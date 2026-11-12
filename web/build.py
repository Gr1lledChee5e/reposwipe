#!/usr/bin/env python3
"""Build reposwipe.html from src.html + seed.json + bg.jpg.
Usage: python3 build.py [out_dir]   (default: current directory)
Also writes the deploy site into out_dir/site/ when --site is passed:
  site/index.html (the app), site/privacy.html, site/pack/<id>/index.html OG stubs, site/404.html.
"""
import base64, json, os, re, sys
from html import escape as hesc

HERE = os.path.dirname(os.path.abspath(__file__))
SITE = "--site" in sys.argv
ORIGIN = os.environ.get("REPOSWIPE_ORIGIN", "https://swipe.yeete.ai")

src = open(os.path.join(HERE, "src.html"), encoding="utf-8").read()
seed = open(os.path.join(HERE, "seed.json"), encoding="utf-8").read()
bg = base64.b64encode(open(os.path.join(HERE, "bg.jpg"), "rb").read()).decode()
assert src.count("__SEED__") == 1 and src.count("__BG__") == 1, "placeholders missing"
html = src.replace("__SEED__", seed).replace("__BG__", "data:image/jpeg;base64," + bg)

# parse check of the inline script
m = re.search(r"<script>([\s\S]*)</script>", html)
assert m, "no script"
out = os.path.join(HERE, "reposwipe.html")
open(out, "w", encoding="utf-8").write(html)
print("built", out, len(html), "bytes")

if SITE:
    site = os.path.join(HERE, "site")
    os.makedirs(site, exist_ok=True)
    open(os.path.join(site, "index.html"), "w", encoding="utf-8").write(html)
    open(os.path.join(site, "404.html"), "w", encoding="utf-8").write(html)  # hash routes + unknown paths load the app
    import shutil
    shutil.copy(os.path.join(HERE, "privacy.html"), os.path.join(site, "privacy.html"))
    os.makedirs(os.path.join(site, "og"), exist_ok=True)
    for f in ("app.png", "pack.png"):
        shutil.copy(os.path.join(HERE, "og", f), os.path.join(site, "og", f))
    data = os.path.join(HERE, "data")   # snapshot feed (snapshot.py) — optional; the app falls back to the live API
    if os.path.isdir(data):
        shutil.copytree(data, os.path.join(site, "data"), dirs_exist_ok=True)
        print("site: data/ snapshot included")
    open(os.path.join(site, "CNAME"), "w").write(ORIGIN.replace("https://", "").replace("http://", "").rstrip("/") + "\n")
    open(os.path.join(site, ".nojekyll"), "w").write("")
    open(os.path.join(site, "robots.txt"), "w").write("User-agent: *\nAllow: /\nSitemap: %s/sitemap.xml\n" % ORIGIN)
    # packs for OG stub pages: parse PACK_GROUPS from the source with node (robust against JS syntax)
    import subprocess
    js = r"""
const fs=require('fs');const h=fs.readFileSync(process.argv[1],'utf8');
const s=h.match(/<script>([\s\S]*)<\/script>/)[1];
const a=s.indexOf('const PACK_GROUPS=');const b=s.indexOf('const PACKS=PACK_GROUPS');
const code=s.slice(a,b)+';return PACK_GROUPS;';
console.log(JSON.stringify(new Function(code)()));
"""
    groups = json.loads(subprocess.check_output(["node", "-e", js, out]).decode())
    n = 0
    for g in groups:
        for p in g["packs"]:
            d = os.path.join(site, "pack", p["id"])
            os.makedirs(d, exist_ok=True)
            art = "an" if p['title'][:1].lower() in "aeiou" else "a"
            title = hesc(f"{p['title']} Starter Pack · RepoSwipe", quote=True)
            desc = hesc(f"{p['blurb']}. The most-starred GitHub repos {art} {p['title']} actually needs — swipe them into your AI toolkit.", quote=True)
            url = f"{ORIGIN}/pack/{p['id']}/"
            stub = f"""<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title}</title><meta name="description" content="{desc}">
<meta property="og:type" content="website"><meta property="og:site_name" content="RepoSwipe"><meta property="og:title" content="{title}"><meta property="og:description" content="{desc}"><meta property="og:url" content="{url}"><meta property="og:image" content="{ORIGIN}/og/pack.png">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="{title}"><meta name="twitter:description" content="{desc}"><meta name="twitter:image" content="{ORIGIN}/og/pack.png">
<link rel="canonical" href="{url}">
<meta http-equiv="refresh" content="0;url=/#/pack/{p['id']}"><script>location.replace("/#/pack/{p['id']}")</script>
<style>body{{background:#0a0718;color:#EDE9FE;font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}}a{{color:#C084FC}}</style></head>
<body><p>Opening the {hesc(p['title'])} pack… <a href="/#/pack/{p['id']}">tap here</a> if nothing happens.</p></body></html>"""
            open(os.path.join(d, "index.html"), "w", encoding="utf-8").write(stub)
            n += 1
    # /repo/<owner>/<name>, /s/<id>, /add/<owner>/<name> are dynamic: GitHub Pages serves 404.html (= the app),
    # and the app's router reads location.pathname and converts it into the matching hash route.
    urls = [ORIGIN + "/", ORIGIN + "/privacy.html"] + [f"{ORIGIN}/pack/{p['id']}/" for g in groups for p in g["packs"]]
    open(os.path.join(site, "sitemap.xml"), "w").write('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' + "".join(f"  <url><loc>{u}</loc></url>\n" for u in urls) + "</urlset>\n")
    print("site:", n, "pack stubs; index/404/privacy/og/sitemap/CNAME")
