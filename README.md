# TV Watch

A game companion for the [Little](https://little.co) TV. **Arc** listens to the game and the app reads the
broadcast's own scoreboard. You get:

- live captions with players and teams highlighted;
- a score and clock that match the broadcast;
- a call-out for every basket, goal, touchdown or wicket, naming who made it, with ties, lead changes and scoring
  runs;
- the TV's own assistant answering questions about the game ("who has scored the most?", "when did they tie it?",
  "what did I miss?");
- automatic highlights you can replay;
- a watchlist of players ("tell me whenever Wembanyama is mentioned").

It works on recorded games, on YouTube games, and on whatever the TV's microphone hears.

## How it fits together

```
 Little TV (or the Little simulator)                         Mac / small box beside it
 ┌───────────────────────────────────────────────┐          ┌──────────────────────────────────────┐
 │ TV Watch (app/: a Little app, Vite + TS)       │  audio   │ service/tvwatch.py                   │
 │ • plays a game: clip, YouTube, or the TV mic   │ ───────▶ │ • Arc transcriber (libarc, on-device) │
 │ • little OCR reads the broadcast's scoreboard  │  board   │ • fuses Arc + scoreboard + Arc Tagger │
 │   (per-broadcaster glyph templates, in-page)   │ ───────▶ │ • alert rules, watchlist, sessions    │
 │ • captions, score box, alerts, highlights      │ ◀─────── │ • game facts, catch-up, highlights    │
 │ • Little SDK: tools, answers, voice, ducking   │  events  └──────────────────────────────────────┘
 └───────────────────────────────────────────────┘
   app/src/engine/ is the same service logic ported to TypeScript, with Arc (arc-wasm/), Arc Tagger (ONNX in the
   page) and the director running in the page: the TV then needs nothing beside it.
```

### Components

| Part | Where | What it does |
|---|---|---|
| **Arc transcriber** | `service/` (native) or `arc-wasm/` (WebAssembly in a Web Worker) | Streaming speech recognition with inline tags: people, teams, numbers, scores, clocks, plus per-frame event heads. |
| **Arc Tagger** | `app/src/tagger.ts` (ONNX Runtime Web) | Tags each finished sentence: entities, score spans, sports events, intents. |
| **little OCR** | `app/src/board.ts`, `app/src/glyphs.ts`, `ocr/` | Reads the broadcast's scoreboard. Each field (scores, clock, period) is its own box per broadcaster, read with tiny glyph templates learned from Tesseract-labelled crops. Majority rules per side: a score only goes up, by at most one play, and needs repeated reads; corrections are silent. |
| **Director** | `director/`, `app/src/director3.ts` | A small streaming Mamba-3 model (under 500k parameters) that calls scoring events from audio and commentary when no scoreboard is visible (YouTube or mic mode). Trained with scoreboard changes as labels. |
| **Engine** | `service/tvwatch.py`, `app/src/engine/` | Fusion: the scoreboard owns the score and clock, Arc says who did it. Rules, sessions (one game, one memory), game facts and catch-up, profanity masking. |
| **Little integration** | `app/public/little/manifest.json`, `app/src/main.ts`, `app/server/answers.ts` | 11 tools the TV's assistant calls (`play_demo`, `watch_player`, `ask_game`, `catch_up`, `highlights`, `watch_youtube`, `seek`, …). Answers for when the app is closed (score, catch-up, game facts). `voice.say` call-outs. The game audio turns down while anyone talks. Recaps and answers are written by Little's own model (`app.compose`). |
| **Phone companion** | `android/` | Optional Android app that follows the same service and pushes alerts. |

## Measured

- **little OCR on the Little TV:** a full scoreboard read takes about 0.05–0.2 s (Tesseract.js took about 20 s on
  the same TV).
- **Score changes followed** on 19 verified broadcast clips: 122 of 148 (Tesseract path: 82 of 148).
- **Arc in WebAssembly:** transcripts identical to native Arc. It runs at a real-time factor of 0.29 single-threaded
  and 0.15 with 3 threads in Chrome on an Apple M-series Mac.
- **The TV's assistant, mid-game:** "who has scored the most?" → "By my count, Brunson has scored the most so far,
  with 3 points off a basket and a free throw."

## Running it

You need:
- Node 22+ and Python 3.11+;
- the Little CLI (`@kabletv/little-cli`, on GitHub Packages; `NODE_AUTH_TOKEN` must be a GitHub token with
  `read:packages`);
- a Little developer account;
- the Arc model and runtime (see **Models and clips**).

```sh
# 1. the service (Arc + fusion), on the machine beside the TV
cd service && python3 tvwatch.py --listen --arc /path/to/arc_tv --model /path/to/arc-model --domain nba --dry-run --port 8080

# 2. the app, in the Little simulator
cd app && npm install && little login && little dev

# 3. or on a real Little TV (Settings → Developer → Pair a computer)
little device pair <CODE> --name den
little dev --device den
```

- The microphone, Web Workers with threads and offline storage need a secure page. Serve the app over https
  (`little dev --device den --app-url https://…`). The origin must be verified with `little domains`.
- The Arc Tagger server (`ARCTAG_URL`, default `http://127.0.0.1:8090`) is optional for the service; in the page,
  the tagger runs in ONNX Runtime Web.
- YouTube search reads `YOUTUBE_API_KEY` from the environment or from `TVW_ENV_FILE`.

## Models and clips

This repository contains code only:
- **Arc, Arc Tagger and the director:** the weights, and libarc for `arc-wasm/`, are not included. Contact
  WhissleAI.
- **Game clips:** bring your own, legally obtained. `ocr/catalog/*.json` holds the metadata the app expects:
  scoreboard layout, teams, roster and verified score changes. `ocr/build_catalog.py` builds the catalog from it.
- **OCR glyph templates:** rebuild with `ocr/glyphs/extract.mjs <clip-id>`, then `node ocr/glyphs/lo.mjs build`.
- **Tesseract language data:** download `eng.traineddata.gz` into `app/public/tess/`.

## Layout

```
app/        the Little TV app (TypeScript, Vite) + answers server
service/    tvwatch.py: Arc + scoreboard fusion, rules, sessions (Python); tests in test_replay.py
arc-wasm/   Arc in WebAssembly (wrapper + build script; libarc separately)
director/   the Mamba-3 director: features, training, export, parity
ocr/        little OCR training tools, scoreboard eval, catalog metadata
android/    phone companion
```

See [DEMO.md](DEMO.md) for a 3-minute demo script. Licence: see [LICENSE.md](LICENSE.md).
