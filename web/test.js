// Headless end-to-end test of RepoSwipe Web — clicks every button, checks for errors.
const { chromium } = require("playwright-core");
const path = require("path");
const fs = require("fs");

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log((ok ? "PASS" : "FAIL"), "-", name, detail ? "· " + detail : "");
}

(async () => {
  const exeCands = ["/opt/pw-browsers/chromium/chrome-linux64/chrome", "/opt/pw-browsers/chromium-1243/chrome-linux64/chrome", "/opt/pw-browsers/chromium", "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"];
  let browser = null;
  for (const c of exeCands) { try { browser = await chromium.launch({ executablePath: c, args: ["--no-sandbox"] }); break; } catch (e) {} }
  if (!browser) browser = await chromium.launch({ args: ["--no-sandbox"] }); // CI: browser from `npx playwright install chromium`
  const ctx = await browser.newContext({ acceptDownloads: true, permissions: ["clipboard-read", "clipboard-write"] });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(window, "showSaveFilePicker", { value: undefined, configurable: true });
    Object.defineProperty(window, "showDirectoryPicker", { value: undefined, configurable: true });
    // the snapshot feed (data/*.json on swipe.yeete.ai) is stubbed per test; by default it 404s so the suite stays deterministic
    const f0 = window.fetch; window.__snapData = null;
    window.fetch = (u, i) => { const url = String(u); if (/\/data\/[\w\/-]+\.json/.test(url)) { const key = url.split("/data/")[1]; const d = window.__snapData && window.__snapData[key]; return Promise.resolve(new Response(d ? JSON.stringify(d) : "{}", { status: d ? 200 : 404, headers: { "content-type": "application/json" } })); } return f0(u, i); };
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });

  await page.goto("file://" + path.resolve("reposwipe.html"));
  await page.waitForTimeout(1200);

  // 1. splash + job quiz
  check("splash visible on first run", await page.locator("#splash").isVisible());
  check("job quiz renders role chips", (await page.locator("#roleGrid .rolechip").count()) >= 9);
  await page.click("#startBtn");
  await page.locator("#splash").waitFor({ state: "hidden", timeout: 6000 }).catch(() => {}); // 0.6s CSS transition; slow containers need the poll
  check("splash dismisses", !(await page.locator("#splash").isVisible()));

  // 1b. bullet extraction logic (unit test inside the page)
  const bullets = await page.evaluate(() => parseBullets(
    "# Title\n\nbadge ![x](y)\n\nSome intro paragraph that is long enough to matter here.\n\n## Features\n\n- Downloads files fast with parallel connections and retries\n- Integrates with your browser to capture links automatically\n- Schedules and queues downloads for later processing\n- short\n- [just a link](https://x.com)\n", "desc"));
  check("bullets: extracts feature list (3)", bullets.length === 3 && bullets[0].startsWith("Downloads files fast"), JSON.stringify(bullets).slice(0, 80));
  const bullets2 = await page.evaluate(() => parseBullets("# T\n\nThis tool converts markdown into slides. It supports themes and custom fonts for your decks today.", "fallback"));
  check("bullets: sentence fallback works", bullets2.length >= 1 && /converts markdown/.test(bullets2[0]), JSON.stringify(bullets2).slice(0, 80));
  const bullets3 = await page.evaluate(() => parseBullets("", "the description"));
  check("bullets: description last-resort", bullets3.length === 1 && bullets3[0] === "the description");

  // 1c. live supply engine units
  const links = await page.evaluate(() => parseRepoLinks(
    "- [A](https://github.com/foo/bar) x\n- https://github.com/foo/bar#readme dup\n- https://github.com/baz/qux/tree/main\n- https://github.com/topics/mcp\n- git clone https://github.com/a/b.git\n", ["punkpeye/awesome-mcp-servers"]));
  check("awesome: link mining parses + dedupes", links.join(",") === "foo/bar,baz/qux,a/b", links.join(","));
  const nq = await page.evaluate(() => { const ok = addCustomChannel("rag"); const c = S.customChannels[S.customChannels.length-1]; const r = ok && c.label==="rag" && c.qs.length===2 && S.channelsOn[c.key]; removeCustomChannel(c.key); return r; });
  check("custom channel: topic input builds 2 live queries", nq);
  const totalQueries = await page.evaluate(() => allChannels().filter(c=>S.channelsOn[c.key]).reduce((n,c)=>n+(c.key==="awesome"?1:c.qs.length),0));
  check("supply: multiple live queries per page", totalQueries >= 7, totalQueries + " queries/page across default channels");
  check("LIVE badge present", await page.locator("#live").isVisible());

  // 1e. bug-fix regression tests
  const html = fs.readFileSync("reposwipe.html", "utf8");
  check("no lookbehind regex (old-Safari crash)", !/\(\?<[=!]/.test(html.match(/<script>[\s\S]*<\/script>/)[0]));
  check("wireId maps seed ids positive", await page.evaluate(() => wireId(-123) === 1e12 + 123 && wireId(5) === 5 && wireId(-999999999) > 0));
  const rateSplit = await page.evaluate(() => {
    const fake = (rem, lim) => ({ headers: { get: k => k === "X-RateLimit-Remaining" ? String(rem) : String(lim) } });
    trackRate(fake(12, 30)); trackRate(fake(4800, 5000));
    const a = rateSearch.remaining === 12 && rateInfo.remaining === 4800 && !apiExhausted();
    trackRate(fake(0, 30));
    const b = apiExhausted() && rateInfo.remaining === 4800; // search exhausted ≠ core number clobbered
    rateSearch = null; return a && b;
  });
  check("rate quotas tracked separately (search vs core)", rateSplit);
  const undoGuard = await page.evaluate(() => {
    if (!feed.length) { // synthesize a card so commit path runs even when API-limited
      feed.unshift({ id: 424242, full_name: "t/t", name: "t", html_url: "https://github.com/t/t", description: "x", language: null, topics: [], stargazers_count: 1, forks_count: 0, open_issues_count: 0, pushed_at: new Date().toISOString(), created_at: new Date().toISOString(), owner: { login: "t", avatar_url: "" } });
      renderDeck();
    }
    const stackBefore = S.stack.length, histBefore = undoHist.length;
    buttonCommit("right");           // starts the 310ms fly-off animation
    undo();                          // must be IGNORED while animating
    return new Promise(res => setTimeout(() => {
      const ok = animating === false && undoHist.length === histBefore + 1 && S.stack.length === stackBefore + 1;
      undo();                        // now allowed — clean rollback
      res(ok && S.stack.length === stackBefore);
    }, 700));
  });
  check("undo blocked mid-animation (no lost cards)", undoGuard);
  const genGuard = await page.evaluate(() => { const g = feedGen; void loadFeed(); return feedGen === g + 1; });
  check("feed generation counter invalidates stale fetches", genGuard);
  const awesomeRetry = await page.evaluate(async () => {
    awesomeList = null;
    const realFetch = window.fetch;
    window.fetch = () => Promise.reject(new Error("offline"));
    const r1 = await loadAwesomeList();           // total failure
    const notCached = awesomeList === null;       // must NOT cache the failure
    window.fetch = realFetch;
    return Array.isArray(r1) && r1.length === 0 && notCached;
  });
  check("awesome list failure not cached (retries later)", awesomeRetry);
  const noChan = await page.evaluate(async () => {
    const saved = { ...S.channelsOn };
    for (const k of Object.keys(S.channelsOn)) S.channelsOn[k] = false;
    await loadFeed();
    let msg = document.querySelector("#stage .empty")?.textContent || "";
    for (let i = 0; i < 50 && (fetchingMore || !/No channels on/.test(msg)); i++) { await new Promise(r => setTimeout(r, 200)); if (!fetchingMore) renderDeck(); msg = document.querySelector("#stage .empty")?.textContent || ""; } // wait out an in-flight refill from the previous feed, then settle
    S.channelsOn = saved; save();
    void loadFeed();
    return /No channels on/.test(msg);
  });
  check("all-channels-off shows its own message", noChan);
  await page.waitForTimeout(1500);

  // 1d. add a custom channel through the real UI
  await page.click("#addChipBtn");
  await page.fill("#addChipInput", "voice-agents");
  await page.press("#addChipInput", "Enter");
  await page.waitForTimeout(600);
  check("➕ chip adds ✨ channel via UI", (await page.locator("#channelChips .chchip", { hasText: "voice-agents" }).count()) === 1);
  await page.reload(); await page.waitForTimeout(1200);
  check("custom channel persists after reload", (await page.locator("#channelChips .chchip", { hasText: "voice-agents" }).count()) === 1);
  // remove it again via the ✕
  await page.locator("#channelChips .chchip", { hasText: "voice-agents" }).locator(".x").click();
  await page.waitForTimeout(400);
  check("✕ removes custom channel", (await page.locator("#channelChips .chchip", { hasText: "voice-agents" }).count()) === 0);

  // 2. seeded stack
  await page.click('.tab[data-tab="stack"]');
  await page.waitForTimeout(600);
  const rows = await page.locator("#stackview .srow").count();
  const SEEDN = await page.evaluate(() => SEED.length);
  check(`${SEEDN} seeded favorites in Stack`, rows === SEEDN, `rows=${rows}`);

  // 2b. row links: open / fork / claude
  const popup1 = ctx.waitForEvent("page", { timeout: 5000 }).catch(() => null);
  await page.locator("#stackview .srow").first().click();
  const p1 = await popup1;
  check("Stack row opens GitHub", !!p1 && /github\.com\//.test(p1.url()), p1 ? p1.url() : "no tab");
  if (p1) await p1.close();
  const popup2 = ctx.waitForEvent("page", { timeout: 5000 }).catch(() => null);
  await page.locator("#stackview .rowfork").first().click();
  const p2 = await popup2;
  const forkOk = u => /github\.com\/.+\/fork/.test(u) || /github\.com\/login\?return_to=.*%2Ffork/.test(u); // logged-out browsers get login→fork redirect
  check("Stack 🍴 opens fork page", !!p2 && forkOk(p2.url()), p2 ? p2.url().slice(0, 70) : "no tab");
  if (p2) await p2.close();
  const popup3 = ctx.waitForEvent("page", { timeout: 5000 }).catch(() => null);
  await page.locator("#stackview .rowclaude").first().click();
  const p3 = await popup3;
  check("Stack ✳️ opens Claude with repo", !!p3 && /claude\.ai\/new\?q=.+github\.com/.test(decodeURIComponent(p3.url())), p3 ? p3.url().slice(0, 70) : "no tab");
  if (p3) await p3.close();

  // 3. Save menu + downloads (fallback path)
  await page.click("#saveBtn");
  check("Save menu opens", await page.locator("#saveMenu").isVisible());
  for (const [btn, fname] of [["#saveMd", "reposwipe-stack.md"], ["#saveCfg", "mcp-servers.json"], ["#saveBak", "reposwipe-backup.json"]]) {
    if (!(await page.locator("#saveMenu").isVisible())) await page.click("#saveBtn");
    const dl = page.waitForEvent("download", { timeout: 6000 }).catch(() => null);
    await page.click(btn);
    const d = await dl;
    if (d) {
      const p = path.join("/tmp", "dl-" + d.suggestedFilename());
      await d.saveAs(p);
      const content = fs.readFileSync(p, "utf8");
      check("save works: " + fname, d.suggestedFilename() === fname && content.length > 20, `${content.length} bytes`);
      if (fname.endsWith("stack.md")) check("markdown contains favorites", content.includes("cline/cline"));
      if (fname === "reposwipe-backup.json") {
        const j = JSON.parse(content);
        check("backup has all seeded stack items", j.state.stack.length === SEEDN);
        check("backup excludes GitHub token", !("ghToken" in j.state));
        fs.writeFileSync("/tmp/backup-roundtrip.json", content);
      }
    } else check("save works: " + fname, false, "no download event");
  }
  // save-all fallback: 3 downloads
  if (!(await page.locator("#saveMenu").isVisible())) await page.click("#saveBtn");
  const dls = [];
  const listener = d => dls.push(d.suggestedFilename());
  page.on("download", listener);
  await page.click("#saveAll");
  await page.waitForTimeout(2500);
  page.off("download", listener);
  check("Save-all produces 3 files", dls.length === 3, dls.join(", "));

  // 4. delete + restore round trip
  await page.locator("#stackview .del").first().click();
  await page.waitForTimeout(300);
  check("delete row works", (await page.locator("#stackview .srow").count()) === SEEDN - 1);
  await page.click('.tab[data-tab="profile"]');
  await page.waitForTimeout(400);
  check("Profile renders", await page.locator("#profileview .vtitle").isVisible());
  if (fs.existsSync("/tmp/backup-roundtrip.json")) {
    await page.locator("#impFile").setInputFiles("/tmp/backup-roundtrip.json");
    await page.waitForTimeout(500);
    await page.click('.tab[data-tab="stack"]');
    await page.waitForTimeout(400);
    check("restore from backup brings back all seeds", (await page.locator("#stackview .srow").count()) === SEEDN);
  } else check("restore from backup brings back all seeds", false, "no backup file");

  // 5. swipe view: cards or empty state; hero buttons if a card is live
  await page.click('.tab[data-tab="swipe"]');
  await page.waitForTimeout(2500);
  const hasCard = await page.locator(".card.top").count();
  check("deck rendered (card or empty-state)", (await page.locator("#stage .card").count()) > 0, hasCard ? "live card" : "empty state (API limited here)");
  if (hasCard) {
    const pf = ctx.waitForEvent("page", { timeout: 5000 }).catch(() => null);
    await page.locator(".card.top .forklink").click();
    const f = await pf;
    check("card 🍴 opens fork page", !!f && forkOk(f.url()), f ? f.url().slice(0, 60) : "no tab");
    if (f) await f.close();
    const pc = ctx.waitForEvent("page", { timeout: 5000 }).catch(() => null);
    await page.locator(".card.top .claudelink").click();
    const c = await pc;
    check("card ✳️ opens Claude", !!c && /claude\.ai/.test(c.url()), c ? c.url().slice(0, 60) : "no tab");
    if (c) await c.close();
  } else {
    check("card 🍴 opens fork page", true, "skipped — no live card (API limited)");
    check("card ✳️ opens Claude", true, "skipped — no live card (API limited)");
  }
  const realErr = arr => arr.filter(e => !/net::|Failed to load resource|api.github.com|ERR_|403|404/.test(e));
  const before = realErr(errors).length;
  for (const b of ["#nopeBtn", "#likeBtn", "#supBtn", "#flipBtn", "#undoBtn"]) {
    await page.click(b);
    await page.waitForTimeout(450);
    await page.evaluate(() => { const m = document.getElementById("match"); if (m) m.classList.remove("show"); }); // super-like on a live card opens the match overlay — dismiss so it can't block the next click
  }
  await page.waitForTimeout(600);
  check("action buttons don't crash", realErr(errors).length === before, realErr(errors).slice(before, before + 2).join(" | "));

  // 5b. packs: role-based starter kits ranked by stars
  check("PACKS: 73 packs in 6 groups (incl. Learn AI), all star-filtered", await page.evaluate(() =>
    PACK_GROUPS.length === 6 && PACKS.length === 73 &&
    PACK_GROUPS.map(g => g.group).join() === "Management,Sales,Service,Technical,Other,Learn AI" &&
    PACKS.every(p => p.id && p.emoji && p.title && p.blurb && p.qs.length >= 2 && p.qs.every(q => q.includes("stars:>"))) &&
    new Set(PACKS.map(p => p.id)).size === 73));
  check("Learn AI packs carry the curated study repos", await page.evaluate(() => {
    const picks = PACK_GROUPS[5].packs.flatMap(p => p.picks);
    return picks.length === 10 && ["mlabonne/llm-course", "microsoft/ai-agents-for-beginners", "NirDiamant/GenAI_Agents", "dair-ai/Prompt-Engineering-Guide", "microsoft/ML-For-Beginners"].every(r => picks.includes(r));
  }));
  check("every pack has 4 queries + hand-picked essentials", await page.evaluate(() =>
    PACKS.every(p => p.qs.length >= 4 && Array.isArray(p.picks) && p.picks.length >= 1 &&
      p.picks.every(f => /^[\w.-]+\/[\w.-]+$/.test(f)))));
  check("pack fetch ranks by best stars (sort=stars desc)", /sort=stars&order=desc/.test(html));
  const pickPin = await page.evaluate(async () => {
    const realFetch = window.fetch;
    window.fetch = async (url) => String(url).includes("/search/")
      ? { ok: true, headers: { get: () => null }, json: async () => ({ items: [{ id: 1, full_name: "a/search-big", stargazers_count: 99999, owner: { login: "a", avatar_url: "" } }] }) }
      : { ok: true, headers: { get: () => null }, json: async () => ({ id: 2, full_name: "b/pick-small", stargazers_count: 10, owner: { login: "b", avatar_url: "" } }) };
    const top = await fetchPack({ id: "_t", qs: ["x stars:>1"], picks: ["b/pick-small"] });
    window.fetch = realFetch; packCache.delete("_t");
    return top.length === 2 && top[0].full_name === "b/pick-small" && top[0]._pick === true && top[1].full_name === "a/search-big";
  });
  check("hand-picked repos hydrate live + pin above search results", pickPin);
  await page.click('.tab[data-tab="packs"]');
  await page.waitForTimeout(400);
  check("Packs tab renders 73 tiles in 6 groups", (await page.locator("#packsview .packtile").count()) === 73 && (await page.locator("#packsview .packgroup").count()) === 6);
  await page.fill("#packSearch", "nurse");
  await page.waitForTimeout(200);
  const nurseVis = await page.evaluate(() => [...document.querySelectorAll("#packsview .packtile")].filter(t => t.style.display !== "none").length);
  await page.fill("#packSearch", "");
  await page.waitForTimeout(200);
  const allVis = await page.evaluate(() => [...document.querySelectorAll("#packsview .packtile")].filter(t => t.style.display !== "none").length);
  check("job search filters packs", nurseVis >= 1 && nurseVis < 73 && allVis === 73, `nurse=${nurseVis}, cleared=${allVis}`);
  await page.locator("#packsview .packtile").first().click();
  await page.waitForTimeout(3500);
  const packRows = await page.locator("#packsview .srow").count();
  const packEmpty = await page.locator("#packsview .empty").count();
  check("pack detail renders (repos or API-limited state)", packRows > 0 || packEmpty > 0, packRows ? packRows + " repos" : "empty state (API limited here)");
  if (packRows > 0) {
    const addBtn = page.locator("#packsview .packadd", { hasText: "+" }).first();
    if (await addBtn.count()) {
      const n0 = await page.evaluate(() => S.stack.length);
      await addBtn.click();
      await page.waitForTimeout(300);
      check("pack ➕ adds repo to Stack", await page.evaluate(n => S.stack.length === n + 1, n0));
      await page.evaluate(() => { const r = S.stack.shift(); delete S.swipes[r.repo.id]; save(); updateMeta(); }); // undo for later counts
    } else check("pack ➕ adds repo to Stack", true, "skipped — all pack repos already in Stack");
  } else check("pack ➕ adds repo to Stack", true, "skipped — API limited");
  await page.click("#packBack");
  await page.waitForTimeout(300);
  check("pack back button returns to grid", (await page.locator("#packsview .packtile").count()) === 73);
  const packAdd = await page.evaluate(() => {
    const fake = { id: 987654321, full_name: "test/pack-repo", name: "pack-repo", html_url: "https://github.com/test/pack-repo", description: "d", language: "Go", stargazers_count: 5, owner: { login: "test", avatar_url: "" }, topics: [] };
    const n0 = S.stack.length;
    const a = addPackRepo(fake) === true && S.stack.length === n0 + 1 && S.swipes[987654321] && S.swipes[987654321].dir === "right";
    const b = addPackRepo(fake) === false && S.stack.length === n0 + 1; // dedupe: second add is a no-op
    S.stack = S.stack.filter(s => s.repo.id !== 987654321); delete S.swipes[987654321]; save(); updateMeta();
    return a && b;
  });
  check("addPackRepo adds once + dedupes", packAdd);
  const packSwipeOk = await page.evaluate(() => {
    const mk = i => ({ id: 900000 + i, full_name: "pk/r" + i, name: "r" + i, html_url: "https://github.com/pk/r" + i, description: "d", language: null, stargazers_count: 10 - i, owner: { login: "pk", avatar_url: "" }, topics: [], pushed_at: new Date().toISOString(), created_at: new Date().toISOString() });
    swipePack(PACKS[0], [mk(1), mk(2), mk(3)]);
    return view === "swipe" && packActive && packActive.id === PACKS[0].id && feed.length === 3;
  });
  check("Swipe-these enters pack mode with pack deck", packSwipeOk);
  check("pack mode shows exit chip", (await page.locator("#packChip").count()) === 1);
  check("pack deck renders a card", (await page.locator(".card.top").count()) === 1);
  check("refill is a no-op in pack mode", await page.evaluate(async () => { const pg = page; await refill(); return page === pg && !fetchingMore; }));
  const packDone = await page.evaluate(() => { feed = []; renderDeck(); return !!document.querySelector("#packDone"); });
  check("pack-complete state offers Back to feed", packDone);
  await page.click("#packDone");
  await page.waitForTimeout(600);
  check("exiting pack returns to live feed", await page.evaluate(() => packActive === null) && (await page.locator("#packChip").count()) === 0);

  // 5c. new features: hot channel, rising badge, progress rings, achievements, AI score, quiz nav
  check("🔥 Hot This Week channel exists and is on", await page.evaluate(() =>
    CHANNELS.some(c => c.key === "hot" && c.qs.length >= 3 && c.qs.some(q => q.includes("created:>"))) && S.channelsOn.hot === true));
  check("isRising detects young fast-growing repos", await page.evaluate(() => {
    const now = Date.now(), d = n => new Date(now - n * 864e5).toISOString();
    const young = isRising({ created_at: d(30), pushed_at: d(1), stargazers_count: 500 });
    const old = isRising({ created_at: d(2000), pushed_at: d(400), stargazers_count: 50000 });
    return young === true && old === false;
  }));
  check("pack progress ring tracks collected repos", await page.evaluate(() => {
    const fake = { id: 76543219, full_name: "ringtest/repo", name: "repo", html_url: "https://github.com/ringtest/repo", description: "", language: null, stargazers_count: 1, owner: { login: "ringtest", avatar_url: "" }, topics: [] };
    addPackRepo(fake, "engineer");
    const tracked = (S.packGot.engineer || []).includes(76543219);
    openPackId = null; renderPacks();
    const ring = !!document.querySelector('.packtile[data-id="engineer"] .ring');
    S.stack = S.stack.filter(s => s.repo.id !== 76543219); delete S.swipes[76543219];
    S.packGot.engineer = S.packGot.engineer.filter(i => i !== 76543219); if (!S.packGot.engineer.length) delete S.packGot.engineer;
    save(); updateMeta();
    return tracked && ring;
  }));
  check("achievements: 9 defined, seed stack already unlocked some", await page.evaluate(() => {
    checkAch();
    return ACH.length === 9 && Object.keys(S.achUnlocked).length >= 2 && !!S.achUnlocked.first && !!S.achUnlocked.ten;
  }));
  check("AI score is 0-100 and categories match stack", await page.evaluate(() => {
    const s = aiScore();
    return AI_CATS.length === 6 && typeof s === "number" && s >= 0 && s <= 100 &&
      catHits(AI_CATS.find(c => c.id === "agents")) >= 1; // seeds include agent repos
  }));
  await page.click('.tab[data-tab="profile"]');
  await page.waitForTimeout(1100);
  check("Profile shows AI score ring + achievements grid", (await page.locator("#aiScoreRing").count()) === 1 && (await page.locator(".achcard").count()) === 9);
  const quizNav = await page.evaluate(() => { pickRole("analyst"); return view === "packs" && openPackId === "analyst"; });
  await page.waitForTimeout(400);
  check("quiz role pick jumps into that pack", quizNav);
  await page.evaluate(() => { openPackId = null; });

  // 5d. multi-AI send menu
  check("AI_TARGETS: 4 AIs with prefill deep links", await page.evaluate(() => {
    const u = "https://github.com/foo/bar", enc = encodeURIComponent(u);
    const hosts = { claude: "claude.ai/new?q=", chatgpt: "chatgpt.com/?q=", perplexity: "perplexity.ai/search?q=", grok: "grok.com/?q=" };
    return AI_TARGETS.length === 4 && AI_TARGETS.every(t => {
      const url = t.url(u);
      return url.includes(hosts[t.id]) && url.includes(enc);
    });
  }));
  await page.click('.tab[data-tab="stack"]');
  await page.waitForTimeout(400);
  check("Stack rows have 🤖 any-AI button", (await page.locator("#stackview .rowai").count()) >= 11);
  await page.locator("#stackview .rowai").first().click();
  await page.waitForTimeout(400);
  check("🤖 opens AI picker with 4 AIs + Make a Skill", (await page.locator("#aiMenu .airow[data-ai]").count()) === 4 && (await page.locator("#aiMenu .airow").count()) === 5);
  const pg = ctx.waitForEvent("page", { timeout: 5000 }).catch(() => null);
  await page.locator('#aiMenu .airow[data-ai="chatgpt"]').click();
  const g = await pg;
  check("picker ChatGPT opens chatgpt.com with repo", !!g && /chatgpt\.com\/\?q=.+github\.com/.test(decodeURIComponent(g.url())), g ? g.url().slice(0, 60) : "no tab");
  if (g) await g.close();
  await page.waitForTimeout(300);
  check("AI picker closes after choosing", (await page.locator("#aiMenu").count()) === 0);
  await page.click('.tab[data-tab="swipe"]');
  await page.waitForTimeout(800);
  if (await page.locator(".card.top .ailink").count()) {
    await page.locator(".card.top .ailink").click();
    await page.waitForTimeout(400);
    const open = (await page.locator("#aiMenu .airow[data-ai]").count()) === 4;
    await page.locator("#aiMenu").click({ position: { x: 10, y: 10 } });
    await page.waitForTimeout(300);
    check("card 🤖 opens + backdrop closes picker", open && (await page.locator("#aiMenu").count()) === 0);
  } else check("card 🤖 opens + backdrop closes picker", true, "skipped — no live card (API limited)");

  // 5d2. Make a Skill
  check("skill: SKILL.md built from README (frontmatter, install, features)", await page.evaluate(() => {
    const r = { name: "cool-mcp", full_name: "acme/cool-mcp", html_url: "https://github.com/acme/cool-mcp", description: "An MCP server for cool things." };
    const md = "# cool-mcp\n\nAn MCP server for cool things.\n\n## Features\n\n- Connects Claude to the Cool API with one command\n- Streams results back in real time for long jobs\n- Caches responses locally so repeated calls are instant\n\n## Install\n\n```bash\nnpx -y cool-mcp\nclaude mcp add cool npx -y cool-mcp\n```\n";
    const s = buildSkill(r, md);
    return s.startsWith("---\nname: cool-mcp\ndescription: ") && s.includes("## Install") && s.includes("claude mcp add cool npx -y cool-mcp") &&
      s.includes("## What it does") && s.includes("- Connects Claude to the Cool API") && s.includes("https://github.com/acme/cool-mcp#readme");
  }));
  check("skill: graceful without README + prompt fits a URL", await page.evaluate(() => {
    const r = { name: "x", full_name: "a/x", html_url: "https://github.com/a/x", description: "desc only" };
    const s = buildSkill(r, null), p = skillPrompt("#".repeat(5000), "x");
    return s.includes("desc only") && !s.includes("## Install") && p.length <= 1900 && p.includes("Save this as a skill") &&
      fullNameFromUrl("https://github.com/Foo/Bar.git") === "Foo/Bar" && skillSlug("My Repo!!") === "my-repo";
  }));
  await page.click('.tab[data-tab="stack"]');
  await page.waitForTimeout(400);
  await page.locator("#stackview .rowai").first().click();
  await page.waitForTimeout(300);
  check("AI picker offers Make a Skill", (await page.locator("#aiMenu .skillrow").count()) === 1);
  await page.locator("#aiMenu .skillrow").click();
  await page.waitForTimeout(1500);
  check("skill sheet: download + copy + 3 send targets", await page.evaluate(() =>
    document.querySelector('#aiMenu[data-mode="skill"]') && document.querySelectorAll("#aiMenu .skilldl").length === 1 &&
    document.querySelectorAll("#aiMenu .skillcp").length === 1 && document.querySelectorAll("#aiMenu .skillsend").length === 3 &&
    !document.querySelector('#aiMenu .skillsend[data-ai="perplexity"]')));
  const pdl = page.waitForEvent("download", { timeout: 6000 }).catch(() => null);
  await page.locator("#aiMenu .skilldl").click();
  const sdl = await pdl;
  if (sdl) {
    const body = fs.readFileSync(await sdl.path(), "utf8");
    check("skill download is a real SKILL.md", /-SKILL\.md$/.test(sdl.suggestedFilename()) && body.startsWith("---\nname: ") && body.includes("## Links"), sdl.suggestedFilename());
  } else check("skill download is a real SKILL.md", false, "no download event");
  await page.waitForTimeout(300);
  check("skill sheet closes after download", (await page.locator("#aiMenu").count()) === 0);
  await page.locator("#stackview .rowai").first().click();
  await page.waitForTimeout(300);
  await page.locator("#aiMenu .skillrow").click();
  await page.waitForTimeout(800);
  const psk = ctx.waitForEvent("page", { timeout: 6000 }).catch(() => null);
  await page.locator('#aiMenu .skillsend[data-ai="claude"]').click();
  const sk = await psk;
  check("skill send opens Claude with the SKILL.md in the prompt", !!sk && /claude\.ai\/new\?q=.*Save%20this%20as%20a%20skill/.test(sk.url()), sk ? sk.url().slice(0, 70) : "no tab");
  if (sk) await sk.close();

  // 5e. i18n (v6): 5 languages, helpers, live switching, persistence
  check("i18n: 5 languages + localized data tables", await page.evaluate(() =>
    LANGS.length === 5 && ["en","es","fr","de","zh"].every(l => I18N[l]) &&
    ["es","fr","de","zh"].every(l => PACK_L10N[l] && Object.keys(PACK_L10N[l]).length === PACKS.length && GROUP_L10N[l] && CAT_L10N[l])));
  check("i18n: t() interpolates and falls back to English", await page.evaluate(() => {
    const keep = S.lang; S.lang = "fr";
    const interp = t("ai_send_to", { repo: "foo" }).includes("foo");
    const fb = t("__no_such_key__") === "__no_such_key__";
    S.lang = "zh"; const zhFallsToEn = t("t_live").length > 0;
    S.lang = keep; return interp && fb && zhFallsToEn;
  }));
  await page.click('.tab[data-tab="profile"]');
  await page.waitForTimeout(500);
  check("i18n: You tab has language selector with 5 options", (await page.locator("#langSel option").count()) === 5);
  await page.selectOption("#langSel", "fr");
  await page.waitForTimeout(500);
  check("i18n: French localizes nav + <html lang>", await page.evaluate(() =>
    document.querySelector('.tab[data-tab="swipe"] .tablabel').textContent === "Swiper" && document.documentElement.lang === "fr"));
  check("i18n: French section labels in profile", (await page.locator("#profileview .seclabel", { hasText: "À PROPOS DE MOI" }).count()) === 1);
  await page.click('.tab[data-tab="packs"]');
  await page.waitForTimeout(500);
  check("i18n: packs localized (Ingénieur tile)", (await page.locator('#packsview .packtile[data-id="engineer"] .pt', { hasText: "Ingénieur" }).count()) === 1);
  await page.evaluate(() => setLang("en"));
  await page.waitForTimeout(400);
  check("i18n: switch back to English", await page.evaluate(() =>
    document.querySelector('.tab[data-tab="swipe"] .tablabel').textContent === "Swipe" && document.documentElement.lang === "en"));
  await page.evaluate(() => setLang("de"));
  await page.reload(); await page.waitForTimeout(1200);
  check("i18n: language persists across reload", await page.evaluate(() => S.lang === "de" && document.documentElement.lang === "de"));
  await page.evaluate(() => setLang("en"));
  await page.waitForTimeout(300);

  // 5f. Connections: AI keys + MCP servers + in-app AI (all network stubbed — no real keys, no spend)
  check("connections: no provider until a key is added", await page.evaluate(() => aiProvider() === null && Array.isArray(S.mcpServers)));
  await page.click('.tab[data-tab="profile"]');
  await page.waitForTimeout(500);
  check("connections: You tab shows 3 AI providers + MCP form", (await page.locator("#profileview .aiin").count()) === 3 && (await page.locator("#mcpAdd").count()) === 1 && (await page.locator("#aiDefault option").count()) === 4);
  // stub every network call the connections make
  await page.evaluate(() => {
    window.__reqs = []; window.__realFetch = window.fetch;
    window.fetch = async (url, init) => {
      const u = String(url); const body = init && init.body ? JSON.parse(init.body) : null; window.__reqs.push({ u, h: (init && init.headers) || {}, body });
      const ok = (obj, hdr) => ({ ok: true, status: 200, headers: { get: k => (hdr || {})[k.toLowerCase()] || null }, json: async () => obj, text: async () => JSON.stringify(obj) });
      if (u.startsWith("https://api.anthropic.com/v1/models")) return ok({ data: [{ id: "claude-opus-4-1" }, { id: "claude-sonnet-4-5" }] });
      if (u.startsWith("https://api.anthropic.com/v1/messages")) return ok({ content: [{ type: "mcp_tool_use", name: "search_docs" }, { type: "text", text: "**Hi from Claude.**\n- step one\n- step two" }] });
      if (u.startsWith("https://api.openai.com/v1/models")) return ok({ data: [{ id: "gpt-4o" }, { id: "gpt-4o-mini" }] });
      if (u.startsWith("https://api.openai.com/v1/chat/completions")) return ok({ choices: [{ message: { content: "Hi from GPT" } }] });
      if (u.startsWith("https://mcp.example.com/")) { const m = body && body.method; return ok(m === "tools/list" ? { result: { tools: [{ name: "a" }, { name: "b" }, { name: "c" }] } } : { result: {} }, { "mcp-session-id": "sess-1", "content-type": "application/json" }); }
      return window.__realFetch(url, init);
    };
  });
  await page.fill('.aikey[data-ai="claude"]', "sk-ant-test-key-0000");
  await page.click('.aiin[data-ai="claude"]');
  await page.waitForTimeout(600);
  check("connections: Claude key validates via /v1/models and picks a sonnet model", await page.evaluate(() =>
    S.ai.claudeKey === "sk-ant-test-key-0000" && S.ai.claudeModel === "claude-sonnet-4-5" && aiProvider() === "claude" &&
    __reqs.some(r => r.u.startsWith("https://api.anthropic.com/v1/models") && r.h["x-api-key"] === "sk-ant-test-key-0000" && r.h["anthropic-dangerous-direct-browser-access"] === "true")));
  check("connections: connected row renders with model + disconnect", (await page.locator('.aiout[data-ai="claude"]').count()) === 1);
  check("connections: keys are stripped from backups (MCP keeps name+url only)", await page.evaluate(() => {
    S.mcpServers = [{ name: "demo", url: "https://mcp.example.com/mcp", token: "secret-tok", status: "ok", tools: 3 }]; save();
    const st = JSON.parse(buildBackup()).state;
    const r = !("ai" in st) && st.mcpServers.length === 1 && st.mcpServers[0].url === "https://mcp.example.com/mcp" && !("token" in st.mcpServers[0]);
    S.mcpServers = []; save(); return r;
  }));
  // MCP add via the real form → probe (initialize → tools/list) → row with tool count
  await page.fill("#mcpName", "Demo MCP"); await page.fill("#mcpUrl", "https://mcp.example.com/mcp"); await page.fill("#mcpTok", "tok-123");
  await page.click("#mcpAdd");
  await page.waitForTimeout(800);
  check("mcp: add & test probes initialize → tools/list and stores 3 tools", await page.evaluate(() =>
    S.mcpServers.length === 1 && S.mcpServers[0].status === "ok" && S.mcpServers[0].tools === 3 && S.mcpServers[0].token === "tok-123" &&
    __reqs.filter(r => r.u === "https://mcp.example.com/mcp").map(r => r.body && r.body.method).join(",") === "initialize,notifications/initialized,tools/list" &&
    __reqs.find(r => r.u === "https://mcp.example.com/mcp" && r.body && r.body.method === "tools/list").h["mcp-session-id"] === "sess-1"));
  check("mcp: row renders with connected status", (await page.locator('#mcpList .prow[data-url="https://mcp.example.com/mcp"]').count()) === 1 && (await page.locator("#mcpList .psub", { hasText: "3 tools" }).count()) === 1);
  check("askAI: Claude request carries key, beta header and mcp_servers with auth token", await page.evaluate(async () => {
    __reqs.length = 0;
    const a = await askAI("hello");
    const r = __reqs.find(x => x.u.startsWith("https://api.anthropic.com/v1/messages"));
    return a.provider === "claude" && a.text.includes("Hi from Claude") && a.tools.join() === "search_docs" &&
      r.h["x-api-key"] === "sk-ant-test-key-0000" && r.h["anthropic-beta"] === "mcp-client-2025-04-04" && r.body.model === "claude-sonnet-4-5" &&
      r.body.mcp_servers.length === 1 && r.body.mcp_servers[0].type === "url" && r.body.mcp_servers[0].url === "https://mcp.example.com/mcp" && r.body.mcp_servers[0].authorization_token === "tok-123" && r.body.mcp_servers[0].name === "Demo-MCP" &&
      r.body.messages[0].content === "hello" && typeof r.body.system === "string";
  }));
  check("askAI: mcp:false omits the connector; OpenAI path uses Bearer + chat/completions", await page.evaluate(async () => {
    __reqs.length = 0; await askAI("x", { mcp: false });
    const noMcp = !("mcp_servers" in __reqs[0].body) && !("anthropic-beta" in __reqs[0].h);
    await validateAiKey("openai", "sk-openai-test"); S.ai.provider = "openai"; save();
    __reqs.length = 0; const a = await askAI("y");
    const r = __reqs.find(x => x.u.startsWith("https://api.openai.com/v1/chat/completions"));
    S.ai.provider = "auto"; disconnectAi("openai"); save();
    return noMcp && a.provider === "openai" && a.text === "Hi from GPT" && r.h.Authorization === "Bearer sk-openai-test" && r.body.model === "gpt-4o-mini" && r.body.messages[0].role === "system" && r.body.messages[1].content === "y";
  }));
  check("fmtAi renders safe markdown-lite", await page.evaluate(() => { const h = fmtAi("**b** `c` <script>x</script>\n- item"); return h.includes("<b>b</b>") && h.includes("<code>c</code>") && h.includes("&lt;script&gt;") && h.includes("▸ item"); }));
  // Toolkit Chat from the Stack: question → stubbed Claude answer with tool badge
  await page.click('.tab[data-tab="stack"]');
  await page.waitForTimeout(400);
  await page.click("#askStackBtn");
  await page.waitForTimeout(300);
  check("chat: sheet opens with provider pill + MCP count", (await page.locator('#aiMenu[data-mode="chat"] .aipill', { hasText: "Claude" }).count()) === 1 && (await page.locator('#aiMenu .aipill', { hasText: "1 MCP" }).count()) === 1);
  await page.fill("#chatIn", "What should I set up first?");
  await page.press("#chatIn", "Enter");
  await page.waitForTimeout(700);
  check("chat: answer renders with tool-use badge and stack context in system prompt", await page.evaluate(() => {
    const ai = document.querySelector("#aiMenu .chatmsg.ai"); const r = __reqs.filter(x => x.u.startsWith("https://api.anthropic.com/v1/messages")).pop();
    return !!ai && ai.innerHTML.includes("<b>Hi from Claude.</b>") && ai.querySelector(".aitools") && r.body.system.includes("cline/cline") && r.body.messages.pop().content === "What should I set up first?";
  }));
  await page.locator("#aiMenu").click({ position: { x: 5, y: 5 } });
  await page.waitForTimeout(200);
  // card back shows Ask AI only when connected; skill sheet offers Write with AI; picker offers in-app ask
  await page.click('.tab[data-tab="swipe"]');
  await page.waitForTimeout(500);
  const askOnCard = await page.evaluate(() => { if (!feed.length) { feed.unshift({ id: 555, full_name: "t/ai", name: "ai", html_url: "https://github.com/t/ai", description: "d", language: null, topics: [], stargazers_count: 1, forks_count: 0, open_issues_count: 0, pushed_at: new Date().toISOString(), created_at: new Date().toISOString(), owner: { login: "t", avatar_url: "" } }); } renderDeck(); flip(); return !!document.querySelector("#askai .askaibtn"); });
  check("card back shows Ask AI when an AI is connected", askOnCard);
  await page.evaluate(() => flip());
  await page.locator(".card.top .ailink").click(); await page.waitForTimeout(300);
  check("picker offers Ask your connected AI", (await page.locator("#aiMenu .askinapp").count()) === 1);
  await page.locator("#aiMenu .skillrow").click(); await page.waitForTimeout(400);
  check("skill sheet offers Write with AI", (await page.locator("#aiMenu .skillai").count()) === 1);
  await page.locator("#aiMenu").click({ position: { x: 5, y: 5 } }); await page.waitForTimeout(200);
  // cleanup + restore real fetch; verify key persisted across reload then disconnect
  await page.evaluate(() => { window.fetch = window.__realFetch; });
  await page.reload(); await page.waitForTimeout(1200);
  check("connections: key + MCP server persist across reload", await page.evaluate(() => S.ai.claudeKey === "sk-ant-test-key-0000" && S.mcpServers.length === 1));
  await page.evaluate(() => { disconnectAi("claude"); removeMcpServer("https://mcp.example.com/mcp"); });
  check("connections: disconnect clears key; no provider again", await page.evaluate(() => aiProvider() === null && S.mcpServers.length === 0));

  // 5g. Deep links (v9): #/pack, #/repo, #/add, #/s — GitHub + share backend stubbed
  const fakeRepo = (full) => ({ id: 777001, full_name: full, name: full.split("/")[1], html_url: "https://github.com/" + full, description: "A deep-linked repo", language: "TypeScript", topics: ["mcp"], stargazers_count: 4321, forks_count: 12, open_issues_count: 3, pushed_at: new Date().toISOString(), created_at: "2025-01-01T00:00:00Z", owner: { login: full.split("/")[0], avatar_url: "https://github.com/octocat.png" }, license: null });
  const stubNet = `(() => { window.__realFetch2 = window.fetch; window.__posts = [];
    window.fetch = async (url, init) => {
      const u = String(url); const ok = (body, hdr) => new Response(JSON.stringify(body), { status: 200, headers: Object.assign({ "content-type": "application/json" }, hdr || {}) });
      if (/api\\.github\\.com\\/repos\\/deep\\/linked$/.test(u)) return ok(${JSON.stringify(fakeRepo("deep/linked"))});
      if (/api\\.github\\.com\\/repos\\/deep\\/missing$/.test(u)) return new Response("{}", { status: 404 });
      if (/reposwipe-api\\/share\\/abc123$/.test(u)) return ok({ title: "Yee's AI Toolkit", created_at: "2026-11-09T10:00:00Z", items: [
        { repo_id: 555001, full_name: "shared/one", html_url: "https://github.com/shared/one", description: "first shared", language: "Go", topics: [], stars: 100, avatar_url: "", super_like: true, saved_at: "2026-11-09T10:00:00Z" },
        { repo_id: 555002, full_name: "shared/two", html_url: "https://github.com/shared/two", description: "second shared", language: "Rust", topics: [], stars: 50, avatar_url: "", super_like: false, saved_at: "2026-11-09T10:00:00Z" } ] });
      if (/reposwipe-api\\/share\\/nope$/.test(u)) return new Response("{}", { status: 404 });
      if (/reposwipe-api\\/sync$/.test(u)) { window.__posts.push("sync"); return ok({ ok: true }); }
      if (/reposwipe-api\\/share$/.test(u)) { window.__posts.push("share"); return ok({ slug: "zz9", url: "https://x.supabase.co/functions/v1/reposwipe-api/share/zz9" }); }
      return window.__realFetch2(url, init);
    }; })();`;
  check("deeplinks: parseRoute accepts valid routes and rejects junk", await page.evaluate(() => {
    const a = parseRoute("#/pack/engineer"), b = parseRoute("#/repo/foo/bar.git"), c = parseRoute("#/add/foo/bar/"), d = parseRoute("#/s/abc123");
    return a && a.kind === "pack" && a.id === "engineer" && b && b.full === "foo/bar" && c && c.kind === "add" && c.full === "foo/bar" && d && d.id === "abc123" &&
      parseRoute("#/repo/foo") === null && parseRoute("#/nope/x") === null && parseRoute("#/repo/<script>/x") === null && parseRoute("") === null;
  }));
  check("deeplinks: site origin falls back to swipe.yeete.ai off-web; links are canonical", await page.evaluate(() =>
    siteOrigin() === "https://swipe.yeete.ai" && packLink(PACKS[0]) === "https://swipe.yeete.ai/pack/" + PACKS[0].id + "/" && shareLinkFor("q") === "https://swipe.yeete.ai/#/s/q" && repoLink("a/b") === "https://swipe.yeete.ai/#/repo/a/b"));
  // #/pack/<id> → opens that pack directly (and the address bar mirrors it)
  await page.goto("file://" + path.resolve("reposwipe.html") + "#/pack/analyst"); await page.waitForTimeout(1500);
  check("deeplinks: #/pack/analyst opens the Analyst pack", await page.evaluate(() => view === "packs" && openPackId === "analyst") && /Analyst/.test(await page.locator("#packsview .vtitle").innerText()));
  await page.locator("#packBack").click(); await page.waitForTimeout(300);
  check("deeplinks: leaving the pack clears the hash; opening a pack sets it", await page.evaluate(() => location.hash === "") );
  await page.locator('.packtile[data-id="engineer"]').click(); await page.waitForTimeout(400);
  check("deeplinks: opening a pack writes #/pack/engineer to the URL", await page.evaluate(() => location.hash === "#/pack/engineer"));
  await page.evaluate(() => { location.hash = "#/pack/does-not-exist"; }); await page.waitForTimeout(400);
  check("deeplinks: unknown pack toasts instead of crashing", (await page.locator("#toast").innerText()).length > 0 && await page.evaluate(() => openPackId === "engineer"));
  // #/add → adds to Stack via stubbed GitHub, lands on Stack, strips the one-shot hash
  await page.goto("file://" + path.resolve("reposwipe.html")); await page.waitForTimeout(800);
  await page.evaluate(stubNet);
  await page.evaluate(() => { location.hash = "#/add/deep/linked"; }); await page.waitForTimeout(900);
  check("deeplinks: #/add/deep/linked adds the repo to the Stack and opens it", await page.evaluate(() => view === "stack" && S.stack.some(s => s.repo.full_name === "deep/linked") && location.hash === ""));
  check("deeplinks: Stack list shows the deep-linked repo", (await page.locator('#stackview .srow[data-url="https://github.com/deep/linked"]').count()) === 1);
  await page.evaluate(() => { S.stack = S.stack.filter(s => s.repo.full_name !== "deep/linked"); delete S.swipes[777001]; save(); });
  // #/repo → pins the repo as the top card
  await page.evaluate(() => { location.hash = "#/repo/deep/linked"; }); await page.waitForTimeout(900);
  check("deeplinks: #/repo/deep/linked pins the repo as the top card", await page.evaluate(() => view === "swipe" && feed.length > 0 && feed[0].full_name === "deep/linked") && (await page.locator(".card.top .rname").innerText()) === "linked");
  await page.evaluate(() => { location.hash = "#/repo/deep/missing"; }); await page.waitForTimeout(700);
  check("deeplinks: 404 repo toasts and keeps the deck intact", await page.evaluate(() => feed[0].full_name === "deep/linked" && document.getElementById("toast").textContent.length > 0));
  // #/s/<slug> → shared Stack view, add-all, back to own Stack
  await page.evaluate(() => { location.hash = "#/s/abc123"; }); await page.waitForTimeout(900);
  check("deeplinks: #/s/abc123 renders the shared Stack with title + 2 rows", /Yee's AI Toolkit/.test(await page.locator("#stackview .vtitle").innerText()) && (await page.locator("#shList .srow").count()) === 2);
  const shBefore = await page.evaluate(() => S.stack.length);
  await page.locator("#shAddAll").click(); await page.waitForTimeout(300);
  check("deeplinks: Add all pulls both shared repos into my Stack", await page.evaluate((b) => S.stack.length === b + 2 && S.stack.some(s => s.repo.full_name === "shared/one"), shBefore));
  await page.locator("#shMine").click(); await page.waitForTimeout(400);
  check("deeplinks: back returns to my own Stack and clears the hash", await page.evaluate(() => location.hash === "" && !document.getElementById("shList")) && (await page.locator("#stackview .srow").count()) >= 2);
  await page.evaluate(() => { location.hash = "#/s/nope"; }); await page.waitForTimeout(700);
  check("deeplinks: bad share slug toasts and shows my Stack", await page.evaluate(() => !document.getElementById("shList") && document.getElementById("toast").textContent.length > 0));
  // Share link now points at yeete.ai (#/s/<slug>) instead of the Supabase URL
  await page.evaluate(() => { history.replaceState(null, "", location.pathname); });
  await page.locator("#linkBtn").click(); await page.waitForTimeout(700);
  check("deeplinks: Share link copies swipe.yeete.ai/#/s/<slug>", await page.evaluate(async () => (await navigator.clipboard.readText()) === "https://swipe.yeete.ai/#/s/zz9" && __posts.join(",") === "sync,share"));
  // Pack link button copies the pretty /pack/<id>/ URL
  await page.click('.tab[data-tab="packs"]'); await page.waitForTimeout(300);
  await page.locator('.packtile[data-id="engineer"]').click(); await page.waitForTimeout(1500);
  if (await page.locator("#packShare").count()) { await page.locator("#packShare").click(); await page.waitForTimeout(300);
    check("deeplinks: pack link button copies /pack/engineer/", await page.evaluate(async () => (await navigator.clipboard.readText()) === "https://swipe.yeete.ai/pack/engineer/")); }
  else check("deeplinks: pack link button copies /pack/engineer/", true, "skipped — pack list empty (API limit)");
  await page.evaluate(() => { window.fetch = window.__realFetch2; S.stack = S.stack.filter(s => !/^shared\//.test(s.repo.full_name)); save(); history.replaceState(null, "", location.pathname); });

  // 5h. Auto-translate (v9.1): detection units, Google path (stubbed), AI path (stubbed), card/README/Stack UI, toggle
  check("translate: detectLang spots zh / es / en and leaves short or code-only text alone", await page.evaluate(() =>
    detectLang("一个用于管理 GitHub 仓库的命令行工具，支持批量克隆") === "zh" &&
    detectLang("Una herramienta para gestionar los repositorios de GitHub con soporte para clonar en lote") === "es" &&
    detectLang("A fast CLI tool for managing your GitHub repositories with batch cloning") === "en" &&
    detectLang("npx create-foo") === null && detectLang("https://example.com/x") === null && detectLang("") === null));
  check("translate: needsTranslation respects UI language and the toggle", await page.evaluate(() => {
    const zh = "一个用于管理 GitHub 仓库的命令行工具，支持批量克隆";
    const a = needsTranslation(zh) === true && needsTranslation("A fast CLI tool for managing your GitHub repositories with batch cloning") === false;
    S.autoTranslate = false; const b = needsTranslation(zh) === false; S.autoTranslate = true; return a && b; }));
  await page.evaluate(() => { window.__realFetch3 = window.fetch; window.__trCalls = [];
    window.fetch = async (url, init) => {
      const u = String(url);
      if (/translate\.googleapis\.com/.test(u)) {
        const q = decodeURIComponent(((init && init.body) || "").replace(/^q=/, "").replace(/\+/g, " "));
        window.__trCalls.push(q);
        const segs = q.split("\n").map((line, i, arr) => ["Translated: " + line.replace(/[^\x00-\x7f]+/g, "zh").slice(0, 40) + (i < arr.length - 1 ? "\n" : ""), line]);
        return new Response(JSON.stringify([segs, null, "zh-CN"]), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (/api\.github\.com\/repos\/tr\/demo\/readme$/.test(u)) return new Response(JSON.stringify({ content: btoa(unescape(encodeURIComponent("这是一个中文的自述文件，用来测试翻译。\n第二行也是中文内容，用于验证。\n"))) }), { status: 200, headers: { "content-type": "application/json" } });
      return window.__realFetch3(url, init);
    }; });
  // Stack row with a Chinese description → translated in place with a pill; pill toggles the original back
  await page.evaluate(() => { S.stack.unshift({ repo: { id: 888001, full_name: "tr/demo", name: "demo", html_url: "https://github.com/tr/demo", description: "一个用于管理 GitHub 仓库的命令行工具，支持批量克隆", language: "Go", topics: [], stargazers_count: 10, owner: { login: "tr", avatar_url: "" } }, superLike: false, at: Date.now() }); save(); });
  await page.click('.tab[data-tab="stack"]'); await page.waitForTimeout(700);
  const trRow = page.locator('#stackview .srow[data-url="https://github.com/tr/demo"] .sd');
  check("translate: Stack row shows the translation + 'translated from 中文' pill", (await trRow.locator(".trpill").count()) === 1 && /^Translated:/.test(await trRow.innerText()) && /中文/.test(await trRow.locator(".trpill").innerText()));
  await trRow.locator(".trpill").click(); await page.waitForTimeout(150);
  check("translate: tapping the pill shows the original (and doesn't open the row)", /仓库/.test(await trRow.innerText()) && await page.evaluate(() => view === "stack"));
  await trRow.locator(".trpill").click(); await page.waitForTimeout(150);
  check("translate: tapping again restores the translation", /^Translated:/.test(await trRow.innerText()));
  check("translate: only foreign rows were sent (one batched Google request for the Stack)", await page.evaluate(() => __trCalls.length === 1 && __trCalls[0].indexOf("仓库") >= 0 && __trCalls[0].indexOf("\n") < 0));
  // Card: bullets + README translated on the deck
  await page.evaluate(() => { bulletCache.clear(); feed = [{ id: 888002, full_name: "tr/demo", name: "demo", html_url: "https://github.com/tr/demo", description: "一个用于管理 GitHub 仓库的命令行工具，支持批量克隆", language: "Go", topics: ["cli"], stargazers_count: 10, forks_count: 1, open_issues_count: 0, pushed_at: new Date().toISOString(), created_at: "2025-01-01T00:00:00Z", owner: { login: "tr", avatar_url: "" }, license: null }]; packActive = null; });
  await page.click('.tab[data-tab="swipe"]'); await page.evaluate(() => renderDeck()); await page.waitForTimeout(900);
  check("translate: card bullets get translated with one pill under the list", (await page.locator(".card.top .trnote .trpill").count()) === 1 && /^Translated:/.test(await page.locator(".card.top .bul li").first().innerText()));
  await page.locator(".card.top .trnote .trpill").click(); await page.waitForTimeout(150);
  check("translate: the card pill flips every bullet back to the original (no card flip)", /仓库/.test(await page.locator(".card.top .bul li").first().innerText()) && (await page.locator(".card.top .bul").count()) === 1);
  await page.locator(".card.top .trnote .trpill").click(); await page.waitForTimeout(150);
  await page.evaluate(() => flip()); await page.waitForTimeout(900);
  check("translate: README on the card back is translated with a pill", (await page.locator(".card.top #readme .trpill").count()) === 1 && /Translated:/.test(await page.locator(".card.top #readme").innerText()));
  check("translate: README stays a single request (newlines → per-item path)", await page.evaluate(() => __trCalls.some(q => q.indexOf("\n") >= 0)));
  // AI path: with a connected key, translation goes through askAI (JSON array) and reports the provider
  await page.evaluate(() => { S.ai.claudeKey = "sk-ant-test-key-0000"; S.ai.claudeModel = "claude-sonnet-4-5"; trCache.clear();
    const prev = window.fetch; window.__aiTr = 0;
    window.fetch = async (url, init) => { if (/api\.anthropic\.com\/v1\/messages/.test(String(url))) { window.__aiTr++; const body = JSON.parse(init.body); const items = JSON.parse(body.messages[0].content.slice(body.messages[0].content.indexOf("["))); return new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify(items.map(x => ({ t: "AI: " + x.slice(0, 10), from: "zh" }))) }] }), { status: 200, headers: { "content-type": "application/json" } }); } return prev(url, init); }; });
  const aiTr = await page.evaluate(async () => { const r = await translateTexts(["一个用于管理 GitHub 仓库的命令行工具", "支持批量克隆"]); return r.length === 2 && r[0].via === "claude" && r[0].from === "zh" && /^AI: /.test(r[0].text) && /^AI: /.test(r[1].text) && __aiTr === 1; });
  check("translate: connected AI is preferred (one JSON batch call, provider reported)", aiTr);
  await page.evaluate(() => { disconnectAi("claude"); trCache.clear(); });
  // Toggle off in the You tab → nothing translated, nothing sent
  await page.click('.tab[data-tab="profile"]'); await page.waitForTimeout(400);
  check("translate: You tab shows the auto-translate toggle (on)", (await page.locator("#trToggle").count()) === 1 && /on|sí|oui|an|开/.test(await page.locator("#trToggle").innerText()));
  await page.locator("#trToggle").click(); await page.waitForTimeout(300);
  check("translate: toggle switches off and persists", await page.evaluate(() => S.autoTranslate === false && JSON.parse(localStorage.getItem("reposwipe.v2")).autoTranslate === false));
  await page.evaluate(() => { window.__trCalls.length = 0; }); await page.click('.tab[data-tab="stack"]'); await page.waitForTimeout(500);
  check("translate: with the toggle off, Stack rows stay in the original language and nothing is sent", (await trRow.locator(".trpill").count()) === 0 && /仓库/.test(await trRow.innerText()) && await page.evaluate(() => __trCalls.length === 0));
  await page.evaluate(() => { S.autoTranslate = true; S.stack = S.stack.filter(s => s.repo.full_name !== "tr/demo"); save(); window.fetch = window.__realFetch3; feed = []; });
  check("translate: helper list of language names covers the 5 UI languages", await page.evaluate(() => ["en","es","fr","de","zh"].every(k => LANG_NAMES[k])));

  // 5i. Search bar + filters (v9.2): search mode, qualifiers, client-side mirror, sheet, persistence, deep link, keyboard guard
  const mkRepo = (id, full, lang, stars, daysAgo, lic) => ({ id, full_name: full, name: full.split("/")[1], html_url: "https://github.com/" + full, description: "repo " + full, language: lang, topics: ["mcp"], stargazers_count: stars, forks_count: 1, open_issues_count: 0, pushed_at: new Date(Date.now() - daysAgo * 864e5).toISOString(), created_at: "2025-01-01T00:00:00Z", owner: { login: full.split("/")[0], avatar_url: "" }, license: lic ? { spdx_id: lic } : null, archived: false });
  await page.evaluate((items) => { window.__realFetch4 = window.fetch; window.__searchUrls = [];
    window.fetch = async (url, init) => { const u = String(url);
      if (/api\.github\.com\/search\/repositories/.test(u)) { window.__searchUrls.push(u); return new Response(JSON.stringify({ items }), { status: 200, headers: { "content-type": "application/json", "X-RateLimit-Remaining": "29", "X-RateLimit-Limit": "30" } }); }
      if (/api\.github\.com\/repos\/.*\/readme/.test(u)) return new Response("{}", { status: 404 });
      return window.__realFetch4(url, init); }; }, [mkRepo(700001, "va/big", "Python", 5000, 2, "MIT"), mkRepo(700002, "va/small", "TypeScript", 120, 90, "Apache-2.0"), mkRepo(700003, "va/old", "Python", 20000, 400, "MIT")]);
  check("search: filterSuffix/passesFilters defaults (archived:false only; everything passes)", await page.evaluate(() => filterSuffix() === "archived:false" && filterCount() === 0 && passesFilters({ language: "Go", stargazers_count: 1, pushed_at: null, license: null, archived: false }) && !passesFilters({ archived: true })));
  await page.click('.tab[data-tab="swipe"]'); await page.waitForTimeout(200);
  await page.fill("#feedSearch", "voice agents"); await page.press("#feedSearch", "Enter"); await page.waitForTimeout(900);
  check("search: Enter runs a GitHub search with the query + archived:false, 30 per page", await page.evaluate(() => S.searchQ === "voice agents" && __searchUrls.some(u => /q=voice%20agents%20archived%3Afalse/.test(u) && /per_page=30/.test(u) && /sort=updated/.test(u))));
  check("search: deck shows the results and a search chip replaces the channels", (await page.locator(".card.top .rname").innerText()).startsWith("") && (await page.locator("#searchChip").count()) === 1 && /voice agents/.test(await page.locator("#searchChip").innerText()) && (await page.locator("#channelChips .chchip").count()) === 1);
  check("search: address bar carries #/search/<q> for sharing", await page.evaluate(() => location.hash === "#/search/voice%20agents"));
  check("search: typing z / arrows in the box never swipes", await page.evaluate(async () => { const n = feed.length; const inp = document.getElementById("feedSearch"); inp.focus(); inp.dispatchEvent(new KeyboardEvent("keydown", { key: "z", bubbles: true })); inp.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })); await new Promise(r => setTimeout(r, 100)); inp.blur(); return feed.length === n; }));
  // Filters sheet: stars 1k+, language Python, sort by stars → qualifiers in the URL + client mirror drops the small repo
  await page.click("#filterBtn"); await page.waitForTimeout(300);
  check("filters: sheet opens with language/stars/updated/sort/license/mcp groups", (await page.locator('#aiMenu[data-mode="filters"] .fgroup').count()) === 6);
  await page.locator('.fchip[data-k="stars"][data-v="1000"]').click();
  await page.locator('.fchip[data-k="sort"][data-v="stars"]').click();
  await page.selectOption("#fLang", "Python");
  await page.evaluate(() => { window.__searchUrls.length = 0; });
  await page.click("#fApply"); await page.waitForTimeout(900);
  check("filters: Apply persists and sends language/stars qualifiers with sort=stars", await page.evaluate(() => S.filters.stars === 1000 && S.filters.lang === "Python" && S.filters.sort === "stars" && filterCount() === 3 && __searchUrls.some(u => /language%3APython/.test(u) && /stars%3A%3E%3D1000/.test(u) && /sort=stars&order=desc/.test(u))));
  check("filters: badge shows 3 and the client-side mirror keeps only matching repos, most stars first", (await page.locator("#filterCount").innerText()) === "3" && await page.evaluate(() => feed.every(r => r.language === "Python" && r.stargazers_count >= 1000) && feed[0].full_name === "va/old"));
  await page.evaluate(() => { S.filters.pushed = "month"; save(); }); await page.evaluate(() => loadFeed()); await page.waitForTimeout(700);
  check("filters: 'updated within 30 days' drops the stale repo (client mirror + pushed:> qualifier)", await page.evaluate(() => feed.length === 1 && feed[0].full_name === "va/big" && /pushed%3A%3E/.test(__searchUrls[__searchUrls.length - 1])));
  await page.reload(); await page.waitForTimeout(1200);
  check("filters + search persist across reload (badge, chip, box)", await page.evaluate(() => S.filters.stars === 1000 && S.filters.pushed === "month" && S.searchQ === "voice agents" && document.getElementById("feedSearch").value === "voice agents") && (await page.locator("#filterCount").innerText()) === "4" && (await page.locator("#searchChip").count()) === 1);
  await page.click("#filterBtn"); await page.waitForTimeout(300); await page.click("#fReset"); await page.waitForTimeout(400);
  check("filters: Reset clears everything", await page.evaluate(() => filterCount() === 0 && !document.getElementById("filterBtn").classList.contains("has")));
  await page.locator("#searchChip .x").click(); await page.waitForTimeout(500);
  check("search: ✕ on the chip returns to the channel feed and clears the hash", await page.evaluate(() => S.searchQ === "" && location.hash === "" && document.getElementById("feedSearch").value === "") && (await page.locator("#channelChips .chchip").count()) > 3);
  await page.evaluate(() => { location.hash = "#/search/rag%20memory"; }); await page.waitForTimeout(600);
  check("search: #/search/<q> deep link starts a search", await page.evaluate(() => S.searchQ === "rag memory" && document.getElementById("searchChip") !== null));
  await page.evaluate(() => { setSearch(""); if (window.__realFetch4) window.fetch = window.__realFetch4; }); // (a reload in this section already restored the real fetch)

  // 5j. Snapshot feed (v10): data/*.json served by the site is used for the first pages, packs and Awesome; live API on top
  const snapRepo = (id, full) => ({ id, full_name: full, name: full.split("/")[1], html_url: "https://github.com/" + full, description: "snap " + full, language: "Go", topics: ["mcp"], stargazers_count: 1000 + id % 100, forks_count: 1, open_issues_count: 0, pushed_at: new Date().toISOString(), created_at: "2025-01-01T00:00:00Z", owner: { login: "snap", avatar_url: "" }, license: null, archived: false });
  await page.evaluate((mk) => {
    const mkR = new Function("return " + mk)();
    const list = (prefix, n) => Array.from({ length: n }, (_, i) => mkR(900000 + i + prefix * 1000, "snap/" + prefix + "-" + i));
    window.__snapData = { "channels.json": { generated: new Date(Date.now() - 23 * 60000).toISOString(), channels: { mcp: list(1, 70), claude: list(2, 40), agents: list(3, 95), trend: list(4, 30), hot: list(5, 10) } },
      "awesome.json": { repos: list(6, 45) }, "packs/engineer.json": { repos: list(7, 20).map((r, i) => Object.assign(r, { _pick: i < 2 })) } };
    snap = null; snapLoad = null; snapMeta = null; packCache.clear();
    window.__realFetch5 = window.fetch; window.__liveSearch = 0;
    window.fetch = async (u, i) => { if (/api\.github\.com\/search\/repositories/.test(String(u))) { window.__liveSearch++; return new Response(JSON.stringify({ items: [] }), { status: 200, headers: { "content-type": "application/json" } }); } return window.__realFetch5(u, i); };
    S.channelsOn = { mcp: true, claude: true, agents: true, awesome: true, trend: false, hot: true }; S.customChannels = []; save();
  }, snapRepo.toString());
  await page.evaluate(() => loadFeed()); await page.waitForTimeout(900);
  check("snapshot: first page comes entirely from data/channels.json + awesome.json — zero search API calls", await page.evaluate(() => __liveSearch === 0 && feed.length > 100 && feed.every(r => /^snap\//.test(r.full_name)) && snapMeta !== null));
  check("snapshot: includes Awesome-list repos and respects the channel toggles (no trend)", await page.evaluate(() => feed.some(r => /^snap\/6-/.test(r.full_name)) && !feed.some(r => /^snap\/4-/.test(r.full_name))));
  await page.evaluate(async () => { for (let i = 0; i < 30 && fetchingMore; i++) await new Promise(r => setTimeout(r, 100)); page = 3; await refill(); }); await page.waitForTimeout(300);
  check("snapshot: page 4 falls through to the live API (snapshot holds 3 pages)", await page.evaluate(() => __liveSearch > 0));
  await page.evaluate(() => { S.filters.stars = 1050; save(); }); await page.evaluate(() => loadFeed()); await page.waitForTimeout(700);
  check("snapshot: filters apply client-side to snapshot repos", await page.evaluate(() => feed.length > 0 && feed.every(r => r.stargazers_count >= 1050)));
  await page.evaluate(() => { S.filters.stars = 0; save(); });
  const packSnap = await page.evaluate(async () => { const p = PACKS.find(x => x.id === "engineer"); const r = await fetchPack(p); return r.length === 20 && r[0]._pick === true && r[0].full_name === "snap/7-0" && packCache.has("engineer"); });
  check("snapshot: packs load from data/packs/<id>.json (picks first) with no API calls", packSnap);
  await page.click('.tab[data-tab="profile"]'); await page.waitForTimeout(300);
  check("snapshot: You tab shows the snapshot age", /23m/.test(await page.locator("#snapInfo").innerText()));
  await page.evaluate(() => { window.__snapData = null; snap = null; snapLoad = null; snapMeta = null; packCache.clear(); window.fetch = window.__realFetch5; });
  await page.evaluate(() => loadFeed()); await page.waitForTimeout(500);
  check("snapshot: without data/ the feed goes live exactly as before", await page.evaluate(() => snap === null && snapMeta === null));

  // 5k. Stack export (zip + share sheet) and Stack groups + search (v10)
  const zipInfo = await page.evaluate(() => {
    const z = buildStackZip(); const b = z.bytes; const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const eocd = b.length - 22; const sig = dv.getUint32(eocd, true), entries = dv.getUint16(eocd + 10, true), cdStart = dv.getUint32(eocd + 16, true);
    const names = []; let o = cdStart; for (let i = 0; i < entries; i++) { if (dv.getUint32(o, true) !== 0x02014b50) break; const fl = dv.getUint16(o + 28, true); names.push(new TextDecoder().decode(b.subarray(o + 46, o + 46 + fl))); o += 46 + fl; }
    // data of the first entry must CRC-match its header (store method)
    const fl0 = dv.getUint16(26, true), size0 = dv.getUint32(22, true), crc0 = dv.getUint32(14, true); const data0 = b.subarray(30 + fl0, 30 + fl0 + size0);
    return { sig: sig === 0x06054b50, local: dv.getUint32(0, true) === 0x04034b50, entries, count: z.count, names: names.slice(0, 5), skills: names.filter(n => n.startsWith("skills/")).length, crcOk: crc32(data0) === crc0, name: z.name, stack: S.stack.length };
  });
  check("export: Stack zip is a valid store-method archive (signatures, central directory, CRC)", zipInfo.sig && zipInfo.local && zipInfo.entries === zipInfo.count && zipInfo.crcOk && /^reposwipe-stack-\d{4}-\d\d-\d\d\.zip$/.test(zipInfo.name));
  check("export: zip holds README, md list, MCP config, backup, CSV and one SKILL.md per repo", zipInfo.names.join(",") === "README.txt,reposwipe-stack.md,mcp-servers.json,reposwipe-backup.json,stack.csv" && zipInfo.skills === zipInfo.stack);
  check("export: CSV has a header and one quoted row per repo", await page.evaluate(() => { const c = buildCsv().trim().split("\n"); return c[0].startsWith("full_name,url,description") && c.length === S.stack.length + 1 && /^"[^"]+\/[^"]+","https:\/\/github\.com\//.test(c[1]); }));
  await page.click('.tab[data-tab="stack"]'); await page.waitForTimeout(400);
  await page.click("#saveBtn"); await page.waitForTimeout(200);
  check("export: Save menu offers .zip and Share/Save to Drive", (await page.locator("#saveZip").count()) === 1 && (await page.locator("#saveShare").count()) === 1);
  const [zipDl] = await Promise.all([page.waitForEvent("download", { timeout: 8000 }).catch(() => null), page.click("#saveZip")]);
  check("export: 'Everything as a .zip' downloads the archive", !!zipDl && /reposwipe-stack-.*\.zip$/.test(zipDl.suggestedFilename()));
  await page.evaluate(() => { window.__shared = null; navigator.canShare = (d) => !!(d && d.files && d.files.length); navigator.share = async (d) => { window.__shared = { n: d.files.length, name: d.files[0].name, type: d.files[0].type, size: d.files[0].size }; }; });
  await page.click("#saveBtn"); await page.waitForTimeout(200); await page.click("#saveShare"); await page.waitForTimeout(500);
  check("export: Share / Save to Drive hands the zip to the system share sheet", await page.evaluate(() => __shared && __shared.n === 1 && /\.zip$/.test(__shared.name) && __shared.type === "application/zip" && __shared.size > 1000));
  await page.evaluate(() => { delete navigator.canShare; delete navigator.share; });
  // groups: create via the + chip, move a repo via the picker, filter by chip, tag on rows, search, auto-group, delete, markdown
  await page.evaluate(() => { S.groups = []; S.stack.forEach(s => delete s.group); save(); }); await page.evaluate(() => renderStack()); await page.waitForTimeout(300);
  await page.click("#groupNewBtn"); await page.fill("#groupNewInput", "Zebra"); await page.press("#groupNewInput", "Enter"); await page.waitForTimeout(300);
  check("groups: + New group creates a group and selects its chip", await page.evaluate(() => S.groups.length === 1 && S.groups[0].name === "Zebra" && stackGroup === S.groups[0].id) && (await page.locator('#groupChips .chchip.on', { hasText: "Zebra" }).count()) === 1);
  await page.locator('#groupChips .chchip[data-g=""]').click(); await page.waitForTimeout(300);
  const firstId = await page.evaluate(() => sortedStack()[0].repo.id);
  await page.locator(".rowgroup").first().click(); await page.waitForTimeout(300);
  check("groups: row folder button opens the picker listing the group + No group + New group", (await page.locator('#aiMenu[data-mode="group"] .grow').count()) === 3);
  await page.locator('#aiMenu .grow[data-g]:not([data-g=""])').first().click(); await page.waitForTimeout(300);
  check("groups: picking a group moves the repo and shows a tag on its row", await page.evaluate((id) => S.stack.find(s => s.repo.id === id).group === S.groups[0].id, firstId) && (await page.locator("#stackview .srow .gtag", { hasText: "Zebra" }).count()) === 1);
  await page.locator('#groupChips .chchip', { hasText: "Zebra" }).click(); await page.waitForTimeout(300);
  check("groups: group chip filters the list to that group (1 row); Ungrouped chip appears", (await page.locator("#stackview .srow").count()) === 1 && (await page.locator('#groupChips .chchip[data-g="__none"]').count()) === 1);
  await page.locator('#groupChips .chchip[data-g="__none"]').click(); await page.waitForTimeout(300);
  check("groups: Ungrouped shows the rest", (await page.locator("#stackview .srow").count()) === zipInfo.stack - 1);
  await page.locator('#groupChips .chchip[data-g=""]').click(); await page.waitForTimeout(300);
  await page.fill("#stackSearch", "zebra"); await page.waitForTimeout(200);
  check("stack search: matches group names too, without losing focus", (await page.locator("#stackview .srow:visible").count()) === 1 && await page.evaluate(() => document.activeElement && document.activeElement.id === "stackSearch"));
  await page.fill("#stackSearch", "zzqqxx"); await page.waitForTimeout(200);
  check("stack search: no-match message", (await page.locator("#stackNoMatch").count()) === 1);
  await page.click("#stackSearchClear"); await page.waitForTimeout(300);
  check("stack search: ✕ clears", await page.evaluate(() => stackQ === "") && (await page.locator("#stackview .srow").count()) === zipInfo.stack);
  await page.click("#autoGroupBtn"); await page.waitForTimeout(400);
  check("groups: Auto-group files ungrouped repos into AI-category groups", await page.evaluate(() => S.groups.length >= 3 && S.stack.filter(s => s.group).length > 10));
  check("export: markdown is grouped by section when groups exist", await page.evaluate(() => { const md = buildMarkdown(); return md.indexOf("## Zebra") > 0 && (md.match(/^## /gm) || []).length >= 3; }));
  await page.locator(".rowgroup").first().click(); await page.waitForTimeout(300);
  await page.locator('#aiMenu [data-del]').first().click(); await page.waitForTimeout(300);
  check("groups: deleting a group ungroups its repos", await page.evaluate(() => S.groups.every(g => g.name !== "Zebra") && !S.stack.some(s => s.group === "__gone")));
  await page.reload(); await page.waitForTimeout(1200);
  check("groups persist across reload (and survive in backups)", await page.evaluate(() => S.groups.length >= 2 && S.stack.some(s => s.group) && JSON.parse(buildBackup()).state.groups.length === S.groups.length));
  await page.evaluate(() => { S.groups = []; S.stack.forEach(s => delete s.group); save(); });

  // 6. persistence
  await page.reload(); await page.waitForTimeout(1200);
  check("no splash on second visit", !(await page.locator("#splash").isVisible()));
  await page.click('.tab[data-tab="stack"]'); await page.waitForTimeout(400);
  check("stack persists after reload", (await page.locator("#stackview .srow").count()) >= 11);

  // 6b. native shell bridge: a second page that looks like the iOS/Android WebView
  const np = await ctx.newPage();
  await np.addInitScript(() => {
    window.__msgs = [];
    window.ReactNativeWebView = { postMessage: (m) => window.__msgs.push(JSON.parse(m)) };
  });
  const nErrors = [];
  np.on("pageerror", (e) => nErrors.push(e.message));
  await np.goto("file://" + path.resolve("reposwipe.html"));
  await np.waitForTimeout(1200);
  const bridge = await np.evaluate(async () => {
    const before = __msgs.length;
    const r1 = window.open("https://github.com/foo/bar") === null;        // window.open → bridge, never a popup
    await saveFile("x-SKILL.md", "---\nname: x\n---", "text/markdown");  // save → bridge payload
    navigator.vibrate(8);                                                  // haptics → bridge
    await navigator.clipboard.writeText("hello");                          // clipboard → bridge
    const a = document.createElement("a"); a.href = "https://example.com/z"; document.body.appendChild(a); a.click(); a.remove(); // anchors → bridge
    const types = __msgs.slice(before).map(m => m.type);
    const save = __msgs.find(m => m.type === "save");
    return NATIVE === true && r1 && document.documentElement.classList.contains("native") &&
      ["open","save","haptic","clipboard","open"].every(t => types.includes(t)) &&
      save && save.name === "x-SKILL.md" && save.content.startsWith("---") &&
      __msgs.filter(m => m.type === "open").some(m => m.url === "https://example.com/z");
  });
  check("native bridge: open/save/haptic/clipboard/links route to the shell", bridge);
  check("native shell page has no JS errors", nErrors.length === 0, nErrors.slice(0, 2).join(" | "));
  await np.close();

  // 7. error summary (ignore expected network failures from rate-limited API)
  const real = errors.filter(e => !/net::|Failed to load resource|api.github.com|ERR_/.test(e));
  check("no JS errors", real.length === 0, real.slice(0, 3).join(" | "));

  await browser.close();
  const fails = results.filter(r => !r.ok);
  console.log("\n==== " + (results.length - fails.length) + "/" + results.length + " passed ====");
  if (fails.length) { console.log("FAILURES:"); fails.forEach(f => console.log(" -", f.name, f.detail)); process.exit(1); }
})();
