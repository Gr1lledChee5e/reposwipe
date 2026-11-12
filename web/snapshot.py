#!/usr/bin/env python3
"""RepoSwipe snapshot: pre-fetch every channel, the Awesome lists and all 73 packs from GitHub into static JSON.

The app loads these first (zero API calls for a visitor's first cards) and layers the live API on top.
Runs in the hourly deploy workflow with GITHUB_TOKEN (search: 30 req/min, core: 1,000 req/hr) — paced to stay
well inside both. On any failure it keeps whatever is already published at <origin>/data/ so the site never
regresses to "no data".

Usage: python3 snapshot.py [--out web/data] [--origin https://swipe.yeete.ai]
Env:   GITHUB_TOKEN (optional but strongly recommended), REPOSWIPE_ORIGIN
"""
import json, os, re, sys, time, urllib.request, urllib.parse, urllib.error, datetime

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "data")
ORIGIN = os.environ.get("REPOSWIPE_ORIGIN", "https://swipe.yeete.ai").rstrip("/")
args = sys.argv[1:]
if "--out" in args: OUT = args[args.index("--out") + 1]
if "--origin" in args: ORIGIN = args[args.index("--origin") + 1].rstrip("/")
LIMIT_PACKS = int(args[args.index("--limit-packs") + 1]) if "--limit-packs" in args else None   # smoke tests
TOKEN = os.environ.get("GITHUB_TOKEN", "").strip()
PAGES_PER_QUERY = int(args[args.index("--pages") + 1]) if "--pages" in args else 3   # 3 × 30 = 90 candidates per channel query
PACK_PER_QUERY = 10
AWESOME_HYDRATE = 60
SEARCH_GAP = 2.1 if TOKEN else 6.5   # seconds between search calls (30/min authed, 10/min anon)

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

_last_search = 0.0
def gh(url, search=False):
    global _last_search
    if search:
        wait = _last_search + SEARCH_GAP - time.time()
        if wait > 0: time.sleep(wait)
    req = urllib.request.Request(url, headers={"Accept": "application/vnd.github+json", "User-Agent": "RepoSwipe-snapshot",
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
                    delay = int(retry) if retry else max(5, min(90, int(reset) - int(time.time()))) if reset else 30
                    print(f"  rate-limited ({e.code}); sleeping {delay}s", flush=True); time.sleep(delay); continue
                print(f"  {e.code} for {url[:80]} (not a rate limit) — skipping", flush=True); return None
            if e.code == 404: return None
            if attempt == 2: raise
            time.sleep(3)
        except Exception:
            if attempt == 2: raise
            time.sleep(3)
    return None

def search(q, pages, per_page=30, sort="updated"):
    out = []
    for p in range(1, pages + 1):
        j = gh("https://api.github.com/search/repositories?q=" + urllib.parse.quote(q) + f"&sort={sort}&order=desc&per_page={per_page}&page={p}", search=True)
        items = (j or {}).get("items") or []
        out.extend(items)
        if len(items) < per_page: break
    return out

def repo(full):
    return gh("https://api.github.com/repos/" + full)

def days_ago(d): return (datetime.datetime.utcnow() - datetime.timedelta(days=d)).strftime("%Y-%m-%d")

def read_source():
    """Pull CHANNELS, AWESOME_SOURCES and PACK_GROUPS out of src.html with node, so the snapshot always matches the app."""
    js = r"""
const fs=require('fs');const h=fs.readFileSync(process.argv[1],'utf8');const s=h.match(/<script>([\s\S]*)<\/script>/)[1];
function grab(start,end){const a=s.indexOf(start);const b=s.indexOf(end,a);return s.slice(a,b);}
const code=`function daysAgoISO(d){return new Date(Date.now()-d*864e5).toISOString().slice(0,10);}
`+grab('const CHANNELS=','const MAX_PAGES')+grab('const AWESOME_SOURCES=','const AWESOME_PER_PAGE')+grab('const PACK_GROUPS=','const PACKS=PACK_GROUPS')+`;return {CHANNELS,AWESOME_SOURCES,PACK_GROUPS};`;
console.log(JSON.stringify(new Function(code)()));"""
    import subprocess
    return json.loads(subprocess.check_output(["node", "-e", js, os.path.join(HERE, "src.html")]).decode())

def published(name):
    try:
        with urllib.request.urlopen(ORIGIN + "/data/" + name, timeout=20) as res: return json.loads(res.read().decode("utf-8"))
    except Exception: return None

def write(name, obj):
    path = os.path.join(OUT, name); os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f: json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
    print(f"  wrote {name} ({os.path.getsize(path)//1024} KB)", flush=True)

def dedupe(items):
    seen, out = set(), []
    for r in items:
        if not r or r.get("id") in seen: continue
        seen.add(r["id"]); out.append(r)
    return out

def main():
    t0 = time.time(); src = read_source(); os.makedirs(OUT, exist_ok=True)
    stats = {"generated": datetime.datetime.utcnow().replace(microsecond=0).isoformat() + "Z", "token": bool(TOKEN)}
    # 1. channels (skip 'awesome' — mined below)
    channels = {}
    try:
        for c in src["CHANNELS"]:
            if not c.get("qs"): continue
            items = []
            for q in c["qs"]: items.extend(search(q, PAGES_PER_QUERY))
            channels[c["key"]] = [slim(r) for r in dedupe(items) if not r.get("archived")]
            print(f"channel {c['key']}: {len(channels[c['key']])}", flush=True)
        write("channels.json", {"generated": stats["generated"], "channels": channels})
        stats["channels"] = {k: len(v) for k, v in channels.items()}
    except Exception as e:
        print("channels failed:", e, flush=True); stats["channels_error"] = str(e)[:200]
        old = published("channels.json")
        if old: write("channels.json", old); stats["channels"] = "kept previous"
    # 2. awesome lists
    try:
        bad = {"topics","search","orgs","sponsors","features","settings","site","about","collections","trending","marketplace","apps","login","signup","readme","contact"}
        names, seen = [], set(x.lower() for x in src["AWESOME_SOURCES"])
        for s_ in src["AWESOME_SOURCES"]:
            d = gh(f"https://api.github.com/repos/{s_}/readme")
            if not d: continue
            import base64
            md = base64.b64decode(d["content"]).decode("utf-8", "ignore")
            for m in re.finditer(r"github\.com/([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+?)(?:[/#?)\s\"']|$)", md):
                o, n = m.group(1), re.sub(r"\.git$", "", m.group(2)); full = f"{o}/{n}"
                if o.lower() in bad or full.lower() in seen: continue
                seen.add(full.lower()); names.append(full)
        hyd = []
        for full in names[:AWESOME_HYDRATE]:
            r = repo(full)
            if r and not r.get("archived"): hyd.append(slim(r))
        write("awesome.json", {"generated": stats["generated"], "list": names[:400], "repos": hyd})
        stats["awesome"] = {"list": len(names), "hydrated": len(hyd)}
        print(f"awesome: {len(names)} names, {len(hyd)} hydrated", flush=True)
    except Exception as e:
        print("awesome failed:", e, flush=True); stats["awesome_error"] = str(e)[:200]
        old = published("awesome.json")
        if old: write("awesome.json", old)
    # 3. packs — hand picks hydrated + 4 star-ranked searches, top 20 (same merge rule as the app)
    packs_done = 0
    all_packs = [p for g in src["PACK_GROUPS"] for p in g["packs"]]
    for p in all_packs[:LIMIT_PACKS] if LIMIT_PACKS else all_packs:
        if True:
            try:
                picks = []
                for full in p.get("picks", []):
                    r = repo(full)
                    if r: r["_pick"] = True; picks.append(r)
                found = []
                for q in p["qs"]: found.extend(search(q, 1, per_page=PACK_PER_QUERY, sort="stars"))
                by = {}
                for r in picks: by[r["id"]] = r
                for r in found: by.setdefault(r["id"], r)
                allr = list(by.values()); key = lambda r: -(r.get("stargazers_count") or 0)
                top = sorted([r for r in allr if r.get("_pick")], key=key) + sorted([r for r in allr if not r.get("_pick")], key=key)
                top = top[:20]
                out = []
                for r in top:
                    o = slim(r); o["_pick"] = bool(r.get("_pick")); out.append(o)
                if out: write(f"packs/{p['id']}.json", {"generated": stats["generated"], "id": p["id"], "repos": out}); packs_done += 1
                else:
                    old = published(f"packs/{p['id']}.json")
                    if old: write(f"packs/{p['id']}.json", old)
            except Exception as e:
                print(f"pack {p['id']} failed: {e}", flush=True)
                old = published(f"packs/{p['id']}.json")
                if old: write(f"packs/{p['id']}.json", old)
    stats["packs"] = packs_done; stats["seconds"] = int(time.time() - t0)
    write("meta.json", stats)
    print("done in", stats["seconds"], "s", flush=True)

if __name__ == "__main__":
    main()
