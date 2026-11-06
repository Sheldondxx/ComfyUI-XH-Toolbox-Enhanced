"""Stable library API for converting normalized or raw H3 latents.

Adapted from NVlabs/Sana @ 144085566a866f9784f3798d4c8d1603f3adbccf
  models/minimax_h3/Sol-H3-Spark/runtime/stage2_ops/h3_ltx_adapter/adapter.py

Difference from upstream: `load()` takes an already-parsed config dict instead of
reading `config.json` from disk next to `model.safetensors`, so a single
safetensors file is enough to run the node.
"""

from __future__ import annotations

import json
from pathlib import Path

import torch
from safetensors.torch import load_file

from .constants import H3_LATENTS_MEAN, H3_LATENTS_STD
from .geometry import align_h3_to_ltx, h3_temporal_positions, ltx_temporal_positions, padded_ltx_pixel_frames
from .model import build_model

# Frozen contract shipped with the released checkpoint (config.json on the Hub).
FROZEN_CONFIG = {
    "dtype": "bfloat16",
    "format": "h3_ltx_adapter_safetensors_v1",
    "geometry": {
        "spatial_mode": "pixel_unshuffle",
        "temporal_mode": "linear_plus_nearest_pack",
        "temporal_pack_slots": 3,
    },
    "input_contract": {
        "normalization": "released H3 per-channel (raw - mean) / std",
        "tensor": "B,24,T,H/16,W/16",
    },
    "model_config": {
        "coarse_blocks": 18,
        "coarse_width": 0,
        "coordinate_channels": 0,
        "dense_temporal_blocks": 0,
        "expansion": 2,
        "gradient_checkpointing": False,
        "groups": 16,
        "high_blocks": 2,
        "in_channels": 384,
        "model_type": "tiny",
        "num_blocks": 22,
        "out_channels": 128,
        "output_refiner_blocks": 0,
        "output_refiner_width": 0,
        "post_blocks": 2,
        "width": 752,
    },
    "output_contract": {
        "normalization": "LTX checkpoint per-channel mean/std normalized latent",
        "tensor": "B,128,T_ltx,H/32,W/32",
    },
    "parameters": 194759504,
}

_EXPECTED_GEOMETRY = {
    "spatial_mode": "pixel_unshuffle",
    "temporal_mode": "linear_plus_nearest_pack",
    "temporal_pack_slots": 3,
}


def read_config(model_path: str | Path) -> dict:
    """Prefer a sibling config.json; fall back to the frozen contract."""
    sidecar = Path(model_path).with_name("config.json")
    if sidecar.is_file():
        try:
            config = json.loads(sidecar.read_text(encoding="utf-8"))
            if config.get("format") != "h3_ltx_adapter_safetensors_v1":
                raise ValueError(f"unsupported adapter format: {config.get('format')!r}")
            if config.get("geometry") != _EXPECTED_GEOMETRY:
                raise ValueError(f"checkpoint geometry {config.get('geometry')} != {_EXPECTED_GEOMETRY}")
            return config
        except ValueError:
            raise
        except Exception as exc:  # malformed sidecar -> fall back, do not hard fail
            print(f"[🔀XH-H3LTX] ignoring unreadable config.json ({exc}); using frozen contract")
    return FROZEN_CONFIG


def expected_shapes(pixel_frames: int, pixel_height: int, pixel_width: int) -> dict[str, list[int]]:
    if pixel_height % 32 or pixel_width % 32:
        raise ValueError("pixel height and width must be divisible by 32")
    padded_frames = padded_ltx_pixel_frames(pixel_frames)
    return {
        "h3": [24, len(h3_temporal_positions(pixel_frames)), pixel_height // 16, pixel_width // 16],
        "aligned_h3": [384, len(ltx_temporal_positions(padded_frames)), pixel_height // 32, pixel_width // 32],
        "ltx": [128, len(ltx_temporal_positions(padded_frames)), pixel_height // 32, pixel_width // 32],
    }


class H3ToLTXAdapter:
    """Load the frozen checkpoint and translate H3 latents to normalized LTX latents."""

    def __init__(self, model, config: dict, device: torch.device, dtype: torch.dtype):
        self.model = model
        self.config = config
        self.device = device
        self.dtype = dtype

    @classmethod
    def load(
        cls,
        model_path: str | Path,
        *,
        config: dict | None = None,
        device: str | torch.device = "cuda",
        dtype: torch.dtype = torch.bfloat16,
    ) -> "H3ToLTXAdapter":
        model_path = Path(model_path)
        if not model_path.is_file():
            raise FileNotFoundError(f"adapter checkpoint not found: {model_path}")
        config = config or read_config(model_path)
        resolved_device = torch.device(device)
        model = build_model(config["model_config"])
        state = load_file(str(model_path), device="cpu")
        try:
            model.load_state_dict(state, strict=True)
        except RuntimeError as exc:
            raise RuntimeError(
                f"adapter state_dict does not match the frozen Conv3D architecture "
                f"({model_path.name}): {exc}"
            ) from exc
        del state
        model.eval().requires_grad_(False).to(device=resolved_device, dtype=dtype)
        return cls(model, config, resolved_device, dtype)

    @staticmethod
    def normalize_raw_h3(raw_h3: torch.Tensor) -> torch.Tensor:
        mean = raw_h3.new_tensor(H3_LATENTS_MEAN).view(1, -1, 1, 1, 1)
        std = raw_h3.new_tensor(H3_LATENTS_STD).view(1, -1, 1, 1, 1)
        return (raw_h3 - mean) / std

    @torch.inference_mode()
    def convert(
        self,
        h3_latent: torch.Tensor,
        *,
        pixel_frames: int,
        pixel_height: int,
        pixel_width: int,
        input_normalization: str = "normalized",
    ) -> torch.Tensor:
        if h3_latent.ndim == 4:
            h3_latent = h3_latent.unsqueeze(0)
        expected = expected_shapes(pixel_frames, pixel_height, pixel_width)
        if list(h3_latent.shape[1:]) != expected["h3"]:
            raise ValueError(f"H3 latent shape {list(h3_latent.shape[1:])} != expected {expected['h3']}")
        if input_normalization == "raw":
            h3_latent = self.normalize_raw_h3(h3_latent.float())
        elif input_normalization != "normalized":
            raise ValueError("input_normalization must be 'normalized' or 'raw'")
        aligned = align_h3_to_ltx(
            h3_latent.to(device=self.device, dtype=self.dtype),
            pixel_frames=pixel_frames,
            target_height=pixel_height // 32,
            target_width=pixel_width // 32,
            slots=3,
        )
        if list(aligned.shape[1:]) != expected["aligned_h3"]:
            raise RuntimeError(f"aligned H3 shape {list(aligned.shape[1:])} != expected {expected['aligned_h3']}")
        output = self.model(aligned)
        if list(output.shape[1:]) != expected["ltx"]:
            raise RuntimeError(f"LTX output shape {list(output.shape[1:])} != expected {expected['ltx']}")
        if not torch.isfinite(output).all():
            raise FloatingPointError("adapter produced NaN or Inf")
        return output

    def to(self, device: str | torch.device) -> "H3ToLTXAdapter":
        resolved = torch.device(device)
        self.model.to(device=resolved)
        self.device = resolved
        return self
