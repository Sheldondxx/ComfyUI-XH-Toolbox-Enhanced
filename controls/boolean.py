# 🔘XH-布尔开关 + 🔀XH-切换（XH 家族）
#
# 来源（2026-10-09 逐行核对源码）：
#   · `XHBooleanToggle` ← 官方 `comfy_extras/nodes_primitive.py` 的 `Boolean`（node_id=PrimitiveBoolean）
#   · `XHBooleanSwitch` ← 官方 `comfy_extras/nodes_logic.py`  的 `SwitchNode`（node_id=ComfySwitchNode，
#     就是画布上那个「切换 #xx BETA」官方实验节点）
#
# ── 为什么自己做 ─────────────────────────────────────────────
# 官方 Boolean 控件上写的不是「开 / 关」，而是 i18n 直译出来的「为真实 / 为假实」——
# 正常人读不懂。根因：官方 `io.Boolean.Input("value")` **没传 label_on / label_off**，
# 前端就拿默认文案兜底（True / False 的直译）。
#
# 🔑 关键发现（读 comfy_api/latest/_io.py:247 才知道）：官方 Boolean.Input **本来就支持**
#    `label_on` / `label_off` 两个参数，会原样发给前端，只是官方节点自己没用。
#    ⇒ 我们在自己的节点里填上「开 / 关」，官方那套机翻直接消失，
#      不用改前端、不用汉化包、也不用让所有 XH 节点跟着 fallback。
#
# ── 界面（2026-10-09 用户拍板：要小、要一个滑块、不要解释行）──────
# 一个节点 = 标题 + **一行**：左右滑动的滑块。
#   · 拨到右边 = 开：整条轨道变绿 #27ae60，圆钮上写「开」
#   · 拨到左边 = 关：整条轨道变红 #c0392b，圆钮上写「关」
#   · 0.22s 缓动，自己会滑过去 ⇒ **没有第二个按钮、没有状态条、节点跟官方一样大**
#   ⇒ 滑块是 web/xh_boolean.js 里画的 DOM 控件（原生布尔 widget 被隐藏但保留，值照样存档）
#
# 接口（**与官方逐字一致**，老工作流里直接替换，连线一根都不用动）：
#   布尔开关：BOOLEAN 出 BOOLEAN（唯一输入口叫 value）
#   切换：    BOOLEAN(switch) + MatchType(on_false) + MatchType(on_true) → MatchType(output)
#
# ※ 2026-10-09 v1.6.1 精简：去掉了布尔开关的 `invert` 和切换的 `info` 文本输出
#   （就是它们把节点撑成了三行）。要取反用官方的 Invert Boolean，别再往这儿堆。

from comfy_api.latest import io

# 哨兵：区分「没接线」和「接了但值没算出来(None)」——照抄官方 nodes_logic.py
MISSING = object()


class XHBooleanToggle(io.ComfyNode):
    """🔘XH-布尔开关：一个 BOOLEAN 值，节点上直接拨（一个滑块，开绿关红）。"""

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="XHBooleanToggle",
            display_name="🔘XH-布尔开关",
            category="🔁XH/工具",
            search_aliases=["bool", "boolean", "toggle", "switch", "true", "false", "开关"],
            description=(
                "【🔘XH-布尔开关】官方 Boolean（PrimitiveBoolean）的家族版，接口完全一致\n"
                "（BOOLEAN 进 BOOLEAN 出，输入口也叫 value），老工作流可直接替换。\n"
                "节点上只有一个左右滑动的开关：拨右边=开（绿）/ 拨左边=关（红），\n"
                "不像官方那套机翻出来的「为真实 / 为假实」。"
            ),
            inputs=[
                io.Boolean.Input(
                    "value",
                    default=False,
                    label_on="开",      # 🔑 官方没填这两个参数 → 前端显示「为真实/为假实」
                    label_off="关",
                    tooltip=(
                        "【🔘 开关】往右拨 = 开 true；往左拨 = 关 false。\n"
                        "这个 widget 由前端画成滑块（本体被隐藏），这里的值就是它的存档值。\n"
                        "English: Right = true, Left = false."
                    ),
                ),
            ],
            outputs=[io.Boolean.Output()],
        )

    @classmethod
    def execute(cls, value: bool) -> io.NodeOutput:
        return io.NodeOutput(bool(value))


class XHBooleanSwitch(io.ComfyNode):
    """🔀XH-切换：官方「切换 BETA」的家族版。开关为开走 on_true，为关走 on_false。"""

    @classmethod
    def define_schema(cls):
        # MatchType 模板：绑在 on_false / on_true / output 三个口上 ⇒ 接什么类型，输出就是什么类型
        # （跟官方 SwitchNode 完全同一套写法）
        template = io.MatchType.Template("switch")
        return io.Schema(
            node_id="XHBooleanSwitch",
            display_name="🔀XH-切换",
            category="🔁XH/工具",
            search_aliases=["switch", "if", "else", "branch", "conditional", "切换", "分支"],
            description=(
                "【🔀XH-切换】官方「切换 BETA」（ComfySwitchNode）的家族版，接口一致：\n"
                "开关拨到 **开** → 输出 on_true 那一路；拨到 **关** → 输出 on_false 那一路。\n"
                "接 IMAGE 就出 IMAGE、接 MASK 就出 MASK（类型跟着输入走）。\n"
                "只比官方多一条：两路都没接时给中文报错，而不是静默出 None。"
            ),
            inputs=[
                io.Boolean.Input(
                    "switch",
                    default=False,
                    label_on="开",
                    label_off="关",
                    tooltip=(
                        "【🔀 开关】往右拨=开（走「真时值 on_true」）；往左拨=关（走「假时值 on_false」）。\n"
                        "可以手动拨，也可以从别的节点（比如 布尔开关 / 比较运算）接过来。\n"
                        "English: Right/on → output on_true; Left/off → output on_false."
                    ),
                ),
                io.MatchType.Input(
                    "on_false",
                    template=template,
                    lazy=True,
                    optional=True,
                    tooltip=(
                        "【↩️ 假时值】开关为**关**时输出这一路。\n"
                        "只有需要的那一路会被计算，另一路不会被触发（照抄官方的 lazy 写法）。\n"
                        "English: Value to output when the switch is false (lazy, not computed otherwise)."
                    ),
                ),
                io.MatchType.Input(
                    "on_true",
                    template=template,
                    lazy=True,
                    optional=True,
                    tooltip=(
                        "【↪️ 真时值】开关为**开**时输出这一路。\n"
                        "English: Value to output when the switch is true (lazy, not computed otherwise)."
                    ),
                ),
            ],
            outputs=[io.MatchType.Output(template=template, display_name="output")],
        )

    @classmethod
    def check_lazy_status(cls, switch, on_false=MISSING, on_true=MISSING):
        """照抄官方：只把真正要用的那一路标记为待算（另一路连带的上游都不会跑）。"""
        if switch and on_true is None:
            return ["on_true"]
        if not switch and on_false is None:
            return ["on_false"]

    @classmethod
    def validate_inputs(cls, switch, on_false=MISSING, on_true=MISSING):
        """官方没有这一步 —— 两路都不接时官方会静默出 None。XH 版给中文报错。"""
        if on_false is MISSING and on_true is MISSING:
            return "🔀XH-切换：假时值 on_false 和 真时值 on_true 至少得接一路，不然没东西可输出。"
        return True

    @classmethod
    def execute(cls, switch, on_true=MISSING, on_false=MISSING) -> io.NodeOutput:
        selected = on_true if bool(switch) else on_false
        return io.NodeOutput(None if selected is MISSING else selected)


NODE_CLASS_MAPPINGS = {
    "XHBooleanToggle": XHBooleanToggle,
    "XHBooleanSwitch": XHBooleanSwitch,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "XHBooleanToggle": "🔘XH-布尔开关",
    "XHBooleanSwitch": "🔀XH-切换",
}
