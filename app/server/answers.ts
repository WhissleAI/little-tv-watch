// TV Watch answers: lets the TV's own agent answer "what's the score?", "what did I miss?" and "what's on?",
// and add or drop a watched player, while the TV Watch app is closed. It reads the live state of tvwatch.py
// (Arc next to the TV) and serves Little's answers protocol at /little-answers.
//
//   npm run answers          (port 7150; vite proxies /little-answers to it, so it is same-origin with the app)
//   little dev answers --json ; little dev answers score '{}' --json ; little dev actions --json
import { createServer } from "node:http";
import { answerField, createAnswerHandler, createVerifier, type AnswerOutcome } from "@kabletv/little-sdk/server";
import manifest from "../public/little/manifest.json" with { type: "json" };

type Json = number | string | boolean | null | Json[] | { [k: string]: Json };

const TVWATCH = process.env.TVWATCH_URL ?? "http://127.0.0.1:8080";
const PORT = Number(process.env.ANSWERS_PORT ?? 7150);

type Rule = { id: string; type: string; name?: string };
type State = {
  domain: string; score: number[] | null; score_text: string | null; clock_label: string | null; status: string;
  sports: Record<string, string>; rules: Rule[]; active: string[]; lines: { text: string }[];
};

async function tv<T>(path: string, signal: AbortSignal, body?: unknown): Promise<T> {
  const r = await fetch(TVWATCH + path, body === undefined ? { signal } :
    { signal, method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`tvwatch ${path}: ${r.status}`);
  return r.json() as Promise<T>;
}

type Facts = {
  sport: string; teams: string[]; score: string | null; clock: string | null; score_source: string;
  scoring_plays: { clock: string | null; score: string; what: string; by: string | null; team: string }[];
  points_by_player_heard: Record<string, { points: number; plays: number }>; note: string;
  ties: number; lead_changes: number; biggest_lead: Record<string, number>;
  most_talked_about: { name: string; mentions: number }[]; recent_commentary: string; watching: string[];
  scoring_heard_in_commentary?: Record<string, { heard_scores: number; heard_points: number }>;
};
// words that pick a part of game_facts out of the viewer's question
const PARTS = ["tie", "lead", "when", "play", "point", "scor", "how many", "talk", "mention", "said", "say", "comment", "run", "happen"];

const cut = (s: string | null | undefined, n: number) => (s ?? "").slice(0, n);
const listening = (s: State) => s.status.startsWith("listening");
const launch = (s: State) => ({ sport: ["nba", "nfl", "nhl", "soccer", "cricket", "esports", "news", "talk"].includes(s.domain) ? s.domain : "nba" });
const watching = (s: State) => s.rules.filter(r => r.type === "name" && r.name && s.active.includes(r.id)).map(r => r.name!).slice(0, 20);
// "NY 82 – 83 SA" (teams come only from the on-screen scoreboard) vs "82 – 83" (said by the commentator)
function board(s: State) {
  const m = (s.score_text ?? "").match(/^([A-Z]{2,12}) (\d+) – (\d+) ([A-Z]{2,12})$/);
  return m ? { team_a: m[1], points_a: +m[2], points_b: +m[3], team_b: m[4] } : null;
}
function fresh(seconds: number) {
  const now = new Date();
  return { fetchedAt: now.toISOString(), expiresAt: new Date(now.getTime() + seconds * 1000).toISOString(), quality: "observed" as const };
}
const rev = (...parts: unknown[]) => JSON.stringify(parts).replace(/[^\w:–-]/g, "").slice(0, 120) || "none";

const handler = createAnswerHandler({
  declaration: manifest.answers,
  launchSchema: manifest.launchSchema,
  verifier: createVerifier({ apiUrl: process.env.LITTLE_API_URL ?? "https://api.little.co", appId: "tv-watch",
    allowSandbox: process.env.LITTLE_ALLOW_SANDBOX !== "0" }),   // sandbox calls are `little dev actions`; set 0 in production
  timeoutMs: 4000,
  onError: e => console.warn("answers", e.kind, e.name, e.error),
  handlers: {
    score: async (_req, { signal }): Promise<AnswerOutcome> => {
      const s = await tv<State>("/api/state", signal);
      const b = board(s);
      const data: { [k: string]: Json } = {
        sport: s.domain, sport_name: cut(s.sports[s.domain] ?? s.domain, 60), listening: listening(s),
        source: b ? "scoreboard" : s.score ? "commentary" : "none", launch: launch(s),
      };
      if (s.score_text) data.score_text = cut(s.score_text, 80);
      if (b) Object.assign(data, b, { leader: b.points_a === b.points_b ? "tied" : b.points_a > b.points_b ? b.team_a : b.team_b });
      else if (s.score) Object.assign(data, { points_a: s.score[0], points_b: s.score[1] });
      if (s.clock_label) data.clock = cut(s.clock_label, 40);
      if (s.lines[0]?.text) data.last_line = cut(s.lines[0].text, 400);
      if (!s.score && !listening(s))
        return { empty: { revision: rev("idle", s.domain), freshness: fresh(30) } };
      return {
        ready: {
          revision: rev(s.domain, s.score_text, s.clock_label), data, freshness: fresh(30),
          content: s.score_text ? [{
            id: "score", kind: "metric", titleRef: answerField("sport_name"),
            facts: [{ label: "Score", format: "text", valueRef: answerField("score_text") },
                    ...(s.clock_label ? [{ label: "Clock", format: "text" as const, valueRef: answerField("clock") }] : [])],
            launchParamsRef: answerField("launch"),
          }] : [{ id: "status", kind: "status", titleRef: answerField("sport_name"), launchParamsRef: answerField("launch"),
                  ...(data.last_line ? { textRef: answerField("last_line") } : {}) }],
        },
      };
    },
    catch_up: async (_req, { signal }): Promise<AnswerOutcome> => {
      const [s, c] = await Promise.all([tv<State>("/api/state", signal),
        tv<{ minutes: number; score_text: string | null; recap: string | null; moments: { time: string; title: string; body?: string }[];
             top: { name: string; kind: string; count: number }[] }>("/api/catchup", signal)]);
      const data: { [k: string]: Json } = {
        sport: s.domain, sport_name: cut(s.sports[s.domain] ?? s.domain, 60), minutes: Math.min(1440, c.minutes),
        moments: c.moments.slice(0, 10).map(m => ({ time: cut(m.time, 8), title: cut(m.title, 160), ...(m.body ? { detail: cut(m.body, 400) } : {}) })),
        talked_about: c.top.slice(0, 8).map(t => ({ name: cut(t.name, 80), kind: cut(t.kind, 20), mentions: t.count })),
        launch: launch(s),
      };
      if (c.score_text) data.score_text = cut(c.score_text, 80);
      if (c.recap) data.recap = cut(c.recap, 1200);
      if (!c.minutes && !c.moments.length)
        return { empty: { revision: rev("nothing", s.domain), freshness: fresh(60) } };
      return {
        ready: {
          revision: rev(s.domain, c.minutes, c.moments.length, c.score_text), data, freshness: fresh(60),
          content: (data.moments as Json[]).slice(0, 6).map((_, i) => ({
            id: `m${i}`, kind: "item", titleRef: answerField("moments", i, "title"),
            facts: [{ label: "Time", format: "text", valueRef: answerField("moments", i, "time") }],
            launchParamsRef: answerField("launch"),
          })),
        },
      };
    },
    game_facts: async (req, { signal }): Promise<AnswerOutcome> => {
      const [s, f] = await Promise.all([tv<State>("/api/state", signal), tv<Facts>("/api/facts", signal)]);
      const q = String((req.args as { question?: string }).question ?? "").toLowerCase();
      // The question only narrows the reply; with none, or one that matches nothing, every part comes back.
      const want = (...words: string[]) => !q || !PARTS.some(p => q.includes(p)) || words.some(w => q.includes(w));
      const opt = (k: string, v: string | null | undefined, n: number) => (v ? { [k]: cut(v, n) } : {});
      const data: { [k: string]: Json } = {
        sport: cut(f.sport, 60), teams: f.teams.slice(0, 2).map(t => cut(t, 40)), ...opt("score", f.score, 80), ...opt("clock", f.clock, 40),
        score_source: cut(f.score_source, 60),
        scoring_plays: want("tie", "lead", "when", "play", "score", "basket", "goal", "three", "run", "happen") ?
          f.scoring_plays.slice(-25).map(p => ({ score: cut(p.score, 80), what: cut(p.what, 60), team: cut(p.team, 40),
                                                 ...opt("clock", p.clock, 40), ...opt("by", p.by, 80) })) : [],
        // with no scoreboard to credit from (YouTube, a TV heard through the mic), the scoring the commentators described
        players_heard: want("point", "scor", "has", "how many", "who", "best", "top", "most", "lead") ?
          (Object.keys(f.points_by_player_heard).length
            ? Object.entries(f.points_by_player_heard).map(([name, v]) => ({ name: cut(name, 80), points: v.points, plays: v.plays }))
            : Object.entries(f.scoring_heard_in_commentary ?? {}).map(([name, v]) => ({ name: cut(name, 80), points: v.heard_points, plays: v.heard_scores })))
            .slice(0, 20) : [],
        credit_note: cut(Object.keys(f.points_by_player_heard).length
          ? f.note || "Per-player points are credited to the player named in the commentary just before each score: a guess, not official stats."
          : "No scoreboard read: these are scoring plays the commentators described, credited to the player named with them — an estimate from what was heard, not official stats. Say 'by the commentary'.", 300),
        ties: f.ties, lead_changes: f.lead_changes,
        biggest_lead: Object.entries(f.biggest_lead).slice(0, 2).map(([team, points]) => ({ team: cut(team, 40), points: Math.max(0, points) })),
        most_talked_about: want("talk", "mention", "who", "about") ? f.most_talked_about.slice(0, 8).map(t => ({ name: cut(t.name, 80), mentions: t.mentions })) : [],
        watching: f.watching.slice(0, 20).map(n => cut(n, 80)),
        launch: launch(s),
      };
      if (want("said", "say", "comment", "talk", "happen", "who", "most", "best")) Object.assign(data, opt("recent_commentary", f.recent_commentary, 2500));
      return {
        ready: {
          revision: rev(f.score, f.clock, f.scoring_plays.length, q.length), data, freshness: fresh(30),
          content: f.score ? [{ id: "facts", kind: "metric", titleRef: answerField("sport"), launchParamsRef: answerField("launch"),
                                facts: [{ label: "Score", format: "text", valueRef: answerField("score") },
                                        { label: "Lead changes", format: "number", valueRef: answerField("lead_changes") },
                                        { label: "Ties", format: "number", valueRef: answerField("ties") }] }] : [],
        },
      };
    },
    now_playing: async (_req, { signal }): Promise<AnswerOutcome> => {
      const s = await tv<State>("/api/state", signal);
      const data: { [k: string]: Json } = {
        sport: s.domain, sport_name: cut(s.sports[s.domain] ?? s.domain, 60), listening: listening(s),
        status: cut(s.status, 120), watching: watching(s), launch: launch(s),
      };
      if (s.lines[0]?.text) data.last_line = cut(s.lines[0].text, 400);
      return {
        ready: {
          revision: rev(s.domain, s.status, s.lines[0]?.text?.length), data, freshness: fresh(30),
          content: [{ id: "now", kind: "status", titleRef: answerField("sport_name"), launchParamsRef: answerField("launch"),
                      ...(data.last_line ? { textRef: answerField("last_line") } : {}) }],
        },
      };
    },
  },
  actions: {
    watch_player: {
      invoke: async ({ input }, { signal }) => {
        const name = String((input as { name: string }).name).trim();
        const s0 = await tv<State>("/api/state", signal);
        if (!watching(s0).some(n => n.toLowerCase() === name.toLowerCase()))
          await tv("/api/rules", signal, { type: "name", name, cooldown_s: 120 });
        const s = await tv<State>("/api/state", signal);
        return { done: { data: { name, watching: watching(s) } } };
      },
    },
    unwatch_player: {
      invoke: async ({ input }, { signal }) => {
        const want = String((input as { name: string }).name).trim().toLowerCase();
        const s0 = await tv<State>("/api/state", signal);
        const r = s0.rules.find(x => x.type === "name" && x.name && x.name.toLowerCase().includes(want));
        if (r) await tv("/api/rules/delete", signal, { id: r.id });
        const s = await tv<State>("/api/state", signal);
        return { done: { data: { removed: !!r, watching: watching(s) } } };
      },
    },
  },
});

// node:http <-> fetch Request/Response
createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const url = `http://${req.headers.host ?? "127.0.0.1"}${req.url}`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (v != null) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
  const r = await handler(new Request(url, { method: req.method, headers, body: req.method === "GET" || req.method === "HEAD" ? undefined : Buffer.concat(chunks) }));
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(Buffer.from(await r.arrayBuffer()));
}).listen(PORT, "127.0.0.1", () => console.log(`TV Watch answers on http://127.0.0.1:${PORT}/little-answers (tvwatch: ${TVWATCH})`));
