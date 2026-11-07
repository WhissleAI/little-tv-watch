# TV Watch: 3-minute demo

**Pitch.** TV Watch is a Little TV app. Arc listens to the game and reads the broadcast's own scoreboard, so the
score is always right, every basket or goal is called with the player who made it, and you can ask the TV about the
game.

## Before you start

1. Start the service: `cd service && python3 tvwatch.py --listen --arc <arc_tv> --model <arc-model> --dry-run --port 8080`.
2. Start the app: `cd app && little dev` (simulator), or `little dev --device <tv>` (a paired Little TV).
3. Check that `curl -s localhost:8080/api/state` returns JSON.

## Demo flow

You can speak each line to the TV, or send it from a second terminal with `little dev say "…"`.

1. **"Play the Knicks comeback."** The game plays with live captions. Names are highlighted, and the score box fills
   in from the broadcast's own scoreboard.
2. **The scoreboard moves, the TV speaks:** "Basket Brunson · NY 83 – 83 SA · tied!". The scorer comes from what Arc
   heard; the points come from the scoreboard.
3. **"Tell me whenever Wembanyama is mentioned."** He appears under ★ Watching, and the next "Wemby…" sends an
   alert.
4. **"Who has scored the most points?"** The game turns down and the TV answers from the game so far.
5. **"Show me the highlights."** The big moments replay with REPLAY cards, then the live game resumes.
6. **"What did I miss?"** A recap card, written by Little's own model from the moments and the commentary.
7. **"Play the Arsenal late winner."** 2–2 in stoppage time, then "⚽ Goal! · ARS 3 – 2 BOU".
8. **Back** returns to the start screen; Back again leaves the app.

## What to say about it

- **Small models, each doing one thing, fused:**
  - Arc hears the game;
  - Arc Tagger tags the text;
  - little OCR reads the scoreboard;
  - the director calls plays from audio when there's no scoreboard.

  The scoreboard owns the points and the clock; Arc says who did it.
- **On-device:** no audio goes to a cloud speech service. The OCR runs in the TV app itself, and the same goes for
  Arc and the tagger when the app runs in its standalone mode.
- **Known limits:**
  - A new broadcaster's scoreboard needs its boxes measured once.
  - Arc can mishear in heavy crowd noise; low-confidence live lines are held back.

## If something breaks

| Symptom | Fix |
|---|---|
| Captions say "Connecting to Arc…" | The service isn't running (step 1). |
| The score box stays "– : –" | The broadcast's scoreboard isn't on screen yet, or hasn't read steadily yet. Wait a few seconds. |
| The assistant doesn't react | Call the tool directly: `little dev call ask_game '{"question":"…"}'`. |
| A clip won't play on the TV | The TV needs H.264 video; re-encode the clip. |
