#!/usr/bin/env python3
"""Score TV Watch on the eval set: Arc (arc_tv) -> tvwatch.py's own rules, per condition.
  eval_run.py [--arc ../arc_tv_mac] [--model DIR] [--jobs 4] [--out results.json]
Per clip: the finals, then score / clock / match-minute / watchlist names / alerts against lines.json."""
import argparse, json, os, subprocess, sys, time, wave
from concurrent.futures import ThreadPoolExecutor
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
sys.argv, _argv = [sys.argv[0]], sys.argv
import tvwatch as tw
sys.argv = _argv

ap = argparse.ArgumentParser()
ap.add_argument("--arc", default=os.path.join(os.path.dirname(HERE), "arc_tv_mac"))
ap.add_argument("--model", default=os.environ.get("ARC_MODEL", "models/mini"))
ap.add_argument("--jobs", type=int, default=4)
ap.add_argument("--threads", type=int, default=2)
ap.add_argument("--conds", default="clean,crowd,room")
ap.add_argument("--out", default=os.path.join(HERE, "results.json"))
ap.add_argument("--bias", action="store_true", help="bias Arc towards the watchlist + the sport's alert words")
ap.add_argument("--beams", type=int, default=0, help="final decode beams (0: Arc's 4)")
ap.add_argument("--cache", default="finals.json")
ap.add_argument("--rejudge", action="store_true", help="reuse Arc's cached output (finals.json): re-score the logic only")
A = ap.parse_args()

lines = {l["id"]: l for l in json.load(open(os.path.join(HERE, "lines.json")))}
names = []
for row in open(os.path.join(HERE, "names_eval.txt")):
    b = row.strip().split("|")
    if b[0] and not b[0].startswith("#"):
        names.append((b[0], [b[0]] + ([a.strip() for a in b[2].split(",")] if len(b) > 2 and b[2] else [])))
tw.load_names = lambda: names


def bias_file(domain):
    """what tvwatch.py writes for a sport: watchlist names + aliases, and the alert words of that sport's rules"""
    path = os.path.join(HERE, f"bias_{domain}.txt")
    rules = [r for r in json.load(open(os.path.join(os.path.dirname(HERE), "rules.json")))
             if not r.get("sports") or domain in r["sports"]]
    tw.ARGS = type("A", (), {"domain": domain})
    open(path, "w").write("\n".join(tw.bias_phrases(rules, names)) + "\n")
    return path


def arc(path, domain):
    pcm = wave.open(path).readframes(10 ** 9) + b"\0" * 32000 * 2
    t = time.time()
    extra = (["--bias", bias_file(domain)] if A.bias else []) + (["--beams", str(A.beams)] if A.beams else [])
    out = subprocess.run(["taskpolicy", "-b", A.arc, A.model, "--domain", domain, "--threads", str(A.threads),
                          "--partial-ms", "-1", "--names", os.path.join(HERE, "names_eval.txt")] + extra,
                         input=pcm, capture_output=True).stdout
    finals = [json.loads(x) for x in out.splitlines() if x.startswith(b"{")]
    return [f for f in finals if f["k"] == "final"], time.time() - t, len(pcm) / 32000


def judge(finals, line):
    """run the service's logic on this clip alone (fresh state)"""
    class Args: domain = line["domain"]; dry_run = True; ntfy = None
    tw.ARGS = Args
    tw.STATE.update(score=None, clock=None, clock_label=None)
    tw.LAST_FIRED.clear()
    fired = []
    tw.fire = lambda r, title, body: fired.append(r.get("id"))
    found = set()
    for f in finals:
        f["tags"] = tw.mark_watch(f["text"], f.get("tags", []))
        found |= {t["watch"] for t in f["tags"] if t.get("watch")}
        found |= {c for c, forms in names if any(tw.fuzzy_has(f["text"], x) for x in forms)}
        tw.check_rules(f)
    minute = tw.STATE["clock_label"].rstrip("'") if line["domain"] == "soccer" and tw.STATE["clock_label"] else None
    return {"text": " ".join(f["text"] for f in finals), "score": tw.STATE["score"], "clock": tw.STATE["clock"],
            "minute": int(minute) if minute else None, "names": sorted(found), "alerts": sorted(set(fired))}


jobs = []
for cond in A.conds.split(","):
    for fn in sorted(os.listdir(os.path.join(HERE, "wav", cond))):
        jobs.append((cond, fn))


def one(job):
    cond, fn = job
    lid, voice = fn[:-4].split("__")
    finals, wall, dur = arc(os.path.join(HERE, "wav", cond, fn), lines[lid]["domain"])
    return {"cond": cond, "id": lid, "voice": voice, "wall": wall, "audio": dur, "finals": finals}


t0 = time.time()
cache = os.path.join(HERE, A.cache)
if A.rejudge:
    raw = json.load(open(cache))
else:
    with ThreadPoolExecutor(A.jobs) as ex:
        raw = list(ex.map(one, jobs))
    done = {r["cond"] for r in raw}   # keep the cached conditions this run didn't redo
    old = [r for r in json.load(open(cache)) if r["cond"] not in done] if os.path.exists(cache) else []
    raw = old + raw
    json.dump(raw, open(cache, "w"))
res = []
for r in raw:   # judging touches tvwatch's globals: one at a time
    line = lines[r["id"]]
    r = dict(r)
    j = judge([dict(f) for f in r.pop("finals")], line)
    res.append(dict(r, **j, truth={k: line.get(k) for k in ("score", "clock", "minute", "names", "alerts")}))
json.dump(res, open(A.out, "w"), indent=1)
print(f"{len(res)} clips in {time.time() - t0:.0f} s -> {A.out}")
