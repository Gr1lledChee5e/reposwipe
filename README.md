# Skill Swipe

Tinder for GitHub repos — formerly RepoSwipe. Every card is a real repository; swipe right to keep it and build your
AI toolkit. Live at **https://swipe.yeete.ai** — a yeete.ai experiment.

- **Ten scouts** refresh the feed every hour (Skills, MCP, Claude, Agents, AI Coding, Memory & RAG, Automation,
  Trending, Fresh, Curator) — all on this repo's own API allowance, never extra accounts.
- **Safety scan**: an inspector checks what the scouts find (install hooks, encoded payloads, credential theft,
  hidden instructions aimed at AIs, leaked secrets, clone/fake-star campaigns). Dangerous repos are dropped; the rest
  carry their verdict into the app, which re-checks on your device before a fork or an AI send. A help, not a guarantee.
- **This Week's Drop**: the best new repos of the week, frozen every Monday, with earlier weeks archived.
- **Super Like** = safety check → fork to your GitHub → send to your main AI (opt-in; one GitHub permission).
- 100 job Starter Packs (27 of them for computer & tech jobs), search + filters, Stack groups/export/share links, auto-translate, optional account with
  cross-device sync, your own AI keys and MCP servers, GitHub stars import.

```
web/         the whole app: src.html (+ seed.json + bg.jpg + logo.webp + scan_rules.json) → build.py → reposwipe.html (one file)
             brand/ = the emblem as supplied + tools/make_brand.py → logo.webp, bg.jpg (green nebula), icons
             snapshot.py = the scouts · scan.py = the inspector · scan_rules.json = the rules both engines share
             test.js = 246-check Playwright suite · tools/ = rule + fixture generators, self-test, OG images, screenshots
             privacy.html · og/ · user_state.sql (sync table) · site/ + data/ = generated, not committed
extension/   Chrome/Edge extension: a "Swipe" button on every github.com repo page (see extension/README.md)
.github/     push to main or the hourly schedule → scouts → build → test → deploy to GitHub Pages at swipe.yeete.ai
```

## Deploy (automatic)
`.github/workflows/deploy.yml` runs on every push to `web/**` and every hour at :23. It self-tests the scan rules,
runs the scouts and the inspector (`snapshot.py` → `data/`), builds the site, runs the 246 checks (the gate), and
publishes to GitHub Pages. If GitHub is having a bad hour the previously published data is kept.

**More scanning per hour (optional):** add a repo secret `SNAPSHOT_TOKEN` — a fine-grained personal access token on
*this same account* with public read-only access. It lifts the allowance from 1,000 to 5,000 API calls an hour, so the
inspector deep-scans more repos per run. Do not create extra accounts for this: GitHub allows one free account per
person and treats extra accounts used to get around rate limits as abuse.

**One-time setup:** Settings → Pages → Source: GitHub Actions; DNS `CNAME swipe → <username>.github.io`; custom
domain `swipe.yeete.ai` + Enforce HTTPS. Sign-in uses Supabase Auth (GitHub + Google providers) and the
`reposwipe_user_state` table from `web/user_state.sql`.

## Changing the safety rules
Edit `web/tools/gen_scan_rules.py`, run it (writes `scan_rules.json`), add a case to `tools/gen_scan_fixtures.py`,
then `python3 tools/scan_selftest.py` and `node test.js`. Every pattern must compile in both Python and JavaScript —
the fixtures run through both engines so they cannot drift.

## Deep links
`/pack/<id>/` · `/pack/weekly/` (This Week's Drop) · `/#/pack/weekly-2026-W46` (an earlier drop) ·
`/#/repo/<owner>/<name>` · `/#/add/<owner>/<name>` · `/#/s/<slug>` · `/#/search/<query>`. Pretty paths are served
by `404.html`, which is the app itself.

## Local
```
cd web && npm install && npx playwright install chromium
python3 tools/scan_selftest.py        # scan rules vs fixtures (Python engine)
python3 snapshot.py --pages 1 --limit-packs 2 --scan-max 50   # a small scout run → data/
python3 build.py --site               # → reposwipe.html + site/
node test.js                          # 246 checks
python3 -m http.server 8080 --directory site
```
Internal names (`reposwipe.html`, the `reposwipe.*` storage keys, the `reposwipe_*` tables, this repo's name) are
unchanged on purpose: renaming them would sign people out or lose their saved Stack.
