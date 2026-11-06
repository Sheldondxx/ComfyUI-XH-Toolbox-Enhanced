# 🔁XH-浮点运算（XH 家族）
#
# 对照 comfyui-easy-use 的 `easy mathFloat`（节点显示名「浮点运算」，py/nodes/logic.py L556）做的 XH 版（2026-10-13）。
# 接口**完全对齐**：同名同序的 a / b / operation 三个参数 + 一个同名的 FLOAT 输出
#   ⇒ 老工作流里把 `easy mathFloat` 换成本节点，连线一根都不用动。
#
# 🔴 与 easy 原版的**唯一行为差异（刻意的）**：
#   easy 版每步都 `round(结果, 3)` 截到 3 位小数；本节点**不取整**，直接给完整精度。
#   原因：本节点主战场是 LTX / H3 这类「时间轴对齐」的活儿，秒数被截到 3 位会引入
#   亚毫秒级偏差；浮点尾数噪声交给下游承担，对齐精度优先。
#   ⚠️ 所以本节点**不是** easy mathFloat 的逐字节等价物，只保证「接口 + 数值语义」对齐。
#
# 比 easy 原版多做的事（都不改变接口）：
#   · 除零 / 取余零**不再让整个工作流崩**（原版直接 ZeroDivisionError）：返回 0 并在控制台提示；
#   · power 的指数做了保护（负数或过大 → 返回 0 并提示），负数开分数次幂得到复数也按 0 处理，
#     避免算出天文数字把内存吃爆、或把复数丢给下游炸掉；
#   · 输入意外收到 list 时取第一个元素（宽容处理，不炸）。
#
# 🔴 min/max 必须显式写：ComfyUI 对数值输入的**默认范围是 0 ~ 2048**（不写就填不进负数、上限卡 2048）。
#    这里沿用 easy 的超大区间，保证负数与大数都能填。
#
# 🔴 输入类型必须写成多类型字符串 "FLOAT,INT,BOOLEAN"（2026-10-14 实机翻车后修正）。
#    写死 "FLOAT" 时，接上游 INT（帧率/帧数/段号常是 INT）会被后端判 `return_type_mismatch`
#    → 「无效连接」，前端「工作流总览」红叉、直接拦住不让跑。详见 INPUT_TYPES 里的注释。
#
# 家族规范：class_type 与 web/xh_mathfloat.js 里的 NODE_TYPE 必须逐字一致。

MAX_SAFE_EXP = 512
FLOAT_MIN = -999999999999.0
FLOAT_MAX = 999999999999.0


class XHMathFloat:
    """浮点运算：a 与 b 按 operation 计算，输出浮点数（不做取整）。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                # 与 easy mathFloat 同名同序
                # 🔴 类型必须是「逗号分隔字符串」多类型 "FLOAT,INT,BOOLEAN"，与官方 ComfyMathExpression
                #    的 io.MultiType([Float, Int, Boolean]) 逐字对齐。原因（2026-10-14 实机翻车坐实）：
                #    上游「帧率 / 帧数 / 段号」多半是 INT 输出（ComfyNumberConvert 的 INT 口、PrimitiveInt），
                #    而 ComfyUI 后端 validate_node_input 只做「类型集合求交」——输入写成 "FLOAT" 时
                #    {INT} ∩ {FLOAT} = ∅ ⇒ 报 return_type_mismatch「无效连接」，整个工作流被拦下不让跑。
                #    ⚠️ 别写成元组 ("FLOAT","INT")，那会被当成 COMBO 下拉控件。
                #    先例：本包 xh_utils/__init__.py 的 "FLOAT,INT,BOOLEAN"、audiosep/nodes.py 的 "INT,FLOAT"。
                "a": ("FLOAT,INT,BOOLEAN", {
                    "default": 0.0, "min": FLOAT_MIN, "max": FLOAT_MAX, "step": 0.01,
                    "tooltip": "左操作数 a。可接 FLOAT / INT（也兼容 BOOLEAN），可填负数与大数（范围比 ComfyUI 默认的 0~2048 宽得多）。",
                }),
                "b": ("FLOAT,INT,BOOLEAN", {
                    "default": 0.0, "min": FLOAT_MIN, "max": FLOAT_MAX, "step": 0.01,
                    "tooltip": (
                        "右操作数 b。可接 FLOAT / INT（也兼容 BOOLEAN）。\n"
                        "⚠️ divide / modulo 时 b=0 不会崩流程，返回 0 并在控制台提示。\n"
                        "⚠️ power 时 b 必须在 0~512 之间，超了返回 0（防算出天文数字把内存吃爆）。"
                    ),
                }),
                "operation": (["add", "subtract", "multiply", "divide", "modulo", "power"],
                              {"default": "add",
                               "tooltip": (
                                   "运算类型：\n"
                                   "· add 加   · subtract 减   · multiply 乘\n"
                                   "· divide 除（真除法，保留小数）   · modulo 取余   · power 幂\n"
                                   "✅ 全程按**浮点**算，结果**不做 3 位取整**（时间轴对齐用，精度优先）。"
                               )}),
            },
        }

    RETURN_TYPES = ("FLOAT",)
    RETURN_NAMES = ("FLOAT",)
    FUNCTION = "calc"
    CATEGORY = "🔁XH/工具"
    DESCRIPTION = (
        "【干什么】两个浮点数做四则运算 / 取余 / 幂，替代 easy-use 的 easy mathFloat。\n"
        "【怎么配】· a、b：两个浮点操作数，支持负数与大数\n"
        "· operation：add 加 / subtract 减 / multiply 乘 / divide 除 / modulo 取余 / power 幂\n"
        "【怎么用】算时长、算时间轴起点这类要小数的活儿 —— 例如「秒数 = 帧数 ÷ 帧率」就靠它。\n"
        "⚠️ 只有**一个** FLOAT 输出口，不存在「一口三输出、接错口径被截断」的问题。\n"
        "⚠️ 与 easy mathFloat 的唯一区别：**不做 3 位取整**，保留完整精度（时间轴对齐优先）。\n"
        "⚠️ 除零、取余零、非法指数都**不会**让流程崩 —— 返回 0 并在控制台说明原因。"
    )

    @staticmethod
    def _one(v):
        """宽容处理：意外收到 list 就取第一个。"""
        if isinstance(v, (list, tuple)):
            return v[0] if len(v) else 0
        return v

    def calc(self, a, b, operation):
        a = float(self._one(a))
        b = float(self._one(b))

        if operation == "add":
            result = a + b
        elif operation == "subtract":
            result = a - b
        elif operation == "multiply":
            result = a * b
        elif operation == "divide":
            if b == 0:
                print(f"[XH-浮点运算] 除数为 0（a={a}），已按 0 处理，不中断流程")
                result = 0.0
            else:
                result = a / b
        elif operation == "modulo":
            if b == 0:
                print(f"[XH-浮点运算] 取余的除数为 0（a={a}），已按 0 处理，不中断流程")
                result = 0.0
            else:
                result = a % b
        elif operation == "power":
            if b < 0 or b > MAX_SAFE_EXP:
                print(f"[XH-浮点运算] 指数 {b} 超出安全范围 0~{MAX_SAFE_EXP}，已按 0 处理（防卡死）")
                result = 0.0
            else:
                try:
                    result = a ** b
                    # 负数开分数次幂会得到复数，float() 会崩 ⇒ 提前拦掉
                    if isinstance(result, complex):
                        raise ValueError("负数开分数次幂会得到复数")
                except Exception as e:
                    print(f"[XH-浮点运算] 幂运算 {a}**{b} 失败（{e}），已按 0 处理")
                    result = 0.0
        else:
            raise ValueError(f"[XH-浮点运算] 不认识的操作: {operation}")

        return (float(result),)


NODE_CLASS_MAPPINGS = {"XHMathFloat": XHMathFloat}
NODE_DISPLAY_NAME_MAPPINGS = {"XHMathFloat": "🔁XH-浮点运算"}
