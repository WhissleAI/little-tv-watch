// Watch on YouTube: any public game, in YouTube's own embedded player (its terms allow embedding; nothing is
// downloaded). The page can't hear or see inside that player (another origin), so Arc listens through the TV's
// microphone, as it would to any TV, and the scoreboard comes from the commentary instead of OCR.

type YTPlayer = {
  playVideo(): void; pauseVideo(): void; destroy(): void; seekTo(s: number, allow: boolean): void;
  getCurrentTime(): number; setVolume(v: number): void; getPlayerState(): number; getDuration(): number;
};
type YTApi = { Player: new (el: HTMLElement | string, opts: Record<string, unknown>) => YTPlayer };
declare global { interface Window { YT?: YTApi; onYouTubeIframeAPIReady?: () => void } }

export type YTResult = { id: string; title: string; channel: string; thumb?: string; live: boolean; sport?: string | null };

let api: Promise<YTApi> | null = null;
function loadApi() {
  api ??= new Promise(resolve => {
    if (window.YT?.Player) return resolve(window.YT);
    window.onYouTubeIframeAPIReady = () => resolve(window.YT!);
    const s = document.createElement("script");
    s.src = "https://www.youtube.com/iframe_api";
    document.head.appendChild(s);
  });
  return api;
}

let player: YTPlayer | null = null, ready = false;
// The player's methods only exist once YouTube says it's ready; before that (and after destroy) every call is a no-op.
const call = <T>(f: (p: YTPlayer) => T, fallback: T): T => {
  try { return player && ready ? f(player) : fallback; } catch { return fallback; }
};

export async function search(q: string, live = false): Promise<YTResult[]> {
  const r = await fetch(`api/yt/search?q=${encodeURIComponent(q)}&live=${live ? 1 : 0}`).then(x => x.json()).catch(() => ({}));
  return r.results ?? [];
}

// Plays a video full-screen behind TV Watch's own overlays; resolves once it is playing (or failed).
export async function play(id: string, onEnd: () => void): Promise<string> {
  stop();
  const YT = await loadApi();
  // The iframe is ours, so it can carry `credentialless`: under the cross-origin isolation Arc's threads need, a
  // player without it wouldn't load. YouTube's API then attaches to it.
  const host = document.getElementById("yt")!;
  const vars = new URLSearchParams({ enablejsapi: "1", autoplay: "1", controls: "0", rel: "0", modestbranding: "1", playsinline: "1",
    iv_load_policy: "3", cc_load_policy: "0", disablekb: "1", origin: location.origin, widget_referrer: location.href });
  const frame = document.createElement("iframe");
  frame.id = "yt-player";
  frame.setAttribute("credentialless", "");
  frame.allow = "autoplay; encrypted-media";
  frame.width = "1920";
  frame.height = "1080";
  frame.src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}?${vars}`;
  host.innerHTML = "";
  host.appendChild(frame);
  // "Video unavailable" inside the player often comes with no error event (an owner blocking TVs, or an embed it
  // won't serve to this page): a video that isn't PLAYING within 8 s counts as unplayable, so the next one is tried.
  return new Promise(resolve => {
    let settled = false;
    const done = (err: string) => { if (!settled) { settled = true; clearTimeout(watchdog); resolve(err); } };
    const watchdog = window.setTimeout(() => done("not playing after 8 s (blocked on this device?)"), 8000);
    player = new YT.Player(frame, {
      events: {
        onReady: () => { ready = true; player?.setVolume(100); player?.playVideo(); },
        onError: (e: { data: number }) => done(`YouTube error ${e.data}`),   // 100 gone, 101/150 no embedding, 152/153 embed config
        onStateChange: (e: { data: number }) => {
          if (e.data === 1) done("");   // playing
          if (e.data === 0) onEnd();
        },
      },
    });
  });
}

export function stop() {
  ready = false;
  try { player?.destroy(); } catch { /* already gone */ }
  player = null;
  const host = document.getElementById("yt");
  if (host) host.innerHTML = "";
}

export const active = () => player != null;
export const time = () => call(p => p.getCurrentTime() || 0, 0);
export const seek = (s: number) => call(p => p.seekTo(Math.max(0, s), true), undefined);
export const volume = (v: number) => call(p => p.setVolume(Math.round(v * 100)), undefined);
export const resume = () => call(p => p.playVideo(), undefined);
export const duration = () => call(p => p.getDuration() || 0, 0);
export const paused = () => call(p => p.getPlayerState() === 2, true);   // 2: paused
export const pause = () => call(p => p.pauseVideo(), undefined);
