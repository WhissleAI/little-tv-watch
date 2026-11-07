// The director: a tiny causal GRU that calls scoring events (a basket, a goal, a touchdown, a three) from what Arc
// hears, with no scoreboard needed. It was taught by the scoreboard: on broadcast clips, every change the app's board
// OCR confirms (board.ts rules) is a labelled event, and the model learns to fire from Arc's own streams in the band
// around it. That makes mic-only mode (no picture) call events, and lets the board and the audio agree when both exist.
//
// Input, once a second, built by Features below exactly as the training script (director/feats.py) built it:
//   arc:<label>   max over the second of each Arc frame head probability (arc_tv --frames; ARC_FRAMES_ALL x: heads too)
//   arc:speech    mean speech probability of those frames
//   txt:*         from Arc finals EMITTED in this second: log1p(words, person tags, NUMBER_SCORE, NUMBER*, NUMBER_CLOCK)
//   kw:<word>     1 if that commentary word is in a final emitted this second
//   tag:<event>   Arc Tagger (arc-tagger-c, /tag, domain "sports") event.sports.* max probability on those finals,
//                 plus log1p(score spans) and log1p(person spans)
//   sport:<s>     one-hot nba / nfl / nhl / soccer / cricket
// Output: p = P(a scoring event's board change lands within (now-5 s, now+4 s]) and the kind (one point / a score /
// a big score: a three or a field goal). fire = p over the trained threshold, at most once every 10 s.
// Weights and the feature list: public/director/director.json (eval numbers in director/README.md).

export type DirectorFile = {
  sports_validated: string[]; frame_floor: number; x_heads: boolean;
  arc_head: { label: string; on: number; hold: number; rearm: number };
  names: string[]; mu: number[]; sd: number[]; hidden: number; threshold: number; kinds: string[]; params: number;
  weights: Record<string, number[] | number[][]>;
};
export type Call = { p: number; kind: string; kinds: Record<string, number>; fire: boolean };

const sig = (x: number) => 1 / (1 + Math.exp(-x));

function matvec(W: number[][], x: ArrayLike<number>, b?: number[]) {
  const out = new Float64Array(W.length);
  for (let i = 0; i < W.length; i++) {
    let s = b ? b[i] : 0;
    const w = W[i];
    for (let j = 0; j < w.length; j++) s += w[j] * x[j];
    out[i] = s;
  }
  return out;
}

export class Director {
  private h: Float64Array;
  private last = -1e9;
  private t = 0;
  constructor(readonly m: DirectorFile) {
    this.h = new Float64Array(m.hidden);
  }

  static async load(url = "director/director.json") {
    return new Director(await (await fetch(url)).json());
  }

  reset() {
    this.h.fill(0);
    this.last = -1e9;
    this.t = 0;
  }

  // One second of features (Features.take()) -> the call for that second.
  step(x: Float32Array): Call {
    const { m } = this, H = m.hidden, w = m.weights as Record<string, number[][]> & Record<string, number[]>;
    const xn = Array.from(x, (v, i) => (v - m.mu[i]) / m.sd[i]);
    const u = matvec(w["inp.weight"], xn, w["inp.bias"] as unknown as number[]).map(v => Math.max(0, v));
    const gi = matvec(w["gru.weight_ih_l0"], u, w["gru.bias_ih_l0"] as unknown as number[]);
    const gh = matvec(w["gru.weight_hh_l0"], this.h, w["gru.bias_hh_l0"] as unknown as number[]);
    const h = new Float64Array(H);
    for (let i = 0; i < H; i++) {   // PyTorch's GRU: gates r, z, n
      const r = sig(gi[i] + gh[i]), z = sig(gi[H + i] + gh[H + i]);
      const n = Math.tanh(gi[2 * H + i] + r * gh[2 * H + i]);
      h[i] = (1 - z) * n + z * this.h[i];
    }
    this.h = h;
    const p = sig(matvec(w["ev.weight"], h, w["ev.bias"] as unknown as number[])[0]);
    const k = matvec(w["kind.weight"], h, w["kind.bias"] as unknown as number[]);
    const mx = Math.max(...k), e = Array.from(k, v => Math.exp(v - mx)), z = e.reduce((a, b) => a + b, 0);
    const kinds = Object.fromEntries(m.kinds.map((name, i) => [name, e[i] / z]));
    const kind = m.kinds[e.indexOf(Math.max(...e))];
    const fire = p >= m.threshold && this.t - this.last >= 10;
    if (fire) this.last = this.t;
    this.t++;
    return { p, kind, kinds, fire };
  }
}

// Arc's own shipped "a score just happened" head, the precise half of the call: on at p >= 0.5 held for 3 frames
// (0.3 s), re-armed once it drops below 0.3. Feed it every Arc frame record; it says when it fires.
export class ArcHead {
  private run = 0;
  private armed = true;
  constructor(readonly cfg: DirectorFile["arc_head"]) {}
  frame(p: Record<string, number>) {
    const v = p[this.cfg.label] ?? 0;   // under the app's frame floor (0.2) counts as 0
    this.run = v >= this.cfg.on ? this.run + 1 : 0;
    if (v < this.cfg.rearm) this.armed = true;
    if (this.armed && this.run >= this.cfg.hold) { this.armed = false; return true; }
    return false;
  }
}

// The call the app should make: Arc's head OR the director, at most one every 10 s (wall seconds you pass in).
// Leave-one-clip-out on 9 broadcast clips (80 board-labelled events, director/README.md): the union gets precision
// 0.53, recall 0.51, 0.31 false alarms a minute, against Arc's head alone at 0.77 / 0.29 / 0.06. On NBA (58 events)
// the union is 0.63 / 0.57 against 0.78 / 0.31; NHL, NFL, soccer and cricket have too few events to learn yet, so
// use the director only where sports_validated says (nba) and Arc's head alone elsewhere.
export class ScoreCaller {
  private last = -1e9;
  constructor(readonly m: DirectorFile) {}
  call(t: number, sport: string, headFired: boolean, director?: Call) {
    const dir = !!director?.fire && this.m.sports_validated.includes(sport);
    if (!(headFired || dir) || t - this.last < 10) return null;
    this.last = t;
    return { by: headFired && dir ? "both" : headFired ? "arc_head" : "director", kind: director?.kind ?? "score", p: director?.p ?? 1 };
  }
}

const KW = ["score", "scores", "good", "bucket", "dunk", "layup", "jumper", "three", "free throw", "and one", "goal", "net",
  "touchdown", "field goal", "extra point", "end zone", "six", "four", "boundary", "wicket", "out", "lead", "tie", "ties"];
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const KW_RE = KW.map(k => new RegExp(`\\b${esc(k)}\\b`));

// Collects one second of Arc and tagger output into the director's input vector.
export class Features {
  private ix: Map<string, number>;
  private x: Float32Array;
  private sp = 0;
  private n = 0;
  // floor: the model's frame_floor; heads under it count as 0 and a frame with none over it is skipped, as arc_tv
  // --frames <floor> would (feats.py does the same), so any Arc setting gives the features the model was trained on
  constructor(readonly names: string[], readonly floor = 0.2) {
    this.ix = new Map(names.map((n, i) => [n, i]));
    this.x = new Float32Array(names.length);
  }
  private max(name: string, v: number) {
    const i = this.ix.get(name);
    if (i != null && v > this.x[i]) this.x[i] = v;
  }
  private add(name: string, v: number) {
    const i = this.ix.get(name);
    if (i != null) this.x[i] += v;
  }
  // An Arc frame record: {k: "frame", sp, p: {label: prob}}
  frame(p: Record<string, number>, sp = 0) {
    const kept = Object.entries(p).filter(([k, v]) => v >= this.floor && this.ix.has(`arc:${k}`));
    if (!kept.length) return;
    for (const [k, v] of kept) this.max(`arc:${k}`, v);
    this.sp += sp;
    this.n++;
  }
  // An Arc final: its text and inline tags ({tag: "ENTITY_PERSON" | "NUMBER_SCORE" | ...})
  final(text: string, tags: { tag: string }[] = []) {
    const t = text.toLowerCase();
    this.add("txt:words", t.split(/\s+/).filter(Boolean).length);
    for (const g of tags) {
      const k = ({ ENTITY_PERSON: "txt:person", NUMBER_SCORE: "txt:score_tag", NUMBER_CLOCK: "txt:clock_tag" } as Record<string, string>)[g.tag];
      if (k) this.add(k, 1);
      if (g.tag.startsWith("NUMBER")) this.add("txt:number", 1);
    }
    KW.forEach((k, i) => { if (KW_RE[i].test(t)) this.max(`kw:${k}`, 1); });
  }
  // Arc Tagger's answer for that final: events [{type, score}], spans [{type}]
  tagger(events: { type?: string; tag?: string; score?: number; p?: number }[], spans: { type: string }[] = []) {
    for (const e of events) {
      const k = e.type ?? e.tag ?? "";
      if (k.startsWith("event.sports")) this.max(`tag:${k}`, e.score ?? e.p ?? 0);
    }
    this.add("tag:score_span", spans.filter(s => s.type === "entity.number.score").length);
    this.add("tag:person", spans.filter(s => s.type === "entity.mention.person").length);
  }
  // The second is over: its vector (counts log1p'd, speech averaged, the sport set), and start the next one.
  take(sport: string) {
    const x = this.x;
    for (const k of ["txt:words", "txt:person", "txt:score_tag", "txt:number", "txt:clock_tag", "tag:score_span", "tag:person"]) {
      const i = this.ix.get(k);
      if (i != null) x[i] = Math.log1p(x[i]);
    }
    const s = this.ix.get("arc:speech");
    if (s != null) x[s] = this.sp / Math.max(1, this.n);
    const sp = this.ix.get(`sport:${sport}`);
    if (sp != null) x[sp] = 1;
    this.x = new Float32Array(this.names.length);
    this.sp = this.n = 0;
    return x;
  }
}
