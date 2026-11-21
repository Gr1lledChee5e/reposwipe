// Skill Swipe service worker — offline shell + stale-while-revalidate for the scouts' feed.
// Keep it small: the app itself is one self-contained HTML file.
const V = "ss-v12-4";
const SHELL = "ss-shell-" + V;
const DATA = "ss-data-" + V;
const SHELL_URLS = [
  "/", "/404.html", "/manifest.webmanifest",
  "/pwa/icon-192.png", "/pwa/icon-512.png",
  "/pwa/icon-192-maskable.png", "/pwa/icon-512-maskable.png",
  "/pwa/apple-touch-icon.png",
  "/og/app.png", "/og/pack.png", "/og/weekly.png", "/og/icon512.png",
];
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_URLS).catch(() => {})).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== SHELL && k !== DATA).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;
  // The app shell: network, falling back to cache; refresh the cache on 200.
  if (SHELL_URLS.includes(url.pathname) || url.pathname === "/" || url.pathname === "/index.html") {
    e.respondWith(
      fetch(e.request).then((r) => {
        if (r.ok) { const copy = r.clone(); caches.open(SHELL).then((c) => c.put(e.request, copy)); }
        return r;
      }).catch(() => caches.match(e.request).then((r) => r || caches.match("/")))
    );
    return;
  }
  // The scouts' feed under /data/: stale-while-revalidate.
  if (url.pathname.startsWith("/data/")) {
    e.respondWith(
      caches.open(DATA).then((c) => c.match(e.request).then((cached) => {
        const net = fetch(e.request).then((r) => { if (r.ok) c.put(e.request, r.clone()); return r; }).catch(() => cached);
        return cached || net;
      }))
    );
    return;
  }
  // Static OG images and PWA icons: cache-first.
  if (url.pathname.startsWith("/pwa/") || url.pathname.startsWith("/og/")) {
    e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request)));
    return;
  }
  // Everything else (pack stubs, MCP stubs, privacy, terms): network with cache fallback.
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});
