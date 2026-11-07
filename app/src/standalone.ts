// TV Watch on its own, on the TV: Arc (WebAssembly, in a worker), the tagger (ONNX in the page), the director and
// TV Watch's own logic (engine/) all run here, and the page's fetch("api/…") / EventSource("api/events") are served by
// them instead of the Mac. On by default on a television (not loopback); ?local forces it in the simulator, ?mac (or
// a fallback after Arc couldn't keep up) keeps the Mac service. YouTube search still asks the Mac (its API key never
// goes into the page).
import type { ArcSink, ArcConfig } from "./engine/engine";
import { ArcLocal, type ArcRecord } from "./arclocal";
import { preload } from "./preload";

type Rec = Record<string, unknown> & { k: string };
const q = new URLSearchParams(location.search);
const loopback = ["127.0.0.1", "localhost"].includes(location.hostname);
const store = { get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string | null) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* */ } } };
export let arcWhere: "tv" | "mac" = "mac";

function chip(text: string) {
  let el = document.getElementById("where");
  if (!el) {
    el = document.createElement("div");
    el.id = "where";
    el.className = "where";
    document.getElementById("root")?.appendChild(el);
  }
  el.textContent = text;
}

// Arc as the engine wants it, while the real one loads: the latest config is kept and applied once it's ready, audio
// before then is dropped (the first seconds of a game), and a spoken question gets its own one-shot Arc.
class ArcProxy implements ArcSink {
  real: ArcLocal | null = null;
  cfg: ArcConfig | null = null;
  ctx = "";
  pushedS = 0;     // audio handed to Arc, seconds
  heardS = 0;      // the audio time of Arc's latest record
  private ask: Promise<ArcLocal> | null = null;
  attach(a: ArcLocal) {
    this.real = a;
    if (this.cfg) this.restart(this.cfg);
    if (this.ctx) a.setContext(this.ctx);
  }
  opts(c: ArcConfig) { return { domain: c.domain, names: c.names, bias: c.bias.join("\n"), frameFloor: 0.2 }; }
  restart(c: ArcConfig) {
    this.cfg = c;
    this.pushedS = this.heardS = 0;
    void this.real?.restart(this.opts(c));
  }
  setContext(t: string) { this.ctx = t; this.real?.setContext(t); }
  push(pcm: Int16Array) {
    if (!this.real) return;
    this.pushedS += pcm.length / 16000;
    this.real.push(pcm);
  }
  async transcribeOnce(pcm: Int16Array, domain: string, names: string): Promise<Rec[]> {
    const recs: Rec[] = [];
    let last = Date.now();
    this.ask ??= ArcLocal.start({ domain, names, threads: 1 }, r => { recs.push(r as Rec); last = Date.now(); });
    const a = await this.ask;
    recs.length = 0;
    await a.restart({ domain, names });
    a.push(pcm);
    a.push(new Int16Array(16000));   // a second of quiet ends the question
    a.finish();
    const t0 = last = Date.now();
    while (Date.now() - last < 1200 && Date.now() - t0 < 8000) await new Promise(r => setTimeout(r, 200));   // quiet 1.2 s, or 8 s
    return recs;
  }
}

async function boot() {
  if (q.has("local")) store.set("tvw.mode", null);   // ?local clears an earlier fallback
  const wantTV = (q.has("local") || !loopback) && !q.has("mac") && store.get("tvw.mode") !== "mac";
  if (!wantTV) { chip("Arc on the Mac"); return; }
  console.log(`[standalone] ${navigator.userAgent} · isolated=${self.crossOriginIsolated} · cores=${navigator.hardwareConcurrency}`);
  const { createDefaultEngine, createLocalBackend, installLocalBackend, loadDirector } = await import("./engine/local");
  const arc = new ArcProxy();
  const engine = await createDefaultEngine({ arc });
  const be = createLocalBackend(engine);
  const realFetch = window.fetch.bind(window);
  // YouTube search (its key stays on the Mac) and the shareable reel (ffmpeg) still ask the Mac when it's there
  const viaMac = (u: string) => /(^|\/)api\/(yt\/|reel)/.test(new URL(u, location.href).pathname);
  installLocalBackend({ ...be, fetch: (u, init) => (viaMac(u) ? realFetch(u, init) : be.fetch(u, init)) });
  engine.start();
  arcWhere = "tv";
  chip("Arc on this TV · loading…");
  (window as unknown as { tvwEngine: unknown }).tvwEngine = engine;   // for the console

  // the heavy parts load behind the first screen; the preloader fills the cache with them (and the demos) first
  void preload().finally(async () => {
    import("./tagger").then(m => m.loadPageTagger()).then(t => { (engine as unknown as { tagger: unknown }).tagger = t; console.log("[standalone] tagger ready"); })
      .catch(e => console.log(`[standalone] tagger unavailable: ${e}`));
    loadDirector().then(d => { (engine as unknown as { director: unknown }).director = d; console.log("[standalone] director ready"); })
      .catch(e => console.log(`[standalone] director unavailable: ${e}`));
    try {
      const threads = self.crossOriginIsolated ? Math.min(3, Math.max(1, (navigator.hardwareConcurrency || 2) - 1)) : 1;
      const t0 = performance.now();
      const real = await ArcLocal.start({ domain: arc.cfg?.domain ?? "nba", names: arc.cfg?.names ?? "", threads, frameFloor: 0.2 },
        (r: ArcRecord) => {
          const t = Number((r as Rec).t ?? 0);
          if (t) arc.heardS = Math.max(arc.heardS, t);
          engine.handle(r as never);
        });
      arc.attach(real);
      console.log(`[arc] ready on this TV: ${real.mode} ${real.threads} thread(s), loaded in ${Math.round(performance.now() - t0)} ms`);
      chip(`Arc on this TV · ${real.threads > 1 ? `${real.threads} threads` : "1 thread"}`);
      watchSpeed(arc, real.threads);
    } catch (e) {
      console.log(`[arc] couldn't start on this TV (${e}); using the Mac`);
      fallBack("Arc couldn't start on this TV");
    }
  });
}

// Real-time factor, measured as the game plays: Arc's lag behind the audio it was given. Falling further behind for
// 20 s means this TV can't keep up, so the next start uses the Mac.
function watchSpeed(arc: ArcProxy, threads: number) {
  let behindSince = 0, lastPushed = 0, lastHeard = 0, lastAt = performance.now();
  setInterval(() => {
    const now = performance.now(), dt = (now - lastAt) / 1000;
    const pushed = arc.pushedS - lastPushed, heard = arc.heardS - lastHeard;
    lastPushed = arc.pushedS; lastHeard = arc.heardS; lastAt = now;
    if (pushed < 1) return;   // nothing playing
    // keeping up: Arc's records advanced as fast as the audio did (1.0); the lag is how far its last record trails
    const lag = arc.pushedS - arc.heardS;
    console.log(`[arc] rtf keep-up ${(heard / pushed).toFixed(2)} lag ${lag.toFixed(1)} s over ${dt.toFixed(0)} s (${threads} thread${threads > 1 ? "s" : ""})`);
    if (lag > 6) { behindSince ||= now; if (now - behindSince > 20000) fallBack("Arc fell behind on this TV"); }
    else behindSince = 0;
  }, 5000);
}

function fallBack(why: string) {
  console.log(`[standalone] ${why}: TV Watch will use the Mac`);
  store.set("tvw.mode", "mac");
  chip("Arc on the Mac");
  setTimeout(() => location.reload(), 1500);
}

await boot().catch(e => { console.log(`[standalone] ${e}`); chip("Arc on the Mac"); });
