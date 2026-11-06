# -*- coding: utf-8 -*-
"""soundboard —— 🔊XH-声音播放（跑完响一声）。

音效库在 `../web/sounds/<分类>/`：
    ui      提示音（叮 / 咚 / 完成 / 失败 …）
    sfx     音效（嗖 / 啪 / 哐 / 金币 …）
    music   音乐（辉煌 / 悬疑 / 轻松 …）
    voice   人声（留给你自己的配音）

加自己的音效：往对应分类目录丢 wav / mp3 → 在 ComfyUI 里按 F5（前端刷新）。
前端 js 在**顶层** `web/xh_sound.js`（本子模块的 WEB_DIRECTORY 是死变量，别往这儿放）。
"""
from .nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS

WEB_DIRECTORY = "web"

__all__ = [
    "NODE_CLASS_MAPPINGS",
    "NODE_DISPLAY_NAME_MAPPINGS",
    "WEB_DIRECTORY",
]
