// director3.ts (the app's runtime, bundled to /tmp/d3.mjs) vs PyTorch's recurrent step on a held-out game:
// node parity3.mjs <director3.json> <parity3_TAG.json>  -> max |p_ts - p_torch| and per-step latency
import fs from "fs";
import { Director3 } from "/tmp/d3.mjs";
const m = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const fx = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
const d = new Director3(m);
let maxd = 0;
const t0 = performance.now();
fx.rows.forEach((row, i) => {
  const c = d.step(row, fx.tokens[i], fx.sport);
  maxd = Math.max(maxd, Math.abs(c.p - fx.p[i]));
});
const ms = (performance.now() - t0) / fx.rows.length;
console.log(`clip ${fx.clip}: ${fx.rows.length} steps, max |p_ts - p_torch| = ${maxd.toExponential(2)}, ${ms.toFixed(2)} ms per step (Node, ${m.params} params)`);
