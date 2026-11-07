#!/usr/bin/env python3
"""lagbench.py CLIP ARGS... : feed CLIP to arc_tv at real-time speed; print each final's lag (wall clock behind the
utterance end) and the run's throttle flags. Lag is what the phone sees after someone stops talking."""
import json, os, resource, subprocess, sys, threading, time, wave
clip, extra = sys.argv[1], sys.argv[2:]
here = os.path.dirname(os.path.abspath(__file__))
p = subprocess.Popen([os.path.join(here, "arc_tv"), os.path.expanduser("~/arc/models/mini"), "--domain", "nba",
                      "--names", os.path.join(here, "names.txt")] + extra,
                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
t0 = None
def feed():
    global t0
    w = wave.open(clip); t0 = time.time(); n = 0
    while True:
        c = w.readframes(1600)
        if not c: break
        p.stdin.write(c); p.stdin.flush(); n += 1
        d = t0 + n * 0.1 - time.time()
        if d > 0: time.sleep(d)
    p.stdin.write(b"\0" * 32000 * 2); p.stdin.close()
threading.Thread(target=feed, daemon=True).start()
parts = 0
for raw in p.stdout:
    r = json.loads(raw)
    if r["k"] == "partial": parts += 1
    if r["k"] == "final":
        print(f"  final #{r['id']} end {r['end']:5.1f}s  lag {time.time() - t0 - r['end']:5.2f}s")
p.wait()
ru = resource.getrusage(resource.RUSAGE_CHILDREN)
print(f"  cpu {(ru.ru_utime + ru.ru_stime) / (time.time() - t0) * 100:.0f}% of one core")
print(f"  partials {parts}, throttled {subprocess.run(['vcgencmd','get_throttled'],capture_output=True,text=True).stdout.strip()}, {subprocess.run(['vcgencmd','measure_temp'],capture_output=True,text=True).stdout.strip()}")
