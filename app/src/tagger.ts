// Arc Tagger in the page: the same ONNX model as arc-tagger-c (arctag.onnx, 34 MB) run by ONNX Runtime Web (WASM,
// SIMD), and the C library's tokenizer and T0 decoding ported line for line (arc-tagger-c/src/tokenizer.c, arctag.c:
// run_model, decode_spans, decode_events, readouts, tag_text). tag() returns what the C server's POST /tag returns.
// The ONNX Runtime module is passed in (onnxruntime-web in the page, onnxruntime-node in the parity test).

const P_MAX = 8, NFEAT = 8;
const QN = ["frame", "span_beg", "span_in", "span_end", "ev_at", "ev_imm", "ev_rec", "utt", "speaker", "item"] as const;
const Q_FRAME = 0, Q_BEG = 1, Q_IN = 2, Q_EVAT = 4, Q_EVIMM = 5, Q_EVREC = 6, Q_UTT = 7, Q_SPK = 8, Q_ITEM = 9;
const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
const f32 = Math.fround;

// ------------------------------------------------------------------ tokenizer (byte-level BPE, GPT-2 pre-tokenizer)
const isLetter = (c: string) => /\p{L}/u.test(c), isNumber = (c: string) => /\p{N}/u.test(c), isSpace = (c: string) => /\p{White_Space}/u.test(c);
const isDigit = (c: string) => /\p{Nd}|[²³¹⁰⁴-⁹₀-₉①-⑨⑴-⑼⒈-⒐⓪⓵-⓽⓿❶-❾➀-➈➊-➒]/u.test(c);
type Cls = 0 | 1 | 2 | 3;   // letter, number, space, other
const clsOf = (c: string): Cls => (isLetter(c) ? 0 : isNumber(c) ? 1 : isSpace(c) ? 2 : 3);

export class Tokenizer {
  private vocab = new Map<string, number>();
  private merges = new Map<string, number>();
  private bytemap: string[] = [];
  private added: [string, number][] = [];
  constructor(tok: any) {
    for (const [k, v] of Object.entries(tok.model.vocab as Record<string, number>)) this.vocab.set(k, v);
    (tok.model.merges as (string | [string, string])[]).forEach((m, rank) => {
      const key = Array.isArray(m) ? `${m[0]} ${m[1]}` : m;
      this.merges.set(key, rank);
    });
    for (const a of tok.added_tokens ?? []) if (a.content) this.added.push([a.content, a.id]);
    let n = 0;
    for (let b = 0; b < 256; b++) {
      const used = (b >= 0x21 && b <= 0x7e) || (b >= 0xa1 && b <= 0xac) || (b >= 0xae && b <= 0xff);
      this.bytemap[b] = String.fromCodePoint(used ? b : 256 + n++);
    }
  }
  private bpe(piece: string, ids: number[]) {
    const syms = [...new TextEncoder().encode(piece)].map(b => this.bytemap[b]);
    for (;;) {
      let best = -1, br = 0;
      for (let i = 0; i + 1 < syms.length; i++) {
        const r = this.merges.get(`${syms[i]} ${syms[i + 1]}`);
        if (r !== undefined && (best < 0 || r < br)) { best = i; br = r; }
      }
      if (best < 0) break;
      syms.splice(best, 2, syms[best] + syms[best + 1]);
    }
    for (const s of syms) {
      const id = this.vocab.get(s);
      if (id !== undefined) { ids.push(id); continue; }
      for (const ch of s) { const c = this.vocab.get(ch); if (c !== undefined) ids.push(c); }   // single chars
    }
  }
  private pretok(text: string, ids: number[]) {
    const cp = [...text];
    let p = 0;
    while (p < cp.length) {
      let e = p;
      const c = cp[p];
      if (c === "'" && p + 1 < cp.length) {
        const a = cp[p + 1], b = cp[p + 2] ?? "";
        if ("stmd".includes(a)) e = p + 2;
        else if ((a === "r" && b === "e") || (a === "v" && b === "e") || (a === "l" && b === "l")) e = p + 3;
      }
      if (e === p) {
        let q = p;
        if (c === " " && p + 1 < cp.length && clsOf(cp[p + 1]) !== 2) q = p + 1;
        const k0 = q < cp.length ? clsOf(cp[q]) : 2;
        if (k0 !== 2 && !(q === p && c === " ")) {
          e = q;
          while (e < cp.length && clsOf(cp[e]) === k0) e++;
        } else {   // a whitespace run
          let r = p;
          while (r < cp.length && clsOf(cp[r]) === 2) r++;
          e = r === cp.length || r - p === 1 ? r : r - 1;   // leave the last space for the next token
        }
      }
      this.bpe(cp.slice(p, e).join(""), ids);
      p = e;
    }
  }
  encode(text: string) {
    const ids: number[] = [];
    let a = 0;
    for (;;) {
      let best = text.length, bi = -1;
      this.added.forEach(([s], j) => { const f = text.indexOf(s, a); if (f >= 0 && f < best) { best = f; bi = j; } });
      if (best > a) this.pretok(text.slice(a, best), ids);
      if (bi < 0) break;
      ids.push(this.added[bi][1]);
      a = best + this.added[bi][0].length;
    }
    return ids;
  }
  /** one word: " " + strip(word); more than P_MAX pieces keep the first 7 and the last */
  word(w: string) {
    const ids = this.encode(" " + w.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, ""));
    if (!ids.length) return [0];
    return ids.length > P_MAX ? [...ids.slice(0, P_MAX - 1), ids[ids.length - 1]] : ids;
  }
}

// ------------------------------------------------------------------ the model and its decoding
type Meta = { readouts: Record<string, string[]>; beg_of_in: number[]; is_norm: number[]; state_groups: string[];
  span_head: { name: string; out_t: string; out_b: string; tags: string[]; use: boolean }[];
  profiles: Record<string, { dom: number; thr: Record<string, number[]>; valid: Record<string, number[]>; head_thr: Record<string, number> }>;
  aliases: Record<string, string>; default_profile: string; asr_sources: string[]; default_asr: string; max_ctx: number };
type Run = { W: number; o: Record<string, Float32Array>; dim: Record<string, number> };
type Span = { c: number; a: number; b: number; p: number; thr: number; head: boolean; alt?: [number, number]; order: number };

const famOf = (t: string) => (t.startsWith("safety.pii.") ? "pii" : t.startsWith("safety.profanity.") || t.startsWith("safety.toxicity.") ? "profanity"
  : t.startsWith("entity.number.") || t.startsWith("entity.numeral") ? "number" : t.startsWith("entity.mention.") ? "entity" : "other");
function decodeFamily(t: string) {
  if (t === "entity.numeral" || t === "safety.toxicity.toxic_any") return -1;
  return ["entity.number.", "entity.mention.", "safety.pii.", "safety.profanity.", "safety.toxicity."].findIndex(p => t.startsWith(p));
}
const isSentEnd = (w: string) => { const s = w.replace(/["')\]}]+$/, ""); return !!s && ".?!".includes(s[s.length - 1]); };

export class ArcTagger {
  private m: Meta; private tok: Tokenizer; private sess: any; private ort: any;
  private prof: string; private asr: number;
  private constructor(ort: any, sess: any, meta: Meta, tok: Tokenizer) {
    this.ort = ort; this.sess = sess; this.m = meta; this.tok = tok;
    this.prof = meta.default_profile;
    this.asr = Math.max(0, meta.asr_sources.indexOf(meta.default_asr));
  }
  /** ort: onnxruntime-web (page) or onnxruntime-node; model: URL/path or bytes of arctag.onnx */
  static async create(ort: any, model: string | Uint8Array, meta: Meta, tokenizer: any) {
    const sess = await ort.InferenceSession.create(model);   // the default provider: WASM in the page, CPU in Node
    return new ArcTagger(ort, sess, meta, new Tokenizer(tokenizer));
  }
  /** a domain (nba, soccer, talk, ...) or a profile name (sports:nba) */
  setDomain(d: string) {
    const p = d in this.m.profiles ? d : this.m.aliases[d];
    if (!p) throw new Error(`unknown domain '${d}'`);
    this.prof = p;
  }
  setAsr(name: string) { const a = this.m.asr_sources.indexOf(name); if (a >= 0) this.asr = a; }

  private async run(words: string[], pcs: number[][], us: number[]): Promise<Run> {
    const W = words.length, P = this.m.profiles[this.prof], T = this.ort.Tensor;
    const i64 = (a: number[], dims: number[]) => new T("int64", BigInt64Array.from(a.map(BigInt)), dims);
    const pcsA: number[] = [], npc: number[] = [], wfl: number[] = [], feats: number[] = [], src: number[] = [], spk: number[] = [], ust: number[] = [];
    words.forEach((w, k) => {
      const p = pcs[k];
      for (let j = 0; j < P_MAX; j++) pcsA.push(p[j] ?? 0);
      npc.push(p.length);
      const ch = [...w], hd = ch.some(isDigit) ? 1 : 0, all = hd && ch.every(isDigit) ? 1 : 0;
      wfl.push(hd, all, Math.min(p.length, P_MAX), 3, k ? 0 : 20);   // text words: no times, so fd 3 and fg 20 / 0
      feats.push(0, 0, 1, 0, 0, this.asr, 0, 0);   // gap dur fin(final) conf chg asr spksrc turn
      src.push(this.m.asr_sources[this.asr] === "arc_transcriber" ? 1 : 0);
      spk.push(0);
      ust.push(k === 0 ? 1 : us[k]);
    });
    const feeds = { pcs: i64(pcsA, [W, P_MAX]), npc: i64(npc, [W]), wfl: i64(wfl, [W, 5]), feats: i64(feats, [W, NFEAT]),
      src: i64(src, [W]), spk: i64(spk, [W]), ustart: i64(ust, [W]), dom: i64([P.dom], [1]) };
    const out = await this.sess.run(feeds);
    const o: Record<string, Float32Array> = {}, dim: Record<string, number> = {};
    for (const [k, v] of Object.entries(out as Record<string, any>)) { o[k] = v.data as Float32Array; dim[k] = v.dims.length >= 2 ? Number(v.dims[1]) : 1; }
    return { W, o, dim };
  }
  private P(r: Run, q: number, row: number, c: number) { const n = QN[q]; return r.o[n][row * r.dim[n] + c]; }

  private top(r: Run, q: number, row: number, prefix: string, k: number) {
    const P = this.m.profiles[this.prof], cols = this.m.readouts[QN[q]], idx: number[] = [];
    cols.forEach((c, i) => { if (P.valid[QN[q]][i] && c.startsWith(prefix)) idx.push(i); });
    for (let i = 1; i < idx.length; i++) {   // stable insertion sort, descending p
      const x = idx[i], px = this.P(r, q, row, x);
      let j = i - 1;
      while (j >= 0 && this.P(r, q, row, idx[j]) < px) { idx[j + 1] = idx[j]; j--; }
      idx[j + 1] = x;
    }
    return idx.slice(0, k).map(c => {
      const p = this.P(r, q, row, c), th = P.thr[QN[q]][c];
      return { tag: cols[c], p: r6(p), thr: r6(th), on: p >= f32(th) };
    });
  }
  private readouts(r: Run, row: number, spkSlot: number) {
    const byP = <T extends { p: number }>(a: T[]) => a.map((x, i) => [x, i] as const).sort((x, y) => y[0].p - x[0].p || x[1] - y[1]).map(x => x[0]);
    const intent = byP([...this.top(r, Q_UTT, row, "intent.", 3), ...this.top(r, Q_UTT, row, "discourse.intent.", 3)]).slice(0, 4);
    const act = [...this.top(r, Q_UTT, row, "discourse.act.", 3), ...this.top(r, Q_UTT, row, "discourse.answer", 1),
      ...this.top(r, Q_UTT, row, "discourse.backchannel", 1), ...this.top(r, Q_UTT, row, "discourse.assistant.", 1)];
    const safety = this.top(r, Q_UTT, row, "safety.", 20).filter(x => x.p >= 0.5 * x.thr).slice(0, 6);
    const state: Record<string, any> = {};
    for (const g of this.m.state_groups) { const t = this.top(r, Q_FRAME, row, g + ".", 3); if (t.length) state[g] = t; }
    return { intent, act, safety, emotion: this.top(r, Q_UTT, row, "affect.emotion.", 3), arousal: this.top(r, Q_UTT, row, "affect.arousal.", 3),
      role: spkSlot > 0 ? this.top(r, Q_SPK, row, "speaker.role.", 3) : [], item: this.top(r, Q_ITEM, row, "item.", 3), state };
  }

  private decodeSpans(r: Run, us: number[], words: string[]) {
    const m = this.m, P = m.profiles[this.prof], cols = m.readouts.span_in, nin = cols.length, W = r.W;
    const thrIn = P.thr.span_in, validIn = P.valid.span_in;
    const ON = new Uint8Array(W * nin), BEG = new Uint8Array(W * nin), headcol = new Uint8Array(nin);
    for (let k = 0; k < W; k++) for (let c = 0; c < nin; c++) {
      ON[k * nin + c] = this.P(r, Q_IN, k, c) >= thrIn[c] && validIn[c] ? 1 : 0;
      const bo = m.beg_of_in[c] ?? -1;
      if (bo >= 0) BEG[k * nin + c] = this.P(r, Q_BEG, k, bo) >= P.thr.span_beg[bo] ? 1 : 0;
      if (us[k]) BEG[k * nin + c] = 1;
    }
    const nfc: number[] = [];
    m.span_head.forEach((F, f) => {
      nfc[f] = 0;
      if (!F.use) return;
      for (const t of F.tags) { const c = cols.indexOf(t); if (c >= 0 && validIn[c]) { nfc[f]++; headcol[c] = 1; } }
    });
    let res: Span[] = [];
    const push = (arr: Span[], s: Omit<Span, "order">) => arr.push({ ...s, order: arr.length });
    for (let c = 0; c < nin; c++) {
      if (headcol[c]) continue;
      let a = -1;
      for (let k = 0; k <= W; k++) {
        const on = k < W && ON[k * nin + c];
        if (a >= 0 && (!on || BEG[k * nin + c])) {
          let mx = 0;
          for (let t = a; t < k; t++) { const p = this.P(r, Q_IN, t, c); if (t === a || p > mx) mx = p; }
          push(res, { c, a, b: k, p: mx, thr: thrIn[c], head: false });
          a = -1;
        }
        if (on && a < 0) a = k;
      }
    }
    {   // type-exclusive merge per decode family (span_in path)
      const keep: Span[] = [], byf: Span[][] = [[], [], [], [], []], seen: number[] = [];
      for (const s of res) { const f = decodeFamily(cols[s.c]); if (f < 0) push(keep, s); else { push(byf[f], s); if (!seen.includes(f)) seen.push(f); } }
      const outv: Span[] = [];
      for (const s of keep) push(outv, s);
      for (const f of seen) {
        const xs = byf[f].sort((x, y) => x.a - y.a || x.b - y.b || x.order - y.order);
        const fc = cols.map((t, c) => [t, c] as const).filter(([t, c]) => decodeFamily(t) === f && validIn[c]).map(([, c]) => c).slice(0, 64);
        let i = 0;
        while (i < xs.length) {
          const ga = xs[i].a; let gb = xs[i].b, j = i + 1;
          while (j < xs.length && xs[j].a < gb) { if (xs[j].b > gb) gb = xs[j].b; j++; }
          if (j - i === 1 || !fc.length) { push(outv, xs[i]); i = j; continue; }
          const M = fc.map(() => 0); let cnt = 0;
          for (let w = ga; w < gb; w++) { if (w < 0 || w >= W) continue; cnt++; fc.forEach((c, t) => { M[t] += this.P(r, Q_IN, w, c); }); }
          for (let t = 0; t < M.length; t++) M[t] /= cnt > 0 ? cnt : 1;
          let b1 = 0; for (let t = 1; t < M.length; t++) if (M[t] > M[b1]) b1 = t;
          let b2 = -1; for (let t = 0; t < M.length; t++) if (t !== b1 && (b2 < 0 || M[t] > M[b2])) b2 = t;
          let mx = 0, first = true;
          for (let w = ga; w < gb; w++) { if (w < 0 || w >= W) continue; const p = this.P(r, Q_IN, w, fc[b1]); if (first || p > mx) mx = p; first = false; }
          push(outv, { c: fc[b1], a: ga, b: gb, p: mx, thr: thrIn[fc[b1]], head: false, alt: b2 >= 0 ? [fc[b2], M[b2]] : undefined });
          i = j;
        }
      }
      res = outv;
    }
    m.span_head.forEach((F, f) => {   // span head (T0 greedy BIO) per family
      if (!F.use || !nfc[f] || !r.o[F.out_t] || !r.o[F.out_b]) return;
      const nt = r.dim[F.out_t], ot = r.o[F.out_t], ob = r.o[F.out_b];
      const mem: number[] = [];
      F.tags.forEach((t, i) => { const c = cols.indexOf(t); if (c >= 0 && headcol[c] && validIn[c]) mem.push(i); });
      const th = P.head_thr[F.name] ?? 0.5;
      const lab = new Array<number>(W).fill(0);
      for (let k = 0; k < W; k++) {
        const pin = f32(1 - ob[k * 3]);
        lab[k] = pin < f32(th) ? 0 : us[k] || ob[k * 3 + 1] > ob[k * 3 + 2] ? 1 : 2;
      }
      for (let k = 1; k < W; k++) if (lab[k] === 2 && lab[k - 1] === 0) lab[k] = 1;
      if (W) lab[0] = lab[0] ? 1 : 0;
      let k = 0;
      while (k < W) {
        if (!lab[k]) { k++; continue; }
        let e = k + 1;
        while (e < W && lab[e] === 2) e++;
        const sc = mem.map(() => 0), pm = mem.map(() => 0);
        let mx = 0;
        for (let x = k; x < e; x++) {
          mem.forEach((t, i) => { let v = ot[x * nt + t]; if (v < f32(1e-9)) v = f32(1e-9); if (v > 1) v = 1; sc[i] += f32(Math.log(v)); pm[i] += ot[x * nt + t]; });
          const pin = f32(1 - ob[x * 3]);
          if (x === k || pin > mx) mx = pin;
        }
        let b1 = 0; for (let t = 1; t < mem.length; t++) if (sc[t] > sc[b1]) b1 = t;
        let b2 = -1; for (let t = 0; t < mem.length; t++) if (t !== b1 && (b2 < 0 || sc[t] > sc[b2])) b2 = t;
        const c = cols.indexOf(F.tags[mem[b1]]);
        push(res, { c, a: k, b: e, p: mx, thr: th, head: true, alt: b2 >= 0 ? [cols.indexOf(F.tags[mem[b2]]), pm[b2] / (e - k)] : undefined });
        k = e;
      }
    });
    res.forEach((s, i) => { s.order = i; });
    res.sort((x, y) => x.a - y.a || y.b - x.b || x.order - y.order);
    const vm = r.o.ver_m, ve = r.o.ver_e;
    return res.map(s => {
      const tag = cols[s.c], o: any = { type: tag, family: famOf(tag), start: s.a, end: s.b, text: words.slice(s.a, s.b).join(" "),
        score: r6(s.p), thr: r6(s.thr), src: s.head ? "head" : "span_in" };
      if (s.alt) o.alt = { tag: cols[s.alt[0]], p: r6(s.alt[1]) };
      if (m.is_norm[s.c] && vm && ve) {
        let mean = 0, cnt = 0;
        for (let w = s.a; w < s.b; w++) if (w >= 0 && w < W) { mean += vm[w]; cnt++; }
        const rl = s.b - 1, v = (cnt ? mean / cnt : 0) + (rl >= 0 && rl < W ? ve[rl] : 0);
        o.ver = r6(1 / (1 + Math.exp(-v)));
      }
      return o;
    });
  }
  private decodeEvents(r: Run, words: string[]) {
    const P = this.m.profiles[this.prof], keys: [string, number][] = [], out: any[] = [];
    for (let row = 0; row < r.W; row++) for (const q of [Q_EVAT, Q_EVIMM, Q_EVREC]) {
      const n = QN[q], cols = this.m.readouts[n];
      for (let c = 0; c < cols.length; c++) {
        const p = this.P(r, q, row, c);
        if (!(p >= P.thr[n][c] && P.valid[n][c])) continue;
        if (keys.some(([name, i]) => i >= row - 3 && i <= row && name === cols[c])) continue;   // the same tag within 3 words
        keys.push([cols[c], row]);
        out.push({ type: cols[c], q: n, word: row, score: r6(p), thr: r6(P.thr[n][c]), text: words[row] });
      }
    }
    return out;
  }

  /** one text, like arctag_tag_text: spans, events, and the read-outs of each sentence */
  async tag(text: string, domain?: string) {
    if (domain) this.setDomain(domain);
    const words = text.split(/[ \t\n\r\f\v]+/).filter(Boolean);
    const us: number[] = [];
    let nxt = 1;
    for (const w of words) { us.push(nxt); nxt = isSentEnd(w) ? 1 : 0; }
    const res = { profile: this.prof, n_words: words.length, words, spans: [] as any[], events: [] as any[], utterances: [] as any[] };
    if (!words.length) return res;
    const ws = words.slice(0, this.m.max_ctx), u = us.slice(0, ws.length);   // one chunk: commentary lines are short
    u[0] = 1;
    const r = await this.run(ws, ws.map(w => this.tok.word(w)), u);
    res.spans = this.decodeSpans(r, u, ws);
    res.events = this.decodeEvents(r, ws);
    let a = 0;
    for (let i = 1; i <= ws.length; i++) {
      if (i < ws.length && !u[i]) continue;
      res.utterances.push({ start: a, end: i, text: ws.slice(a, i).join(" "), ...this.readouts(r, i - 1, 0) });
      a = i;
    }
    return res;
  }
}

/** the page's tagger: model files from public/arctag, ONNX Runtime's WASM from public/ort (no CDN on the TV) */
export async function loadPageTagger(base = "arctag/") {
  const ort = await import("onnxruntime-web/wasm");   // WASM only (no WebGPU build): ort-wasm-simd-threaded.{mjs,wasm} in public/ort
  ort.env.wasm.wasmPaths = new URL("ort/", location.href).href;
  ort.env.wasm.numThreads = 1;   // threads need cross-origin isolation, which the YouTube player can't have
  const [meta, tok] = await Promise.all([fetch(base + "arctag_meta.json").then(r => r.json()), fetch(base + "tokenizer.json").then(r => r.json())]);
  const t = await ArcTagger.create(ort, new URL(base + "arctag.onnx", location.href).href, meta, tok);
  return { tag: (text: string, domain: string) => t.tag(text, domain).catch(() => null) };
}
