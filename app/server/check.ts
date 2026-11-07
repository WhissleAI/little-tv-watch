// Contract check without the simulator: the declaration, then each query's live response, through the SDK's own
// validators (the same ones `little dev answers` uses). npm run answers must be running.
import { validateAnswerProvider, validateAnswerRequest, validateAnswerResponse } from "@kabletv/little-sdk/server";
import manifest from "../public/little/manifest.json" with { type: "json" };

const decl = validateAnswerProvider(manifest.answers);
console.log("declaration ok:", decl.queries?.map((q: { name: string }) => q.name), (manifest.answers.actions ?? []).map(a => a.name));
for (const [query, args] of [["score", {}], ["catch_up", {}], ["now_playing", {}], ["game_facts", {}],
                             ["game_facts", { question: "how many points does Brunson have?" }]] as const) {
  const body = { version: 1, requestId: `check-${query}`, query, args, presentationVersion: 1, locale: "en-US", timeZone: "America/Los_Angeles" };
  const q = decl.queries.find((x: { name: string }) => x.name === query)!;
  const request = validateAnswerRequest(body, q);
  const r = await fetch(process.env.ANSWERS_URL ?? "http://127.0.0.1:7140/little-answers",
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json = await r.json();
  const v = validateAnswerResponse(json, q, request, manifest.launchSchema);
  const out = json.ready ? "ready" : json.empty ? "empty" : Object.keys(json).join(",");
  console.log(query.padEnd(12), r.status, out, JSON.stringify(json.ready?.data ?? {}).slice(0, 220), `✓ valid, ${v.content.length} card(s)`);
}
