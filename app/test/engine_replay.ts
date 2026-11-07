// node test/engine_replay.ts — the in-page engine against the same checks as tvwatch/test_replay.py: a real Arc
// recording of the NBA demo clip (stitching, early alerts, rules, memory, recap), a commercial break, the roster
// guard on Arc's bias, and the scoreboard's events.
import { readFileSync, readdirSync } from "node:fs";
import { Engine, type Rule, type Tag } from "../src/engine/engine.ts";

const D = new URL("../src/engine/defaults/", import.meta.url);
const rules: Rule[] = JSON.parse(readFileSync(new URL("rules.json", D), "utf8"));
const rosters = Object.fromEntries(readdirSync(new URL("rosters/", D)).map(f => [f.replace(".txt", ""), readFileSync(new URL(`rosters/${f}`, D), "utf8")]));
const mem = new Map<string, string>();
const store = { get: (k: string) => mem.get(k) ?? null, set: (k: string, v: string) => void mem.set(k, v) };
const recs = JSON.parse(readFileSync(new URL("../../tvwatch/eval/partials_w7.json", import.meta.url), "utf8"));

let ok = true;
const t = new Engine({ store, domain: "nba", rules: [...rules, { id: "curry", type: "name", name: "Stephen Curry", cooldown_s: 120 }],
  names: readFileSync(new URL("names.txt", D), "utf8"), rosters });
t.rosterForms = () => new Set();   // the clip is Warriors-Lakers, not tonight's Knicks-Spurs roster
const updates: any[] = [];
t.on((kind, data) => { if (kind === "alert_update") updates.push(data); });
t.memory.ctx_written = 1e18;
let longest = 0;
for (const rec of recs) {
  t.handle(rec);
  longest = Math.max(longest, t.state.partial.split(/\s+/).filter(Boolean).length);
}
const titles = t.state.alerts.map(a => a.title);
const checks: Record<string, boolean> = {
  "3 sentences": t.state.lines.length === 3,
  "score 102-100": JSON.stringify(t.state.score) === "[102,100]",
  "clock 1:45": t.state.clock === 105,
  "Curry alert": titles.some(x => x.includes("Stephen Curry")),
  "timeout alert": titles.some(x => x.toLowerCase().includes("time out")),
  "score alert": titles.some(x => x.startsWith("Score 102 – 98")),
  "recap": t.catchup().sentences === 3,
  "live line grows past one window": longest > 25,
  "early alerts cleaned by their final": updates.length >= 2 && !JSON.stringify(updates).includes("DeV"),
};
const bad = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
console.log("replay:", bad.length ? "FAILED " + bad.join(", ") : "ok", `(${titles.length} alerts)`);
ok &&= !bad.length;

// a commercial break: the game, 80 s of ads, then the game again -> one "game is back" alert, and none before
let fired: string[] = [];
t.fire = (r: Rule) => { fired.push(r.id ?? ""); };
let clock = 1e9;
t.now = () => clock;
Object.assign(t.state, { score: null, clock: null, last_game: clock });
const script: [string, number][] = [["Stephen Curry hits the three, Warriors lead 88 to 85.", 0], ["Fifty percent off at Mattress Mart.", 40],
  ["Ask your doctor if it is right for you.", 40], ["And we're back. LeBron James brings it up.", 40], ["LeBron James with the layup.", 10]];
for (const [text, dt] of script) { clock += dt; t.checkRules({ text, tags: [] }); }
const breakOk = fired.filter(x => x === "back").length === 1;
console.log("break:", breakOk ? "ok" : `FAILED ${fired}`);
ok &&= breakOk;

// a watchlist star who isn't in tonight's game must not pull Arc's decoder
t.rosterForms = () => new Set(["jalen brunson", "brunson", "new york knicks", "knicks"]);
const bias = t.biasPhrases([{ type: "name", name: "Stephen Curry" }, { type: "name", name: "Brunson" }],
  [["Stephen Curry", ["Stephen Curry", "Curry"]], ["Jalen Brunson", ["Jalen Brunson", "Brunson"]]]);
const rosterOk = !bias.includes("Curry") && !bias.includes("Stephen Curry") && bias.includes("Brunson");
console.log("roster:", rosterOk ? "ok" : `FAILED ${bias}`);
ok &&= rosterOk;

// the scoreboard: the first reading sets the board, a jump of 3 is a three, credited to the player just heard
fired = [];
t.fire = (_r: Rule, title: string) => { fired.push(title); };
t.rosterForms = () => new Set();
Object.assign(t.state, { score: null, clock: null, clock_label: null });
t.memory.lines.push([clock, { time: "", text: "Brunson pulls up from deep.", tags: [{ tag: "ENTITY_PERSON", text: "Brunson" } as Tag] }]);
t.onOcr({ score: [79, 83], teams: ["NY", "SA"], period: "4TH", clock: "5:18" });
const first = [...fired];
clock += 5;
t.onOcr({ score: [82, 83], teams: ["NY", "SA"], period: "4TH", clock: "4:58" });
const f = t.facts();
const boardOk = !first.length && fired.some(x => x.startsWith("Three! Brunson · NY 82 – 83 SA")) && t.state.clock_label === "4TH 4:58"
  && t.scoreText() === "NY 82 – 83 SA" && f.points_by_player_heard["Brunson"]?.points === 3 && f.scoring_plays.at(-1).what === "Three";
console.log("board:", boardOk ? "ok" : `FAILED first=${first} fired=${fired} clock=${t.state.clock_label} ${t.scoreText()}`);
ok &&= boardOk;
process.exit(ok ? 0 : 1);
