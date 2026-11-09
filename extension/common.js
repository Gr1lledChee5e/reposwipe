// Shared helpers (loaded by popup.js; background.js and content.js inline their own copies — MV3 workers can't share files).
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
