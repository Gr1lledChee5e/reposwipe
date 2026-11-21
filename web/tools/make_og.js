// Renders the 1200×630 share images (og/app.png, og/pack.png, og/weekly.png). Usage: node tools/make_og.js
const { chromium } = require("playwright-core");
const fs = require("fs"), path = require("path");
const ROOT = path.resolve(__dirname, "..");
const bg = "data:image/jpeg;base64," + fs.readFileSync(path.join(ROOT, "bg.jpg")).toString("base64");
const heart = `<img src="data:image/png;base64,${fs.readFileSync(path.join(ROOT, "brand", "logo-1024.png")).toString("base64")}" width="210" height="210" style="filter:drop-shadow(0 0 30px rgba(16,185,129,.6))">`;
const page = (h2, sub, pill) => `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0}body{width:1200px;height:630px;background:#040B07 url(${bg}) center/cover;font-family:"DejaVu Sans",Arial,sans-serif;color:#EEF7F1;position:relative;overflow:hidden}
.shade{position:absolute;inset:0;background:linear-gradient(90deg,rgba(4,11,7,.82) 0%,rgba(4,11,7,.55) 55%,rgba(4,11,7,.15) 100%)}
.wrap{position:absolute;left:60px;top:0;bottom:0;right:60px;display:flex;align-items:center;gap:36px}
h1{font-size:104px;font-weight:800;letter-spacing:-3px;line-height:1}
h2{font-size:42px;font-weight:800;color:#37DB9D;margin-top:14px;letter-spacing:-.5px}
p{font-size:27px;color:#95DEB4;margin-top:18px;max-width:900px;line-height:1.3}
.pill{display:inline-block;margin-top:34px;background:#1AAC62;color:#fff;font-weight:800;font-size:25px;padding:14px 26px;border-radius:999px}
.url{position:absolute;right:64px;bottom:40px;font-size:25px;font-weight:800;color:#6FB58C}
</style></head><body><div class="shade"></div><div class="wrap">${heart}<div><h1>Skill Swipe</h1><h2>${h2}</h2><p>${sub}</p><span class="pill">${pill}</span></div></div><div class="url">swipe.yeete.ai</div></body></html>`;
const SHOTS = {
  "app.png": ["Swipe GitHub. Build your AI kit.", "Safety-checked repos · 100 job packs · send to your AI", "Swipe right to keep it"],
  "pack.png": ["Starter Packs for your job", "The most-starred repos each role actually needs — live from GitHub", "100 roles · tuned weekly"],
  "weekly.png": ["This Week's Drop", "The best new repos of the week, safety-checked", "New every Monday"],
};
(async () => {
  const cands = ["/opt/pw-browsers/chromium/chrome-linux64/chrome", "/opt/pw-browsers/chromium-1243/chrome-linux64/chrome"];
  let b = null; for (const c of cands) { try { b = await chromium.launch({ executablePath: c, args: ["--no-sandbox"] }); break; } catch (e) {} }
  if (!b) b = await chromium.launch({ args: ["--no-sandbox"] });
  const pg = await b.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  for (const [f, a] of Object.entries(SHOTS)) { await pg.setContent(page(...a)); await pg.screenshot({ path: path.join(ROOT, "og", f) }); console.log("wrote og/" + f); }
  await b.close();
})();
