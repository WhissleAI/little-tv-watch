"""TV Watch director, Director3 family (the Director3 family): per-stream zero-init input
projections, a hashed-token bag in a shared embedding, sport FiLM, Mamba-3 blocks (the vendored Arc layer: same
recurrence, recurrent step() for deployment) with MLP residuals, LayerNorm, and several heads on the shared state:
score event now (per sport), kind (one point / score / big score), side (a / b). One step per second, causal.
Eval: games held out (grouped folds, stratified by sport): per sport recall/precision at 0.5 / 1 / 2 false alarms per
10 judged minutes and at the blind training-fold threshold, vs Arc's shipped score head. ARCH=gru for the v2 GRU.
python train3.py <TAG> -> eval3_<TAG>_<ARCH>.json; EXPORT=1 also fits on everything -> director3_<TAG>.pt/.json"""
import json, os, re, sys, time
import numpy as np, torch, torch.nn as nn
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mamba3.layer import Mamba3Layer
from mamba3.ssd import mamba3_layer_ssd
from train2 import detect, score, baseline, at_fa   # same scoring as v2 (board ±8 s, 10 s refractory)
import train2
torch.set_num_threads(int(os.environ.get("THREADS", "4"))); torch.manual_seed(0); np.random.seed(0)
TAG = sys.argv[1] if len(sys.argv) > 1 else "live"; ARCH = os.environ.get("ARCH", "mamba")
D_MODEL, LAYERS, EMB = int(os.environ.get("D", "96")), int(os.environ.get("LAYERS", "3")), int(os.environ.get("EMB", "24"))
EPOCHS, FOLDS, BATCH, T = int(os.environ.get("EPOCHS", "12")), int(os.environ.get("FOLDS", "5")), 8, 240
spec = json.load(open(f"spec2_{TAG}.json")); D = np.load(f"ds/f2_{TAG}.npz")
train2.D = D
clips, SPORTS, V, names = spec["clips"], spec["sports"], spec["V"], spec["names"]
F = len(names)
sport = lambda c: re.sub(r"\d+$", "", re.sub(r"^v2", "", c))
BLOCKS = [(k, [i for i, n in enumerate(names) if n.startswith(p)]) for k, p in
          (("arc", "arc:"), ("txt", "txt:"), ("tag", "tag:"))]
SIDE = {}
for c in clips:   # side target per labelled second (which team's number moved)
    ev = json.load(open(f"ds/{c}.events.json"))["events"]; n = len(D[f"y_{c}"]); s = np.full(n, -1)
    for e in ev:
        if "side" in e and e["t"] < n: s[max(0, e["t"] - 6):min(n, e["t"] + 3)] = e["side"]
    SIDE[c] = s


class TVDirector(nn.Module):
    def __init__(s):
        super().__init__()
        d = D_MODEL
        s.xin = nn.ModuleDict({k: nn.Linear(len(ix), d) for k, ix in BLOCKS})
        for k, _ in BLOCKS[1:]:   # streams beyond Arc's frames start at zero (Director3's xblocks)
            nn.init.zeros_(s.xin[k].weight); nn.init.zeros_(s.xin[k].bias)
        s.emb = nn.EmbeddingBag(V, EMB, mode="mean"); s.tok = nn.Linear(EMB, d)
        s.film = nn.Embedding(len(SPORTS), 2 * d); nn.init.zeros_(s.film.weight)
        if ARCH == "mamba":
            s.blocks = nn.ModuleList([Mamba3Layer(d, d_state=32, rank=1, head_dim=32) for _ in range(LAYERS)])
            s.mlps = nn.ModuleList([nn.Sequential(nn.LayerNorm(d), nn.Linear(d, 2 * d), nn.GELU(), nn.Linear(2 * d, d)) for _ in range(LAYERS)])
        else:
            s.gru = nn.GRU(d, d, batch_first=True)
        s.norm = nn.LayerNorm(d)
        s.ev = nn.Linear(d, len(SPORTS)); s.kind = nn.Linear(d, 3); s.side = nn.Linear(d, 2)

    def embed(s, x, ti, to, si):   # x [B,T,F]; ti flat tokens, to offsets over B*T (+1); si [B]
        B, Tn, _ = x.shape
        u = sum(s.xin[k](x[..., ix]) for k, ix in BLOCKS)
        e = s.emb(ti, to[:-1]) if len(ti) else torch.zeros(B * Tn, EMB)
        if len(ti): e = e * (to[1:] > to[:-1]).float().unsqueeze(1)
        u = u + s.tok(e.view(B, Tn, EMB))
        g, b = s.film(si).chunk(2, -1)
        return u * (1 + g[:, None]) + b[:, None]

    def forward(s, x, ti, to, si):
        u = s.embed(x, ti, to, si)
        if ARCH == "mamba":
            for blk, mlp in zip(s.blocks, s.mlps):
                u = u + mamba3_layer_ssd(blk, u)
                u = u + mlp(u)
        else:
            u = s.gru(u)[0]
        z = s.norm(u)
        ev = s.ev(z).gather(-1, si[:, None, None].expand(-1, z.shape[1], 1)).squeeze(-1)
        return ev, s.kind(z), s.side(z)


def chunk(c, a, b, mu, sd):
    x = (D[f"x_{c}"][a:b] - mu) / sd
    to = D[f"to_{c}"][a:b + 1]; ti = D[f"ti_{c}"][to[0]:to[-1]]
    return x, ti, to - to[0]


def batchify(items, mu, sd):   # items: [(clip, a, b)] of equal length
    xs, tis, tos, base = [], [], [0], 0
    for c, a, b in items:
        x, ti, to = chunk(c, a, b, mu, sd); xs.append(x); tis.append(ti)
        tos.extend((to[1:] + base).tolist()); base += len(ti)
    si = torch.tensor([SPORTS.index(sport(c)) for c, _, _ in items])
    return torch.tensor(np.stack(xs)), torch.tensor(np.concatenate(tis)).long(), torch.tensor(tos).long(), si


def fit(train, epochs=EPOCHS):
    xs = np.concatenate([D[f"x_{c}"] for c in train]); mu, sd = xs.mean(0), xs.std(0) + 1e-3
    m = TVDirector(); opt = torch.optim.AdamW(m.parameters(), 2e-3, weight_decay=1e-3)
    pos = sum((D[f"y_{c}"] == 1).sum() for c in train); neg = sum((D[f"y_{c}"] == 0).sum() for c in train)
    pw = torch.tensor(min(8.0, neg / max(pos, 1)))
    lab = [c for c in train if (D[f"y_{c}"] == 1).any()]
    for ep in range(epochs):
        items = []
        for c in train:
            n = len(D[f"y_{c}"])
            if n < T or (c not in lab and np.random.rand() < 0.5): continue
            for a in range(np.random.randint(0, 60), n - T, 150): items.append((c, a, a + T))
        np.random.shuffle(items)
        for k in range(0, len(items), BATCH):
            bt = items[k:k + BATCH]
            x, ti, to, si = batchify(bt, mu, sd)
            x = x + 0.05 * torch.randn_like(x)
            if np.random.rand() < 0.15: ti = ti[:0]; to = torch.zeros_like(to)   # text dropout
            lo, ki, sdl = m(x, ti, to, si)
            y = torch.tensor(np.stack([D[f"y_{c}"][a:b] for c, a, b in bt])); keep = y >= 0
            if not keep.any(): continue
            loss = nn.functional.binary_cross_entropy_with_logits(lo[keep], y[keep], pos_weight=pw)
            kk = torch.tensor(np.stack([D[f"k_{c}"][a:b] for c, a, b in bt])); ss = torch.tensor(np.stack([SIDE[c][a:b] for c, a, b in bt]))
            if (kk >= 0).any(): loss = loss + 0.3 * nn.functional.cross_entropy(ki[kk >= 0], kk[kk >= 0])
            if (ss >= 0).any(): loss = loss + 0.2 * nn.functional.cross_entropy(sdl[ss >= 0], ss[ss >= 0])
            opt.zero_grad(); loss.backward(); nn.utils.clip_grad_norm_(m.parameters(), 1.0); opt.step()
    return m.eval(), mu, sd


def probs(m, mu, sd, c):
    with torch.no_grad():
        x, ti, to, si = batchify([(c, 0, len(D[f"y_{c}"]))], mu, sd)
        lo, _, _ = m(x, ti, to, si)
    return torch.sigmoid(lo[0]).numpy()


if __name__ == "__main__":
    t0 = time.time()
    groups = sorted(set(clips)); rng = np.random.RandomState(1); fold = {}
    by = {}
    for g in groups: by.setdefault(sport(g), []).append(g)
    for s_, gs in by.items():
        rng.shuffle(gs)
        for i, g in enumerate(gs): fold[g] = i % max(FOLDS, 1)
    if "nfl2" in fold: fold["nfl2"] = fold.get("nfl", fold["nfl2"])   # two cuts of one game stay together
    P, thr_blind = {}, {}
    for k in range(FOLDS):
        test = [c for c in clips if fold[c] == k]; train = [c for c in clips if c not in test]
        if not test: continue
        m, mu, sd = fit(train)
        Ptr = {c: probs(m, mu, sd, c) for c in train if len(D[f"e_{c}"])}
        for s_ in SPORTS:
            tr = {c: p for c, p in Ptr.items() if sport(c) == s_}
            if not tr: continue
            f1 = lambda th: (lambda a: 2 * a[0] / max(1, a[1] + a[2]))(sum(score(detect(p, th), list(D[f"e_{c}"]), D[f"y_{c}"]) for c, p in tr.items()))
            thr_blind.setdefault(s_, []).append(float(max(np.arange(0.2, 0.995, 0.01), key=f1)))
        for c in test: P[c] = probs(m, mu, sd, c)
        print(f"fold {k} done ({time.time() - t0:.0f} s): {test}", flush=True)
    np.savez(f"ds/p3_{TAG}_{ARCH}.npz", **P)
    res = {}
    for s_ in SPORTS:
        Ps = {c: p for c, p in P.items() if sport(c) == s_}
        if not Ps: continue
        r = {"games": len(Ps), "events": int(sum(len(D[f"e_{c}"]) for c in Ps)),
             "judged_min": round(sum(float((D[f"y_{c}"] >= 0).sum()) for c in Ps) / 60, 1)}
        for rate in (0.5, 1.0, 2.0):
            th, a = at_fa(Ps, rate)
            r[f"fa{rate}"] = {"thr": round(float(th), 3), "recall": round(a[0] / max(1, a[2]), 3), "precision": round(a[0] / max(1, a[1]), 3)}
        tb = float(np.median(thr_blind.get(s_, [0.5])))
        a = sum(score(detect(p, tb), list(D[f"e_{c}"]), D[f"y_{c}"]) for c, p in Ps.items())
        r["blind"] = {"thr": round(tb, 3), "recall": round(a[0] / max(1, a[2]), 3), "precision": round(a[0] / max(1, a[1]), 3),
                      "fa_per10": round((a[1] - a[0]) / max(a[3], 1e-9) * 10, 2)}
        b = sum(score(baseline(c), list(D[f"e_{c}"]), D[f"y_{c}"]) for c in Ps)
        r["arc_head"] = {"recall": round(b[0] / max(1, b[2]), 3), "precision": round(b[0] / max(1, b[1]), 3),
                         "fa_per10": round((b[1] - b[0]) / max(b[3], 1e-9) * 10, 2)}
        res[s_] = r
        print(s_, json.dumps(r), flush=True)
    m0 = TVDirector()
    json.dump({"tag": TAG, "arch": ARCH, "d": D_MODEL, "layers": LAYERS, "emb": EMB, "params": sum(p.numel() for p in m0.parameters()),
               "folds": FOLDS, "fold_of": fold, "results": res, "thr_blind": thr_blind}, open(f"eval3_{TAG}_{ARCH}.json", "w"), indent=1)
    print("params", sum(p.numel() for p in m0.parameters()), f"({time.time() - t0:.0f} s)")
    if os.environ.get("EXPORT"):
        m, mu, sd = fit(clips)
        torch.save({"state": m.state_dict(), "mu": mu, "sd": sd, "thr": {s_: float(np.median(v)) for s_, v in thr_blind.items()}}, f"director3_{TAG}.pt")
        print("exported", f"director3_{TAG}.pt")
