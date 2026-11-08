// The TV Watch director, v2: the same model family as Steer's Director3 and Arc Tagger. One small streaming Mamba-3
// over Arc's streams, stepping once a second with constant memory (the state is carried across ticks), several heads
// read out every step: a scoring event now (per sport), its kind (one point / score / big score) and which side.
// With no picture (mic mode) the director still calls baskets and goals from what Arc hears. Plain TypeScript, no
// dependencies.
//
// Input each second (built by Features3):
//   arc:<head>  max over the second of each Arc frame head, kept when >= frame_floor (arc_tv --frames)
//   arc:speech  mean speech probability of those frames
//   txt:*       the newest Arc line this second (partial or final): log1p(words, persons, score tags, numbers, clock
//               tags), and 1 if it was a final
//   tag:*       Arc Tagger on finals: event.sports.* max p, log1p(score spans), log1p(person spans)
//   tokens      the newest line's last 8 words as unigrams + bigrams, FNV-1a("p:"|"f:" + token) % V
// Weights, feature names and per-sport thresholds: public/director/director3.json.

type Mat = number[][];
type Vec = number[];
export type Director3File = {
  d: number; layers: number; emb: number; d_state: number; head_dim: number; V: number; last_words: number;
  names: string[]; blocks: Record<string, number[]>; sports: string[]; frame_floor: number; x_heads: boolean;
  mu: number[]; sd: number[]; thresholds: Record<string, number>; kinds: string[]; params: number;
  weights: Record<string, any>;
};
export type Call3 = { p: number; fire: boolean; kind: string; kinds: Record<string, number>; side: number };

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
const softplus = (x: number) => (x > 20 ? x : Math.log1p(Math.exp(x)));
const silu = (x: number) => x * sigmoid(x);
function erf(x: number) {   // Abramowitz-Stegun 7.1.26 refined (|err| < 1.2e-7)
  const s = Math.sign(x), a = Math.abs(x), t = 1 / (1 + 0.5 * a);
  const y = 1 - t * Math.exp(-a * a - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 +
    t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return s * y;
}
const gelu = (x: number) => 0.5 * x * (1 + erf(x / Math.SQRT2));

function lin(W: Mat, b: Vec | undefined, x: ArrayLike<number>) {
  const o = new Float64Array(W.length);
  for (let i = 0; i < W.length; i++) {
    const w = W[i];
    let s = b ? b[i] : 0;
    for (let j = 0; j < w.length; j++) s += w[j] * x[j];
    o[i] = s;
  }
  return o;
}
function rms(x: ArrayLike<number>, w: Vec, eps = 1.1920928955078125e-7) {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  const r = 1 / Math.sqrt(s / x.length + eps), o = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) o[i] = x[i] * r * w[i];
  return o;
}
function layerNorm(x: ArrayLike<number>, w: Vec, b: Vec, eps = 1e-5) {
  let m = 0, v = 0;
  for (let i = 0; i < x.length; i++) m += x[i];
  m /= x.length;
  for (let i = 0; i < x.length; i++) v += (x[i] - m) ** 2;
  const r = 1 / Math.sqrt(v / x.length + eps), o = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) o[i] = (x[i] - m) * r * w[i] + b[i];
  return o;
}

// One Mamba-3 layer (rank 1), recurrent step: h_t = R_t(alpha h_{t-1} + beta B_{t-1}x_{t-1}^T) + gamma B_t x_t^T.
class Mamba3Step {
  H: number; N: number; P: number;
  h: Float64Array; bx: Float64Array | null = null;
  constructor(private w: Record<string, any>, private pre: string, d: number, N: number, P: number) {
    this.H = d / P; this.N = N; this.P = P;
    this.h = new Float64Array(this.H * N * P);
  }
  reset() { this.h.fill(0); this.bx = null; }
  step(u: Float64Array) {
    const g = (k: string) => this.w[this.pre + k];
    const { H, N, P } = this;
    const nu = rms(u, g("norm.weight"));
    const dtr = lin(g("dt_proj.weight"), g("dt_proj.bias"), nu);
    const lamr = lin(g("lam_proj.weight"), g("lam_proj.bias"), nu);
    const Bp = lin(g("B_proj.weight"), g("B_proj.bias"), nu), Cp = lin(g("C_proj.weight"), g("C_proj.bias"), nu);
    const xp = lin(g("x_proj.weight"), g("x_proj.bias"), nu);
    const th = lin(g("theta_proj.weight"), g("theta_proj.bias"), nu);
    const Alog: Vec = g("A_log"), Bb: number[][][] = g("B_bias"), Cb: number[][][] = g("C_bias");
    const bnw: Vec = g("B_norm.weight"), cnw: Vec = g("C_norm.weight");
    const bx = new Float64Array(H * N * P), y = new Float64Array(H * P);
    for (let hh = 0; hh < H; hh++) {
      const dt = softplus(dtr[hh]), alpha = Math.exp(dt * -Math.exp(Alog[hh]));
      const lam = sigmoid(lamr[hh]), gamma = lam * dt, beta = (1 - lam) * dt * alpha;
      const Bn = rms(Bp.subarray(hh * N, hh * N + N), bnw), Cn = rms(Cp.subarray(hh * N, hh * N + N), cnw);
      for (let n = 0; n < N; n++) { Bn[n] += Bb[hh][n][0]; Cn[n] += Cb[hh][n][0]; }
      const base = hh * N * P;
      // pre = alpha h + beta prev_bx, then rotate (n even, n odd) pairs by theta * dt
      for (let n = 0; n < N; n += 2) {
        const ang = th[hh * (N / 2) + n / 2] * dt, c = Math.cos(ang), s = Math.sin(ang);
        for (let p = 0; p < P; p++) {
          const i0 = base + n * P + p, i1 = base + (n + 1) * P + p;
          let a = alpha * this.h[i0], b = alpha * this.h[i1];
          if (this.bx) { a += beta * this.bx[i0]; b += beta * this.bx[i1]; }
          this.h[i0] = c * a - s * b; this.h[i1] = s * a + c * b;
        }
      }
      for (let n = 0; n < N; n++)
        for (let p = 0; p < P; p++) {
          const i = base + n * P + p, v = Bn[n] * xp[hh * P + p];
          bx[i] = v; this.h[i] += gamma * v;
        }
      for (let p = 0; p < P; p++) {
        let s = 0;
        for (let n = 0; n < N; n++) s += Cn[n] * this.h[base + n * P + p];
        y[hh * P + p] = s;
      }
    }
    this.bx = bx;
    const gate = lin(g("in_proj.weight"), g("in_proj.bias"), nu);
    for (let i = 0; i < y.length; i++) y[i] *= silu(gate[i]);
    return lin(g("out_proj.weight"), g("out_proj.bias"), y);
  }
}

function fnv(s: string) {
  let h = 0x811c9dc5;
  for (const b of new TextEncoder().encode(s)) h = Math.imul(h ^ b, 0x01000193) >>> 0;
  return h;
}

export class Director3 {
  private layers: Mamba3Step[];
  private last = -1e9;
  private t = 0;
  constructor(readonly m: Director3File) {
    this.layers = Array.from({ length: m.layers }, (_, i) => new Mamba3Step(m.weights, `blocks.${i}.`, m.d, m.d_state, m.head_dim));
  }
  static async load(url = "director/director3.json") { return new Director3(await (await fetch(url)).json()); }
  reset() { this.layers.forEach(l => l.reset()); this.last = -1e9; this.t = 0; }

  // One second: the raw feature row (Features3.take()), the token ids, the sport -> this second's call.
  step(row: ArrayLike<number>, tokens: number[], sport: string): Call3 {
    const { m } = this, W = m.weights, d = m.d;
    const si = Math.max(0, m.sports.indexOf(sport));
    const x = Float64Array.from(row, (v, i) => (v - m.mu[i]) / m.sd[i]);
    const u = new Float64Array(d);
    for (const [k, ix] of Object.entries(m.blocks)) {
      const o = lin(W[`xin.${k}.weight`], W[`xin.${k}.bias`], ix.map(i => x[i]));
      for (let i = 0; i < d; i++) u[i] += o[i];
    }
    if (tokens.length) {
      const e = new Float64Array(m.emb);
      for (const t of tokens) { const r = W["emb.weight"][t]; for (let j = 0; j < m.emb; j++) e[j] += r[j] / tokens.length; }
      const o = lin(W["tok.weight"], W["tok.bias"], e);
      for (let i = 0; i < d; i++) u[i] += o[i];
    } else {
      for (let i = 0; i < d; i++) u[i] += W["tok.bias"][i];
    }
    const film: Vec = W["film.weight"][si];
    let v = Float64Array.from(u, (a, i) => a * (1 + film[i]) + film[d + i]);
    this.layers.forEach((L, i) => {
      const o = L.step(v);
      v = Float64Array.from(v, (a, j) => a + o[j]);
      const pre = `mlps.${i}.`;
      const hdn = lin(W[pre + "1.weight"], W[pre + "1.bias"], layerNorm(v, W[pre + "0.weight"], W[pre + "0.bias"])).map(gelu);
      const o2 = lin(W[pre + "3.weight"], W[pre + "3.bias"], hdn);
      v = Float64Array.from(v, (a, j) => a + o2[j]);
    });
    const z = layerNorm(v, W["norm.weight"], W["norm.bias"]);
    const p = sigmoid(lin([W["ev.weight"][si]], [W["ev.bias"][si]], z)[0]);
    const kl = lin(W["kind.weight"], W["kind.bias"], z), mx = Math.max(...kl);
    const ex = Array.from(kl, a => Math.exp(a - mx)), sum = ex.reduce((a, b) => a + b, 0);
    const kinds = Object.fromEntries(m.kinds.map((k, i) => [k, ex[i] / sum]));
    const sd = lin(W["side.weight"], W["side.bias"], z);
    const thr = m.thresholds[sport] ?? 0.9;
    const fire = p >= thr && this.t - this.last >= 10;
    if (fire) this.last = this.t;
    this.t++;
    return { p, fire, kind: m.kinds[kl.indexOf(mx)], kinds, side: sd[0] >= sd[1] ? 0 : 1 };
  }
}

// Builds one second of inputs from the app's live streams.
const WORD = /[a-z0-9']+/g;
export class Features3 {
  private ix: Map<string, number>;
  private row: Float64Array;
  private sp = 0; private n = 0;
  private toks: number[] = [];
  constructor(private m: Director3File) {
    this.ix = new Map(m.names.map((k, i) => [k, i]));
    this.row = new Float64Array(m.names.length);
  }
  // an Arc frame record {p: {head: prob}, sp}
  frame(p: Record<string, number>, sp = 0) {
    const keep = Object.entries(p).filter(([k, v]) => v >= this.m.frame_floor && (this.m.x_heads || !k.startsWith("x:")));
    if (!keep.length) return;
    for (const [k, v] of keep) { const j = this.ix.get(`arc:${k}`); if (j != null) this.row[j] = Math.max(this.row[j], v); }
    this.sp += sp; this.n++;
  }
  // the newest Arc line: a partial (growing) or a final; tags as Arc gives them [{tag}]
  line(text: string, tags: { tag: string }[], final: boolean) {
    const w = (text.toLowerCase().match(WORD) ?? []).slice(-this.m.last_words), k = final ? "f" : "p";
    const toks = [...w.map(x => `${k}:${x}`), ...w.slice(1).map((x, i) => `${k}:${w[i]}_${x}`)];
    this.toks = [...new Set(toks.map(t => fnv(t) % this.m.V))].sort((a, b) => a - b);
    const c = [w.length, 0, 0, 0, 0, final ? 1 : 0];
    for (const t of tags) {
      if (t.tag === "ENTITY_PERSON") c[1]++;
      if (t.tag === "NUMBER_SCORE") c[2]++;
      if (t.tag === "NUMBER_CLOCK") c[4]++;
      if (t.tag.startsWith("NUMBER")) c[3]++;
    }
    ["txt:words", "txt:person", "txt:score_tag", "txt:number", "txt:clock_tag", "txt:final"].forEach((n, i) => {
      const j = this.ix.get(n); if (j != null) this.row[j] = Math.log1p(c[i]);
    });
  }
  // Arc Tagger on a final: events {label: p}, counts of score and person spans
  tagger(events: Record<string, number>, scoreSpans: number, personSpans: number) {
    for (const [k, v] of Object.entries(events)) { const j = this.ix.get(`tag:${k}`); if (j != null) this.row[j] = Math.max(this.row[j], v); }
    const a = this.ix.get("tag:score_span"), b = this.ix.get("tag:person");
    if (a != null) this.row[a] = Math.log1p(scoreSpans);
    if (b != null) this.row[b] = Math.log1p(personSpans);
  }
  // close the second: the row, its tokens; then start the next one
  take(sport: string) {
    const j = this.ix.get("arc:speech");
    if (j != null) this.row[j] = this.n ? this.sp / this.n : 0;
    const s = this.ix.get(`sport:${sport}`); if (s != null) this.row[s] = 1;
    const out = { row: this.row, tokens: this.toks };
    this.row = new Float64Array(this.m.names.length); this.sp = 0; this.n = 0; this.toks = [];
    return out;
  }
}
