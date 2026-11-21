#!/usr/bin/env python3
"""Build reposwipe.html from src.html + seed.json + bg.jpg + logo.webp + scan_rules.json.
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
logo = base64.b64encode(open(os.path.join(HERE, "logo.webp"), "rb").read()).decode()   # the emblem (tools/make_brand.py)
rules = json.dumps(json.load(open(os.path.join(HERE, "scan_rules.json"), encoding="utf-8")), separators=(",", ":"))   # the safety-scan rules, shared with scan.py
assert src.count("__SEED__") == 1 and src.count("__BG__") == 1 and src.count("__SCAN_RULES__") == 1 and src.count("__LOGO__") == 1, "placeholders missing"
assert "</script" not in rules.lower()
html = src.replace("__SEED__", seed).replace("__BG__", "data:image/jpeg;base64," + bg).replace("__SCAN_RULES__", rules).replace("__LOGO__", "data:image/webp;base64," + logo)

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
    shutil.copy(os.path.join(HERE, "terms.html"), os.path.join(site, "terms.html"))
    os.makedirs(os.path.join(site, "og"), exist_ok=True)
    for f in ("app.png", "pack.png", "weekly.png", "icon512.png"):
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
            title = hesc(f"{p['title']} Starter Pack · Skill Swipe", quote=True)
            desc = hesc(f"{p['blurb']}. The most-starred GitHub repos {art} {p['title']} actually needs — swipe them into your AI toolkit.", quote=True)
            url = f"{ORIGIN}/pack/{p['id']}/"
            stub = f"""<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title}</title><meta name="description" content="{desc}">
<meta property="og:type" content="website"><meta property="og:site_name" content="Skill Swipe"><meta property="og:title" content="{title}"><meta property="og:description" content="{desc}"><meta property="og:url" content="{url}"><meta property="og:image" content="{ORIGIN}/og/pack.png">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="{title}"><meta name="twitter:description" content="{desc}"><meta name="twitter:image" content="{ORIGIN}/og/pack.png">
<link rel="canonical" href="{url}">
<meta http-equiv="refresh" content="0;url=/#/pack/{p['id']}"><script>location.replace("/#/pack/{p['id']}")</script>
<style>body{{background:#040B07;color:#DFEFE6;font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}}a{{color:#37DB9D}}</style></head>
<body><p>Opening the {hesc(p['title'])} pack… <a href="/#/pack/{p['id']}">tap here</a> if nothing happens.</p></body></html>"""
            open(os.path.join(d, "index.html"), "w", encoding="utf-8").write(stub)
            n += 1
    # This Week's Drop: one share page; the app loads data/weekly.json (written every Monday by the Fresh Scout)
    d = os.path.join(site, "pack", "weekly"); os.makedirs(d, exist_ok=True)
    wt, wd_, wu = "This Week's Drop · Skill Swipe", "The best new GitHub repos of the week for your AI toolkit — picked by the scouts, safety-checked, new every Monday.", f"{ORIGIN}/pack/weekly/"
    open(os.path.join(d, "index.html"), "w", encoding="utf-8").write(f"""<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{hesc(wt)}</title><meta name="description" content="{hesc(wd_, quote=True)}">
<meta property="og:type" content="website"><meta property="og:site_name" content="Skill Swipe"><meta property="og:title" content="{hesc(wt, quote=True)}"><meta property="og:description" content="{hesc(wd_, quote=True)}"><meta property="og:url" content="{wu}"><meta property="og:image" content="{ORIGIN}/og/weekly.png">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="{hesc(wt, quote=True)}"><meta name="twitter:description" content="{hesc(wd_, quote=True)}"><meta name="twitter:image" content="{ORIGIN}/og/weekly.png">
<link rel="canonical" href="{wu}">
<meta http-equiv="refresh" content="0;url=/#/pack/weekly"><script>location.replace("/#/pack/weekly")</script>
<style>body{{background:#040B07;color:#DFEFE6;font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}}a{{color:#37DB9D}}</style></head>
<body><p>Opening This Week's Drop… <a href="/#/pack/weekly">tap here</a> if nothing happens.</p></body></html>""")
    # MCP setup stubs: /mcp/ index + one page per AI the You → USE SKILL SWIPE WITH YOUR AI tiles link to.
    # These stay stubs ("coming soon" + the config they'll need) until the @skillswipe/mcp Node package ships.
    MCP_TILES = [
        ("claude-desktop", "Claude Desktop", "Add Skill Swipe to Claude Desktop", "Edit <code>~/Library/Application Support/Claude/claude_desktop_config.json</code> (macOS) or <code>%APPDATA%\\Claude\\claude_desktop_config.json</code> (Windows), add the entry below under <code>mcpServers</code>, then restart Claude Desktop."),
        ("claude-code",    "Claude Code",    "Add Skill Swipe to Claude Code", "Run the one-line command below in your project, or edit <code>~/.config/claude-code/mcp.json</code> by hand."),
        ("chatgpt",        "ChatGPT",        "Use Skill Swipe from ChatGPT", "ChatGPT's custom-tool support is rolling out gradually. When your plan has it, add a new connector pointing at the Skill Swipe MCP server URL below and sign in with your GitHub account."),
        ("cursor",         "Cursor",         "Add Skill Swipe to Cursor", "In Cursor: Settings → Features → Model Context Protocol → Add new server. Paste the JSON below."),
    ]
    mcp_dir = os.path.join(site, "mcp"); os.makedirs(mcp_dir, exist_ok=True)
    def mcp_stub(title, desc, body):
        return f"""<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{hesc(title)}</title><meta name="description" content="{hesc(desc, quote=True)}">
<meta property="og:type" content="website"><meta property="og:site_name" content="Skill Swipe"><meta property="og:title" content="{hesc(title, quote=True)}"><meta property="og:description" content="{hesc(desc, quote=True)}"><meta property="og:image" content="{ORIGIN}/og/app.png">
<style>body{{background:#040B07;color:#DFEFE6;font-family:-apple-system,system-ui,sans-serif;max-width:720px;margin:0 auto;padding:40px 24px;line-height:1.55}}
h1{{font-size:28px;color:#37DB9D;margin:0 0 6px}}h2{{font-size:18px;color:#DFEFE6;margin:28px 0 8px}}p{{color:#B3D7C3}}
a{{color:#37DB9D}}code{{background:rgba(26,172,98,.14);padding:2px 6px;border-radius:5px;font-size:92%}}
pre{{background:rgba(3,9,6,.7);border:1px solid rgba(26,172,98,.3);padding:14px;border-radius:12px;overflow:auto;font-size:13px}}
.note{{background:rgba(251,191,36,.08);border:1px solid rgba(251,191,36,.3);padding:12px 14px;border-radius:12px;margin:18px 0;color:#F5E4B3;font-size:14px}}
.back{{display:inline-block;margin-bottom:18px;color:#6A9C7F;text-decoration:none;font-size:13px}}</style></head>
<body><a class="back" href="/">← Skill Swipe</a>{body}<p style="margin-top:36px;font-size:12px;color:#6A9C7F">Skill Swipe · <a href="{ORIGIN}/mcp/">All MCP setups</a> · <a href="{ORIGIN}/privacy.html">Privacy</a></p></body></html>"""
    config_snippet = '{\n  "mcpServers": {\n    "skillswipe": {\n      "command": "npx",\n      "args": ["-y", "@skillswipe/mcp"]\n    }\n  }\n}'
    for mid, name, title, how in MCP_TILES:
        body = f"<h1>{hesc(name)}</h1><p>{hesc(title)}.</p><div class=\"note\"><b>Coming soon.</b> The <code>@skillswipe/mcp</code> package isn't published yet. When it is, this page will have the final install command. For now, here's the planned configuration so you can see what to expect.</p></div><h2>How</h2><p>{how}</p><h2>Configuration</h2><pre><code>{hesc(config_snippet)}</code></pre><p>The server exposes your <b>Stack</b> as read-only tools so any AI can list, search and open the repos you've saved. Your Skill Swipe account signs it in; no extra token is needed.</p>"
        d = os.path.join(mcp_dir, mid); os.makedirs(d, exist_ok=True)
        open(os.path.join(d, "index.html"), "w", encoding="utf-8").write(mcp_stub(f"{name} · Skill Swipe MCP", title, body))
    index_body = "<h1>Skill Swipe MCP</h1><p>Use Skill Swipe with your AI through the Model Context Protocol. Pick your AI:</p><ul>" + "".join(f'<li><a href="/mcp/{mid}/">{hesc(name)}</a></li>' for mid, name, _, _ in MCP_TILES) + "</ul><p>These setups ship with v12.3 as placeholders. The <code>@skillswipe/mcp</code> package follows.</p>"
    open(os.path.join(mcp_dir, "index.html"), "w", encoding="utf-8").write(mcp_stub("Skill Swipe MCP", "Use Skill Swipe with your AI through the Model Context Protocol.", index_body))
    # /repo/<owner>/<name>, /s/<id>, /add/<owner>/<name> are dynamic: GitHub Pages serves 404.html (= the app),
    # and the app's router reads location.pathname and converts it into the matching hash route.
    urls = [ORIGIN + "/", ORIGIN + "/privacy.html", ORIGIN + "/terms.html", ORIGIN + "/pack/weekly/", ORIGIN + "/mcp/"] + [f"{ORIGIN}/mcp/{mid}/" for mid, _, _, _ in MCP_TILES] + [f"{ORIGIN}/pack/{p['id']}/" for g in groups for p in g["packs"]]
    open(os.path.join(site, "sitemap.xml"), "w").write('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' + "".join(f"  <url><loc>{u}</loc></url>\n" for u in urls) + "</urlset>\n")
    print("site:", n, "pack stubs; index/404/privacy/og/sitemap/CNAME")
