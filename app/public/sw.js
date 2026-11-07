// TV Watch's service worker: what the preloader put in this TV's cache (the built-in demos, Arc, the tagger, the
// director, the glyphs) is served from the cache, video ranges included; everything else goes to the network as usual.
const CACHE = "tvw-v1";   // the preloader (src/preload.ts) fills it; same name there
const CACHED = /\/(demos|arcwasm|arctag|ort|director|glyphs)\//;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin || !CACHED.test(url.pathname)) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(url.origin + url.pathname);
    if (!hit) return fetch(req);
    // what the cache gives back carries the embedder headers a cross-origin-isolated page requires of its workers
    const iso = { "cross-origin-embedder-policy": "credentialless", "cross-origin-resource-policy": "same-origin" };
    const range = req.headers.get("range");
    if (!range) return new Response(hit.body, { status: 200, headers: { "content-type": hit.headers.get("content-type") || "application/octet-stream", ...iso } });
    // a <video> asks for byte ranges: cut them from the cached file
    const blob = await hit.blob(), size = blob.size;
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = m && m[1] ? Number(m[1]) : 0, end = m && m[2] ? Number(m[2]) : size - 1;
    if (m && !m[1] && m[2]) { start = size - Number(m[2]); end = size - 1; }
    end = Math.min(end, size - 1);
    return new Response(blob.slice(start, end + 1), { status: 206, headers: {
      "content-type": hit.headers.get("content-type") || "video/mp4", "content-range": `bytes ${start}-${end}/${size}`,
      "content-length": String(end - start + 1), "accept-ranges": "bytes", ...iso } });
  })());
});
