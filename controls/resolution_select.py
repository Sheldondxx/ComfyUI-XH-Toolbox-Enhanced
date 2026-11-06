# 📐XH-分辨率选择器（XH 家族）
#
# 算法**逐行照抄**官方 `comfy_extras/nodes_resolution.py` 的 `ResolutionSelector`
# （2026-10-09 读本地源码核对，不是照截图猜）：
#     total = 百万像素 × 1024 × 1024
#     scale = √(total ÷ (宽比 × 高比))
#     width  = round(宽比 × scale ÷ 倍数) × 倍数
#     height = round(高比 × scale ÷ 倍数) × 倍数
#
# 参数名 / 参数顺序 / 下拉**存档值** / 输出名，全部与官方一致
#   ⇒ 老工作流里把官方「分辨率选择器」直接替换成本节点，连线一根都不用动。
#
# 比官方多做的事（都不改接口）：
#   · 中文显示名 + 控件 / 端口的中英切换（家族 i18n，见 web/xh_resolution.js）；
#   · 节点上**实时显示最终生效的宽高**（家族前端预览条，照官方那个 `1024 × 1024 · 1.00 MP` 的样式）；
#     前端与后端用的是同一套公式（含 Python 的「四舍六入五成双」取整），所以节点上看到的
#     就是真跑出来的值，不是估算；
#   · 宽高比字符串认不出来时**回退 1:1 并提示**（官方是 KeyError 直接红框）；
#   · 百万像素填到极小 / 倍数填错时**保底不小于一个倍数**（官方会算出 0，喂给 EmptyLatent 直接崩）。
#
# 🔴 家族规范：class_type 与 web/xh_resolution.js 里的 NODE_TYPE 必须逐字一致。
# 🔴 FLOAT / INT 必须显式写 min / max（不写就是 ComfyUI 默认的 0~2048，百万像素想填 16.0 会填不进）。
# 🔴 下拉的 values 必须是官方那 8 个英文串 —— 那是存档值，中文只在前端显示层换（getOptionLabel）。

import math

# 与官方 `nodes_resolution.py` 的 ASPECT_RATIOS 逐条对齐（键 = 存档值，值 = (宽比, 高比)）
ASPECT_RATIOS = {
    "1:1 (Square)": (1, 1),
    "2:3 (Portrait Photo)": (2, 3),
    "3:2 (Photo)": (3, 2),
    "3:4 (Portrait Standard)": (3, 4),
    "4:3 (Standard)": (4, 3),
    "9:16 (Portrait Widescreen)": (9, 16),
    "16:9 (Widescreen)": (16, 9),
    "21:9 (Ultrawide)": (21, 9),
}

_DEFAULT_RATIO = "1:1 (Square)"


class XHResolutionSelect:
    """按「宽高比 × 百万像素」算出宽高，并按倍数对齐 —— 官方 ResolutionSelector 的 XH 版。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "aspect_ratio": (list(ASPECT_RATIOS.keys()), {
                    "default": _DEFAULT_RATIO,
                    "tooltip": (
                        "画面宽高比（存的是官方那 8 个英文值，界面上按语言显示中文）。\n"
                        "· 1:1 方形  · 2:3 / 3:4 竖版  · 3:2 / 4:3 横版\n"
                        "· 9:16 竖屏（短视频）  · 16:9 横屏  · 21:9 超宽屏"
                    ),
                }),
                "megapixels": ("FLOAT", {
                    "default": 1.0, "min": 0.1, "max": 16.0, "step": 0.1,
                    "tooltip": (
                        "目标总像素（百万像素，MP）。1.0 MP ≈ 方形 1024×1024。\n"
                        "⚠️ 它管的是**总面积**，宽高由上面的比例分配 —— 同一个 1.0 MP，"
                        "9:16 会比 1:1 矮很多、21:9 会扁很多。\n"
                        "⚠️ 算完还会按「倍数」取整，所以实际 MP 与这里可能有零点零几的出入。"
                    ),
                }),
                "multiple": ("INT", {
                    "default": 8, "min": 8, "max": 128, "step": 4,
                    "advanced": True,
                    "tooltip": (
                        "把结果对齐到这个数的整数倍（默认 8）。\n"
                        "VAE / 大多数模型要求宽高是 8 的倍数，动它之前先想清楚：\n"
                        "· 64 / 128 会让尺寸跳档很猛，适合对齐 latent 块；\n"
                        "· 官方默认就是 8，一般不用改。"
                    ),
                }),
            },
        }

    RETURN_TYPES = ("INT", "INT")
    RETURN_NAMES = ("width", "height")
    FUNCTION = "get_resolution"
    CATEGORY = "🔁XH/工具"
    DESCRIPTION = (
        "【干什么】按「宽高比 × 百万像素」算出宽和高，并按倍数对齐 —— 官方「分辨率选择器」的 XH 版，"
        "参数与输出跟官方逐字一致，可直接替换。\n"
        "【怎么配】· aspect_ratio 宽高比（官方 8 档：1:1 / 2:3 / 3:2 / 3:4 / 4:3 / 9:16 / 16:9 / 21:9）\n"
        "· megapixels 目标总像素（MP，0.1~16.0；1.0 MP ≈ 方形 1024×1024）\n"
        "· multiple 对齐倍数（默认 8，一般不用动）\n"
        "【怎么用】接 Empty Latent Image / EmptyImage 的 width、height，"
        "比手填数字更省心：换比例时总像素不变，不会一会儿清楚一会儿糊。\n"
        "【输出】width 宽 / height 高（都是 INT，已按倍数对齐）。\n"
        "⚠️ 它算的是「面积对、比例对」的尺寸，不是精确的 832×1216 这类常用档 —— "
        "要精确档位请自己填数字（本节点不预设档位表，就是为了避免一堆用不上的花架子）。"
    )

    def get_resolution(self, aspect_ratio, megapixels, multiple):
        pair = ASPECT_RATIOS.get(aspect_ratio)
        if pair is None:
            print(f"[XH-分辨率选择器] 不认识的宽高比 {aspect_ratio!r}，已按 {_DEFAULT_RATIO} 处理，不中断流程")
            pair = ASPECT_RATIOS[_DEFAULT_RATIO]

        w_ratio, h_ratio = pair

        try:
            mp = float(megapixels)
        except (TypeError, ValueError):
            mp = 1.0
        if mp < 0.01:                       # 官方不设保底，填小了会算出 0 宽 0 高
            mp = 0.01

        try:
            mult = int(multiple)
        except (TypeError, ValueError):
            mult = 8
        if mult < 1:
            mult = 1

        total_pixels = mp * 1024 * 1024
        scale = math.sqrt(total_pixels / (w_ratio * h_ratio))
        width = int(round(w_ratio * scale / mult) * mult)
        height = int(round(h_ratio * scale / mult) * mult)

        # 保底：至少留一个倍数，免得下游 Empty Latent 收到 0 直接崩
        width = max(mult, width)
        height = max(mult, height)

        return (width, height)


NODE_CLASS_MAPPINGS = {"XHResolutionSelect": XHResolutionSelect}
NODE_DISPLAY_NAME_MAPPINGS = {"XHResolutionSelect": "📐XH-分辨率选择器"}
