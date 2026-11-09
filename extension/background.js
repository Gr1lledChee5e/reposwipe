// RepoSwipe extension — background service worker (MV3).
// Right-click any GitHub repo link (or any GitHub repo page) → "Swipe this repo into RepoSwipe".
const RS_DEFAULT_ORIGIN = "https://swipe.yeete.ai";
const RS_RESERVED = new Set(["topics","search","orgs","sponsors","features","settings","site","about","collections","trending","marketplace","apps","login","signup","join","pricing","explore","notifications","issues","pulls","codespaces","new","organizations","enterprise","customer-stories","security","readme","contact","events","nonprofit","team","copilot","mobile","sessions","users","account","dashboard"]);
function rsParseRepo(url) {
  try {
    const u = new URL(url);
    if (u.hostname !== "github.com") return null;
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length < 2) return null;
    const [owner, name] = parts;
    if (RS_RESERVED.has(owner.toLowerCase())) return null;
    if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(name)) return null;
    return owner + "/" + name.replace(/\.git$/, "");
  } catch (e) { return null; }
}
function rsOrigin() {
  return new Promise((resolve) => {
    try { chrome.storage.sync.get({ origin: RS_DEFAULT_ORIGIN }, (v) => resolve((v && v.origin) || RS_DEFAULT_ORIGIN)); }
    catch (e) { resolve(RS_DEFAULT_ORIGIN); }
  });
}
async function openRoute(kind, full) {
  const origin = (await rsOrigin()).replace(/\/+$/, "");
  chrome.tabs.create({ url: origin + "/#/" + kind + "/" + full });
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: "rs-swipe-link", title: "Swipe this repo into RepoSwipe", contexts: ["link"], targetUrlPatterns: ["https://github.com/*"] });
  chrome.contextMenus.create({ id: "rs-swipe-page", title: "Swipe this repo into RepoSwipe", contexts: ["page"], documentUrlPatterns: ["https://github.com/*"] });
  chrome.contextMenus.create({ id: "rs-card-page", title: "See this repo as a RepoSwipe card", contexts: ["page"], documentUrlPatterns: ["https://github.com/*"] });
});

chrome.contextMenus.onClicked.addListener((info) => {
  const url = info.menuItemId === "rs-swipe-link" ? info.linkUrl : info.pageUrl;
  const full = rsParseRepo(url || "");
  if (!full) return;
  openRoute(info.menuItemId === "rs-card-page" ? "repo" : "add", full);
});

// content script / popup ask the worker to open routes (keeps tab creation in one place)
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "rs-open" && msg.full && /^(add|repo)$/.test(msg.kind)) { openRoute(msg.kind, msg.full); sendResponse({ ok: true }); }
  return false;
});
