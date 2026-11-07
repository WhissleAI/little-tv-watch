// Arc on the TV itself: libarc compiled to WebAssembly (public/arcwasm/, built by arc-wasm/build.sh),
// running in a Web Worker, emitting the same records arc_tv prints for tvwatch.py: {k:"partial"|"final"|"tags",
// id, t, start, end, text, tags[{tag,text,wb,we}], intent, act, tags_final}, {k:"frame", t, sp, p:{label: p}},
// {k:"event", t, label, start, end, p}. Measured real-time factor (60 s of NBA commentary, partials every 1 s,
// frames at 0.2): Mac native 0.25 (1 thread); wasm in Chrome on the Mac 0.29 (1 thread), 0.15 (3 threads, needs a
// cross-origin-isolated page). The TV's own numbers: public/arcwasm/bench.html.
//
//   const arc = await ArcLocal.start({ domain: "nba", names: rosterText }, rec => engine.handle(rec));
//   arc.push(int16Pcm16k);                 // as audio arrives (any chunk size)
//   arc.setContext("Jalen Brunson|person\n…");   // recent names, like tvwatch's context.txt
//   await arc.restart({ domain: "soccer", names })   // a new game: a fresh stream (the model stays loaded)
//   arc.close();
//
// Threads: the worker uses the threaded build only when the page is cross-origin isolated (COOP same-origin + COEP
// require-corp or credentialless). Under COEP the YouTube player's iframe needs the `credentialless` attribute
// (Chrome 110+) or it won't load; without isolation Arc runs single-threaded.

export type ArcRecord = { k: "partial" | "final" | "tags" | "frame" | "event"; [key: string]: unknown };
export type ArcOptions = { domain?: string; names?: string; bias?: string; threads?: number; partialMs?: number;
  partialWindow?: number; frameFloor?: number };

export class ArcLocal {
  private constructor(private w: Worker, public mode: string, public threads: number, public loadMs: number) {}

  // public/arcwasm sits one level above this module (src/ in dev, assets/ in a build); the path is joined at run time
  // so the bundler doesn't rewrite it
  static start(opts: ArcOptions, onRecord: (r: ArcRecord) => void, base = new URL(["..", "arcwasm", ""].join("/"), import.meta.url).href) {
    const w = new Worker(base + "arc_worker.js", { type: "module" });
    return new Promise<ArcLocal>((resolve, reject) => {
      w.onmessage = e => {
        const m = e.data;
        if (m.type === "rec") onRecord(m.rec);
        else if (m.type === "ready" && !ready) { ready = new ArcLocal(w, m.mode, m.threads, m.loadMs); resolve(ready); }
        else if (m.type === "error") { console.log(`[arclocal] ${m.message}`); if (!ready) reject(new Error(m.message)); }
        else if (m.type === "log") console.log(`[arclocal] ${m.text}`);
      };
      // a worker that can't load at all (script, import, memory) never posts an error of its own
      w.onerror = e => { console.log(`[arclocal] worker failed: ${e.message || e.type}`); if (!ready) reject(new Error(e.message || "worker failed")); };
      let ready: ArcLocal | null = null;
      w.postMessage({ type: "open", ...opts });
    });
  }

  push(pcm: Int16Array) {
    const c = pcm.slice();   // the copy is handed to the worker, not cloned
    this.w.postMessage({ type: "pcm", data: c }, [c.buffer]);
  }
  setContext(text: string) { this.w.postMessage({ type: "context", text }); }
  restart(opts: ArcOptions) {
    return new Promise<void>(resolve => {
      const prev = this.w.onmessage;
      this.w.onmessage = e => { if (e.data.type === "ready") { this.w.onmessage = prev; resolve(); } else prev?.call(this.w, e); };
      this.w.postMessage({ type: "open", ...opts });
    });
  }
  finish() { this.w.postMessage({ type: "finish" }); }
  close() { this.w.postMessage({ type: "close" }); this.w.terminate(); }
}
