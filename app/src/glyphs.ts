// Little OCR: a scoreboard reader small enough for the TV. A broadcaster's score graphic uses one typeface, so each
// character is matched against templates learned from that broadcast (labelled by Tesseract offline, see
// ocr/glyphs/train.mjs) instead of running a general OCR engine: a field is a few hundred
// pixels and a dozen correlations, well under a millisecond on a laptop. Pure functions, no DOM: the trainer runs the
// very same code in Node.

export const GW = 12, GH = 20;   // a glyph is compared at 12x20

export type Glyph = { x0: number; x1: number; y0: number; y1: number; v: Float32Array; parts: number; hr: number; wr: number };
export type Templates = Record<string, number[][]>;   // char -> mean glyphs (one or more), each GW*GH values in 0..1
// How a field is cut into glyphs, learned per broadcaster and field: which side is ink (`flip`: light ink on dark)
// and the threshold (0: Otsu over the whole cell, 1: Otsu over its middle, 2: halfway between ink and paper).
// Without one (a broadcast we haven't seen), the cell decides for itself.
export type Cut = { flip: boolean; thr: 0 | 1 | 2 };
export const CUTS: Cut[] = [false, true].flatMap(flip => ([0, 1, 2] as const).map(thr => ({ flip, thr })));

// Grey (0 = ink, 1 = paper) from RGBA or RGB pixels of a box; ink is whichever side is the minority, so white-on-dark
// and dark-on-light read the same.
export function grey(px: Uint8ClampedArray | Uint8Array, stride: number, ch: number, x0: number, y0: number, w: number, h: number) {
  const g = new Float32Array(w * h);
  let lo = 255, hi = 0, sum = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = ((y0 + y) * stride + (x0 + x)) * ch;
      const v = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
      g[y * w + x] = v;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
      sum += v;
    }
  }
  const span = Math.max(1, hi - lo), mean = sum / g.length;
  // a mostly dark cell has light text: flip it so ink is always low
  const flip = mean < lo + span / 2;
  for (let i = 0; i < g.length; i++) {
    const v = (g[i] - lo) / span;
    g[i] = flip ? 1 - v : v;
  }
  return g;
}

// Otsu's threshold over the grey cell.
function otsu(g: Float32Array) {
  const bins = new Float64Array(64);
  for (const v of g) bins[Math.min(63, Math.floor(v * 64))]++;
  let total = g.length, sumAll = 0;
  for (let i = 0; i < 64; i++) sumAll += i * bins[i];
  let wB = 0, sumB = 0, best = 0, thr = 32;
  for (let i = 0; i < 64; i++) {
    wB += bins[i];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += i * bins[i];
    const mB = sumB / wB, mF = (sumAll - sumB) / wF, between = wB * wF * (mB - mF) ** 2;
    if (between > best) { best = between; thr = i; }
  }
  return (thr + 0.5) / 64;
}

// The characters in a cell, left to right: connected ink blobs, with blobs that share columns joined (":" is two dots,
// "i" a stem and a dot). Blobs touching the cell's edge that span most of it (the box's own border) and specks are
// dropped.
// How much a cut's glyphs look like characters: tall enough for the cell, not slivers or slabs, and of one height
// (cutting the paper instead of the ink gives a few odd shapes).
export function plausible(gl: Glyph[], h: number) {
  const body = gl.filter(x => x.hr > 0.55);
  if (!body.length) return 0;
  let ok = 0;
  for (const x of body) {
    const gh = x.y1 - x.y0 + 1, gw = x.x1 - x.x0 + 1;
    let fill = 0;
    for (const v of x.v) fill += v;
    fill /= x.v.length;   // strokes fill part of their box; a slab of background fills nearly all of it
    if (gh >= 0.35 * h && gh <= 0.97 * h && gw / gh >= 0.12 && gw / gh <= 1.1 && fill >= 0.18 && fill <= 0.93) ok++;
  }
  return ok / Math.max(body.length, 1) * Math.min(body.length, 4);
}

// Which side is ink in this cell by itself: the side the non-background pixels mostly sit on.
export function lightInk(g0: Float32Array, w: number, h: number) {
  const mx = Math.floor(0.08 * w), my = Math.floor(0.08 * h), hist = new Float64Array(16), mid: number[] = [];
  for (let y = my; y < h - my; y++) for (let x = mx; x < w - mx; x++) { const v = g0[y * w + x]; mid.push(v); hist[Math.min(15, Math.floor(v * 16))]++; }
  let modeBin = 0;
  for (let i = 1; i < 16; i++) if (hist[i] > hist[modeBin]) modeBin = i;
  const bg = (modeBin + 0.5) / 16;
  let up = 0, down = 0;
  for (const v of mid) { if (v > bg + 0.2) up++; else if (v < bg - 0.2) down++; }
  return up > down;
}

export function segment(g0: Float32Array, w: number, h: number, cut?: Cut): Glyph[] {
  // The background is the cell's most common level (paper, wherever its edges are); ink is whichever side of it the
  // other pixels mostly sit, unless this broadcaster's field has a learned cut.
  const mx = Math.floor(0.08 * w), my = Math.floor(0.08 * h), mid: number[] = [], hist = new Float64Array(16);
  for (let y = my; y < h - my; y++) for (let x = mx; x < w - mx; x++) {
    const v = g0[y * w + x];
    mid.push(v);
    hist[Math.min(15, Math.floor(v * 16))]++;
  }
  let modeBin = 0;
  for (let i = 1; i < 16; i++) if (hist[i] > hist[modeBin]) modeBin = i;
  let up = 0, down = 0;
  const bg0 = (modeBin + 0.5) / 16;
  for (const v of mid) { if (v > bg0 + 0.2) up++; else if (v < bg0 - 0.2) down++; }
  const flip = cut ? cut.flip : up > down;
  const g = flip ? g0.map(v => 1 - v) : g0;
  const inner = Float32Array.from(flip ? mid.map(v => 1 - v) : mid), sorted = Float32Array.from(inner).sort();
  const inkLevel = sorted[Math.floor(0.05 * sorted.length)] ?? 0, paper = sorted[Math.floor(0.6 * sorted.length)] ?? 1;
  if (paper - inkLevel < 0.15) return [];   // nothing written here
  const how = cut ? cut.thr : 1;
  const t = how === 0 ? otsu(g) : how === 1 ? Math.min(paper - 0.05, Math.max(inkLevel + 0.05, otsu(inner))) : (paper + inkLevel) / 2;
  const ink = new Uint8Array(w * h);
  for (let i = 0; i < ink.length; i++) ink[i] = g[i] < t ? 1 : 0;
  const lab = new Int32Array(w * h).fill(-1), boxes: number[][] = [];
  const stack: number[] = [];
  for (let s = 0; s < ink.length; s++) {
    if (!ink[s] || lab[s] >= 0) continue;
    const id = boxes.length, b = [w, h, -1, -1, 0];   // x0 y0 x1 y1 count
    lab[s] = id;
    stack.push(s);
    while (stack.length) {
      const p = stack.pop()!, x = p % w, y = (p - x) / w;
      if (x < b[0]) b[0] = x;
      if (y < b[1]) b[1] = y;
      if (x > b[2]) b[2] = x;
      if (y > b[3]) b[3] = y;
      b[4]++;
      for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1])
        if (q >= 0 && ink[q] && lab[q] < 0) { lab[q] = id; stack.push(q); }
    }
    boxes.push(b);
  }
  const keep = boxes.filter(b => {
    const bw = b[2] - b[0] + 1, bh = b[3] - b[1] + 1;
    const edge = b[0] === 0 || b[1] === 0 || b[2] === w - 1 || b[3] === h - 1;
    if (edge && (bw > 0.6 * w || (bh > 0.85 * h && bw < 0.15 * w))) return false;   // the cell's border or a background band (a digit filling the cell top to bottom stays)
    if (edge && b[4] < 0.002 * w * h + 2) return false;
    return b[4] >= Math.max(2, 0.0015 * w * h);
  });
  if (!keep.length) return [];
  // join blobs that overlap in x (by half the narrower one)
  keep.sort((a, b) => a[0] - b[0]);
  const groups: number[][] = [];
  for (const b of keep) {
    const g0 = groups[groups.length - 1];
    if (g0) {
      const ov = Math.min(g0[2], b[2]) - Math.max(g0[0], b[0]) + 1, nar = Math.min(g0[2] - g0[0], b[2] - b[0]) + 1;
      if (ov >= 0.5 * nar) {
        g0[0] = Math.min(g0[0], b[0]); g0[1] = Math.min(g0[1], b[1]); g0[2] = Math.max(g0[2], b[2]); g0[3] = Math.max(g0[3], b[3]);
        g0[4]++;
        continue;
      }
    }
    groups.push([b[0], b[1], b[2], b[3], 1]);
  }
  // the line's height comes from the tallest groups (a digit), not from junk
  const tall = Math.max(...groups.map(x => x[3] - x[1] + 1));
  // text at the cell's left or right edge that isn't ours (ESPN's vertical "BONUS" beside the score), and clusters of
  // many small blobs: not characters
  const real = groups.filter(([x0, , x1, , parts]) => {
    const bw = x1 - x0 + 1, narrow = bw < 0.35 * tall;
    if ((x0 === 0 || x1 === w - 1) && narrow) return false;
    if (bw <= 2 || bw < 0.1 * tall) return false;   // a hairline: the cell's inner border
    return parts < 4;
  });
  if (!real.length) return [];
  const top = Math.min(...real.map(x => x[1])), bot = Math.max(...real.map(x => x[3])), lineH = Math.max(1, bot - top + 1);
  return real.map(([x0, y0, x1, y1, parts]) => {
    const v = new Float32Array(GW * GH), bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    // area-average the glyph's box into 12x20 (ink = 1)
    for (let gy = 0; gy < GH; gy++) {
      const sy0 = y0 + (gy * bh) / GH, sy1 = y0 + ((gy + 1) * bh) / GH;
      for (let gx = 0; gx < GW; gx++) {
        const sx0 = x0 + (gx * bw) / GW, sx1 = x0 + ((gx + 1) * bw) / GW;
        let acc = 0, n = 0;
        for (let y = Math.floor(sy0); y < Math.max(Math.floor(sy0) + 1, Math.ceil(sy1)); y++)
          for (let x = Math.floor(sx0); x < Math.max(Math.floor(sx0) + 1, Math.ceil(sx1)); x++) { acc += 1 - g[y * w + x]; n++; }
        v[gy * GW + gx] = acc / n;
      }
    }
    return { x0, x1, y0, y1, v, parts, hr: bh / lineH, wr: bw / lineH };
  });
}

// Punctuation goes on shape, not templates: ":" is two narrow parts (as tall as 70% of a digit), "-" is short and
// wide, "." is a small low blob.
export function punct(gl: Glyph): string | null {
  if (gl.parts >= 2 && gl.wr < 0.45) return ":";
  if (gl.hr > 0.55) return null;
  if (gl.wr > 1.3 * gl.hr) return "-";
  return gl.hr < 0.35 && gl.wr < 0.45 ? "." : null;
}

function corr(a: Float32Array, b: number[]) {
  let ma = 0, mb = 0;
  for (let i = 0; i < a.length; i++) { ma += a[i]; mb += b[i]; }
  ma /= a.length; mb /= a.length;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] - ma, y = b[i] - mb;
    sab += x * y; saa += x * x; sbb += y * y;
  }
  return sab / Math.sqrt(saa * sbb + 1e-9);
}

export type Read = { text: string; conf: number };

// One field: its characters by template, the least sure character's correlation as the field's confidence.
// The glyphs of a cell under a threshold method, with the ink side that gives the more character-like result:
// cell colours follow the teams (the same CBS box is dark-on-light for one game and light-on-dark for another), so the
// ink side is decided per read, never per broadcaster.
export function glyphsOf(g: Float32Array, w: number, h: number, thr: 0 | 1 | 2 = 1): Glyph[] {
  const a = segment(g, w, h, { flip: false, thr }), b = segment(g, w, h, { flip: true, thr });
  return plausible(b, h) > plausible(a, h) ? b : a;
}

export function recognize(g: Float32Array, w: number, h: number, tpl: Templates, allow: string, thr: 0 | 1 | 2 = 1): Read {
  const glyphs = glyphsOf(g, w, h, thr);
  if (!glyphs.length || glyphs.length > 12) return { text: "", conf: 0 };
  let text = "", conf = 1;
  for (const gl of glyphs) {
    const p = punct(gl);
    if (p) {
      if (allow.includes(p)) text += p;
      continue;
    }
    let best = "", bc = -1;
    for (const ch of allow) {
      for (const t of tpl[ch] ?? []) {
        const c = corr(gl.v, t);
        if (c > bc) { bc = c; best = ch; }
      }
    }
    if (!best) return { text: "", conf: 0 };
    text += best;
    conf = Math.min(conf, bc);
  }
  return { text, conf };
}
