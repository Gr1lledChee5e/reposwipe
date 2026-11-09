# RepoSwipe

Tinder for GitHub repos. Every card is a live repository from the GitHub API; swipe right to keep it, build your AI
toolkit, grab a Starter Pack for your job (73 roles, tuned weekly), send any repo to Claude / ChatGPT / Perplexity /
Grok, turn repos into skills, connect your own AI keys and MCP servers. Live at **https://swipe.yeete.ai** — a
yeete.ai experiment.

```
web/         the whole app: src.html (+ seed.json + bg.jpg) → build.py → reposwipe.html (one file, no build tools)
             test.js = 122-check Playwright e2e suite · privacy.html · og/ images · site/ = generated deploy output
extension/   Chrome/Edge extension: a "Swipe" button on every github.com repo page (see extension/README.md)
native/      Expo iOS/Android shell that bundles web/reposwipe.html as assets/app.html (added separately)
.github/     push to main → build → test → deploy to GitHub Pages at swipe.yeete.ai
```

## Deploy (automatic)
Every push to `main` runs `.github/workflows/deploy.yml`: builds `reposwipe.html`, generates the static site
(index, 404 fallback for deep links, 73 `/pack/<id>/` pages with Open Graph previews, `privacy.html`, sitemap,
`CNAME`), runs the 122 e2e checks, and publishes to GitHub Pages. The weekly pack-improver pushes here too, so
improvements go live on Monday mornings without anyone uploading anything.

**One-time setup (5 minutes):**
1. Repo → **Settings → Pages → Build and deployment → Source: GitHub Actions.**
2. DNS at your registrar / Hostinger for `yeete.ai`: add a **CNAME** record `swipe` → `<your-github-username>.github.io`
   (TTL default). Then Settings → Pages → Custom domain: `swipe.yeete.ai` → Save → wait for the DNS check →
   tick **Enforce HTTPS** (appears once the certificate is issued, ~5–30 min).
3. Push to `main` (or Actions → "Build · test · deploy" → Run workflow). `https://swipe.yeete.ai` is live when the
   workflow is green.

Prefer a different address? Change `REPOSWIPE_ORIGIN` in the workflow and `SITE_ORIGIN` in `web/src.html`
(`https://swipe.yeete.ai`), and the pack/share links follow.

## Deep links
`/pack/<id>/` (e.g. `/pack/engineer/`) · `/#/repo/<owner>/<name>` · `/#/add/<owner>/<name>` (adds to your Stack —
used by the extension) · `/#/s/<slug>` (a shared Stack, opened in-app). Pretty paths are served by `404.html`,
which is the app itself.

## Local
```
cd web && npm install && npx playwright install chromium
python3 build.py --site        # → reposwipe.html + site/
node test.js                   # 122 checks
python3 -m http.server 8080 --directory site
```
Other hosts: upload `web/reposwipe.html` as `index.html` (and `web/privacy.html`) — the file is self-contained.
