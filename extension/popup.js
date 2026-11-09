(async () => {
  const $ = (id) => document.getElementById(id);
  let origin = await rsOrigin();
  $("origin").value = origin === RS_DEFAULT_ORIGIN ? "" : origin;
  $("origin").addEventListener("change", () => {
    let v = $("origin").value.trim().replace(/\/+$/, "");
    if (v && !/^https?:\/\//.test(v)) v = "https://" + v;
    origin = v || RS_DEFAULT_ORIGIN;
    chrome.storage.sync.set({ origin });
  });
  const go = (path) => chrome.tabs.create({ url: origin.replace(/\/+$/, "") + path });
  $("openBtn").addEventListener("click", () => go("/"));
  $("packsBtn").addEventListener("click", () => go("/#/pack/engineer"));

  let full = null;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    full = tab && tab.url ? rsParseRepo(tab.url) : null;
  } catch (e) {}
  if (full) {
    $("repoBox").style.display = "block"; $("repoName").textContent = full;
    $("addBtn").disabled = false; $("cardBtn").disabled = false;
    $("addBtn").addEventListener("click", () => { go("/#/add/" + full); $("addLabel").textContent = "Swiped ✓"; });
    $("cardBtn").addEventListener("click", () => go("/#/repo/" + full));
  } else {
    $("addLabel").textContent = "Open a GitHub repo page to swipe it";
  }
})();
