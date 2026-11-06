# XH-滑块 —— Nodes 2.0 原生的 Slider 节点（替代 mxToolkit 的 mxSlider）
# 数据走单个标准 STRING widget（slider_json），UI 走单个 addDOMWidget（serialize:false）。
# 全程不碰 node.widgets 数组的增删/排序，不 canvas 手画 —— Nodes 2.0 Vue 渲染下唯一稳的做法。
import json

# 分类遵循 XH 家族规范：🔁XH/<类别>（见 xh_style.md 第二节）
CATEGORY_TYPE = "🔁XH/Control"
NODE_CLASS_NAME = "XHSlider"
DISPLAY_NAME = "🔁XH-滑块"
DISPLAY_NAME_EN = "🔁XH-Slider"

DEFAULT_JSON = '{"value":20,"min":0,"max":100,"step":1,"decimals":0}'


class XHSlider:
    """滑块：前端 DOM UI 编辑 min/max/step/decimals/value，后端按 decimals 输出 INT 或 FLOAT。"""

    NAME = NODE_CLASS_NAME
    CATEGORY = CATEGORY_TYPE
    OUTPUT_NODE = False
    DESCRIPTION = (
        "【干什么】一根可调参数的滑块：拖动即改，输出 INT 或 FLOAT 随便往任何数值口上插，"
        "省得每次改参数都要点开好几个节点。\n"
        "【怎么配】节点界面上设 最小值 / 最大值 / 步长 / 小数位 / 当前值；"
        "小数位 decimals = 0 时输出 INT，>0 时输出 FLOAT。\n"
        "【怎么用】把它的输出口接到任何你要来回试的数值参数上（步数、CFG、强度、帧数都行），"
        "然后直接在滑块上拖。\n"
        "【输出】X（任意类型 *）：既能插 INT 口也能插 FLOAT 口。\n"
        "⚠️ 输出类型是 `*`（any-type）——**下游节点把它当什么类型，它就是什么类型**，"
        "所以接到齿轮控件上不会报类型不匹配。\n"
        "⚠️ 真正的配置存在 slider_json 里随工作流存档；它本身你应该当成界面的一部分，"
        "一般不手动编辑。"
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                # 唯一的数据载体：标准 STRING widget，进存档 + 进 prompt，序列化天然无错位
                "slider_json": (
                    "STRING",
                    {
                        "default": DEFAULT_JSON, "multiline": False, "advanced": True,
                        "tooltip": (
                            "滑块配置（JSON），由节点上的界面自动生成，**通常不用手动编辑**。\n"
                            "字段：`{\"value\":20,\"min\":0,\"max\":100,\"step\":1,\"decimals\":0}`\n"
                            "· decimals = 0 → 输出 INT；> 0 → 输出 FLOAT\n"
                            "⚠️ 手改写坏了会按默认值处理，并在控制台提示。"
                        ),
                    },
                ),
            },
        }

    RETURN_TYPES = ("*",)  # any-type：既能接 INT 也能接 FLOAT（同 mxToolkit 的 AnyType 套路）
    RETURN_NAMES = ("X",)
    FUNCTION = "main"

    def main(self, slider_json=DEFAULT_JSON):
        cfg = {}
        try:
            cfg = json.loads(slider_json or "{}")
        except Exception:
            print("[XH-滑块] slider_json 不是合法 JSON，按默认值处理")
            cfg = {}
        if not isinstance(cfg, dict):
            cfg = {}

        def _num(key, default):
            try:
                v = float(cfg.get(key, default))
            except (TypeError, ValueError):
                return float(default)
            if v != v:  # NaN
                return float(default)
            return v

        value = _num("value", 20.0)
        lo = _num("min", 0.0)
        hi = _num("max", 100.0)
        if lo > hi:
            lo, hi = hi, lo
        if value < lo:
            value = lo
        if value > hi:
            value = hi
        try:
            decimals = int(float(cfg.get("decimals", 0)))
        except (TypeError, ValueError):
            decimals = 0
        decimals = max(0, min(4, decimals))

        if decimals > 0:
            p = 10 ** decimals
            return (round(value * p) / p,)
        # 整数模式：与 mxSlider 一致输出 floor
        return (int(value // 1),)
