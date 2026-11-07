// node test/tagger_parity.ts — the page's Arc Tagger (src/tagger.ts, run here by onnxruntime-node) against the C
// server (arc-tagger-c arctag_server on :8090) on 20 commentary lines: spans, events and read-outs must match.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { ArcTagger } from "../src/tagger.ts";

const ort = createRequire(import.meta.url)("onnxruntime-node");
const M = new URL("../public/arctag/", import.meta.url);
const t = await ArcTagger.create(ort, new URL("arctag.onnx", M).pathname, JSON.parse(readFileSync(new URL("arctag_meta.json", M), "utf8")),
  JSON.parse(readFileSync(new URL("tokenizer.json", M), "utf8")));
const lines: [string, string][] = [
  ["nba", "Brunson drives, kicks it out to Hart, and he buries the three! Knicks cut the lead to one, 82 to 83."],
  ["nba", "Stephen Curry brings it up, pulls up from deep, and he hits the three."],
  ["nba", "The Warriors now lead the Lakers one hundred and two to ninety eight with one minute forty five left in the game."],
  ["nba", "Timeout on the floor. Golden State has scored eight straight."],
  ["nba", "Wemby fakes, drives, and throws it down! What a play by Victor Wembanyama."],
  ["nba", "Karl-Anthony Towns picks up his sixth personal foul, and he's out of the game."],
  ["soccer", "Saka cuts inside, shoots, and it's a goal! Arsenal lead Chelsea two to one in the seventy eighth minute."],
  ["soccer", "That's a red card for Chelsea! They will have to play the final ten minutes with ten men."],
  ["soccer", "Into the ninetieth minute now, and there will be four minutes of added time."],
  ["soccer", "Odegaard with the free kick... over the wall and in! Arsenal 3, Bournemouth 2!"],
  ["nfl", "Mahomes finds Kelce in the end zone, touchdown Kansas City! The Chiefs lead the Bills 24 to 20."],
  ["nfl", "Josh Allen is picked off! Interception at the forty yard line, with one minute fifty left."],
  ["nfl", "The Bills will settle for a field goal attempt from thirty eight yards out."],
  ["nhl", "McDavid splits the defence, shoots, scores! Edmonton ties it at five with 4:40 to go in overtime."],
  ["nhl", "Power play for Florida, Tkachuk in the box for two minutes for roughing."],
  ["cricket", "Bumrah to Konstas, that's edged and taken at slip! Australia are 9 for 1."],
  ["cricket", "Kohli drives it through the covers for four, India 142 for 6 after 32 overs."],
  ["cricket", "That's a huge six over long on, and Smith brings up his century!"],
  ["talk", "Joining us now is the head coach, welcome to the show. How do you rate tonight's performance?"],
  ["news", "Breaking news this evening: a magnitude five earthquake has been reported near San Jose, California."],
];
let maxDiff = 0;
const close = (a: any, b: any, path = ""): string | null => {
  if (typeof a === "number" && typeof b === "number") { maxDiff = Math.max(maxDiff, Math.abs(a - b)); return Math.abs(a - b) <= 1e-4 ? null : `${path}: ${a} vs ${b}`; }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${path}: length ${a.length} vs ${b.length}`;
    for (let i = 0; i < a.length; i++) { const d = close(a[i], b[i], `${path}[${i}]`); if (d) return d; }
    return null;
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
    if (ka.join() !== kb.join()) return `${path}: keys ${ka} vs ${kb}`;
    for (const k of ka) { const d = close(a[k], b[k], `${path}.${k}`); if (d) return d; }
    return null;
  }
  return a === b ? null : `${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
};
let same = 0, ms = 0;
for (const [dom, text] of lines) {
  const ref = await (await fetch("http://127.0.0.1:8090/tag", { method: "POST", body: JSON.stringify({ text, domain: dom }) })).json();
  const t0 = performance.now(), got = await t.tag(text, dom);
  ms += performance.now() - t0;
  const d = close(got, ref);
  if (d) console.log(`DIFF ${dom}: ${text.slice(0, 50)}… ${d}`); else same++;
}
console.log(`tagger parity: ${same}/${lines.length} identical (every span, event and read-out; largest probability gap ${maxDiff.toExponential(1)}: ONNX Runtime 1.31 vs the C server's 1.20), ${(ms / lines.length).toFixed(1)} ms/line in Node`);
process.exit(same === lines.length ? 0 : 1);
