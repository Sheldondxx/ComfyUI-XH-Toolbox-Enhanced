"""🔧 XH 控件三件套（纯前端 UI 节点）

来源：`XH_GroupController` / `XH_Label` / `XH_Timer`
（2026-09-22 由 `XiaoHei_*` 改名，同日并入 `Comfyui-XH_Toolbox`）。

三个都是**纯前端**节点：py 侧只注册一个空壳类，真正的界面（DOM widget）
全部由顶层 `web/` 下对应的 js 画出来：

    group_controller.py  ← XH_GroupController   XHGroupController   1 节点
    label.py             ← XH_Label             XHLabel             1 节点
    timer.py             ← XH_Timer             XHTimer             1 节点
    number_counter.py    ← XHNumberCounter      XHNumberCounter     1 节点（真后端）
    for_loop.py          ← XHForLoopStart/End   🔁XH-循环开始/结束   2 节点 + 3 个内部节点
                                                                     （走官方循环引擎）
    math_int.py          ← XHMathInt            🔁XH-整数运算        1 节点（真后端）
    math_float.py        ← XHMathFloat          🔁XH-浮点运算        1 节点（真后端，接口对齐
                                                                     easy mathFloat；唯一差异＝
                                                                     不做 3 位取整，保精度）
    tone_compensate.py   ← XHToneCompensate     🔁XH-色调补偿        1 节点（真后端，修接缝色调）
    segment_table.py     ← XHSegmentTable       🔁XH-分段表          1 节点（真后端，按索引取起始秒/时长；
                                                                     批量粘贴 ⇄ 逐段填写一键互切）
    resolution_select.py ← XHResolutionSelect   📐XH-分辨率选择器    1 节点（真后端，算法照抄官方
                                                                     comfy_extras/nodes_resolution.py 的
                                                                     ResolutionSelector；参数/输出与官方
                                                                     逐字一致，可直接替换）
    show_text.py         ← XHShowText           📺XH-显示文本        1 节点（真后端，机制照抄官方
                                                                     pysssss ShowText：执行时把文本
                                                                     回写存档 + ui 发前端显示）
    beat_cue.py          ← XHBeatCueTable       🎵XH-音乐卡点表      1 节点（真后端，2026-10-14 新增：
                                                                     给音乐算出「每一刀切在第几秒」的
                                                                     卡拍表。**纯 numpy 零第三方依赖**，
                                                                     不依赖 librosa；混合帧数编排让
                                                                     8k+1 帧格与音乐小节线长期对齐）
    audio_load.py        ← XHLoadAudio          🎵XH-加载音频        1 节点（真后端，2026-10-16 新增：
                                                                     复刻官方 Load Audio，输出逐字
                                                                     一致可互换；正主是前端播放器——
                                                                     粗时间线（10px 轨道+16px 拖把手）
                                                                     拖拽 seek，治官方进度条太细的毛病）
    boolean.py           ← XHBooleanToggle      🔘XH-布尔开关       2 节点（真后端，复刻官方
                                                / XHBooleanSwitch   🔀XH-切换
                                                PrimitiveBoolean 与 ComfySwitchNode；
                                                靠官方 Boolean.Input 的 label_on/label_off
                                                把机翻的「为真实/为假实」改成「开/关」；
                                                界面＝一行左右滑动的滑块，开绿关红）
    seed.py              ← XHSeed               🎲XH-种子            1 节点（真后端，复刻 rgthree Seed：
                                                                     -1=每次随机/-2=上次+1/-3=上次-1，
                                                                     前端排队瞬间换真种子并写回元数据）
    xh_h3_latent_continuation.py ← XHH3LatentContinuation 🔁XH-H3 latent接续
                                                                     1 节点（真后端，2026-10-23：
                                                                     接缝 latent 锚定；初版曾 import 导演台
                                                                     两个纯函数，当天改为 XH 自研净室实现，
                                                                     只用 ComfyUI 官方 API，零三方依赖）
    xh_h3_tst.py         ← XHH3TemporalCorrection 🔁XH-H3 动作校正   1 节点（真后端，2026-10-23：
                                                                     TST 推理时注意力校正；
                                                                     算法 arXiv:2609.08505·MIT，
                                                                     H3 适配 XH 自研，零三方依赖）

改动范围（并入时）：
  · class_type 与原包**完全一致** → 已存工作流零影响
  · CATEGORY 由 `XH工具` 统一为 `🔁XH/工具`（跟 Toolbox 其他节点在同一菜单目录下）
  · 显示名由 `XH 分组控制` 统一为 `🔁XH-分组控制` 等格式
  · 原 `WEB_DIRECTORY = "./web/js"` 已删除 —— js 全部汇到顶层 `web/`，
    全包只保留顶层那一处 `WEB_DIRECTORY` 声明

⚠ 前端 js 用 `nodeData.name !== NODE_TYPE` 判断节点类型，
  所以 **py 的 class_type 与 js 里的 NODE_TYPE 必须逐字一致**，
  动任意一边都要同步改另一边，否则节点会渲染成空白壳。
"""

import sys

from .group_controller import (
    NODE_CLASS_MAPPINGS as _M_GRP,
    NODE_DISPLAY_NAME_MAPPINGS as _D_GRP,
)
from .label import (
    NODE_CLASS_MAPPINGS as _M_LBL,
    NODE_DISPLAY_NAME_MAPPINGS as _D_LBL,
)
from .timer import (
    NODE_CLASS_MAPPINGS as _M_TMR,
    NODE_DISPLAY_NAME_MAPPINGS as _D_TMR,
)
from .number_counter import (
    NODE_CLASS_MAPPINGS as _M_CNT,
    NODE_DISPLAY_NAME_MAPPINGS as _D_CNT,
)
from .for_loop import (
    NODE_CLASS_MAPPINGS as _M_LOOP,
    NODE_DISPLAY_NAME_MAPPINGS as _D_LOOP,
)
from .math_int import (
    NODE_CLASS_MAPPINGS as _M_MATH,
    NODE_DISPLAY_NAME_MAPPINGS as _D_MATH,
)
from .math_float import (
    NODE_CLASS_MAPPINGS as _M_MATHF,
    NODE_DISPLAY_NAME_MAPPINGS as _D_MATHF,
)
from .calculator import (
    NODE_CLASS_MAPPINGS as _M_CALC,
    NODE_DISPLAY_NAME_MAPPINGS as _D_CALC,
)
from .tone_compensate import (
    NODE_CLASS_MAPPINGS as _M_TONE,
    NODE_DISPLAY_NAME_MAPPINGS as _D_TONE,
)
_M_FLOAT = _D_FLOAT = {}
if sys.platform == "win32":
    from .float_window import (
        NODE_CLASS_MAPPINGS as _M_FLOAT,
        NODE_DISPLAY_NAME_MAPPINGS as _D_FLOAT,
    )
from .segment_table import (
    NODE_CLASS_MAPPINGS as _M_SEG,
    NODE_DISPLAY_NAME_MAPPINGS as _D_SEG,
)
from .resolution_select import (
    NODE_CLASS_MAPPINGS as _M_RES,
    NODE_DISPLAY_NAME_MAPPINGS as _D_RES,
)
from .seed import (
    NODE_CLASS_MAPPINGS as _M_SEED,
    NODE_DISPLAY_NAME_MAPPINGS as _D_SEED,
)
from .boolean import (
    NODE_CLASS_MAPPINGS as _M_BOOL,
    NODE_DISPLAY_NAME_MAPPINGS as _D_BOOL,
)
from .show_text import (
    NODE_CLASS_MAPPINGS as _M_STXT,
    NODE_DISPLAY_NAME_MAPPINGS as _D_STXT,
)
from .beat_cue import (
    NODE_CLASS_MAPPINGS as _M_CUE,
    NODE_DISPLAY_NAME_MAPPINGS as _D_CUE,
)
from .audio_load import (
    NODE_CLASS_MAPPINGS as _M_AL,
    NODE_DISPLAY_NAME_MAPPINGS as _D_AL,
    register_routes as _al_register_routes,
)

from .xh_h3_latent_continuation import (
    NODE_CLASS_MAPPINGS as _M_H3LC,
    NODE_DISPLAY_NAME_MAPPINGS as _D_H3LC,
)

from .xh_h3_tst import (
    NODE_CLASS_MAPPINGS as _M_H3TST,
    NODE_DISPLAY_NAME_MAPPINGS as _D_H3TST,
)

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

NODE_CLASS_MAPPINGS.update(_M_GRP)
NODE_CLASS_MAPPINGS.update(_M_LBL)
NODE_CLASS_MAPPINGS.update(_M_TMR)
NODE_CLASS_MAPPINGS.update(_M_CNT)
NODE_CLASS_MAPPINGS.update(_M_LOOP)
NODE_CLASS_MAPPINGS.update(_M_MATH)
NODE_CLASS_MAPPINGS.update(_M_MATHF)
NODE_CLASS_MAPPINGS.update(_M_CALC)
NODE_CLASS_MAPPINGS.update(_M_TONE)
NODE_CLASS_MAPPINGS.update(_M_SEG)
NODE_CLASS_MAPPINGS.update(_M_RES)
NODE_CLASS_MAPPINGS.update(_M_SEED)
NODE_CLASS_MAPPINGS.update(_M_BOOL)
NODE_CLASS_MAPPINGS.update(_M_STXT)
NODE_CLASS_MAPPINGS.update(_M_CUE)
NODE_CLASS_MAPPINGS.update(_M_AL)
NODE_CLASS_MAPPINGS.update(_M_H3LC)
NODE_CLASS_MAPPINGS.update(_M_H3TST)
NODE_CLASS_MAPPINGS.update(_M_FLOAT)
NODE_DISPLAY_NAME_MAPPINGS.update(_D_GRP)
NODE_DISPLAY_NAME_MAPPINGS.update(_D_LBL)
NODE_DISPLAY_NAME_MAPPINGS.update(_D_TMR)
NODE_DISPLAY_NAME_MAPPINGS.update(_D_CNT)
NODE_DISPLAY_NAME_MAPPINGS.update(_D_LOOP)
NODE_DISPLAY_NAME_MAPPINGS.update(_D_MATH)
NODE_DISPLAY_NAME_MAPPINGS.update(_D_MATHF)
NODE_DISPLAY_NAME_MAPPINGS.update(_D_CALC)
NODE_DISPLAY_NAME_MAPPINGS.update(_D_TONE)
NODE_DISPLAY_NAME_MAPPINGS.update(_D_SEG)
NODE_DISPLAY_NAME_MAPPINGS.update(_D_RES)
NODE_DISPLAY_NAME_MAPPINGS.update(_D_SEED)
NODE_DISPLAY_NAME_MAPPINGS.update(_D_BOOL)
NODE_DISPLAY_NAME_MAPPINGS.update(_D_STXT)
NODE_DISPLAY_NAME_MAPPINGS.update(_D_CUE)
NODE_DISPLAY_NAME_MAPPINGS.update(_D_AL)
NODE_DISPLAY_NAME_MAPPINGS.update(_D_H3LC)
NODE_DISPLAY_NAME_MAPPINGS.update(_D_H3TST)
NODE_DISPLAY_NAME_MAPPINGS.update(_D_FLOAT)

# 音频加载的信息条探测路由（注册失败只打日志，不影响节点；2026-10-16 新增）
try:
    _al_register_routes()
except Exception as _e:                                  # noqa: BLE001
    print(f"[XH LoadAudio] /xh/audioload/probe 路由注册失败（不影响节点）：{_e}")

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]

# 2026-10-16：分段表的 /xh_segments/set_slots 路由与「🔄 刷新段数」按钮一并删除
#   （段数早就是节点自身参数 + 纯前端折叠，路由自 2026-10-07 起已无人调用）。
