# 🔁XH-计算器（XH 家族）
#
# 2026-10-18 新增（XH 原创）：节点上直接嵌一个真·计算器键盘（顶部显示屏 + 下方数字/运算符键盘），
# 像实体小键盘那样按按钮算，点 = 出结果，结果作为 FLOAT 输出给下游数值口用。
#
# 设计要点（照 XH-Slider / XH-浮点运算 的家族规范）：
#   · 唯一的数据载体是标准 STRING widget（calc_state，存 {expr, result} JSON），前端 UI 写、后端执行读，存档天然无错位；
#   · 后端也做一次「白名单安全求值」，所以即使前端 DOM 没加载（命令行/API 跑工作流）也能算出结果；
#   · class_type（XHCalculator）必须与 web/xh_calculator.js 里的 NODE_TYPE 逐字一致，否则渲染成空白壳。

import json
import re

CATEGORY_TYPE = "🔁XH/工具"
NODE_CLASS_NAME = "XHCalculator"
DISPLAY_NAME = "🔁XH-计算器"
DISPLAY_NAME_EN = "🔁XH-Calculator"

DEFAULT_STATE = '{"expr":"","result":0}'

# 安全求值：只允许数字、小数点、括号、四则运算符、百分号、科学计数法 e/E 与空白；
# 字母除 e/E 外一律剔除后求值
# 🔴 2026-10-21 修：放行 e/E —— 前端 fmt 对极大/极小结果会输出科学计数法（如 1e+21），
#    老白名单把 e 毙掉 ⇒ 前端显示屏有结果、后端 result 口却给 0，两口不一致。
_SAFE_CHARS = re.compile(r"^[0-9.()+\-*/% eE]+$")


def safe_eval(expr: str):
    """白名单算术求值，失败返回 None。支持 + - * / % ( ) 与隐式小数。"""
    if expr is None:
        return None
    s = str(expr).strip()
    if not s:
        return None
    # × ÷ 是界面按钮符号，统一转成 * /
    s = s.replace("×", "*").replace("÷", "/")
    # 🔴 2026-10-21 修：键盘「−」键是 U+2212（排版用真减号），不是 ASCII "-"。
    #    老代码只转 × ÷ ⇒ 任何含减号的算式（如 5−3）白名单不匹配直接返回 None，
    #    表现为「按等号就报错误」。± 键产生的负号是 ASCII，所以时好时坏。
    s = s.replace("−", "-")
    # % 在计算器语境里通常是「除以 100」，例如 50% → 0.5
    s = s.replace("%", "/100")
    if not _SAFE_CHARS.match(s):
        return None
    try:
        # 用 Function 构造，不暴露任何内建，纯算术求值
        val = eval(compile(f"({s})", "<calc>", "eval"), {"__builtins__": {}}, {})
    except Exception:
        return None
    if not isinstance(val, (int, float)) or isinstance(val, bool):
        return None
    if val != val or val in (float("inf"), float("-inf")):  # NaN / Inf
        return None
    return float(val)


class XHCalculator:
    """计算器：前端键盘拼表达式，点 = 求值；后端兜底安全求值。输出 FLOAT 结果 + STRING 表达式。"""

    NAME = NODE_CLASS_NAME
    CATEGORY = CATEGORY_TYPE
    OUTPUT_NODE = False
    DESCRIPTION = (
        "【干什么】节点上直接放一个真·计算器键盘（顶部显示屏 + 下方数字/运算符键），像手机/实体小键盘那样按按钮算，"
        "点 = 出结果，结果作为数字输出给下游任何数值口（步数 / 帧率 / CFG / 强度都行）。\n"
        "【怎么用】上方显示屏实时显示你按的内容；下方键盘 0~9 . + − × ÷ = C（清除）⏎（退格）± % 随便按；"
        "点 = 即算，结果进 result 口、原始式子进 expression 口。\n"
        "【输出】result（FLOAT，任意类型 *，可插 INT/FLOAT 口）· expression（STRING，方便打印/核对）。\n"
        "⚠️ 配置存在 calc_state（JSON）里随工作流存档；它一般当界面的一部分，不用手改。\n"
        "⚠️ 后端对输入做了白名单安全求值（只认数字和 + − × ÷ % 与括号），不会执行任何代码，可放心用。"
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "calc_state": (
                    "STRING",
                    {
                        "default": DEFAULT_STATE, "multiline": False, "advanced": True,
                        "tooltip": (
                            "计算器状态（JSON），由节点上的键盘界面自动生成，**通常不用手动编辑**。\n"
                            "字段：`{\"expr\":\"1+2*3\",\"result\":7}`\n"
                            "· expr 是算式 · result 是点 = 后的结果\n"
                            "⚠️ 手改写坏了会按空算式（结果 0）处理，并在控制台提示。"
                        ),
                    },
                ),
            },
        }

    RETURN_TYPES = ("FLOAT", "STRING")
    RETURN_NAMES = ("result", "expression")
    FUNCTION = "calc"

    def calc(self, calc_state=DEFAULT_STATE):
        state = {}
        try:
            state = json.loads(calc_state or "{}")
        except Exception:
            print("[XH-计算器] calc_state 不是合法 JSON，按空算式处理")
            state = {}
        if not isinstance(state, dict):
            state = {}

        expr = state.get("expr", "")
        if not isinstance(expr, str):
            expr = str(expr)

        val = safe_eval(expr)
        if val is None:
            # 空算式或非法 → 结果 0，expression 给空串
            return (0.0, "")
        return (float(val), expr)


# ---- 家族标准导出（缺这个 __init__ 的 from .calculator import 会 ImportError，整包崩）----
NODE_CLASS_MAPPINGS = {
    NODE_CLASS_NAME: XHCalculator,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    NODE_CLASS_NAME: DISPLAY_NAME,
}
