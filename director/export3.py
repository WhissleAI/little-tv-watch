"""director3_<TAG>.pt -> the app's public/director/director.json (weights + feature spec + per-sport thresholds), and a
parity fixture: one held-out game's per-second inputs and PyTorch's per-step outputs through the RECURRENT step path
(Mamba3Layer.step, state carried), which must equal the parallel SSD path used in training.
python export3.py <TAG> <clip> [out_json]"""
import json, os, sys
import numpy as np, torch
sys.argv, ARGV = sys.argv[:2], sys.argv
import train3 as T3
TAG, CLIP = ARGV[1], ARGV[2]
OUT = ARGV[3] if len(ARGV) > 3 else "../app/public/director/director.json"
ck = torch.load(f"director3_{TAG}.pt", weights_only=False)
m = T3.TVDirector(); m.load_state_dict(ck["state"]); m.eval()
mu, sd = ck["mu"], ck["sd"]


@torch.no_grad()
def stepwise(c):
    x, ti, to, si = T3.batchify([(c, 0, len(T3.D[f"y_{c}"]))], mu, sd)
    u = m.embed(x, ti, to, si)[0]
    st = [(None, None) for _ in m.blocks]; outs = []
    for t in range(u.shape[0]):
        v = u[t:t + 1]
        for i, (blk, mlp) in enumerate(zip(m.blocks, m.mlps)):
            o, h, bx = blk.step(v, *st[i]); st[i] = (h, bx)
            v = v + o; v = v + mlp(v)
        z = m.norm(v)
        outs.append(torch.sigmoid(m.ev(z)[0, si[0]]).item())
    return np.array(outs)


par = T3.probs(m, mu, sd, CLIP); rec = stepwise(CLIP)
print("SSD (training path) vs recurrent step: max abs diff", float(np.abs(par - rec).max()))
W = {k: v.detach().numpy().astype(np.float32).round(6).tolist() for k, v in m.state_dict().items()}
spec = T3.spec
blocks = {k: ix for k, ix in T3.BLOCKS}
json.dump({"format": "tvwatch-director3", "arch": "Director3 family: per-stream projections + hashed token bag + sport FiLM + Mamba-3 x"
           f"{T3.LAYERS} (d {T3.D_MODEL}, state 32, head 32) + MLP, heads event/kind/side",
           "d": T3.D_MODEL, "layers": T3.LAYERS, "emb": T3.EMB, "d_state": 32, "head_dim": 32, "V": spec["V"], "last_words": spec["last_words"],
           "names": spec["names"], "blocks": blocks, "sports": spec["sports"], "frame_floor": spec["frame_floor"], "x_heads": spec["x_heads"],
           "mu": np.asarray(mu).round(6).tolist(), "sd": np.asarray(sd).round(6).tolist(), "thresholds": ck["thr"],
           "kinds": spec["kinds"], "params": sum(p.numel() for p in m.parameters()), "weights": W}, open(OUT, "w"))
x, ti, to, si = T3.batchify([(CLIP, 0, len(T3.D[f"y_{CLIP}"]))], mu, sd)
raw = T3.D[f"x_{CLIP}"]; tof = T3.D[f"to_{CLIP}"]; tif = T3.D[f"ti_{CLIP}"]
json.dump({"clip": CLIP, "sport": T3.sport(CLIP), "rows": raw[:600].round(6).tolist(),
           "tokens": [tif[tof[s]:tof[s + 1]].tolist() for s in range(min(600, len(raw)))], "p": rec[:600].tolist()},
          open(f"parity3_{TAG}.json", "w"))
print("wrote", OUT, os.path.getsize(OUT) // 1024, "KB; parity fixture", f"parity3_{TAG}.json")
