"""🔁XH-MSR 精修编码 —— 按「秒」给视频的不同时间段贴不同提示词

文件分工：

    engine.py  ← 引擎层：文本→token 区间、段长换算、时间惩罚矩阵、
                  往注意力层挂钩子（LTX 的 attn2/audio_attn2、Wan 的 cross_attn）
    nodes.py   ← 节点层：XHMSRRelayEncode  🔁XH-MSR精修编码  1 节点

用途：H3 出的低分辨率视频 → 交给 LTX 2.5 二采精修时，
      保证每一段视频只认自己那一段的提示词，切镜点上不会串味
      （典型案例：切镜晚了 → 女孩提前「长出胡子」）。

与上游 ComfyUI-PromptRelay 的关系：
    · 算法同源（同一篇 Prompt Relay 论文），但**实现完全自持** ——
      engine.py 不 import 上游任何东西，只依赖 comfy 官方模块 + torch + 标准库。
    · 因此本节点可独立分发、零第三方依赖；与上游节点并存或单独使用都可以。
    · 比上游多做的三件事：秒→帧自动换算、「硬度」五件套内置、
      段长结果用 info 输出白纸黑字打出来（段数配错也直接报错，不静默）。

⚠ 前端 js 用 nodeData.name !== NODE_TYPE 判断节点类型，
  所以 py 的 class_type 与 web/xh_msr_relay.js 里的 NODE_TYPE 必须逐字一致。
"""

from .nodes import (
    NODE_CLASS_MAPPINGS as _M_MSR,
    NODE_DISPLAY_NAME_MAPPINGS as _D_MSR,
)

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

NODE_CLASS_MAPPINGS.update(_M_MSR)
NODE_DISPLAY_NAME_MAPPINGS.update(_D_MSR)

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
