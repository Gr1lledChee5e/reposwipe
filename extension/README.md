# RepoSwipe browser extension (Chrome / Edge / Brave — Manifest V3)

Adds a **Swipe** button next to Watch / Fork / Star on every github.com repository page. One click sends that repo
into your RepoSwipe Stack (it opens `swipe.yeete.ai/#/add/<owner>/<repo>`, which adds it and shows your Stack).
The second button shows the repo as a RepoSwipe card. Right-click any GitHub link anywhere on the web → "Swipe this
repo into RepoSwipe".

Privacy: reads only the repo name from the URL, stores only your chosen RepoSwipe address (if you change it),
makes no network requests of its own, no analytics.

## Install for yourself (2 minutes)
1. Chrome → `chrome://extensions` → turn on **Developer mode** (top right).
2. **Load unpacked** → choose this folder (`reposwipe-extension/`).
3. Open any GitHub repo — the purple Swipe button sits beside Star.

## Publish to the Chrome Web Store
1. Zip the folder contents (not the folder): `cd reposwipe-extension && zip -r ../reposwipe-extension.zip . -x '*.DS_Store'`
2. https://chrome.google.com/webstore/devconsole → one-time $5 developer registration → **New item** → upload the zip.
3. Store listing: name "RepoSwipe — Swipe this repo", category Developer Tools, 1280×800 screenshot (any GitHub repo page
   with the button), icon = `icons/icon128.png`, privacy policy URL `https://swipe.yeete.ai/privacy.html`.
4. Permissions justification (they ask): `storage` = remember a self-hosted RepoSwipe address; `contextMenus` =
   the right-click "Swipe this repo" item; host `github.com` = draw the button on repo pages. Single purpose:
   "send GitHub repositories to the user's RepoSwipe collection". No remote code, no data collection.
5. Review usually takes 1–3 days. Edge Add-ons accepts the same zip (partner.microsoft.com/dashboard).

## Files
`manifest.json` · `background.js` (context menus, opens routes) · `content.js` + `content.css` (the button on
github.com, survives GitHub's SPA navigation) · `popup.html/js` (toolbar popup: swipe current repo, open app, set
address) · `common.js` (shared parsing) · `icons/`.
