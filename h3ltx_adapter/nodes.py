"""ComfyUI nodes for the MiniMax-H3 -> LTX-2.5 latent adapter.

The adapter (194.8M params, pure Conv3D) translates a *normalized* H3 latent
into a *normalized* LTX-2.5 latent, replacing an H3 VAE decode + LTX VAE encode
round trip.

Required chain (order matters -- the upscaler runs first):

    H3 sampling -> LATENT (24, T, H/16, W/16)   normalized by ComfyUI's H3 VAE
      -> MinimaxH3LatentUpscaler3D  (scale 2.0)
      -> LATENT (24, T, H/8, W/8)
      -> [H3LTXAdapterConvert]      <-- this pack
      -> LATENT (128, T_ltx, H/32, W/32)
      -> LTX-2.5 refiner sampling -> LTX Conv VAE decode

The adapter is 2x pixel-unshuffle bound: whatever pixel_height/pixel_width you
declare, the incoming latent must be exactly twice the target latent size.
ComfyUI's H3 VAE already emits normalized latents, so keep `input_is_raw` off
unless you are feeding a hand-rolled raw VAE output.
"""

from __future__ import annotations

import gc
import os
from pathlib import Path

import torch

import comfy.model_management as mm
import comfy.model_patcher
import folder_paths

from .h3ltx import FROZEN_CONFIG, H3ToLTXAdapter, expected_shapes
from .h3ltx.constants import H3_CLIP_LENGTH, H3_TEMPORAL_COMPRESSION, H3_TOKEN_DROP
from .h3ltx.geometry import h3_temporal_positions, ltx_temporal_positions, padded_ltx_pixel_frames

FOLDER_KEY = "h3_ltx_adapter"
PLACEHOLDER = "<drop model into models/h3_ltx_adapter>"
DEFAULT_PIXEL_FRAMES = 124  # the frame count the adapter was trained against
H3_OUTPUT_GRID = 5          # H3 aligns generated frame counts to n % 17 == 5
PRECISIONS = {"bf16": torch.bfloat16, "fp16": torch.float16, "fp32": torch.float32}

_CACHE: dict[tuple[str, str, str], H3ToLTXAdapter] = {}
_PATCHER_CACHE: dict[tuple[str, str, str], "comfy.model_patcher.ModelPatcher"] = {}

# The adapter's widest internal tensor is `width` channels (752). ComfyUI needs to
# know about it before the forward runs, otherwise it cannot free room and the
# allocation lands on top of H3/LTX already resident on an 8GB card.
ADAPTER_WIDTH = 752
# Rough transient multiplier over the single widest activation (blocks + concat).
ADAPTER_WORKING_SET_FACTOR = 8


def _estimate_working_memory(latent_frames: int, pixel_height: int, pixel_width: int,
                             dtype: torch.dtype, batch: int = 1) -> int:
    """Bytes ComfyUI should reserve for one adapter forward.

    Mirrors the Sol-H3-Spark sizing: B * width * T_padded * H/32 * W/32 * itemsize,
    scaled by the transient factor. This is a reservation hint, not a hard cap.
    """
    target_frames = (latent_frames - 1) // 8 + 1
    padded_frames = target_frames + int((latent_frames - 1) % 8 != 0)
    target_height = max(1, pixel_height // 32)
    target_width = max(1, pixel_width // 32)
    itemsize = torch.empty((), dtype=dtype).element_size()
    return int(batch * ADAPTER_WIDTH * padded_frames * target_height
               * target_width * itemsize * ADAPTER_WORKING_SET_FACTOR)


def _get_patcher(adapter: H3ToLTXAdapter, cache_key: tuple[str, str, str]):
    """Wrap the adapter in a ComfyUI ModelPatcher so it joins VRAM scheduling.

    Returns None when this ComfyUI build exposes no usable patcher class; the
    caller then falls back to plain `.to(device)` behaviour.
    """
    cached = _PATCHER_CACHE.get(cache_key)
    if cached is not None:
        return cached
    patcher_cls = getattr(comfy.model_patcher, "CoreModelPatcher", None)
    if patcher_cls is None:
        # ComfyUI 0.35.x and earlier call it ModelPatcher.
        patcher_cls = getattr(comfy.model_patcher, "ModelPatcher", None)
    if patcher_cls is None:
        return None
    try:
        patcher = patcher_cls(
            adapter.model,
            load_device=mm.get_torch_device(),
            offload_device=mm.unet_offload_device(),
        )
    except Exception as exc:
        print(f"[🔀XH-H3LTX] ModelPatcher unavailable, falling back to manual device move: {exc}")
        return None
    _PATCHER_CACHE[cache_key] = patcher
    return patcher



# --------------------------------------------------------------------------- #
# model folder registration
# --------------------------------------------------------------------------- #

def _candidate_roots() -> list[Path]:
    """Every plausible `models/` root, including extra_model_paths entries."""
    roots: list[Path] = []
    try:
        roots.append(Path(folder_paths.models_dir))
    except Exception:
        pass
    for key in ("diffusion_models", "checkpoints", "vae", "loras", "latent_upscale_models"):
        try:
            for entry in folder_paths.get_folder_paths(key):
                roots.append(Path(entry).parent)
        except Exception:
            pass
    seen: set[str] = set()
    unique: list[Path] = []
    for root in roots:
        try:
            token = str(root.resolve())
        except Exception:
            token = str(root)
        if token not in seen:
            seen.add(token)
            unique.append(root)
    return unique


def _register_folder() -> None:
    for root in _candidate_roots():
        try:
            folder_paths.add_model_folder_path(FOLDER_KEY, str(root / FOLDER_KEY))
        except Exception:
            pass


_register_folder()


def _walk_safetensors(folder: Path) -> list[str]:
    found: list[str] = []
    if not folder.is_dir():
        return found
    for dirpath, _dirnames, filenames in os.walk(folder):
        for filename in filenames:
            if filename.endswith((".safetensors", ".sft")):
                found.append(os.path.relpath(os.path.join(dirpath, filename), folder))
    return found


def _scan_models() -> list[str]:
    """Scan the disk directly so it never depends on ComfyUI's filename cache."""
    _register_folder()  # tolerate custom_nodes loading before extra_model_paths
    names: list[str] = []
    for root in _candidate_roots():
        names.extend(_walk_safetensors(root / FOLDER_KEY))
    if not names:  # tolerate the model being dropped next to the H3 weights instead
        for root in _candidate_roots():
            for name in _walk_safetensors(root / "diffusion_models"):
                low = name.lower()
                if "ltx_adapter" in low or "h3_ltx" in low or "h3ltx" in low:
                    names.append(name)
    ordered: list[str] = []
    for name in names:
        if name not in ordered:
            ordered.append(name)
    return ordered or [PLACEHOLDER]


def _resolve(name: str) -> str:
    if not name or name == PLACEHOLDER:
        raise FileNotFoundError(
            f"No adapter checkpoint found. Download model.safetensors from "
            f"MATLOWAI/Efficient-Large-Model H3-to-LTX-Latent-Adapter into "
            f"<ComfyUI>/models/{FOLDER_KEY}/ and refresh the node definitions."
        )
    for key in (FOLDER_KEY, "diffusion_models"):
        try:
            full = folder_paths.get_full_path(key, name)
        except Exception:
            full = None
        if full and os.path.isfile(full):
            return full
    raise FileNotFoundError(f"adapter checkpoint not found on disk: {name}")


def _get_adapter(name: str, device: str, precision: str, force_reload: bool = False) -> H3ToLTXAdapter:
    path = _resolve(name)
    dtype = PRECISIONS.get(precision, torch.bfloat16)
    # resolve "cuda" to the actual compute device ComfyUI is using
    dev = device
    if dev == "cuda" and not torch.cuda.is_available():
        print("[🔀XH-H3LTX] CUDA unavailable, falling back to CPU")
        dev = "cpu"
    key = (path, dev, precision)
    adapter = _CACHE.get(key)
    if adapter is None or force_reload:
        print(f"[🔀XH-H3LTX] loading {Path(path).name} ({precision}) on {dev}")
        adapter = H3ToLTXAdapter.load(path, config=FROZEN_CONFIG, device=dev, dtype=dtype)
        _CACHE[key] = adapter
        if force_reload:
            _PATCHER_CACHE.pop(key, None)
        _get_patcher(adapter, key)
    return adapter


def _unload(adapter: H3ToLTXAdapter) -> None:
    for key, cached in list(_CACHE.items()):
        if cached is adapter:
            _CACHE.pop(key, None)
            _PATCHER_CACHE.pop(key, None)
    try:
        adapter.model.to("cpu")
    except Exception:
        pass
    gc.collect()
    try:
        mm.soft_empty_cache()
    except Exception:
        if torch.cuda.is_available():
            torch.cuda.empty_cache()


def _pack_health(pixel_frames: int) -> tuple[int, int]:
    """Geometry-only dry run of the nearest-pack for one candidate frame count.

    Returns (required_slots, empty_targets).
      required_slots > checkpoint pack slots -> temporal_nearest_pack() raises.
      empty targets = LTX frames no H3 token maps onto -> blank (white/black) tail frame.
    """
    source = h3_temporal_positions(pixel_frames)
    target = ltx_temporal_positions(padded_ltx_pixel_frames(pixel_frames))
    counts = [0] * len(target)
    for position in source:
        nearest = min(range(len(target)), key=lambda index: (abs(target[index] - position), index))
        counts[nearest] += 1
    return max(counts), counts.count(0)


def _infer_pixel_frames(latent_frames: int) -> tuple[int | None, list[int]]:
    """Invert h3_temporal_positions(): T = ceil(n/17)*5 - 3  =>  n in a 17-wide band.

    Every n inside the band yields the very same latent T, so the shape check can
    never tell them apart -- the band has to be resolved by geometry, not by shape.
    The old rule (nearest to DEFAULT_PIXEL_FRAMES) always landed on the band edge,
    which crashes on some lengths and leaves a blank tail frame on others.

    New order:
      1. drop candidates whose nearest-pack needs more slots than the checkpoint has
      2. prefer candidates with no empty target (no blank tail frame)
      3. among survivors prefer the H3 output grid n % 17 == 5, else take the middle
    """
    tokens_per_chunk = (H3_CLIP_LENGTH + H3_TEMPORAL_COMPRESSION - 1) // H3_TEMPORAL_COMPRESSION
    total = latent_frames + H3_TOKEN_DROP
    if tokens_per_chunk and total % tokens_per_chunk == 0:
        chunks = total // tokens_per_chunk
        if chunks > 0:
            low = (chunks - 1) * H3_CLIP_LENGTH + 1
            high = chunks * H3_CLIP_LENGTH
            candidates = list(range(low, high + 1))
            slots = int(FROZEN_CONFIG.get("geometry", {}).get("temporal_pack_slots", 3))
            scored = [(n, *_pack_health(n)) for n in candidates]
            safe = [item for item in scored if item[1] <= slots] or scored
            clean = [item for item in safe if item[2] == 0] or safe
            on_grid = [item for item in clean if item[0] % H3_CLIP_LENGTH == H3_OUTPUT_GRID]
            if on_grid:
                return on_grid[0][0], candidates
            return clean[len(clean) // 2][0], candidates
    return None, []


# --------------------------------------------------------------------------- #
# nodes
# --------------------------------------------------------------------------- #

class H3LTXAdapterLoader:
    """Load the frozen H3 -> LTX-2.5 Conv3D adapter checkpoint."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model_name": (_scan_models(), {
                    "tooltip": "放在 models/h3_ltx_adapter/ 下的 safetensors | safetensors under models/h3_ltx_adapter/",
                }),
                "device": (["cuda", "cpu"], {
                    "default": "cuda",
                    "tooltip": "推理设备，显存紧张可先放 cpu | Inference device; use cpu when VRAM is tight",
                }),
                "precision": (["bf16", "fp16", "fp32"], {
                    "default": "bf16",
                    "tooltip": "运算精度，checkpoint 原生是 bf16 | Compute dtype; the checkpoint is natively bf16",
                }),
                "reload": ("BOOLEAN", {
                    "default": False,
                    "tooltip": "强制重新从磁盘加载，忽略缓存 | Force reload from disk, ignore cache",
                }),
            }
        }

    RETURN_TYPES = ("H3LTX_ADAPTER",)
    RETURN_NAMES = ("adapter",)
    FUNCTION = "load"
    CATEGORY = "🔁XH/Video"
    DESCRIPTION = "🔀 加载 H3→LTX-2.5 latent 转换器（NVIDIA Sol-H3-Spark 的 Conv3D 适配器，194.8M 参数）。 | 🔀 Load the H3→LTX-2.5 latent adapter (NVIDIA Sol-H3-Spark Conv3D, 194.8M params)."

    def load(self, model_name, device, precision, reload):
        adapter = _get_adapter(model_name, device, precision, force_reload=reload)
        params = sum(p.numel() for p in adapter.model.parameters())
        print(f"[🔀XH-H3LTX] ready: {params:,} params, dtype={adapter.dtype}, device={adapter.device}")
        return (adapter,)


class H3LTXAdapterConvert:
    """Translate a normalized H3 latent into a normalized LTX-2.5 latent."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "adapter": ("H3LTX_ADAPTER", {
                    "tooltip": (
                        "「🔀XH-H3LTX-适配器加载」节点输出的那张卡在这里，不接就没法转换。\n"
                        "它是那个 194.8M 参数、纯 Conv3D 的 H3→LTX 适配器，"
                        "用来替换一次「H3 VAE 解码 + LTX VAE 再编码」的往返。\n"
                        "⚠️ 换模型/换精度要回到加载节点那边改，然后重新往外拉一根线，"
                        "本节点自己不会重新读盘。"
                    ),
                }),
                "latent": ("LATENT", {
                    "tooltip": "H3 latent（已过 ×2 放大器的 normalized latent） | H3 latent (normalized, after the ×2 upscaler)",
                }),
                "pixel_frames": ("INT", {
                    "default": 0, "min": 0, "max": 8192, "step": 1,
                    "tooltip": "H3 原始像素帧数（官方 124）。0 = 从 latent 时间长度自动反推 | H3 source pixel frames (official 124). 0 = infer from latent length",
                }),
                "pixel_height": ("INT", {
                    "default": 0, "min": 0, "max": 16384, "step": 16,
                    "tooltip": "0 = latent_H × 16（放大后的像素高，即 H3 原生像素的 2 倍） | 0 = latent_H × 16",
                }),
                "pixel_width": ("INT", {
                    "default": 0, "min": 0, "max": 16384, "step": 16,
                    "tooltip": "0 = latent_W × 16（放大后的像素宽） | 0 = latent_W × 16",
                }),
            },
            "optional": {
                "input_is_raw": ("BOOLEAN", {
                    "default": False,
                    "tooltip": "ComfyUI 的 H3 VAE 输出已是 normalized，保持关闭 | H3 VAE output is already normalized, keep off",
                }),
                "drop_last_frame": ("BOOLEAN", {
                    "default": False,
                    "tooltip": "丢掉 LTX latent 的最后一帧（Spark 官方精修前裁成 16 帧） | Drop the last LTX latent frame (Spark Stage2 trims to 16)",
                }),
                "unload_after": ("BOOLEAN", {
                    "default": False,
                    "tooltip": "推理完把模型移回 CPU 释放显存 | Move the model back to CPU after inference",
                }),
            },
        }

    RETURN_TYPES = ("LATENT", "INT", "INT", "INT", "STRING")
    RETURN_NAMES = ("ltx_latent", "pixel_frames", "width", "height", "report")
    FUNCTION = "convert"
    CATEGORY = "🔁XH/Video"
    DESCRIPTION = "🔀 把 H3 的 24 通道 latent 转成 LTX-2.5 的 128 通道 latent（形状与归一化同时完成）。 | 🔀 Convert a 24-channel H3 latent into a 128-channel LTX-2.5 latent (shape + normalization in one step)."

    def convert(self, adapter, latent, pixel_frames, pixel_height, pixel_width,
                input_is_raw=False, drop_last_frame=False, unload_after=False):
        samples = latent["samples"]
        original_dtype = samples.dtype
        if samples.ndim == 4:  # (B,C,H,W) -> give it a temporal axis
            samples = samples.unsqueeze(2)
        if samples.ndim != 5:
            raise ValueError(f"expected a 4D/5D H3 latent, got shape {tuple(samples.shape)}")
        batch, channels, latent_frames, height, width = samples.shape
        if channels != 24:
            raise ValueError(
                f"expected a 24-channel H3 latent, got {channels}. "
                f"Feed the output of the H3 VAE / upscaler, not an LTX latent."
            )

        notes: list[str] = []

        if int(pixel_frames) > 0:
            frames = int(pixel_frames)
        else:
            frames, candidates = _infer_pixel_frames(latent_frames)
            if frames is None:
                raise ValueError(
                    f"cannot invert pixel_frames from H3 latent T={latent_frames}. "
                    f"Set pixel_frames manually (the official value is 124)."
                )
            if len(candidates) > 1:
                notes.append(
                    f"pixel_frames={frames} (auto, band {candidates[0]}-{candidates[-1]} all share T={latent_frames})"
                )
            else:
                notes.append(f"pixel_frames={frames} (auto)")

        pix_h = int(pixel_height) if int(pixel_height) > 0 else height * 16
        pix_w = int(pixel_width) if int(pixel_width) > 0 else width * 16

        if pix_h % 32 or pix_w % 32:
            raise ValueError(f"pixel_height/pixel_width must be divisible by 32, got {pix_h}x{pix_w}")

        expected = expected_shapes(frames, pix_h, pix_w)
        if list(samples.shape[1:]) != expected["h3"]:
            raise ValueError(
                f"H3 latent {list(samples.shape[1:])} != expected {expected['h3']}.\n"
                f"Check: pixel_frames={frames}, pixel={pix_h}x{pix_w}. "
                f"If you skipped the ×2 upscaler, the latent must be {pix_h // 16}x{pix_w // 16} "
                f"and pixel_height/pixel_width should be half of what you passed."
            )

        if height * 16 != pix_h or width * 16 != pix_w:
            notes.append(f"pixel {pix_h}x{pix_w} (declared) vs latent-derived {height * 16}x{width * 16}")

        # Join ComfyUI's VRAM scheduling: declare the adapter's transient footprint
        # so the allocator frees room instead of discovering the peak via OOM.
        patcher = None
        for cache_key, cached in _CACHE.items():
            if cached is adapter:
                patcher = _PATCHER_CACHE.get(cache_key)
                break
        if patcher is not None:
            working_memory = _estimate_working_memory(
                latent_frames, pix_h, pix_w,
                adapter.dtype if isinstance(adapter.dtype, torch.dtype) else torch.bfloat16,
                batch=batch,
            )
            try:
                mm.load_models_gpu(
                    [patcher],
                    memory_required=working_memory,
                    force_full_load=True,
                )
            except Exception as exc:
                notes.append(f"VRAM scheduling skipped: {exc}")
        else:
            notes.append("no ModelPatcher (manual device placement)")

        output = adapter.convert(
            samples,
            pixel_frames=frames,
            pixel_height=pix_h,
            pixel_width=pix_w,
            input_normalization="raw" if input_is_raw else "normalized",
        )
        if drop_last_frame and output.shape[2] > 1:
            output = output[:, :, :-1]
            notes.append("dropped last LTX frame")

        out_dtype = original_dtype if original_dtype in (torch.float16, torch.bfloat16, torch.float32) else torch.float32
        output = output.to(dtype=out_dtype, device="cpu", non_blocking=True)

        if unload_after:
            _unload(adapter)
            notes.append("adapter unloaded to CPU")

        padded = padded_ltx_pixel_frames(frames)
        report = "\n".join([
            "H3 -> LTX latent adapter",
            f"  H3 latent in : {tuple(samples.shape)}  ({'raw' if input_is_raw else 'normalized'})",
            f"  pixel_frames : {frames}  (padded to {padded} for LTX)",
            f"  aligned      : {tuple([batch] + expected['aligned_h3'])}",
            f"  LTX latent   : {tuple(output.shape)}",
            f"  LTX pixel eq.: {pix_h}x{pix_w}, {output.shape[2]} latent / {frames} real frames",
        ] + [f"  note         : {n}" for n in notes])
        print("[🔀XH-H3LTX]\n" + report)
        return ({"samples": output}, int(frames), int(pix_w), int(pix_h), report)


NODE_CLASS_MAPPINGS = {
    "H3LTXAdapterLoader": H3LTXAdapterLoader,
    "H3LTXAdapterConvert": H3LTXAdapterConvert,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "H3LTXAdapterLoader": "🔀XH-H3LTX-适配器加载",
    "H3LTXAdapterConvert": "🔀XH-H3LTX-转换",
}
