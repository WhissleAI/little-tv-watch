"""Locate the score bug and label scoring events from Vision OCR (ds/<id>.vis.jsonl, every 2nd second).
Locate: cluster every bare number (1-3 digits) by position; the two clusters that read often, mostly go up and take
several values, side by side or stacked, are the scores; a m:ss / s.t cluster near them is the clock.
Label: per frame, the number nearest each score cluster; board.ts Side rules (only up, at most one play's worth, a new
value twice in a row); the board restarts with no event where the game clock jumps (a montage cut) or a value that
breaks the rule reads steadily 5 times. -> layouts/<id>.json, ds/<id>.events.json
python visboard.py <id> [sport]"""
import json, re, sys
import numpy as np

cid = sys.argv[1]; sport = sys.argv[2] if len(sys.argv) > 2 else re.sub(r"\d+$", "", re.sub(r"^v2", "", cid))
STEP = {"nba": 4, "nfl": 8, "nhl": 2, "soccer": 2, "cricket": 7}[sport]
MAXV = {"nba": 200, "nfl": 80, "nhl": 15, "soccer": 15, "cricket": 600}[sport]
MIND = {"nba": 6, "nfl": 3, "nhl": 2, "soccer": 2, "cricket": 3}[sport]
KIND = {"nba": {1: "free_throw", 2: "basket", 3: "three"},
        "nfl": {6: "touchdown", 7: "touchdown", 8: "touchdown", 3: "field_goal", 1: "extra_point", 2: "two_points"},
        "nhl": {1: "goal", 2: "goal"}, "soccer": {1: "goal", 2: "goal"}, "cricket": {}}[sport]
NUM = re.compile(r"^\d{1,3}$"); CLK = re.compile(r"(\d{1,2}):(\d{2})(?!\d)|(?<![\d:])(\d{1,2})\.(\d)(?!\d)")
frames = []
for l in open(f"ds/{cid}.vis.jsonl"):
    d = json.loads(l); t = int(d["f"].split("/")[-1][:5]) - 1
    frames.append((t, [(w[0].strip(), w[1], (w[2] + w[4]) / 2, (w[3] + w[5]) / 2, w[5] - w[3]) for w in d["w"]]))
frames.sort()

clusters = []
for t, ws in frames:
    for txt, conf, cx, cy, h in ws:
        kind = "num" if NUM.match(txt) else "clock" if CLK.search(txt) else None
        if not kind or h < 0.015: continue
        for c in clusters:
            if c["k"] == kind and abs(c["cx"] - cx) < 0.045 and abs(c["cy"] - cy) < 0.02:
                c["r"].append((t, txt)); n = len(c["r"]); c["cx"] += (cx - c["cx"]) / n; c["cy"] += (cy - c["cy"]) / n; break
        else:
            clusters.append({"k": kind, "cx": cx, "cy": cy, "r": [(t, txt)]})


def scoreish(c):
    by = {}
    for t, v in c["r"]: by.setdefault(t, int(v))
    v = [by[t] for t in sorted(by)]
    if len(v) < max(8, 0.15 * len(frames)): return -1
    d = np.diff(v); ch = d[d != 0]
    up = (ch > 0).mean() if len(ch) else 0
    if len(set(v)) < MIND or up < 0.5 or np.median(v) > MAXV: return -1   # misreads must not disqualify
    return len(v) / len(frames) * up


nums = sorted([c for c in clusters if c["k"] == "num" and scoreish(c) > 0], key=lambda c: -scoreish(c))
pair = None
for i, a in enumerate(nums):
    for b in nums[i + 1:]:
        if (abs(a["cy"] - b["cy"]) < 0.05 and abs(a["cx"] - b["cx"]) < 0.4) or (abs(a["cx"] - b["cx"]) < 0.05 and abs(a["cy"] - b["cy"]) < 0.15):
            pair = (a, b); break
    if pair: break
out = {}
if not pair:
    json.dump(out, open(f"layouts/{cid}.json", "w"))
    json.dump({"clip": cid, "sport": sport, "seconds": len(frames) * 2, "readable": 0, "events": [], "cuts": 0, "cut_times": [],
               "rule": "visboard: no score bug found"}, open(f"ds/{cid}.events.json", "w"))
    print(cid, sport, "NO BUG FOUND", flush=True); sys.exit(0)
a, b = sorted(pair, key=lambda c: (round(c["cy"], 1), c["cx"]))
clock = None
cl = [c for c in clusters if c["k"] == "clock" and len(c["r"]) > 0.15 * len(frames)
      and min(abs(c["cy"] - a["cy"]), abs(c["cy"] - b["cy"])) < 0.1]
if cl: clock = max(cl, key=lambda c: len(c["r"]))
out = {"a": [a["cx"], a["cy"]], "b": [b["cx"], b["cy"]], "clock": [clock["cx"], clock["cy"]] if clock else None}
json.dump(out, open(f"layouts/{cid}.json", "w"))


NEED = int(__import__("os").environ.get("NEED", "1"))   # Vision reads boards almost without error: one read counts


class Side:
    def __init__(s): s.value = s.cand = s.bad = None; s.seen = s.badN = 0; s.since = 0; s.rebase = False
    def feed(s, v, t):
        if v is None: return None
        if s.rebase:   # just after a montage cut: the first value read is the new baseline, no event
            s.rebase = False
            if v != s.value: s.value, s.seen, s.cand, s.badN = v, 0, None, 0; return None
        if v == s.value: s.seen = 0; s.badN = 0; return None
        if s.value is not None and not (v > s.value and v - s.value <= STEP):
            s.badN = s.badN + 1 if v == s.bad else 1; s.bad = v
            if s.badN >= 5: s.value, s.badN, s.seen, s.cand = v, 0, 0, None; return "restart"
            return None
        s.badN = 0
        if v != s.cand: s.since = t
        s.seen = s.seen + 1 if v == s.cand else 1; s.cand = v
        if s.seen < NEED: return None
        old, s.value, s.seen = s.value, v, 0
        return ("moved", old)


def near(ws, c, kind):
    best, bd = None, 1e9
    for txt, conf, cx, cy, h in ws:
        if abs(cx - c["cx"]) > 0.05 or abs(cy - c["cy"]) > 0.03: continue
        if kind == "num" and NUM.match(txt) and int(txt) <= MAXV: v = int(txt)
        elif kind == "clock":
            m = CLK.search(txt)
            if not m: continue
            v = int(m[1]) * 60 + int(m[2]) if m[1] else int(m[3])
        else: continue
        dd = abs(cx - c["cx"]) + abs(cy - c["cy"])
        if dd < bd: best, bd = v, dd
    return best


sides = [Side(), Side()]; events, cuts = [], []; readable = 0; last = None
for t, ws in frames:
    raw = [near(ws, a, "num"), near(ws, b, "num")]
    if clock:
        cs = near(ws, clock, "clock")
        if cs is not None:
            if last:
                dg, dt = cs - last[0], t - last[1]
                ok = (-2 <= dg <= dt + 2) if sport == "soccer" else (-dt - 2 <= dg <= 2)
                if not ok:
                    cuts.append(t)
                    for sd in sides: sd.rebase = True
            last = (cs, t)
    if None not in raw: readable += 1
    for i, sd in enumerate(sides):
        r = sd.feed(raw[i], t)
        if r == "restart": cuts.append(t)
        elif r and r[1] is not None:
            dv = sd.value - r[1]
            events.append({"t": sd.since, "side": i, "from": r[1], "to": sd.value, "kind": KIND.get(dv, f"+{dv}")})
json.dump({"clip": cid, "sport": sport, "seconds": frames[-1][0] + 1, "readable": readable, "events": events, "cuts": len(cuts),
           "cut_times": sorted(cuts), "layout": out, "rule": "visboard.py: Vision OCR every 2 s, nearest number to each score cluster, board.ts Side rules, clock-jump and steady-restart cuts"},
          open(f"ds/{cid}.events.json", "w"), indent=1)
print(cid, sport, f"{readable}/{len(frames)} readable", len(events), "events", len(cuts), "cuts", " ".join(f"{e['t']}:{e['kind']}" for e in events[:20]), flush=True)
