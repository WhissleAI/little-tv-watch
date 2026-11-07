// node test/local_backend.ts — the local backend answers main.ts's /api calls and streams /api/events like tvwatch
import { readFileSync } from "node:fs";
import { Engine, type ArcRec } from "../src/engine/engine.ts";
import { createLocalBackend } from "../src/engine/local.ts";

const D = new URL("../src/engine/defaults/", import.meta.url), mem = new Map<string, string>();
let pushed = 0, restarts = 0;
const arc = { push: (p: Int16Array) => { pushed += p.length; }, restart: () => { restarts++; },
  transcribeOnce: async (): Promise<ArcRec[]> => [{ k: "final", text: "How many points does Brunson have?", intent: "discourse.intent.qa_factoid", tags: [] }] };
const engine = new Engine({ store: { get: k => mem.get(k) ?? null, set: (k, v) => void mem.set(k, v) }, domain: "nba", arc,
  rules: JSON.parse(readFileSync(new URL("rules.json", D), "utf8")), names: readFileSync(new URL("names.txt", D), "utf8"),
  rosters: { nba: readFileSync(new URL("rosters/nba.txt", D), "utf8") } });
const be = createLocalBackend(engine);
const post = (p: string, body: unknown) => be.fetch(p, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }).then(r => r.json());
const seen: string[] = [];
const es = be.EventSource("api/events");
for (const k of ["hello", "state", "alert", "final"]) es.addEventListener(k, e => seen.push(`${k}:${JSON.parse((e as MessageEvent).data).score_text ?? JSON.parse((e as MessageEvent).data).title ?? ""}`));
await new Promise(r => setTimeout(r, 5));
const checks: Record<string, boolean> = {};
await post("api/sport", { domain: "nba" });
await post("api/roster", { domain: "nba", names: "Jalen Brunson|person|Brunson\nNew York Knicks|team|Knicks" });
await post("api/reset", {});
await post("api/rules", { type: "name", name: "Brunson", cooldown_s: 120, sports: ["nba"] });
await be.fetch("api/pcm", { method: "POST", body: new Int16Array(4000).buffer as ArrayBuffer });
engine.handle({ k: "final", id: 1, text: "Brunson pulls up from deep.", tags: [{ tag: "ENTITY_PERSON", text: "Brunson", wb: 0, we: 1 }] });
await post("api/ocr", { score: [79, 83], teams: ["NY", "SA"], period: "4TH", clock: "5:18" });
await post("api/ocr", { score: [82, 83], teams: ["NY", "SA"], period: "4TH", clock: "4:58" });
const st = await (await be.fetch("api/state")).json(), facts = await (await be.fetch("api/facts")).json(), cu = await (await be.fetch("api/catchup")).json();
const ask = await (await be.fetch("api/ask", { method: "POST", body: new Int16Array(16000).buffer as ArrayBuffer })).json();
checks["state: session, score, teams, rule active"] = st.session === 1 && st.score_text === "NY 82 – 83 SA" && st.teams?.[0] === "NY" && st.active.some((id: string) => id?.startsWith("r"));
checks["facts: Brunson credited 3"] = facts.points_by_player_heard?.Brunson?.points === 3;
checks["catch-up: moments"] = cu.moments.some((m: any) => m.title.startsWith("Three! Brunson"));
checks["ask: heard via local Arc + facts"] = ask.heard.text.startsWith("How many") && ask.facts.score === "NY 82 – 83 SA";
checks["pcm reached Arc; roster/reset restarted Arc"] = pushed === 4000 && restarts >= 2;
checks["events: hello first, then state/alert/final"] = seen[0]?.startsWith("hello") && seen.some(s => s.startsWith("alert:Three! Brunson")) && seen.some(s => s.startsWith("final"));
checks["unknown route 404"] = (await be.fetch("api/nope")).status === 404;
const bad = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
console.log("local backend:", bad.length ? "FAILED " + bad.join("; ") : `ok (${Object.keys(checks).length} checks)`);
es.close();
process.exit(bad.length ? 1 : 0);
