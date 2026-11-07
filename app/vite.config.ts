import { defineConfig } from "vite";

// base: "./" — a Little app must load from a CDN/bucket prefix, not just an origin root,
// or root-absolute asset URLs 404 once published. allowedHosts: tunnels change per run.
// /api goes to TV Watch (tvwatch.py --listen), which runs Arc next to the simulator; /little-answers to
// server/answers.ts, so Little's answers endpoint is same-origin with the app.
export default defineConfig({
  base: "./",
  server: {
    host: "0.0.0.0", port: 7140, strictPort: true, allowedHosts: true,
    // cross-origin isolation, so Arc can run on several threads in the page (SharedArrayBuffer); `credentialless`
    // keeps YouTube's player and thumbnails loading (its iframe also carries the credentialless attribute)
    headers: process.env.TVW_ISOLATE === "0" ? {} : {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "credentialless",
    },
    proxy: {
      "/api": { target: "http://127.0.0.1:8080", changeOrigin: true },
      // Little answers (score / catch_up / now_playing, watch actions): server/answers.ts, `npm run answers`
      "/little-answers": { target: "http://127.0.0.1:7150", changeOrigin: true },
      // SIMULATOR-ONLY: the app stage grabbed from the simulator window (server/frames.py), so the scoreboard reader
      // can see a YouTube player, whose pixels the page may not read itself
      "/frame": { target: "http://127.0.0.1:8093", changeOrigin: true },
    },
  },
});
