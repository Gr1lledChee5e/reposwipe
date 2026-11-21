// Visual check of the v12 screens with stubbed data. Usage: node tools/shots.js <outdir> [scale]
const { chromium } = require("playwright-core");
const path = require("path"), fs = require("fs");
const out = process.argv[2] || ".", scale = +(process.argv[3] || 1);
(async () => {
  let b; for (const c of ["/opt/pw-browsers/chromium/chrome-linux64/chrome", "/opt/pw-browsers/chromium-1243/chrome-linux64/chrome"]) { try { b = await chromium.launch({ executablePath: c, args: ["--no-sandbox"] }); break; } catch (e) {} }
  if (!b) b = await chromium.launch({ args: ["--no-sandbox"] });
  const ctx = await b.newContext({ viewport: { width: 400, height: 860 }, deviceScaleFactor: scale });
  const page = await ctx.newPage();
  const real = JSON.parse(fs.readFileSync(process.env.SNAP_DIR ? path.join(process.env.SNAP_DIR, "weekly.json") : path.resolve(__dirname, "../scan_fixtures.json"), "utf8"));
  await page.addInitScript((weekly) => {
    const f0 = window.fetch; const gen = new Date(Date.now() - 14 * 60000).toISOString();
    const D = { "weekly.json": weekly.repos ? weekly : null, "weekly-index.json": [{ week: "2026-W46", from: "2026-11-02", to: "2026-11-08", count: 12, top: [] }],
      "meta.json": { generated: gen, version: 2, channels: { skills: 448, mcp: 431, claude: 440, agents: 450, coding: 438, rag: 450, automation: 450, trend: 200, hot: 450 }, scan: { clear: 2114, caution: 187, blocked: 46 },
        scouts: [["skills", "Skills Scout", 448], ["mcp", "MCP Scout", 431], ["claude", "Claude Scout", 440], ["agents", "Agents Scout", 450], ["coding", "Coding Scout", 438], ["rag", "Memory Scout", 450], ["automation", "Automation Scout", 450], ["trend", "Trending Scout", 200], ["hot", "Fresh Scout", 450]].map(x => ({ id: x[0], name: x[1], beat: "", channels: [x[0]], found: x[2] })).concat([{ id: "curator", name: "Curator", beat: "", channels: [], found: 128 }]) } };
    window.fetch = (u, i) => { const m = /\/data\/([\w\/.-]+\.json)/.exec(String(u)); if (m) { const d = D[m[1]]; return Promise.resolve(new Response(d ? JSON.stringify(d) : "{}", { status: d ? 200 : 404 })); } return f0(u, i); };
  }, real);
  await page.goto("file://" + path.resolve(__dirname, "../reposwipe.html")); await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(out, "1-splash.png") });
  await page.click("#startBtn"); await page.waitForTimeout(2500);
  const mk = `(id, full, extra) => Object.assign({ id, full_name: full, name: full.split("/")[1], html_url: "https://github.com/" + full, description: "A Claude skill that turns meeting notes into tidy action lists, with owners and due dates.", language: "TypeScript", topics: ["claude-skills", "productivity"], stargazers_count: 4312, forks_count: 231, open_issues_count: 12, pushed_at: new Date(Date.now()-3*864e5).toISOString(), created_at: "2026-09-01T00:00:00Z", owner: { login: full.split("/")[0], avatar_url: "https://avatars.githubusercontent.com/u/76263028?v=4" }, license: { spdx_id: "MIT" }, archived: false }, extra || {})`;
  await page.evaluate((mk) => { window.mkS = new Function("return " + mk)(); feedGen++; page = MAX_PAGES; bulletCache.set(91001, ["Turns raw meeting notes into action lists", "Assigns owners and due dates automatically", "Works as a Claude skill or a CLI"]);
    feed = [mkS(91001, "anthropics/skills", { safety: { l: 0, r: [], n: 6, t: 1 } }), mkS(91002, "acme/notes-skill", { safety: { l: 1, r: ["pipe-shell", "tree-env"], n: 4, t: 1 } })]; renderDeck(); }, mk);
  await page.waitForTimeout(1200); await page.screenshot({ path: path.join(out, "2-card-checked.png") });
  await page.evaluate(() => { feed.shift(); renderDeck(); }); await page.waitForTimeout(900);
  await page.evaluate(() => flip()); await page.waitForTimeout(1500); await page.screenshot({ path: path.join(out, "3-card-back-caution.png") });
  await page.evaluate(() => flip());
  await page.click('.tab[data-tab="packs"]'); await page.waitForTimeout(1200); await page.screenshot({ path: path.join(out, "4-packs-weekly.png") });
  await page.click("#weeklyTile"); await page.waitForTimeout(1500); await page.screenshot({ path: path.join(out, "5-weekly-detail.png") });
  // Super Like with the permission in place
  await page.evaluate(() => { ghUser = { login: "Gr1lledChee5e", avatar_url: "" }; S.ghToken = "x"; ghScopes = "public_repo"; S.superFork = true; S.superSend = true; S.mainAI = "claude";
    const f0 = window.fetch; window.fetch = (u, i) => /\/forks$/.test(String(u)) ? Promise.resolve(new Response(JSON.stringify({ full_name: "Gr1lledChee5e/notes-skill", html_url: "https://github.com/Gr1lledChee5e/notes-skill" }), { status: 202 })) : f0(u, i); window.open = () => null; });
  await page.click('.tab[data-tab="swipe"]'); await page.evaluate(() => { packActive = null; feedGen++; page = MAX_PAGES; feed = [mkS(91002, "acme/notes-skill", { safety: { l: 1, r: ["pipe-shell", "tree-env"], n: 4, t: 1 } })]; renderChips(); renderDeck(); });
  await page.waitForTimeout(600); await page.evaluate(() => buttonCommit("super")); await page.waitForTimeout(1600); await page.screenshot({ path: path.join(out, "6-super-like.png") });
  await page.evaluate(() => { $("match").classList.remove("show"); S.superFork = null; S.superSend = null; feed = [mkS(91003, "acme/first-time")]; renderDeck(); });
  await page.waitForTimeout(500); await page.evaluate(() => buttonCommit("super")); await page.waitForTimeout(900); await page.screenshot({ path: path.join(out, "7-super-offer.png") });
  await page.evaluate(() => { $("match").classList.remove("show"); S.superFork = true; S.superSend = true; });
  await page.click('.tab[data-tab="profile"]'); await page.waitForTimeout(900); await page.screenshot({ path: path.join(out, "8-you-top.png") });
  await page.evaluate(() => document.getElementById("scoutCard").scrollIntoView({ block: "center" })); await page.waitForTimeout(400); await page.screenshot({ path: path.join(out, "9-you-scouts.png") });
  await page.click('.tab[data-tab="stack"]'); await page.waitForTimeout(700); await page.screenshot({ path: path.join(out, "10-stack.png") });
  await b.close(); console.log("shots written to", out);
})();
