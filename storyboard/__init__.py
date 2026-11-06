"""🖼️XH-宫格故事板 · 包入口（2026-10-09 新增，3 个节点）

XH 家族复刻社区包 `ComfyUI-Storyboard-Tools`（作者原包，核心算法一致）：
  · 🖼️XH-宫格底板      (XHStoryboardGrid)        ← StoryboardGridGenerator
  · 🖼️XH-图像对比度    (XHImageContrast)         ← ImageContrastAdjuster
  · 🖼️XH-宫格切图      (XHStoryboardPanelCrop)   ← StoryboardPanelCrop

用途：Krea2 / SD 的「宫格故事板」流程 ——
  底板（白框灰格）→ 局部重绘往每格画镜头 → 对比度微调 → 切图成 batch。

⚠️ class_type **刻意用新的 XH 名字**，不沿用原包的 `StoryboardGridGenerator` 等：
  原包可以照常装着，两套并存、互不干扰；老工作流继续用原包，新工作流用 XH 版。

XH 增值（都不改默认行为，见 py/storyboard_tools.py 顶部说明）：
  底板 → 手动列×行 / 格数上限 24 / 多出 cell_mask(蒙版) 与 info(文本)
  对比度 → 多 brightness；原版写死的 0.25 折扣开放成 strength
  切图 → 多 order(行/列优先)；多输出 panel_count
"""

from .py.storyboard_tools import (
    NODE_CLASS_MAPPINGS as _SB_CLASS_MAPPINGS,
    NODE_DISPLAY_NAME_MAPPINGS as _SB_DISPLAY_NAME_MAPPINGS,
)

NODE_CLASS_MAPPINGS = {**_SB_CLASS_MAPPINGS}
NODE_DISPLAY_NAME_MAPPINGS = {**_SB_DISPLAY_NAME_MAPPINGS}

# 死变量：ComfyUI 只认顶层自定义节点目录的 WEB_DIRECTORY 声明，子目录里的不会被读取。
# 本模块的双语标签挂在家族 js（web/xh_image_tools_lang.js）上，顶层那句 WEB_DIRECTORY = "web" 已覆盖。
WEB_DIRECTORY = "web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
