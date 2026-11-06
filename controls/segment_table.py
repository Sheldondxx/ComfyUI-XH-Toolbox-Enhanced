# 🔁XH-分段表（XH 家族）
#
# 用途：长视频 / MV 分段时，按**循环索引**取该段的时间信息 ——
#   起始秒（前缀和自动算）、本段时长、结束秒、表里一共几段。
#   ⇒ 让"每段多久"由**一张表**决定，而不是所有段都等长。
#
# 为什么需要它：官方 MV skill 要求「镜头精确映射到歌词时间戳与鼓点」，
#   镜头长度本来就是**不均匀**的（副歌长、鼓点切换快），
#   而原来的做法是 `索引 × 每段秒数` —— 天生只能等分。这张表就是补这个口子。
#
# ------------------------------------------------------------------ 两种填法（2026-10-16 改版）
# 同一个节点、两种输入形态，节点工具栏的「⇄ 批量粘贴 / ⇄ 逐段填写」按钮**一键互切**：
#   · 批量粘贴（默认，input_mode=False）：durations 一个多行框，一行一个秒数。
#     粘几行「段数」就自动变几（300ms 防抖，只数能解析出数字的行，clamp 1..64）；
#     有内容时优先于分段框。
#   · 逐段填写（input_mode=True）：`seg_1` `seg_2` … 每段一个独立框，要几个框改「段数」。
#     此时 durations 里残留的内容**保留但不生效**（后端只认分段框）。
# 切换时数据**双向自动同步**：批量→逐段按行解析填进 seg_N（段数=行数）；
# 逐段→批量把当前可见的段框重新生成一行一个的文本。
# 旧存档没有 input_mode 字段：前端按「哪种填法有数据」自动选模式打开，行为与老版本一致。
#
# 分段框细则：顺序 = 镜头顺序；**只填有值的框**（0 = 没填，自动跳过）；
#   至少第 1 段要有值，否则报错（不会静默乱跑）；
#   「段数」= 要显示多少个框，改完**立刻**显示那么多框（纯前端折叠，无延迟）。
# 批量粘贴细则：用脚本/其他工具一次算出一整首（如扒鼓点得来的 35 行）→ 直接整段粘进来；
#   每行只取**第一个数字**，后面可写注释（`#` 之后全部忽略）；空行/`#` 行自动跳过；
#   只填一行（如 `5`）= 所有段都用这个时长（等长模式），此时「段数」返回 1。
#
# ------------------------------------------------------------------ 两个开关（2026-10-21 三次改造）
# ① 单位（秒 / 帧）—— widget `unit`，默认「秒」：
#   · 秒：老行为逐字不变 —— 你填几秒就吐几秒，「秒 → 模型帧数」交给下游
#     🔁XH-帧数对齐 / ComfyMathExpression 做；
#   · 帧：段框直接填**帧数**（如 124/124/124），原样吐帧数（合法化交给下游
#     🔁XH-帧数对齐）—— 直连 🔁XH-加载视频 的 start_frame/frame_count 口，
#     或经 🔁XH-帧数对齐（规矩选 H3 17k+5 等）中转。
#     ⇒ 全链路只有一个帧数真源，治「5 秒 → 120 帧 / 124 帧 / 5.000 秒」一数三貌。
# ② 模式（连续 / 跳接）—— widget `ui_mode`，**纯前端显隐**，后端零参与：
#   · 连续（默认）：只填时长，所有段框全显示、改段数就往下长，起始全程自动接续
#     = 老分段表体验；
#   · 跳接：一次精调一段，当前编辑组多显示一个起始框（0 = 自动接续；填了 = 跳片头/段间重叠）。
#   🔴 两个模式读写同一批控件（seg_N / start_N），切换只是显隐、数据不丢；
#      后端把 start_N=0 一律当自动接续 ⇒ 「只填时长」就是老分段表的子集。
#
# ------------------------------------------------------------------ 比"手算"多做的事
#   · 起始秒自动做前缀和，你不用自己一格格累加（改一个数后面全跟着对）；
#   · 索引越界**报错说清表里有几段**（可开 clamp 自动兜）；
#   · 多一个 info 文字输出，把「第几段 / 起始 / 时长 / 结束 / 数据来自哪」白纸黑字打出来；
#   · 【可选】「H3 帧格吸附」开关（2026-10-08 加）：直接填 5 / 6 / 8 这种「人话秒数」，
#     节点自动换算成模型真正接受的帧数（H3：帧数 ≡ 5 (mod 17)；即官方工作流里那条
#     `(max(5, round(a*24)) + (5 - (max(5, round(a*24)) % 17)) % 17) / 24`），
#     并且 start_sec 也落在同一帧格上 ⇒ 音频裁剪长度与视频帧数**严格相等**、不会逐段累积误差。
#     常数 24fps / 模数 17 / 偏移 5 藏在 hidden 输入里，界面上看不到（要改用 JSON 或找作者）。
#
# 🔴 铁律：FLOAT/INT 必须显式写 min/max（不写默认 0~2048，负数/大于 2048 的值填不进）。
#
# 2026-09-30：由"只能填多行文本"改成"每段一个独立框"。
# 2026-10-07：段数从「后端全局 json + 重建画布」改成「节点自身参数 + 纯前端折叠」——
#   ① 改段数实时生效，无延迟；② 段数随工作流走；③ 同类节点互不干扰。

import json
import os
import re
import time

_HERE = os.path.dirname(os.path.abspath(__file__))
_SLOTS_FILE = os.path.join(_HERE, "segments.json")

# 2026-10-16 由 8 改 1（用户要求）：拖出来只给 1 段，要几段自己改「段数」。
# 与 web/xh_segment_table.js 的 DEFAULT_SLOTS 双写一致（改一个必须同步另一个）。
DEFAULT_SEG_SLOTS = 1
MIN_SEG_SLOTS = 1
MAX_SEG_SLOTS = 64

_SEG_KEY_RE = re.compile(r"^seg_(\d+)$")
_NUM_RE = re.compile(r"-?\d+(?:\.\d+)?")


# ------------------------------------------------------------------ 框数存取（已弃用，保留避免外部调用报错）
def load_slots() -> int:
    """读当前框数。文件不存在/损坏都退回默认值。（历史兼容，已不再影响节点定义）"""
    try:
        with open(_SLOTS_FILE, "r", encoding="utf-8") as f:
            n = int(json.load(f).get("slots"))
    except Exception:
        return DEFAULT_SEG_SLOTS
    return max(MIN_SEG_SLOTS, min(n, MAX_SEG_SLOTS))


def save_slots(n) -> int:
    """写框数，返回实际写入值（越界会被夹紧）。（历史兼容，已不再被前端调用）"""
    n = max(MIN_SEG_SLOTS, min(int(n), MAX_SEG_SLOTS))
    with open(_SLOTS_FILE, "w", encoding="utf-8") as f:
        json.dump({"slots": n}, f)
    return n


# ------------------------------------------------------------------ 解析
def _parse_durations(text):
    """从多行文本里抽时长：每行取第一个数字，跳过空行与 # 注释行。"""
    vals = []
    for raw in (text or "").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        m = _NUM_RE.search(line)
        if m:
            vals.append(float(m.group(0)))
    return vals


def _collect(kwargs, durations, num_segments=None, input_mode=False):
    """决定这次用哪套数据。
    返回 (vals, source说明)。
    input_mode：True = 逐段填写（**忽略 durations**，只认分段框）；
                False = 批量粘贴（durations 有内容 → 用它；为空/解析不出正值
                → 退回分段框 —— 旧存档默认 False，行为与 2026-10-16 之前一致）。
    num_segments：只收集「段数」范围内的框，范围外（折叠隐藏）的框即使残留有值也忽略
    —— 修掉和链提示词选择器同款的 bug：缩小段数后，隐藏框里残留的 >0 值会被当成一段来跑。
    🔴 2026-10-16：批量路径与逐段路径**语义对齐**——
       · `0` / 负值行 = 没填，跳过（与分段框 `0 = 没填` 一致）；
       · 超过 MAX_SEG_SLOTS(64) 行的部分截掉（否则段数失控，
         前端「段数」clamp 1..64、后端却收 100 段，循环/越界逻辑全乱）。"""
    if not input_mode and isinstance(durations, str) and durations.strip():
        vals = [v for v in _parse_durations(durations) if v > 0][:MAX_SEG_SLOTS]
        if vals:                            # 全是 0/注释行 ⇒ 当没填，回落分段框
            return vals, "批量粘贴框"

    max_idx = MAX_SEG_SLOTS if not num_segments else max(MIN_SEG_SLOTS, int(num_segments))
    found = []
    for k, v in kwargs.items():
        m = _SEG_KEY_RE.match(k)
        if not m:
            continue
        seg_no = int(m.group(1))
        if seg_no > max_idx:            # 范围外（折叠隐藏）的框忽略
            continue
        try:
            f = float(v)
        except (TypeError, ValueError):
            continue
        if f > 0:                       # 0 = 没填，跳过
            found.append((seg_no, f))
    found.sort(key=lambda x: x[0])
    return [v for _, v in found], "分段框"


def _as_int(v, default):
    """把可能是 str/None/非法值的输入稳妥转成 int，失败则退回 default。"""
    try:
        return int(v)
    except (TypeError, ValueError):
        return int(default)


def _snap_to_frame(seconds, fps=24, mod=17, off=5):
    """把「秒数」吸附到模型真正接受的帧格上，返回 (吸附后秒数, 帧数)。

    规则（与官方 H3 工作流的数学表达式逐字等价）：
        f0 = max(off, round(seconds * fps))      # 先换帧、并保证不小于 off
        f  = f0 + ((off - f0 % mod) % mod)       # 再向上取到最近的「f ≡ off (mod mod)」
        sec = f / fps

    ⚠️ `%` 用 Python/simpleeval 语义（负数取模返回非负），a=6 → 144 帧 → +14 → **158 帧**，
       不是 141 帧。用 JS 的 `%` 会算成 141，长度对不上视频，别踩。
    """
    try:
        fps = float(fps)
    except (TypeError, ValueError):
        fps = 24.0
    if fps <= 0:
        fps = 24.0
    mod = _as_int(mod, 17)
    if mod <= 0:
        mod = 17
    off = max(0, min(_as_int(off, 5), mod - 1))

    f0 = max(off, int(round(float(seconds) * fps)))
    frames = f0 + ((off - (f0 % mod)) % mod)
    return frames / fps, frames


# ------------------------------------------------------------------ 段 + 两个开关（2026-10-21 三次改造）
# 演进线（用户原话驱动的三次改造，别再把老设计改回来）：
#   ① 2026-10-15 单段时间表 → ② 2026-10-16 两种填法（批量/逐段）→
#   ③ 2026-10-21 上午「多通道输出」（上线两天被否：「你额外添加那些通道，我迷茫了」）→
#   ④ 2026-10-21 下午「一段 = 一组预设，时长+起始秒两个框」（又被否：「之前单纯的一个分段功能消失了」）→
#   ⑤ 2026-10-21 晚定稿：**一段 = 一个段长**，模式两种看法（连续 / 跳接），
#      单位两种（秒 / 帧）—— 老分段表行为是它的子集，输出口始终 5 个。
# 定稿形态：
#   · 「段数」= 复用老控件 num_segments（默认 1，要几段自己改，改完立刻显示）；
#   · 每段两个框：`seg_N`（段长，老控件复用）+ `start_N`（起始，新增，0 = 自动接续）；
#   · 「当前编辑第几段」（preset_edit，纯界面）：切到哪段只显示哪段的框，其它自动收起；
#   · 单位开关 `unit`：秒（默认，老行为）/ 帧（段框填帧数，原样吐帧数，合法化交下游）；
#   · 模式开关 `ui_mode`：连续（默认，老分段表体验）/ 跳接；
#   · 运行时按「索引」口（接循环索引）取第几段，从原有 5 个输出口吐出
#     —— 🔴 **输出口一个不加**（老工作流连线一根不断）。
# 为什么要"起始填 0 自动接续"：起始与段长分开手填 = 接缝由用户自己负责，填错一个数就跳帧。
#   · 起始填 0（默认）= 自动接上一段的结尾 ⇒ 不想动脑就只填段长，行为与老版逐字一致；
#   · 起始填了非 0 = 完全听你的（跳片头 / 段间重叠 / 跳着取片段）。
# 🔴 seg_N / num_segments 这两个**控件名不能改**（改了老档数据全丢）—— 只改显示 label（前端 i18n）。
# 🔴 新控件一律追加在 required **最末尾**：老存档 widgets_values 位序一个都不能动
#    （skill §13.7：前端读档走 positional，中间插控件 = 整档串值）。

MAX_PRESET = MAX_SEG_SLOTS          # 段数与预设共用一把尺子：start_N 与 seg_N 一一对应
DEFAULT_PRESET_EDIT = 1             # 默认编辑第 1 段

# ---- 单位开关（2026-10-21）----
UNIT_SEC = "秒"
UNIT_FRAME = "帧"
UNITS = [UNIT_SEC, UNIT_FRAME]

# ---- 模式开关（2026-10-21，纯前端显隐，后端不读）----
# 🔴 2026-10-21 深夜改名：「只填时长/时长+起始秒」→「连续/跳接」（旧词没信息量，
#    说不出什么时候该选哪个）。选项值即存档值 ⇒ 旧档由前端 readUiMode 兼容迁移。
UI_SIMPLE = "连续"              # 只填时长、段间自动首尾相接（老分段表体验）
UI_FULL = "跳接"                # 时长+起始秒都手填：可跳片头/段间重叠/精确卡点
UI_MODES = [UI_SIMPLE, UI_FULL]

# 🔴 帧数规矩（RULE_* / _snap_frames_int）2026-10-21 深夜已删：分段表只吐原始值，
#    合法帧数吸附是下游的活（🔁XH-帧数对齐 / ComfyMathExpression 各自带同款下拉）。


def _sid_of_uid(uid):
    """从 unique_id 抠出基础节点 id。
    循环体 / 子图展开后 unique_id 可能是 '599_2' / '599:1' 这种带后缀形式，
    老写法 int(str(uid).split(":")[0]) 只吃 '599:1'，碰到 '599_2' 直接抛异常
    => 事件永远发不出去（前端只剩「运行中…」不报段号，2026-10-24 实测定位于此）。
    """
    if uid is None:
        return None
    m = re.match(r"^\s*(\d+)", str(uid))
    try:
        return int(m.group(1)) if m else None
    except (TypeError, ValueError):
        return None


def _collect_starts(kwargs, durations, num_segments=None, input_mode=False):
    """收集每组**手填**的起始秒，与 _collect 严格对齐（同一批有效组、同一个顺序）。

    返回与 _collect 的 vals **等长**的 list；没填 / 填 0 = 自动接续（补 0.0）。
    ⚠️ 批量粘贴模式（durations 有内容）没有对应的起始框 ⇒ 全部返回 0.0（自动接续）。
    """
    if not input_mode and isinstance(durations, str) and durations.strip():
        vals = [v for v in _parse_durations(durations) if v > 0][:MAX_SEG_SLOTS]
        if vals:
            return [0.0] * len(vals)
    max_idx = MAX_PRESET if not num_segments else max(MIN_SEG_SLOTS, int(num_segments))
    valid = []
    for k, v in kwargs.items():
        m = _SEG_KEY_RE.match(k)
        if not m:
            continue
        no = int(m.group(1))
        if no > max_idx:                       # 范围外（折叠隐藏）的组忽略，与 _collect 同规则
            continue
        try:
            f = float(v)
        except (TypeError, ValueError):
            continue
        if f > 0:                              # 0 = 没填，跳过
            valid.append(no)
    valid.sort()
    out = []
    for no in valid:
        try:
            f = float(kwargs.get("start_%d" % no) or 0.0)
        except (TypeError, ValueError):
            f = 0.0
        out.append(f if f > 0 else 0.0)
    return out


class XHSegmentTable:
    """按索引取该段的起始秒/起始帧 / 时长 / 结束 / 段数（单位看开关）。"""

    @classmethod
    def INPUT_TYPES(cls):
        required = {}

        # ---- 原有三件：顺序**必须**保持 index → durations → clamp ----
        #      （新字段一律追加在后面，这样旧存档的 widgets_values 不会串位）
        # 循环的 index 接这里（也可手动填来单步测试）
        required["index"] = ("INT", {
            "default": 0, "min": -4096, "max": 4096, "step": 1,
            "tooltip": (
                "取第几段。0 = 第 1 段、1 = 第 2 段……直接接 🔁XH-循环 的 index 即可。\n"
                "支持负数倒数：-1 = 最后一段。\n"
                "⚠️ 超出总段数时：clamp 关 → 报错；clamp 开 → 自动贴到首/末段。"
            ),
        })
        # 批量粘贴口：留空则用下面的分段框
        required["durations"] = ("STRING", {
            "default": "", "multiline": True,
            "tooltip": (
                "批量粘贴口：一行一个秒数，一次能粘几十行（比如扒出来的鼓点）。\n"
                "🔴 **当前是「批量粘贴」模式时，有内容就优先用它**；\n"
                "🔴 切到「逐段填写」模式后（工具栏 ⇄ 按钮），这里的内容**保留但不生效**。\n"
                "格式：`第N段 秒数` 或只写秒数都行；写 `#1 3.5`、`1: 3.5` 也认。"
            ),
        })
        # 表里段数不够时：关 = 报错（安全），开 = 自动钳到首/尾段
        required["clamp"] = ("BOOLEAN", {
            "default": False,
            "tooltip": (
                "index 超出表里的段数怎么办：\n"
                "· 关（默认）= 直接报错，告诉你一共有几段（推荐：能尽早发现段数配错）\n"
                "· 开 = 自动钳到第一段 / 最后一段，流程不中断"
            ),
        })

        # ---- 段框（固定声明 MAX_SEG_SLOTS 个，前端按「段数」折叠显示）----
        # 🔴 控件名 seg_N 是**存档键**，改不得（改了老档数据全丢）；显示文案归前端 i18n（「第 N 段(秒)」）。
        for i in range(1, MAX_SEG_SLOTS + 1):
            required[f"seg_{i}"] = (
                # 🔴 2026-10-21 深夜 FLOAT→INT（用户定：秒单位也整数，要浮点下游调）。
                #    根因：原生 canvas 控件下 FLOAT 显示强制一位小数（600.0），INT 才干净。
                #    控件形态：家族统一滑块（web/xh_segment_table.js 用 makeXHSlider，与 🔁XH-滑块 同款）
                #    —— 横向拖拽条 + 数字框（原生 ▲▼ 微调），seg_N/start_N 本体作数据载体；
                #    2026-10-22 曾试官方 slider 变体+±钮，64px 硬挤反复翻车，已废弃。
                # 🔴 2026-10-22 默认值 0→5（用户定）：0 的语义是「这一段没填＝跳过」，
                #    新拖出来的节点第 1 段本该有值（5 秒 = 单次生成的合理长度），
                #    滑块也从 5 起步比从 0 好拖。⚠️ 0 仍是合法值（=跳过该段），
                #    用户想跳过某段照样填 0。
                # 🔴 max 保持 600（= 帧单位的 600 帧 ≈ 25s@24fps，帧用户不受影响）；
                #    **秒单位的前端上限 30 由 web 端在切换单位时动态改**（见 xh_segment_table.js
                #    的 applySegMaxByUnit）—— py 端 schema 是静态的，切单位时改不动。
                "INT",
                {
                    "default": 5,
                    "min": 0,
                    "max": 600,
                    "step": 1,
                    "tooltip": (
                        f"【🎞 第 {i} 段·时长】这一段多长（单位是「秒」还是「帧」，看下面的单位开关）。\n"
                        "⚠️ **0 = 这一段没填，会被自动跳过**；"
                        "别拿 0 表示「时长为零」，它表示的是不存在的段。\n"
                        "⚠️ 想显示更多段，直接改上面的「段数」。\n"
                        "| English: Duration of segment %d (seconds or frames, see unit switch)."
                    ) % i,
                },
            )

        # 只给前端「折叠/展开段框」读，不参与执行逻辑；随工作流保存
        # 控件名 num_segments 是存档键，改不得；显示文案归前端 i18n（「段数」）。
        required["num_segments"] = (
            "INT",
            {
                "default": DEFAULT_SEG_SLOTS,
                "min": MIN_SEG_SLOTS,
                "max": MAX_SEG_SLOTS,
                "step": 1,
                "tooltip": (
                    "【🔢 段数】要显示多少段。改完数字立刻生效。\n"
                    "批量粘贴模式下粘几行，这个数字也会自动跟着变成几。\n"
                    "⚠️ 默认就是 1 —— 要几段自己往上加，不会一拖出来就糊你一脸。\n"
                    "⚠️ 这个值随工作流保存，发给别人也不会变。\n"
                    "⚠️ 它本身不参与任何计算，只是控制界面显示几段。\n"
                    "| English: How many segments to show. Pure UI, not used in math."
                ),
            },
        )

        # 自循环·跑全部段（不接循环也能一次出 N 段）。追加在最后，旧存档位序不错位。
        required["all_segments"] = (
            "BOOLEAN",
            {
                "default": False,
                "tooltip": (
                    "让节点「不用外接循环也一次跑完所有段」。\n"
                    "· 开 = 三个时间口（起始秒 / 本段时长 / 结束秒）都按你填的段，"
                    "依次给出每一段 ⇒ ComfyUI 自动把下游跑 N 遍（一次 Queue 出 N 段）。\n"
                    "· 关（默认）= 仍按「索引」取单段（下游跑 1 遍），原本接循环的用法完全不变。\n"
                    "⚠️ 绝对不能和任何循环（XH-循环 / easy-use 循环）一起用！"
                    "节点在循环里会被反复执行，每次又吐全部段 ⇒ N×N 重复跑、又慢又费显存。"
                    "循环体内请用「索引」口接循环，逐段喂给下游。\n"
                    "⚠️ 本开关是 ComfyUI 的「列表广播」：同阶段的所有段一起跑"
                    "（先所有一采、再所有二采…），不是「段1跑完整条流水线→段2」的顺序执行。"
                    "要逐段顺序跑完整个工作流（每段都出一段视频再进下一段），"
                    "请用 🔁XH-循环 把整条流水线框进循环体，本开关保持关闭。"
                ),
            },
        )

        # 【2026-10-16 新增】输入方式（批量粘贴 / 逐段填写）—— 由工具栏「⇄」按钮切换。
        # 追加在 required 最末尾：旧存档 widgets_values 按位序回填时不会串到任何老控件。
        # 界面上不直接显示这个控件（前端视觉隐藏，按钮即开关），但值随工作流保存。
        required["input_mode"] = (
            "BOOLEAN",
            {
                # 🔴 2026-10-22 默认 False→True（用户定）：新拖出来的节点默认「逐段填写」。
                #    理由（用户原话）：「我不希望它默认是这个批量粘贴模式」——
                #    逐段填写才是这个节点的主形态（分段框 + 滑块 + ±微调），
                #    批量粘贴是「有整段数字要贴」时才切的辅助形态。
                #    ⚠️ 只影响**新建**节点：老档的 input_mode 值随存档回填，不受影响。
                "default": True,    # True = 逐段填写（默认）；False = 批量粘贴
                "tooltip": (
                    "输入方式（节点工具栏上的「⇄」按钮一键切换，切换时数据自动互相同步）：\n"
                    "· 开（默认）= 逐段填写：只用下面的分段框，durations 里残留内容保留但不生效\n"
                    "· 关 = 批量粘贴：durations 一行一个秒数；粘几行段数自动变几\n"
                    "⚠️ 这个值随工作流保存；旧存档没有这个字段时，"
                    "前端按你哪种填法有数据自动选模式打开。"
                ),
            },
        )

        # 【2026-10-15 删】原来的「H3 帧格吸附」开关（2026-10-08 加）已删除。
        #   理由（用户要求的"简化"）：本节点**只负责照原样吐秒数**；
        #   「秒 → 模型认的合法帧数」这件事统一交给下游的 ComfyMathExpression 做
        #   （H3：`(max(5, round(a * 24)) + (5 - (max(5, round(a * 24)) % 17)) % 17)`；
        #     LTX-2.5：`8 * (-((1 - a*b) // 8)) + 1`）。
        #   ⇒ 节点上没有"帧格/帧率"这类概念，也就不会再和下游的换算打架。
        #   它原来是**最后一个**控件，删掉不会串动任何其它控件的存档位序。
        # 🔴 2026-10-08 改为「真隐藏输入」（从 required widget 挪到 hidden 段）：
        #    · 界面上不再显示这个框 ⇒ 不会被误改、也不占 widgets_values 位；
        #    · 值只在「工作流 inputs 里真给了」时才生效（execution.py:193
        #      input_category == "hidden" 时直接按原值取），没给就用函数默认值 -1；
        #    · hidden 段的值写 "INT" 而非 PROMPT/UNIQUE_ID 等官方常量 ⇒
        #      后端不会自动注入任何值，只有 XH-循环展开显式 set_input 才写得进去。
        #    用途：XH-循环展开时写入真实轮次（0 起），用来判断「自己是不是在循环体内」，
        #    优先级高于脆弱的 unique_id 前缀解析。
        # ---- 【2026-10-21 二次改造】预设：每组的「起始秒」+「当前编辑第几组」----
        # 「多通道输出」上线两天被用户否掉（原话：「你额外添加那些通道，我迷茫了」）——
        #   他要的是**一组参数 = 一个预设**：一次只编辑一组，其它组自动收起，输出口一个不加。
        #   ⇒ ch_1..ch_6 / fps / frame_rule / ch_count 全部撤掉，RETURN 缩回 5 口
        #     （已 grep 验证：他本机工作流没有任何线接通道口，撤口不断线）。
        # 「当前编辑第几段」：纯前端折叠用（切到哪段只显示哪段的框），不参与计算。
        required["preset_edit"] = (
            "INT",
            {
                "default": DEFAULT_PRESET_EDIT, "min": 1, "max": MAX_PRESET, "step": 1,
                "tooltip": (
                    "【🖊 当前编辑第几段】界面一次只显示一段的框（时长，或时长+起始），"
                    "切到哪段显示哪段，其它段自动收起。\n"
                    "纯界面开关，不参与计算；**运行时按「索引」口取第几段**（接循环索引）。\n"
                    "| English: Which segment's fields to show. Pure UI, not used in math."
                ),
            },
        )

        # 每段的起始：填 0（默认）= 自动接上一段的结尾（接缝零误差，老行为不变）；
        # 填了非 0 = 完全听你的（跳片头 / 段间重叠 / 跳着取片段）。
        # 🔴 追加在 required 最末尾：老存档 widgets_values 位序一个都不动。
        for i in range(1, MAX_PRESET + 1):
            required[f"start_{i}"] = (
                # 🔴 2026-10-21 深夜 FLOAT→INT，同 seg_N（秒单位也整数，要浮点下游调）。
                #    控件形态：同 seg_N，家族标准 INT 控件（废弃官方 slider 变体）。
                "INT",
                {
                    "default": 0,
                    "min": 0,
                    "max": 600,
                    "step": 1,
                    "tooltip": (
                        f"【📌 第 {i} 段·起始】这一段从第几秒（单位=秒）或第几帧（单位=帧）开始取。\n"
                        "· 填 0（默认）= 自动接上一段的结尾 —— 接缝零误差，老行为不变\n"
                        "· 填了数 = 完全听你的：跳片头 / 段间重叠 / 跳着取片段\n"
                        f"⚠️ 只有「当前编辑」切到第 {i} 段、且模式是「跳接」时才看得到这个框。\n"
                        "| English: Start of segment %d. 0 = auto-continue from previous segment."
                    ) % i,
                },
            )

        # ---- 【2026-10-21】两个开关：一律追加在 required **最末尾** ----
        #      （老存档 widgets_values 位序一个都不能动，skill §13.7；
        #       今天上午的预设改造把 preset_edit / start_N 加在末尾，这两个只能排它们后面）
        # ① 单位：秒（默认）= 老行为，原样吐秒数；帧 = 段框填帧数，原样吐帧数（合法化交下游）。
        required["unit"] = (
            UNITS,
            {
                "default": UNIT_SEC,
                "tooltip": (
                    "【🔢 单位】段框里填的是什么。\n"
                    "· 秒（默认）：老行为 —— 填几秒吐几秒，「秒 → 模型帧数」交给下游\n"
                    "  🔁XH-帧数对齐 / ComfyMathExpression 做；\n"
                    "· 帧：段框直接填帧数（如 124/124/124），原样吐帧数 —— 要合法帧数\n"
                    "  （H3：17k+5 / LTX：8k+1）请在下游接 🔁XH-帧数对齐 选对应规矩；\n"
                    "  三个时间口直连 🔁XH-加载视频 的 start_frame/frame_count。\n"
                    "🔴 全链路只有一个帧数真源 ⇒ 不再有「5 秒 → 120 帧 / 124 帧」一数三貌。\n"
                    "| English: Unit of segment fields (seconds = legacy / frames = native)."
                ),
            },
        )
        # ② 帧数规矩控件已删（2026-10-21 深夜，用户定）——
        #    「这个只是分段表，填帧数规矩有必要吗？还是放在说明里就行」。
        #    本节点只吐原始值；「多少帧合法」是换算，交给下游 🔁XH-帧数对齐 /
        #    ComfyMathExpression（它们自带同款规矩下拉）。RULE_* / _snap_frames_int 一并删除。
        # ③ 模式：连续 / 跳接 —— 纯前端显隐（web/xh_segment_table.js），
        #    后端完全不读它；两个模式读写同一批 seg_N/start_N，切换只是显隐不丢数据。
        required["ui_mode"] = (
            UI_MODES,
            {
                "default": UI_SIMPLE,
                "tooltip": (
                    "【🖥 模式】段框怎么显示（只影响你看得到几个框，不影响计算）。\n"
                    "· 连续（默认）：只填时长，段间自动首尾相接 —— 老分段表体验；\n"
                    "· 跳接：每段时长+起始秒都手填\n"
                    "  （起始填 0 = 自动接续；填了 = 跳片头 / 段间重叠 / 跳着取片段）。\n"
                    "🔴 两个模式读写同一批数据，切来切去不丢值。\n"
                    "| English: mode (continuous / jump). Display only."
                ),
            },
        )

        hidden = {
            "unique_id": "UNIQUE_ID",
            "xh_loop_turn": "INT",
        }

        return {"required": required, "hidden": hidden}

    # 🔴 2026-10-21：输出口**缩回 5 个**（撤掉上线两天的 6 条通道口，用户：「迷茫了」）。
    #    已 grep 验证他本机工作流零接线到通道口 ⇒ 撤口不断线。
    #    以后要加输出口也只能**追加在末尾**：ComfyUI 的连线按端口序号记，中间插口会串位。
    RETURN_TYPES = ("INT", "INT", "INT", "INT", "STRING")
    RETURN_NAMES = ("start_sec", "duration", "end_sec", "count", "info")
    # 全部声明成「列表」⇒ all_segments 开时返回全部段（长度 N），
    # ComfyUI 自动把下游跑 N 遍；普通模式返回「长度 1 的列表」，下游跑 1 遍，行为不变。
    OUTPUT_IS_LIST = (True, True, True, True, True)
    FUNCTION = "get_segment"
    CATEGORY = "🔁XH/工具"
    DESCRIPTION = (
        "【干什么】一张「每段多长」的表：按段号告诉你这一段的起始秒、时长、结束秒，"
        "并顺带给出总段数。起始默认自动累加（填 0 接上段结尾），也可每段手填。\n"
        "【怎么配】工具栏「⇄」按钮一键切换两种填法，切换时数据自动互相同步：\n"
        " ① 批量粘贴（默认）：durations 里一行一个数整段粘，"
        "粘几行「段数」自动变几；有内容时优先于段框\n"
        " ② 逐段填写：每段一个独立框（seg_1、seg_2…），**0 = 没填会自动跳过**，"
        "要显示更多框直接改「段数」，实时生效\n"
        "· index：取第几段（接循环 index，0 起）\n"
        "· clamp：段号超范围时报错（关）还是自动贴到首/末段（开）\n"
        "【怎么用】给循环的每一轮喂「这一段的起止时间」，"
        "典型用途：按鼓点/台词时间点切分长视频、给每段配不同的提示词。\n"
        "【单位开关】秒（默认）= 老行为，原样吐秒数，「秒 → 模型帧数」交给下游\n"
        "  🔁XH-帧数对齐 / ComfyMathExpression；帧 = 段框直接填帧数（如 124/124/124），\n"
        "  原样吐帧数 —— 要 H3/LTX 合法帧数，在下游接 🔁XH-帧数对齐 选对应规矩；\n"
        "  三个时间口直连 🔁XH-加载视频 的 start_frame/frame_count。\n"
        "  🔴 全链路只有一个帧数真源 ⇒ 治「5 秒 → 120 帧 / 124 帧」一数三貌、接缝漂移。\n"
        "【模式开关】连续（默认）= 老分段表体验：只填时长，段间自动首尾相接；\n"
        "  跳接 = 每段时长+起始秒都手填（起始填 0 = 自动接续；\n"
        "  填了 = 跳片头 / 段间重叠 / 跳着取片段）。\n"
        "  🔴 两个模式读写同一批数据，切换只是显隐不丢值；start_N 填 0 后端一律当自动接续。\n"
        "【输出】start_sec（起始，秒或帧看单位）、duration（本段时长）、end_sec（结束）、"
        "count（总段数）、info（这一轮到底算了什么，接显示文本就能看）。\n"
        "⚠️ 模式（批量/逐段）随工作流保存；旧存档按原有填法自动选模式打开。\n"
        "⚠️ 全填 0 / 两种填法都不填会明确报错，不会静默乱跑。\n"
        "【自循环】打开「自循环·跑全部段」后，不接任何循环也能一次把 N 段全部交给下游跑 N 遍；"
        "该开关与任何循环互斥，循环体内请保持关闭、改用「索引」口逐段。\n"
        "【帧格换算】本节点只吐原始值：单位 = 秒 原样吐秒数，单位 = 帧 原样吐帧数；\n"
        "  「多少帧合法」是换算，交给下游 🔁XH-帧数对齐（H3：17k+5 / LTX：8k+1）。\n"
        "🔴 为什么不是「起始一张表 + 时长一张表」：起始与时长是同一组段长的两种表示，\n"
        "分成两张表就要手动同步两份数据，改一个忘改另一个 ⇒ 接缝吞帧或跳帧。\n"
        "一张表 + 起始填 0 自动接续 ⇒ 数学上不可能错位；想手动就填，两全。"
    )

    # 每次 re-queue 都重算，避免命中缓存（尤其改了 seg 值之后）
    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return time.time()

    def get_segment(self, index, durations="", clamp=False,
                     num_segments=DEFAULT_SEG_SLOTS, all_segments=False,
                     input_mode=False, unique_id=None,
                     preset_edit=DEFAULT_PRESET_EDIT, xh_loop_turn=-1,
                     unit=UNIT_SEC, ui_mode=UI_SIMPLE, **kwargs):
        vals, source = _collect(kwargs, durations, num_segments, input_mode)
        # 🔴 2026-10-21 深夜：全链路整数化（seg_N/start_N 已是 INT，批量粘贴文本里
        #    万一粘了小数也在这里 round 归正）⇒ 三个时间口吐整数，要浮点下游自己调。
        vals = [int(round(float(v))) for v in vals]

        if not vals:
            raise ValueError(
                "[XH-分段表] 没拿到任何段长 —— 两种填法选一种：\n"
                "  ① 段框：至少把「第 1 段」填上（0 表示没填）；\n"
                "  ② 批量粘贴框：一行一个数（秒或帧，看单位开关；顺序 = 段顺序），整段粘进去即可。"
            )

        n = len(vals)

        # ---- 单位开关（2026-10-21）----
        # 秒（默认）：原样吐秒数；帧：段框填的就是帧数，原样吐帧数。
        # 🔴 2026-10-21 深夜：帧数吸附（规矩下拉）已删 —— 本节点只吐原始值，
        #    「多少帧合法」交给下游 🔁XH-帧数对齐 / ComfyMathExpression。
        unit_v = unit if unit in UNITS else UNIT_SEC
        frames_mode = (unit_v == UNIT_FRAME)
        snap_note = "（帧数模式 · 不吸附，合法化交给下游）" if frames_mode else ""

        # ---- 每段起始（2026-10-21）----
        # 每段一个起始：填 0 = 自动接上一段的结尾；填了非 0 = 听你的。
        # 重算后 starts[i] 就是第 i 段真正的起点（手填优先，否则接上段结尾）
        #    ⇒ 手填与自动接续可以混着用，第 k+1 段的"自动"基线跟着手填值走，不会对不上。
        starts_raw = _collect_starts(kwargs, durations, num_segments, input_mode)
        starts = []
        _cum = 0
        for _i, _v in enumerate(vals):
            _sv = int(round(float(starts_raw[_i]))) if _i < len(starts_raw) else 0
            _s = _sv if _sv > 0 else _cum
            starts.append(int(_s))
            _cum = _s + _v

        # 判断「自己是不是在 XH 循环体里」：优先用 XH 注入的 xh_loop_turn（>=0 即循环体内，
        # 真实 0 起轮次），其次 unique_id 前缀兜底（格式随 GraphBuilder 计数器变化、不稳定）。
        # 自循环（all_segments）只在「循环体外」有意义，循环体内直接走单段逻辑。
        try:
            _lt = int(xh_loop_turn) if xh_loop_turn is not None else -1
        except (TypeError, ValueError):
            _lt = -1
        turn = None
        if _lt >= 0:
            turn = _lt
        elif unique_id is not None:
            m = re.match(r"^(\d+)_", str(unique_id))
            if m:
                try:
                    turn = int(m.group(1))
                except (TypeError, ValueError):
                    turn = None

        # 一句话信息：帧模式吐整数帧，秒模式吐三位小数秒（单位跟着开关走）
        def _info_line(i, s, d, e, note):
            if frames_mode:
                return ("[XH-分段表] 第 %d 段：起始 %d 帧  时长 %d 帧  结束 %d 帧  "
                        "共 %d 段（%s）%s%s"
                        % (i, int(s), int(d), int(e), n, source, note, snap_note))
            return ("[XH-分段表] 第 %d 段：起始 %d 秒  时长 %d 秒  结束 %d 秒  "
                    "共 %d 段（%s）%s%s"
                    % (i, int(s), int(d), int(e), n, source, note, snap_note))

        # 🔴 批量自循环（不用外接循环，一次把全部段交给下游跑 N 遍）
        if all_segments and turn is None:
            durs, ends, counts, infos = [], [], [], []
            for i, v in enumerate(vals):
                end = starts[i] + v
                durs.append(int(v))
                ends.append(int(end))
                counts.append(int(n))
                _src = "（起点手填）" if (i < len(starts_raw) and starts_raw[i] > 0) else "（自动接续）"
                infos.append(_info_line(i, starts[i], v, end, _src))
            print("[XH-分段表] 自循环：一次性输出全部 %d 段" % n)

            # 🔴 2026-10-21：实时段进度推送（自循环一次性输出全部 N 段）
            try:
                from server import PromptServer
                _sid = None
                _sid = _sid_of_uid(unique_id)
                if _sid is not None and getattr(PromptServer, "instance", None) is not None:
                    PromptServer.instance.send_sync(
                        "xh-segtable/seg",
                        {"id": _sid, "seg": n, "total": n, "all": True},
                    )
                    print("[XH-分段表] 段进度 → %d/%d（自循环一次性输出）（uid=%s → id=%s）" % (n, n, unique_id, _sid))
                else:
                    print("[XH-分段表] 段进度没推出去：拿不到节点 id 或 PromptServer 未就绪")
            except Exception:
                pass
            # 🔴🔴 2026-10-23 修缩进血案：这行 return 原来缩在 except 里 ⇒ 只要不抛异常就**不返回**，
            #   直掉进下面的单段分支 ⇒ 自循环只输出 1 段（还没接循环也一样）；而且 try 原本在 if 外面，
            #   单段模式也会先发一个 seg=n 的错事件（状态条闪一下「第 N/N 段」）。
            #   现在 try/except 收进 if 内，return 回到 if 末尾。
            return (starts, durs, ends, counts, infos)

        # ---- 单段模式（普通用法 / 循环体内逐段）----
        idx = int(index)
        single = (n == 1)

        if single:
            dur = vals[0]
            # 只填了一段时的等长分支：起点 = 手填值（填了 start_1 就尊重，不再静默忽略）+ 每段等长累加
            base = starts[0] if (starts_raw and starts_raw[0] > 0) else 0.0
            start = base + dur * idx
            note = "（只给了 1 段 → 按等长处理：每段 %s；循环次数请自己做主填）" % (
                "%d 帧" % int(dur) if frames_mode else "%.3f 秒" % dur)
            if base > 0:
                note += "（起点手填 %s）" % ("%d 帧" % int(base) if frames_mode else "%.3f 秒" % base)
        else:
            if idx < 0 or idx >= n:
                if not clamp:
                    raise ValueError(
                        "[XH-分段表] 要第 %d 段，但你只填了 %d 段（合法索引 0 ~ %d）。"
                        "要么多填几段，要么把循环的「次数」改成 %d，"
                        "要么打开「越界自动钳制」让它重复首/尾段。"
                        % (idx, n, n - 1, n)
                    )
                fixed = 0 if idx < 0 else n - 1
                print("[XH-分段表] 索引 %d 越界（只填了 %d 段），已自动钳到第 %d 段" % (idx, n, fixed))
                idx = fixed
            start = starts[idx]
            dur = vals[idx]
            note = "（起点手填）" if (idx < len(starts_raw) and starts_raw[idx] > 0) else "（自动接续）"

        end = start + dur
        info = _info_line(idx, start, dur, end, note)
        print(info)

        # 🔴 2026-10-21：实时段进度推送（前端状态条 + 闪动提醒）
        try:
            from server import PromptServer
            _sid = None
            _sid = _sid_of_uid(unique_id)
            if _sid is not None and getattr(PromptServer, "instance", None) is not None:
                PromptServer.instance.send_sync(
                    "xh-segtable/seg",
                    {"id": _sid, "seg": idx + 1, "total": n,
                     "start": int(start), "dur": int(dur)},
                )
                print("[XH-分段表] 段进度 → 第 %d/%d 段（起始 %d / 时长 %d）（uid=%s → id=%s）"
                      % (idx + 1, n, int(start), int(dur), unique_id, _sid))
            else:
                print("[XH-分段表] 段进度没推出去：拿不到节点 id 或 PromptServer 未就绪")
        except Exception:
            pass

        # 所有口都返回「长度为 1 的列表」—— 兼容 OUTPUT_IS_LIST，下游跑 1 遍，行为不变。
        return ([int(start)], [int(dur)], [int(end)], [int(n)], [info])


NODE_CLASS_MAPPINGS = {"XHSegmentTable": XHSegmentTable}
NODE_DISPLAY_NAME_MAPPINGS = {"XHSegmentTable": "🔁XH-分段表"}


# ------------------------------------------------------------------ HTTP 路由（2026-10-16 删除）
# 原 `GET /xh_segments/set_slots`（「🔄 刷新段数」按钮写 segments.json 用）自 2026-10-07
# 起前端就不再调用；2026-10-16 刷新按钮删除，register_routes 整条链一并清掉。
# load_slots / save_slots 保留在文件顶部仅为防止外部代码 import 时报错，节点不再调用。
