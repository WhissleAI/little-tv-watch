// What TV Watch reads out of a commentator's words: spoken numbers, scores, clocks, match minutes, phrases and their
// near misses, and the clean-ups for Arc's live lines. A line-for-line port of tvwatch.py's text helpers.
import { ratio } from "./difflib.ts";

const UNITS: Record<string, number> = {};
"zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen"
  .split(" ").forEach((w, i) => { UNITS[w] = i; });
Object.assign(UNITS, { nil: 0, nothing: 0, love: 0 });
const TENS: Record<string, number> = {};
"_ _ twenty thirty forty fifty sixty seventy eighty ninety".split(" ").forEach((w, i) => { if (i > 1) TENS[w] = 10 * i; });
const isDigits = (s: string) => /^[0-9]+$/.test(s);

/** ['one','hundred','two'] -> 102; digits pass through; null when nothing numeric. */
export function wordsToInt(ws: string[]): number | null {
  let total = 0, cur = 0, seen = false;
  for (const w0 of ws) {
    const w = w0.toLowerCase().replace(/^[.,!?'"]+|[.,!?'"]+$/g, "").replace(/-/g, " ");
    for (const p of w.split(/\s+/).filter(Boolean)) {
      if (isDigits(p)) { cur += parseInt(p, 10); seen = true; }
      else if (p in UNITS) { cur += UNITS[p]; seen = true; }
      else if (p in TENS) { cur += TENS[p]; seen = true; }
      else if (p === "hundred") { cur = Math.max(cur, 1) * 100; seen = true; }
      else if (p === "thousand") { total += Math.max(cur, 1) * 1000; cur = 0; seen = true; }
      else if (p === "and" || p === "a") continue;
      else if (seen) return total + cur;
    }
  }
  return seen ? total + cur : null;
}

/** 'one hundred two to ninety eight' / '102-98' -> [102, 98] */
export function parseScore(text: string): [number, number] | null {
  const t = text.toLowerCase().replace(/–/g, "-");
  let m = /(\d+)\s*(?:-|to)\s*(\d+)/.exec(t);
  if (m) return [parseInt(m[1], 10), parseInt(m[2], 10)];
  m = /\b(\w+)\s+nil\b/.exec(t);
  if (m && wordsToInt([m[1]]) !== null) return [wordsToInt([m[1]])!, 0];
  const sp = /\s(?:to|-)\s/.exec(t);
  if (sp) {
    const a = wordsToInt(t.slice(0, sp.index).split(/\s+/).filter(Boolean));
    const b = wordsToInt(t.slice(sp.index + sp[0].length).split(/\s+/).filter(Boolean));
    if (a !== null && b !== null) return [a, b];
  }
  return null;
}

export const NUMW = new Set([...Object.keys(UNITS), ...Object.keys(TENS), "hundred", "thousand"]);
const isnum = (w: string) => isDigits(w) || NUMW.has(w);

const ORD: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8,
  ninth: 9, tenth: 10, eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14, fifteenth: 15, sixteenth: 16,
  seventeenth: 17, eighteenth: 18, nineteenth: 19, twentieth: 20, thirtieth: 30, fortieth: 40, fiftieth: 50,
  sixtieth: 60, seventieth: 70, eightieth: 80, ninetieth: 90 };

/** 'in the eighty seventh minute' / '87th minute' / "87'" -> 87; plain durations ('five minutes') are not minutes */
export function parseMatchMinute(text: string): number | null {
  const t = text.toLowerCase().replace(/-/g, " ");
  let m = /\b(\d+)(?:st|nd|rd|th)\s+minute\b/.exec(t) || /\b(\d+)'/.exec(t);
  if (m) return parseInt(m[1], 10);
  m = /(?:(\w+)\s+)?(\w+)\s+minute\b/.exec(t);
  if (m && m[2] in ORD) return (TENS[m[1] ?? ""] ?? 0) + ORD[m[2]];
  m = /\b(?:in|into)\s+the\s+((?:\w+\s+){1,2}?)minutes?\b/.exec(t);
  if (m) {
    const ws = m[1].split(/\s+/).filter(Boolean), v = wordsToInt(ws);
    if (v !== null && (NUMW.has(ws[0]) || ws[0] === String(v))) return v;
  }
  return null;
}

/** 'one minute forty five left' / '1:45' / 'forty seconds' / '2 minutes' -> seconds */
export function parseClock(text: string): number | null {
  const t = text.toLowerCase();
  const m = /(\d+):(\d\d)/.exec(t);
  if (m) return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  const ws = t.replace(/-/g, " ").replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
  let mins: number | null = null, secs: number | null = null;
  ws.forEach((w, i) => {
    if (!["minute", "minutes", "second", "seconds"].includes(w)) return;
    let j = i;
    while (j > 0 && isnum(ws[j - 1])) j--;
    const v = j < i ? wordsToInt(ws.slice(j, i)) : (w === "minute" ? 1 : null);
    if (w.startsWith("minute")) {
      mins = v;
      let k = i + 1;   // "one minute forty five (left)"
      while (k < ws.length && isnum(ws[k])) k++;
      if (k > i + 1 && (k === ws.length || !["second", "seconds"].includes(ws[k]))) secs = wordsToInt(ws.slice(i + 1, k));
    } else if (v !== null) secs = v;
  });
  if (mins === null && secs === null) return null;
  return (mins ?? 0) * 60 + (secs ?? 0);
}

const W = [...NUMW].filter(w => !["nil", "nothing", "love"].includes(w)).sort((a, b) => b.length - a.length).join("|");
const NW = `(?:\\d+|(?:${W})(?:(?:[ -]|\\s+and\\s+)(?:${W}))*)`;
export const SCORE_RE = () => new RegExp(`\\b${NW}\\s*(?:\\bto\\b|-)\\s*${NW}\\b|\\b(?:${W})\\s+nil\\b`, "gi");
export const CRICKET_RE = () => new RegExp(`\\b(${NW})\\s*(?:\\bfor\\b|/)\\s*(${NW})\\b`, "gi");   // runs for wickets: "142 for 6"
export const UNIT_AFTER = /^\W*(?:seconds?|secs?|minutes?|mins?|hours?|yards?|yard line|metres?|meters?|feet|foot|percent|years?|games?|wins?|losses|records?|times|overs?|balls?|days?|weeks?|points? per|rebounds|assists)\b/i;
export const CLOCK_RE = () => /((?:\S+\s+){1,6}?)(?:left|remaining|to play|two play|to go|on the clock)\b/gi;

/** the sentence of text that holds needle (an alert body, not the whole utterance) */
export function snippet(text: string, needle = "") {
  const sents = text.split(/(?<=[.!?])\s+/);
  for (const x of sents) if (needle && x.toLowerCase().includes(needle.toLowerCase().replace(/^[ .,]+|[ .,]+$/g, ""))) return x;
  return text.length > 160 ? sents[sents.length - 1] : text;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const hasPhrase = (text: string, phrase: string) => new RegExp(`\\b${esc(phrase.toLowerCase())}\\b`).test(text.toLowerCase());

export const FUZZY_MIN = 0.8;   // a misheard keyword / name still counts ("couchdown" ~ touchdown)
/** hasPhrase, or a near miss for a long enough phrase (strict: partials, exact words only) */
export function fuzzyHas(text: string, phrase: string, strict = false) {
  if (hasPhrase(text, phrase)) return true;
  if (strict) return false;
  const p = phrase.toLowerCase().replace(/[^a-z0-9 ]/g, "").split(/\s+/).filter(Boolean);
  if (p.reduce((n, w) => n + w.length, 0) < 6) return false;
  const ws = text.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
  const target = p.join(" ");
  for (let i = 0; i + p.length <= ws.length; i++) if (ratio(ws.slice(i, i + p.length).join(" "), target) >= FUZZY_MIN) return true;
  return false;
}

export const norm = (w: string) => w.toLowerCase().replace(/[^a-z0-9]/g, "");

/** a sentence whose most common three-word phrase comes 3+ times is Arc looping under noise, not trusted */
export function looping(text: string) {
  const w = text.split(/\s+/).filter(Boolean).map(norm), counts = new Map<string, number>();
  let best = 0;
  for (let i = 0; i + 2 < w.length; i++) {
    const g = w.slice(i, i + 3).join("\u0001"), c = (counts.get(g) ?? 0) + 1;
    counts.set(g, c);
    best = Math.max(best, c);
  }
  return best >= 3;
}

// Arc mishears under crowd noise ("and the foul" came out as "and the fuck"): no swear word reaches a screen.
const SWEAR = /\b(fuck\w*|shit\w*|bitch\w*|asshole\w*|cunt\w*|motherfuck\w*|dick(?:head)?s?|bastard\w*)\b/gi;
export function clean(text: string, sports: boolean) {
  return (text || "").replace(SWEAR, w => {
    if (sports && w.toLowerCase().startsWith("fuck")) return (w[0] === w[0].toUpperCase() && w[0] !== w[0].toLowerCase() ? "F" : "f") + "oul" + (w.toLowerCase().endsWith("s") ? "s" : "");
    return w[0] + "*".repeat(w.length - 1);
  });
}

/** a greedy partial loops where its audio runs out: keep one of a repeated word, stop where a 3-word phrase restarts */
export function cleanWindow(words: string[]) {
  const out: string[] = [], seen = new Set<string>();
  for (const w of words) {
    if (out.length && norm(w) === norm(out[out.length - 1]) && norm(w)) continue;
    out.push(w);
    if (out.length >= 3) {
      const g = out.slice(-3).map(norm);
      if (seen.has(g.join("\u0001")) && g.every(Boolean)) { out.splice(-3); break; }
      if (out.length >= 4) seen.add(out.slice(-4, -1).map(norm).join("\u0001"));
    }
  }
  return out;
}

/** drop a phrase said twice in a row by the stitch, not the commentator ("goes right goes right at" -> "goes right at") */
export function undouble(words: string[]) {
  const out = [...words];
  for (let n = 6; n > 1; n--) {
    let i = 0;
    while (i + 2 * n <= out.length) {
      const a = out.slice(i, i + n).map(norm).join("\u0001"), b = out.slice(i + n, i + 2 * n).map(norm).join("\u0001");
      if (a === b) out.splice(i + n, n); else i++;
    }
  }
  return out;
}
