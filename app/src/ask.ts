import type { LittleApp } from "@kabletv/little-sdk";

// "Ask about the game": the viewer presses Ask and speaks. Arc (TV Watch's own ears, domain "assistant") writes the
// question down and tags it; TV Watch answers from what it knows about this game (the scoreboard's plays, who was
// credited, ties, runs, who was talked about); Little's own model words the answer and the TV says it.

type Facts = Record<string, unknown>;
type Heard = { text: string; intent?: string | null };

const $ = (id: string) => document.getElementById(id)!;

// Record one question: stops 1.2 s after the viewer stops talking, after 8 s, or on a second press.
async function record(app: LittleApp, ac: AudioContext, stopSignal: { stop?: () => void }) {
  let stream: MediaStream, release: () => void;
  if (app.can("media.mic")) {
    const r = await app.media.mic({ echoCancellation: true, noiseSuppression: true });
    if (!r.ok) throw new Error(r.error?.code ?? "mic declined");
    stream = r.stream;
    release = () => r.stop();
  } else {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    release = () => stream.getTracks().forEach(t => t.stop());
  }
  const src = ac.createMediaStreamSource(stream);
  const proc = ac.createScriptProcessor(4096, 1, 1);
  const sink = ac.createGain();
  sink.gain.value = 0;
  const ratio = ac.sampleRate / 16000, chunks: Int16Array[] = [];
  let pos = 0, spoke = false, quietSince = performance.now();
  const t0 = performance.now();
  return new Promise<Int16Array>(resolve => {
    const done = () => {
      proc.disconnect();
      src.disconnect();
      release();
      const all = new Int16Array(chunks.reduce((n, c) => n + c.length, 0));
      let o = 0;
      for (const c of chunks) { all.set(c, o); o += c.length; }
      resolve(all);
    };
    stopSignal.stop = done;
    proc.onaudioprocess = ev => {
      const x = ev.inputBuffer.getChannelData(0), out: number[] = [];
      let peak = 0;
      for (; pos < x.length; pos += ratio) {
        const v = x[Math.floor(pos)];
        peak = Math.max(peak, Math.abs(v));
        out.push(Math.max(-32768, Math.min(32767, v * 32767)));
      }
      pos -= x.length;
      chunks.push(Int16Array.from(out));
      const now = performance.now();
      if (peak > 0.04) { spoke = true; quietSince = now; }
      $("ask-level").style.width = `${Math.min(100, peak * 400)}%`;
      if ((spoke && now - quietSince > 1200) || now - t0 > 8000) done();
    };
    src.connect(proc);
    proc.connect(sink).connect(ac.destination);
  });
}

export async function answer(app: LittleApp, question: string, facts: Facts) {
  const r = await app.compose({
    instruction: "You are TV Watch, the viewer's friend on the couch. Answer their question about the game in one or two "
      + "short spoken sentences, using only the facts given (the broadcast's scoreboard and the live commentary, which "
      + "has recognition errors). Per-player points from the scoreboard (points_by_player_heard) are credited from the "
      + "commentary: say 'by my count'. If the scoreboard credited nobody, use scoring_heard_in_commentary and "
      + "scoring_plays_heard: say 'by the commentary, X has scored the most (N baskets I heard)'. Otherwise fall back "
      + "to most_talked_about and recent_commentary and say what was heard. Never answer 'I don't know' when there is "
      + "commentary; never invent stats.",
    schema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] },
    context: { question, facts },
  }).catch(() => null);
  return r?.ok ? (r.data as { answer: string }).answer : "";
}

export function setupAsk(app: LittleApp, audioContext: () => AudioContext, duck: (on: boolean) => void) {
  const btn = $("ask") as HTMLButtonElement, card = $("ask-card");
  const sig: { stop?: () => void } = {};
  let busy = false, hide = 0;
  const show = (q: string, a: string, state: string) => {
    $("ask-q").textContent = q;
    $("ask-a").textContent = a;
    card.dataset.state = state;
    card.classList.add("on");
    clearTimeout(hide);
    if (state === "done") hide = window.setTimeout(() => card.classList.remove("on"), 15000);
  };
  async function ask() {
    if (busy) { sig.stop?.(); return; }   // a second press: that's the whole question
    busy = true;
    btn.classList.add("rec");
    duck(true);
    try {
      show("Listening…", "", "listening");
      const pcm = await record(app, audioContext(), sig);
      btn.classList.remove("rec");
      show("…", "", "thinking");
      const r: { heard: Heard; facts: Facts } = await fetch("api/ask", { method: "POST", body: new Blob([pcm.slice()]) }).then(x => x.json());
      const q = r.heard.text;
      if (!q) { show("I didn't catch that.", "Press Ask and try again.", "done"); return; }
      show(`“${q}”`, "", "thinking");
      const a = await answer(app, q, r.facts);
      show(`“${q}”`, a || "I couldn't work that out from the game so far.", "done");
      app.emit("asked", { question: q, intent: r.heard.intent, answer: a });
      if (a && app.can("voice.say")) await app.voice.say(a);
    } catch (e) {
      show("The microphone isn't available.", String(e), "done");
    } finally {
      busy = false;
      btn.classList.remove("rec");
      duck(false);
    }
  }
  btn.addEventListener("click", () => void ask());
  return ask;
}
