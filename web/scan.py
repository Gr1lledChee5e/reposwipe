#!/usr/bin/env python3
"""Skill Swipe safety scan — the scouts' inspector (Python engine).

Same rules (scan_rules.json) and same logic as the in-app scanner in src.html; scan_fixtures.json is run
through both so they cannot drift apart. A scan reads the repo's file list plus up to 14 key files
(install hooks, setup scripts, skill / agent instruction files, tool configs, entry points) and looks for:
install-time remote execution, encoded payloads, reverse shells, credential theft, crypto miners, leaked
secrets, hidden or stealthy instructions aimed at an AI, and committed binaries / env files / data dumps.

It is a heuristic over a sample of files — it can miss things and it can be wrong. Never present it as a guarantee.
"""
import json, os, re

HERE = os.path.dirname(os.path.abspath(__file__))
RULES = json.load(open(os.path.join(HERE, "scan_rules.json"), encoding="utf-8"))
LEVELS = RULES["levels"]

def _rx(p, flags=""):
    return re.compile(p, re.ASCII | (re.I if "i" in (flags or "") else 0))

_FILES = [dict(f, rx=_rx(f["re"])) for f in RULES["files"]]
_CONTENT = [dict(r, rx=_rx(r["re"], r.get("flags")), prx=_rx(r["path"]) if r.get("path") else None) for r in RULES["content"]]
_TREE = [dict(r, rx=_rx(r["re"])) for r in RULES["tree"]]
_META = [dict(r, rx=_rx(r["re"], r.get("flags"))) for r in RULES["meta"]]
_HOOK = _rx(RULES["hookRe"], "i")
_HOOK_NET = _rx(RULES["hookNetRe"], "i")
_HOOK_SCRIPT = _rx(RULES["hookScriptRe"], "i")

def scan_meta(repo):
    """Signals from the listing alone (name, description, topics) — free, runs on every repo."""
    hay = " ".join([repo.get("full_name") or "", repo.get("description") or "", " ".join(repo.get("topics") or [])])
    return sorted({r["code"] for r in _META if r["rx"].search(hay)})

def scan_tree(entries):
    """entries: [{path, size}] for every blob in the repo."""
    out = set()
    for e in entries[:6000]:
        p = (e.get("path") or "").lower()
        for r in _TREE:
            if r["code"] in out: continue
            if r["rx"].search(p) and (e.get("size") or 0) >= r.get("minSize", 0): out.add(r["code"])
    return sorted(out)

def pick_files(entries):
    """Choose which files to read: [{path, cls}] in rule order, capped per class and overall."""
    picked, seen = [], set()
    paths = sorted([e for e in entries if (e.get("size") or 0) <= RULES["maxFileSize"]], key=lambda e: (e["path"].count("/"), len(e["path"]), e["path"]))
    for f in _FILES:
        n = 0
        for e in paths:
            if n >= f["max"] or len(picked) >= RULES["maxFiles"]: break
            p = e["path"]
            if p in seen or not f["rx"].search(p.lower()): continue
            seen.add(p); picked.append({"path": p, "cls": f["cls"]}); n += 1
    return picked

def hook_scripts(text):
    """package.json → (codes, [script paths the install hooks run])."""
    try: scripts = (json.loads(text) or {}).get("scripts") or {}
    except Exception: return [], []
    if not isinstance(scripts, dict): return [], []
    codes, extra = set(), []
    for k in RULES["hookKeys"]:
        v = scripts.get(k)
        if not isinstance(v, str): continue
        if _HOOK.search(v): codes.add("hook-exec")
        if _HOOK_NET.search(v): codes.add("hook-net")
        for m in _HOOK_SCRIPT.finditer(v): extra.append(re.sub(r"^\./", "", m.group(1)))
    return sorted(codes), extra

def _unicode(cls, text):
    U, out = RULES["unicode"], set()
    tags = bidi = zw = 0
    for i, ch in enumerate(text):
        o = ord(ch)
        if 0xE0000 <= o <= 0xE007F: tags += 1
        elif 0x202A <= o <= 0x202E or 0x2066 <= o <= 0x2069: bidi += 1
        elif o in (0x200B, 0x2060) or (o == 0xFEFF and i > 0): zw += 1
    if tags >= U["tagMin"]: out.add("hidden-text")
    if bidi and cls in U["bidiIn"]: out.add("bidi-control")
    if zw >= U["zeroWidthMin"] and cls in U["zeroWidthIn"]: out.add("zero-width")
    return out

def scan_text(path, cls, text):
    """Codes found in one file."""
    text = (text or "")[:RULES["maxBytes"]]
    out, lp = set(), path.lower()
    for r in _CONTENT:
        if cls not in r["in"] or r["code"] in out: continue
        if r["prx"] and not r["prx"].search(lp): continue
        need = r.get("min", 1)
        if need <= 1:
            if r["rx"].search(text): out.add(r["code"])
        elif sum(1 for _ in r["rx"].finditer(text)) >= need: out.add(r["code"])
    out |= _unicode(cls, text)
    if lp == "package.json": out |= set(hook_scripts(text)[0])
    for c in RULES["combos"]:
        if all(x in out for x in c["all"]): out.add(c["code"])
    return sorted(out)

def _day(iso):
    """Days since the epoch for an ISO timestamp (same arithmetic as the app: Date.parse / 864e5)."""
    try:
        import datetime
        d = datetime.datetime.strptime(iso[:19], "%Y-%m-%dT%H:%M:%S")
        return (d - datetime.datetime(1970, 1, 1)).total_seconds() / 86400.0
    except Exception: return None

def find_clusters(repos):
    """Clone campaigns in a list of repos → set of full_names (lower-case).
    Confirmed cluster: ≥ minSize repos from different owners, created within `days` of each other, with
    near-identical names (token Jaccard ≥ jaccard) AND near-identical star counts. Anything else that looks
    like a confirmed member (same naming, same days, other owner) is swept in as an associate."""
    C = RULES["cluster"]
    items = []
    for r in repos:
        d = _day(r.get("created_at") or ""); tok = set(t for t in re.split(r"[^a-z0-9]+", (r.get("name") or "").lower()) if t)
        if d is None or len(tok) < C["minTokens"] or (r.get("stargazers_count") or 0) < C["minStars"]: continue
        items.append({"f": (r.get("full_name") or "").lower(), "o": ((r.get("owner") or {}).get("login") or "").lower(), "d": d, "t": tok, "s": r.get("stargazers_count") or 0})
    seen, uniq = set(), []
    for it in items:
        if it["f"] in seen: continue
        seen.add(it["f"]); uniq.append(it)
    uniq.sort(key=lambda x: (x["d"], x["f"]))
    def similar(a, b):
        if a["o"] == b["o"] or abs(a["d"] - b["d"]) > C["days"]: return False
        return len(a["t"] & b["t"]) / len(a["t"] | b["t"]) >= C["jaccard"]
    def tight(a, b): return similar(a, b) and min(a["s"], b["s"]) / max(a["s"], b["s"]) >= C["starRatio"]
    parent = list(range(len(uniq)))
    def find(i):
        while parent[i] != i: parent[i] = parent[parent[i]]; i = parent[i]
        return i
    for i, a in enumerate(uniq):
        for j in range(i + 1, len(uniq)):
            b = uniq[j]
            if b["d"] - a["d"] > C["days"]: break
            if tight(a, b): parent[find(i)] = find(j)
    groups = {}
    for i in range(len(uniq)): groups.setdefault(find(i), []).append(i)
    confirmed = [i for g in groups.values() if len(g) >= C["minSize"] for i in g]
    out = {uniq[i]["f"] for i in confirmed}
    for a in uniq:
        if a["f"] in out: continue
        if any(similar(a, uniq[i]) for i in confirmed): out.add(a["f"])
    return out

def verdict(codes):
    """→ (level 0|1|2, reasons worst-first, max 6)."""
    codes = sorted(set(codes), key=lambda c: (-LEVELS.get(c, 1), c))
    return (max([LEVELS.get(c, 1) for c in codes]) if codes else 0), codes[:6]

def scan_repo(repo, fetch_tree, fetch_file):
    """Full scan. fetch_tree(full) → [{path,size}] or None; fetch_file(full, path) → text or None.
    Returns {"l": level, "r": [codes], "n": files read, "t": True when the file list was available}."""
    full = repo["full_name"]; codes = set(scan_meta(repo))
    entries = fetch_tree(full); has_tree = entries is not None
    if has_tree: codes |= set(scan_tree(entries))
    else: entries = [{"path": p, "size": 0} for p in RULES["fallbackPaths"]]   # no file list → try the well-known paths directly
    picks = pick_files(entries); have = {p["path"] for p in picks}; allp = {e["path"] for e in entries}
    n = 0; i = 0
    while i < len(picks) and n < RULES["maxFiles"] + 2:
        p = picks[i]; i += 1
        text = fetch_file(full, p["path"])
        if text is None: continue
        n += 1; codes |= set(scan_text(p["path"], p["cls"], text))
        if p["path"].lower() == "package.json":      # follow install hooks into the scripts they run
            for sp in hook_scripts(text)[1]:
                if (sp in allp or not has_tree) and sp not in have: have.add(sp); picks.append({"path": sp, "cls": "install"})
    lvl, reasons = verdict(codes)
    return {"l": lvl, "r": reasons, "n": n, "t": has_tree}

if __name__ == "__main__":   # python3 scan.py owner/repo  → scan one live repo
    import sys, urllib.request
    tok = os.environ.get("SNAPSHOT_TOKEN") or os.environ.get("GITHUB_TOKEN") or ""
    def _get(url, raw=False):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "SkillSwipe-scan", **({"Authorization": "Bearer " + tok} if tok and not raw else {})})
            with urllib.request.urlopen(req, timeout=30) as r: return r.read()
        except Exception: return None
    def tree(full):
        d = _get(f"https://api.github.com/repos/{full}/git/trees/HEAD?recursive=1")
        return [{"path": e["path"], "size": e.get("size", 0)} for e in json.loads(d).get("tree", []) if e.get("type") == "blob"] if d else None
    def file(full, path):
        d = _get(f"https://raw.githubusercontent.com/{full}/HEAD/{path}", raw=True)
        return d.decode("utf-8", "ignore") if d is not None else None
    for full in sys.argv[1:]:
        print(full, json.dumps(scan_repo({"full_name": full}, tree, file)))
