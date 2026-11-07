import type { Worker } from "tesseract.js";
import { grey, recognize, type Templates } from "./glyphs";

// The broadcast's own score graphic, read off the video about once a second. Each field (a score, a team, the
// clock) is its own box. Fields are read by little OCR (glyphs.ts): per-broadcaster character templates, about 1.5 ms
// for a whole board on a laptop, so the TV keeps up (Tesseract took ~20 s a board on the TV). Over the demo clips'
// verified score timelines it finds 122 of 148 changes against 82 for the Tesseract path (Nov 7,
// ocr/glyphs/lo.mjs). Boxes are fractions of the frame, per broadcaster.
type Box = [number, number, number, number];
export const LAYOUTS: Record<string, Record<string, Box>> = {
  nba: { a_name: [0.313, 0.885, 0.352, 0.925], a: [0.385, 0.882, 0.448, 0.928], b_name: [0.453, 0.885, 0.492, 0.925],
    b: [0.528, 0.882, 0.585, 0.928], period: [0.593, 0.885, 0.628, 0.925], clock: [0.640, 0.882, 0.722, 0.928] },   // ESPN / ABC
  nhl: { period: [0.088, 0.064, 0.118, 0.096], clock: [0.086, 0.106, 0.126, 0.142], a_name: [0.183, 0.062, 0.225, 0.098],
    a: [0.226, 0.060, 0.246, 0.100], b_name: [0.183, 0.112, 0.225, 0.148], b: [0.226, 0.110, 0.246, 0.150] },   // ESPN
  nfl: { a: [0.360, 0.845, 0.422, 0.925], period: [0.430, 0.900, 0.470, 0.945], clock: [0.488, 0.900, 0.538, 0.945],
    b: [0.580, 0.845, 0.642, 0.925] },   // CBS
  soccer: { a_name: [0.120, 0.112, 0.168, 0.152], score: [0.183, 0.108, 0.250, 0.156], b_name: [0.262, 0.112, 0.315, 0.152],
    clock: [0.183, 0.178, 0.250, 0.222] },   // Premier League
  cricket: { a_name: [0.105, 0.866, 0.205, 0.903], wr: [0.100, 0.905, 0.192, 0.972], overs: [0.193, 0.933, 0.236, 0.972] },   // Fox
};
const ALLOW: Record<string, string> = { a: "0123456789", b: "0123456789", score: "0123456789-", wr: "0123456789-",
  clock: "0123456789:.", overs: "0123456789.", period: "0123456789STNDRHOTQ" };
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

export type Reading = { score?: number[]; teams?: string[]; clock?: string; period?: string; overs?: string; correction?: boolean };

// Tesseract only as a fallback in the simulator (on this Mac), for a broadcast that has no templates yet
let worker: Promise<Worker> | null = null;
const fastDevice = ["127.0.0.1", "localhost"].includes(location.hostname);
function ocr() {
  const base = new URL("tess/", location.href).href;
  worker ??= import("tesseract.js").then(T => T.createWorker("eng", 1, { workerPath: base + "worker.min.js", corePath: base,
    langPath: base.slice(0, -1), gzip: true, workerBlobURL: false }));
  return worker;
}

// The templates: per broadcaster layout (keyed by its boxes), with the threshold method each field reads best with,
// and per sport for broadcasts we haven't learned.
type GlyphSet = { chars: Templates; cuts: Record<string, 0 | 1 | 2> };
let glyphs: { byLayout: Record<string, GlyphSet>; sports: Record<string, Templates> } | null = null;
const glyphsReady = fetch(new URL("glyphs/templates.json", location.href).href).then(r => r.json()).then(j => { glyphs = j; })
  .catch(e => console.log(`[tvwatch] board: no glyph templates (${e})`));
const layoutKey = (l: Record<string, Box>) => JSON.stringify(Object.keys(l).sort().map(k => [k, l[k].map(x => +(+x).toFixed(3))]));
const MINCONF = 0.6;
const cell = document.createElement("canvas");

const frame = document.createElement("canvas");
const crop = document.createElement("canvas");

// One field, cut out, made dark-on-light and stretched, 4x up: what Tesseract reads best. `hard` thresholds it to
// pure black on white, which keeps a small decimal point (cricket overs "2.4": 70% of seconds read vs 26% grey)
// but loses thin dashes ("0-9"), so it is per field.
const HARD = new Set(["overs"]);
function cut(video: HTMLVideoElement, [x0, y0, x1, y1]: Box, hard = false, wide = false) {
  const W = video.videoWidth, H = video.videoHeight;
  const m = wide ? 0.006 * W : 0;   // score digits: a little room each side, or a narrow leading "1" gets cut (116 → "16")
  const sx = Math.max(0, x0 * W - m), sy = y0 * H, sw = Math.min(W - sx, (x1 - x0) * W + 2 * m), sh = (y1 - y0) * H, pad = 12;
  crop.width = Math.round(sw * 4) + 2 * pad;
  crop.height = Math.round(sh * 4) + 2 * pad;
  const g = crop.getContext("2d", { willReadFrequently: true })!;
  g.fillStyle = "#fff";
  g.fillRect(0, 0, crop.width, crop.height);
  g.imageSmoothingQuality = "high";
  g.drawImage(frame, sx, sy, sw, sh, pad, pad, crop.width - 2 * pad, crop.height - 2 * pad);
  const img = g.getImageData(pad, pad, crop.width - 2 * pad, crop.height - 2 * pad), d = img.data;
  let sum = 0, lo = 255, hi = 0;
  for (let i = 0; i < d.length; i += 4) {
    const v = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    d[i] = v;
    sum += v;
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  const invert = sum / (d.length / 4) < 128, span = Math.max(1, hi - lo);
  for (let i = 0; i < d.length; i += 4) {
    let v = ((d[i] - lo) / span) * 255;
    if (invert) v = 255 - v;
    if (hard) v = v >= 128 ? 255 : 0;
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  g.putImageData(img, pad, pad);
  return crop;
}

// What each field must look like. Bare score digits also need Tesseract's confidence (ghost digits look like
// numbers); everything else goes on its shape, because short strings read right at low confidence ("EDM" 15,
// "OT" 0, clocks 7, "3-2" 12), and the board's own checks (Side, Steady) take care of the rest.
const SHAPE: Record<string, RegExp> = { a: /^\d{1,3}$/, b: /^\d{1,3}$/, score: /^\d{1,2}-\d{1,2}$/, wr: /^\d{1,2}-\d{1,3}$/,
  clock: /^\d{1,2}:\d{2}$|^\d{1,2}\.\d$/, overs: /^\d{1,2}(\.\d)?$|^\d{3}$/, period: /^(\d(ST|ND|RD|TH)|OT|Q\d)$/ };
function fits(k: string, text: string, confidence: number) {
  if (!(SHAPE[k] ?? /^[A-Z]{2,12}$/).test(text)) return false;
  return k === "a" || k === "b" ? confidence >= (text.length === 1 ? 45 : 55) : true;   // a lone digit reads ~50 on colour cells
}

async function read(video: HTMLVideoElement, layout: Record<string, Box>, sport: string, skip = new Set<string>()): Promise<Raw> {
  await glyphsReady;
  const W = video.videoWidth, H = video.videoHeight;
  const set = glyphs?.byLayout[layoutKey(layout)], tpl = set?.chars ?? glyphs?.sports[sport];
  const got: Record<string, string> = {}, conf: Record<string, number> = {}, missed: string[] = [];
  // one copy off the video for the whole board (each copy is a slow GPU readback on the TV), then each field's pixels
  const boxes = Object.entries(layout).filter(([k]) => !skip.has(k)).map(([k, [x0, y0, x1, y1]]) => {
    // the same pixels the templates were learned from (ocr/glyphs/extract.mjs rect())
    const m = k === "a" || k === "b" ? 0.006 * W : 0;
    const sx = Math.max(0, Math.round(x0 * W - m)), sy = Math.round(y0 * H);
    return { k, sx, sy, sw: Math.max(4, Math.min(W - sx, Math.round((x1 - x0) * W + 2 * m))), sh: Math.max(4, Math.min(H - sy, Math.round((y1 - y0) * H))) };
  });
  if (!boxes.length) return { sides: [undefined, undefined] };
  const ux = Math.min(...boxes.map(b => b.sx)), uy = Math.min(...boxes.map(b => b.sy));
  const uw = Math.max(...boxes.map(b => b.sx + b.sw)) - ux, uh = Math.max(...boxes.map(b => b.sy + b.sh)) - uy;
  if (cell.width !== uw || cell.height !== uh) { cell.width = uw; cell.height = uh; }
  const g2 = cell.getContext("2d", { willReadFrequently: true })!;
  g2.drawImage(video, ux, uy, uw, uh, 0, 0, uw, uh);
  const px = g2.getImageData(0, 0, uw, uh).data;
  for (const { k, sx, sy, sw, sh } of boxes) {
    if (!tpl) { missed.push(k); continue; }
    const r = recognize(grey(px, uw, 4, sx - ux, sy - uy, sw, sh), sw, sh, tpl, ALLOW[k] ?? LETTERS, set?.cuts?.[k] ?? 1);
    const text = r.text.replace(/^0T$/, "OT");
    if (r.conf >= MINCONF && (SHAPE[k] ?? /^[A-Z]{2,12}$/).test(text)) { got[k] = text; conf[k] = r.conf * 100; }
    else missed.push(k);
  }
  // no templates for this broadcast, on a fast machine: the old Tesseract reading for what little OCR couldn't
  if (!set && fastDevice && missed.length) await tesseractFields(video, layout, missed, got, conf);
  const raw: Raw = { sides: [undefined, undefined] };
  const int = (s?: string) => (s && /^\d{1,3}$/.test(s) ? Number(s) : undefined);
  raw.sides = [int(got.a), int(got.b)];
  const pair = (got.score ?? "").match(/^(\d{1,2})-(\d{1,2})$/);
  if (pair) raw.sides = [Number(pair[1]), Number(pair[2])];
  const wr = (got.wr ?? "").match(/^(\d{1,2})-(\d{1,3})$/);   // wickets-runs (Australian broadcasts)
  if (wr && Number(wr[1]) <= 10) raw.sides = [Number(wr[2]), Number(wr[1])];   // tvwatch keeps cricket as (runs, wickets)
  raw.sure = (conf.wr ?? 0) >= 90;
  const name = (s?: string) => (s && /^[A-Z]{2,4}$|^[A-Z]{5,12}$/.test(s) ? s : undefined);
  raw.teams = [name(got.a_name), name(got.b_name)];
  const mins = got.clock?.includes(":") ? Number(got.clock.split(":")[0]) : 0;   // "26.1": under a minute, tenths
  const secs = got.clock?.includes(":") ? Number(got.clock.split(":")[1]) : 0;   // "9:94" is a misread
  if (got.clock && mins <= (sport === "soccer" ? 130 : 20) && secs < 60) raw.clock = got.clock;
  if (got.period) raw.period = got.period;
  if (got.overs && /^\d{1,2}(\.\d)?$|^\d{3}$/.test(got.overs)) raw.overs = got.overs;   // dotless: see oversOf
  return raw;
}

async function tesseractFields(video: HTMLVideoElement, layout: Record<string, Box>, keys: string[], got: Record<string, string>, conf: Record<string, number>) {
  const { PSM } = await import("tesseract.js");
  frame.width = video.videoWidth;
  frame.height = video.videoHeight;
  frame.getContext("2d")!.drawImage(video, 0, 0);
  const w = await ocr();
  for (const k of keys) {
    const img = cut(video, layout[k], HARD.has(k), k === "a" || k === "b");
    const seen: string[] = [];
    for (const psm of [PSM.SINGLE_LINE, PSM.RAW_LINE]) {
      await w.setParameters({ tessedit_pageseg_mode: psm, tessedit_char_whitelist: ALLOW[k] ?? LETTERS });
      const r = await w.recognize(img);
      const text = r.data.text.trim().replace(/\s+/g, "").replace(/^0T$/, "OT");
      const agreed = (k === "a" || k === "b") && /^\d{1,3}$/.test(text) && seen.includes(text);
      seen.push(text);
      if (agreed || fits(k, text, r.data.confidence)) { got[k] = text; conf[k] = r.data.confidence; break; }
    }
  }
}

type Raw = { sides: (number | undefined)[]; sure?: boolean; teams?: (string | undefined)[]; clock?: string; period?: string; overs?: string };

// How far one side's number can move in one play (cricket: runs, then wickets).
// Cricket highlight packages jump 10-40 runs between the overs they show: runs may move 60, wickets 1.
const STEP: Record<string, number[]> = { nba: [4, 4], nfl: [8, 8], nhl: [2, 2], soccer: [2, 2], cricket: [60, 1] };
// The widest believable gap between the two sides; a read past it is a misread ("MIN 8 – 89 SAS" was "88").
const GAP: Record<string, number> = { nba: 50, nfl: 50, nhl: 8, soccer: 8 };

// The tiny dot in Fox's overs often doesn't read: "32" after 3.1 is 3.2, "32" after 31.5 is 32.0, "324" is 32.4.
function oversOf(raw: string, prev: number | null) {
  if (raw.includes(".")) return raw;
  if (raw.length === 3) return `${raw.slice(0, 2)}.${raw[2]}`;
  const whole = Number(raw), split = raw.length === 2 && Number(raw[1]) <= 5 ? Number(`${raw[0]}.${raw[1]}`) : null;
  if (split == null) return `${whole}.0`;
  if (prev == null) return whole >= 10 && split < 1 ? `${whole}.0` : `${raw[0]}.${raw[1]}`;
  return Math.abs(whole - prev) < Math.abs(split - prev) ? `${whole}.0` : `${raw[0]}.${raw[1]}`;
}

// Each side of the score is checked on its own: it only goes up, by no more than one play's worth, and a new value
// must be read twice in the last three seconds (the first value three times in the last five). A side that can't be read this second keeps its
// last value, so one cell lighting up never freezes the board, and ghost digits ("920" for 90, "294" for 94) are
// dropped. One bad low read can never stick, though: a higher value read 4 times in the last 6 becomes the side's
// value as a correction (no event) even past the step ("MIN 8 – 89" stuck forever before; condensed games jump
// 68 → 80 across a cut). Never downwards: a misread 7 reads "1" for seconds at a time ("73" → "13").
type Fed = "" | "move" | "fix";
class Side {
  value?: number;
  private run = 0;   // the same out-of-range value, unbroken
  private hist: number[] = [];
  feed(v: number | undefined, step: number, need: number, other: number | undefined, gap?: number): Fed {
    if (v == null) return "";
    this.run = v === this.hist[this.hist.length - 1] ? this.run + 1 : 1;
    this.hist = [...this.hist, v].slice(-6);
    if (v === this.value) return "";
    const count = (n: number) => this.hist.slice(-n).filter(x => x === v).length;
    const fair = gap == null || other == null || Math.abs(v - other) <= gap;
    if (this.value == null) {   // the first value: 3 of the last 5 reads (live reads jitter: 114, 4, 14, 114, 114)
      if (fair && count(5) >= 3) { this.value = v; return "fix"; }
      return "";
    }
    if (fair && v > this.value && v - this.value <= step && count(3) >= need) { this.value = v; return "move"; }
    if (v > this.value && count(6) >= 4 && this.run >= (fair ? 4 : 8)) { this.value = v; return "fix"; }   // a leap must read steadily ("99" ghost)
    return "";
  }
}

// A label (a team name, the period) is believed once it reads the same `need` times in a row.
class Steady {
  value = "";
  private cand = "";
  private seen = 0;
  constructor(private need: number) {}
  feed(v?: string) {
    if (!v) return;
    this.seen = v === this.cand ? this.seen + 1 : 1;
    this.cand = v;
    if (this.seen >= this.need) this.value = v;
  }
}

// Reads every second while the clip plays and reports only what changed: the score once both sides are known
// (and after any side moves), the clock on every clean read (it ticks every second), the period when it settles.
// A demo replays the same clip file, so the clip's address alone can't tell a new game: the app calls newGame()
// whenever it starts one (tvwatch forgets its score at the same moment).
let gameId = 0, clipLayout: Record<string, Box> | null = null, clipTeams: string[] = [];
// teams: the catalog's names for broadcasts whose scoreboard shows logos, not abbreviations ("LAL", "PHI")
export function newGame(layout?: Record<string, Box> | null, teams?: string[] | null) {
  gameId++;
  clipTeams = teams ?? [];
  clipLayout = layout && Object.keys(layout).length ? layout : null;   // this broadcast's own boxes, if the catalog has them
}

// The scoreboard boxes in use now (the clip's own, else the sport's): the page keeps its captions clear of them.
export function activeLayout(sport: string): Record<string, Box> | undefined {
  return clipLayout ?? LAYOUTS[sport];
}

export function watchBoard(video: HTMLVideoElement, sport: () => string, onReading: (r: Reading) => void) {
  let sides = [new Side(), new Side()], teams = [new Steady(3), new Steady(3)], period = new Steady(2);
  let sentClock = "", sentTeams = "", busy = false, game = "", lastOvers: number | null = null, tick = 0;
  const timer = window.setInterval(async () => {
    const s = sport(), layout = clipLayout ?? LAYOUTS[s];
    if (!layout || busy || video.paused || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return;
    if (game !== video.currentSrc + "#" + gameId) {   // another clip, or the same clip started over: another game
      game = video.currentSrc + "#" + gameId;
      sides = [new Side(), new Side()];
      teams = [new Steady(3), new Steady(3)];
      period = new Steady(2);
      sentClock = sentTeams = "";
      lastOvers = null;
    }
    busy = true;
    try {
      // the less that changes, the less it is read: names the catalog knows never, the period every 5th second
      const skip = new Set<string>([...(clipTeams.length ? ["a_name", "b_name"] : []), ...(tick++ % 5 && period.value ? ["period"] : [])]);
      const t0 = performance.now();
      const r = await read(video, layout, s, skip);
      if (tick % 30 === 1) console.log(`[tvwatch] board read ${Math.round(performance.now() - t0)} ms`);
      const out: Reading = {};
      // A wicket often shows for one second before the bar animates away (1-9 at 56 s in the Fox clip, read at
      // confidence 91): a sure read that only adds a wicket, runs unchanged, counts at once. Nothing else does
      // (ESPN ghost digits read at confidence 93).
      const wicket = s === "cricket" && r.sure && r.sides[0] === sides[0].value && r.sides[1] === (sides[1].value ?? -1) + 1;
      // the gap is judged against what the other side reads now, so both sides can correct together (16-15 → 116-115)
      const fed = sides.map((side, i) => side.feed(r.sides[i], (STEP[s] ?? [9, 9])[i], wicket ? 1 : 2, r.sides[1 - i] ?? sides[1 - i].value, GAP[s]));
      const moved = fed.includes("move"), fixed = fed.includes("fix") && !moved;
      r.teams?.forEach((t, i) => teams[i].feed(t));
      const names = teams.map((x, k) => clipTeams[k] || x.value || ""), settled = names.join("|") !== sentTeams;   // the catalog's names win; read names settle a beat after the score
      if ((moved || fixed || settled) && sides.every(x => x.value != null)) {
        sentTeams = names.join("|");
        Object.assign(out, { score: sides.map(x => x.value!), teams: names }, fixed ? { correction: true } : {});
      }
      period.feed(r.period);
      if (r.overs) {
        r.overs = oversOf(r.overs, lastOvers);
        lastOvers = Number(r.overs);
      }
      const clock = r.overs ?? r.clock;
      if (clock && clock !== sentClock) {
        sentClock = clock;
        Object.assign(out, { clock: r.clock, period: period.value || undefined, overs: r.overs });
      }
      if (Object.keys(out).length) onReading(out);
    } catch (e) {
      console.log(`[tvwatch] board: ${e}`);
    } finally {
      busy = false;
    }
  }, 1000);
  return () => clearInterval(timer);
}

// One look at a frame with a given layout (no Side/Steady rules): the YouTube screen-grab reader (boardyt.ts) uses it
// to choose which known broadcaster layout a frame matches.
export const readFields = read;
