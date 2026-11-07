// Little OCR: build glyph templates from the teacher-labelled cells, and replay every clip second by second through
// the app's own recogniser + board rules to compare with the verified board timelines.
//   node lo.mjs build [--split]   -> templates (public/glyphs/templates.json); --split trains on seconds % 4 == 0 only
//   node lo.mjs eval              -> per-clip field accuracy (vs teacher on seconds % 4 == 2) and timeline vs board_changes
import fs from "fs";
import { glyphsOf, recognize, punct, GW, GH } from "../../app/src/glyphs.ts";
const DATA = "./data", CAT = "../catalog";
const OUT = "../../app/public/glyphs/templates.json";
const cmd = process.argv[2], split = process.argv.includes("--split");
const PUN = /[:.\-]/g;
export const layoutKey = l => JSON.stringify(Object.keys(l).sort().map(k => [k, l[k].map(x => +(+x).toFixed(3))]));
const cell = c => ({ w: c.w, h: c.h, g: Float32Array.from(Buffer.from(c.g, "base64"), v => v / 255) });
const clips = fs.readdirSync(DATA).filter(f => f.endsWith(".json")).map(f => JSON.parse(fs.readFileSync(`${DATA}/${f}`, "utf8")));

function kmeans(vs, k) {   // a few means per character (a cell lit up, a bolder weight): plain k-means, 8 rounds
  if (vs.length <= k) return vs.map(v => Array.from(v));
  let c = Array.from({ length: k }, (_, i) => Array.from(vs[Math.floor((i * vs.length) / k)]));
  for (let it = 0; it < 8; it++) {
    const acc = c.map(() => [new Float64Array(GW * GH), 0]);
    for (const v of vs) {
      let bi = 0, bd = Infinity;
      c.forEach((m, i) => { let d = 0; for (let j = 0; j < v.length; j++) d += (v[j] - m[j]) ** 2; if (d < bd) { bd = d; bi = i; } });
      for (let j = 0; j < v.length; j++) acc[bi][0][j] += v[j];
      acc[bi][1]++;
    }
    c = acc.map(([s, n], i) => (n ? Array.from(s, x => x / n) : c[i]));
  }
  return c;
}

// Per field, the cut (ink side + threshold) under which a reader built from the teacher's labels reproduces the
// teacher best; a field the teacher never read gets the cut under which the sport's glyphs read it most often in a
// well-formed, confident way. Then the labelled glyphs under the chosen cut.
const ALLOW0 = { a: "0123456789", b: "0123456789", score: "0123456789-", wr: "0123456789-", clock: "0123456789:.", overs: "0123456789.",
  period: "0123456789STNDRHOTQ" };
const SHAPE0 = { a: /^\d{1,3}$/, b: /^\d{1,3}$/, score: /^\d{1,2}-\d{1,2}$/, wr: /^\d{1,2}-\d{1,3}$/, clock: /^\d{1,2}:\d{2}$|^\d{1,2}\.\d$/,
  overs: /^\d{1,2}(\.\d)?$|^\d{3}$/, period: /^(\d(ST|ND|RD|TH)|OT|Q\d)$/ };
function labelled(cells, cut) {
  const by = {};
  let used = 0;
  for (const { c, text } of cells) {
    const gl = glyphsOf(c.g, c.w, c.h, cut).filter(x => !punct(x));
    if (gl.length !== text.length || !text.length) continue;
    gl.forEach((x, i) => (by[text[i]] ??= []).push(x.v));
    used++;
  }
  return { by, used };
}
function samples(clip, keep, pooled) {
  const by = {}, cuts = {};
  let used = 0, skipped = 0;
  for (const k of Object.keys(clip.layout)) {
    const rows = clip.rows.filter(r => keep(r.t) && r.f[k]);
    const cells = rows.filter(r => r.f[k].teach).map(r => ({ c: cell(r.f[k]), text: r.f[k].teach[0] }));
    // candidates: the six fixed cuts, and -1 = let each cell decide (the automatic rule)
    // the ink side is the cells' own majority vote (a flipped cut can turn background into "glyphs" that agree with the
    // teacher's text by accident); only the threshold method is chosen here
    // only the threshold method is learned per field (0 Otsu whole cell, 1 Otsu middle, 2 halfway); ink is per read
    const cand = [0, 1, 2], cutOf = i => i;
    const teacherScore = i => {
      const t = templates(labelled(cells.map(x => ({ ...x, text: x.text.replace(PUN, "") })), cutOf(i)).by);
      return cells.filter(({ c, text }) => recognize(c.g, c.w, c.h, t, ALLOW0[k] ?? "ABCDEFGHIJKLMNOPQRSTUVWXYZ", cutOf(i)).text === text).length / cells.length;
    };
    const selfScore = i => {
      if (!pooled) return 0;
      const all = rows.map(r => cell(r.f[k]));
      return all.filter(c => { const r = recognize(c.g, c.w, c.h, pooled, ALLOW0[k] ?? "ABCDEFGHIJKLMNOPQRSTUVWXYZ", cutOf(i)); return r.conf >= 0.6 && (SHAPE0[k] ?? /^[A-Z]{2,12}$/).test(r.text); }).length / Math.max(1, all.length);
    };
    const pick = f => cand.reduce((b, i) => { const sc = f(i); return sc > b[1] + 1e-9 ? [i, sc] : b; }, [cand[0], -1]);
    // the teacher's agreement where it read the field, plus how often the field reads cleanly at all (a cut that finds
    // nothing in most seconds scores low even if the few teacher cells agree)
    const [best] = pick(i => (cells.length >= 3 ? teacherScore(i) : 0) + (pooled ? selfScore(i) : 0));
    cuts[k] = best;
    if (cells.length) {
      const L = labelled(cells.map(x => ({ ...x, text: x.text.replace(PUN, "") })), best);
      for (const [ch, vs] of Object.entries(L.by)) (by[ch] ??= []).push(...vs);
      used += L.used; skipped += cells.length - L.used;
    }
  }
  return { by, used, skipped, cuts };
}

function corrv(a, b) {
  let ma = 0, mb = 0; for (let i = 0; i < a.length; i++) { ma += a[i]; mb += b[i]; } ma /= a.length; mb /= a.length;
  let ab = 0, aa = 0, bb = 0; for (let i = 0; i < a.length; i++) { const x = a[i] - ma, y = b[i] - mb; ab += x * y; aa += x * x; bb += y * y; }
  return ab / Math.sqrt(aa * bb + 1e-9);
}
// the teacher is wrong now and then ("78" read as "18"): a sample that matches another character's mean better than
// its own label's is dropped before the means are made
function clean(by) {
  const mean = {};
  for (const [ch, vs] of Object.entries(by)) { const m = new Float64Array(GW * GH); for (const v of vs) for (let j = 0; j < m.length; j++) m[j] += v[j] / vs.length; mean[ch] = m; }
  const out = {};
  for (const [ch, vs] of Object.entries(by)) out[ch] = vs.filter(v => {
    const own = corrv(v, mean[ch]);
    return own > 0.5 && Object.entries(mean).every(([c2, m]) => c2 === ch || corrv(v, m) < own);
  });
  return out;
}
function templates(byRaw) {
  const by = clean(byRaw);
  const t = {};
  for (const [ch, vs] of Object.entries(by)) if (vs.length) t[ch] = kmeans(vs, Math.min(3, Math.max(1, Math.floor(vs.length / 8)))).map(m => m.map(x => +x.toFixed(2)));
  return t;
}

function buildAll(keep) {
  const pass = pooledBySport => {
    const byLayout = {}, bySport = {};
    for (const clip of clips) {
      const { by, used, skipped, cuts } = samples(clip, keep, pooledBySport?.[clip.sport]);
      byLayout[layoutKey(clip.layout)] = { chars: templates(by), cuts };
      const sp = (bySport[clip.sport] ??= {});
      for (const [ch, vs] of Object.entries(by)) (sp[ch] ??= []).push(...vs);
      if (cmd === "build" && pooledBySport) console.log(`${clip.id.padEnd(20)} cells used ${used}, unaligned ${skipped}, cuts ${JSON.stringify(cuts)}`);
    }
    const sports = {};
    for (const [s, by] of Object.entries(bySport)) sports[s] = templates(by);
    return { byLayout, sports };
  };
  const first = pass(null), { byLayout, sports } = pass(first.sports);
  // a character this broadcast never showed (or the teacher never read) comes from the sport's other broadcasts
  for (const clip of clips) { const k = layoutKey(clip.layout); byLayout[k].chars = { ...sports[clip.sport], ...byLayout[k].chars }; }
  return { byLayout, sports };
}

if (cmd === "build") {
  const t = buildAll(r => (split ? r % 4 === 0 : r % 2 === 0));
  fs.mkdirSync(OUT.replace(/\/[^/]+$/, ""), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ GW, GH, ...t }));
  console.log("templates:", (fs.statSync(OUT).size / 1024).toFixed(0), "KB");
}

// ---- eval: the app's own reading + board rules
const ALLOW = { a: "0123456789", b: "0123456789", score: "0123456789-", wr: "0123456789-", clock: "0123456789:.", overs: "0123456789.",
  period: "0123456789STNDRHOTQ" };
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const SHAPE = { a: /^\d{1,3}$/, b: /^\d{1,3}$/, score: /^\d{1,2}-\d{1,2}$/, wr: /^\d{1,2}-\d{1,3}$/, clock: /^\d{1,2}:\d{2}$|^\d{1,2}\.\d$/,
  overs: /^\d{1,2}(\.\d)?$|^\d{3}$/, period: /^(\d(ST|ND|RD|TH)|OT|Q\d)$/ };
const STEP = { nba: [4, 4], nfl: [8, 8], nhl: [2, 2], soccer: [2, 2], cricket: [60, 1] };
const GAP = { nba: 50, nfl: 50, nhl: 8, soccer: 8 };
export const MINCONF = +(process.env.MINCONF ?? 0.6);
class Side {
  value; run = 0; hist = [];
  feed(v, step, need, other, gap) {
    if (v == null) return "";
    this.run = v === this.hist[this.hist.length - 1] ? this.run + 1 : 1;
    this.hist = [...this.hist, v].slice(-6);
    if (v === this.value) return "";
    const count = n => this.hist.slice(-n).filter(x => x === v).length;
    const fair = gap == null || other == null || Math.abs(v - other) <= gap;
    if (this.value == null) { if (fair && count(5) >= 3) { this.value = v; return "fix"; } return ""; }
    if (fair && v > this.value && v - this.value <= step && count(3) >= need) { this.value = v; return "move"; }
    if (v > this.value && count(6) >= 4 && this.run >= (fair ? 4 : 8)) { this.value = v; return "fix"; }
    return "";
  }
}

if (cmd === "eval") {
  const T = JSON.parse(fs.readFileSync(OUT, "utf8"));
  let fieldOk = 0, fieldN = 0, fieldNone = 0, ms = 0, reads = 0, hitsAll = 0, wantAll = 0, falseAll = 0, tessAll = 0;
  for (const clip of clips) {
    const L = T.byLayout[layoutKey(clip.layout)], tpl = L?.chars ?? T.sports[clip.sport];
    const cat = JSON.parse(fs.readFileSync(`${CAT}/${clip.id}.json`, "utf8")), want = cat.board_changes ?? [];
    const sides = [new Side(), new Side()], got = [];
    let ok = 0, n = 0, none = 0;
    for (const row of clip.rows) {
      const read = {};
      const a = performance.now();
      for (const [k, c] of Object.entries(row.f)) {
        const { g, w, h } = cell(c);
        const r = recognize(g, w, h, tpl, ALLOW[k] ?? LETTERS, L?.cuts?.[k] ?? 1);
        if (r.conf >= MINCONF && (SHAPE[k] ?? /^[A-Z]{2,12}$/).test(r.text)) read[k] = r.text;
        if (row.t % 4 === 2 && c.teach) { n++; if (read[k] === c.teach[0]) ok++; else if (!read[k]) none++; }
      }
      ms += performance.now() - a; reads++;
      const int = x => (x && /^\d{1,3}$/.test(x) ? +x : undefined);
      let raw = [int(read.a), int(read.b)];
      const pair = (read.score ?? "").match(/^(\d{1,2})-(\d{1,2})$/); if (pair) raw = [+pair[1], +pair[2]];
      const wr = (read.wr ?? "").match(/^(\d{1,2})-(\d{1,3})$/); if (wr && +wr[1] <= 10) raw = [+wr[2], +wr[1]];
      const fed = sides.map((x, i) => x.feed(raw[i], STEP[clip.sport][i], 2, raw[1 - i] ?? sides[1 - i].value, GAP[clip.sport]));
      if ((fed.includes("move") || fed.includes("fix")) && sides.every(x => x.value != null)) got.push({ t: row.t, score: sides.map(x => x.value) });
    }
    // the Tesseract path for comparison: the teacher's reads (even seconds; each stands for that second and the next)
    const ts = [new Side(), new Side()], tgot = [];
    for (const row of clip.rows) {
      const src = clip.rows[row.t - (row.t % 2)] ?? row, rd = {};
      for (const [k, c] of Object.entries(src.f)) if (c.teach) rd[k] = c.teach[0];
      const int = x => (x && /^\d{1,3}$/.test(x) ? +x : undefined);
      let raw = [int(rd.a), int(rd.b)];
      const pair = (rd.score ?? "").match(/^(\d{1,2})-(\d{1,2})$/); if (pair) raw = [+pair[1], +pair[2]];
      const wr = (rd.wr ?? "").match(/^(\d{1,2})-(\d{1,3})$/); if (wr && +wr[1] <= 10) raw = [+wr[2], +wr[1]];
      const fed = ts.map((x, i) => x.feed(raw[i], STEP[clip.sport][i], 2, raw[1 - i] ?? ts[1 - i].value, GAP[clip.sport]));
      if ((fed.includes("move") || fed.includes("fix")) && ts.every(x => x.value != null)) tgot.push({ t: row.t, score: ts.map(x => x.value) });
    }
    const thit = want.filter(wv => tgot.some(g => g.score.join("-") === wv.score.join("-") && Math.abs(g.t - wv.t) <= 6)).length;
    tessAll += thit;
    fieldOk += ok; fieldN += n; fieldNone += none;
    const hit = want.filter(wv => got.some(g => g.score.join("-") === wv.score.join("-") && Math.abs(g.t - wv.t) <= 6)).length;
    const extra = got.filter(g => !want.some(wv => wv.score.join("-") === g.score.join("-"))).length;
    hitsAll += hit; wantAll += want.length; falseAll += want.length ? extra : 0;
    console.log(`${clip.id.padEnd(20)} tesseract ${want.length ? thit + "/" + want.length : "-"}  little ${want.length ? hit + "/" + want.length : "-"}  fields ${n ? ((100 * ok) / n).toFixed(0) : "-"}% right (${none} unread of ${n})  board ${want.length ? `${hit}/${want.length} changes, ${extra} not in the verified list` : "no verified list"}  → ${got.map(g => `${g.t}s ${g.score.join("-")}`).slice(0, 40).join(", ")}`);
  }
  console.log(`ALL tesseract path ${tessAll}/${wantAll}  little OCR ${hitsAll}/${wantAll};  fields ${((100 * fieldOk) / fieldN).toFixed(1)}% right (${fieldNone} unread of ${fieldN}); board ${hitsAll}/${wantAll} verified changes, ${falseAll} extra; ${(ms / reads).toFixed(2)} ms per full board read (Mac, Node)`);
}
