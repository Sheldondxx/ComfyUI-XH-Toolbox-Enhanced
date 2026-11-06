"""XH-SeamFeather: 把一段视频的前 N 帧，按递减权重拉向一张静态参考帧。

典型用途：多段长视频衔接时，把上一段的末帧拿来做参考，
让本段开头几帧的色调平滑过渡过去，消除接缝处的色差/泛白。
"""

import torch
import torch.nn.functional as F

CATEGORY_TYPE = "\U0001F501XH/Video"


def _box_blur(img: torch.Tensor, radius: int) -> torch.Tensor:
    """[B,H,W,C] -> 三次盒式模糊（中心极限近似高斯），边缘用 replicate 填充。"""
    r = max(int(radius), 1)
    x = img.movedim(-1, 1)                      # [B,C,H,W]
    k = 2 * r + 1
    for _ in range(3):
        x = F.pad(x, (r, r, r, r), mode="replicate")
        x = F.avg_pool2d(x, kernel_size=k, stride=1, padding=0)
    return x.movedim(1, -1)                     # [B,H,W,C]


def _resize_to(t: torch.Tensor, ref: torch.Tensor) -> torch.Tensor:
    """把 t 缩放到 ref 的 H/W（t、ref 均为 [B,H,W,C]）。"""
    if t.shape[1:3] == ref.shape[1:3]:
        return t
    x = t.movedim(-1, 1)
    x = F.interpolate(
        x, size=(ref.shape[1], ref.shape[2]), mode="bicubic", align_corners=False
    )
    return x.movedim(1, -1).to(ref.dtype)


def _rgb_to_yuv(rgb: torch.Tensor):
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    y = 0.299 * r + 0.587 * g + 0.114 * b
    return y, b - y, r - y          # Y, U(B-Y), V(R-Y)


def _yuv_to_rgb(y, u, v) -> torch.Tensor:
    r = y + v
    b = y + u
    g = (y - 0.299 * r - 0.114 * b) / 0.587
    return torch.stack((r, g, b), dim=-1)


def _falloff(kind: str, t: torch.Tensor) -> torch.Tensor:
    """t 已归一化到 0..1（第 0 帧为 1，最后一帧趋近 0），返回衰减系数。"""
    if kind == "ease_out":
        return t * t
    if kind == "ease_in_out":
        return t * t * (3.0 - 2.0 * t)
    return t                        # linear


class XHSeamFeather:
    """衔接淡化：拿一张静态参考帧，把本段开头若干帧平滑拉过去。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE", {"tooltip": "本段视频（完整帧序列），输出尺寸以它为准"}),
                "reference": ("IMAGE", {"tooltip": "参考帧，通常是上一段的末帧；多于 1 帧时按 ref_pick 取"}),
                "frames": ("INT", {
                    "default": 3, "min": 1, "max": 120, "step": 1,
                    "tooltip": "参与淡化的帧数，3 帧约 0.12 秒（24fps）",
                }),
                "strength": ("FLOAT", {
                    "default": 0.70, "min": 0.0, "max": 1.0, "step": 0.01,
                    "tooltip": "第 1 帧拉向参考帧的强度，后续帧按 falloff 递减到 0",
                }),
                "falloff": (["linear", "ease_out", "ease_in_out"], {
                    "default": "linear",
                    "tooltip": "衰减曲线：ease_out 过渡更短更急，ease_in_out 更柔和",
                }),
                "mode": (["full", "chroma_only", "low_freq"], {
                    "default": "full",
                    "tooltip": "full=整帧混合；chroma_only=只拉颜色不动亮度（防泛白）；low_freq=只补低频色调（防重影）",
                }),
                "ref_pick": (["last", "first"], {
                    "default": "last",
                    "tooltip": "参考图有多帧时取哪一帧",
                }),
                "blur_radius": ("INT", {
                    "default": 24, "min": 1, "max": 128, "step": 1,
                    "tooltip": "仅 low_freq 模式生效：模糊半径，越大越只吃色调块",
                }),
            }
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("images",)
    FUNCTION = "feather"
    CATEGORY = CATEGORY_TYPE
    DESCRIPTION = (
        "【干什么】拿一张静态参考帧（通常是上一段的末帧），把本段开头若干帧平滑地拉过去，"
        "消掉两段之间的「跳一下」。\n"
        "【怎么配】· images：本段视频（输出尺寸以它为准）\n"
        "· reference：参考帧；有多帧时按 ref_pick 挑一张\n"
        "· frames：参与淡化的帧数（默认 3，约 0.12 秒 @24fps）\n"
        "· strength：第 1 帧拉向参考帧的强度，后续按 falloff 递减到 0\n"
        "· falloff：衰减曲线（linear / ease_out / ease_in_out）\n"
        "· mode：full 整帧混合 / chroma_only 只拉颜色防泛白 / low_freq 只补低频防重影\n"
        "· blur_radius：只在 low_freq 模式生效，越大越只吃色调块\n"
        "【怎么用】放在「上一段末帧 → 本段」之间；只对**开头 frames 帧**动手，之后原样输出。\n"
        "【输出】images（IMAGE）。\n"
        "⚠️ 泛白就换 chroma_only，重影就换 low_freq；两个一起来先 low_freq 再 chroma_only。"
    )

    def feather(self, images, reference, frames, strength, falloff, mode, ref_pick, blur_radius):
        if images is None or reference is None:
            return (images,)

        out = images.clone()
        n = max(int(frames), 1)
        n = min(n, out.shape[0])
        if n <= 0 or float(strength) == 0.0:
            return (out,)

        ref = reference[0] if ref_pick == "first" else reference[-1]
        ref = ref.unsqueeze(0)                                   # [1,H,W,C]
        ref = _resize_to(ref, out)                               # 尺寸跟随 images
        ref = ref.to(device=out.device, dtype=out.dtype)

        head = out[:n]
        ref_b = ref.expand(n, -1, -1, -1)

        # 归一化进度：第 0 帧 = 1，第 n-1 帧 = 1/n（第 n 帧起权重为 0，自然接上）
        idx = torch.arange(n, device=out.device, dtype=out.dtype)
        t = 1.0 - idx / float(n)
        w = float(strength) * _falloff(falloff, t)
        w = w.view(n, 1, 1, 1)

        if mode == "chroma_only":
            # Y/U/V 是 [n,H,W]，权重要降一维
            w3 = w[..., 0]
            y, u, v = _rgb_to_yuv(head)
            yr, ur, vr = _rgb_to_yuv(ref_b)
            mixed = _yuv_to_rgb(y, u * (1 - w3) + ur * w3, v * (1 - w3) + vr * w3)
        elif mode == "low_freq":
            diff = _box_blur(ref_b, blur_radius) - _box_blur(head, blur_radius)
            mixed = head + w * diff
        else:
            mixed = head * (1 - w) + ref_b * w

        out = torch.cat((mixed.clamp(0, 1), out[n:]), dim=0)
        return (out,)


NODE_CLASS_MAPPINGS = {
    "XHSeamFeather": XHSeamFeather,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "XHSeamFeather": "\U0001F501XH-衔接淡化",
}
