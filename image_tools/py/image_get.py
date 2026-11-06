# 🖼️XH-图像按序取（XH 家族，2026-10-01）
#
# 配套「🖼️XH-图片列表」用的取图节点：
#   上游接 XH-图片列表 输出的 IMAGE 批次（第 1 张 → 第 1 段），
#   把循环变量 index 接到本节点的 index 口，
#   → 循环第 0 轮取第 1 张、第 1 轮取第 2 张……实现「逐段自动换图」。
#
# 为什么需要它：ComfyUI 的 IMAGE 是个批次张量 [N,H,W,3]，
#   下游采样节点只吃单张，没法直接「按段挑第几张」。本节点就是那个挑图的下标器。
#
# 关键约定（务必看）：
#   · XH 循环变量 index 是 **0-based**（第 0 轮 / 第 1 轮…）。
#     所以默认 index_from_one=False，直接把循环 index 接进来即可：第 0 轮 → 第 1 张。
#   · 想手动填序号更直观（第 1 段=1）→ 开 index_from_one=True，内部会 -1 再取。
#   · 段数 > 图数时（循环跑多了），默认 clamp=True 自动复用末张，不会崩；
#     想要「图不够就报错」就关掉 clamp。
#   · 支持负数倒数：-1 = 最后一张（在 index_from_one=False 时）。

import torch


class XHImageGetByIndex:
    """从 IMAGE 批次里按序号取出单张，配合循环变量 index 实现逐段换图。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE", {
                    "tooltip": (
                        "上游「🖼️XH-图片列表」输出的 IMAGE 批次（按上传顺序排列）。\n"
                        "本节点按 index 从中取出单张。没接图 / 空批次会给出清晰报错。"
                    ),
                }),
                "index": ("INT", {
                    "default": 0,
                    "min": -9999,
                    "max": 9999,
                    "step": 1,
                    "tooltip": (
                        "要取第几张。\n"
                        "默认 0-based：0=第1张、1=第2张……直接接 XH 循环的 index 即可。\n"
                        "开「从1开始」后：1=第1张、2=第2张……\n"
                        "支持负数：-1=倒数第1张。"
                    ),
                }),
            },
            "optional": {
                "index_from_one": ("BOOLEAN", {
                    "default": False,
                    "tooltip": (
                        "False（默认）：序号按 0 起算，直接接 XH 循环的 index（0-based）。\n"
                        "True：序号按 1 起算（1=第1张），手动填更直观时开。"
                    ),
                }),
                "clamp": ("BOOLEAN", {
                    "default": True,
                    "tooltip": (
                        "True（默认）：index 越界时自动钳到 [0, 总数-1]，多出来的段复用末张，不崩。\n"
                        "False：越界直接报错，方便发现「图不够 / 段数配错」。"
                    ),
                }),
            },
        }

    RETURN_TYPES = ("IMAGE", "INT")
    # 端口名一律英文（4B.2 红线：name 不许本地化），中文交给 web/xh_image_get.js 的 slots 字典
    RETURN_NAMES = ("IMAGE", "actual_index")
    FUNCTION = "get_by_index"
    CATEGORY = "🔁XH/Image"
    DESCRIPTION = (
        "从 IMAGE 批次里按序号取出【单张】，是「🖼️XH-图片列表」接循环逐段换图的取图下标器。\n"
        "用法：XH-图片列表 的 IMAGE → 本节点 images；XH 循环 index → 本节点 index；\n"
        "本节点 IMAGE → 循环体内的采样节点。第 0 轮取第 1 张、第 1 轮取第 2 张……\n"
        "默认 0-based（直接接循环 index）；「实际序号」口会回显这一轮实际取到第几张，方便排错。"
    )

    def get_by_index(self, images, index, index_from_one=False, clamp=True):
        if images is None:
            raise ValueError("[XH-图像按序取] 没接 IMAGE：请把「🖼️XH-图片列表」的 IMAGE 接到这里。")
        n = images.shape[0]
        if n == 0:
            raise ValueError("[XH-图像按序取] 进来的批次是空的（0 张）。")

        i = int(index)
        if index_from_one:
            i = i - 1  # 1-based → 0-based

        # 负数倒数（-1 = 最后一张）
        if i < 0:
            i = n + i

        if clamp:
            if i < 0:
                i = 0
            if i >= n:
                i = n - 1
        else:
            if i < 0 or i >= n:
                base_note = "（开了「从1开始」请检查是不是填成了 1-based 序号）" if index_from_one else ""
                raise IndexError(
                    f"[XH-图像按序取] index={index} 越界：批次只有 {n} 张，"
                    f"合法范围 0~{n - 1}。{base_note}\n"
                    "要么多传几张图，要么开 clamp 自动复用末张。"
                )

        return (images[i:i + 1], int(i))


NODE_CLASS_MAPPINGS = {"XHImageGetByIndex": XHImageGetByIndex}
NODE_DISPLAY_NAME_MAPPINGS = {"XHImageGetByIndex": "🖼️XH-图像按序取"}
