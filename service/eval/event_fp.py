#!/usr/bin/env python3
"""How often each sound event fires on the eval clips (speech, crowd babble; no real cheering): false-fire rate."""
import json, os, subprocess, sys, wave
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
HERE = os.path.dirname(os.path.abspath(__file__))
ARC = os.path.join(os.path.dirname(HERE), "arc_tv_mac")
MODEL = sys.argv[1]
clips = [(c, f) for c in ("clean", "crowd", "near") for f in sorted(os.listdir(os.path.join(HERE, "wav", c)))]


def run(cf):
    c, f = cf
    pcm = wave.open(os.path.join(HERE, "wav", c, f)).readframes(10 ** 9) + b"\0" * 32000
    out = subprocess.run(["taskpolicy", "-b", ARC, MODEL, "--domain", "nba", "--threads", "2", "--partial-ms", "-1"],
                         input=pcm, capture_output=True).stdout
    return c, len(pcm) / 32000, [json.loads(x)["label"] for x in out.splitlines() if b'"event"' in x]


with ThreadPoolExecutor(4) as ex:
    res = list(ex.map(run, clips))
for cond in ("clean", "crowd", "near"):
    rs = [r for r in res if r[0] == cond]
    mins = sum(r[1] for r in rs) / 60
    cnt = Counter(l for r in rs for l in r[2])
    print(f"{cond:6s} {len(rs)} clips, {mins:.1f} min: " + ", ".join(f"{k} {v}" for k, v in cnt.most_common()))
