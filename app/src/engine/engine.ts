// TV Watch's service, in the page: everything tvwatch.py did between Arc and the screen, so the Little TV needs no
// laptop. In: Arc's records (partial / final / frame / event, exactly what arc_tv prints) and the scoreboard's
// readings (board.ts). Out: the same messages the page took from tvwatch's /api/events (hello, state, partial, final,
// alert, alert_update, event) and the same answers to its /api calls (see local.ts). A line-for-line port of
// tvwatch.py (its comments carry the why); test/engine_replay.ts replays the same recording as test_replay.py.
import {
  CLOCK_RE, CRICKET_RE, SCORE_RE, UNIT_AFTER, clean, cleanWindow, fuzzyHas, hasPhrase, looping, norm, parseClock,
  parseMatchMinute, parseScore, snippet, undouble, wordsToInt,
} from "./text.ts";
import { ratio } from "./difflib.ts";

export type Tag = { tag: string; text: string; wb?: number; we?: number; watch?: string | null };
export type ArcRec = { k: string; id?: number; t?: number; text?: string; tags?: Tag[]; p?: any; sp?: number; label?: string;
  start?: number; end?: number; intent?: string; act?: string };
export type Rule = { id?: string; type: string; [k: string]: any };
export type Alert = { aid: number; time: string; title: string; body: string; priority: number; clock: string | null };
export type Line = { id?: number; time: string; text: string; tags: Tag[]; domain?: string };
export type Reading = { score?: number[]; teams?: string[]; clock?: string; period?: string; overs?: string; correction?: boolean };
type Score = [number, number];

/** where rules, the watchlist and rosters live: localStorage in the page, a Map in tests */
export interface Store { get(key: string): string | null; set(key: string, value: string): void }
/** Arc, wherever it runs (arclocal.ts in the page): told the game's names, bias phrases and context when they change */
export interface ArcSink {
  restart?(cfg: ArcConfig): void;
  setContext?(context: string): void;
  push?(pcm: Int16Array): void;
  transcribeOnce?(pcm: Int16Array, domain: string, names: string): Promise<ArcRec[]>;
}
export type ArcConfig = { domain: string; names: string; bias: string[]; context: string };
/** Arc Tagger (tagger.ts): the C server's /tag JSON for one sentence */
export interface TaggerLike { tag(text: string, domain: string): Promise<any | null> }
/** the director (director3.ts): Features3 + Director3, used only while no scoreboard is readable */
export interface DirectorLike {
  features: { frame(p: Record<string, number>, sp?: number): void; line(text: string, tags: { tag: string }[], final: boolean): void;
    tagger(events: Record<string, number>, scoreSpans: number, personSpans: number): void;
    take(sport: string): { row: ArrayLike<number>; tokens: number[] } };
  model: { step(row: ArrayLike<number>, tokens: number[], sport: string): { p: number; kind: string; side: number }; reset(): void };
}

export const SPORT_NAMES: Record<string, string> = { nba: "Basketball (NBA)", nfl: "American football (NFL)", nhl: "Hockey (NHL)",
  soccer: "Soccer", cricket: "Cricket", esports: "Esports", news: "News", talk: "Talk show", court_trial: "Court TV", stream_chat: "Live stream" };
export const SPORTS = new Set(["nba", "nhl", "nfl", "cricket", "soccer", "esports"]);
const KIND: Record<string, string> = { ENTITY_PERSON: "person", ENTITY_TEAM: "team", ENTITY_PLACE: "place", ENTITY_ORG: "organization" };
const SCORE_MAX: Record<string, number> = { soccer: 15, nhl: 15, nfl: 80, nba: 200, esports: 60 };
const JUMPS: Record<string, Record<number, string>> = {
  nba: { 1: "Free throw", 2: "Basket", 3: "Three!" },
  nfl: { 6: "🏈 Touchdown!", 7: "🏈 Touchdown!", 8: "🏈 Touchdown!", 3: "Field goal", 1: "Extra point", 2: "Safety / two points" },
  nhl: { 1: "🚨 Goal!" }, soccer: { 1: "⚽ Goal!" }, esports: {} };
const OCR_FRESH_S = 30, CLOCK_STALE_S = 90;
// The director, heard not confirmed: NBA only (the one sport it was validated on), at the training-chosen operating
// point (held-out games: recall 0.77, precision 0.73; director/v2/README.md), one call per 10 s.
const DIRECTOR_SPORTS: Record<string, number> = { nba: 0.95 };

export type EngineOptions = {
  store: Store; domain?: string; now?: () => number; memoryMin?: number; noEarly?: boolean;
  rules?: Rule[]; names?: string; rosters?: Record<string, string>;
  arc?: ArcSink; tagger?: TaggerLike; director?: DirectorLike;
};

/** names-file text ("Name|kind|alias1,alias2" lines) -> [(canon, [canon, ...aliases])] */
export function parseNames(text: string | null): [string, string[]][] {
  const out: [string, string[]][] = [];
  for (const raw of (text ?? "").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const bits = line.split("|");
    const aliases = bits.length > 2 && bits[2] ? bits[2].split(",").map(a => a.trim()) : [];
    out.push([bits[0].trim(), [bits[0].trim(), ...aliases]]);
  }
  return out;
}

const pad = (n: number) => String(n).padStart(2, "0");

export class Engine {
  // the game
  domain: string;
  state = { lines: [] as Line[], partial: "", alerts: [] as Alert[], score: null as Score | null, clock: null as number | null,
    clock_label: null as string | null, level: 0, status: "starting", score_at: 0, clock_at: 0, last_game: undefined as number | undefined };
  memory = { lines: [] as [number, Line][], scores: [] as [number, number[], string][], alerts: [] as [number, Alert][], ctx_written: 0 };
  ocr = { at: 0, teams: ["", ""] as string[], history: [] as Score[], run_said: {} as Record<number, number> };
  game = { players: {} as Record<string, { points: number; plays: number }>, ties: 0, lead_changes: 0, max_lead: [0, 0], plays: [] as any[] };
  session = { id: 0, started: 0 };
  telemetry: any[] = [];
  // the record path
  private lastFired = new Map<string, number>();
  private earlySent = new Map<string, [Alert, number]>();
  private early = { id: null as number | null, hits: new Set<string>() };
  private collect: [Rule, string, string][] | null = null;
  private strict = false;
  private aid = 0;
  private lastBig = { alert: null as Alert | null, t: 0, boosted: false };
  private labelOn = new Map<string, [number, boolean]>();
  private speech: number[] = [];
  private stitchState = { id: null as number | null, words: [] as string[], tags: [] as Tag[] };
  private listeners = new Set<(kind: string, data: any) => void>();
  private timers: ReturnType<typeof setInterval>[] = [];
  private lastDirector = -1e9;

  store: Store; now: () => number; memoryMin: number; noEarly: boolean;
  arc?: ArcSink; tagger?: TaggerLike; director?: DirectorLike;
  private defaults: { rules: Rule[]; names: string; rosters: Record<string, string> };

  constructor(o: EngineOptions) {
    this.store = o.store;
    this.now = o.now ?? (() => Date.now() / 1000);
    this.domain = o.domain ?? o.store.get("tvw.domain") ?? "nba";
    this.memoryMin = o.memoryMin ?? 30;
    this.noEarly = !!o.noEarly;
    this.arc = o.arc; this.tagger = o.tagger; this.director = o.director;
    this.defaults = { rules: o.rules ?? [], names: o.names ?? "", rosters: o.rosters ?? {} };
  }

  // ------------------------------------------------------------ out
  on(fn: (kind: string, data: any) => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  publish(kind: string, data: any) { for (const fn of this.listeners) fn(kind, data); }
  tele(kind: string, data: any) {
    this.telemetry.push({ w: Math.round(this.now() * 100) / 100, k: kind, dom: this.domain, ...data });
    if (this.telemetry.length > 20000) this.telemetry.splice(0, 5000);
  }
  private hms(t = this.now()) { const d = new Date(t * 1000); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; }

  /** the background jobs tvwatch ran on threads: the clock going stale, the director's 1 s tick */
  start() {
    this.timers.push(setInterval(() => this.health(), 2000));
    if (this.director) this.timers.push(setInterval(() => this.directorTick(), 1000));
    this.startArc();
  }
  stop() { this.timers.forEach(clearInterval); this.timers = []; }
  private health() {
    if (this.state.clock_label && this.now() - this.state.clock_at > CLOCK_STALE_S) {
      this.state.clock = null; this.state.clock_label = null;   // a clock nobody has said for a while is no longer the clock
      this.publish("state", { score: this.state.score, score_text: this.scoreText(), clock: null, clock_label: null, domain: this.domain });
    }
  }

  // ------------------------------------------------------------ rules, watchlist, rosters (persisted)
  loadRules(): Rule[] {
    const s = this.store.get("tvw.rules");
    return s ? JSON.parse(s) : structuredClone(this.defaults.rules);
  }
  saveRules(rules: Rule[]) { this.store.set("tvw.rules", JSON.stringify(rules)); }
  loadNames(text?: string | null) { return parseNames(text === undefined ? (this.store.get("tvw.names") ?? this.defaults.names) : text); }
  rosterText(sport = this.domain) { return this.store.get(`tvw.roster.${sport}`) ?? this.defaults.rosters[sport] ?? null; }
  rosterForms(): Set<string> {
    return new Set(this.loadNames(this.rosterText()).flatMap(([c, f]) => [c, ...f].map(x => x.toLowerCase())));
  }
  inGame(forms: string[]) { const roster = this.rosterForms(); return !roster.size || forms.some(x => roster.has(x.toLowerCase())); }
  otherRosters() {
    const out = new Set<string>();
    for (const sport of Object.keys(SPORT_NAMES)) {
      if (sport === this.domain) continue;
      for (const [c] of this.loadNames(this.rosterText(sport))) out.add(c.toLowerCase());
    }
    for (const [c] of this.loadNames(this.rosterText())) out.delete(c.toLowerCase());
    return out;
  }
  sportNames() {
    const other = this.otherRosters();
    return this.loadNames().filter(([c, f]) => !other.has(c.toLowerCase()) && this.inGame([c, ...f]));
  }
  activeRules() { return this.loadRules().filter(r => !r.sports || r.sports.includes(this.domain)); }
  /** Arc's names list: the watchlist (only the people in this game) plus tonight's roster, minus other sports' */
  arcNames() {
    const lines: string[] = [], seen = new Set<string>(), other = this.otherRosters();
    const sources: [string, string][] = [["names", this.store.get("tvw.names") ?? this.defaults.names], ["roster", this.rosterText() ?? ""]];
    for (const [which, text] of sources) {
      for (const line of text.split("\n")) {
        const k = line.split("|")[0].trim().toLowerCase();
        const bits = line.split("|");
        const forms = [k, ...(bits.length >= 3 ? bits[2].split(",") : []).filter(a => a.trim())];
        if (which === "names" && !this.inGame(forms.map(x => x.trim()))) continue;
        if (k && !k.startsWith("#") && !seen.has(k) && !other.has(k)) { seen.add(k); lines.push(line.replace(/\n$/, "")); }
      }
    }
    return lines.join("\n") + "\n";
  }
  biasPhrases(rules = this.activeRules(), names = this.sportNames()) {
    const out: string[] = [];
    for (const [, forms] of names) if (this.inGame(forms)) out.push(...forms);
    for (const r of rules) {
      out.push(...(r.words ?? []));
      if (r.type === "name" && r.name && this.inGame([r.name])) out.push(r.name);
    }
    const seen = new Set<string>(), uniq: string[] = [];
    for (const p of out) if (!seen.has(p.toLowerCase()) && p.length > 2) { seen.add(p.toLowerCase()); uniq.push(p); }
    return uniq;
  }
  private context = "";
  startArc() { this.arc?.restart?.({ domain: this.domain, names: this.arcNames(), bias: this.biasPhrases(), context: this.context }); }

  // ------------------------------------------------------------ alerts
  fire(rule: Rule, title: string, body: string, early = false) {
    if (this.collect) { this.collect.push([rule, title, body]); return; }
    const now = this.now(), key = rule.id ?? title;
    if (now - (this.lastFired.get(key) ?? 0) < Number(rule.cooldown_s ?? 60)) {
      const sent = early ? undefined : this.earlySent.get(key);
      if (!early) this.earlySent.delete(key);   // later partials re-hit it: only the final cleans up
      if (sent && now - sent[1] < 30) {   // the final of an early alert: replace its partial text
        Object.assign(sent[0], { title, body });
        this.publish("alert_update", { aid: sent[0].aid, title, body });
      }
      return;
    }
    this.lastFired.set(key, now);
    const alert: Alert = { aid: ++this.aid, time: this.hms(now), title, body, priority: Number(rule.priority ?? 4), clock: this.state.clock_label };
    if (early) this.earlySent.set(key, [alert, now]);
    this.state.alerts.unshift(alert);
    if (this.state.alerts.length > 50) this.state.alerts.length = 50;
    this.memory.alerts.push([now, alert]);
    if (alert.priority >= 4 && rule.type !== "sound") Object.assign(this.lastBig, { alert, t: now, boosted: false });
    this.publish("alert", alert);
    this.tele("alert", { title, body, rule: rule.id, type: rule.type, priority: alert.priority });
  }
  /** a cheer never alerts on its own: it upgrades an important alert sent in the last window_s ("Goal! 🔥") */
  crowd(rule: Rule) {
    const a = this.lastBig.alert;
    if (!a || this.lastBig.boosted || this.now() - this.lastBig.t > Number(rule.window_s ?? 12)) return;
    this.lastBig.boosted = true;
    a.title = a.title + " " + (rule.mark ?? "🔥");
    this.publish("alert_update", { aid: a.aid, title: a.title, body: a.body });
  }
  private fuzzy(text: string, phrase: string) { return fuzzyHas(text, phrase, this.strict); }

  // ------------------------------------------------------------ score and clock
  ocrFresh() { return this.now() - this.ocr.at < OCR_FRESH_S; }
  scoreText(s: number[] | null = this.state.score): string | null {
    if (!s) return null;
    if (this.domain === "cricket") return this.ocrFresh() && this.ocr.teams[0] ? `${this.ocr.teams[0]} ${s[0]}/${s[1]}` : `${s[0]}/${s[1]}`;
    const [a, b] = this.ocrFresh() ? this.ocr.teams : ["", ""];
    return `${a} ${s[0]} – ${s[1]} ${b}`.trim();
  }
  plausibleScore(sc: Score, after: string) {
    if (UNIT_AFTER.test(after)) return false;
    if (Math.max(...sc) > (SCORE_MAX[this.domain] ?? 400)) return false;
    const prev = this.state.score;
    if (prev && this.now() - this.state.score_at < 20 * 60 && this.domain !== "cricket") {
      const up = (a: number[], b: number[]) => a[0] >= b[0] && a[1] >= b[1];
      if (!(up(sc, prev) || up([sc[1], sc[0]], prev))) return false;
    }
    return true;
  }
  checkScore(rules: Rule[], t: { text: string }, s: Score, text: string) {
    const prev = this.state.score;
    this.state.score = s;
    this.state.score_at = this.now();
    const same = (a: number[] | null, b: number[] | null) => !!a && !!b && a[0] === b[0] && a[1] === b[1];
    if (!same(s, prev)) this.memory.scores.push([this.now(), [...s], snippet(text, t.text)]);
    for (const r of rules) {
      if (r.type === "score_change" && !same(s, prev)) this.fire(r, `Score ${this.scoreText(s)}`, snippet(text, t.text));
      if (r.type === "lead_change" && prev && (prev[0] - prev[1]) * (s[0] - s[1]) < 0) this.fire(r, `Lead change! ${s[0]}-${s[1]}`, snippet(text, t.text));
      if (r.type === "close_game" && Math.abs(s[0] - s[1]) <= Number(r.margin ?? 3)) this.fire(r, `Close game: ${s[0]}-${s[1]}`, snippet(text, t.text));
    }
  }

  // ------------------------------------------------------------ the scoreboard on screen
  recentPerson(within = 15): [string | null, string] {
    const now = this.now();
    const lines = this.memory.lines.filter(([t]) => now - t >= 0 && now - t < within).map(([, l]) => l);
    for (const line of [...lines].reverse()) {
      const roster = this.rosterForms();   // with a roster, only its players can score ("Neither" was once tagged a person)
      const people = (line.tags ?? []).filter(t => t.tag === "ENTITY_PERSON").map(t => t.text.replace(/^[ .,!?]+|[ .,!?]+$/g, ""))
        .filter(p => !roster.size || roster.has(p.toLowerCase()) || p.split(/\s+/).some(w => roster.has(w.toLowerCase())));
      if (people.length) return [people[people.length - 1], line.text];
    }
    return [null, lines.length ? lines[lines.length - 1].text : ""];
  }
  onOcr(b: Reading) {
    this.tele("board", b);
    const now = this.now(), first = !this.ocrFresh();
    this.ocr.at = now;
    if (b.teams?.length) this.ocr.teams = b.teams.slice(0, 2).map(x => x ?? "");   // clock-only readings keep the teams
    let clock: string | null = [b.period, b.clock].filter(Boolean).join(" ") || null;
    if (this.domain === "cricket" && b.overs) clock = `${b.overs} ov`;
    let changed = false;
    if (clock && clock !== this.state.clock_label) {
      Object.assign(this.state, { clock_label: clock, clock: null, clock_at: now });
      changed = true;
    }
    const sc = b.score;
    if (sc && sc.length === 2 && sc.every(x => Number.isInteger(x) && x >= 0 && x <= 999)) {
      const s: Score = [sc[0], sc[1]], prev = this.state.score;
      if (!prev || prev[0] !== s[0] || prev[1] !== s[1]) {
        changed = true;
        const rules = this.activeRules();
        if (prev && !first && !b.correction && s[0] >= prev[0] && s[1] >= prev[1]) {
          this.jumpAlert(s, prev);
          const said = this.recentPerson()[1];
          this.checkScore(rules.filter(r => r.type !== "score_change"), { text: "" }, s, said || this.scoreText(s) || "");
        } else {   // the first reading, or a new game: no event, just the board
          Object.assign(this.state, { score: s, score_at: now });
          this.ocr.history = [s];
        }
      }
    }
    if (changed) this.publish("state", { score: this.state.score, score_text: this.scoreText(), clock: this.state.clock,
      clock_label: this.state.clock_label, domain: this.domain, board: true });
  }
  scoringRun(history: Score[], side: number): [number, number] | null {
    if (history.length < 2) return null;
    const last = history[history.length - 1];
    let best: [number, number] | null = null;
    for (let i = history.length - 2; i >= 0; i--) {
      const us = last[side] - history[i][side], them = last[1 - side] - history[i][1 - side];
      if (them > 2) break;
      best = [us, them];
    }
    return best && best[0] >= 7 && best[1] <= 2 ? best : null;
  }
  gamePlay(sc: Score, prev: Score, side: number, what: string, who: string | null) {
    const d = sc[side] - prev[side];
    if (who && this.domain !== "cricket") {
      const k = who.split(/\s+/).pop()!, key = k[0].toUpperCase() + k.slice(1).toLowerCase();
      const p = (this.game.players[key] ??= { points: 0, plays: 0 });
      p.points += d; p.plays += 1;
    }
    if (sc[0] === sc[1]) this.game.ties += 1;
    if ((prev[0] - prev[1]) * (sc[0] - sc[1]) < 0) this.game.lead_changes += 1;
    for (const i of [0, 1]) this.game.max_lead[i] = Math.max(this.game.max_lead[i], sc[i] - sc[1 - i]);
    this.game.plays.push({ clock: this.state.clock_label, score: this.scoreText(sc), what: what.replace(/^[!🏈🚨⚽☝️🏏 ]+|[!🏈🚨⚽☝️🏏 ]+$/gu, ""),
      by: who, team: this.ocr.teams[side] || ["home", "away"][side] });
  }
  jumpAlert(sc: Score, prev: Score) {
    const [who, line] = this.recentPerson();
    const side = sc[0] !== prev[0] ? 0 : 1;
    const team = this.ocr.teams[side] || (this.domain === "cricket" ? "" : ["home", "away"][side]);
    let title: string, what: string | undefined;
    if (this.domain === "cricket") {   // (runs, wickets)
      const runs = sc[0] - prev[0], wkts = sc[1] - prev[1];
      what = wkts ? "☝️ Wicket!" : ({ 4: "🏏 FOUR", 6: "🏏 SIX!" } as Record<number, string>)[runs];
      if (!what) return;
      title = `${what} ${team} ${sc[0]}/${sc[1]}`.trim();
    } else {
      const d = sc[side] - prev[side];
      what = JUMPS[this.domain]?.[d] ?? `+${d}`;
      const [a, b] = this.ocr.teams;
      title = `${what}${who ? " " + who : ""} · ${`${a} ${sc[0]} – ${sc[1]} ${b}`.trim()}`;   // the board shows which side moved
      if (sc[0] === sc[1]) title += " · tied!";
      else if ((prev[0] - prev[1]) * (sc[0] - sc[1]) < 0) title += " · lead change!";
    }
    this.gamePlay(sc, prev, side, what, who);
    this.ocr.history.push(sc);
    const run = this.scoringRun(this.ocr.history, side), said = this.ocr.run_said;
    if (!run) delete said[side];
    else if (["nba", "nfl"].includes(this.domain) && run[0] >= (said[side] ?? 0) + (side in said ? 3 : 0)) {
      said[side] = run[0];   // told at 7, then again only as it grows (10, 13...): not on every point
      title += ` · ${team} on a ${run[0]}–${run[1]} run`;
    }
    // (tvwatch.py reused the name `said` for run_said here, so its body was always "from the scoreboard")
    this.fire({ id: `board${this.now()}`, cooldown_s: 0, priority: 5, type: "board" }, title, line ? snippet(line) : "from the scoreboard");
  }

  // ------------------------------------------------------------ what Arc said
  markWatch(_text: string, tags: Tag[]) {
    const names = this.sportNames();
    for (const t of tags) {
      const span = t.text.replace(/^[ .,!?]+|[ .,!?]+$/g, "").toLowerCase();
      t.watch = names.find(([, forms]) => forms.some(f => span === f.toLowerCase() || span.includes(f.toLowerCase())))?.[0] ?? null;
    }
    return tags;
  }
  checkRules(rec: { text: string; tags?: Tag[] }) {
    const text = rec.text;
    if (looping(text)) return;
    const tags = rec.tags ?? [], rules = this.activeRules(), names = this.sportNames();
    const scoreBefore = this.state.score, clockBefore = this.state.clock;
    const mm = this.domain === "soccer" ? parseMatchMinute(text) : null;
    if (mm && mm > 0 && mm <= 130 && !this.ocrFresh()) {
      Object.assign(this.state, { clock: null, clock_label: `${mm}'`, clock_at: this.now() });
      for (const r of rules) if (r.type === "clock_under" && mm >= 85) this.fire(r, `Final minutes: ${mm}'`, snippet(text, "minute"));
    }
    if (SPORTS.has(this.domain) && !this.ocrFresh()) {   // scores (the scoreboard on screen wins while it is readable)
      if (this.domain === "cricket") {   // cricket's score is runs for wickets ("142 for 6"), never "a to b"
        for (const m of text.matchAll(CRICKET_RE())) {
          const [r_, w_] = [m[1], m[2]].map(g => (/^[0-9]+$/.test(g) ? parseInt(g, 10) : wordsToInt(g.toLowerCase().replace(/-/g, " ").split(/\s+/))));
          if (r_ !== null && w_ !== null && w_ <= 10 && r_ <= 600 && !UNIT_AFTER.test(text.slice(m.index! + m[0].length)))
            this.checkScore(rules, { text: m[0] }, [r_, w_], text);
        }
      } else {
        let found: [string, string][] = [...text.matchAll(SCORE_RE())].map(m => [m[0], text.slice(m.index! + m[0].length)]);
        if (!found.length) found = tags.filter(t => t.tag === "NUMBER_SCORE").map(t => [t.text, ""]);   // else Arc's score tag
        for (const [f, after] of found) {
          const sc = parseScore(f);
          if (sc && this.plausibleScore(sc, after)) this.checkScore(rules, { text: f }, sc, text);
        }
      }
    }
    if (["nba", "nfl", "nhl"].includes(this.domain) && !this.ocrFresh()) {   // a game clock: tags, or "... left / to play"
      const spans = tags.filter(t => t.tag === "NUMBER_CLOCK").map(t => t.text);
      for (const m of text.matchAll(CLOCK_RE())) { const parts = m[1].split(/[.,;!?]/); spans.push(parts[parts.length - 1]); }
      for (const span of spans) {
        const c = parseClock(span);
        if (c !== null && c > 0 && c <= 20 * 60) {
          const label = `${Math.floor(c / 60)}:${pad(c % 60)}`;
          Object.assign(this.state, { clock_label: label, clock: c, clock_at: this.now() });
          for (const r of rules) if (r.type === "clock_under" && c <= Number(r.seconds ?? 120)) this.fire(r, `Crunch time: ${label} left`, snippet(text, span.trim()));
          break;
        }
      }
    }
    if (!this.strict) {   // a finished sentence: is the game on? (a watchlist name, a score or a clock: ads rarely say those)
      const sameScore = (x: number[] | null, y: number[] | null) => (!x && !y) || (!!x && !!y && x[0] === y[0] && x[1] === y[1]);
      const game = !sameScore(this.state.score, scoreBefore) || this.state.clock !== clockBefore || tags.some(t => t.watch)
        || names.some(([, fs]) => fs.some(f => this.fuzzy(text, f)));
      const now = this.now();
      if (game) {
        const gap = now - (this.state.last_game ?? now);
        for (const r of rules) if (r.type === "game_back" && gap >= Number(r.after_s ?? 90)) this.fire(r, r.title || "▶️ The game is back on", snippet(text));
        this.state.last_game = now;
      }
    }
    for (const r of rules) {
      if (r.type === "name") {   // a watchlist name (its aliases too), or any name typed in the rule
        const want = String(r.name ?? "").trim().toLowerCase();
        let cands = names.filter(([, f]) => f.map(x => x.toLowerCase()).includes(want));
        if (!cands.length) cands = this.loadNames(this.rosterText()).filter(([c, f]) => [c, ...f].map(x => x.toLowerCase()).includes(want));
        if (!cands.length) cands = [[r.name ?? "", [r.name ?? ""]]];
        for (const [canon, forms] of cands) {
          if (want && forms.some(f => f && this.fuzzy(text, f))) {
            this.fire(r, `${canon} is on TV`, snippet(text, forms.find(f => hasPhrase(text, f)) ?? ""));
            break;
          }
        }
      } else if (r.type === "keyword") {
        const hit = (r.words ?? []).filter((k: string) => this.fuzzy(text, k));
        if (hit.length) this.fire(r, r.title || `Heard: ${hit.join(", ")}`, snippet(text, hit[0]));
      } else if (r.type === "entity") {   // any person / team / place Arc tags
        const hit = tags.filter(t => t.tag === (r.tag ?? "ENTITY_PERSON")).map(t => t.text.replace(/^[ .,]+|[ .,]+$/g, ""));
        if (hit.length) this.fire(r, `${r.label ?? "Mentioned"}: ${hit.join(", ")}`, text);
      }
    }
  }
  /** alerts before the sentence ends: a hit the last partial of this sentence also had is stable, and fires now */
  earlyAlerts(rec: ArcRec, text: string, tags: Tag[]) {
    const saved = [this.state.score, this.state.clock, this.state.clock_label, this.memory.scores.length] as const;
    this.collect = []; this.strict = true;
    let hits: [Rule, string, string][];
    try {
      this.checkRules({ text, tags });
      hits = this.collect;
    } finally {
      this.collect = null; this.strict = false;
      [this.state.score, this.state.clock, this.state.clock_label] = [saved[0], saved[1], saved[2]];
      this.memory.scores.length = saved[3];
    }
    if (this.early.id !== rec.id) this.early = { id: rec.id ?? null, hits: new Set() };
    const keys = new Set(hits.map(([r, title]) => `${r.id}\u0001${title}`));
    for (const [r, title, body] of hits) if (this.early.hits.has(`${r.id}\u0001${title}`)) this.fire(r, title, body, true);
    this.early.hits = keys;
  }
  stitch(rec: ArcRec): [string, Tag[]] {
    const words = cleanWindow((rec.text ?? "").split(" "));
    const st = this.stitchState;
    if (st.id !== rec.id) Object.assign(st, { id: rec.id, words: [], tags: [] });
    const old = st.words, on = old.map(norm), wn = words.map(norm);
    const sim = (a: string, b: string) => (a === b ? 1 : ratio(a, b));   // "curi" ~ "curry"
    let best = 0, cut: number | null = null, skip = 0;
    for (const sk of [0, 1, 2]) {
      for (let i = Math.max(0, old.length - words.length - 8); i < old.length; i++) {
        const n = Math.min(old.length - i, wn.length - sk, 5);   // anchor on the window's first words
        if (n <= 0) continue;
        let s = 0;
        for (let j = 0; j < n; j++) s += sim(on[i + j], wn[sk + j]);
        const r = (s / n) * Math.min(1, n / 3) - 0.05 * sk;
        if (r >= best - 1e-9 && r >= 0.6) { best = r; cut = i; skip = sk; }   // ties: the latest place
      }
    }
    if (cut === null) {
      if (old.length && words.length < old.length) return [old.join(" "), st.tags];   // a garbled window keeps the line
      cut = old.length ? old.length : 0;
    }
    const neu = undouble([...old.slice(0, cut), ...words.slice(skip)]);
    if (neu.length < old.length - 2) return [old.join(" "), st.tags];   // the line never shrinks by more than a word or two
    const c = cut;
    const tags = st.tags.filter(t => (t.we ?? 0) <= c);
    for (const t of rec.tags ?? []) if (t.wb !== undefined && t.wb >= skip && (t.we ?? 0) <= words.length) tags.push({ ...t, wb: t.wb - skip + c, we: t.we! - skip + c });
    Object.assign(st, { words: neu, tags });
    return [neu.join(" "), tags];
  }
  remember(line: Line) {
    const now = this.now();
    this.memory.lines.push([now, { ...line, domain: this.domain }]);
    for (const k of ["lines", "scores", "alerts"] as const) {
      const arr = this.memory[k] as [number, ...any[]][];
      while (arr.length && arr[0][0] < now - this.memoryMin * 60) arr.shift();
    }
    if (now - this.memory.ctx_written >= 20) {   // every 20 s, the names heard most go to Arc's decoder
      this.memory.ctx_written = now;
      const names: [string, string][] = [];
      for (const l of this.arcNames().split("\n")) {
        const bits = l.trim().split("|");
        if (bits[0] && !bits[0].startsWith("#")) names.push([bits[0].trim(), bits.length > 1 ? bits[1].trim() : ""]);
      }
      const seen = new Set(names.map(([c]) => c.toLowerCase()));
      for (const [name, kind] of this.topMentions(16)) if (!seen.has(name.toLowerCase())) { names.push([name, kind]); seen.add(name.toLowerCase()); }
      this.context = names.slice(0, 24).map(([n, k]) => `${n}|${k}\n`).join("");
      this.arc?.setContext?.(this.context);
    }
  }
  topMentions(k = 8): [string, string, number][] {
    const counts = new Map<string, number>(), kinds = new Map<string, string>(), shown = new Map<string, string>();
    for (const [, l] of this.memory.lines) {
      if ((l.domain ?? this.domain) !== this.domain) continue;
      for (const t of l.tags ?? []) {
        if (!(t.tag in KIND)) continue;
        const name = t.watch || t.text.replace(/^[ .,!?'"]+|[ .,!?'"]+$/g, "");
        if (name.length < 3) continue;
        const key = name.toLowerCase();
        counts.set(key, (counts.get(key) ?? 0) + 1);
        kinds.set(key, KIND[t.tag]);
        if (!shown.has(key)) shown.set(key, name);
      }
    }
    return [...counts.keys()].sort((a, b) => counts.get(b)! - counts.get(a)!).slice(0, k).map(x => [shown.get(x)!, kinds.get(x)!, counts.get(x)!]);
  }

  // ------------------------------------------------------------ Arc's own heads, frame by frame
  speechLevel() { return this.speech.length ? this.speech.reduce((a, b) => a + b, 0) / this.speech.length : 1; }
  labelThr(r: Rule, label: string) {
    const t = r.thr ?? 0.5;
    return typeof t === "object" ? (t[this.domain] ?? t[label] ?? t.default ?? 0.5) : t;
  }
  arcFrame(rec: ArcRec) {
    this.speech.push(rec.sp ?? 1);
    if (this.speech.length > 15) this.speech.shift();
    const p: Record<string, number> = rec.p ?? {};
    this.director?.features.frame(p, rec.sp ?? 0);
    const watched = new Map<string, Rule>();
    for (const r of this.activeRules()) if (r.type === "arc_label") for (const l of r.labels ?? []) watched.set(l, r);
    for (const [label, v] of Object.entries(p)) {
      const r = watched.get(label), thr = r ? this.labelThr(r, label) : 0.6;
      const st = this.labelOn.get(label) ?? [0, false];
      this.labelOn.set(label, st);
      if (v >= thr) st[0]++;
      else { st[0] = 0; if (st[1] && v < thr * 0.6) st[1] = false; }
      if (st[0] >= (r?.hold ?? 3) && !st[1]) {
        st[1] = true;
        this.tele("label", { label, p: Math.round(v * 1000) / 1000, text: this.state.partial.slice(-120) });
        this.publish("event", { time: this.hms(), label, p: v });
        if (r) this.fire(r, r.title || label.split(".").slice(-2)[0], this.state.partial.slice(-140) || (this.state.lines[0]?.text ?? ""));
      }
    }
    for (const [label, st] of this.labelOn) if (!(label in p)) { st[0] = 0; st[1] = false; }   // dropped under the floor: off
  }

  // ------------------------------------------------------------ one record from Arc
  handle(rec: ArcRec) {
    if ("text" in rec) rec.text = clean(rec.text ?? "", SPORTS.has(this.domain));
    if (rec.k !== "partial") this.tele("arc", rec);
    if (rec.k === "partial" || rec.k === "final") rec.tags = this.markWatch(rec.text ?? "", rec.tags ?? []);
    if (rec.k === "partial") {
      let [text, tags] = this.stitch(rec);
      text = clean(text, SPORTS.has(this.domain));
      if (looping(text) || this.speechLevel() < 0.45) return;   // crowd noise: Arc's guesses don't reach the screen
      this.state.partial = text;
      this.publish("partial", { id: rec.id, text, tags });
      this.director?.features.line(text, tags, false);
      if (!this.noEarly) this.earlyAlerts(rec, text, tags.map(t => ({ ...t })));
    } else if (rec.k === "final") {
      this.state.partial = "";
      const line: Line = { id: rec.id, time: this.hms(), text: rec.text ?? "", tags: rec.tags ?? [] };
      this.state.lines.unshift(line);
      if (this.state.lines.length > 60) this.state.lines.length = 60;
      this.remember(line);
      this.publish("final", line);
      this.director?.features.line(line.text, line.tags, true);
      void this.tagLine(line.text);
      this.checkRules({ text: line.text, tags: line.tags });
      this.publish("state", { text: line.text, score: this.state.score, score_text: this.scoreText(), clock: this.state.clock,
        clock_label: this.state.clock_label, domain: this.domain });
    } else if (rec.k === "frame") {
      this.arcFrame(rec);
    } else if (rec.k === "event") {
      this.publish("event", { time: this.hms(), label: rec.label, p: rec.p });
      for (const r of this.activeRules())   // a crowd reaction often comes before the commentator names the moment
        if (r.type === "sound" && (r.labels ?? []).includes(rec.label) && rec.p >= (r.min_p ?? 0.9)) this.crowd(r);
    }
  }
  /** Arc Tagger's read of a finished sentence: logged, and fed to the director (not alerted on: uncalibrated) */
  private async tagLine(text: string) {
    if (!this.tagger) return;
    const out = await this.tagger.tag(text, SPORTS.has(this.domain) ? this.domain : this.domain).catch(() => null);
    if (!out) return;
    const events: Record<string, number> = {};
    for (const e of out.events ?? []) { const k = e.tag ?? e.type; events[k] = Math.max(events[k] ?? 0, e.p ?? e.score ?? 0); }
    const spans = (out.spans ?? []) as { type: string; text: string; score: number }[];
    this.director?.features.tagger(events, spans.filter(s => s.type === "entity.number.score").length,
      spans.filter(s => s.type === "entity.mention.person").length);
    this.tele("tagger", { text, events: Object.entries(events).map(([tag, p]) => ({ tag, p })),
      spans: spans.filter(x => /^entity\.(number\.score|number\.clock|mention)/.test(x.type)).map(x => ({ type: x.type, text: x.text, p: x.score })),
      utt: (out.utterances ?? []).map((u: any) => ({ intent: u.intent, state: u.state })) });
  }
  /** the director's second: with no scoreboard readable, a likely score is called as heard, not confirmed */
  directorTick() {
    const d = this.director;
    if (!d) return;
    const { row, tokens } = d.features.take(this.domain);
    const thr = DIRECTOR_SPORTS[this.domain];
    if (thr === undefined) return;
    const c = d.model.step(row, tokens, this.domain), now = this.now();
    this.tele("director", { p: Math.round(c.p * 1000) / 1000, kind: c.kind, side: c.side });
    if (this.ocrFresh() || c.p < thr || now - this.lastDirector < 10) return;
    this.lastDirector = now;
    const [who, line] = this.recentPerson(10);
    const what = c.kind === "one_point" ? "free throw" : c.kind === "big_score" ? "three" : "basket";
    this.fire({ id: `director${now}`, cooldown_s: 0, priority: 4, type: "director" },
      `🏀 Sounds like a ${what}${who ? " · " + who : ""} (heard)`, line ? snippet(line) : "heard by Arc, not confirmed by the scoreboard");
  }

  // ------------------------------------------------------------ sessions and the game's knobs
  resetGame() {
    this.state.lines = []; this.state.alerts = [];
    this.memory.lines = []; this.memory.scores = []; this.memory.alerts = []; this.memory.ctx_written = 0;
    Object.assign(this.state, { partial: "", score: null, clock: null, clock_label: null, score_at: 0, clock_at: 0 });
    Object.assign(this.ocr, { at: 0, teams: ["", ""], history: [], run_said: {} });
    Object.assign(this.game, { players: {}, ties: 0, lead_changes: 0, max_lead: [0, 0], plays: [] });
    this.lastFired.clear(); this.earlySent.clear(); this.labelOn.clear();
    Object.assign(this.lastBig, { alert: null, t: 0, boosted: false });
    Object.assign(this.stitchState, { id: null, words: [], tags: [] });
    this.speech = [];
    this.context = "";
    this.director?.model.reset();
    this.session = { id: this.session.id + 1, started: this.now() };
    this.tele("reset", { session: this.session.id });
    this.startArc();   // a fresh Arc: no decoder context or names from the last game
    this.publish("state", { text: "", score: null, score_text: "", clock: null, clock_label: null, domain: this.domain });
  }
  setSport(domain: string) {
    if (!(domain in SPORT_NAMES) || domain === this.domain) return;
    this.domain = domain;
    this.store.set("tvw.domain", domain);
    this.state.score = null; this.state.clock = null; this.state.clock_label = null;
    this.startArc();
    this.publish("state", { text: "", score: null, clock: null, clock_label: null, domain });
  }
  setRoster(domain: string, names: string) {
    if (!(domain in SPORT_NAMES)) return false;
    this.store.set(`tvw.roster.${domain}`, String(names ?? "").trim() + "\n");
    if (domain === this.domain) this.startArc();   // Arc picks the new names up now
    return true;
  }

  // ------------------------------------------------------------ what the page asks for
  hello() {
    return { sports: SPORT_NAMES, text: this.state.lines[0]?.text ?? "", score: this.state.score, score_text: this.scoreText(),
      clock: this.state.clock, clock_label: this.state.clock_label, status: this.state.status, domain: this.domain, session: this.session.id,
      lines: this.state.lines.slice(0, 12).reverse(), alerts: this.state.alerts.slice(0, 10).reverse() };
  }
  stateJson() {
    return { lines: this.state.lines, partial: this.state.partial, alerts: this.state.alerts, score: this.state.score,
      score_text: this.scoreText(), clock: this.state.clock, clock_label: this.state.clock_label, level: this.state.level,
      session: this.session.id, board: this.ocrFresh(), board_age_s: this.ocr.at ? Math.round((this.now() - this.ocr.at) * 10) / 10 : null,
      teams: this.ocrFresh() ? this.ocr.teams : null, status: this.state.status, domain: this.domain, ntfy: null, dry_run: true,
      rules: this.loadRules(), active: this.activeRules().map(r => r.id), sports: SPORT_NAMES,
      names: [...this.sportNames().map(([n]) => n), ...this.loadNames(this.rosterText()).map(([n]) => n)] };
  }
  facts() {
    const [a, b] = this.ocrFresh() ? this.ocr.teams : ["", ""];
    return { sport: SPORT_NAMES[this.domain] ?? this.domain, teams: [a, b], score: this.scoreText(), clock: this.state.clock_label,
      score_source: this.ocrFresh() ? "the broadcast's scoreboard" : "the commentary",
      scoring_plays: this.game.plays.slice(-25),
      points_by_player_heard: Object.fromEntries(Object.entries(this.game.players).sort((x, y) => y[1].points - x[1].points)),
      note: "points_by_player credits each scoreboard change to the player named in the commentary just before it: a guess",
      ties: this.game.ties, lead_changes: this.game.lead_changes,
      biggest_lead: { [a || "home"]: this.game.max_lead[0], [b || "away"]: this.game.max_lead[1] },
      most_talked_about: this.topMentions(8).map(([name, , c]) => ({ name, mentions: c })),
      recent_commentary: this.state.lines.slice(0, 10).reverse().map(l => l.text).join(" ").slice(-2500),
      watching: this.activeRules().filter(r => r.type === "name").map(r => r.name) };
  }
  catchup() {
    const lines = this.memory.lines, span = lines.length ? (this.now() - lines[0][0]) / 60 : 0;
    const hm = (t: number) => this.hms(t).slice(0, 5);
    return { minutes: Math.round(span * 10) / 10, window: this.memoryMin, domain: this.domain, sentences: lines.length,
      words: lines.reduce((n, [, l]) => n + l.text.split(/\s+/).filter(Boolean).length, 0),
      score: this.state.score, score_text: this.scoreText(), clock: this.state.clock_label,
      scores: this.memory.scores.slice(-12).map(([t, score, said]) => ({ time: hm(t), score, said })),
      moments: this.memory.alerts.slice(-15).map(([, a]) => ({ ...a, time: a.time.slice(0, 5) })).reverse(),
      top: this.topMentions(10).map(([name, kind, count]) => ({ name, kind, count })),
      recap: null };   // the page writes the recap with Little's own model (app.compose)
  }
  addRule(body: Rule) {
    body.id = body.id || `r${Math.floor(this.now() * 1000)}`;
    this.saveRules([...this.loadRules().filter(r => r.id !== body.id), body]);   // same id: replace
  }
  deleteRule(id: string) { this.saveRules(this.loadRules().filter(r => r.id !== id)); }
}
