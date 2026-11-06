# 🔁XH-整数运算（XH 家族）
#
# 对照 comfyui-easy-use 的 `easy mathInt`（节点显示名「整数运算」）做的 XH 版（2026-09-30）。
# 接口**完全对齐**：同名同序的 a / b / operation 三个参数 + 一个同名的 INT 输出
#   ⇒ 老工作流里把 `easy mathInt` 换成本节点，连线一根都不用动。
#
# 比 easy 原版多做的事（都不改变接口）：
#   · 除零 / 取余零**不再让整个工作流崩**（原版直接 ZeroDivisionError）：返回 0 并在控制台提示；
#   · power 的指数做了保护（负数或过大 → 返回 0 并提示），避免算出天文数字把内存吃爆；
#   · 输入意外收到 list 时取第一个元素（宽容处理，不炸）。
#
# 🔴 min/max 必须显式写：ComfyUI 对数值输入的**默认范围是 0 ~ 2048**（不写就填不进负数、上限卡 2048）。
#    这里沿用 easy/WAS 的超大区间，保证负数与大数都能填。
#
# 家族规范：class_type 与 web/xh_mathint.js 里的 NODE_TYPE 必须逐字一致。

MAX_SAFE_EXP = 512


class XHMathInt:
    """整数运算：a 与 b 按 operation 计算，输出整数。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                # 与 easy mathInt 同名同序
                "a": ("INT", {
                    "default": 0, "min": -0xFFFFFFFFFFFFFFFF,
                    "max": 0xFFFFFFFFFFFFFFFF, "step": 1,
                    "tooltip": "左操作数 a。可以填负数和大数（范围比 ComfyUI 默认的 0~2048 宽得多）。",
                }),
                "b": ("INT", {
                    "default": 0, "min": -0xFFFFFFFFFFFFFFFF,
                    "max": 0xFFFFFFFFFFFFFFFF, "step": 1,
                    "tooltip": (
                        "右操作数 b。\n"
                        "⚠️ divide / modulo 时 b=0 不会崩流程，返回 0 并在控制台提示；\n"
                        "⚠️ power 时 b 必须在 0~512 之间，超了返回 0（防算出天文数字把内存吃爆）。"
                    ),
                }),
                "operation": (["add", "subtract", "multiply", "divide", "modulo", "power"],
                              {"default": "add",
                               "tooltip": (
                                   "运算类型：\n"
                                   "· add 加  · subtract 减  · multiply 乘\n"
                                   "· divide 整除（结果取整数部分）  · modulo 取余  · power 幂\n"
                                   "⚠️ 全程按**整数**算，小数会被截断，不是四舍五入。"
                               )}),
            },
        }

    RETURN_TYPES = ("INT",)
    RETURN_NAMES = ("INT",)
    FUNCTION = "calc"
    CATEGORY = "🔁XH/工具"
    DESCRIPTION = (
        "【干什么】两个整数做四则运算 / 取余 / 幂，替代 easy-use 的 easy mathInt。\n"
        "【怎么配】· a、b：两个整数操作数，支持负数与大数\n"
        "· operation：add 加 / subtract 减 / multiply 乘 / divide 整除 / modulo 取余 / power 幂\n"
        "【怎么用】算循环轮数、算帧数索引、算 batch 大小这类纯整数的活儿。"
        "参数顺序与 easy mathInt 完全一致，老工作流换节点不用重接线。\n"
        "【输出】INT：运算结果。\n"
        "⚠️ 一切结果都是整数，不会出现小数。\n"
        "⚠️ 除零、取余零、非法指数都**不会**让流程崩 —— 返回 0 并在控制台说明原因。"
    )

    @staticmethod
    def _one(v):
        """宽容处理：意外收到 list 就取第一个。"""
        if isinstance(v, (list, tuple)):
            return v[0] if len(v) else 0
        return v

    def calc(self, a, b, operation):
        a = int(self._one(a))
        b = int(self._one(b))

        if operation == "add":
            result = a + b
        elif operation == "subtract":
            result = a - b
        elif operation == "multiply":
            result = a * b
        elif operation == "divide":
            if b == 0:
                print(f"[XH-整数运算] 除数为 0（a={a}），已按 0 处理，不中断流程")
                result = 0
            else:
                result = a // b          # 整除，与 easy 版一致
        elif operation == "modulo":
            if b == 0:
                print(f"[XH-整数运算] 取余的除数为 0（a={a}），已按 0 处理，不中断流程")
                result = 0
            else:
                result = a % b
        elif operation == "power":
            if b < 0 or b > MAX_SAFE_EXP:
                print(f"[XH-整数运算] 指数 {b} 超出安全范围 0~{MAX_SAFE_EXP}，已按 0 处理（防卡死）")
                result = 0
            else:
                result = a ** b
        else:
            raise ValueError(f"[XH-整数运算] 不认识的操作: {operation}")

        return (int(result),)


NODE_CLASS_MAPPINGS = {"XHMathInt": XHMathInt}
NODE_DISPLAY_NAME_MAPPINGS = {"XHMathInt": "🔁XH-整数运算"}
