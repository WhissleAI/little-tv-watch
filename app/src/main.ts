import "./standalone";   // first: on a TV it puts Arc, the tagger, the director and TV Watch's logic in this page
import { connect } from "@kabletv/little-sdk";
import "./style.css";
import { watchBoard, newGame, activeLayout } from "./board";
import { setupAsk, answer } from "./ask";
import * as yt from "./youtube";
import { startYouTubeBoard } from "./boardyt";

// TV Watch on Little. Arc runs next to the TV (tvwatch.py, reached through /api): this page
// sends it audio (the TV's mic, or the demo clip it is playing) and shows what Arc hears: captions,
// the score bug and alerts. The TV's agent drives it with the tools in public/little/manifest.json.

type Tag = { tag: string; wb?: number; we?: number; watch?: boolean };
type Line = { text?: string; tags?: Tag[] };
type Alert = { aid?: string; title: string; body: string; priority?: number };
type State = { domain?: string; score?: number[] | null; score_text?: string; clock?: number | null; clock_label?: string | null };

const $ = (id: string) => document.getElementById(id)!;
const root = $("root");
const video = $("video") as HTMLVideoElement;
const EMO: Record<string, string> = { nba: "🏀", nfl: "🏈", nhl: "🏒", soccer: "⚽", cricket: "🏏", esports: "🎮",
  news: "📰", talk: "🎙️", court_trial: "⚖️", stream_chat: "📡" };
const SHORT: Record<string, string> = { nba: "NBA", nfl: "NFL", nhl: "NHL", soccer: "SOCCER", cricket: "CRICKET",
  esports: "ESPORTS", news: "NEWS", talk: "TALK", court_trial: "COURT", stream_chat: "STREAM" };
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
// This screen's id: the simulator and a TV can share one TV Watch, and the screen that starts a game owns it (the
// other's audio and scoreboard are refused), so two screens never mix their games.
const CLIENT = (["127.0.0.1", "localhost"].includes(location.hostname) ? "sim-" : "tv-") + Math.random().toString(36).slice(2, 10);   // randomUUID needs a secure page; the TV loads us over http
const post = (path: string, body: unknown) =>   // never hangs the app: TV Watch busy or down is a 5 s miss, not a freeze
  fetch(path, { method: "POST", headers: { "Content-Type": "application/json", "X-Client": CLIENT }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000) })
    .catch(() => new Response("{}", { status: 503 }));

const app = connect();
{
  const register = app.tool.bind(app) as typeof app.tool;
  (app as { tool: typeof app.tool }).tool = ((name: string, handler: (args: never) => unknown) =>
    register(name, (async (args: never) => {
      duckFor(4000);   // the assistant is mid-turn: it will speak right after this
      const r = (await handler(args)) as { say?: string } | undefined;
      duckFor(speakMs(r?.say));
      return r;
    }) as never)) as typeof app.tool;
}
let sport = "nba";
let score = "";
let clock = "";

// ------------------------------------------------------------------ what Arc hears -> the screen
function hl(line: Line) {
  const w = String(line.text || "").split(" ").map(esc);
  for (const t of line.tags || []) {
    if (t.wb == null || t.we == null || t.we <= t.wb || t.we > w.length || t.tag === "NUMBER" || t.tag === "NUMBER_ORDINAL") continue;
    const k = t.tag.startsWith("NUMBER") ? "num" : ({ ENTITY_PERSON: "person", ENTITY_TEAM: "team", ENTITY_PLACE: "place",
      ENTITY_ORG: "org", ENTITY_PRODUCT: "product" } as Record<string, string>)[t.tag] || "other";
    w[t.wb] = `<span class="h ${k}${t.watch ? " watch" : ""}">${t.watch ? "★ " : ""}` + w[t.wb];
    w[t.we - 1] += "</span>";
  }
  return w.join(" ");
}

function showState(s: State) {
  if (s.domain) {
    if (s.domain !== sport) setTimeout(() => void refreshWatching(), 0);   // the watchlist is per sport
    sport = s.domain;
    $("sport").textContent = (EMO[sport] || "📺") + " " + (SHORT[sport] || sport.toUpperCase());
  }
  if ("score" in s) score = s.score_text || (s.score ? `${s.score[0]} – ${s.score[1]}` : "");
  if ("clock" in s || "clock_label" in s)
    clock = s.clock_label || (s.clock != null ? `${Math.floor(s.clock / 60)}:${String(s.clock % 60).padStart(2, "0")}` : "");
  $("score").textContent = score || "– : –";
  $("clock").textContent = clock || "–";
  $("bug").setAttribute("data-little-data", JSON.stringify({ sport, score: score || null, clock: clock || null }));
}

const QUIET = /^(Heard: |.{0,3}Big moment|Close game)/;
function toast(a: Alert) {
  const d = document.createElement("div");
  d.className = "toast p" + (a.priority || 4);
  d.dataset.aid = a.aid || "";
  d.setAttribute("data-little", "readout");
  d.setAttribute("data-little-label", a.title);
  const body = a.body && a.body !== "from the scoreboard" ? `<span>${esc(a.body)}</span>` : "";
  d.innerHTML = `<b>${esc(a.title)}</b>${body}`;
  $("toasts").prepend(d);
  while ($("toasts").children.length > 3) $("toasts").lastChild!.remove();
  setTimeout(() => d.classList.add("out"), 9000);
  setTimeout(() => d.remove(), 9700);
}

// Big moments are said out loud, one at a time, with the game turned down underneath.
let speaking = Promise.resolve();
let lastSaid = 0;
function callOut(a: Alert) {
  if ((a.priority || 4) < 5 || !app.can("voice.say") || Date.now() - lastSaid < 8000) return;
  lastSaid = Date.now();
  speaking = speaking.then(async () => { await holdDuck(app.voice.say(a.title.replace(/–/g, " to "))); });
}

// Only the crowd's own reactions make the badge, at most every 20 s: Arc's buzzer, whistle and horn heads hit
// p = 1.0 many times a minute on real broadcasts (calibration, Nov 7), so they stay in tvwatch's labels.log only.
const SOUND: Record<string, string> = { "scene.cheer": "📣 CROWD ROARS", "scene.applause": "👏 APPLAUSE", "scene.boo_jeer": "👎 BOOS" };
let lastCrowd = 0;
let crowdTimer = 0;

// Another screen started its own game on TV Watch: say so and step aside (never fight back with a reset).
function tookOver(st: { owner?: string }) {
  const busy = root.classList.contains("playing") || root.classList.contains("listening");
  if (!st.owner || st.owner === CLIENT || !busy) return false;
  stopAll();
  toast({ title: "Another screen took over this game", body: "Press Play to watch here again.", priority: 4 });
  focusHome();
  return true;
}

// What the live stream carries, as functions: the stream calls them, and so does the poller below when the stream
// can't get through (a tunnel that buffers server-sent events, as Cloudflare's quick tunnel does to the TV).
let lastStream = 0, lastAid = 0, lastFinal = "", lastPartial = "";
function onPartial(l: Line) {
  $("now").innerHTML = hl(l) + '<span class="cursor"></span>';
}
function onFinal(l: Line) {
  lastFinal = l.text || "";
  $("prev").innerHTML = hl(l);
  $("prev").setAttribute("data-little-data", JSON.stringify({ text: l.text || "" }));
  $("now").innerHTML = '<span class="cursor"></span>';
}
function seenAlert(a: Alert) {
  if (a.aid != null && Number(a.aid) <= lastAid) return;   // the stream and the poller may both bring it
  if (a.aid != null) lastAid = Number(a.aid);
  if (!reeling) mark(a);
  // the generic ones ("Heard: time out", "🏀 Big moment", "Close game") stay off the screen: noise on a TV.
  // They still go to the agent and the catch-up.
  if (!QUIET.test(a.title)) {
    toast(a);
    callOut(a);
  }
  app.emit("alert", { title: a.title, detail: a.body, score: score || null, clock: clock || null, spoken: (a.priority || 4) >= 5 });
}
// No stream for 3 s while a game is on: read the state once a second and draw the same things from it.
setInterval(async () => {
  if (Date.now() - lastStream < 3000 || !(root.classList.contains("playing") || root.classList.contains("listening"))) return;
  const st = await fetch("api/state").then(r => r.json()).catch(() => null);
  if (!st || Date.now() - lastStream < 3000) return;
  if (tookOver(st)) return;
  if (st.session != null && session >= 0 && st.session !== session) newSession(st.session);
  showState(st);
  const newest: Line | undefined = (st.lines || [])[0];   // newest first
  if (newest?.text && newest.text !== lastFinal) onFinal(newest);
  if (st.partial && st.partial !== lastPartial) { lastPartial = st.partial; onPartial({ text: st.partial, tags: [] }); }
  for (const a of [...(st.alerts || [])].reverse()) if (Number(a.aid) > lastAid) seenAlert(a);   // oldest first
}, 1000);

function listen() {
  const es = new EventSource("api/events");
  es.addEventListener("hello", e => {
    lastStream = Date.now();
    const h = JSON.parse((e as MessageEvent).data);
    lastAid = Math.max(lastAid, ...((h.alerts || []) as Alert[]).map(a => Number(a.aid) || 0));
    if (tookOver(h)) return;
    if (h.session != null && h.session !== session) newSession(h.session);
    if (current && root.classList.contains("playing") && h.domain !== current.sport) {   // TV Watch restarted mid-game
      void post("api/sport", { domain: current.sport });
      if (current.roster) void post("api/roster", { domain: current.sport, names: current.roster });
    }
    showState(h);
    const lines: Line[] = h.lines || [];
    if (lines.length) $("prev").innerHTML = hl(lines[lines.length - 1]);
    $("now").innerHTML = '<span class="cursor"></span>';
    $("live").classList.remove("off");
    void refreshWatching();
  });
  es.addEventListener("state", e => {
    lastStream = Date.now();
    const st = JSON.parse((e as MessageEvent).data);
    if (tookOver(st)) return;
    if (st.session != null && session >= 0 && st.session !== session) newSession(st.session);
    showState(st);
  });
  es.addEventListener("partial", e => { lastStream = Date.now(); onPartial(JSON.parse((e as MessageEvent).data)); });
  es.addEventListener("final", e => {
    lastStream = Date.now();
    onFinal(JSON.parse((e as MessageEvent).data));
  });
  es.addEventListener("alert", e => { lastStream = Date.now(); seenAlert(JSON.parse((e as MessageEvent).data)); });
  es.addEventListener("alert_update", e => {
    const a: Alert = JSON.parse((e as MessageEvent).data);
    const d = $("toasts").querySelector(`[data-aid="${a.aid}"] b`);
    if (d) d.textContent = a.title;
  });
  es.addEventListener("event", e => {
    const ev = JSON.parse((e as MessageEvent).data);
    const label = SOUND[ev.label];
    if (!label || ev.p < 0.95 || Date.now() - lastCrowd < 20000) return;
    lastCrowd = Date.now();
    $("crowd").textContent = label;
    $("crowd").classList.add("on");
    clearTimeout(crowdTimer);
    crowdTimer = window.setTimeout(() => $("crowd").classList.remove("on"), 4000);
  });
  es.onerror = () => $("live").classList.add("off");
  es.onopen = () => $("live").classList.remove("off");
}

// ------------------------------------------------------------------ the game turns down while anyone talks
// Little has no "assistant speaking" event, so three signals hold the duck: the viewer talking to the TV (the
// platform's own transcript, sense.speech), any tool call from the assistant (it is mid-turn and about to answer),
// and our own spoken lines. The game comes back up a few seconds after the last of them. Arc hears the clip before
// this gain, so captions and the scoreboard never dip.
let duckGain: GainNode | null = null;
let duckUntil = 0, duckHeld = 0, duckTimer = 0;
function gameGain(ac: AudioContext) {
  duckGain ??= ac.createGain();
  return duckGain;
}
function setDuck() {
  if (!duckGain || !ctx) { yt.volume(duckHeld > 0 || Date.now() < duckUntil ? 0.18 : 1); return; }
  const down = duckHeld > 0 || Date.now() < duckUntil;
  duckGain.gain.cancelScheduledValues(ctx.currentTime);
  duckGain.gain.setTargetAtTime(down ? 0.18 : 1, ctx.currentTime, down ? 0.08 : 0.4);
  yt.volume(down ? 0.18 : 1);
  clearTimeout(duckTimer);
  if (!duckHeld && down) duckTimer = window.setTimeout(setDuck, duckUntil - Date.now() + 50);
}
function duckFor(ms: number) {
  duckUntil = Math.max(duckUntil, Date.now() + ms);
  setDuck();
}
async function holdDuck<T>(p: Promise<T>) {
  duckHeld++;
  setDuck();
  try { return await p; } finally { duckHeld--; duckFor(600); }
}
const speakMs = (text?: string) => 1500 + (text ? text.split(/\s+/).length * 420 : 2500);   // a reply's rough length

// ------------------------------------------------------------------ audio -> Arc (16 kHz mono s16le)
let ctx: AudioContext | null = null;
let videoNode: MediaElementAudioSourceNode | null = null;
let input: AudioNode | null = null;
let proc: ScriptProcessorNode | null = null;
let mic: { stop(): void } | null = null;

function audioContext() {
  ctx ??= new AudioContext();
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

// Downsample whatever the page hears to 16 kHz and post it to Arc every 250 ms.
function capture(node: AudioNode, label: string) {
  const ac = audioContext();
  const ratio = ac.sampleRate / 16000;
  const out = new Int16Array(4000);
  let n = 0;
  let pos = 0;
  proc = ac.createScriptProcessor(4096, 1, 1);
  proc.onaudioprocess = ev => {
    const x = ev.inputBuffer.getChannelData(0);
    for (; pos < x.length; pos += ratio) {
      const i = Math.floor(pos), f = pos - i;
      const v = x[i] * (1 - f) + (x[i + 1] ?? x[i]) * f;
      out[n++] = Math.max(-32768, Math.min(32767, v * 32767));
      if (n === out.length) {
        void fetch("api/pcm", { method: "POST", headers: { "X-Source": encodeURIComponent(label), "X-Client": CLIENT }, body: out.slice().buffer })
          .catch(e => console.log(`[tvwatch] pcm post failed: ${e}`));
        n = 0;
      }
    }
    pos -= x.length;
  };
  const sink = ac.createGain();
  sink.gain.value = 0;   // a script processor only runs when it reaches the destination; keep it silent
  node.connect(proc);
  proc.connect(sink).connect(ac.destination);
  input = node;
  $("src").textContent = label;
  $("src").setAttribute("data-little-data", JSON.stringify({ source: label }));
}

function release() {
  if (input && proc) input.disconnect(proc);
  proc?.disconnect();
  proc = null;
  input = null;
  mic?.stop();
  mic = null;
  $("src").textContent = "Not listening";
}

async function listenToTv() {
  stopAll();
  void post("api/reset", {});
  newSession();
  let stream: MediaStream;
  let stop: () => void;
  if (app.can("media.mic")) {
    const r = await app.media.mic({ echoCancellation: false, noiseSuppression: false, autoGainControl: false });
    if (!r.ok) return { detail: `microphone unavailable: ${r.error?.code ?? "declined"}`, say: "I can't use the microphone right now." };
    stream = r.stream;
    stop = () => r.stop();
  } else {   // a plain browser (no Little host)
    const s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false } });
    stream = s;
    stop = () => s.getTracks().forEach(t => t.stop());
  }
  capture(audioContext().createMediaStreamSource(stream), "🎙 Listening to the TV");
  mic = { stop };
  root.classList.add("listening");
  placeCaptions();
  back.focus({ preventScroll: true });
  return { detail: "listening to the TV through the microphone", say: "I'm listening to the game." };
}

// Captions sit above a scoreboard that broadcasts put at the bottom, and low when it is at the top.
function placeCaptions() {
  const boxes = Object.values(activeLayout(sport) ?? {});
  const top = boxes.length && !root.classList.contains("listening") ? Math.min(...boxes.map(b => b[1])) : 1;
  // a bottom scoreboard: the captions sit well above its fields (bugs reach above the boxes we read, e.g. MSG's);
  // otherwise above the always-on player panel at the bottom
  ($("now").parentElement as HTMLElement).style.bottom = `${top > 0.55 ? Math.round((1 - top) * 1080) + 80 : 190}px`;
  root.classList.toggle("bug-bottom", top > 0.55);   // the player controls move to the top-left, clear of it
}

// Player controls: shown on any key, play or pause, then faded after a few quiet seconds (kept while one is focused).
let uiTimer = 0;
function wake() {
  root.classList.add("ui");
  clearTimeout(uiTimer);
  uiTimer = window.setTimeout(() => {
    const f = document.activeElement as HTMLElement | null;
    if (f && f.closest(".hl-list.on, .chips.on")) return wake();
    root.classList.remove("ui");
  }, 6000);
}
document.addEventListener("keydown", wake, true);
document.addEventListener("mousemove", wake);

// ------------------------------------------------------------------ the demo catalog (catalog/catalog.json)
// Every clip brings its sport, where it gets good (start), its broadcaster's scoreboard boxes and the players' names
// for Arc. Built by ocr/build_catalog.py from the clip gatherers' entries.
type Clip = { id: string; sport: string; title: string; subtitle?: string; file: string; poster?: string | null; start?: number;
  duration?: number; broadcaster?: string; teams?: string[]; featured?: boolean; codec?: string; src?: string; posterUrl?: string;
  layout?: Record<string, [number, number, number, number]>; roster?: string };
let clips: Clip[] = [];
// The demos built into the app (public/demos: short, light, cached on the TV) play from there; the rest from the catalog.
const clipSrc = (c: Clip) => c.src ?? `catalog/${c.file}`;
const clipPoster = (c: Clip) => c.posterUrl ?? (c.poster ? `catalog/${c.poster}` : null);
const SPORT_ROW: Record<string, string> = { nba: "🏀 Basketball", soccer: "⚽ Soccer", nfl: "🏈 Football", nhl: "🏒 Hockey", cricket: "🏏 Cricket" };
let heroClip: Clip | null = null, heroFlip = false;

// The hero shows the focused game, crossfading between two layers like a TV home screen.
function showHero(c: Clip) {
  if (heroClip?.id === c.id) return;
  heroClip = c;
  const [on, off] = heroFlip ? [$("hero-a"), $("hero-b")] : [$("hero-b"), $("hero-a")];
  heroFlip = !heroFlip;
  const poster = clipPoster(c);
  if (poster) (on as HTMLImageElement).src = poster;
  on.classList.add("on");
  off.classList.remove("on");
  $("hero-sport").textContent = SHORT[c.sport] ?? c.sport.toUpperCase();
  $("hero-bc").textContent = [c.broadcaster, c.duration ? `${Math.round(c.duration / 60)} min` : ""].filter(Boolean).join("  ·  ");
  $("hero-title").textContent = c.title;
  $("hero-sub").textContent = c.subtitle ?? "";
  $("b-play").setAttribute("data-little-label", `Play ${c.title}`);
  $("b-play").setAttribute("data-little-id", c.id);
}

async function loadCatalog() {
  const [demos, catalog] = await Promise.all([
    fetch("demos/demos.json").then(r => r.json()).catch(() => ({ clips: [] })),
    fetch("catalog/catalog.json").then(r => r.json()).catch(() => ({ clips: [] }))]);
  const built: Clip[] = demos.clips ?? [];
  clips = [...built, ...(catalog.clips as Clip[]).map(c => (built.length ? { ...c, featured: false } : c))];   // the built-in demos are today's demo
  if (CLIENT.startsWith("tv-")) clips = clips.filter(c => !c.codec || c.codec === "h264");   // a TV decodes H.264 only
  const rows = [...(clips.some(c => c.featured) ? ["featured"] : []), ...new Set(clips.map(c => c.sport))];
  const inRow = (r: string) => clips.filter(c => (r === "featured" ? c.featured : c.sport === r));
  $("catalog").innerHTML = rows.map(sp => `<div class="row"${sp === "featured" ? ' id="featured-row"' : ""}><h3>${sp === "featured" ? "⭐ Today's demo" : SPORT_ROW[sp] ?? sp}</h3><div class="strip">${inRow(sp).map(c =>
    `<button class="card" data-clip="${esc(c.id)}" data-little="item" data-little-id="${sp === "featured" ? "today-" : ""}${esc(c.id)}" data-little-action="play_demo" data-little-label="${esc(c.title)}"
      data-little-data='${esc(JSON.stringify({ sport: c.sport, subtitle: c.subtitle ?? "" }))}'>
      ${clipPoster(c) ? `<img src="${esc(clipPoster(c))}" alt="" loading="lazy">` : ""}<div class="cap"><div class="t">${esc(c.title)}</div><div class="s">${esc(c.subtitle ?? "")}</div></div></button>`).join("")}</div></div>`).join("");
  $("catalog").querySelectorAll<HTMLButtonElement>(".card").forEach(b => {
    b.addEventListener("click", () => void playDemo(b.dataset.clip));
    b.addEventListener("focus", () => { showHero(clips.find(c => c.id === b.dataset.clip)!); keepInView(b); });
    b.addEventListener("mouseenter", () => showHero(clips.find(c => c.id === b.dataset.clip)!));
  });
  const first = clips.find(c => c.featured) ?? clips[0];
  if (first) showHero(first);
  renderYouTube();
  const featured = document.getElementById("featured-row");
  if (featured) $("catalog").prepend(featured);   // today's demo first, then YouTube, then the sports
}
void loadCatalog();

// The focused row slides up to the top of the rows area, and the focused card slides left to stay in view with the
// next one peeking at the right edge; nothing is ever cut off at the bottom.
const CARD_W = 362;
function keepInView(b: HTMLElement) {
  const strip = b.parentElement!, row = strip.parentElement!;
  const i = [...strip.children].indexOf(b);
  $("catalog").style.transform = `translateY(${-((row as HTMLElement).offsetTop - (row.parentElement!.firstElementChild as HTMLElement).offsetTop)}px)`;
  $("catalog").parentElement!.scrollTop = 0;   // focus() must never scroll these: the transforms place them
  strip.scrollLeft = 0;
  const visible = Math.floor((1920 - 220) / CARD_W);   // cards that fit; the next one peeks
  strip.style.transform = `translateX(${-Math.max(0, i - (visible - 2)) * CARD_W}px)`;
}

// ------------------------------------------------------------------ Watch on YouTube (a row on the start screen)
// Ready-made searches, then that search's games as cards; the TV's agent can search anything with watch_youtube.
const YT_SEARCHES = [["🏀", "NBA full game highlights"], ["⚽", "Premier League extended highlights"], ["🏈", "NFL game highlights"],
  ["🏒", "NHL game highlights"], ["🏏", "cricket highlights"], ["🔴", "live basketball"]];
let ytResults: yt.YTResult[] = [];
// One card in the YouTube row that says what is happening (searching, nothing found), so a slow search never looks
// like nothing happened. `back` makes it a button back to the quick searches.
function ytStatus(text: string, icon: string, back = false) {
  const row = document.getElementById("yt-row");
  const strip = row?.querySelector(".strip");
  if (!strip) return;
  strip.innerHTML = `<button class="card q" ${back ? 'data-ytback="1"' : "disabled"} data-little="readout" data-little-label="${esc(text)}">
    <span class="big">${icon}</span><div class="cap"><div class="t">${esc(text)}</div><div class="s">${back ? "Back to searches" : "One moment"}</div></div></button>`;
  const b = strip.querySelector<HTMLButtonElement>("button")!;
  if (back) b.addEventListener("click", () => renderYouTube());
  b.focus({ preventScroll: true });
}

function renderYouTube(results?: yt.YTResult[], q?: string) {
  if (results) ytResults = results;
  const cards = results
    ? results.map((r, i) => `<button class="card" data-yt="${i}" data-little="item" data-little-id="yt-${esc(r.id)}" data-little-action="watch_youtube" data-little-label="${esc(r.title)}"
        data-little-data='${esc(JSON.stringify({ channel: r.channel, live: r.live, sport: r.sport ?? "" }))}'>
        ${r.thumb ? `<img src="${esc(r.thumb)}" alt="" loading="lazy">` : ""}${r.live ? '<span class="live-tag">LIVE</span>' : ""}
        <div class="cap"><div class="t">${esc(r.title)}</div><div class="s">${esc(r.channel)}</div></div></button>`).join("")
    : YT_SEARCHES.map(([e, t]) => `<button class="card q" data-ytq="${esc(t)}" data-little="control" data-little-action="watch_youtube" data-little-label="Search YouTube: ${esc(t)}">
        <span class="big">${e}</span><div class="cap"><div class="t">${esc(t)}</div><div class="s">Search YouTube</div></div></button>`).join("");
  const back = results ? `<button class="card q" data-ytback="1" data-little="control" data-little-label="More searches"><span class="big">🔎</span><div class="cap"><div class="t">More searches</div><div class="s">“${esc(q ?? "")}”</div></div></button>` : "";
  let row = document.getElementById("yt-row");
  if (!row) {
    row = document.createElement("div");
    row.className = "row";
    row.id = "yt-row";
    $("catalog").prepend(row);
  }
  row.innerHTML = `<h3>▶ Watch on YouTube</h3><div class="strip">${back}${cards}</div>`;
  row.querySelectorAll<HTMLButtonElement>(".card").forEach(b => {
    b.addEventListener("click", () => {
      if (b.dataset.ytq) void ytSearch(b.dataset.ytq, b.dataset.ytq.startsWith("live"));
      else if (b.dataset.ytback) renderYouTube();
      else void playYouTube(ytResults[Number(b.dataset.yt)]);
    });
    b.addEventListener("focus", () => keepInView(b));
  });
}
async function ytSearch(q: string, live = false) {
  ytStatus(`Searching YouTube for “${q}”…`, "⏳");
  const r = await yt.search(q, live).catch(() => [] as yt.YTResult[]);
  if (!r.length) { ytStatus(`No results for “${q}” — try another search`, "🔎", true); return r; }
  renderYouTube(r, q);
  (document.querySelector("#yt-row .card") as HTMLButtonElement | null)?.focus({ preventScroll: true });
  return r;
}

let ytNow: yt.YTResult | null = null, stopYTBoard = () => {};
function playYouTube(r?: yt.YTResult, tries = 0) {
  if (!r) return { detail: "nothing to play" };
  stopAll();
  const s = r.sport || sport, token = ++playToken;
  ytNow = r;
  root.classList.add("playing", "yt-on");
  placeCaptions();
  wake();
  back.focus({ preventScroll: true });
  // The answer goes back at once; the player, TV Watch's fresh session, the scoreboard and the microphone (a human
  // may still have to press Allow) all start behind it.
  void (async () => {
    const err = await yt.play(r.id, () => { stopAll(); app.emit("clip_ended", { sport: s }); });
    if (err) {   // embedding off, or gone: say so, and try the next result (three at most)
      const next = ytResults[ytResults.indexOf(r) + 1];
      app.emit("youtube_failed", { title: r.title, reason: err });
      void post("api/yt/bad", { id: r.id, code: err });   // TV Watch keeps them out of later searches
      if (next && tries < 2 && token === playToken) {
        toast({ title: "That video can't play inside TV Watch", body: `Trying the next one: ${next.title}`, priority: 4 });
        void playYouTube(next, tries + 1);
      } else {
        stopAll();
        toast({ title: "That video can't play here", body: "Its owner doesn't allow it on TVs. Try another search.", priority: 4 });
      }
      return;
    }
    await post("api/sport", { domain: s });
    await post("api/roster", { domain: s, names: "" });   // a game we don't have a roster for: no stale names
    await post("api/reset", {});
    if (token !== playToken) return;
    newSession();
    newGame(null);
    stopYTBoard = startYouTubeBoard(() => sport, reading => {   // the screen-grabbed scoreboard, same path as a clip's
      if (reeling) return;
      void post("api/ocr", reading);
      $("board").classList.add("on");
      clearTimeout(boardTimer);
      boardTimer = window.setTimeout(() => $("board").classList.remove("on"), 30000);
    });
    // Arc hears it the way it would hear any TV: through the microphone (the player is another origin)
    let stream: MediaStream | null = null, stopMic = () => {};
    if (app.can("media.mic")) {
      const m = await app.media.mic({ echoCancellation: false, noiseSuppression: false, autoGainControl: false });
      if (m.ok) { stream = m.stream; stopMic = () => m.stop(); }
      else console.log(`[tvwatch] youtube mic: ${JSON.stringify(m.error ?? m)}`);
    } else {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false } }).catch(() => null);
      if (stream) { const st = stream; stopMic = () => st.getTracks().forEach(t => t.stop()); }
    }
    if (token !== playToken) { stopMic(); return; }
    if (stream) { capture(audioContext().createMediaStreamSource(stream), `▶ YouTube · ${r.title}`); mic = { stop: stopMic }; }
  })();
  return { detail: `starting "${r.title}" (${r.channel}) from YouTube; Arc hears it through the microphone once it's allowed, and the score comes from the broadcast's scoreboard on screen` };
}
app.tool<{ query?: string; live?: boolean; pick?: number }>("watch_youtube", async ({ query, live, pick }) => {
  const results = query ? await ytSearch(query, !!live) : ytResults;
  if (!results.length) return { detail: `no YouTube results for "${query ?? ""}"`, say: "I couldn't find that on YouTube." };
  const choice = results[Math.max(0, Math.min(results.length - 1, (pick ?? 1) - 1))];
  return playYouTube(choice);
});

// A clip by id, a few words of its title ("the Arsenal late winner"), or a sport (its first clip).
function findClip(want?: string) {
  const w = (want || "").toLowerCase().replace(/^today-/, "");   // a "Today's demo" card is the same clip
  return clips.find(c => c.id === w) ?? clips.find(c => w && (c.title + " " + (c.subtitle ?? "")).toLowerCase().includes(w))
    ?? clips.find(c => c.sport === w) ?? clips.find(c => w.split(/\s+/).some(x => x.length > 3 && c.title.toLowerCase().includes(x))) ?? clips[0];
}

let current: Clip | null = null;   // the clip on screen, so a restarted TV Watch can be told what it is hearing
let playToken = 0;
async function playDemo(want?: string) {
  const clip = findClip(want);
  if (!clip) return { detail: "no demo clips" };
  const s = clip.sport;
  stopAll();
  const token = ++playToken;
  // The picture starts at once; TV Watch gets ready (sport, tonight's names, a fresh session: Arc restarts, which
  // takes seconds) behind it, and Arc hears the game from the moment it is ready.
  current = clip;
  placeCaptions();
  wake();
  $("prev").innerHTML = "";
  $("now").innerHTML = '<span class="cursor"></span>';
  $("toasts").innerHTML = "";
  video.src = clipSrc(clip);
  if (clip.start) video.addEventListener("loadedmetadata", () => { video.currentTime = clip.start!; }, { once: true });
  const ac = audioContext();
  if (!videoNode) {
    videoNode = ac.createMediaElementSource(video);
    videoNode.connect(gameGain(ac)).connect(ac.destination);   // heard through the duck; Arc taps before it
  }
  root.classList.add("playing");
  back.focus({ preventScroll: true });
  $("src").textContent = "Getting Arc ready…";
  const played = video.play().then(() => "", (e: Error) => e.message);
  await post("api/sport", { domain: s });
  if (clip.roster) await post("api/roster", { domain: s, names: clip.roster });   // Arc learns tonight's names
  await post("api/reset", {});   // a new game: the old score, clock and lines would only confuse Arc's checks
  if (token !== playToken) return { detail: "stopped" };   // Back, or another game, while it got ready
  newSession();
  newGame(clip.layout, clip.teams);   // after the reset, so the board's first reading lands in this session
  capture(videoNode, `▶ ${clip.title}`);
  const failed = await played;
  console.log(`[tvwatch] demo ${s}: audio ${ac.state}${failed ? `, play failed: ${failed}` : ""}`);
  return { detail: `playing "${clip.title}" (${clip.subtitle ?? s}); Arc is captioning it live` };
}

function stopAll() {
  current = null;
  playToken++;
  ytNow = null;
  stopYTBoard();
  stopYTBoard = () => {};
  yt.stop();
  root.classList.remove("yt-on");
  reeling = false;
  root.classList.remove("reel");
  for (const id of ["ask-card", "recap", "chips"]) $(id).classList.remove("on");   // a fresh start shows nothing old
  $("hl-list").classList.remove("on");
  release();
  video.pause();
  if (video.getAttribute("src")) {
    video.removeAttribute("src");
    video.load();
  }
  root.classList.remove("playing", "listening");
}
// stutter, logged: a cached demo should never wait on the network
for (const ev of ["waiting", "stalled"]) video.addEventListener(ev, () => console.log(`[tvwatch] video ${ev} at ${video.currentTime.toFixed(1)} s (${video.currentSrc.split("/").pop()})`));
video.addEventListener("ended", () => { stopAll(); app.emit("clip_ended", { sport }); });

// The broadcast's scoreboard, read off the clip: Arc's service takes it as the truth for score and clock.
let boardTimer = 0;
watchBoard(video, () => sport, r => {
  if (reeling) return;   // a replay shows old scoreboards: never post them
  void post("api/ocr", r);
  $("board").classList.add("on");
  clearTimeout(boardTimer);
  boardTimer = window.setTimeout(() => $("board").classList.remove("on"), 30000);
});

// ------------------------------------------------------------------ highlights: every big moment, cut from the clip
// A scoring change lands on the board a few seconds after the play, so a moment's clip starts 10 s before the alert.
type Mark = { t: number; title: string; clock: string };
let marks: Mark[] = [], reeling = false, reelSrc = "";

// A new game is a new session: nothing from the last one (moments, questions, cards, alerts) carries over. Only
// the watchlist does, by design. TV Watch numbers its sessions; a page that sees another number forgets too.
let session = -1;
function newSession(id?: number) {
  if (id != null) session = id;
  marks = [];
  reelSrc = "";
  $("reel-btn").classList.remove("has");
  $("reel-btn").textContent = "🎬 No highlights yet";
  for (const k of ["chips", "ask-card", "recap"]) $(k).classList.remove("on");
  $("hl-list").classList.remove("on");
  $("hl-items").innerHTML = "";
  $("toasts").innerHTML = "";
  $("prev").innerHTML = "";
  $("now").innerHTML = "";
}
const BIG = /^(Basket|Three|Free throw|.*Goal|.*Touchdown|Field goal|.*Wicket|.*FOUR|.*SIX|Lead change|.*is on TV)/;
function mark(a: Alert) {
  if (!root.classList.contains("playing") || (a.priority || 4) < 5 || !BIG.test(a.title)) return;
  reelSrc = ytNow ? `yt:${ytNow.id}` : video.getAttribute("src") || "";
  const t = ytNow ? yt.time() : video.currentTime;
  if (marks.length && t - marks[marks.length - 1].t < 6) marks[marks.length - 1].title = a.title;   // one play, one clip
  else marks.push({ t, title: a.title, clock: clock || "" });
  $("reel-btn").classList.add("has");
  $("reel-btn").textContent = `🎬 Highlights (${marks.length})`;
  suggest(a);
}

async function highlights(only?: Mark[]) {
  closeList();
  if (!marks.length || reeling) return { detail: "no highlights yet" };
  reeling = true;
  root.classList.add("reel");
  release();   // Arc already heard these: a replay must not count twice
  $("src").textContent = "🎬 Replay";
  const onYT = !!ytNow, resumeAt = onYT ? yt.time() : video.currentTime, segs = only ?? marks.slice(-8);
  if (onYT) return ytReel(segs, resumeAt);
  if (!only) void post("api/reel", { src: reelSrc, segments: segs.map(m => [Math.max(0, m.t - 10), m.t + 2, m.title, m.clock]) });   // a file to share
  for (const [i, m] of segs.entries()) {
    if (!reeling) break;
    $("replay-title").textContent = m.title;
    $("replay-n").textContent = `${i + 1} / ${segs.length}`;
    video.currentTime = Math.max(0, m.t - 10);
    await video.play().catch(() => {});
    await new Promise<void>(res => { const tick = () => (!reeling || video.currentTime >= m.t + 2 ? res() : requestAnimationFrame(tick)); tick(); });
  }
  root.classList.remove("reel");
  reeling = false;
  if (video.getAttribute("src")) {   // back to the live game where we left it (unless Back stopped the game)
    video.currentTime = resumeAt;
    if (videoNode) capture(videoNode, `▶ ${findClip(reelSrc.split("/").pop()?.replace(".mp4", ""))?.title ?? SHORT[sport]}`);
  }
  return { detail: `played ${segs.length} highlights`, say: undefined };
}
// On YouTube the reel seeks its player: the same moments, no file (nothing is downloaded).
async function ytReel(segs: Mark[], resumeAt: number) {
  const r = ytNow;
  for (const [i, m] of segs.entries()) {
    if (!reeling) break;
    $("replay-title").textContent = m.title;
    $("replay-n").textContent = `${i + 1} / ${segs.length}`;
    yt.seek(m.t - 10);
    yt.resume();
    await new Promise<void>(res => { const tick = () => (!reeling || yt.time() >= m.t + 2 ? res() : setTimeout(tick, 200)); tick(); });
  }
  root.classList.remove("reel");
  reeling = false;
  if (ytNow && ytNow === r) {
    yt.seek(resumeAt);
    void playYouTubeMicOnly(r!);
  }
  return { detail: `played ${segs.length} highlights` };
}
async function playYouTubeMicOnly(r: yt.YTResult) {   // after a reel: Arc listens again, the game carries on
  if (!app.can("media.mic")) return;
  const m = await app.media.mic({ echoCancellation: false, noiseSuppression: false, autoGainControl: false });
  if (m.ok) { capture(audioContext().createMediaStreamSource(m.stream), `▶ YouTube · ${r.title}`); mic = { stop: () => m.stop() }; }
}

// ------------------------------------------------------------------ transport: seek and pause (clips and YouTube)
const fmt = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
const mediaTime = () => (ytNow ? yt.time() : video.currentTime || 0);
const mediaDuration = () => (ytNow ? yt.duration() : video.duration || 0);
function seekTo(t: number) {
  const before = mediaTime(), to = Math.max(0, Math.min(mediaDuration() - 1, t));
  if (ytNow) yt.seek(to); else video.currentTime = to;
  if (to < before - 20) newGame(current?.layout ?? null, current?.teams);   // back in time: the board starts over (no events)
  drawTransport();
  wake();
}
function togglePause() {
  if (ytNow) { if (yt.paused()) yt.resume(); else yt.pause(); }
  else if (video.paused) void video.play(); else video.pause();
  drawTransport();
  wake();
}
function drawTransport() {
  const t = mediaTime(), d = mediaDuration(), f = d ? (t / d) * 100 : 0;
  $("t-fill").style.width = `${f}%`;
  $("t-knob").style.left = `${f}%`;
  $("t-time").textContent = `${fmt(t)} / ${d ? fmt(d) : "–"}`;
  $("t-play").textContent = (ytNow ? yt.paused() : video.paused) ? "▶" : "⏸";
}
setInterval(() => { if (root.classList.contains("playing")) drawTransport(); }, 500);
$("t-back10").addEventListener("click", () => seekTo(mediaTime() - 10));
$("t-fwd10").addEventListener("click", () => seekTo(mediaTime() + 10));
$("t-fwd60").addEventListener("click", () => seekTo(mediaTime() + 60));
$("t-play").addEventListener("click", togglePause);
$("t-bar").addEventListener("click", e => {
  const r = $("t-bar").getBoundingClientRect();
  seekTo(((e as MouseEvent).clientX - r.left) / r.width * mediaDuration());
});
app.tool<{ seconds?: number; to?: number; pause?: boolean; play?: boolean }>("seek", ({ seconds, to, pause, play }) => {
  if (pause && !(ytNow ? yt.paused() : video.paused)) togglePause();
  else if (play && (ytNow ? yt.paused() : video.paused)) togglePause();
  if (to != null) seekTo(to); else if (seconds) seekTo(mediaTime() + seconds);
  return { detail: `at ${fmt(mediaTime())} of ${fmt(mediaDuration())}${(ytNow ? yt.paused() : video.paused) ? " (paused)" : ""}` };
});

// The list: every moment with its game clock; press one to see it again, or play them all.
function openList() {
  if (!marks.length) {   // pressed before the first moment: say what will land here
    $("hl-items").innerHTML = `<div class="empty" data-little="readout" data-little-label="No highlights yet">No big moments yet. Scores, goals, wickets and big calls land here as they happen.</div>`;
    $("hl-list").classList.add("on");
    return;
  }
  $("hl-items").innerHTML = `<button class="all" data-i="all" data-little="control" data-little-action="highlights" data-little-label="Play all highlights">▶ Play all (${marks.length})</button>`
    + marks.map((m, i) => `<button data-i="${i}" data-little="item" data-little-id="hl${i}" data-little-label="${esc(m.title)}"><span class="t">${esc(m.clock)}</span>${esc(m.title)}</button>`).join("");
  $("hl-items").querySelectorAll<HTMLButtonElement>("button").forEach(b => b.addEventListener("click", () =>
    void highlights(b.dataset.i === "all" ? undefined : [marks[Number(b.dataset.i)]])));
  $("hl-list").classList.add("on");
  ($("hl-items").firstElementChild as HTMLButtonElement)?.focus({ preventScroll: true });
}
function closeList() { $("hl-list").classList.remove("on"); }
$("reel-btn").addEventListener("click", () => ($("hl-list").classList.contains("on") ? closeList() : openList()));
app.tool("highlights", () => {   // answer the assistant now; the reel plays on its own
  if (!marks.length) return { detail: "no big moments yet in this game", say: "Nothing to replay yet." };
  void highlights();
  return { detail: `replaying ${Math.min(8, marks.length)} moments: ${marks.slice(-8).map(m => m.title).join("; ")}` };
});

// After a big moment, the questions people actually ask next, one press away.
let chipTimer = 0;
function suggest(a: Alert) {
  const who = a.title.match(/^(?:Basket|Three!|Free throw|.*Goal!|.*Touchdown!|Field goal) ([A-Z][\w'-]+(?: [A-Z][\w'-]+)?) ·/)?.[1];
  const qs = [who ? `How many does ${who} have?` : "Who scored?", / on a \d+–\d+ run/.test(a.title) ? "How did the run start?" : "What's the biggest lead?",
    /tied|Lead change/.test(a.title) ? "How many times has it been tied?" : "Who's been hot?"];
  $("chips").innerHTML = qs.map(q => `<button data-little="control" data-little-action="ask_game" data-little-label="${esc(q)}">${esc(q)}</button>`).join("");
  $("chips").querySelectorAll("button").forEach(b => b.addEventListener("click", () => void askText(b.textContent || "")));
  $("chips").classList.add("on");
  clearTimeout(chipTimer);
  chipTimer = window.setTimeout(() => $("chips").classList.remove("on"), 12000);
}
async function askText(q: string) {
  $("chips").classList.remove("on");
  showAsk(`“${q}”`, "", "thinking");
  const facts = await fetch("api/facts", { signal: AbortSignal.timeout(6000) }).then(r => r.json());
  const a = await answer(app, q, facts);
  showAsk(`“${q}”`, a || "I couldn't work that out from the game so far.", "done");
  if (a && app.can("voice.say")) await holdDuck(app.voice.say(a));
  return a;
}
let askHide = 0;
function showAsk(q: string, a: string, state: string) {
  $("ask-q").textContent = q;
  $("ask-a").textContent = a;
  $("ask-card").dataset.state = state;
  $("ask-card").classList.add("on");
  clearTimeout(askHide);
  if (state === "done") askHide = window.setTimeout(() => $("ask-card").classList.remove("on"), 15000);
}

// ------------------------------------------------------------------ watchlist (alert rules of type "name")
type Rule = { id: string; type: string; name?: string };
let watching: Rule[] = [];
async function refreshWatching() {
  const s = await fetch("api/state", { signal: AbortSignal.timeout(5000) }).then(r => r.json()).catch(() => null);
  if (!s) return;
  watching = (s.rules as (Rule & { id: string })[]).filter(r => r.type === "name" && r.name && (s.active as string[]).includes(r.id));
  $("watching").innerHTML = watching.map(r =>
    `<span class="w" data-little="item" data-little-id="${esc(r.id)}" data-little-label="${esc(r.name)}">${esc(r.name)}</span>`).join("");
  if (app.can("voice.config"))   // the TV's own recogniser should hear these names too
    void app.voice.config({ hints: [...new Set([...watching.map(r => r.name!), ...(s.names as string[])])].slice(0, 100),
      context: `Watching a ${s.sports?.[s.domain] ?? "sports"} broadcast with TV Watch.` });
}

// ------------------------------------------------------------------ tools
app.tool<{ name: string }>("watch_player", async ({ name }) => {
  const n = String(name || "").trim();
  if (!n) return { detail: "no name given" };
  await post("api/rules", { type: "name", name: n, cooldown_s: 120, sports: [sport] });   // this sport's game only
  await refreshWatching();
  return { detail: `watching ${n}: an alert fires on every mention`, say: `I'll tell you when ${n} comes up.` };
});
app.tool<{ name: string }>("unwatch_player", async ({ name }) => {
  const r = watching.find(w => w.name!.toLowerCase().includes(String(name || "").toLowerCase()));
  if (!r) return { detail: `not watching ${name}` };
  await post("api/rules/delete", { id: r.id });
  await refreshWatching();
  return { detail: `stopped watching ${r.name}`, say: `Okay, no more ${r.name} alerts.` };
});
app.tool<{ sport: string }>("switch_sport", async ({ sport: s }) => {
  await post("api/sport", { domain: s });
  return { detail: `Arc now follows ${s} rules` };
});
// "What did I miss?": the moments and the score from TV Watch, told by Little's own model (app.compose), shown for
// a few seconds over the game. Without the platform model (the inspector), the moments alone still make the card.
type Moment = { time: string; clock?: string | null; title: string; body?: string };
let recapTimer = 0;
async function catchUp() {
  const [c, st] = await Promise.all([fetch("api/catchup", { signal: AbortSignal.timeout(8000) }).then(r => r.json()), fetch("api/state", { signal: AbortSignal.timeout(5000) }).then(r => r.json())]);
  const moments: Moment[] = (c.moments || []).filter((m: Moment) => !/^(Heard|Close game)/.test(m.title)).slice(0, 5);
  const who: string[] = (c.top || []).slice(0, 5).map((t: { name: string }) => t.name);
  const said = (st.lines || []).slice(0, 12).reverse().map((l: Line) => l.text).join(" ");
  let headline = c.score_text ? `${SHORT[sport] ?? ""} ${c.score_text}`.trim() : "Nothing big yet", recap = c.recap || "";
  const r = await app.compose({
    instruction: "Catch a TV viewer up on the game they stepped away from. Use only the facts given (the scoreboard and "
      + "the live commentary transcript, which has recognition errors). Headline: at most 8 words, the score story. "
      + "Recap: two short sentences, the key moments and players. No invented stats.",
    schema: { type: "object", properties: { headline: { type: "string" }, recap: { type: "string" } }, required: ["headline", "recap"] },
    context: { sport, score: c.score_text, clock: c.clock, moments: moments.map(m => (m.clock ? `[game clock ${m.clock}] ` : "") + m.title), talked_about: who, commentary: said.slice(-3000) },
  }).catch(() => null);
  if (r?.ok) ({ headline, recap } = r.data as { headline: string; recap: string });
  $("recap-head").textContent = headline;
  $("recap-body").textContent = recap || (who.length ? `Talked about: ${who.join(", ")}.` : "");
  $("recap-moments").innerHTML = moments.map(m => `<li><span class="t">${esc(m.clock || m.time)}</span>${esc(m.title)}</li>`).join("");
  $("recap").classList.add("on");
  clearTimeout(recapTimer);
  recapTimer = window.setTimeout(() => $("recap").classList.remove("on"), 14000);
  return { headline, recap, moments, who, minutes: c.minutes };
}
app.tool("catch_up", async () => {
  const c = await catchUp();
  return { detail: JSON.stringify(c), say: [c.headline, c.recap].filter(Boolean).join(". ") || undefined };
});
// Ask about the game: the Ask button (Arc hears the question), or Little's own assistant through ask_game.
const askByVoice = setupAsk(app, audioContext, on => {
  if (on) { duckHeld++; setDuck(); } else { duckHeld = Math.max(0, duckHeld - 1); duckFor(600); }
});
app.tool<{ question?: string }>("ask_game", async ({ question }) => {
  if (!question) { void askByVoice(); return { detail: "listening for the viewer's question (Arc)" }; }
  showAsk(`“${question}”`, "", "thinking");
  const facts = await fetch("api/facts", { signal: AbortSignal.timeout(6000) }).then(r => r.json());
  const a = await answer(app, question, facts);
  showAsk(`“${question}”`, a || "I couldn't work that out from the game so far.", "done");
  return { detail: JSON.stringify({ answer: a, facts }), say: a || undefined };
});
app.tool("listen_to_tv", listenToTv);
// Starting a game restarts Arc for a fresh session (seconds under load): answer the agent at once, play behind it.
app.tool<{ sport?: string; clip?: string }>("play_demo", ({ sport: s, clip }) => {
  const c = findClip(clip || s);
  if (!c) return { detail: "no demo clips" };
  void playDemo(c.id);
  return { detail: `starting "${c.title}" (${c.subtitle ?? c.sport}); Arc will caption it live` };
});
app.tool("stop", () => { home(); return { detail: "stopped; back on the start screen" }; });

// The same buttons for the remote and the mouse.
$("b-listen").addEventListener("click", () => void listenToTv());
$("b-recap").addEventListener("click", () => void catchUp());
$("b-play").addEventListener("click", () => void playDemo(heroClip?.id));
// The simulator's window isn't always the focused OS window, and :focus only paints in a focused window: the focus
// ring follows a class instead, so the remote's position always shows.
document.addEventListener("focusin", e => (e.target as HTMLElement).classList?.add("f"));
document.addEventListener("focusout", e => (e.target as HTMLElement).classList?.remove("f"));
// The start screen's focus: the hero's buttons, then one row of games per sport.
function focusHome() {
  $("catalog").style.transform = "";
  ($("b-play") as HTMLButtonElement).focus({ preventScroll: true });
}
const back = $("back") as HTMLButtonElement;
// Home is a clean slate: the game stops, TV Watch forgets it, and nothing from it stays on screen.
function home() {
  stopAll();
  void post("api/reset", {});
  newGame();
  newSession();
  showState({ score: null, score_text: "", clock: null, clock_label: null });
  focusHome();
}
back.addEventListener("click", home);
// The remote: arrows move between the start buttons, Enter presses, Back (Escape) leaves the game for the start
// screen and leaves TV Watch from there.
document.addEventListener("keydown", e => {
  const busy = root.classList.contains("playing") || root.classList.contains("listening");
  if (e.key === "Escape" || e.key === "Backspace" || e.key === "GoBack" || e.key === "BrowserBack") {
    e.preventDefault();
    if ($("hl-list").classList.contains("on")) closeList();
    else if (reeling) { reeling = false; }
    else if (busy) home();
    else app.exit();
    return;
  }
  if (busy) {
    if (e.key === "MediaPlayPause" || e.key === " ") { togglePause(); e.preventDefault(); return; }
    if (e.key === "MediaFastForward") { seekTo(mediaTime() + 10); e.preventDefault(); return; }
    if (e.key === "MediaRewind") { seekTo(mediaTime() - 10); e.preventDefault(); return; }
    if (document.activeElement === $("t-bar") && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      seekTo(mediaTime() + (e.key === "ArrowRight" ? 10 : -10));
      e.preventDefault();
      return;
    }
    if (!e.key.startsWith("Arrow")) return;
    const live = [...document.querySelectorAll<HTMLButtonElement>(".hl-list.on button, .chips.on button, #back, #ask, #reel-btn, #transport button, #t-bar")]
      .filter(b => b.offsetParent !== null);
    const j = live.indexOf(document.activeElement as HTMLButtonElement);
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : -1;
    live[(j + step + live.length) % live.length]?.focus({ preventScroll: true });
    e.preventDefault();
    return;
  }
  const cur = document.activeElement as HTMLElement;
  const rows = [$("hero-buttons"), ...document.querySelectorAll<HTMLElement>("#catalog .strip")];
  let r = rows.findIndex(x => x.contains(cur));
  if (r < 0) { focusHome(); e.preventDefault(); return; }
  const items = [...rows[r].children] as HTMLButtonElement[], i = items.indexOf(cur as HTMLButtonElement);
  if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
    items[Math.max(0, Math.min(items.length - 1, i + (e.key === "ArrowRight" ? 1 : -1)))]?.focus({ preventScroll: true });
    e.preventDefault();
  } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    r = Math.max(0, Math.min(rows.length - 1, r + (e.key === "ArrowDown" ? 1 : -1)));
    if (r === 0) focusHome();
    else {   // the same column in the next row, where it exists
      const next = [...rows[r].children] as HTMLButtonElement[];
      next[Math.min(Math.max(0, i), next.length - 1)]?.focus({ preventScroll: true });
    }
    e.preventDefault();
  }
});

let hearing: (() => void) | null = null;
app.onEnter(info => {
  if (!hearing && app.can("sense.speech"))   // the viewer talking to the TV: the assistant answers right after
    hearing = app.sense.speech(f => duckFor(f.final ? 7000 : 4000));
  const p = (info?.params ?? {}) as { sport?: string };
  if (p.sport) void post("api/sport", { domain: p.sport });
  focusHome();
});
app.onPause(() => { stopAll(); hearing = null; });   // the host ends the speech stream while we're off screen   // off screen: the mic must go, and nobody is watching the clip
listen();
focusHome();
