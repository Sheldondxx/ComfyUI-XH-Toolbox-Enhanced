"""
🖼️ XH-图像工具（复刻自 comfyui-kjnodes）
================================================================
本文件 = 两个可用节点 + 一个内部依赖，**算法与 KJNodes 原版逐字节一致**。
只改了「显示层」：类名 / 分类 / tooltip（中文）/ 下拉选项文字（中英双语）。

原作：comfyui-kjnodes  (Kosinkadink)
      nodes/image_nodes.py  →  ImageBatchMulti / ImageResizeKJv2 / ImagePadKJ
      utility/utility.py    →  string_to_color

包含：
  · XHImageResizeV2    ← ImageResizeKJv2      （注册节点）
  · XHImageBatchMulti  ← ImageBatchMulti      （注册节点）
  · XHImagePadKJ       ← ImagePadKJ           （内部依赖，被 Resize 的补边模式调用，不注册）

回滚：直接删掉本包目录。原版 KJNodes 毫发无损，旧工作流照旧能跑。

改了什么（只有显示层）：
  1. 类名加 XH 前缀（避免与 KJNodes 撞名，两套可同时安装）
  2. CATEGORY  KJNodes/image  →  🔁XH/Image
  3. 所有参数补中文 tooltip（保留 English 原词，方便对照官方文档）
  4. 4 个下拉列表 → 「① 中文 (english)」；后端 _xh_norm 收敛回英文原值，旧存档/API 完全兼容
  5. DESCRIPTION 改中文（原文附在 README）
没有改：任何计算逻辑、默认值、参数顺序、返回值顺序。
"""
from __future__ import annotations

import math
import logging

import numpy as np
import torch
import torch.nn.functional as F
from PIL import ImageColor

from nodes import MAX_RESOLUTION
from comfy.utils import common_upscale
from comfy import model_management

try:
    from server import PromptServer
except Exception:  # 脱离 ComfyUI 环境做语法/单测时不至于炸
    PromptServer = None


# ══════════════════════════════════════════════════════════════
# XH：双语下拉值 → 英文原值 归一化
# 下拉显示是「① 中文 (english)」，值里仍含英文原词，这里把它剥离回来。
# ⚠️ 顺序要求：**包含关系必须长词在前**（如 pad_edge_pixel 含 pad_edge 含 pad，
#    必须按 pad_edge_pixel → pad_edge → pad 的顺序排）。
# ⚠️ 每组的**最后一项 = 兜底值**（匹配不到任何词时返回它），请与「原版默认值」对齐。
# ══════════════════════════════════════════════════════════════
_XH_UPSCALE = ("nvidia_rtx_vsr", "bilinear", "area", "bicubic", "lanczos",
               "nearest-exact")              # 兜底 = nearest-exact（原版无 default，前端取列表首项）
_XH_KEEP = ("pad_edge_pixel", "pad_edge", "pad", "pillarbox_blur", "total_pixels",
            "resize", "crop", "stretch")     # 兜底 = stretch（原版 default=False 时前端取列表首项 stretch）
_XH_CROP_POS = ("top", "bottom", "left", "right", "center")   # 兜底 = center（原版 default=center）
_XH_DEVICE = ("gpu", "cpu")                                  # 兜底 = cpu（原版列表首项）


def _xh_norm(value, canon):
    """把双语显示值 / 旧存档纯英文值，统一收敛成英文原值。"""
    s = str(value or "")
    for key in canon:
        if key in s:
            return key
    return canon[-1]


def string_to_color(color_string: str) -> List[int]:
    color_list = [0, 0, 0]  # Default fallback (black)

    if ',' in color_string:
        # Handle CSV format (e.g., "255, 0, 0" or "255, 0, 0, 128" or "1.0, 0.5, 0.0")
        try:
            values = [float(channel.strip()) for channel in color_string.split(',')]
            # Convert to 0-255 range if values are in 0-1 range
            if all(0 <= v <= 1 for v in values):
                color_list = [int(v * 255) for v in values]
            else:
                color_list = [int(v) for v in values]
        except ValueError:
            logging.warning(f"Invalid color format: {color_string}. Using default black.")
    elif color_string.startswith('#') or (color_string.lstrip('#').isalnum() and not color_string.lstrip('#').replace('.', '', 1).isdigit()):
        # Could be Hex format or color name
        color_string_stripped = color_string.lstrip('#')
        # Try hex first
        if len(color_string_stripped) in [6, 8] and all(c in '0123456789ABCDEFabcdef' for c in color_string_stripped):
            if len(color_string_stripped) == 6:  # #RRGGBB
                color_list = [int(color_string_stripped[i:i+2], 16) for i in (0, 2, 4)]
            elif len(color_string_stripped) == 8:  # #RRGGBBAA
                color_list = [int(color_string_stripped[i:i+2], 16) for i in (0, 2, 4, 6)]
        else:
            # Try color name (e.g., "red", "blue", "cyan")
            try:
                rgb = ImageColor.getrgb(color_string)
                color_list = list(rgb)
            except ValueError:
                logging.warning(f"Invalid color name or hex format: {color_string}. Using default black.")
    else:
        # Handle single value (grayscale) - can be int or float
        try:
            value = float(color_string.strip())
            # Convert to 0-255 range if it's a float between 0-1
            if 0 <= value <= 1:
                value = int(value * 255)
            else:
                value = int(value)
            color_list = [value, value, value]
        except ValueError:
            logging.warning(f"Invalid color format: {color_string}. Using default black.")

    # Clip values to valid range
    color_list = np.clip(color_list, 0, 255).tolist()

    return color_list


class XHImageBatchMulti:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "inputcount": ("INT", {"default": 2, "min": 2, "max": 1000, "step": 1, "tooltip": "【🔢 输入口数量】想合并几张图就填几。改完点下面的「🔄 更新输入口」按钮，输入槽才会增减。 | English: inputcount"}),
                "image_1": ("IMAGE", {"tooltip": "【🖼️ 第 1 张图】必填。输出尺寸以它为基准。 | English: image_1"}),
            },
            "optional": {
                "image_2": ("IMAGE", {"tooltip": "【🖼️ 第 2 张图】可选，不接就以黑图占位（保持帧数）。 | English: image_2"}),
            }
    }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("images",)
    FUNCTION = "combine"
    CATEGORY = "🔁XH/Image"
    DESCRIPTION = """【🖼️ 图像批量合并】把多张图按顺序拼成一个 batch（批次）。
想接几张就先改 inputcount，再点「🔄 更新输入口」按钮。
尺寸不一致的图会自动缩放到和第 1 张一样大，会补成全画幅。
⚠️ 这是「批次」不是「拼版」—— 每张图仍独立存在，不会被拼进同一画面。
（算法与原版 KJNodes Image Batch Multi 逐字节一致）"""

    def combine(self, inputcount, **kwargs):
        first = kwargs["image_1"]
        h, w = first.shape[1], first.shape[2]

        # determine output shape
        max_ch = first.shape[-1]
        total_frames = first.shape[0]
        for c in range(1, inputcount):
            img = kwargs.get(f"image_{c + 1}")
            if img is not None:
                max_ch = max(max_ch, img.shape[-1])
                total_frames += img.shape[0]
            else:
                total_frames += first.shape[0]

        # pre-allocate output
        out = torch.empty((total_frames, h, w, max_ch), dtype=first.dtype)
        offset = 0

        for c in range(inputcount):
            img = kwargs.get(f"image_{c + 1}", torch.zeros((first.shape[0], h, w, max_ch), dtype=first.dtype))

            if img.shape[1:3] != (h, w):
                img = common_upscale(img.movedim(-1, 1), w, h, "bilinear", "center").movedim(1, -1)

            if img.shape[-1] < max_ch:
                img = torch.nn.functional.pad(img, (0, max_ch - img.shape[-1]), mode='constant', value=1.0)

            n = img.shape[0]
            out[offset:offset + n].copy_(img, non_blocking=True)
            offset += n
            del img

        return (out.cpu(),)


class XHImageResizeV2:
    # XH：下拉显示中文，值里仍带英文原词 → _xh_norm 收敛回英文，旧工作流与 API 完全兼容
    upscale_methods = [
        "① 最近邻 (nearest-exact)",
        "② 双线性 (bilinear)",
        "③ 区域平均 (area)",
        "④ 双三次 (bicubic)",
        "⑤ 兰索斯 (lanczos)",
        "⑥ RTX超分 (nvidia_rtx_vsr)",
    ]
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "image": ("IMAGE", {"tooltip": "【🖼️ 输入图像】要缩放/裁切的图像（可以是批次）。 | English: image"}),
                "width": ("INT", { "default": 512, "min": 0, "max": MAX_RESOLUTION, "step": 1, "tooltip": "【📐 目标宽度】想要输出的宽度（像素）。填 0 = 按高度自动等比推算。 | English: width"}),
                "height": ("INT", { "default": 512, "min": 0, "max": MAX_RESOLUTION, "step": 1, "tooltip": "【📏 目标高度】想要输出的高度（像素）。填 0 = 按宽度自动等比推算。 | English: height"}),
                "upscale_method": (s.upscale_methods, {"tooltip": "【🔍 缩放算法】\n① 最近邻 nearest-exact：最快，有锯齿，适合像素画/蒙版\n② 双线性 bilinear：快，偏软，拉伸大时糊\n③ 区域平均 area：缩小时最平滑（推荐缩小用）\n④ 双三次 bicubic：通用，锐度好\n⑤ 兰索斯 lanczos：最锐利，细节最好（★ 你现在用的，仅 CPU）\n⑥ RTX超分 nvidia_rtx_vsr：需装 nvidia-vfx 库，本机没装别选\n | English: upscale_method"}),
                "keep_proportion": ([
                    "① 拉伸铺满 (stretch)",
                    "② 等比缩放 (resize)",
                    "③ 补边·纯色 (pad)",
                    "④ 补边·边缘均值 (pad_edge)",
                    "⑤ 补边·边缘像素 (pad_edge_pixel)",
                    "⑥ 裁剪填满 (crop)",
                    "⑦ 补边·毛玻璃 (pillarbox_blur)",
                    "⑧ 等总像素 (total_pixels)",
                ], { "default": False,
                    "tooltip": "【✂️ 保持比例方式】图像怎么适配目标宽高：\n① 拉伸铺满 stretch：不管比例硬拉成目标尺寸（会变形）\n② 等比缩放 resize：只缩不裁，缩到能放进框里；⚠️ 输出可能小于目标，且**不改画幅比例**（1:1 进去还是 1:1）\n③ 补边·纯色 pad：等比缩放后空处补 pad_color 颜色\n④ 补边·边缘均值 pad_edge：补边用边缘一条的平均色（边缘延展，比纯色自然）\n⑤ 补边·边缘像素 pad_edge_pixel：补边用边缘原像素直接拉出去（会拉丝）\n⑥ 裁剪填满 crop：先按目标画幅比例裁一刀，再缩到满框 —— 输出尺寸精确等于目标。★ 想「换画幅而不留空」就选它\n⑦ 补边·毛玻璃 pillarbox_blur：背景放大+模糊+压暗当底再填\n⑧ 等总像素 total_pixels：把 width×height 当成总像素数，按原图比例分配\n | English: keep_proportion"}),
                "pad_color": ("STRING", { "default": "0, 0, 0", "tooltip": "【🎨 补边颜色】仅「③ 补边·纯色 pad」生效。支持 0-255 的 RGB（如 235, 235, 238）/ 0-1 浮点 / 颜色名(black) / #RRGGBB。 | English: Color to use for padding."}),
                "crop_position": ([
                    "① 居中 (center)",
                    "② 靠上 (top)",
                    "③ 靠下 (bottom)",
                    "④ 靠左 (left)",
                    "⑤ 靠右 (right)",
                ], { "default": "① 居中 (center)",
                    "tooltip": "【📍 裁切/补边锚点】「⑥ 裁剪填满 crop」时决定从哪一边开始裁（★ 横屏裁上下、竖屏裁左右，选 top 能保住头顶但会丢下巴）；补边模式下决定内容贴哪一边。 | English: crop_position"}),
                "divisible_by": ("INT", { "default": 2, "min": 0, "max": 512, "step": 1, "tooltip": "【➗ 整除对齐】输出宽高会向下取整到它的倍数。喂视频模型（LTX/H3）建议填 32 或 64；纯图片处理保持 2。 | English: divisible_by"}),
            },
            "optional" : {
                "mask": ("MASK", {"tooltip": "【🎭 可选蒙版】会跟着图像一起缩放/裁切/补边，输出对齐后的蒙版。 | English: mask"}),
                "device": (["① CPU (cpu)", "② GPU (gpu)"], {"tooltip": "【⚙️ 计算设备】缩放运算在哪跑。GPU 更快但吃显存；⚠️「⑤ 兰索斯 lanczos」不支持 GPU，选了会报错。 | English: cpu / gpu"}),
                #"per_batch": ("INT", { "default": 0, "min": 0, "max": MAX_RESOLUTION, "step": 1, "tooltip": "Process images in sub-batches to reduce memory usage. 0 disables sub-batching."}),
            },
             "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    RETURN_TYPES = ("IMAGE", "INT", "INT", "MASK",)
    RETURN_NAMES = ("IMAGE", "width", "height", "mask",)
    FUNCTION = "resize"
    CATEGORY = "🔁XH/Image"
    DESCRIPTION = """【🖼️ 图像缩放 v2】把图像缩放到指定宽高，输出还会带出实际宽高和蒙版。
关键在「保持比例方式 keep_proportion」：
· 只想改大小 → 「② 等比缩放 resize」（不改画幅，1:1 进 1:1 出）
· 想改画幅比例（如 1:1 图要喂 9:16 视频）→ 「⑥ 裁剪填满 crop」，输出精确等于你填的宽高
· 想不裁任何像素 → 「④ 补边·边缘均值 pad_edge」或「③ 补边·纯色 pad」
（算法与原版 KJNodes Resize Image v2 逐字节一致）"""

    def resize(self, image, width, height, keep_proportion, upscale_method, divisible_by, pad_color, crop_position, unique_id, device="cpu", mask=None, per_batch=64):
        # ── XH：把「① 中文 (english)」或旧存档里的纯英文值，统一收敛回英文原值 ──
        # 下面所有判断继续用纯英文比较，算法一行未改。
        keep_proportion = _xh_norm(keep_proportion, _XH_KEEP)
        upscale_method = _xh_norm(upscale_method, _XH_UPSCALE)
        crop_position = _xh_norm(crop_position, _XH_CROP_POS)
        device = _xh_norm(device, _XH_DEVICE)

        B, H, W, C = image.shape

        # Treat ComfyUI's 64x64 placeholder mask as no mask
        if mask is not None and mask.shape[-2:] == (64, 64) and (H != 64 or W != 64):
            mask = None

        # Scale mask to match image dimensions if they differ
        if mask is not None and mask.shape[-2:] != (H, W):
            mask = common_upscale(mask.unsqueeze(1), W, H, "bilinear", crop="disabled").squeeze(1)

        if device == "gpu":
            if upscale_method == "lanczos":
                raise ValueError("Lanczos is not supported on the GPU")
            device = model_management.get_torch_device()
        else:
            device = torch.device("cpu")

        pillarbox_blur = keep_proportion == "pillarbox_blur"

        # Initialize padding variables
        pad_left = pad_right = pad_top = pad_bottom = 0

        if keep_proportion in ["resize", "total_pixels"] or keep_proportion.startswith("pad") or pillarbox_blur:
            if keep_proportion == "total_pixels":
                total_pixels = width * height
                aspect_ratio = W / H
                new_height = int(math.sqrt(total_pixels / aspect_ratio))
                new_width = int(math.sqrt(total_pixels * aspect_ratio))

            # If one of the dimensions is zero, calculate it to maintain the aspect ratio
            elif width == 0 and height == 0:
                new_width = W
                new_height = H
            elif width == 0 and height != 0:
                ratio = height / H
                new_width = round(W * ratio)
                new_height = height
            elif height == 0 and width != 0:
                ratio = width / W
                new_width = width
                new_height = round(H * ratio)
            elif width != 0 and height != 0:
                ratio = min(width / W, height / H)
                new_width = round(W * ratio)
                new_height = round(H * ratio)
            else:
                new_width = width
                new_height = height

            if keep_proportion.startswith("pad") or pillarbox_blur:
                # Calculate padding based on position
                if crop_position == "center":
                    pad_left = (width - new_width) // 2
                    pad_right = width - new_width - pad_left
                    pad_top = (height - new_height) // 2
                    pad_bottom = height - new_height - pad_top
                elif crop_position == "top":
                    pad_left = (width - new_width) // 2
                    pad_right = width - new_width - pad_left
                    pad_top = 0
                    pad_bottom = height - new_height
                elif crop_position == "bottom":
                    pad_left = (width - new_width) // 2
                    pad_right = width - new_width - pad_left
                    pad_top = height - new_height
                    pad_bottom = 0
                elif crop_position == "left":
                    pad_left = 0
                    pad_right = width - new_width
                    pad_top = (height - new_height) // 2
                    pad_bottom = height - new_height - pad_top
                elif crop_position == "right":
                    pad_left = width - new_width
                    pad_right = 0
                    pad_top = (height - new_height) // 2
                    pad_bottom = height - new_height - pad_top

            width = new_width
            height = new_height
        else:
            if width == 0:
                width = W
            if height == 0:
                height = H

        if divisible_by > 1:
            width = width - (width % divisible_by)
            height = height - (height % divisible_by)

        # Preflight estimate (log-only when batching is active)
        if per_batch != 0 and B > per_batch:
            try:
                bytes_per_elem = image.element_size()  # typically 4 for float32
                est_total_bytes = B * height * width * C * bytes_per_elem
                est_mb = est_total_bytes / (1024 * 1024)
                msg = f"<tr><td>Resize v2</td><td>estimated output ~{est_mb:.2f} MB; batching {per_batch}/{B}</td></tr>"
                if unique_id and PromptServer is not None:
                    try:
                        PromptServer.instance.send_progress_text(msg, unique_id)
                    except Exception:
                        pass
                else:
                    logging.info(f"[XH-图像缩放v2] estimated output ~{est_mb:.2f} MB; batching {per_batch}/{B}")
            except Exception:
                pass

        # NVIDIA RTX Video Super Resolution setup
        nvvfx_sr = None
        nvvfx_ctx = None
        if upscale_method == "nvidia_rtx_vsr":
            try:
                import nvvfx
            except ImportError:
                raise ImportError("NVIDIA RTX Video Super Resolution is not available. Please install the nvidia-vfx library and ensure you have a compatible NVIDIA GPU.")
            nvvfx_ctx = nvvfx.VideoSuperRes(nvvfx.effects.QualityLevel.ULTRA)
            nvvfx_sr = nvvfx_ctx.__enter__()
            nvvfx_sr.output_width = max(8, round(width / 8) * 8)
            nvvfx_sr.output_height = max(8, round(height / 8) * 8)
            nvvfx_sr.load()

        def _process_subbatch(in_image, in_mask, pad_left, pad_right, pad_top, pad_bottom):
            # Avoid unnecessary clones; only move if needed
            out_image = in_image if in_image.device == device else in_image.to(device)
            out_mask = None if in_mask is None else (in_mask if in_mask.device == device else in_mask.to(device))

            # Crop logic
            if keep_proportion == "crop":
                old_height = out_image.shape[-3]
                old_width = out_image.shape[-2]
                old_aspect = old_width / old_height
                new_aspect = width / height
                if old_aspect > new_aspect:
                    crop_w = round(old_height * new_aspect)
                    crop_h = old_height
                else:
                    crop_w = old_width
                    crop_h = round(old_width / new_aspect)
                if crop_position == "center":
                    x = (old_width - crop_w) // 2
                    y = (old_height - crop_h) // 2
                elif crop_position == "top":
                    x = (old_width - crop_w) // 2
                    y = 0
                elif crop_position == "bottom":
                    x = (old_width - crop_w) // 2
                    y = old_height - crop_h
                elif crop_position == "left":
                    x = 0
                    y = (old_height - crop_h) // 2
                elif crop_position == "right":
                    x = old_width - crop_w
                    y = (old_height - crop_h) // 2
                out_image = out_image.narrow(-2, x, crop_w).narrow(-3, y, crop_h)
                if out_mask is not None:
                    out_mask = out_mask.narrow(-1, x, crop_w).narrow(-2, y, crop_h)

            if upscale_method == "nvidia_rtx_vsr":
                # Process each frame through RTX Video Super Resolution
                frames_chw = out_image.movedim(-1, 1).cuda().contiguous()
                upscaled_frames = []
                for j in range(frames_chw.shape[0]):
                    dlpack_out = nvvfx_sr.run(frames_chw[j]).image
                    upscaled_frames.append(torch.from_dlpack(dlpack_out).clone())
                out_image = torch.stack(upscaled_frames, dim=0).movedim(1, -1).cpu()
                if out_mask is not None:
                    out_mask = common_upscale(out_mask.unsqueeze(1), width, height, "bilinear", crop="disabled").squeeze(1)
            else:
                out_image = common_upscale(out_image.movedim(-1,1), width, height, upscale_method, crop="disabled").movedim(1,-1)
                if out_mask is not None:
                    if upscale_method == "lanczos":
                        out_mask = common_upscale(out_mask.unsqueeze(1).repeat(1, 3, 1, 1), width, height, upscale_method, crop="disabled").movedim(1,-1)[:, :, :, 0]
                    else:
                        out_mask = common_upscale(out_mask.unsqueeze(1), width, height, upscale_method, crop="disabled").squeeze(1)

            # Pad logic
            if (keep_proportion.startswith("pad") or pillarbox_blur) and (pad_left > 0 or pad_right > 0 or pad_top > 0 or pad_bottom > 0):
                padded_width = width + pad_left + pad_right
                padded_height = height + pad_top + pad_bottom
                if divisible_by > 1:
                    width_remainder = padded_width % divisible_by
                    height_remainder = padded_height % divisible_by
                    if width_remainder > 0:
                        extra_width = divisible_by - width_remainder
                        pad_right += extra_width
                    if height_remainder > 0:
                        extra_height = divisible_by - height_remainder
                        pad_bottom += extra_height

                pad_mode = (
                    "pillarbox_blur" if pillarbox_blur else
                    "edge" if keep_proportion == "pad_edge" else
                    "edge_pixel" if keep_proportion == "pad_edge_pixel" else
                    "color"
                )
                out_image, out_mask = XHImagePadKJ.pad(self, out_image, pad_left, pad_right, pad_top, pad_bottom, 0, pad_color, pad_mode, mask=out_mask)

            return out_image, out_mask

        # If batching disabled (per_batch==0) or batch fits, process whole batch
        if per_batch == 0 or B <= per_batch:
            out_image, out_mask = _process_subbatch(image, mask, pad_left, pad_right, pad_top, pad_bottom)
        else:
            chunks = []
            mask_chunks = [] if mask is not None else None
            total_batches = (B + per_batch - 1) // per_batch
            current_batch = 0
            for start_idx in range(0, B, per_batch):
                current_batch += 1
                end_idx = min(start_idx + per_batch, B)
                sub_img = image[start_idx:end_idx]
                sub_mask = mask[start_idx:end_idx] if mask is not None else None
                sub_out_img, sub_out_mask = _process_subbatch(sub_img, sub_mask, pad_left, pad_right, pad_top, pad_bottom)
                chunks.append(sub_out_img.cpu())
                if mask is not None:
                    mask_chunks.append(sub_out_mask.cpu() if sub_out_mask is not None else None)
                # Per-batch progress update
                if unique_id and PromptServer is not None:
                    try:
                        PromptServer.instance.send_progress_text(
                            f"<tr><td>Resize v2</td><td>batch {current_batch}/{total_batches} · images {end_idx}/{B}</td></tr>",
                            unique_id
                        )
                    except Exception:
                        pass
                else:
                    logging.info(f"[XH-图像缩放v2] batch {current_batch}/{total_batches} · images {end_idx}/{B}")
            out_image = torch.cat(chunks, dim=0)
            if mask is not None and any(m is not None for m in mask_chunks):
                out_mask = torch.cat([m for m in mask_chunks if m is not None], dim=0)
            else:
                out_mask = None

        # Cleanup NVIDIA RTX VSR context
        if nvvfx_ctx is not None:
            nvvfx_ctx.__exit__(None, None, None)

        # Progress UI
        if unique_id and PromptServer is not None:
            try:
                num_elements = out_image.numel()
                element_size = out_image.element_size()
                memory_size_mb = (num_elements * element_size) / (1024 * 1024)
                PromptServer.instance.send_progress_text(
                    f"<tr><td>Output: </td><td><b>{out_image.shape[0]}</b> x <b>{out_image.shape[2]}</b> x <b>{out_image.shape[1]} | {memory_size_mb:.2f}MB</b></td></tr>",
                    unique_id
                )
            except Exception:
                pass

        return (out_image.cpu(), out_image.shape[2], out_image.shape[1], out_mask.cpu() if out_mask is not None else torch.zeros(1, 64,64, device=torch.device("cpu"), dtype=torch.float32))


class XHImagePadKJ:
    @classmethod
    def INPUT_TYPES(s):
        return {"required": {
                    "image": ("IMAGE", ),
                    "left": ("INT", {"default": 0, "min": 0, "max": MAX_RESOLUTION, "step": 1, }),
                    "right": ("INT", {"default": 0, "min": 0, "max": MAX_RESOLUTION, "step": 1, }),
                    "top": ("INT", {"default": 0, "min": 0, "max": MAX_RESOLUTION, "step": 1, }),
                    "bottom": ("INT", {"default": 0, "min": 0, "max": MAX_RESOLUTION, "step": 1, }),
                    "extra_padding": ("INT", {"default": 0, "min": 0, "max": MAX_RESOLUTION, "step": 1, }),
                    "pad_mode": (["edge", "edge_pixel", "color", "pillarbox_blur"],),
                    "color": ("STRING", {"default": "0, 0, 0", "tooltip": "【🎨 补边颜色】0-255 的 RGB / 0-1 浮点 / 颜色名 / #RRGGBB。 | English: color"}),
                  },
                "optional": {
                    "mask": ("MASK", ),
                    "target_width": ("INT", {"default": 512, "min": 0, "max": MAX_RESOLUTION, "step": 1, "forceInput": True}),
                    "target_height": ("INT", {"default": 512, "min": 0, "max": MAX_RESOLUTION, "step": 1, "forceInput": True}),
                }
                }
    
    RETURN_TYPES = ("IMAGE", "MASK", )
    RETURN_NAMES = ("images", "masks",)
    FUNCTION = "pad"
    CATEGORY = "🔁XH/Image"
    DESCRIPTION = "Pad the input image and optionally mask with the specified padding."
        
    def pad(self, image, left, right, top, bottom, extra_padding, color, pad_mode, mask=None, target_width=None, target_height=None):
        B, H, W, C = image.shape
        # Resize masks to image dimensions if necessary
        if mask is not None:
            BM, HM, WM = mask.shape
            if HM != H or WM != W:
                mask = F.interpolate(mask.unsqueeze(1), size=(H, W), mode='nearest-exact').squeeze(1)

        # Parse background color using helper function
        color_list = string_to_color(color)
        bg_color = [x / 255.0 for x in color_list]
        if len(bg_color) == 1:
            bg_color = bg_color * 3  # Grayscale to RGB
        bg_color = torch.tensor(bg_color, dtype=image.dtype, device=image.device)

        # Calculate padding sizes with extra padding
        if target_width is not None and target_height is not None:
            if extra_padding > 0:
                image = common_upscale(image.movedim(-1, 1), W - extra_padding, H - extra_padding, "lanczos", "disabled").movedim(1, -1)
                B, H, W, C = image.shape

            padded_width = target_width
            padded_height = target_height
            pad_left = (padded_width - W) // 2
            pad_right = padded_width - W - pad_left
            pad_top = (padded_height - H) // 2
            pad_bottom = padded_height - H - pad_top
        else:
            pad_left = left + extra_padding
            pad_right = right + extra_padding
            pad_top = top + extra_padding
            pad_bottom = bottom + extra_padding

            padded_width = W + pad_left + pad_right
            padded_height = H + pad_top + pad_bottom

        # Pillarbox blur mode
        if pad_mode == "pillarbox_blur":
            def _gaussian_blur_nchw(img_nchw, sigma_px):
                if sigma_px <= 0:
                    return img_nchw
                radius = max(1, int(3.0 * float(sigma_px)))
                k = 2 * radius + 1
                x = torch.arange(-radius, radius + 1, device=img_nchw.device, dtype=img_nchw.dtype)
                k1 = torch.exp(-(x * x) / (2.0 * float(sigma_px) * float(sigma_px)))
                k1 = k1 / k1.sum()
                kx = k1.view(1, 1, 1, k)
                ky = k1.view(1, 1, k, 1)
                c = img_nchw.shape[1]
                kx = kx.repeat(c, 1, 1, 1)
                ky = ky.repeat(c, 1, 1, 1)
                img_nchw = F.conv2d(img_nchw, kx, padding=(0, radius), groups=c)
                img_nchw = F.conv2d(img_nchw, ky, padding=(radius, 0), groups=c)
                return img_nchw

            out_image = torch.zeros((B, padded_height, padded_width, C), dtype=image.dtype, device=image.device)
            for b in range(B):
                scale_fill = max(padded_width / float(W), padded_height / float(H)) if (W > 0 and H > 0) else 1.0
                bg_w = max(1, int(round(W * scale_fill)))
                bg_h = max(1, int(round(H * scale_fill)))
                src_b = image[b].movedim(-1, 0).unsqueeze(0)
                bg = common_upscale(src_b, bg_w, bg_h, "bilinear", crop="disabled")
                y0 = max(0, (bg_h - padded_height) // 2)
                x0 = max(0, (bg_w - padded_width) // 2)
                y1 = min(bg_h, y0 + padded_height)
                x1 = min(bg_w, x0 + padded_width)
                bg = bg[:, :, y0:y1, x0:x1]
                if bg.shape[2] != padded_height or bg.shape[3] != padded_width:
                    pad_h = padded_height - bg.shape[2]
                    pad_w = padded_width - bg.shape[3]
                    pad_top_fix = max(0, pad_h // 2)
                    pad_bottom_fix = max(0, pad_h - pad_top_fix)
                    pad_left_fix = max(0, pad_w // 2)
                    pad_right_fix = max(0, pad_w - pad_left_fix)
                    bg = F.pad(bg, (pad_left_fix, pad_right_fix, pad_top_fix, pad_bottom_fix), mode="replicate")
                sigma = max(1.0, 0.006 * float(min(padded_height, padded_width)))
                bg = _gaussian_blur_nchw(bg, sigma_px=sigma)
                if C >= 3:
                    r, g, bch = bg[:, 0:1], bg[:, 1:2], bg[:, 2:3]
                    luma = 0.2126 * r + 0.7152 * g + 0.0722 * bch
                    gray = torch.cat([luma, luma, luma], dim=1)
                    desat = 0.20
                    rgb = torch.cat([r, g, bch], dim=1)
                    rgb = rgb * (1.0 - desat) + gray * desat
                    bg[:, 0:3, :, :] = rgb
                dim = 0.35
                bg = torch.clamp(bg * dim, 0.0, 1.0)
                out_image[b] = bg.squeeze(0).movedim(0, -1)
            out_image[:, pad_top:pad_top+H, pad_left:pad_left+W, :] = image
            # Mask handling for pillarbox_blur
            if mask is not None:
                fg_mask = mask
                out_masks = torch.ones((B, padded_height, padded_width), dtype=image.dtype, device=image.device)
                out_masks[:, pad_top:pad_top+H, pad_left:pad_left+W] = fg_mask
            else:
                out_masks = torch.ones((B, padded_height, padded_width), dtype=image.dtype, device=image.device)
                out_masks[:, pad_top:pad_top+H, pad_left:pad_left+W] = 0.0
            return (out_image, out_masks)

        # Standard pad logic (edge/color)
        out_image = torch.zeros((B, padded_height, padded_width, C), dtype=image.dtype, device=image.device)
        for b in range(B):
                if pad_mode == "edge":
                    # Pad with edge color (mean)
                    top_edge = image[b, 0, :, :]
                    bottom_edge = image[b, H-1, :, :]
                    left_edge = image[b, :, 0, :]
                    right_edge = image[b, :, W-1, :]
                    out_image[b, :pad_top, :, :] = top_edge.mean(dim=0)
                    out_image[b, pad_top+H:, :, :] = bottom_edge.mean(dim=0)
                    out_image[b, :, :pad_left, :] = left_edge.mean(dim=0)
                    out_image[b, :, pad_left+W:, :] = right_edge.mean(dim=0)
                    out_image[b, pad_top:pad_top+H, pad_left:pad_left+W, :] = image[b]
                elif pad_mode == "edge_pixel":
                    # Pad with exact edge pixel values
                    for y in range(pad_top):
                        out_image[b, y, pad_left:pad_left+W, :] = image[b, 0, :, :]
                    for y in range(pad_top+H, padded_height):
                        out_image[b, y, pad_left:pad_left+W, :] = image[b, H-1, :, :]
                    for x in range(pad_left):
                        out_image[b, pad_top:pad_top+H, x, :] = image[b, :, 0, :]
                    for x in range(pad_left+W, padded_width):
                        out_image[b, pad_top:pad_top+H, x, :] = image[b, :, W-1, :]
                    out_image[b, :pad_top, :pad_left, :] = image[b, 0, 0, :]
                    out_image[b, :pad_top, pad_left+W:, :] = image[b, 0, W-1, :]
                    out_image[b, pad_top+H:, :pad_left, :] = image[b, H-1, 0, :]
                    out_image[b, pad_top+H:, pad_left+W:, :] = image[b, H-1, W-1, :]
                    out_image[b, pad_top:pad_top+H, pad_left:pad_left+W, :] = image[b]
                else:
                    # Pad with specified background color
                    out_image[b, :, :, :] = bg_color.unsqueeze(0).unsqueeze(0)
                    out_image[b, pad_top:pad_top+H, pad_left:pad_left+W, :] = image[b]

        if mask is not None:
            out_masks = torch.nn.functional.pad(
                mask, 
                (pad_left, pad_right, pad_top, pad_bottom),
                mode='replicate'
            )
        else:
            out_masks = torch.ones((B, padded_height, padded_width), dtype=image.dtype, device=image.device)
            for m in range(B):
                out_masks[m, pad_top:pad_top+H, pad_left:pad_left+W] = 0.0

        return (out_image, out_masks)

# ══════════════════════════════════════════════════════════════
# 🧩 XH-参考图拼接板
# 把 1~3 张参考图拼成一张「参考表」，自动适配目标画幅并补边，不变形。
#
# 解决的痛点：
#   LTX 的 LTXAddVideoICLoRAGuide / 各家的多图参考节点只接受**单个 IMAGE**，
#   想喂「女主 + 男主」两张脸就得先拼图；手拼容易出现
#     ① 两张图比例不同 → 被拉伸变形
#     ② 拼完的比例 ≠ 目标视频比例 → 再被压一次
#   本节点把「等比缩放 → 拼接 → 适配目标画幅 → 居中补边」一条龙做掉。
#
# 关键机制（对齐 LTX IC-LoRA 的实际行为）：
#   · LTX 参考图会按 width_scale_factor=32 缩到 latent_w*32，例如 16:9 二采
#     → 参考图最终约 1376×768。**参考表比例 = 目标视频比例**，人脸才不会被压扁。
#   · 人脸的像素量比总分辨率更重要：1376×768 横拼两人，每人约 688 宽，脸约 229px
#     —— 够用（换脸常用 224）。
#   ⇒ 所以宁可「等比缩小 + 补黑边」，也绝不「拉伸铺满」。
# ══════════════════════════════════════════════════════════════

# 目标画幅预设：显示值(含英文原词) → (宽, 高)
_XH_REFERENCESHEET_PRESETS = {
    "① 16:9 横屏 1.0MP (1536×864)": (1536, 864),
    "② 9:16 竖屏 1.0MP (864×1536)": (864, 1536),
    "③ 16:9 横屏 0.4MP (960×544)": (960, 544),
    "④ 9:16 竖屏 0.4MP (544×960)": (544, 960),
    "⑤ 1:1 方形 (1024×1024)": (1024, 1024),
    "⑥ 4:3 横屏 (1152×864)": (1152, 864),
}

# 版式：显示值 → 内部键
_XH_REFERENCESHEET_LAYOUT = (
    "horizontal",       # 横排
    "vertical",         # 竖排
    "grid",             # 网格
)
# 兜底 = horizontal（最常用：16:9 二采拼两人）


class XHRefSheetBuilder:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "image_1": ("IMAGE", {"tooltip": "【🖼️ 第 1 格】左上 / 首图。必填。 | English: image_1"}),
                "preset": (list(_XH_REFERENCESHEET_PRESETS.keys()), {
                    "default": "① 16:9 横屏 1.0MP (1536×864)",
                    "tooltip": (
                        "【📐 目标画幅】= 你二采视频的分辨率。\n"
                        "⚠️ 铁律：**参考表比例必须等于目标视频比例**，否则人脸会被压扁。\n"
                        "· 一采 0.4MP / 二采 1.0MP 各对应一档，选跟当前工作流一致的那档\n"
                        "· 16:9 → 横排；9:16 → 竖排\n"
                        " | English: target canvas preset"
                    )}),
                "inputcount": ("INT", {
                    "default": 2, "min": 1, "max": 3, "step": 1,
                    "tooltip": "【🔢 参考图数量】1~3 张。选 1 = 单图直接适配画幅（不出格线）。改完不需要点按钮，随时生效。 | English: inputcount"}),
                "layout": (list(_XH_REFERENCESHEET_LAYOUT), {
                    "default": "horizontal",
                    "tooltip": (
                        "【🧩 版式】\n"
                        "· horizontal 横排：16:9 画幅用（两人左右并排，各自占满高度，脸最大）★ 推荐\n"
                        "· vertical 竖排：9:16 画幅用（两人上下堆叠）\n"
                        "· grid 网格：3 张图时用（上 2 下 1）\n"
                        " | English: layout"
                    )}),
                "gap": ("INT", {
                    "default": 0, "min": 0, "max": 256, "step": 2,
                    "tooltip": "【📏 格间距】每格之间留多少像素的缝（用补边色填充）。填 0 = 紧贴。想更清晰地分隔两个角色可以填 8~16。 | English: gap"}),
                "crop_fill": ("BOOLEAN", {
                    "default": True,
                    "tooltip": (
                        "【✂️ 裁切填满】★ 建议保持开启\n"
                        "· 开：让每格的人脸**撑满整条高度**（横排时左右超出就裁掉一点边缘）\n"
                        "   人脸在画面里占的像素最多 → 模型认脸最准\n"
                        "· 关：完整保留原图不裁任何像素，但图比例和格子差太多时会留大片空白、脸变小\n"
                        "   头像都已按 1:1 裁好的话，开不开差别不大；开着更保险\n"
                        " | English: crop to fill cell"
                    )}),
                "pad_color": ("STRING", {
                    "default": "0, 0, 0",
                    "tooltip": "【🎨 补边色】画幅没被填满的地方用什么颜色。默认纯黑（0, 0, 0）。也可填 255,255,255 / #1a1a1a / 颜色名。 | English: pad color"}),
                "divisible_by": ("INT", {
                    "default": 32, "min": 0, "max": 512, "step": 1,
                    "tooltip": "【➗ 整除对齐】输出宽高向下取整到它的倍数。喂 H3/LTX 建议 32（模型 VAE 的 stride）。 | English: divisible_by"}),
            },
            "optional": {
                "image_2": ("IMAGE", {"tooltip": "【🖼️ 第 2 格】可选。不接则跳过。 | English: image_2"}),
                "image_3": ("IMAGE", {"tooltip": "【🖼️ 第 3 格】可选（grid 版式的第 3 张）。 | English: image_3"}),
            },
        }

    RETURN_TYPES = ("IMAGE", "INT", "INT")
    RETURN_NAMES = ("ref_sheet", "width", "height")
    FUNCTION = "build"
    CATEGORY = "🔁XH/Image"
    DESCRIPTION = """【🖼️ 参考图拼接板】把 1~3 张人物/场景参考图拼成一张「参考表」，
自动等比缩放、按版式排布、适配目标画幅、居中补黑边 —— **全程不拉伸、不变形**。

给谁用：LTX 的 IC-LoRA 参考引导（LTXAddVideoICLoRAGuide）、以及一切只接受单张 IMAGE
的多图参考节点。想同时锁「女主 + 男主」两张脸，就得先拼成一张再喂。

三条要点：
· 「目标画幅 preset」= 你二采视频的分辨率，**必须一致**，否则脸会被压扁
· 16:9 就横排、9:16 就竖排，这样每张脸拿到的像素最多
· 每格都是等比缩放成方形单元后再拼，所以原始图的宽高比差不影响结果

输出 ref_sheet 直接接参考引导节点的 image 输入即可。"""

    def build(self, image_1, preset, inputcount, layout, gap, crop_fill, pad_color,
              divisible_by, image_2=None, image_3=None):
        # ── 1. 收敛显示值 → 真实宽高 ──
        tw, th = _XH_REFERENCESHEET_PRESETS.get(preset, (1536, 864))
        layout = _xh_norm(layout, _XH_REFERENCESHEET_LAYOUT)

        # ── 2. 收集实际给到的图 ──
        pool = [image_1, image_2, image_3]
        imgs = []
        for i in range(max(1, min(int(inputcount), 3))):
            im = pool[i] if i < len(pool) else None
            if im is not None:
                imgs.append(im)
        if not imgs:
            imgs = [image_1]

        # 多帧批次：只取第一帧当参考图（参考表是静帧）
        cells = []
        for im in imgs:
            t = im[0:1] if im.dim() == 4 else im.unsqueeze(0)
            cells.append(t)
        n = len(cells)
        if layout == "grid" and n < 3:
            layout = "horizontal" if n == 1 else ("horizontal" if tw >= th else "vertical")

        # ── 3. 算出「每格画布」尺寸 ──
        gap = max(0, int(gap))
        if n == 1:
            unit_w, unit_h = tw, th
        elif layout == "horizontal":
            # 横排：高度分满，宽度均分
            unit_h = th
            unit_w = (tw - gap * (n - 1)) // n
        elif layout == "vertical":
            unit_w = tw
            unit_h = (th - gap * (n - 1)) // n
        else:  # grid：3 图 = 上 2 下 1（下 1 居中）
            unit_w = (tw - gap) // 2
            unit_h = (th - gap) // 2

        unit_w = max(8, unit_w)
        unit_h = max(8, unit_h)

        # ── 4. 每格：等比缩放 + 居中贴到单元格（不拉伸）──
        # 🔴 关键：缩放基准 = **cell_fit 指定的那条边**，不是无脑 min()。
        #   min() 会让「比单元格更宽」的图被宽度卡住 → 上下留大白边、人脸变小。
        #   横排时必须以**高度**为准（脸占满整条高度），左右不够才补边；
        #   竖排时以**宽度**为准。这样人脸在画布里占的像素最多。
        _dt = cells[0].dtype
        _bg_cell = (torch.tensor(string_to_color(pad_color)[:3], dtype=_dt) / 255.0)

        def _fit_cell(t, cw, ch, basis, crop_fill):
            src = t.movedim(-1, 1)                       # BHWC → BCHW
            _, _, H, W = src.shape
            if basis == "height":
                scale = ch / float(H)
            elif basis == "width":
                scale = cw / float(W)
            else:
                scale = min(cw / float(W), ch / float(H))
            nw = max(1, int(round(W * scale)))
            nh = max(1, int(round(H * scale)))

            if crop_fill and (nw > cw or nh > ch) and basis in ("height", "width"):
                # 裁切填满：先缩放让「基准边」铺满，再把溢出的那条边对称裁掉。
                # 目的：人脸在画布里占的像素最大化（比留白更有价值）。
                # 横排时溢出的必是宽度 → 裁左右；竖排时溢出的必是高度 → 裁上下。
                scaled = common_upscale(src, nw, nh, "lanczos", crop="disabled")
                ox = max(0, (nw - cw) // 2)
                oy = max(0, (nh - ch) // 2)
                scaled = scaled[:, :, oy:oy + min(nh, ch), ox:ox + min(nw, cw)]
                scaled = scaled.movedim(1, -1)
                cs = scaled.shape[-1]
                if cs >= 3:
                    cell = _bg_cell.view(1, 1, 1, 3).expand(1, ch, cw, 3).clone()
                else:
                    cell = _bg_cell[:1].view(1, 1, 1, 1).expand(1, ch, cw, cs).clone()
                if cs > cell.shape[-1]:
                    cell = torch.cat([cell, scaled.new_zeros(1, ch, cw, cs - cell.shape[-1])], dim=-1)
                hh = min(ch, scaled.shape[1])
                ww = min(cw, scaled.shape[2])
                y0 = (ch - hh) // 2
                x0 = (cw - ww) // 2
                cell[0, y0:y0 + hh, x0:x0 + ww, :cs] = scaled[0, :hh, :ww, :]
                return cell

            # 防溢出：任一方向超出单元格就退回 min 基准（保完整画面，不裁切）
            if nw > cw or nh > ch:
                scale = min(cw / float(W), ch / float(H))
                nw = max(1, int(round(W * scale)))
                nh = max(1, int(round(H * scale)))
            scaled = common_upscale(src, nw, nh, "lanczos", crop="disabled").movedim(1, -1)
            cs = scaled.shape[-1]
            # 单元格底色也用补边色（否则单格留白是黑的，和人脸对不上色调）
            if cs >= 3:
                cell = _bg_cell.view(1, 1, 1, 3).expand(1, ch, cw, 3).clone()
            else:
                cell = _bg_cell[:1].view(1, 1, 1, 1).expand(1, ch, cw, cs).clone()
            if cs > cell.shape[-1]:
                cell = torch.cat([cell, scaled.new_zeros(1, ch, cw, cs - cell.shape[-1])], dim=-1)
            oy = (ch - nh) // 2
            ox = (cw - nw) // 2
            cell[0, oy:oy + nh, ox:ox + nw, :cs] = scaled[0]
            return cell

        # 横排 → 高度基准；竖排 → 宽度基准；单图 / 网格 → min 基准（保完整画面）
        if n == 1:
            _basis = "min"
        elif layout == "horizontal":
            _basis = "height"
        elif layout == "vertical":
            _basis = "width"
        else:
            _basis = "min"

        filled = [_fit_cell(c, unit_w, unit_h, _basis, crop_fill) for c in cells]

        # ── 5. 拼成大板（先算实际用到的画布，再居中贴到目标画布上补边）──
        C = max(f.shape[-1] for f in filled)
        bg_rgb = string_to_color(pad_color)[:3]
        # ⚠️ 必须显式 float32：torch.tensor(list) 默认 float64，直接赋给 float32 切片会
        #    静默不生效（补边色永远是黑的）。这里统一 dtype，跟输出张量对齐。
        _bg = torch.tensor(bg_rgb, dtype=_dt) / 255.0
        _bg4 = _bg.view(1, 1, 1, 3)

        def _new_board(w, h):
            b = torch.zeros((1, h, w, C), dtype=_dt)
            if C >= 3:
                b[:, :, :, :3] = _bg4
            elif C == 1:
                b[:, :, :, :] = _bg[:1].view(1, 1, 1, 1)
            return b

        if n == 1:
            board_w, board_h = unit_w, unit_h
            board = _new_board(board_w, board_h)
            board[0, :unit_h, :unit_w, :] = filled[0][0]

        elif layout == "horizontal":
            board_h = unit_h
            board_w = unit_w * n + gap * (n - 1)
            board = _new_board(board_w, board_h)
            x = 0
            for f in filled:
                board[0, 0:unit_h, x:x + unit_w, :] = f[0]
                x += unit_w + gap

        elif layout == "vertical":
            board_w = unit_w
            board_h = unit_h * n + gap * (n - 1)
            board = _new_board(board_w, board_h)
            y = 0
            for f in filled:
                board[0, y:y + unit_h, 0:unit_w, :] = f[0]
                y += unit_h + gap
        else:  # grid：上排 2 张，下排 1 张居中
            board_w = unit_w * 2 + gap
            board_h = unit_h * 2 + gap
            board = _new_board(board_w, board_h)
            board[0, 0:unit_h, 0:unit_w, :] = filled[0][0]
            if n >= 2:
                board[0, 0:unit_h, unit_w + gap:board_w, :] = filled[1][0]
            if n >= 3:
                cx = (board_w - unit_w) // 2
                board[0, unit_h + gap:board_h, cx:cx + unit_w, :] = filled[2][0]

        # ── 6. 整体等比缩到目标画幅内 + 居中补边（绝不拉伸）──
        bw, bh = board.shape[2], board.shape[1]
        scale = min(tw / float(bw), th / float(bh))
        fw = max(1, int(round(bw * scale)))
        fh = max(1, int(round(bh * scale)))

        # 整除对齐：**只能往下缩到目标画幅内**，绝不能借机放大。
        # 用 min(tw, th) 的整除数做天花板，避免 fw/fh 超出画布导致内容被裁。
        if divisible_by and divisible_by > 1:
            lim_w = (tw // divisible_by) * divisible_by
            lim_h = (th // divisible_by) * divisible_by
            fw = max(divisible_by, (fw // divisible_by) * divisible_by)
            fh = max(divisible_by, (fh // divisible_by) * divisible_by)
            fw = min(fw, lim_w)
            fh = min(fh, lim_h)
            # 同比例缩放：以更受限的一边为准重算，保证不变形
            s2 = min(fw / float(bw), fh / float(bh))
            fw = max(divisible_by, (int(round(bw * s2)) // divisible_by) * divisible_by)
            fh = max(divisible_by, (int(round(bh * s2)) // divisible_by) * divisible_by)
            fw = min(fw, lim_w)
            fh = min(fh, lim_h)

        if (fw, fh) != (bw, bh):
            board = common_upscale(board.movedim(-1, 1), fw, fh, "lanczos",
                                   crop="disabled").movedim(1, -1)

        C_out = board.shape[-1]
        out = torch.zeros((1, th, tw, C_out), dtype=board.dtype)
        if C_out >= 3:
            out[:, :, :, :3] = _bg4.to(board.dtype)
        elif C_out == 1:
            out[:, :, :, :] = _bg[:1].view(1, 1, 1, 1).to(board.dtype)
        oy = (th - fh) // 2
        ox = (tw - fw) // 2
        out[0, oy:oy + fh, ox:ox + fw, :] = board[0]

        return (out.cpu(), int(tw), int(th))


# ══════════════════════════════════════════════════════════════
# 注册
# ══════════════════════════════════════════════════════════════
NODE_CLASS_MAPPINGS = {
    "XHImageResizeV2": XHImageResizeV2,
    "XHImageBatchMulti": XHImageBatchMulti,
    "XHRefSheetBuilder": XHRefSheetBuilder,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "XHImageResizeV2": "🖼️XH-图像缩放v2",
    "XHImageBatchMulti": "🖼️XH-图像批量合并",
    "XHRefSheetBuilder": "🧩XH-参考图拼接板",
}
