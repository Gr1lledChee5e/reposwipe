#!/usr/bin/env python3
"""Skill Swipe snapshot — ten scout agents and one inspector, run by the hourly deploy workflow.

Each scout owns a beat and pre-fetches it from GitHub into static JSON, so a visitor's first cards cost zero API
calls. The inspector (scan.py) then safety-checks what the scouts found: dangerous repos are dropped, the rest
carry their verdict into the app.

  scouts ── skills · mcp · claude · agents · coding · memory · automation · trending · fresh · curator
  output ── data/ch/<channel>.json   one file per channel (the app loads only the channels that are switched on)
            data/awesome.json        repos mined from the curated awesome lists (curator)
            data/packs/<id>.json     the 100 starter packs (curator; rolling refresh — each pack at most ~6 hours old)
            data/weekly.json         This Week's Drop — best repos created last week (fresh; frozen each Monday)
            data/weekly/<week>.json + data/weekly-index.json   earlier drops
            data/scan.json           the inspector's cache (verdict per repo) + what it blocked
            data/meta.json           run report: per-scout counts, scan stats, timings

All of it runs on ONE account's own API allowance — never extra accounts. Searches return 100 repos per request
(the old feed took 30), which is where the bigger catalogue comes from. Set the repo secret SNAPSHOT_TOKEN to a
read-only personal access token to raise the allowance from 1,000 to 5,000 requests an hour; without it the
workflow's built-in GITHUB_TOKEN is used. On any failure the previously published file is kept.

Usage: python3 snapshot.py [--out web/data] [--origin https://swipe.yeete.ai] [--pages N] [--limit-packs N]
                           [--fresh-packs] [--packs-per-run N] [--scan-max N] [--no-scan]
       python3 snapshot.py --mirror     copy the currently published data/ (used when a run could not finish)
"""
import base64, datetime, json, os, re, subprocess, sys, threading, time, urllib.error, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import scan as inspector

OUT = os.path.join(HERE, "data")
ORIGIN = os.environ.get("REPOSWIPE_ORIGIN", "https://swipe.yeete.ai").rstrip("/")
args = sys.argv[1:]
def opt(name, default=None, cast=str):
    return cast(args[args.index(name) + 1]) if name in args else default
OUT = opt("--out", OUT); ORIGIN = opt("--origin", ORIGIN).rstrip("/")
LIMIT_PACKS = opt("--limit-packs", None, int)      # smoke tests
FRESH_PACKS = "--fresh-packs" in args
NO_SCAN = "--no-scan" in args
SCAN_MAX = opt("--scan-max", 600, int)             # deep scans per run (also bounded by the API allowance left)
PAGES_PER_QUERY = opt("--pages", 2, int)           # 2 × 100 = 200 candidates per channel query
TOKEN = (os.environ.get("SNAPSHOT_TOKEN") or os.environ.get("GITHUB_TOKEN") or "").strip()
TOKEN_KIND = "snapshot" if os.environ.get("SNAPSHOT_TOKEN", "").strip() else "actions" if TOKEN else "none"
PER_PAGE = 100
CHANNEL_CAP = 450
PACK_PER_QUERY = 10
PACK_REFRESH_HOURS = 6
PACKS_PER_RUN = opt("--packs-per-run", 34, int)    # rolling refresh: the oldest packs first, this many per hourly run
AWESOME_HYDRATE = 60
WEEKLY_SIZE = 12
SEARCH_GAP = 2.1 if TOKEN else 6.5                 # seconds between search calls (30/min authed, 10/min anon)
CORE_RESERVE = 120                                 # API calls left untouched for the rest of the hour

# The ten scouts. "channels" are keys of CHANNELS in src.html (the queries live there, so app and scouts never drift).
SCOUTS = [
    {"id": "skills",     "name": "Skills Scout",     "beat": "Claude & agent skills, plugins",      "channels": ["skills"]},
    {"id": "mcp",        "name": "MCP Scout",        "beat": "MCP servers",                         "channels": ["mcp"]},
    {"id": "claude",     "name": "Claude Scout",     "beat": "Claude and Claude Code tooling",      "channels": ["claude"]},
    {"id": "agents",     "name": "Agents Scout",     "beat": "AI agents and frameworks",            "channels": ["agents"]},
    {"id": "coding",     "name": "Coding Scout",     "beat": "AI coding tools",                     "channels": ["coding"]},
    {"id": "memory",     "name": "Memory Scout",     "beat": "Memory, RAG and vector stores",       "channels": ["rag"]},
    {"id": "automation", "name": "Automation Scout", "beat": "Workflow and browser automation",     "channels": ["automation"]},
    {"id": "trending",   "name": "Trending Scout",   "beat": "What's moving across GitHub",         "channels": ["trend"]},
    {"id": "fresh",      "name": "Fresh Scout",      "beat": "New this month + This Week's Drop",   "channels": ["hot"]},
    {"id": "curator",    "name": "Curator",          "beat": "Awesome lists + the 100 starter packs", "channels": []},
]

FIELDS = ["id", "full_name", "name", "html_url", "description", "language", "topics", "stargazers_count",
          "forks_count", "open_issues_count", "pushed_at", "created_at", "archived"]

def slim(r):
    o = {k: r.get(k) for k in FIELDS}
    o["topics"] = (r.get("topics") or [])[:6]
    if o.get("description"): o["description"] = o["description"][:240]
    ow = r.get("owner") or {}
    o["owner"] = {"login": ow.get("login"), "avatar_url": ow.get("avatar_url")}
    lic = r.get("license") or {}
    o["license"] = {"spdx_id": lic.get("spdx_id")} if lic.get("spdx_id") else None
    return o

def now(): return datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)
def iso(d): return d.replace(microsecond=0).isoformat() + "Z"
def days_ago(d): return (now() - datetime.timedelta(days=d)).strftime("%Y-%m-%d")
def parse_iso(s):
    try: return datetime.datetime.strptime(s[:19], "%Y-%m-%dT%H:%M:%S")
    except Exception: return None

_last_search = 0.0
_core_used = 0
_core_blocked_until = 0.0
def gh(url, search=False, free=False):
    """GitHub API GET with pacing for search and patience for real rate limits. None on 404 / hard refusals.
    When the hourly (core) allowance is spent and the reset is more than a minute away, core calls return None at
    once instead of sleeping — the run finishes with what it has and the next hourly run picks up the rest."""
    global _last_search, _core_used, _core_blocked_until
    if search:
        wait = _last_search + SEARCH_GAP - time.time()
        if wait > 0: time.sleep(wait)
    elif not free:
        if time.time() < _core_blocked_until: return None
        _core_used += 1
    req = urllib.request.Request(url, headers={"Accept": "application/vnd.github+json", "User-Agent": "SkillSwipe-snapshot",
                                               **({"Authorization": "Bearer " + TOKEN} if TOKEN else {})})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=30) as res:
                if search: _last_search = time.time()
                return json.loads(res.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if search: _last_search = time.time()
            if e.code in (403, 429):
                reset = e.headers.get("X-RateLimit-Reset"); retry = e.headers.get("Retry-After"); rem = e.headers.get("X-RateLimit-Remaining")
                if retry or rem == "0":   # a real rate limit — wait it out; any other 403 is a hard "no" (proxy/permissions)
                    if not search and not retry and reset and int(reset) - time.time() > 60:
                        if _core_blocked_until < int(reset): print(f"  hourly API allowance spent — skipping API calls until it resets in {int(int(reset) - time.time())}s", flush=True)
                        _core_blocked_until = float(reset); return None
                    delay = int(retry) if retry else max(5, min(90, int(reset) - int(time.time()))) if reset else 30
                    print(f"  rate-limited ({e.code}); sleeping {delay}s", flush=True); time.sleep(delay); continue
                print(f"  {e.code} for {url[:80]} (not a rate limit) — skipping", flush=True); return None
            if e.code in (404, 409, 422, 451): return None
            if attempt == 2: raise
            time.sleep(3)
        except Exception:
            if attempt == 2: raise
            time.sleep(3)
    return None

def search(q, pages, per_page=PER_PAGE, sort="updated"):
    out = []
    for p in range(1, pages + 1):
        j = gh("https://api.github.com/search/repositories?q=" + urllib.parse.quote(q) + f"&sort={sort}&order=desc&per_page={per_page}&page={p}", search=True)
        items = (j or {}).get("items") or []
        out.extend(items)
        if len(items) < per_page: break
    return out

def repo(full): return gh("https://api.github.com/repos/" + full)

def core_remaining():
    j = gh("https://api.github.com/rate_limit", free=True)   # free: doesn't count against the allowance
    try: return int(j["resources"]["core"]["remaining"])
    except Exception: return None

def read_source():
    """Pull CHANNELS, AWESOME_SOURCES and PACK_GROUPS out of src.html with node, so the snapshot always matches the app."""
    js = r"""
const fs=require('fs');const h=fs.readFileSync(process.argv[1],'utf8');const s=h.match(/<script>([\s\S]*)<\/script>/)[1];
function grab(start,end){const a=s.indexOf(start);const b=s.indexOf(end,a);return s.slice(a,b);}
const code=`function daysAgoISO(d){return new Date(Date.now()-d*864e5).toISOString().slice(0,10);}
`+grab('const CHANNELS=','const MAX_PAGES')+grab('const AWESOME_SOURCES=','const AWESOME_PER_PAGE')+grab('const PACK_GROUPS=','const PACKS=PACK_GROUPS')+`;return {CHANNELS,AWESOME_SOURCES,PACK_GROUPS};`;
console.log(JSON.stringify(new Function(code)()));"""
    return json.loads(subprocess.check_output(["node", "-e", js, os.path.join(HERE, "src.html")]).decode())

def published(name):
    try:
        with urllib.request.urlopen(urllib.request.Request(ORIGIN + "/data/" + name, headers={"User-Agent": "SkillSwipe-snapshot"}), timeout=20) as res:
            return json.loads(res.read().decode("utf-8"))
    except Exception: return None

def write(name, obj, quiet=False):
    path = os.path.join(OUT, name); os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f: json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
    if not quiet: print(f"  wrote {name} ({os.path.getsize(path)//1024} KB)", flush=True)

def dedupe(items):
    seen, out = set(), []
    for r in items:
        if not r or r.get("id") in seen: continue
        seen.add(r["id"]); out.append(r)
    return out

def interleave(lists):
    """Round-robin merge, so page 1 of a channel mixes all of its queries instead of exhausting the first."""
    out, i = [], 0
    while any(i < len(l) for l in lists):
        for l in lists:
            if i < len(l): out.append(l[i])
        i += 1
    return out

# ---------------------------------------------------------------- the inspector ----------------------------------
_raw_limited = threading.Event()
def fetch_tree(full):
    d = gh(f"https://api.github.com/repos/{full}/git/trees/HEAD?recursive=1")
    if not d or not isinstance(d.get("tree"), list): return None
    return [{"path": e["path"], "size": e.get("size", 0)} for e in d["tree"] if e.get("type") == "blob"]

def fetch_file(full, path):
    if _raw_limited.is_set(): return None
    url = f"https://raw.githubusercontent.com/{full}/HEAD/" + urllib.parse.quote(path)
    for auth in (False, True):                       # anonymous first; the token only if the host starts throttling
        if auth and not TOKEN: break
        req = urllib.request.Request(url, headers={"User-Agent": "SkillSwipe-snapshot", **({"Authorization": "Bearer " + TOKEN} if auth else {})})
        try:
            with urllib.request.urlopen(req, timeout=25) as res: return res.read(inspector.RULES["maxBytes"] + 1).decode("utf-8", "ignore")
        except urllib.error.HTTPError as e:
            if e.code == 429: continue
            return None
        except Exception: return None
    _raw_limited.set(); print("  raw file host rate-limited — stopping scans for this run", flush=True)
    return None

def flag_clusters(repos, cache):
    """Clone campaigns (see scan.find_clusters) are recorded as danger so they stay out even when only one member resurfaces."""
    bad = inspector.find_clusters(repos); today = iso(now())
    for r in repos:
        f = (r.get("full_name") or "").lower()
        if f not in bad: continue
        c = cache.get(f) or {"n": 0, "t": 0, "p": r.get("pushed_at")}
        c["l"] = 2; c["r"] = (["clone-cluster"] + [x for x in c.get("r", []) if x != "clone-cluster"])[:6]; c["at"] = today; cache[f] = c
    return bad

def inspect(candidates, cache, budget):
    """Deep-scan up to `budget` repos (never-scanned first), update `cache` in place. → number scanned."""
    today = now()
    def tier(r):
        c = cache.get(r["full_name"].lower())
        if not c: return 0
        age = (today - (parse_iso(c.get("at", "")) or today)).days
        if c.get("p") != r.get("pushed_at") and age >= 3: return 1
        if age >= 14: return 2
        return 9
    todo = [r for r in candidates if tier(r) < 9]
    todo.sort(key=tier)                                  # stable: keeps the caller's priority order inside a tier
    todo = todo[:max(0, budget)]
    if not todo: return 0
    def one(r):
        if _raw_limited.is_set(): return None
        try: res = inspector.scan_repo(r, fetch_tree, fetch_file)
        except Exception as e: print("  scan failed", r["full_name"], str(e)[:80], flush=True); return None
        if res["n"] == 0 and (not res["t"] or _raw_limited.is_set()): return None   # nothing could be read — that is not a verdict
        return r, res
    done = 0
    with ThreadPoolExecutor(max_workers=8) as ex:
        for out in ex.map(one, todo):
            if not out: continue
            r, res = out
            cache[r["full_name"].lower()] = {"l": res["l"], "r": res["r"], "n": res["n"], "t": 1 if res["t"] else 0, "p": r.get("pushed_at"), "at": iso(today)}
            done += 1
    return done

def stamp(r, cache):
    """Attach the verdict to a slim repo. → False when the repo must be dropped (danger)."""
    c = cache.get((r.get("full_name") or "").lower())
    if c:
        if c["l"] >= 2: return False
        r["safety"] = {"l": c["l"], "r": c["r"], "n": c["n"], "t": c.get("t", 0)}
    else:
        m = inspector.scan_meta(r)                      # not deep-scanned yet: listing-only signals, if any
        if m: r["safety"] = {"l": inspector.verdict(m)[0], "r": m, "n": 0}
    return True

# ---------------------------------------------------------------- This Week's Drop --------------------------------
def week_id(d): y, w, _ = d.isocalendar(); return f"{y}-W{w:02d}"

def weekly_candidates(frm, to, floor):
    span = f"created:{frm}..{to} stars:>={floor} fork:false"
    qs = [f"{span} topic:{t}" for t in ("mcp", "claude", "claude-code", "ai-agents", "agent-skills", "llm", "ai")] + \
         [f"{span} {w} in:name,description" for w in ("mcp", "claude", "agent", "skill")]
    found = []
    for q in qs: found.extend(search(q, 1, per_page=30, sort="stars"))
    return sorted([r for r in dedupe(found) if not r.get("archived") and r.get("description")], key=lambda r: -(r.get("stargazers_count") or 0))

def build_weekly(cache, stats):
    today = now(); monday = (today - datetime.timedelta(days=today.weekday())).date()
    frm, to = monday - datetime.timedelta(days=7), monday - datetime.timedelta(days=1)
    week = week_id(monday)
    prev = published("weekly.json")
    index = published("weekly-index.json") or []
    if not isinstance(index, list): index = []
    if prev and prev.get("week") == week and prev.get("repos"):
        doc = prev                                        # frozen for the week; verdicts are re-applied below
        doc["repos"] = [r for r in doc["repos"] if stamp(r, cache)]
    else:
        cands = weekly_candidates(frm, to, 40)
        if len(cands) < WEEKLY_SIZE: cands = dedupe(cands + weekly_candidates(frm, to, 12))
        flag_clusters(cands, cache)                         # clone campaigns love "new and trending" lists
        cands = [r for r in cands if (cache.get(r["full_name"].lower()) or {}).get("l", 0) < 2]
        short = [slim(r) for r in cands[:WEEKLY_SIZE * 3]]
        if not NO_SCAN: inspect(short, cache, len(short))   # every pick is deep-scanned before it can be featured
        picks, per_owner = [], {}
        for r in short:
            o = (r["owner"].get("login") or "").lower()
            if per_owner.get(o, 0) >= 2 or not stamp(r, cache): continue
            per_owner[o] = per_owner.get(o, 0) + 1; picks.append(r)
            if len(picks) >= WEEKLY_SIZE: break
        if not picks:
            if prev: write("weekly.json", prev)
            return prev
        doc = {"week": week, "from": str(frm), "to": str(to), "generated": stats["generated"], "repos": picks}
        if prev and prev.get("week") and prev.get("week") != week and prev.get("repos"):
            index = [e for e in index if e.get("week") != prev["week"]]
            index.insert(0, {"week": prev["week"], "from": prev.get("from"), "to": prev.get("to"), "count": len(prev["repos"]),
                             "top": [r["full_name"] for r in prev["repos"][:3]]})
            write(f"weekly/{prev['week']}.json", prev)
    write("weekly.json", doc)
    index = index[:12]
    for e in index:                                       # carry earlier drops forward (each deploy replaces the whole site)
        if os.path.exists(os.path.join(OUT, "weekly", e["week"] + ".json")): continue
        old = published(f"weekly/{e['week']}.json")
        if old: write(f"weekly/{e['week']}.json", old, quiet=True)
    index = [e for e in index if os.path.exists(os.path.join(OUT, "weekly", e["week"] + ".json"))]
    write("weekly-index.json", index)
    stats["weekly"] = {"week": doc["week"], "from": doc.get("from"), "to": doc.get("to"), "count": len(doc["repos"]), "archive": len(index)}
    return doc

# ---------------------------------------------------------------- main -------------------------------------------
def main():
    t0 = time.time(); src = read_source(); os.makedirs(OUT, exist_ok=True)
    stats = {"generated": iso(now()), "token": bool(TOKEN), "token_kind": TOKEN_KIND, "version": 2}
    old_scan = published("scan.json") or {}
    cache = old_scan.get("repos") if isinstance(old_scan.get("repos"), dict) else {}
    if old_scan.get("rules") != inspector.RULES["version"]: cache = {}   # rules changed → every verdict is re-earned
    by_key = {c["key"]: c for c in src["CHANNELS"]}
    channels, scout_report, kept = {}, [], {}

    # 1. the nine search scouts — one channel each
    for s in SCOUTS:
        found = 0
        for key in s["channels"]:
            c = by_key.get(key)
            if not c or not c.get("qs"): continue
            try:
                lists = [search(q + " archived:false", PAGES_PER_QUERY) for q in c["qs"]]
                channels[key] = [slim(r) for r in dedupe(interleave(lists)) if not r.get("archived")][:CHANNEL_CAP]
                found += len(channels[key])
                print(f"{s['name']}: {key} → {len(channels[key])}", flush=True)
            except Exception as e:
                print(f"{s['name']}: {key} failed: {e}", flush=True)
                old = published(f"ch/{key}.json")
                if old: kept[key] = old
        scout_report.append({"id": s["id"], "name": s["name"], "beat": s["beat"], "channels": s["channels"], "found": found})

    # 2. curator — awesome lists
    awesome_names, awesome_repos = [], []
    try:
        bad = {"topics","search","orgs","sponsors","features","settings","site","about","collections","trending","marketplace","apps","login","signup","readme","contact"}
        seen = set(x.lower() for x in src["AWESOME_SOURCES"])
        for s_ in src["AWESOME_SOURCES"]:
            d = gh(f"https://api.github.com/repos/{s_}/readme")
            if not d: continue
            md = base64.b64decode(d["content"]).decode("utf-8", "ignore")
            for m in re.finditer(r"github\.com/([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+?)(?:[/#?)\s\"']|$)", md):
                o, n = m.group(1), re.sub(r"\.git$", "", m.group(2)); full = f"{o}/{n}"
                if o.lower() in bad or full.lower() in seen: continue
                seen.add(full.lower()); awesome_names.append(full)
        for full in awesome_names[:AWESOME_HYDRATE]:
            r = repo(full)
            if r and not r.get("archived"): awesome_repos.append(slim(r))
        print(f"Curator: awesome → {len(awesome_names)} names, {len(awesome_repos)} hydrated", flush=True)
    except Exception as e:
        print("Curator: awesome failed:", e, flush=True); stats["awesome_error"] = str(e)[:200]

    # 3. curator — the starter packs, refreshed on a rolling basis: each run rebuilds the packs that are missing or
    #    oldest (at most PACKS_PER_RUN), so 100 packs never mean 400 searches in one go and every pack is ≤ ~6 h old.
    all_packs = [p for g in src["PACK_GROUPS"] for p in g["packs"]]
    if LIMIT_PACKS: all_packs = all_packs[:LIMIT_PACKS]
    with ThreadPoolExecutor(max_workers=8) as ex:
        olds = dict(zip([p["id"] for p in all_packs], ex.map(lambda p: published(f"packs/{p['id']}.json"), all_packs)))
    def age_h(pid):
        o = olds.get(pid); t = parse_iso((o or {}).get("generated") or "") if o and o.get("repos") else None
        return 1e9 if t is None else (now() - t).total_seconds() / 3600
    due = sorted([p for p in all_packs if FRESH_PACKS or age_h(p["id"]) >= PACK_REFRESH_HOURS], key=lambda p: -age_h(p["id"]))
    if not FRESH_PACKS: due = due[:PACKS_PER_RUN]
    due_ids = {p["id"] for p in due}
    packs, pack_gen, fresh_ok = {}, {}, 0
    for p in all_packs:
        old = olds.get(p["id"])
        if p["id"] in due_ids:
            try:
                picks = []
                for full in p.get("picks", []):
                    r = repo(full)
                    if r: r["_pick"] = True; picks.append(r)
                if p.get("picks") and len(picks) * 2 < len(p["picks"]):   # allowance spent or a GitHub hiccup: a pack without
                    raise RuntimeError("hand picks unavailable")          # its essentials is worse than the published one
                found = []
                for q in p["qs"]: found.extend(search(q, 1, per_page=PACK_PER_QUERY, sort="stars"))
                by = {}
                for r in picks: by[r["id"]] = r
                for r in found: by.setdefault(r["id"], r)
                allr = list(by.values()); key = lambda r: -(r.get("stargazers_count") or 0)
                top = (sorted([r for r in allr if r.get("_pick")], key=key) + sorted([r for r in allr if not r.get("_pick")], key=key))[:20]
                out = []
                for r in top:
                    o = slim(r); o["_pick"] = bool(r.get("_pick")); out.append(o)
                if out: packs[p["id"]] = out; pack_gen[p["id"]] = stats["generated"]; fresh_ok += 1; continue
            except Exception as e:
                print(f"Curator: pack {p['id']} failed: {e}", flush=True)
        if old and old.get("repos"): packs[p["id"]] = old["repos"]; pack_gen[p["id"]] = old.get("generated") or ""   # keeps its age → retried first next run
    stats["packs_at"] = stats["generated"]
    print(f"Curator: packs → {len(packs)} of {len(all_packs)} ({fresh_ok} refreshed of {len(due)} due, {len(packs) - fresh_ok} kept)", flush=True)
    scout_report[-1]["found"] = len(awesome_repos) + len(packs)

    # 4. fresh scout — This Week's Drop (its picks are deep-scanned inside)
    weekly = None
    try: weekly = build_weekly(cache, stats)
    except Exception as e: print("Fresh Scout: weekly failed:", e, flush=True); stats["weekly_error"] = str(e)[:200]
    if weekly is None:
        old = published("weekly.json")
        if old: write("weekly.json", old)

    # 5. the inspector — everything the scouts found goes through the safety scan, as far as the API allowance reaches
    clustered = flag_clusters([r for rs in channels.values() for r in rs] + awesome_repos, cache)
    if clustered: print(f"Inspector: {len(clustered)} repos belong to clone campaigns", flush=True)
    scanned = 0
    if not NO_SCAN:
        order = interleave([channels[k] for k in channels]) + awesome_repos + [r for rs in packs.values() for r in rs]
        cands = [r for r in dedupe(order) if "clone-cluster" not in (cache.get(r["full_name"].lower()) or {}).get("r", [])]
        left = core_remaining()
        budget = SCAN_MAX if left is None else max(0, min(SCAN_MAX, left - CORE_RESERVE))
        print(f"Inspector: {len(cands)} repos in play, {len(cache)} verdicts cached, API calls left {left}, scanning up to {budget}", flush=True)
        try: scanned = inspect(cands, cache, budget)
        except Exception as e: print("Inspector failed:", e, flush=True); stats["scan_error"] = str(e)[:200]

    # 6. publish — verdicts stamped on, dangerous repos dropped
    blocked, tally = {}, {"clear": 0, "caution": 0, "unscanned": 0}
    def clean(repos):
        out = []
        for r in repos:
            if not stamp(r, cache):
                blocked[r["full_name"]] = cache[r["full_name"].lower()]["r"]; continue
            out.append(r)
        return out
    for key, repos in channels.items():
        repos = clean(repos)
        for r in repos:
            sf = r.get("safety"); tally["caution" if sf and sf["l"] else "clear" if sf and (sf.get("n") or sf.get("t")) else "unscanned"] += 1
        scout = next((s["id"] for s in SCOUTS if key in s["channels"]), None)
        write(f"ch/{key}.json", {"generated": stats["generated"], "key": key, "scout": scout, "repos": repos})
    for key, old in kept.items():
        if key not in channels: write(f"ch/{key}.json", old)
    if awesome_names:
        write("awesome.json", {"generated": stats["generated"], "list": awesome_names[:400], "repos": clean(awesome_repos)})
        stats["awesome"] = {"list": len(awesome_names), "hydrated": len(awesome_repos)}
    else:
        old = published("awesome.json")
        if old: write("awesome.json", old)
    for pid, repos in packs.items():
        write(f"packs/{pid}.json", {"generated": pack_gen.get(pid) or stats["generated"], "id": pid, "repos": clean(repos)}, quiet=True)
    print(f"  wrote {len(packs)} pack files", flush=True)

    # keep the cache bounded: verdicts for repos not seen for 30 days fall out
    cutoff = iso(now() - datetime.timedelta(days=30))
    live = {r["full_name"].lower() for rs in channels.values() for r in rs}
    cache = {k: v for k, v in cache.items() if k in live or v.get("at", "") >= cutoff}
    write("scan.json", {"version": 1, "generated": stats["generated"], "rules": inspector.RULES["version"], "repos": cache,
                        "blocked": [{"full_name": k, "reasons": v} for k, v in sorted(blocked.items())][:100]})
    stats["channels"] = {k: len(v) for k, v in channels.items()}
    stats["scouts"] = scout_report
    stats["scan"] = {"scanned_now": scanned, "cached": len(cache), "clear": tally["clear"], "caution": tally["caution"],
                     "unscanned": tally["unscanned"], "blocked": len(blocked), "clusters": len(clustered), "raw_limited": _raw_limited.is_set()}
    stats["packs"] = len(packs); stats["core_calls"] = _core_used; stats["seconds"] = int(time.time() - t0)
    write("meta.json", stats)
    print("done in", stats["seconds"], "s ·", sum(stats["channels"].values()), "channel repos ·", scanned, "scanned ·", len(blocked), "blocked", flush=True)

def mirror():
    """Copy what is currently published into data/, so a scout run that could not finish never leaves the site without a feed."""
    meta = published("meta.json")
    if not meta: print("mirror: nothing published yet", flush=True); return False
    names = ["meta.json", "awesome.json", "weekly.json", "weekly-index.json", "scan.json"] + [f"ch/{k}.json" for k in (meta.get("channels") or {})]
    try: names += [f"packs/{p['id']}.json" for g in read_source()["PACK_GROUPS"] for p in g["packs"]]
    except Exception as e: print("mirror: pack list unavailable:", e, flush=True)
    index = published("weekly-index.json") or []
    names += [f"weekly/{e['week']}.json" for e in index if isinstance(e, dict) and e.get("week")]
    kept = 0
    for name in names:
        d = published(name)
        if d is not None: write(name, d, quiet=True); kept += 1
    print(f"mirror: kept {kept} of {len(names)} published files", flush=True)
    return kept > 0

if __name__ == "__main__":
    if "--mirror" in args: mirror()
    else: main()
