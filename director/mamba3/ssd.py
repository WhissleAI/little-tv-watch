"""Chunked SSD evaluation of Mamba3Layer (copied verbatim from WhissleAI's internal Mamba-3 code)."""
import torch
from .scan import rotate_by
from .layer import Mamba3Layer

def _f(t):
    return t.float() if t is not None and t.dtype in (torch.float16, torch.bfloat16) else t


def _shift(x):
    return torch.cat([torch.zeros_like(x[:, :1]), x[:, :-1]], dim=1)


def ssd_safe(alpha, Beff, xeff, Ctil, chunk: int = 64):
    """Chunked SSD (as vendor ssd_pytorch) with the decay masked before exp. Returns y (B,T,H,R,P)."""
    B, T, H, N, K = Beff.shape
    P = xeff.shape[-2]
    la = torch.log(alpha.clamp_min(1e-30))
    g = torch.zeros(B, H, N, P, dtype=Beff.dtype, device=Beff.device)
    ys = []
    for s0 in range(0, T, chunk):
        e = min(s0 + chunk, T)
        L = e - s0
        Bc, xc, Cc = Beff[:, s0:e], xeff[:, s0:e], Ctil[:, s0:e]
        cl = torch.cumsum(la[:, s0:e], dim=1)
        d = torch.exp(cl)
        rel = cl.unsqueeze(2) - cl.unsqueeze(1)                       # (B,L,L,H)
        tril = torch.tril(torch.ones(L, L, dtype=torch.bool, device=Beff.device)).view(1, L, L, 1)
        Ldec = torch.exp(rel.masked_fill(~tril, float("-inf")))
        G = torch.einsum('blhnr,bmhnk->bhlmrk', Cc, Bc)
        y_intra = torch.einsum('blmh,bhlmrk,bmhpk->blhrp', Ldec, G, xc)
        y_inter = torch.einsum('blh,blhnr,bhnp->blhrp', d, Cc, g)
        ys.append(y_intra + y_inter)
        coef = torch.exp(cl[:, -1:, :] - cl)
        g = d[:, -1].unsqueeze(-1).unsqueeze(-1) * g + torch.einsum('blh,blhnk,blhpk->bhnp', coef, Bc, xc)
    return torch.cat(ys, dim=1)


def _ssd_from_coeffs(alpha, beta, gamma, Bc, xc, Cm, theta, chunk):
    """Bc (B,T,H,N,K) xc (B,T,H,P,K) Cm (B,T,H,N,R) -> y (B,T,H,R,P); the vendor ssd_inputs reduction."""
    Phi = torch.cumsum(theta, dim=1)
    Phi_prev = _shift(Phi)
    Btil = rotate_by(Bc, -Phi)
    Ctil = rotate_by(Cm, -Phi)
    Btil_prev = rotate_by(_shift(Bc), -Phi_prev)
    Beff = torch.cat([gamma[..., None, None] * Btil, beta[..., None, None] * Btil_prev], dim=-1)
    xeff = torch.cat([xc, _shift(xc)], dim=-1)
    return ssd_safe(alpha, Beff, xeff, Ctil, chunk)


def mamba3_layer_ssd(layer: Mamba3Layer, u: torch.Tensor, chunk: int = 64):
    """Same output as Mamba3Layer.forward(u) via SSD."""
    nu = layer.norm(u)
    alpha, beta, gamma, Bm, Cm, x, theta = layer._coeffs(nu)
    y = _ssd_from_coeffs(alpha, beta, gamma, Bm, x, Cm, theta, chunk)
    Bsz, T = u.shape[:2]
    return layer.gate_and_proj(y.reshape(Bsz, T, -1), nu)




# ---- stateful SSD (carried state across calls; truncated-BPTT training and reset-free inference) -------------------
def ssd_safe_state(alpha, Beff, xeff, Ctil, g0=None, chunk: int = 64):
    """ssd_safe with an initial inter-chunk state g0 (B,H,N,P) (rotated frame of t = -1); returns (y, g_final)."""
    B, T, H, N, K = Beff.shape
    P = xeff.shape[-2]
    la = torch.log(alpha.clamp_min(1e-30))
    g = torch.zeros(B, H, N, P, dtype=Beff.dtype, device=Beff.device) if g0 is None else g0.to(Beff.dtype)
    ys = []
    for s0 in range(0, T, chunk):
        e = min(s0 + chunk, T)
        L = e - s0
        Bc, xc, Cc = Beff[:, s0:e], xeff[:, s0:e], Ctil[:, s0:e]
        cl = torch.cumsum(la[:, s0:e], dim=1)
        d = torch.exp(cl)
        rel = cl.unsqueeze(2) - cl.unsqueeze(1)
        tril = torch.tril(torch.ones(L, L, dtype=torch.bool, device=Beff.device)).view(1, L, L, 1)
        Ldec = torch.exp(rel.masked_fill(~tril, float("-inf")))
        G = torch.einsum('blhnr,bmhnk->bhlmrk', Cc, Bc)
        y_intra = torch.einsum('blmh,bhlmrk,bmhpk->blhrp', Ldec, G, xc)
        y_inter = torch.einsum('blh,blhnr,bhnp->blhrp', d, Cc, g)
        ys.append(y_intra + y_inter)
        coef = torch.exp(cl[:, -1:, :] - cl)
        g = d[:, -1].unsqueeze(-1).unsqueeze(-1) * g + torch.einsum('blh,blhnk,blhpk->bhnp', coef, Bc, xc)
    return torch.cat(ys, dim=1), g


def mamba3_layer_ssd_state(layer: Mamba3Layer, u: torch.Tensor, state=None, chunk: int = 64):
    """SSD with carried state. state = (h (B,H,N,P) absolute frame, B_last (B,H,N,K), x_last (B,H,P,K)) or None (zeros).
    Returns (out, new_state). Equal to running mamba3_layer_ssd over the concatenated sequence; step()'s prev_bx = B_last @ x_last^T."""
    nu = layer.norm(u)
    alpha, beta, gamma, Bm, Cm, x, theta = layer._coeffs(nu)
    Phi = torch.cumsum(theta, dim=1)
    Phi_prev = _shift(Phi)
    if state is None:
        h0 = None; Bp = torch.zeros_like(Bm[:, :1]); xp = torch.zeros_like(x[:, :1])
    else:
        h0, Bl, xl = state; Bp = Bl[:, None].to(Bm.dtype); xp = xl[:, None].to(x.dtype)
    Bsh = torch.cat([Bp, Bm[:, :-1]], 1); xsh = torch.cat([xp, x[:, :-1]], 1)
    Btil = rotate_by(Bm, -Phi); Ctil = rotate_by(Cm, -Phi); Btil_prev = rotate_by(Bsh, -Phi_prev)
    Beff = torch.cat([gamma[..., None, None] * Btil, beta[..., None, None] * Btil_prev], dim=-1)
    xeff = torch.cat([x, xsh], dim=-1)
    y, g = ssd_safe_state(alpha, Beff, xeff, Ctil, h0, chunk)
    hT = rotate_by(g.unsqueeze(1), Phi[:, -1:])[:, 0]
    Bsz, T = u.shape[:2]
    return layer.gate_and_proj(y.reshape(Bsz, T, -1), nu), (hT, Bm[:, -1], x[:, -1])
