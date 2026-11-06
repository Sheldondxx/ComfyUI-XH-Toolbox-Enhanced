# 🖼️XH-取帧范围（XH 家族）
#
# 对照 comfyui-kjnodes 的 `GetImageRangeFromBatch`（显示名 Get Image or Mask Range From Batch，
# `custom_nodes/comfyui-kjnodes/nodes/image_nodes.py:1968`）做的 XH 版（2026-09-30）。
#
# 用途：从一个 IMAGE / MASK **批次**里取一段连续的帧。
#   · 长视频续接里最常用的是「取上一段的**尾帧**」 ⇒ start_index = -1、num_frames = 1
#   · 取开头几帧做首帧锚定               ⇒ start_index = 0、num_frames = 5
#
# 接口与 KJ 版**对齐**（同名同序 start_index / num_frames + 同名 images / masks + 同名 IMAGE / MASK 输出）
#   ⇒ 老工作流把 KJ 节点换成本节点，连线一根都不用动；widgets 只多一个 clamp（追加在最后，默认 False）。
#
# 比 KJ 原版多做的事
#   · **负数更灵活**：-1 仍是「末尾 num_frames 帧」（保留原语义），
#     而 -2 / -3 … 变成「倒数第 2 / 3 帧起」（KJ 版只认 -1，其它负数直接报错）；
#   · **越界报错写清楚**：告诉你有多少帧、你要的是哪一段（原版只丢一句 "Start index is out of range"）；
#   · **clamp 开关**：越界时自动钳到最近的有效起点，而不是把整条流程打断；
#   · **两个输入都没接时明确报错**（原版静默返回 None，下游拿到 None 才炸，很难查）。
#
# 🔴 铁律：INT 必须显式写 min/max（不写默认 0~2048，负数填不进去 —— 这个节点靠负数工作，必踩）。


class XHImageRangeFromBatch:
    """从 IMAGE / MASK 批次里取一段连续帧。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                # 与 KJ 版前两个参数同名同序 ⇒ 换节点不用重接线
                "start_index": ("INT", {
                    "default": 0, "min": -4096, "max": 4096, "step": 1,
                    "tooltip": (
                        "从第几帧开始切。\n"
                        "· 0（默认）= 批次第 1 帧\n"
                        "· 正数 = 正着数的第 N 帧（下标从 0 开始）\n"
                        "· -1 = 末尾「取几帧」帧（和 KJ 原版语义一致，最常用：取上一段尾帧就填 -1）\n"
                        "· -2 / -3 … = 倒数第 2 / 3 帧起（这是 XH 版比原版多出来的）\n"
                        "⚠️ 越界（超过总帧数）默认报错；想自动贴到最近的有效起点就打开「越界自动钳制」。"
                    ),
                }),
                "num_frames": ("INT", {
                    "default": 1, "min": 1, "max": 4096, "step": 1,
                    "tooltip": (
                        "要连续取几帧。默认 1（只要起始帧那一帧）。\n"
                        "剩余帧数不够时**不会报错**，按实际还能取的帧数返回，控制台会打印提示。\n"
                        "⚠️ 起点用 -1 时它同时决定「从末尾倒着数几帧」，不是「从倒数第一帧往后取几帧」。"
                    ),
                }),
                # XH 追加：越界时自动钳制（默认 False = 与 KJ 版行为一致，直接报错）
                "clamp": ("BOOLEAN", {
                    "default": False,
                    "tooltip": (
                        "越界时的处理方式：\n"
                        "· 关（默认）= 直接报错，并把总帧数、合法起点范围都告诉你（与原版行为一致）\n"
                        "· 开 = 自动钳到最近的有效起点，流程不中断\n"
                        "⚠️ 开着跑批处理很省心，但会掩盖「你算错帧数」这件事，调试阶段建议关。"
                    ),
                }),
            },
            "optional": {
                "images": ("IMAGE", {
                    "tooltip": "图像批次输入端。和 masks **至少要接一个**，两个都不接会直接报错。",
                }),
                "masks": ("MASK", {
                    "tooltip": "蒙版批次输入端，切法与 images 完全相同。两个都不接会直接报错。",
                }),
            },
        }

    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("IMAGE", "MASK")
    FUNCTION = "get_range"
    CATEGORY = "🔁XH/Image"
    DESCRIPTION = (
        "从 IMAGE / MASK 批次里取一段连续帧（取上一段尾帧：起始帧=-1、取几帧=1）。"
        "起始帧 -1 = 末尾「取几帧」帧；-2/-3… = 倒数第 2/3 帧起。"
    )

    @staticmethod
    def _slice(data, kind, start_index, num_frames, clamp):
        n = int(data.shape[0])
        start = int(start_index)

        if start == -1:
            # 原版语义：-1 = 从末尾倒着取 num_frames 帧
            start = max(0, n - int(num_frames))
        elif start < 0:
            # XH 追加：其它负数按 Python 语义 = 倒数第 |start| 帧
            start = n + start

        if start < 0 or start >= n:
            if not clamp:
                raise ValueError(
                    "[XH-取帧范围] %s 一共只有 %d 帧，起点 %d 越界 —— "
                    "合法起点是 0 ~ %d，或 -1（末尾「取几帧」帧）、或负数倒数。"
                    "想让它自动钳到最近的有效起点，把「越界自动钳制」打开。"
                    % (kind, n, int(start_index), n - 1)
                )
            fixed = 0 if start < 0 else n - 1
            print("[XH-取帧范围] %s 起点 %d 越界（共 %d 帧），已自动钳到 %d"
                  % (kind, int(start_index), n, fixed))
            start = fixed

        end = min(start + int(num_frames), n)
        chosen = data[start:end]
        if chosen.shape[0] < int(num_frames):
            print("[XH-取帧范围] %s 从第 %d 帧起只剩 %d 帧（要 %d 帧），已按实际帧数返回"
                  % (kind, start, chosen.shape[0], int(num_frames)))
        return chosen

    def get_range(self, start_index, num_frames, clamp=False, images=None, masks=None):
        if images is None and masks is None:
            raise ValueError(
                "[XH-取帧范围] images 和 masks 都没接 —— 至少要接一个，否则这个节点没有任何输入可切"
            )

        out_images = out_masks = None
        if images is not None:
            out_images = self._slice(images, "images", start_index, num_frames, clamp)
        if masks is not None:
            out_masks = self._slice(masks, "masks", start_index, num_frames, clamp)
        return (out_images, out_masks)


NODE_CLASS_MAPPINGS = {"XHImageRangeFromBatch": XHImageRangeFromBatch}
NODE_DISPLAY_NAME_MAPPINGS = {"XHImageRangeFromBatch": "🖼️XH-取帧范围"}
