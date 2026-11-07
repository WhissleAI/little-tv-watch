// Little OCR training data: every second of a catalog clip, every scoreboard field cut out exactly as the app will
// (glyphs.ts grey()), plus, on even seconds, Tesseract's reading of the same field the way board.ts reads it (the
// teacher). node extract.mjs <clip-id>  ->  data/<id>.json
import { spawn, execFileSync } from "child_process";
import fs from "fs";
import zlib from "zlib";
import { grey } from "../../app/src/glyphs.ts";
import { createWorker, PSM } from "../../app/node_modules/tesseract.js/src/index.js";

const id = process.argv[2];
const CAT = "../catalog", MEDIA = (process.env.TVW_MEDIA || "../../media");
const clip = JSON.parse(fs.readFileSync(`${CAT}/${id}.json`, "utf8"));
const layout = clip.layout;
const file = `${MEDIA}/${clip.file}`;
const [W, H] = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", file])
  .toString().trim().split(",").map(Number);
const ALLOW = { a: "0123456789", b: "0123456789", score: "0123456789-", wr: "0123456789-", clock: "0123456789:.", overs: "0123456789.",
  period: "0123456789STNDRHOTQ" };
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const SHAPE = { a: /^\d{1,3}$/, b: /^\d{1,3}$/, score: /^\d{1,2}-\d{1,2}$/, wr: /^\d{1,2}-\d{1,3}$/, clock: /^\d{1,2}:\d{2}$|^\d{1,2}\.\d$/,
  overs: /^\d{1,2}(\.\d)?$|^\d{3}$/, period: /^(\d(ST|ND|RD|TH)|OT|Q\d)$/ };
const fits = (k, t, c) => (SHAPE[k] ?? /^[A-Z]{2,12}$/).test(t) && (k === "a" || k === "b" ? c >= (t.length === 1 ? 45 : 55) : true);

// the box in pixels, with board.ts's small side margin on score digits
function rect(k, [x0, y0, x1, y1]) {
  const m = k === "a" || k === "b" ? 0.006 * W : 0;
  const sx = Math.max(0, Math.round(x0 * W - m)), sy = Math.round(y0 * H);
  return [sx, sy, Math.max(4, Math.min(W - sx, Math.round((x1 - x0) * W + 2 * m))), Math.max(4, Math.round((y1 - y0) * H))];
}

function png(gray, w, h) {   // 8-bit greyscale PNG
  const crcT = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
  const crc = b => { let c = -1; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const raw = Buffer.alloc((w + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w + 1)] = 0; for (let x = 0; x < w; x++) raw[y * (w + 1) + 1 + x] = gray[y * w + x]; }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

// board.ts cut(): 4x up (bilinear here), grey, stretched, flipped to dark-on-light, `hard` for overs, 12 px white pad
function teacherCrop(px, k, [sx, sy, sw, sh]) {
  const S = 4, pad = 12, ow = sw * S, oh = sh * S, g = new Float32Array(ow * oh);
  let lo = 255, hi = 0, sum = 0;
  for (let y = 0; y < oh; y++) for (let x = 0; x < ow; x++) {
    const fx = Math.min(sw - 1.001, Math.max(0, (x + 0.5) / S - 0.5)), fy = Math.min(sh - 1.001, Math.max(0, (y + 0.5) / S - 0.5));
    const x0 = Math.floor(fx), y0 = Math.floor(fy), ax = fx - x0, ay = fy - y0;
    const at = (xx, yy) => { const i = ((sy + yy) * W + sx + xx) * 3; return 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]; };
    const v = at(x0, y0) * (1 - ax) * (1 - ay) + at(x0 + 1, y0) * ax * (1 - ay) + at(x0, y0 + 1) * (1 - ax) * ay + at(x0 + 1, y0 + 1) * ax * ay;
    g[y * ow + x] = v; lo = Math.min(lo, v); hi = Math.max(hi, v); sum += v;
  }
  const inv = sum / g.length < 128, span = Math.max(1, hi - lo), out = new Uint8Array((ow + 2 * pad) * (oh + 2 * pad)).fill(255);
  for (let y = 0; y < oh; y++) for (let x = 0; x < ow; x++) {
    let v = ((g[y * ow + x] - lo) / span) * 255;
    if (inv) v = 255 - v;
    if (k === "overs") v = v >= 128 ? 255 : 0;
    out[(y + pad) * (ow + 2 * pad) + x + pad] = v;
  }
  return png(out, ow + 2 * pad, oh + 2 * pad);
}

const w = await createWorker("eng", 1, { langPath: "../../app/public/tess", gzip: true, cachePath: "/tmp/tesscache" });
async function teach(px, k, r) {
  const img = teacherCrop(px, k, r), seen = [];
  for (const psm of [PSM.SINGLE_LINE, PSM.RAW_LINE]) {
    await w.setParameters({ tessedit_pageseg_mode: psm, tessedit_char_whitelist: ALLOW[k] ?? LETTERS });
    const res = await w.recognize(img);
    const text = res.data.text.trim().replace(/\s+/g, "").replace(/^0T$/, "OT");
    const agreed = (k === "a" || k === "b") && /^\d{1,3}$/.test(text) && seen.includes(text);
    seen.push(text);
    if (agreed || fits(k, text, res.data.confidence)) return [text, Math.round(res.data.confidence)];
  }
  return null;
}

const frameBytes = W * H * 3, rows = [];
const ff = spawn("ffmpeg", ["-v", "error", "-i", file, "-vf", "fps=1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
let buf = Buffer.alloc(0), t = 0;
const frames = [];
ff.stdout.on("data", d => { buf = Buffer.concat([buf, d]); while (buf.length >= frameBytes) { frames.push(buf.subarray(0, frameBytes)); buf = buf.subarray(frameBytes); } });
await new Promise(r => ff.on("close", r));
for (const px of frames) {
  const row = { t, f: {} };
  for (const [k, box] of Object.entries(layout)) {
    const r = rect(k, box), g = grey(px, W, 3, ...r);
    const cell = { w: r[2], h: r[3], g: Buffer.from(Uint8Array.from(g, v => Math.round(v * 255))).toString("base64") };
    if (t % 2 === 0) cell.teach = await teach(px, k, r);
    row.f[k] = cell;
  }
  rows.push(row);
  t++;
}
await w.terminate();
fs.writeFileSync(`./data/${id}.json`, JSON.stringify({ id, sport: clip.sport, W, H, layout, rows }));
console.log(id, rows.length, "s");
