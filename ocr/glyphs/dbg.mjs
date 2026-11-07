// dump cells where the glyph count disagrees with the teacher: png strips with the glyph boxes in red
import fs from "fs";
import zlib from "zlib";
import { segment, punct } from "../../app/src/glyphs.ts";
const [id, field, n = "6"] = process.argv.slice(2);
const clip = JSON.parse(fs.readFileSync(`./data/${id}.json`, "utf8"));
const crcT = new Int32Array(256).map((_, k) => { let c = k; for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc = b => { let c = -1; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
const S = 4, cells = [];
for (const row of clip.rows) {
  const c = row.f[field];
  if (!c?.teach) continue;
  const g = Float32Array.from(Buffer.from(c.g, "base64"), v => v / 255), gl = segment(g, c.w, c.h);
  const text = c.teach[0].replace(/[:.\-]/g, "");
  const nonp = gl.filter(x => !punct(x));
  if (nonp.length !== text.length) { cells.push({ t: row.t, c, g, gl, text }); console.log(row.t, c.teach[0], "glyphs", gl.map(x => `${x.x0}-${x.x1}/${x.y0}-${x.y1} p${x.parts} h${x.hr.toFixed(2)}`).join(" ")); }
  if (cells.length >= +n) break;
}
const W = Math.max(...cells.map(x => x.c.w)) * S, H = cells.reduce((a, x) => a + x.c.h * S + 4, 0);
const img = Buffer.alloc(W * H * 3, 128); let oy = 0;
for (const { c, g, gl } of cells) {
  for (let y = 0; y < c.h * S; y++) for (let x = 0; x < c.w * S; x++) { const v = Math.round(g[Math.floor(y / S) * c.w + Math.floor(x / S)] * 255); const i = ((oy + y) * W + x) * 3; img[i] = img[i + 1] = img[i + 2] = v; }
  for (const b of gl) for (let x = b.x0 * S; x <= b.x1 * S + S - 1; x++) for (const y of [b.y0 * S, b.y1 * S + S - 1]) { const i = ((oy + y) * W + x) * 3; img[i] = 255; img[i + 1] = 0; img[i + 2] = 0; }
  oy += c.h * S + 4;
}
const raw = Buffer.alloc((W * 3 + 1) * H);
for (let y = 0; y < H; y++) img.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3);
const ih = Buffer.alloc(13); ih.writeUInt32BE(W, 0); ih.writeUInt32BE(H, 4); ih[8] = 8; ih[9] = 2;
fs.writeFileSync(`/tmp/dbg_${id}_${field}.png`, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ih), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]));
