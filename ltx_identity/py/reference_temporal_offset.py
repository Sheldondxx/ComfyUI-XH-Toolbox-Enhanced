"""Shared temporal placement helpers for clean LTX reference tokens.

LTX VAEs normally compress eight pixel frames into one latent-time step.  The
public node input is expressed in latent steps so ``-1`` consistently means
"one VAE temporal step before frame zero" without hard-coding a particular
VAE scale factor.
"""

from __future__ import annotations

import torch

DEFAULT_REFERENCE_TEMPORAL_OFFSET_LATENTS = 0


def reference_temporal_offset_input():
    """Return a fresh ComfyUI input declaration for reference-only placement."""
    return (
        "INT",
        {
            "default": DEFAULT_REFERENCE_TEMPORAL_OFFSET_LATENTS,
            "min": -16,
            "max": 16,
            "step": 1,
            "tooltip": (
                "【⏱ 参考时间偏移】只影响「参考图 token」自己在时间轴上的 RoPE 位置，单位 = VAE latent 时间步。"
                "① 0 = 历史默认：参考块钉在第 0 帧。"
                "⚠️ 如果成片开头几秒出现参考图的残影 / 半透明幽灵，就是这里 —— 改成 -1。"
                "② -1 = 把参考块挪到第 0 帧之前（≈ 提前 8 个像素帧）。"
                "作者原话：可用来减轻 overlap 布局在第 0 帧的参考泄漏，专治开头残影。"
                "不够就继续试 -2 / -3（范围到 -16）。"
                "③ 正值 = 往后挪，一般不用。引导 / 遮罩 / 目标的位置永不受影响。 | "
                "Temporal RoPE offset for reference tokens only, in VAE latent steps. "
                "0 = standard frame-0 placement (may leak reference into the first seconds). "
                "-1 = one latent step before frame 0; reduces overlap frame-0 leakage. "
                "Try -1 first if you see a reference ghost in the opening seconds."
            ),
        },
    )


def reference_temporal_pixel_offset(
    offset_latents: int, temporal_scale_factor: int
) -> int:
    """Convert a latent-step offset to the raw pixel-frame units used by LTX RoPE."""
    return int(offset_latents) * int(temporal_scale_factor)


def shift_reference_temporal_positions(
    positions: torch.Tensor,
    offset_latents: int,
    temporal_scale_factor: int,
) -> torch.Tensor:
    """Shift only the temporal axis of a reference coordinate tensor.

    The helper accepts both ComfyUI's ``[B, axes, tokens]`` coordinates and
    trainer-style tensors with extra trailing dimensions.  A zero offset is an
    exact no-op and returns the original tensor for backward-compatible specs.
    """
    pixel_offset = reference_temporal_pixel_offset(
        offset_latents, temporal_scale_factor
    )
    if pixel_offset == 0:
        return positions
    if positions.ndim < 3 or positions.shape[1] < 1:
        raise ValueError(
            "Reference temporal positions must have shape [batch, axes, ...] "
            f"with a temporal axis; got {tuple(positions.shape)}"
        )
    shifted = positions.clone()
    shifted[:, 0, ...] += torch.as_tensor(
        pixel_offset,
        device=shifted.device,
        dtype=shifted.dtype,
    )
    return shifted
