"""🔁XH-LTX锁脸 · 包入口

本包是 bfsnodes「LTXIdentityOverlapConditioning（显示名 LTX Identity Transfer）」的 XH 复刻版：
  · 算法与原版逐字节一致（未改动任何计算逻辑）
  · 界面双语化：下拉选项「中文 (english)」、tooltip 中文优先、参数标签中/EN 一键切换
  · 分类 / 显示名改 XH 风格：🔁XH/Identity · 🔒XH-LTX锁脸

原包 bfsnodes 保持原样不动，两套可同时安装、互不干扰（class_type 键不同）。
"""

from .py.ltx_identity_overlap import (
    NODE_CLASS_MAPPINGS as _ID_CLASS_MAPPINGS,
    NODE_DISPLAY_NAME_MAPPINGS as _ID_DISPLAY_NAME_MAPPINGS,
)

NODE_CLASS_MAPPINGS = {
    **_ID_CLASS_MAPPINGS,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    **_ID_DISPLAY_NAME_MAPPINGS,
}

# 让 ComfyUI 加载 web/ 下的前端扩展（中/EN 语言切换按钮 + 参数标签本地化）
WEB_DIRECTORY = "web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
