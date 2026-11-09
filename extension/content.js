// RepoSwipe extension — content script for github.com
// Adds a "Swipe" button next to Star/Fork on repository pages. Nothing is read from the page except the repo
// name in the URL, nothing is stored, and no network requests are made from here: the click just opens RepoSwipe.
(() => {
  const RESERVED = new Set(["topics","search","orgs","sponsors","features","settings","site","about","collections","trending","marketplace","apps","login","signup","join","pricing","explore","notifications","issues","pulls","codespaces","new","organizations","enterprise","customer-stories","security","readme","contact","events","nonprofit","team","copilot","mobile","sessions","users","account","dashboard"]);
  function repoFromLocation() {
    const parts = location.pathname.split("/").filter(Boolean);
    if (parts.length < 2) return null;
    const [owner, name] = parts;
    if (RESERVED.has(owner.toLowerCase()) || !/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(name)) return null;
    return owner + "/" + name.replace(/\.git$/, "");
  }
  const HEART = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21.2l7.8-7.8 1-1a5.5 5.5 0 0 0 0-7.8z"/></svg>';
  const CARD = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="2" width="14" height="20" rx="3"/><path d="M9 7h6"/><path d="M9 11h6"/></svg>';

  function open(kind, full) {
    try { chrome.runtime.sendMessage({ type: "rs-open", kind, full }); }
    catch (e) { window.open("https://swipe.yeete.ai/#/" + kind + "/" + full, "_blank", "noopener"); }
  }
  function flash(btn, text) {
    const old = btn.innerHTML; btn.classList.add("rs-done"); btn.querySelector(".rs-label").textContent = text;
    setTimeout(() => { btn.classList.remove("rs-done"); btn.innerHTML = old; }, 1800);
  }
  function build(full) {
    const wrap = document.createElement("li");
    wrap.className = "rs-wrap"; wrap.dataset.rsFor = full;
    wrap.innerHTML =
      `<button type="button" class="rs-btn rs-main" title="Add ${full} to your RepoSwipe Stack">${HEART}<span class="rs-label">Swipe</span></button>` +
      `<button type="button" class="rs-btn rs-alt" title="See ${full} as a RepoSwipe card">${CARD}</button>`;
    wrap.querySelector(".rs-main").addEventListener("click", (e) => { e.preventDefault(); open("add", full); flash(e.currentTarget, "Swiped ✓"); });
    wrap.querySelector(".rs-alt").addEventListener("click", (e) => { e.preventDefault(); open("repo", full); });
    return wrap;
  }
  // GitHub's repo header actions (Watch / Fork / Star): locate the Star control near the top of the page and use
  // its <ul>, so the button survives GitHub's class-name churn. Falls back to legacy selectors, then to a float.
  function findActions() {
    const els = [...document.querySelectorAll("a,button")].filter((e) => {
      const r = e.getBoundingClientRect(); if (!(r.width > 0 && r.top < 360)) return false;
      const txt = (e.textContent || "").trim();
      return /^(Un)?[Ss]tar(red)?(\s|\d|$)/.test(txt) || /\/stargazers$/.test(e.getAttribute("href") || "") || /\bstar\b/i.test(e.getAttribute("aria-label") || "");
    });
    for (const e of els) { const ul = e.closest("ul"); if (ul) return ul; }
    return document.querySelector("ul.pagehead-actions") || document.querySelector("#repository-details-container ul") || null;
  }
  function mount() {
    const full = repoFromLocation();
    const existing = document.querySelector(".rs-wrap");
    if (!full) { if (existing) existing.remove(); return; }
    if (existing && existing.dataset.rsFor === full && document.contains(existing)) return;
    if (existing) existing.remove();
    const btn = build(full);
    const host = findActions();
    if (host) { host.prepend(btn); btn.classList.add("rs-inline"); }
    else { btn.classList.add("rs-float"); document.body.appendChild(btn); upgradeLater(btn); }
  }
  // GitHub hydrates the header after document_idle: keep looking for the Star row for a few seconds and move in.
  function upgradeLater(btn) {
    let tries = 0;
    const iv = setInterval(() => {
      if (!document.contains(btn) || btn.classList.contains("rs-inline")) { clearInterval(iv); return; }
      const host = findActions();
      if (host) { btn.classList.remove("rs-float"); btn.classList.add("rs-inline"); host.prepend(btn); clearInterval(iv); }
      else if (++tries > 24) clearInterval(iv);
    }, 500);
  }
  mount();
  // GitHub is a SPA (Turbo): re-mount on navigation and on header re-renders
  document.addEventListener("turbo:load", mount);
  document.addEventListener("turbo:render", mount);
  let last = location.href;
  const mo = new MutationObserver(() => {
    if (location.href !== last) { last = location.href; mount(); return; }
    if (repoFromLocation() && !document.querySelector(".rs-wrap")) mount();
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });
})();
