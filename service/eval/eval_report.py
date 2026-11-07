#!/usr/bin/env python3
"""results.json -> per-condition table (markdown): score / clock / minute exact, names P/R, alerts P/R, worst misses."""
import json, os, sys
from collections import defaultdict
HERE = os.path.dirname(os.path.abspath(__file__))
res = json.load(open(sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "results.json")))
by = defaultdict(list)
for r in res:
    by[r["cond"]].append(r)


def pr(tp, fp, fn):
    p = tp / (tp + fp) if tp + fp else 1.0
    r = tp / (tp + fn) if tp + fn else 1.0
    return p, r


print("| condition | clips | score exact | false score | clock ±5 s | minute | names P / R | alerts P / R | RTF |")
print("|---|---|---|---|---|---|---|---|---|")
misses = defaultdict(lambda: defaultdict(int))
for cond in ("clean", "crowd", "near", "room"):
    rs = by.get(cond, [])
    if not rs:
        continue
    sc = [r for r in rs if r["truth"]["score"]]
    sc_ok = sum(1 for r in sc if r["score"] and list(r["score"]) == r["truth"]["score"])
    false_sc = sum(1 for r in rs if not r["truth"]["score"] and r["score"])
    ck = [r for r in rs if r["truth"].get("clock") is not None]
    ck_ok = sum(1 for r in ck if r["clock"] is not None and abs(r["clock"] - r["truth"]["clock"]) <= 5)
    mn = [r for r in rs if r["truth"].get("minute")]
    mn_ok = sum(1 for r in mn if r["minute"] == r["truth"]["minute"])
    ntp = nfp = nfn = atp = afp = afn = 0
    for r in rs:
        tn, pn = set(r["truth"]["names"]), set(r["names"])
        ntp += len(tn & pn); nfp += len(pn - tn); nfn += len(tn - pn)
        ta, pa = set(r["truth"]["alerts"]), set(r["alerts"])
        atp += len(ta & pa); afp += len(pa - ta); afn += len(ta - pa)
        for a in ta - pa: misses[cond][f"missed alert {a} ({r['id']})"] += 1
        for a in pa - ta: misses[cond][f"extra alert {a} ({r['id']})"] += 1
        for n in tn - pn: misses[cond][f"missed name {n}"] += 1
        if r["truth"]["score"] and (not r["score"] or list(r["score"]) != r["truth"]["score"]):
            misses[cond][f"score {r['id']}: got {r['score']}"] += 1
    np_, nr = pr(ntp, nfp, nfn)
    ap_, ar = pr(atp, afp, afn)
    rtf = sum(r["wall"] for r in rs) / sum(r["audio"] for r in rs)
    print(f"| {cond} | {len(rs)} | {sc_ok}/{len(sc)} | {false_sc}/{len(rs) - len(sc)} | {ck_ok}/{len(ck)} | "
          f"{mn_ok}/{len(mn)} | {np_:.2f} / {nr:.2f} | {ap_:.2f} / {ar:.2f} | {rtf:.2f} |")
for cond, m in misses.items():
    top = sorted(m.items(), key=lambda x: -x[1])[:10]
    print(f"\n**{cond}** most frequent misses (of 4 voices): " + "; ".join(f"{k} ×{v}" for k, v in top))
