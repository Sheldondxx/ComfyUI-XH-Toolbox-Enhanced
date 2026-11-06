# XH 数字计数器
# 对照 WAS Node Suite 的 Number Counter 做的 XH 版（2026-09-30）。
# 接口与 WAS 版完全对齐（widget 顺序 / 输出槽 / 五种模式全保留），
# 老工作流里把 Number Counter 换成本节点后连线不用重排。
#
# 修复了 WAS 原版两个 bug：
#   1. WAS 把 decrement 模式拼成 'deccrement'，导致递减模式永远不生效（数值不动）；
#   2. WAS 判断整数模式时误写成 mode == 'integer'（应为 number_type），
#      导致 integer 模式下起始值没取整。
#
# 计数状态按节点实例（unique_id）存在内存字典里，每次执行 +step/-step。
# IS_CHANGED 返回 NaN 强制每次队列都重跑（计数器必须每次执行，否则缓存会卡住不计数）。


class XHNumberCounter:
    def __init__(self):
        self.counters = {}

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "number_type": (["integer", "float"], {
                    "default": "integer",
                    "tooltip": (
                        "输出整数还是浮点。\n"
                        "· integer：起始值先取整，之后每轮 ±step 再取整\n"
                        "· float：保留小数\n"
                        "⚠️ 这一项同时决定 int 口的输出质量。"
                    ),
                }),
                "mode": (["increment", "decrement", "increment_to_stop",
                          "decrement_to_stop", "reset_after_stop"], {
                    "default": "increment",
                    "tooltip": (
                        "· increment：每跑一次 +step（无上限）\n"
                        "· decrement：每跑一次 -step（无下限）\n"
                        "· increment_to_stop：加到 stop 就停在那儿\n"
                        "· decrement_to_stop：减到 stop 就停在那儿\n"
                        "· reset_after_stop：到 stop 之后回到 start 重新开始\n"
                        "⚠️ 计数状态存在**内存里**，重启 ComfyUI 会从头再来。"
                    ),
                }),
                # ⚠️ min/max 必须显式写：ComfyUI 对 FLOAT 的**默认**范围是 0 ~ 2048，
                #    不写就会变成「不能填负数 + 最多 2048」（2026-09-30 用户踩到，已修）。
                #    这里沿用 WAS 原版的超大区间，保证老工作流换节点时数值不被夹紧。
                "start": ("FLOAT", {
                    "default": 0, "min": -18446744073709551615,
                    "max": 18446744073709551615, "step": 0.01,
                    "tooltip": "起始值。integer 模式下会先向下取整。",
                }),
                "stop": ("FLOAT", {
                    "default": 0, "min": -18446744073709551615,
                    "max": 18446744073709551615, "step": 0.01,
                    "tooltip": (
                        "终止值。\n"
                        "⚠️ 只有 *_to_stop / reset_after_stop 这几种模式会看它，"
                        "纯 increment / decrement 模式**永远停不下来**。"
                    ),
                }),
                "step": ("FLOAT", {
                    "default": 1, "min": 0, "max": 99999, "step": 0.01,
                    "tooltip": (
                        "每执行一次累加/累减多少。默认 1。\n"
                        "⚠️ 填 0 数值就不动了；填负数会让「递增」变成反向。"
                    ),
                }),
            },
            "optional": {
                "reset_bool": ("NUMBER", {
                    "tooltip": (
                        "接一个数字进来，**非零就把计数器归位到 start**。\n"
                        "通常接循环首轮的标志位，让每次开跑都从同一个数开始。"
                    ),
                }),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("NaN")

    RETURN_TYPES = ("NUMBER", "FLOAT", "INT")
    RETURN_NAMES = ("number", "float", "int")
    FUNCTION = "count"
    CATEGORY = "🔁XH/工具"
    DESCRIPTION = (
        "【干什么】一个带状态的计数器：每执行一次就按步长 +1（或 -1），并把当前值输出出去。"
        "替代 WAS Node Suite 的 Number Counter。\n"
        "【怎么配】· number_type：integer 整数 / float 浮点\n"
        "· mode：increment 递增 / decrement 递减 / increment_to_stop 递增到 stop 停 / "
        "decrement_to_stop 递减到 stop 停 / reset_after_stop 到 stop 后重置\n"
        "· start / stop / step：起始值、终止值、步长\n"
        "· reset_bool（可选）：非 0 时归位到 start\n"
        "【怎么用】给工作流提供「第几张 / 第几遍 / 第几轮」这类自增编号，"
        "典型搭配：接文件名前缀做自动编号、接取图节点做逐轮换图。\n"
        "【输出】number（NUMBER）、float（FLOAT）、int（INT）—— 同一个值的三种类型，随便挑一个接。\n"
        "⚠️ 状态存在内存里，按节点实例区分：**重启 ComfyUI 或换一个新放的节点都会从头计数**。\n"
        "⚠️ 内部 IS_CHANGED 返回 NaN，强制每次排队都真跑；"
        "所以「重复执行同一张图」它会继续往上加，不会停。"
    )

    def count(self, number_type, mode, start, stop, step, unique_id, reset_bool=0):
        # 起始值按输出类型取整（修 WAS 的 number_type/mode 写反 bug）
        counter = int(start) if number_type == "integer" else start
        if unique_id in self.counters:
            counter = self.counters[unique_id]

        # reset_bool 非零 → 归零回 start
        if round(reset_bool) >= 1:
            counter = start

        if mode == "increment":
            counter += step
        elif mode == "decrement":
            counter -= step
        elif mode == "increment_to_stop":
            counter = counter + step if counter < stop else counter
        elif mode == "decrement_to_stop":
            counter = counter - step if counter > stop else counter
        elif mode == "reset_after_stop":
            counter = counter + step if counter < stop else start + step

        self.counters[unique_id] = counter

        result = int(counter) if number_type == "integer" else float(counter)
        return (result, float(counter), int(counter))


NODE_CLASS_MAPPINGS = {"XHNumberCounter": XHNumberCounter}
NODE_DISPLAY_NAME_MAPPINGS = {"XHNumberCounter": "🔁XH-数字计数器"}
