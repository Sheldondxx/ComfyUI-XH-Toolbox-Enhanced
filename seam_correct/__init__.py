# -*- coding: utf-8 -*-
"""seam_correct —— 🩹XH-接缝修正

算法本体照搬 ComfyUI_MinimaxH3_AutoContext（Apache-2.0，见 `py/h3_seam_impl.py` 头部版权）。
本模块只做 XH 风格的 v1 注册。
"""

from .py.core import XHSeamCorrect

NODE_CLASS_MAPPINGS = {
    "XHSeamCorrect": XHSeamCorrect,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "XHSeamCorrect": "🩹XH-接缝修正",
}
