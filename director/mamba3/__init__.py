"""Pure-PyTorch Mamba-3 layer (Lahoti et al., arXiv 2603.15569; WhissleAI in-house implementation, no CUDA kernels):
layer.py (recurrent path + step()), scan.py (chunked scan), ssd.py (chunked-SSD parallel path used for offline inference).
Identical to the copy the model was trained with."""
from .layer import Mamba3Layer  # noqa: F401
from .ssd import mamba3_layer_ssd, _f  # noqa: F401
