// The first launch on a TV: the built-in demos and the models (Arc, the tagger, the director, the scoreboard's glyphs)
// go into this TV's cache once, with a progress screen, and the service worker (public/sw.js) serves them from there
// ever after: the demos never stutter on the network, and Arc starts in seconds. Without a secure page (no service
// worker, no Cache Storage) or room on the TV, everything simply streams as before.
const CACHE = "tvw-v1";

async function assets(): Promise<string[]> {
  const out = ["demos/demos.json", "arcwasm/arc_worker.js", "arcwasm/arc_st.mjs", "arcwasm/arc_st.wasm", "arcwasm/arc_mt.mjs",
    "arcwasm/arc_mt.wasm", "arcwasm/model.json", "arctag/arctag_meta.json", "arctag/tokenizer.json", "arctag/arctag.onnx",
    "ort/ort-wasm-simd-threaded.mjs", "ort/ort-wasm-simd-threaded.wasm", "director/director3.json", "glyphs/templates.json"];
  const demos = await fetch("demos/demos.json").then(r => r.json()).catch(() => ({ clips: [] }));
  for (const c of demos.clips ?? []) out.push(c.src, c.posterUrl);
  const model: [string, number][] = await fetch("arcwasm/model.json").then(r => r.json()).catch(() => []);
  for (const [rel] of model) out.push("arcwasm/model/" + rel);
  return out.filter(Boolean).map(u => new URL(u, location.href).href);
}

function overlay() {
  let el = document.getElementById("preload");
  if (!el) {
    el = document.createElement("div");
    el.id = "preload";
    el.innerHTML = `<div class="box"><div class="t">Getting your demos ready…</div><div class="bar"><i></i></div>
      <div class="s">Downloading the games and Arc to this TV, once. <b>Back</b> skips and streams instead.</div></div>`;
    document.getElementById("root")?.appendChild(el);
  }
  return el;
}

let skip = false;
export async function preload() {
  if (!("serviceWorker" in navigator) || !("caches" in self) || !self.isSecureContext) {
    console.log("[preload] no service worker here (not a secure page): streaming");
    return;
  }
  await navigator.serviceWorker.register("sw.js", { scope: "./" }).catch(e => console.log(`[preload] sw: ${e}`));
  const persisted = await navigator.storage?.persist?.().catch(() => false);
  const est = await navigator.storage?.estimate?.().catch(() => undefined);
  const cache = await caches.open(CACHE);
  const list = await assets();
  const missing: string[] = [];
  for (const u of list) if (!(await cache.match(u))) missing.push(u);
  console.log(`[preload] ${list.length - missing.length}/${list.length} cached · quota ${est ? Math.round((est.quota ?? 0) / 1e6) : "?"} MB, used ${est ? Math.round((est.usage ?? 0) / 1e6) : "?"} MB, persisted ${persisted}`);
  if (!missing.length) return;

  // sizes first, for an honest percentage
  const sizes = await Promise.all(missing.map(u => fetch(u, { method: "HEAD" }).then(r => Number(r.headers.get("content-length") || 0)).catch(() => 0)));
  const total = sizes.reduce((a, b) => a + b, 0) || 1;
  const el = overlay(), bar = el.querySelector("i") as HTMLElement, label = el.querySelector(".t") as HTMLElement;
  const onKey = (e: KeyboardEvent) => { if (["Escape", "Backspace", "GoBack", "BrowserBack"].includes(e.key)) { skip = true; e.preventDefault(); e.stopImmediatePropagation(); } };
  document.addEventListener("keydown", onKey, true);
  let done = 0;
  const t0 = performance.now();
  try {
    for (const u of missing) {
      if (skip) break;
      const r = await fetch(u, { cache: "no-store" });
      if (!r.ok || !r.body) continue;
      const reader = r.body.getReader(), parts: Uint8Array[] = [];
      for (;;) {
        const { done: end, value } = await reader.read();
        if (end) break;
        parts.push(value);
        done += value.length;
        const pct = Math.min(100, Math.round(done / total * 100));
        bar.style.width = `${pct}%`;
        label.textContent = `Getting your demos ready… ${pct}%`;
        if (skip) { await reader.cancel(); break; }
      }
      if (skip) break;
      const type = r.headers.get("content-type") || "application/octet-stream";
      await cache.put(u, new Response(new Blob(parts as BlobPart[], { type }), { headers: { "content-type": type } }));
    }
    console.log(`[preload] ${skip ? "skipped" : "done"}: ${Math.round(done / 1e6)} MB in ${Math.round((performance.now() - t0) / 1000)} s`);
  } catch (e) {
    console.log(`[preload] stopped (${e}): streaming the rest`);   // a full TV (QuotaExceededError) streams instead
  } finally {
    document.removeEventListener("keydown", onKey, true);
    el.remove();
  }
}
