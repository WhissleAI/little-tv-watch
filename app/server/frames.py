"""TV Watch frame server (SIMULATOR-ONLY): the Little simulator's app stage as a JPEG, for the scoreboard reader
when a YouTube player is on screen (the page may not read that player's pixels: it is another origin).

  python3 server/frames.py            # :8093;  vite proxies /frame/* here, so the page reads it same-origin
  GET /frame/start   start grabbing (scgrab, ~2 fps, nice 10: ScreenCaptureKit never starts under taskpolicy -b)
  GET /frame/stop    stop
  GET /frame/latest.jpg   the newest 1920x1080 stage (404 until the first grab)
The grabber stops by itself 20 s after the last frame request, so a page that went away costs nothing."""
import os
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
GRAB = os.path.join(HERE, "scgrab", "scgrab")
OUT = os.path.join(HERE, "scgrab", "frame.jpg")
STATE = {"proc": None, "last_req": 0.0}
LOCK = threading.Lock()


def start():
    with LOCK:
        p = STATE["proc"]
        if p and p.poll() is None:
            return "running"
        if os.path.exists(OUT):
            os.remove(OUT)
        STATE["proc"] = subprocess.Popen(["nice", "-n", "10", GRAB, OUT, "Little · dev", "2"],
                                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return "started"


def stop():
    with LOCK:
        p = STATE["proc"]
        if p and p.poll() is None:
            p.terminate()
        STATE["proc"] = None


def reaper():
    while True:
        time.sleep(5)
        if STATE["proc"] and time.time() - STATE["last_req"] > 20:
            stop()


class Web(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, code, body, ctype):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?")[0]
        STATE["last_req"] = time.time()
        if path == "/frame/start":
            return self.send(200, start().encode(), "text/plain")
        if path == "/frame/stop":
            stop()
            return self.send(200, b"stopped", "text/plain")
        if path == "/frame/latest.jpg":
            if not STATE["proc"] or STATE["proc"].poll() is not None:
                start()
            try:
                data = open(OUT, "rb").read()
            except OSError:
                return self.send(404, b"no frame yet", "text/plain")
            return self.send(200, data, "image/jpeg")
        self.send(404, b"", "text/plain")


if __name__ == "__main__":
    threading.Thread(target=reaper, daemon=True).start()
    print("frames on :8093", flush=True)
    ThreadingHTTPServer(("127.0.0.1", 8093), Web).serve_forever()
