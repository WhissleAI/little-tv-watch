#!/usr/bin/env python3
"""alert_timing.py run.log : when each alert fired relative to its sentence's final text (negative = before it)."""
import re, statistics, sys
ev = []
for line in open(sys.argv[1], errors="ignore"):
    m = re.match(r"(TV|ALERT)\s+(\d+\.\d+) (.*)", line)
    if m:
        ev.append((m.group(1), float(m.group(2)), m.group(3)[:60]))
finals = [t for k, t, _ in ev if k == "TV"]
d = []
for k, t, title in ev:
    if k == "ALERT":
        nxt = [f for f in finals if f >= t - 0.05]   # the sentence it belongs to: the next final (or this one)
        if nxt and nxt[0] - t < 25:
            d.append((t - nxt[0], title))
for x, title in d:
    print(f"  {x:+6.2f} s  {title}")
if d:
    print(f"alerts {len(d)}, median {statistics.median(x for x, _ in d):+.2f} s vs the final; "
          f"earliest {min(x for x, _ in d):+.2f} s")
