"""
🖼️ XH-去背景（XHBackgroundRemove）  —— 2026-10-15 新增

── 为什么做这个节点 ────────────────────────────────────────
MINIMAX CHARACTER SWAP 等工作流原来依赖第三方包 ComfyUI-RMBG 的 `RMBG` 节点。
该包在本机 import 失败（缺 hydra 等依赖，且包自身 __init__.py 还有个报错 bug），
用户要求：**用 ComfyUI 官方内核做一个 XH 自己的去背景节点**，端口对齐 RMBG，
能做到「工作流零改线替换、以后不依赖任何第三方去背景包」。

── 实现（全走官方核心，零新增依赖）────────────────────────
  · 模型加载：`comfy.bg_removal_model.load(path)`（官方 BiRefNet）
    权重放 `models/background_removal/`，官方文档：
    https://docs.comfy.org/zh/tutorials/utility/remove-background-birefnet
  · 抠图：`model.encode_image(image)` → 前景遮罩 (B, H, W)，取值 0~1
  · 出透明图：直接 `cat(RGB, 遮罩)` 当 alpha。
    与官方「Remove Background → Invert Mask → Join Image with Alpha」链路**等价** ——
    官方 JoinImageWithAlpha 内部还会再取反一次（源码 comfy_extras/nodes_compositing.py:207），
    一来一回正好抵消，所以这里不需要额外取反。

── 与第三方 RMBG 节点对比 ──────────────────────────────────
  · 端口：输入 `image`(IMAGE) ＋ 输出 `IMAGE`(透明 RGBA) / `MASK`，前两槽对齐 RMBG
    （差别：RMBG 是 3 个输出口 IMAGE/MASK/MASK_IMAGE，本节点不需要 MASK_IMAGE 预览口）
  · 参数精简为 3 个：掩码羽化 / 掩码偏移 / 反转，全中文 tooltip
  · 模型下拉**实时扫描** models/background_removal/，装了新权重 F5 即可选到
"""

import torch
import folder_paths

# 已加载模型缓存：模型名 → BackgroundRemovalModel
# 为什么要缓存：官方是「Load 节点 + Remove 节点」两个节点，模型只加载一次；
# 本节点把加载与推理合在一起，若不缓存则每次执行都重新 load 一遍（几百 MB，很慢）。
_MODEL_CACHE = {}

_MODEL_DIR_HINT = "ComfyUI/models/background_removal/"
_MODEL_DOWNLOAD_HINT = "https://huggingface.co/Comfy-Org/BiRefNet"


def _list_bg_models():
    """扫描 models/background_removal/，给下拉框用（空目录时给一条提示项，避免空 COMBO）。"""
    try:
        files = sorted(folder_paths.get_filename_list("background_removal"))
    except Exception:
        files = []
    if not files:
        return ["（未找到模型）请把 birefnet.safetensors 放进 " + _MODEL_DIR_HINT]
    return files


def _load_bg_model(name):
    """按文件名加载并缓存 BiRefNet 权重。"""
    if name in _MODEL_CACHE:
        return _MODEL_CACHE[name]

    from comfy.bg_removal_model import load as _load_bg  # 官方核心加载器

    path = folder_paths.get_full_path_or_raise("background_removal", name)
    model = _load_bg(path)
    if model is None:
        raise RuntimeError(
            f"[XH-去背景] 这个文件不是有效的背景移除模型：{name}\n"
            f"只认 BiRefNet 格式（birefnet.safetensors）。\n"
            f"下载：{_MODEL_DOWNLOAD_HINT}\n"
            f"放置：{_MODEL_DIR_HINT}"
        )
    _MODEL_CACHE[name] = model
    return model


def _offset_mask(mask, offset):
    """掩码偏移：正数外扩（膨胀）/ 负数内缩（腐蚀），单位像素。用最大池化实现。"""
    if offset == 0:
        return mask
    x = mask.unsqueeze(1)                       # (B,1,H,W)
    k = abs(int(offset)) * 2 + 1
    pad = k // 2
    if offset > 0:
        x = torch.nn.functional.max_pool2d(x, k, 1, pad)
    else:
        x = -torch.nn.functional.max_pool2d(-x, k, 1, pad)
    return x.squeeze(1).clamp(0.0, 1.0)


def _feather_mask(mask, radius):
    """掩码羽化：高斯模糊边缘，radius<=0 不处理。"""
    if radius <= 0:
        return mask
    r = int(radius)
    k = r * 2 + 1
    x = mask.unsqueeze(1)                       # (B,1,H,W)
    coords = torch.arange(k, dtype=torch.float32, device=x.device) - r
    sigma = max(r / 2.0, 1.0)
    g = torch.exp(-(coords ** 2) / (2.0 * sigma * sigma))
    g = g / g.sum()
    ker = (g[:, None] * g[None, :]).view(1, 1, k, k)
    x = torch.nn.functional.pad(x, (r, r, r, r), mode="replicate")
    x = torch.nn.functional.conv2d(x, ker)
    return x.squeeze(1).clamp(0.0, 1.0)


class XHBackgroundRemove:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "image": ("IMAGE", {
                    "tooltip": "【🖼️ 输入图像】要抠掉背景的图。 | English: input image",
                }),
                "model": (_list_bg_models(), {
                    "tooltip": "【🧠 模型】models/background_removal/ 里的 BiRefNet 权重"
                               "（birefnet.safetensors）。没装的话先下载放进该目录，再 F5。"
                               " | English: BiRefNet weights in models/background_removal/. F5 after adding a new file.",
                }),
            },
            "optional": {
                "mask_feather": ("INT", {
                    "default": 0, "min": 0, "max": 128, "step": 1,
                    "tooltip": "【🪶 掩码羽化】边缘柔化半径，0 = 不羽化。抠头发丝常给 2~8。 | English: edge feathering radius, 0 = off; 2~8 for hair.",
                }),
                "mask_offset": ("INT", {
                    "default": 0, "min": -128, "max": 128, "step": 1,
                    "tooltip": "【↔️ 掩码偏移】正数=边缘外扩（留一点边），负数=内缩（去干净残边），0=不动。 | English: positive = expand edges, negative = shrink, 0 = no change.",
                }),
                "invert": ("BOOLEAN", {
                    "default": False,
                    "tooltip": "【🔃 反转】打开后输出「背景」而不是「人物」（透明反着来）。 | English: output background instead of subject.",
                }),
            },
        }

    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("image", "mask")
    FUNCTION = "run"
    CATEGORY = "🔁XH/Image"
    DESCRIPTION = (
        "【🖼️ 去背景】用 ComfyUI 官方 BiRefNet 内核抠图，输出①透明背景图（RGBA）②前景遮罩。\n"
        "模型放 models/background_removal/（birefnet.safetensors）。\n"
        "端口对齐第三方 RMBG 节点，可直接顶替它使用。"
    )

    def run(self, image, model, mask_feather=0, mask_offset=0, invert=False):
        bg = _load_bg_model(model)

        # 官方内核：返回 (B, H, W) 前景遮罩，设备/精度为中间态 → 拉回跟输入图一致
        mask = bg.encode_image(image.to(torch.float32))
        mask = mask.to(device=image.device, dtype=image.dtype)

        # 掩码后处理
        mask = _offset_mask(mask, mask_offset)
        mask = _feather_mask(mask, mask_feather)
        if invert:
            mask = 1.0 - mask

        # 数量对齐（保险：万一 batch 不一致）
        if mask.shape[0] != image.shape[0]:
            if mask.shape[0] == 1:
                mask = mask.repeat(image.shape[0], 1, 1)
            else:
                image = image[:mask.shape[0]]

        rgb = image[..., :3]
        alpha = mask.unsqueeze(-1)                  # (B,H,W,1)
        out = torch.cat((rgb, alpha), dim=-1)       # (B,H,W,4) 透明 RGBA
        return (out, mask)


NODE_CLASS_MAPPINGS = {"XHBackgroundRemove": XHBackgroundRemove}
NODE_DISPLAY_NAME_MAPPINGS = {"XHBackgroundRemove": "🖼️XH-去背景"}
