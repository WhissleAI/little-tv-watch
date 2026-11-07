// The scoreboard on YouTube. SIMULATOR-ONLY: the page may not read pixels from YouTube's player (another origin),
// and on a real Little TV an app can't capture the screen. In the simulator the Mac grabs the window
// (server/frames.py + server/scgrab, ~2 fps, served on our own origin at frame/latest.jpg), and this module:
//   1. works out which broadcaster's scoreboard is on screen by trying every layout we have measured (the demo
//      catalog's clips plus the built-in ones; broadcasters reuse their graphics, and league channels on YouTube post
//      the same networks' feeds) and keeping the one whose fields read as a score, a clock and a period, the same
//      one three looks in a row. Offline on the catalog's frames: 32 right, 0 wrong, 14 not yet (board hidden or
//      half read on that frame); a free search of the whole strip with OCR was 5 right, 14 wrong, so it isn't used.
//   2. reads it every second with board.ts's own rules (watchBoard: Side, Steady, gaps, corrections, clocks), by
//      handing it a canvas that passes for a playing video and the chosen layout through newGame().
// A broadcaster we have never measured gets no scoreboard: the score then comes from the commentary, as in mic mode.
import { newGame, readFields, watchBoard, LAYOUTS, type Reading } from "./board";

type Box = [number, number, number, number];
type Layout = { id: string; sport: string; boxes: Record<string, Box> };

const W = 1920, H = 1080;
const canvas = document.createElement("canvas");
canvas.width = W;
canvas.height = H;
const g = canvas.getContext("2d", { willReadFrequently: true })!;

// watchBoard reads a video; this canvas passes for one, paused until a layout is chosen (so no boxes read a
// broadcast they weren't measured on).
const asVideo = canvas as unknown as HTMLVideoElement & { paused: boolean };
Object.defineProperties(asVideo, {
  videoWidth: { value: W }, videoHeight: { value: H }, readyState: { value: 4 },
  currentSrc: { value: "youtube-frame" }, paused: { value: true, writable: true },
});

async function grab(): Promise<boolean> {
  const img = new Image();
  img.src = `frame/latest.jpg?t=${Date.now()}`;
  try { await img.decode(); } catch { return false; }
  g.drawImage(img, 0, 0, W, H);
  return true;
}

let known: Promise<Layout[]> | null = null;
function layouts() {
  known ??= Promise.all([
    fetch("catalog/catalog.json").then(r => r.json()).catch(() => ({ clips: [] })),
    fetch("board_layouts.json").then(r => r.json()).catch(() => ({ layouts: [] })),   // measured off YouTube broadcasts
  ]).then(([c, extra]) => {
    const out: Layout[] = Object.entries(LAYOUTS).map(([sport, boxes]) => ({ id: `builtin-${sport}`, sport, boxes }));
    for (const l of extra.layouts ?? []) out.push({ id: l.id, sport: l.sport, boxes: l.boxes });
    for (const clip of c.clips ?? []) if (clip.layout && Object.keys(clip.layout).length) out.push({ id: clip.id, sport: clip.sport, boxes: clip.layout });
    return out;
  });
  return known;
}

// How well one look at a layout reads: both sides of the score (4), a clock or overs (2), a period (1), both names (1).
async function fit(l: Layout, sport: string) {
  const r = await readFields(asVideo, l.boxes, sport);
  const both = r.sides.length === 2 && r.sides.every(x => x != null);
  let s = both ? 4 : 0;
  if (r.clock || r.overs) s += 2;
  if (r.period) s += 1;
  if (r.teams?.[0] && r.teams?.[1]) s += 1;
  return { l, s, key: both ? r.sides.join("-") : "" };
}

// The best layout for this frame: this sport's first (cheaper, and the right one when it fits), then the rest.
async function look(sport: string) {
  const all = await layouts(), mine = all.filter(l => l.sport === sport), rest = all.filter(l => l.sport !== sport);
  let best: Awaited<ReturnType<typeof fit>> | null = null;
  for (const group of [mine, rest]) {
    for (const l of group) {
      const f = await fit(l, sport);
      if (!best || f.s > best.s) best = f;
    }
    if (best && best.s >= 7) break;   // a full read in the sport's own layouts: no need to try other sports'
  }
  return best && best.s >= 4 ? best : null;
}

export function startYouTubeBoard(sport: () => string, onReading: (r: Reading) => void) {
  // The grab is of the Mac's own screen: only the simulator (served from this Mac's loopback) can use it. On a real
  // television it would read the wrong picture, so the score comes from the commentary there.
  if (!["127.0.0.1", "localhost"].includes(location.hostname)) {
    console.log("[tvwatch] youtube board: off on a real television (the screen grab is simulator-only)");
    return () => {};
  }
  let alive = true, chosen: Layout | null = null, lastRead = Date.now(), streak: string[] = [];
  void fetch("frame/start").catch(() => {});
  asVideo.paused = true;
  const stopBoard = watchBoard(asVideo, sport, r => { lastRead = Date.now(); onReading(r); });
  console.log("[tvwatch] youtube board: matching the broadcast's scoreboard (simulator screen grab)");
  const frames = window.setInterval(() => { if (alive && chosen) void grab(); }, 1000);
  void (async () => {
    while (alive) {
      // look until one layout wins three looks in a row (four when it reads no clock); look again when the chosen
      // board has read nothing for 45 s (a new graphic, another broadcaster after a cut)
      if (!chosen || Date.now() - lastRead > 45000) {
        if (await grab()) {
          const b = await look(sport()).catch(e => { console.log(`[tvwatch] youtube board: ${e}`); return null; });
          streak = b ? [...streak, b.l.id].slice(-4) : [];
          const need = b && b.s >= 6 ? 3 : 4;
          if (b && streak.length >= need && streak.slice(-need).every(id => id === b.l.id) && chosen?.id !== b.l.id) {
            chosen = b.l;
            newGame(b.l.boxes);   // watchBoard starts over on it (Side, Steady, clocks), as for a new clip
            lastRead = Date.now();
            asVideo.paused = false;
            console.log(`[tvwatch] youtube board: using ${b.l.id}'s layout (${b.l.sport}), read ${b.key}`);
          }
        }
      }
      await new Promise(res => setTimeout(res, chosen ? 5000 : 1500));
    }
  })();
  return () => {
    alive = false;
    asVideo.paused = true;
    clearInterval(frames);
    stopBoard();
    void fetch("frame/stop").catch(() => {});
  };
}
