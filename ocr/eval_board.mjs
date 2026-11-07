// Replays 1 fps scoreboard crops (eval_crops.py) through board.ts's own logic: the same whitelists, RAW_LINE,
// confidence floor, parsing and per-side Side rules. Prints the accepted score timeline and per-field read rates.
// node eval_board.mjs <sport> [--raw]
import { createWorker, PSM } from "../app/node_modules/tesseract.js/src/index.js";
import fs from "fs";
const ALLOW = { a: "0123456789", b: "0123456789", score: "0123456789-", wr: "0123456789-", clock: "0123456789:.",
  overs: "0123456789.", period: "0123456789STNDRHOTQ" };
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const SHAPE = { a: /^\d{1,3}$/, b: /^\d{1,3}$/, score: /^\d{1,2}-\d{1,2}$/, wr: /^\d{1,2}-\d{1,3}$/,
  clock: /^\d{1,2}:\d{2}$|^\d{1,2}\.\d$/, overs: /^\d{1,2}\.\d$/, period: /^(\d(ST|ND|RD|TH)|OT|Q\d)$/ };
const STEP = { nba: [4, 4], nfl: [8, 8], nhl: [2, 2], soccer: [2, 2], cricket: [7, 1] };
const s = process.argv[2], showRaw = process.argv.includes("--raw");
const dir = `ev/${s}`, files = fs.readdirSync(dir).sort();
const secs = [...new Set(files.map(f => +f.slice(0, 5)))];
const w = await createWorker("eng", 1, { langPath: "../app/public/tess", gzip: true, cachePath: "/tmp/tesscache" });
class Side {
  value; cand; seen = 0;
  feed(v, step, need = 2) {
    if (v == null || v === this.value) { if (v === this.value) this.seen = 0; return false; }
    if (this.value != null && !(v > this.value && v - this.value <= step)) return false;
    this.seen = v === this.cand ? this.seen + 1 : 1; this.cand = v;
    if (this.seen < need) return false;
    this.value = v; this.seen = 0; return true;
  }
}
const sides = [new Side(), new Side()], reads = {}, t0 = Date.now(); let fieldMs = 0, nField = 0, period = "";
for (const t of secs) {
  const got = {};
  for (const f of files.filter(f => +f.slice(0, 5) === t)) {
    const k = f.slice(6, -4);
    reads[k] ??= [0, 0]; reads[k][1]++;
    for (const psm of [PSM.SINGLE_LINE, PSM.RAW_LINE]) {
      await w.setParameters({ tessedit_pageseg_mode: psm, tessedit_char_whitelist: ALLOW[k] ?? LETTERS });
      const a = Date.now(); const r = await w.recognize(`${dir}/${f}`); fieldMs += Date.now() - a; nField++;
      let text = r.data.text.trim().replace(/\s+/g, "").replace(/^0T$/, "OT");
      if (k === "overs") text = text.replace(/^(\d{1,2})([0-5])$/, "$1.$2");
      if ((SHAPE[k] ?? /^[A-Z]{2,12}$/).test(text) && (!(k === "a" || k === "b") || r.data.confidence >= 55)) {
        got[k] = text; if (k === "wr") got.wrConf = r.data.confidence; reads[k][0]++; break;
      }
    }
  }
  const int = x => (x && /^\d{1,3}$/.test(x) ? Number(x) : undefined);
  let raw = [int(got.a), int(got.b)];
  const pair = (got.score ?? "").match(/^(\d{1,2})-(\d{1,2})$/); if (pair) raw = [+pair[1], +pair[2]];
  const wr = (got.wr ?? "").match(/^(\d{1,2})-(\d{1,3})$/); if (wr && +wr[1] <= 10) raw = [+wr[2], +wr[1]];
  if (got.period) period = got.period;
  const ov = got.overs && /^\d{1,2}\.\d$/.test(got.overs) ? got.overs : "";
  const wicket = s === "cricket" && (got.wrConf ?? 0) >= 90 && raw[0] === sides[0].value && raw[1] === (sides[1].value ?? -1) + 1;
  delete got.wrConf;
  const moved = sides.map((x, i) => x.feed(raw[i], STEP[s][i], wicket ? 1 : 2)).some(Boolean);
  if (showRaw) console.log(t, JSON.stringify(got));
  if (moved && sides.every(x => x.value != null)) console.log(`t=${t}s  score ${sides.map(x => x.value).join("-")}  ${period} ${got.clock ?? ov}`);
}
console.log("read rate:", Object.entries(reads).map(([k, [o, n]]) => `${k} ${Math.round(100 * o / n)}%`).join("  "),
  ` | ${(fieldMs / nField).toFixed(1)} ms/recognize, ${(fieldMs / secs.length).toFixed(0)} ms/frame`);
await w.terminate();
