"""Director v2: causal GRU over 1 s steps. Inputs: dense Arc/text/tagger features -> Linear, and the hashed text of the
newest Arc line -> EmbeddingBag(mean). Output: P(scoring event) per sport (one logit per sport, the clip's sport is
used) + kind (one point / score / big score).
Eval: games held out (grouped K folds), per sport: recall/precision at fixed false-alarm rates (0.5 and 1 per 10 min),
and at the threshold picked on the training folds (blind), vs Arc's shipped score head.
python train2.py <TAG> [hidden] [emb]   -> v2/eval2_<TAG>.json, director2_<TAG>.json"""
import json, os, sys, re
import numpy as np, torch, torch.nn as nn
torch.set_num_threads(int(os.environ.get("THREADS", "3"))); torch.manual_seed(0); np.random.seed(0)
TAG = sys.argv[1] if len(sys.argv) > 1 else "live"
H = int(sys.argv[2]) if len(sys.argv) > 2 else 64; E = int(sys.argv[3]) if len(sys.argv) > 3 else 24
EPOCHS = int(os.environ.get("EPOCHS", "25")); FOLDS = int(os.environ.get("FOLDS", "5"))
spec = json.load(open(f"spec2_{TAG}.json")); D = np.load(f"ds/f2_{TAG}.npz")
clips, SPORTS, V = spec["clips"], spec["sports"], spec["V"]; F = len(spec["names"])
sport = lambda c: re.sub(r"\d+$", "", re.sub(r"^v2", "", c))
game = lambda c: c   # one clip = one game (v1 nfl/nfl2 are two cuts of one game: grouped below)
GROUP = {"nfl2": "nfl"}


class Director(nn.Module):
    def __init__(s):
        super().__init__()
        s.emb = nn.EmbeddingBag(V, E, mode="mean")
        s.inp = nn.Linear(F + E, H); s.gru = nn.GRU(H, H, batch_first=True)
        s.ev = nn.Linear(H, len(SPORTS)); s.kind = nn.Linear(H, 3)

    def forward(s, x, ti, to, si):   # x [T,F]; ti/to: flat token ids + offsets (T+1); si: sport index
        e = s.emb(ti, to[:-1]) if len(ti) else torch.zeros(len(x), E)
        if len(ti): e = e * (to[1:] > to[:-1]).float().unsqueeze(1)   # seconds with no new line: zero
        z, _ = s.gru(torch.relu(s.inp(torch.cat([x, e], 1))).unsqueeze(0))
        return s.ev(z[0])[:, si], s.kind(z[0])


def chunk(c, a, b, mu, sd):
    x = torch.tensor((D[f"x_{c}"][a:b] - mu) / sd)
    to = D[f"to_{c}"][a:b + 1]; ti = D[f"ti_{c}"][to[0]:to[-1]]
    return x, torch.tensor(ti), torch.tensor(to - to[0])


def fit(train, epochs=EPOCHS):
    xs = np.concatenate([D[f"x_{c}"] for c in train]); mu, sd = xs.mean(0), xs.std(0) + 1e-3
    m = Director(); opt = torch.optim.AdamW(m.parameters(), 2e-3, weight_decay=1e-3)
    pos = sum((D[f"y_{c}"] == 1).sum() for c in train); neg = sum((D[f"y_{c}"] == 0).sum() for c in train)
    pw = torch.tensor(min(8.0, neg / max(pos, 1)))
    for ep in range(epochs):
        for c in np.random.permutation(train):
            n = len(D[f"y_{c}"]); si = SPORTS.index(sport(c))
            if not (D[f"y_{c}"] == 1).any() and np.random.rand() < 0.5: continue   # clips with no labels: half the time
            for a in range(np.random.randint(0, 60), max(1, n - 30), 180):
                b = min(n, a + 240)
                x, ti, to = chunk(c, a, b, mu, sd)
                x = x + 0.05 * torch.randn_like(x)
                if np.random.rand() < 0.15: ti = ti[:0]; to = torch.zeros_like(to)   # text dropout: audio alone must work
                lo, ki = m(x, ti, to, si)
                y = torch.tensor(D[f"y_{c}"][a:b]); keep = y >= 0
                if not keep.any(): continue
                loss = nn.functional.binary_cross_entropy_with_logits(lo[keep], y[keep], pos_weight=pw)
                k = torch.tensor(D[f"k_{c}"][a:b])
                if (k >= 0).any(): loss = loss + 0.3 * nn.functional.cross_entropy(ki[k >= 0], k[k >= 0])
                opt.zero_grad(); loss.backward(); nn.utils.clip_grad_norm_(m.parameters(), 1.0); opt.step()
    return m, mu, sd


def probs(m, mu, sd, c):
    with torch.no_grad():
        x, ti, to = chunk(c, 0, len(D[f"y_{c}"]), mu, sd)
        lo, _ = m(x, ti, to, SPORTS.index(sport(c)))
    return torch.sigmoid(lo).numpy()


def detect(p, thr, refractory=10):
    out, last = [], -99
    for s, v in enumerate(p):
        if v >= thr and s - last >= refractory: out.append(s); last = s
    return out


def score(dets, events, y, tol=8):
    dets = [d for d in dets if y[min(d, len(y) - 1)] >= 0 or any(abs(d - e) <= tol for e in events)]
    used, tp = set(), 0
    for d in dets:
        j = next((i for i, e in enumerate(events) if i not in used and abs(d - e) <= tol), None)
        if j is not None: used.add(j); tp += 1
    judged = float((y >= 0).sum())   # seconds the board can judge (false-alarm rate is per judged minute)
    return np.array([tp, len(dets), len(events), judged / 60])


def baseline(c):
    head = "ev_rec:event.sports.score.recent"; dets, run, armed, last = [], 0, True, -99
    for l in open(f"ds/{c}.arc.jsonl"):
        try: r = json.loads(l)
        except ValueError: continue
        if r["k"] != "frame": continue
        p = r["p"].get(head, 0); t = r["t"]
        run = run + 1 if p >= 0.5 else 0
        if p < 0.3: armed = True
        if armed and run >= 3 and t - last >= 10: dets.append(int(t)); armed = False; last = t
    return dets


def at_fa(P, rate):   # the lowest threshold whose false alarms stay within `rate` per 10 judged minutes (pooled)
    allp = np.concatenate(list(P.values()))   # thresholds from the predictions' own quantiles (they bunch near 1)
    for thr in np.unique(np.quantile(allp, np.linspace(0.5, 0.99999, 300))):
        s = sum(score(detect(p, thr), list(D[f"e_{c}"]), D[f"y_{c}"]) for c, p in P.items())
        if (s[1] - s[0]) / max(s[3], 1e-9) * 10 <= rate:
            return thr, s
    return 1.0, sum(score([], list(D[f"e_{c}"]), D[f"y_{c}"]) for c in P)


if __name__ == "__main__":
    groups = sorted({GROUP.get(c, c) for c in clips})
    rng = np.random.RandomState(1)
    by_sport = {}
    for g in groups: by_sport.setdefault(sport(g), []).append(g)
    fold = {}
    for s, gs in by_sport.items():   # stratified: each sport's games spread over the folds
        rng.shuffle(gs)
        for i, g in enumerate(gs): fold[g] = i % FOLDS
    P, thr_blind = {}, {}
    for k in range(FOLDS):
        test = [c for c in clips if fold[GROUP.get(c, c)] == k]; train = [c for c in clips if c not in test]
        if not test: continue
        m, mu, sd = fit(train)
        Ptr = {c: probs(m, mu, sd, c) for c in train}
        for s in SPORTS:   # blind threshold per sport: best F1 on the training folds
            tr = {c: p for c, p in Ptr.items() if sport(c) == s and len(D[f"e_{c}"])}
            if not tr: continue
            def f1(th):
                a = sum(score(detect(p, th), list(D[f"e_{c}"]), D[f"y_{c}"]) for c, p in tr.items())
                return 2 * a[0] / max(1, a[1] + a[2])
            thr_blind.setdefault(s, []).append(float(max(np.arange(0.2, 0.995, 0.01), key=f1)))
        for c in test: P[c] = probs(m, mu, sd, c)
        print(f"fold {k}: held out {test}", flush=True)
        np.savez(f"ds/p2_{TAG}_h{H}.npz", **P)
    res = {}
    for s in SPORTS:
        Ps = {c: p for c, p in P.items() if sport(c) == s}
        if not Ps: continue
        ev = sum(len(D[f"e_{c}"]) for c in Ps); mins = sum(float((D[f"y_{c}"] >= 0).sum()) for c in Ps) / 60
        r = {"games": len(Ps), "events": ev, "judged_min": round(mins, 1)}
        for rate in (0.5, 1.0, 2.0):
            th, a = at_fa(Ps, rate)
            r[f"fa{rate}"] = {"thr": round(float(th), 3), "recall": round(a[0] / max(1, a[2]), 3), "precision": round(a[0] / max(1, a[1]), 3)}
        tb = float(np.median(thr_blind.get(s, [0.5])))
        a = sum(score(detect(p, tb), list(D[f"e_{c}"]), D[f"y_{c}"]) for c, p in Ps.items())
        r["blind"] = {"thr": round(tb, 3), "recall": round(a[0] / max(1, a[2]), 3), "precision": round(a[0] / max(1, a[1]), 3),
                      "fa_per10": round((a[1] - a[0]) / max(a[3], 1e-9) * 10, 2)}
        b = sum(score(baseline(c), list(D[f"e_{c}"]), D[f"y_{c}"]) for c in Ps)
        r["arc_head"] = {"recall": round(b[0] / max(1, b[2]), 3), "precision": round(b[0] / max(1, b[1]), 3),
                         "fa_per10": round((b[1] - b[0]) / max(b[3], 1e-9) * 10, 2)}
        res[s] = r
        print(s, json.dumps(r), flush=True)
    json.dump({"tag": TAG, "hidden": H, "emb": E, "folds": FOLDS, "fold_of": fold, "results": res, "thr_blind": thr_blind},
              open(f"eval2_{TAG}_h{H}.json", "w"), indent=1)
