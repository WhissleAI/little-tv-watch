"""Director v2 features, per second, from what the app has live at that second:
* dense: every Arc frame head (max over the second, kept only when >= FLOOR, x: heads only with XHEADS=1), speech,
  text counts (words / persons / score tags / numbers in the newest partial or final), Arc Tagger on finals, sport.
* text: the last 8 words of the newest partial or final Arc emitted in that second, as unigrams and bigrams hashed
  (FNV-1a 32-bit) into V buckets; the app has the same words live (the stitched partial line / the final).
Labels: the scoreboard (label_board.mjs). A second is positive when a board change lands in (s-6, s+3]: the play is
before the board moves and the commentary about it comes around it. Around montage cuts there is no target (-1).
-> ds/f2_<TAG>.npz + spec2_<TAG>.json"""
import json, os, re, sys
import numpy as np
SPORTS = ["nba", "nfl", "nhl", "soccer", "cricket"]
FLOOR = float(os.environ.get("FLOOR", "0.2")); XHEADS = os.environ.get("XHEADS", "0") == "1"
TAG = os.environ.get("TAG", "live"); V = int(os.environ.get("V", "8192")); LAST = 8
clips = sys.argv[1:]
sport = lambda c: re.sub(r"\d+$", "", re.sub(r"^v2", "", c))
WORD = re.compile(r"[a-z0-9']+")


def fnv(s):
    h = 0x811C9DC5
    for b in s.encode():
        h = ((h ^ b) * 0x01000193) & 0xFFFFFFFF
    return h


def tokens(text, kind):   # kind "p" (partial) or "f" (final)
    w = WORD.findall(text.lower())[-LAST:]
    toks = [f"{kind}:{x}" for x in w] + [f"{kind}:{a}_{b}" for a, b in zip(w, w[1:])]
    return sorted({fnv(t) % V for t in toks})


def recs(c):
    out = []
    for l in open(f"ds/{c}.arc.jsonl"):
        try: out.append(json.loads(l))
        except ValueError: pass
    return out


labels, tagev = set(), set()
R = {c: recs(c) for c in clips}
for c in clips:
    for r in R[c]:
        if r["k"] == "frame":
            labels |= {k for k, p in r["p"].items() if (XHEADS or not k.startswith("x:"))}
    if os.path.exists(f"ds/{c}.tag.jsonl"):
        for l in open(f"ds/{c}.tag.jsonl"):
            tagev |= {k for k in json.loads(l)["events"] if k.startswith("event.sports")}
labels, tagev = sorted(labels), sorted(tagev)
CNT = ["txt:words", "txt:person", "txt:score_tag", "txt:number", "txt:clock_tag", "txt:final"]
names = [f"arc:{x}" for x in labels] + ["arc:speech"] + CNT + [f"tag:{x}" for x in tagev] + ["tag:score_span", "tag:person"] \
    + [f"sport:{s}" for s in SPORTS]
ix = {n: i for i, n in enumerate(names)}
KIND = {"free_throw": 0, "extra_point": 0, "two_points": 0, "basket": 1, "goal": 1, "touchdown": 2, "four": 1,
        "three": 2, "field_goal": 1, "six": 2, "wicket": 1}
out = {}
for c in clips:
    rs = R[c]
    n = int(max(r["t"] for r in rs)) + 1
    x = np.zeros((n, len(names)), np.float32); sp = np.zeros(n); cnt = np.zeros(n)
    toks = [[] for _ in range(n)]
    for r in rs:
        s = int(r["t"])
        if s >= n: continue
        if r["k"] == "frame":
            keep = {k: p for k, p in r["p"].items() if p >= FLOOR and (XHEADS or not k.startswith("x:"))}
            if not keep: continue   # arc_tv prints a frame only when a head reaches the floor
            for k, p in keep.items():
                j = ix.get(f"arc:{k}")
                if j is not None: x[s, j] = max(x[s, j], p)
            sp[s] += r.get("sp", 0); cnt[s] += 1
        elif r["k"] in ("partial", "final") and r.get("text", "").strip():
            fin = r["k"] == "final"
            toks[s] = tokens(r["text"], "f" if fin else "p")   # the newest line this second wins
            w = WORD.findall(r["text"].lower())[-LAST:]
            row = np.zeros(len(CNT), np.float32)
            row[0] = len(w); row[5] = 1.0 if fin else 0.0
            for t in r.get("tags", []):
                k = {"ENTITY_PERSON": 1, "NUMBER_SCORE": 2, "NUMBER_CLOCK": 4}.get(t["tag"])
                if k: row[k] += 1
                if t["tag"].startswith("NUMBER"): row[3] += 1
            x[s, ix[CNT[0]]:ix[CNT[0]] + len(CNT)] = np.log1p(row)
    x[:, ix["arc:speech"]] = sp / np.maximum(cnt, 1)
    if os.path.exists(f"ds/{c}.tag.jsonl"):
        for l in open(f"ds/{c}.tag.jsonl"):
            r = json.loads(l); s = int(r["t"])
            if s >= n: continue
            for k, p in r["events"].items():
                if f"tag:{k}" in ix: x[s, ix[f"tag:{k}"]] = max(x[s, ix[f"tag:{k}"]], p)
            x[s, ix["tag:score_span"]] = np.log1p(r["score_span"]); x[s, ix["tag:person"]] = np.log1p(r["person"])
    x[:, ix[f"sport:{sport(c)}"]] = 1
    ev = json.load(open(f"ds/{c}.events.json"))
    events = [e for e in ev["events"] if e["t"] < n - 3]
    y = np.zeros(n, np.float32); kind = np.full(n, -1)
    for c0 in ev.get("cut_times", []):
        y[max(0, c0 - 6):min(n, c0 + 3)] = -1
    # a broadcast whose board OCR could not follow the score must not teach "no events here": unlabelled, not negative
    MIN_RATE = {"nba": 1.0, "nfl": 0.15, "nhl": 0.15, "soccer": 0.08, "cricket": 0.0}[sport(c)]
    if ev.get("readable", 1) == 0 or (c.startswith("v2") and len(events) / max(1, n / 60) < MIN_RATE):
        y[:] = -1; events = []
        print(f"  {c}: board not followed ({len(ev['events'])} events, {ev.get('readable')} readable) -> unlabelled")
    for e in events:
        lo, hi = max(0, e["t"] - 6), min(n, e["t"] + 3)
        y[lo:hi] = 1; kind[lo:hi] = KIND.get(e["kind"], 1)
    off = np.cumsum([0] + [len(t) for t in toks]).astype(np.int64)
    out[f"x_{c}"] = x; out[f"y_{c}"] = y; out[f"k_{c}"] = kind; out[f"e_{c}"] = np.array([e["t"] for e in events])
    out[f"to_{c}"] = off; out[f"ti_{c}"] = np.array([i for t in toks for i in t], np.int64)
    print(f"{c:10s} {n:6d} s {len(events):4d} events", flush=True)
np.savez(f"ds/f2_{TAG}.npz", **out)
json.dump({"names": names, "clips": clips, "sports": SPORTS, "frame_floor": FLOOR, "x_heads": XHEADS, "V": V, "last_words": LAST,
           "hash": "fnv1a32(kind + ':' + token) % V; tokens = last 8 words [a-z0-9']+, unigrams + bigrams (a_b); kind p/f",
           "target": "1 when a board change lands in (s-6, s+3]", "kinds": ["one_point", "score", "big_score"]},
          open(f"spec2_{TAG}.json", "w"), indent=1)
print(len(names), "dense features, V", V)
