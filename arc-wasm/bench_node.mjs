// node bench_node.mjs st|mt clip.pcm [threads]: Arc in WebAssembly, the model in its memory FS, the clip as fast as it goes
import fs from "fs";
import path from "path";
const [mode = "st", pcmPath = "clip60.pcm", th = "1"] = process.argv.slice(2);
const { default: ArcModule } = await import(`./arc_${mode}.mjs`);
const M = await ArcModule();
const src = (process.env.ARC_MODEL || "models/mini-tv");
function put(rel) {
  const p = fs.realpathSync(path.join(src, rel));
  if (fs.statSync(p).isDirectory()) {
    M.FS.mkdirTree("/model/" + rel);
    for (const f of fs.readdirSync(p)) put(path.join(rel, f));
  } else M.FS.writeFile("/model/" + rel, fs.readFileSync(p));
}
M.FS.mkdirTree("/model");
for (const f of fs.readdirSync(src)) put(f);
const t0 = performance.now();
const ok = M.ccall("arcw_open", "number", ["string", "number", "string", "number", "number", "number", "string", "string"],
  ["/model", +th, "nba", 1000, 7, 0.2, "", ""]);
if (ok) throw new Error("arcw_open failed");
const tLoad = performance.now() - t0;
const pcm = new Int16Array(fs.readFileSync(pcmPath).buffer.slice(0));
const buf = M._malloc(1600 * 2);
let out = "";
const t1 = performance.now();
for (let i = 0; i < pcm.length; i += 1600) {
  const chunk = pcm.subarray(i, i + 1600);
  M.HEAP16.set(chunk, buf >> 1);
  M.ccall("arcw_push", "number", ["number", "number"], [buf, chunk.length]);
  out += M.UTF8ToString(M.ccall("arcw_take", "number", [], []));
}
M.ccall("arcw_finish", null, [], []);
out += M.UTF8ToString(M.ccall("arcw_take", "number", [], []));
const secs = (performance.now() - t1) / 1000, audio = pcm.length / 16000;
fs.writeFileSync(`wasm_${mode}_t${th}.jsonl`, out);
console.log(JSON.stringify({ mode, threads: +th, load_s: +(tLoad / 1000).toFixed(2), audio_s: audio, wall_s: +secs.toFixed(2),
  rtf: +(secs / audio).toFixed(3), finals: (out.match(/"k":"final"/g) || []).length }));
process.exit(0);
