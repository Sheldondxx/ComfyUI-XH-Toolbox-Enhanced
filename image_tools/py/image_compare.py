"""
🖼️ XH-图像对比拼图（XHImageCompare）  —— 2026-10-15 新增

── 为什么做这个节点 ────────────────────────────────────────
MINIMAX CHARACTER SWAP 工作流原来用第三方包 ComfyUI-RMBG 的 `AILab_ImageCompare`
把「参考图 vs 生成结果」拼成一张对比图，再送进 CreateVideo 成对比视频。
该包本机 import 失败，用户要求做 XH 自己的替代品。

── 做什么 ─────────────────────────────────────────────────
把最多 3 张图**横向并排**拼成一张，每张图上方带一条标题栏（写文字标签）。
  · 各图按「基准图」的高度等比缩放 → 横向排列 → 高度对齐 → 拼成一张 IMAGE
  · 端口对齐 AILab_ImageCompare：text1/2/3 + size_base + text_color + bg_color，
    输入 image1/2/3（可选）；可零改线顶替。
  · 纯 PIL + torch，零新增依赖。

── 与 AILab_ImageCompare 的差别 ────────────────────────────
  · 颜色用 STRING 十六进制（AILab 用第三方 COLORCODE 类型，本节点不引入该依赖）
  · 多一个 `font_size`（标题字号）参数
  · 取每张图的**第 1 帧**参与拼接（批次图取首帧，符合"对比代表性画面"的习惯）
"""

import math

import numpy as np
import torch
from PIL import Image, ImageDraw, ImageFont

_CJK_FONTS = (
    "C:/Windows/Fonts/msyh.ttc",      # 微软雅黑
    "C:/Windows/Fonts/msyhbd.ttc",
    "C:/Windows/Fonts/simhei.ttf",    # 黑体
    "C:/Windows/Fonts/simsun.ttc",    # 宋体
    "C:/Windows/Fonts/arial.ttf",
)


def _load_font(size):
    """按字号加载字体：优先中文可用字体，全失败退回 PIL 内置位图字体。"""
    for path in _CJK_FONTS:
        try:
            return ImageFont.truetype(path, size)
        except Exception:
            continue
    try:
        return ImageFont.load_default(size)
    except Exception:
        return ImageFont.load_default()


def _parse_color(text, default=(0, 0, 0)):
    """把 "#RRGGBB" / "#RRGGBBAA" / "RRGGBB" 解析成 RGB 元组；解析失败用默认色。"""
    if not isinstance(text, str):
        return default
    s = text.strip().lstrip("#")
    if len(s) == 8:                      # 带 alpha，这里只取 RGB 部分
        s = s[:6]
    if len(s) != 6:
        return default
    try:
        return (int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16))
    except ValueError:
        return default


def _tensor_to_pil(t):
    """ComfyUI IMAGE 单帧 (H,W,C) float 0~1 → PIL.Image（RGB）。"""
    arr = (t.detach().cpu().numpy() * 255.0).round().clip(0, 255).astype(np.uint8)
    if arr.ndim == 2:
        arr = np.stack([arr] * 3, axis=-1)
    if arr.shape[2] == 1:
        arr = np.repeat(arr, 3, axis=2)
    if arr.shape[2] == 4:
        arr = arr[:, :, :3]
    return Image.fromarray(arr, mode="RGB")


def _pil_to_tensor(img):
    """PIL.Image（RGB）→ ComfyUI IMAGE 单帧 (1,H,W,3) float 0~1。"""
    arr = np.asarray(img.convert("RGB"), dtype=np.float32) / 255.0
    return torch.from_numpy(arr)[None, ...]


class XHImageCompare:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "text1": ("STRING", {"default": "图1", "multiline": False,
                                     "tooltip": "【🏷️ 标题1】第 1 张图上方的文字。 | English: title 1"}),
                "text2": ("STRING", {"default": "图2", "multiline": False,
                                     "tooltip": "【🏷️ 标题2】第 2 张图上方的文字。"}),
                "text3": ("STRING", {"default": "图3", "multiline": False,
                                     "tooltip": "【🏷️ 标题3】第 3 张图上方的文字。"}),
                "size_base": (["largest", "smallest", "image1", "image2", "image3"], {
                    "default": "largest",
                    "tooltip": "【📐 基准图】以哪张图的高度为基准，其余图按比例对齐：\n"
                               "· largest=最大  · smallest=最小  · image1/2/3=指定某张",
                }),
                "text_color": ("STRING", {"default": "#000000",
                                          "tooltip": "【🔤 文字颜色】十六进制，如 #000000。"}),
                "bg_color": ("STRING", {"default": "#FFFFFF",
                                        "tooltip": "【🎨 背景色】标题栏/留白填充色，十六进制，如 #FFFFFF。"}),
                "font_size": ("INT", {"default": 28, "min": 8, "max": 200, "step": 1,
                                      "tooltip": "【🔠 字号】标题文字大小。"}),
            },
            "optional": {
                "image1": ("IMAGE", {"tooltip": "【🖼️ 图1】第 1 张（可空）。"}),
                "image2": ("IMAGE", {"tooltip": "【🖼️ 图2】第 2 张（可空）。"}),
                "image3": ("IMAGE", {"tooltip": "【🖼️ 图3】第 3 张（可空）。"}),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("IMAGE",)
    FUNCTION = "run"
    CATEGORY = "🔁XH/Image"
    DESCRIPTION = (
        "【🖼️ 图像对比拼图】把最多 3 张图横向并排拼成一张，每张上方带标题栏。\n"
        "常用于「原图 vs 生成结果」对比；输出一张 IMAGE，可接保存/成视频。"
    )

    def run(self, text1, text2, text3, size_base, text_color, bg_color, font_size,
            image1=None, image2=None, image3=None):
        color_text = _parse_color(text_color, (0, 0, 0))
        color_bg = _parse_color(bg_color, (255, 255, 255))

        # 收集实际接入的图（取每批的第 1 帧）
        panels = []
        for label, img, txt in (
            ("image1", image1, text1),
            ("image2", image2, text2),
            ("image3", image3, text3),
        ):
            if img is None:
                continue
            panels.append([label, _tensor_to_pil(img[0]), txt or ""])

        if not panels:
            raise ValueError(
                "[XH-图像对比拼图] 至少接入一张图片（image1 / image2 / image3 任选）。"
            )

        # 选基准图 → 目标高度
        if size_base == "smallest":
            base = min(panels, key=lambda p: p[1].width * p[1].height)[1]
        elif size_base in ("image1", "image2", "image3"):
            match = next((p for p in panels if p[0] == size_base), None)
            base = match[1] if match else max(panels, key=lambda p: p[1].width * p[1].height)[1]
        else:  # largest
            base = max(panels, key=lambda p: p[1].width * p[1].height)[1]
        target_h = max(1, base.height)

        # 标题栏高度：有字才留
        title_h = int(font_size * 1.8) if any(p[2].strip() for p in panels) else 0
        font = _load_font(font_size)

        # 逐张：等比缩放到目标高度 → 上方贴标题栏
        canvases = []
        for _, pil, txt in panels:
            w = max(1, int(round(pil.width * target_h / pil.height)))
            im = pil.resize((w, target_h), Image.LANCZOS)

            canvas = Image.new("RGB", (w, title_h + target_h), color_bg)
            if title_h > 0:
                draw = ImageDraw.Draw(canvas)
                bbox = draw.textbbox((0, 0), txt, font=font)
                tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
                draw.text(((w - tw) / 2 - bbox[0], (title_h - th) / 2 - bbox[1]),
                          txt, font=font, fill=color_text)
            canvas.paste(im, (0, title_h))
            canvases.append(canvas)

        # 横向拼接
        total_w = sum(c.width for c in canvases)
        total_h = max(c.height for c in canvases)
        out = Image.new("RGB", (total_w, total_h), color_bg)
        x = 0
        for c in canvases:
            out.paste(c, (x, 0))
            x += c.width

        return (_pil_to_tensor(out),)


NODE_CLASS_MAPPINGS = {"XHImageCompare": XHImageCompare}
NODE_DISPLAY_NAME_MAPPINGS = {"XHImageCompare": "🖼️XH-图像对比拼图"}
