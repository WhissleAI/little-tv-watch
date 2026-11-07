// The page's backend, either way: the remote tvwatch on the laptop (today), or the engine running right here on the
// TV. createLocalBackend() answers the same /api calls and streams the same /api/events messages as tvwatch.py, so
// installLocalBackend() can slot it under the page's own fetch() and EventSource without main.ts changing its calls.
import { Engine, type ArcRec, type ArcSink, type DirectorLike, type Store, type TaggerLike } from "./engine.ts";

const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status, headers: { "content-type": "application/json" } });

async function bodyOf(init?: RequestInit): Promise<{ text: string; bytes: ArrayBuffer }> {
  const b = init?.body;
  if (b == null) return { text: "", bytes: new ArrayBuffer(0) };
  if (typeof b === "string") return { text: b, bytes: new TextEncoder().encode(b).buffer as ArrayBuffer };
  const bytes = await new Response(b as BodyInit).arrayBuffer();
  return { text: new TextDecoder().decode(bytes), bytes };
}

/** the /api/events stream, from the engine instead of a server: same event names, same JSON */
export class LocalEventSource extends EventTarget {
  onopen: ((e: Event) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  readyState = 0;
  readonly url: string;
  private off: () => void;
  constructor(engine: Engine, url = "api/events") {
    super();
    this.url = url;
    this.off = engine.on((kind, data) => this.dispatchEvent(new MessageEvent(kind, { data: JSON.stringify(data) })));
    setTimeout(() => {   // like a real stream: open, then hello with everything the page needs to draw
      this.readyState = 1;
      const open = new Event("open");
      this.onopen?.(open);
      this.dispatchEvent(open);
      this.dispatchEvent(new MessageEvent("hello", { data: JSON.stringify(engine.hello()) }));
    }, 0);
  }
  close() { this.readyState = 2; this.off(); }
}

export type LocalBackend = { engine: Engine; fetch: (url: string, init?: RequestInit) => Promise<Response>; EventSource: (url: string) => LocalEventSource };

export function createLocalBackend(engine: Engine, opts: { ytKey?: () => string | null } = {}): LocalBackend {
  async function handle(path: string, query: URLSearchParams, method: string, init?: RequestInit): Promise<Response> {
    const e = engine;
    if (method === "GET") {
      if (path === "state") return json(e.stateJson());
      if (path === "facts") return json(e.facts());
      if (path === "catchup") return json(e.catchup());
      if (path === "yt/search") return json(await ytSearch(query.get("q") ?? "", query.get("live") === "1", opts.ytKey?.() ?? null));
      return json({}, 404);
    }
    const { text, bytes } = await bodyOf(init);
    if (path === "pcm") {   // the page's audio: straight into Arc on this TV
      e.arc?.push?.(new Int16Array(bytes.slice(0, bytes.byteLength - (bytes.byteLength % 2))));
      return json({});
    }
    if (path === "ask") {   // a spoken question: Arc on its own (assistant domain), then the facts to answer from
      const pcm = new Int16Array(bytes.slice(0, bytes.byteLength - (bytes.byteLength % 2)));
      const finals: ArcRec[] = e.arc?.transcribeOnce ? (await e.arc.transcribeOnce(pcm, "assistant", e.arcNames()).catch(() => [])).filter(r => r.k === "final") : [];
      const heard = { text: finals.map(f => f.text ?? "").join(" ").trim(), intent: finals.find(f => f.intent)?.intent ?? null,
        tags: finals.flatMap(f => f.tags ?? []) };
      e.tele("ask", { text: heard.text, intent: finals.map(f => f.intent) });
      return json({ heard, facts: e.facts() });
    }
    const body = text ? JSON.parse(text) : {};
    switch (path) {
      case "rules": e.addRule(body); break;
      case "rules/delete": e.deleteRule(body.id); break;
      case "sport": e.setSport(body.domain ?? ""); break;
      case "ocr": e.onOcr(body); break;
      case "reset": e.resetGame(); break;
      case "roster": if (!e.setRoster(body.domain || e.domain, body.names ?? "")) return json({}, 400); break;
      case "telemetry": { const k = String(body.k ?? "app"); delete body.k; e.tele(k, body); break; }
      case "reel": break;   // the shareable reel file is cut on the laptop (ffmpeg); on the TV the in-app replay is the reel
      case "test": e.fire({ id: `test${e.now()}`, type: "test", cooldown_s: 0 }, "TV Watch test", "Notifications are working."); break;
      default: return json({}, 404);
    }
    return json({});
  }
  return {
    engine,
    fetch: (url, init) => {
      const u = new URL(url, typeof location !== "undefined" ? location.href : "http://tv.local/");
      const m = u.pathname.match(/\/api\/(.+)$/);
      if (!m) return Promise.resolve(json({}, 404));
      return handle(m[1], u.searchParams, (init?.method ?? "GET").toUpperCase(), init).catch(err => json({ error: String(err) }, 500));
    },
    EventSource: url => new LocalEventSource(engine, url),
  };
}

/** YouTube search without the laptop: the official Data API straight from the TV, with a key the viewer saved */
async function ytSearch(q: string, live: boolean, key: string | null) {
  if (!key) return { q, results: [], error: "no YouTube API key on this TV" };
  const p = new URLSearchParams({ part: "snippet", type: "video", maxResults: "16", q, key, videoEmbeddable: "true", safeSearch: "moderate", relevanceLanguage: "en" });
  if (live) p.set("eventType", "live");
  const r = await fetch(`https://www.googleapis.com/youtube/v3/search?${p}`).then(x => x.json()).catch(() => ({ items: [] }));
  const SPORT = [["nba", /\bnba\b|basketball|lakers|warriors|celtics|knicks|spurs|nuggets|bucks|thunder/], ["nfl", /\bnfl\b|football|chiefs|eagles|cowboys|bills|ravens|49ers|touchdown/],
    ["nhl", /\bnhl\b|hockey|oilers|bruins|panthers|rangers|maple leafs/], ["cricket", /cricket|\bipl\b|\bt20\b|\bodi\b|test match|ashes|wicket/],
    ["soccer", /premier league|la liga|serie a|bundesliga|champions league|\bfc\b|soccer|football club|arsenal|liverpool|madrid|barcelona|chelsea|man utd|manchester/]] as const;
  const unescape = (s: string) => new DOMParser().parseFromString(s, "text/html").documentElement.textContent ?? s;
  return { q, results: (r.items ?? []).filter((it: any) => it.id?.videoId).map((it: any) => {
    const title = unescape(it.snippet?.title ?? ""), t = (title + " " + q).toLowerCase();
    return { id: it.id.videoId, title, channel: it.snippet?.channelTitle ?? "", thumb: (it.snippet?.thumbnails?.high ?? it.snippet?.thumbnails?.medium)?.url,
      live: it.snippet?.liveBroadcastContent === "live", sport: SPORT.find(([, re]) => re.test(t))?.[0] ?? null };
  }) };
}

/** Route the page's own fetch("api/...") and new EventSource("api/events") to a local backend; everything else
 *  (the clips, posters, YouTube, Little) still goes to the network. Returns a function that undoes it. */
export function installLocalBackend(be: LocalBackend) {
  const realFetch = window.fetch.bind(window), RealES = window.EventSource;
  const isApi = (u: string) => /(^|\/)api\//.test(new URL(u, location.href).pathname);
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return isApi(url) ? be.fetch(url, init) : realFetch(input, init);
  }) as typeof fetch;
  window.EventSource = function (url: string | URL) {
    return isApi(String(url)) ? be.EventSource(String(url)) : new RealES(url);
  } as unknown as typeof EventSource;
  return () => { window.fetch = realFetch; window.EventSource = RealES; };
}

/** localStorage, wrapped so a private window or blocked storage only loses persistence, never the app */
export const browserStore: Store = {
  get: k => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* not persisted */ } },
};

/** The engine with TV Watch's default rules, watchlist and rosters, persisted in this TV's storage. Arc, the tagger
 *  and the director are optional: pass what is available (arclocal.ts, tagger.ts, director3.ts). */
export async function createDefaultEngine(parts: { arc?: ArcSink; tagger?: TaggerLike; director?: DirectorLike; domain?: string } = {}) {
  const rules = JSON.parse((await import("./defaults/rules.json?raw")).default);
  const names = (await import("./defaults/names.txt?raw")).default;
  const files = import.meta.glob("./defaults/rosters/*.txt", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
  const rosters = Object.fromEntries(Object.entries(files).map(([p, t]) => [p.split("/").pop()!.replace(".txt", ""), t]));
  const engine = new Engine({ store: browserStore, rules, names, rosters, ...parts });
  engine.state.status = parts.arc ? "Arc on this TV" : "no Arc yet";
  return engine;
}

/** the director (director/v2: the Mamba-3 over Arc's streams) as the engine wants it: features in, a call per second */
export async function loadDirector(url = "director/director3.json"): Promise<DirectorLike> {
  const { Director3, Features3 } = await import("../director3.ts");
  const model = await Director3.load(url);
  return { model, features: new Features3(model.m) };
}
