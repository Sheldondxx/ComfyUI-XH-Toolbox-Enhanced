"""
🖼️ XH-图像遮罩缩放（XHImageMaskScale）—— V3 版（io.ComfyNode + MatchType）

2026-10-08 重写：对齐官方 `ResizeImageMaskNode`
（源码：comfy_extras/nodes_post_processing.py:417）。

── 为什么现在是「1 进 1 出」 ────────────────────────────────
官方用「类型联动端口」：
    io.MatchType.Template("input_type", [io.Image, io.Mask])
    io.MatchType.Input("input",  template=template)   # 一个口，接什么就是什么类型
    io.MatchType.Output(template=template)            # 输出类型自动跟着输入变
上一版做成了 image / mask 两个输入口 + width/height/info 三个额外输出口，
端口比官方多、节点又高又乱，已按用户要求改回官方形态。
术语备忘：MatchType = 联动；MultiType = 只接多种类型但不联动；`*` = 通配符（老 API）。

── 内部实现与官方逐条一致 ──────────────────────────────────
  · `len(shape)==4` → IMAGE（[B,H,W,C]）；3 维 → MASK（[B,H,W]）
  · IMAGE ↔ [B,C,H,W] 用 movedim；MASK ↔ [B,C,H,W] 用 unsqueeze / squeeze
  · 缩放走 `comfy.utils.common_upscale`（GPU 原生），不再是 PIL
  · 短边 / 长边 / 宽 / 高 四种等比算法照抄官方
    scale_shorter_dimension / scale_longer_dimension / scale_dimensions

── 比官方多一项 ────────────────────────────────────────────
  · `divisible_by`：把算出来的宽高向下取整到 N 的倍数（喂视频模型常用 32/64）。
    官方对应的是 DynamicCombo 里的 `SCALE_TO_MULTIPLE` 模式，但那个是
    「缩放 + 居中裁切」，本版只取整、不裁切。
"""
import comfy.utils
from comfy_api.latest import io
from nodes import MAX_RESOLUTION


class XHImageMaskScale(io.ComfyNode):
    resize_modes = ["shorter_dimension", "longer_dimension", "width", "height"]
    scale_methods = ["lanczos", "nearest-exact", "bilinear", "bicubic", "area"]

    @classmethod
    def define_schema(cls):
        # ★ 类型联动模板：同一个模板绑在输入口和输出口上，输出类型跟着输入走
        template = io.MatchType.Template("input_type", [io.Image, io.Mask])
        return io.Schema(
            node_id="XHImageMaskScale",
            display_name="🖼️XH-图像遮罩缩放",
            description=(
                "【🖼️ 图像遮罩缩放】按短边 / 长边 / 宽度 / 高度 等比缩放图像或蒙版。\n"
                "输入口是 MatchType：接 IMAGE 就是 IMAGE，接 MASK 就是 MASK，输出自动跟着变。\n"
                "不裁切、不补边，只做纯等比缩放。"
            ),
            category="🔁XH/Image",
            inputs=[
                io.MatchType.Input(
                    "input",
                    template=template,
                    tooltip="【🖼️ 输入】图像或蒙版都行，输出类型自动跟着变。 | English: image or mask",
                ),
                io.Combo.Input(
                    "resize_mode",
                    options=cls.resize_modes,
                    default="shorter_dimension",
                    tooltip=(
                        "【📐 调整类型】按哪条边定目标尺寸，另一边自动等比：\n"
                        "· shorter_dimension：短边 = 目标尺寸\n"
                        "· longer_dimension：长边 = 目标尺寸\n"
                        "· width：宽度 = 目标尺寸\n"
                        "· height：高度 = 目标尺寸"
                    ),
                ),
                io.Int.Input(
                    "size",
                    default=544,
                    min=1,
                    max=MAX_RESOLUTION,
                    step=1,
                    tooltip="【📏 目标尺寸】像素值，含义由「调整类型」决定。 | English: target size in pixels",
                ),
                io.Combo.Input(
                    "interpolation",
                    options=cls.scale_methods,
                    default="lanczos",
                    tooltip=(
                        "【🔍 缩放方法】\n"
                        "· lanczos：最锐利（放大好）\n"
                        "· nearest-exact：最近邻，硬边缘蒙版 / 像素画\n"
                        "· bilinear：双线性，快且平滑\n"
                        "· bicubic：双三次\n"
                        "· area：区域平均（缩小最平滑）"
                    ),
                ),
                io.Int.Input(
                    "divisible_by",
                    default=1,
                    min=1,
                    max=512,
                    step=1,
                    tooltip="【➗ 整除对齐】输出宽高向下取整到它的倍数。喂视频模型建议 32/64。 | English: round down to multiple of",
                ),
            ],
            outputs=[io.MatchType.Output(template=template, display_name="resized")],
        )

    @classmethod
    def execute(cls, input, resize_mode, size, interpolation, divisible_by=1) -> io.NodeOutput:
        # IMAGE [B,H,W,C] 是 4 维；MASK [B,H,W] 是 3 维 —— 官方 is_image() 的判据
        is_type_image = len(input.shape) == 4

        # 统一成 [B, C, H, W] 再交给 common_upscale
        x = input.movedim(-1, 1) if is_type_image else input.unsqueeze(1)

        width = x.shape[-1]
        height = x.shape[-2]

        # ── 以下四种等比算法逐条照抄官方 ──────────────────────────
        if resize_mode == "shorter_dimension":            # ← scale_shorter_dimension
            if height < width:
                width = round((width / height) * size)
                height = size
            elif width < height:
                height = round((height / width) * size)
                width = size
            else:
                height = width = size
        elif resize_mode == "longer_dimension":           # ← scale_longer_dimension
            if height > width:
                width = round((width / height) * size)
                height = size
            elif width > height:
                height = round((height / width) * size)
                width = size
            else:
                height = width = size
        elif resize_mode == "width":                      # ← scale_dimensions(w, 0)
            height = max(1, round(height * size / width))
            width = size
        elif resize_mode == "height":                     # ← scale_dimensions(0, h)
            width = max(1, round(width * size / height))
            height = size

        width = max(1, width)
        height = max(1, height)

        # 官方没有、本节点独有：向下取整到 divisible_by 的倍数
        if divisible_by and divisible_by > 1:
            width = max(divisible_by, width - (width % divisible_by))
            height = max(divisible_by, height - (height % divisible_by))

        out = comfy.utils.common_upscale(x, width, height, interpolation, "disabled")

        # 还原成输入时的形状：IMAGE → [B,H,W,C]；MASK → [B,H,W]
        out = out.movedim(1, -1) if is_type_image else out.squeeze(1)
        return io.NodeOutput(out)


NODE_CLASS_MAPPINGS = {"XHImageMaskScale": XHImageMaskScale}
NODE_DISPLAY_NAME_MAPPINGS = {"XHImageMaskScale": "🖼️XH-图像遮罩缩放"}
