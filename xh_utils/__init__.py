# 🔁XH-工具扩展（XH 家族）
#
# 2026-10-04 新增，用于替换工作流里几个第三方工具节点（KJ / LTX 官方保留不动）：
#   XHMathExpression   ← ComfyMath 的 ComfyMathExpression（表达式求值，变量 a/b/c）
#   XHNumberConvert    ← ComfyMath 的 ComfyNumberConvert（数值类型转换）
#   XHSamplerSelect    ← easy-use 的 KSamplerSelect（按名选采样器 → SAMPLER 对象）
#   XHSolidMask       ← easy-use 的 SolidMask（实心遮罩）
#   XHVAEDecodeTiled   ← Apt_Preset 的 VAEDecodeTiled（平铺 VAE 解码 → IMAGE）
#
# 设计为「即插即换」：接口严格对齐被替节点，工作流里只需把 type 改掉，连线/控件零改动。
#   · XHMathExpression：输入名保留 values.a/values.b/values.c（多类型无控件），输出 FLOAT/INT/BOOL
#                       三路，expression 为唯一控件；函数用 **kwargs 接收带点输入名，规避 f(values.a=) 关键字错误。
#   · XHNumberConvert：输出 FLOAT/INT/STRING 三路，前两位 FLOAT/INT 与原版 slot 0/1 对齐。
#   · 平铺解码逻辑逐字照搬 Apt_Preset 的 VAEDecodeTiled()，行为一致。
#
# 家族规范：class_type 与前端 js 的 NODE_TYPE 必须逐字一致（本模块纯后端，无 js）。

import math
import torch

from .smart_face_mask import XHSmartFaceMask

_SAFE_GLOBALS = {"__builtins__": {}}


class XHMathExpression:
    """表达式求值：在 expression 里用 a / b / c 三个变量写算术式，输出 FLOAT / INT / BOOL 三路（对齐 ComfyMathExpression）。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "expression": ("STRING", {
                    "multiline": True,
                    "default": "a/2",
                    "tooltip": "可用 a, b, c 变量与 + - * / // % ** 及 math 函数（floor/ceil/sqrt/exp/log/sin/cos...）。 | English: use a,b,c and operators; math funcs floor/ceil/sqrt/exp/log/sin/cos...",
                }),
            },
            "optional": {
                # ⚠️ 类型必须逐字对齐原版 ComfyMathExpression（备份 #364 实测为 "FLOAT,INT,BOOLEAN"）。
                "values.a": ("FLOAT,INT,BOOLEAN", {
                    "default": 0.0, "step": 0.01,
                    "tooltip": "变量 a 的值。接 INT / FLOAT / BOOLEAN 都行，内部统一当数字参与运算。",
                }),
                "values.b": ("FLOAT,INT,BOOLEAN", {
                    "default": 0.0, "step": 0.01,
                    "tooltip": "变量 b 的值，用法同 a。没接时按 0 参与运算。",
                }),
                "values.c": ("FLOAT,INT,BOOLEAN", {
                    "default": 0.0, "step": 0.01,
                    "tooltip": "变量 c 的值，用法同 a。表达式里没用到的变量可以不接。",
                }),
            },
        }

    RETURN_TYPES = ("FLOAT", "INT", "BOOLEAN")
    RETURN_NAMES = ("FLOAT", "INT", "BOOL")
    FUNCTION = "evaluate"
    CATEGORY = "🔁XH/工具"
    DESCRIPTION = "表达式求值：在 expression 里用 a/b/c 变量算任意算术，输出 FLOAT/INT/BOOL 三路。 | English: evaluate arithmetic with a/b/c, output FLOAT/INT/BOOL."

    def evaluate(self, expression, **kwargs):
        a = float(kwargs.get("values.a", 0) or 0)
        b = float(kwargs.get("values.b", 0) or 0)
        c = float(kwargs.get("values.c", 0) or 0)
        env = dict(_SAFE_GLOBALS)
        env.update({
            "a": a, "b": b, "c": c,
            "abs": abs, "min": min, "max": max, "round": round, "pow": pow,
            "floor": math.floor, "ceil": math.ceil, "sqrt": math.sqrt,
            "exp": math.exp, "log": math.log, "sin": math.sin, "cos": math.cos,
            "tan": math.tan, "pi": math.pi, "e": math.e,
        })
        try:
            result = eval(expression, env)
        except Exception as ex:
            print(f"[XH-表达式] 解析失败：{expression!r} -> {ex}（已返回 0，不中断流程）")
            result = 0.0
        r = float(result)
        return (r, int(round(r)), bool(r != 0.0))


class XHNumberConvert:
    """数值类型转换：输入任意数值/字符串，同时输出 FLOAT / INT / STRING 三路（前两位对齐 ComfyNumberConvert 的 FLOAT/INT）。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "optional": {
                # ⚠️ 必须用「逗号分隔字符串」表示多类型；写成元组 ("INT","FLOAT",...) 会被当成 COMBO 下拉控件（STRING），
                # 与上游 INT/FLOAT 输出连线时报「类型不兼容」。对齐原版 ComfyNumberConvert 的 INT,FLOAT,STRING,BOOLEAN。
                "value": ("INT,FLOAT,STRING,BOOLEAN", {
                    "default": 0,
                    "tooltip": (
                        "要转换的输入值，INT / FLOAT / STRING / BOOLEAN 都能吃。\n"
                        "转换规则：先按 float 解析（解析失败算 0.0），INT 是四舍五入的结果，"
                        "STRING 是原始输入的原样文本。\n"
                        "⚠️ 类型是「逗号分隔字符串」写法，不是元组 —— 写成元组会被当成下拉框。"
                    ),
                }),
            },
        }

    RETURN_TYPES = ("FLOAT", "INT", "STRING")
    RETURN_NAMES = ("FLOAT", "INT", "STRING")
    FUNCTION = "convert"
    CATEGORY = "🔁XH/工具"
    DESCRIPTION = "数值类型转换：把输入转成 FLOAT / INT / STRING 三路同时输出。 | English: convert input to FLOAT/INT/STRING at once."

    def convert(self, value=0):
        try:
            f = float(value)
        except (TypeError, ValueError):
            f = 0.0
        i = int(round(f))
        s = str(value)
        return (f, i, s)


class XHSamplerSelect:
    """按名选采样器：输出 ComfyUI 的 SAMPLER 对象。"""

    @classmethod
    def INPUT_TYPES(cls):
        import comfy.samplers as _samplers
        return {
            "required": {
                "sampler_name": (_samplers.SAMPLER_NAMES, {
                    "default": "euler_ancestral",
                    "tooltip": (
                        "采样器算法名，输出一个 SAMPLER 对象交给采样节点的 sampler 口。\n"
                        "常用：euler / euler_ancestral / dpmpp_2m / dpmpp_2m_sde / lcm。\n"
                        "⚠️ 它只决定「采样算法」，步数 CFG 那些仍在采样节点上设。"
                    ),
                }),
            },
        }

    RETURN_TYPES = ("SAMPLER",)
    RETURN_NAMES = ("SAMPLER",)
    FUNCTION = "select"
    CATEGORY = "🔁XH/工具"
    DESCRIPTION = "按名选采样器，输出 SAMPLER 对象（喂给采样器 / 自定义采样节点）。 | English: pick a sampler by name, output a SAMPLER object."

    def select(self, sampler_name):
        import comfy.samplers as _samplers
        return (_samplers.sampler_object(sampler_name),)


class XHSolidMask:
    """实心遮罩：生成 width×height、值=value 的单张遮罩。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "value": ("FLOAT", {
                    "default": 0.0, "min": 0.0, "max": 1.0, "step": 0.01,
                    "tooltip": (
                        "遮罩填充值（0~1）。\n"
                        "· 0 = 纯黑（完全不作用）\n"
                        "· 1 = 纯白（完全作用）\n"
                        "常见用法：先造一张全白 full mask，后面再用别的节点去裁剪/混合。"
                    ),
                }),
                "width": ("INT", {
                    "default": 512, "min": 1, "max": 4096, "step": 1,
                    "tooltip": "遮罩宽度（像素）。应该与你要作用的图/ latent 同分辨率。",
                }),
                "height": ("INT", {
                    "default": 512, "min": 1, "max": 4096, "step": 1,
                    "tooltip": "遮罩高度（像素）。尺寸对不上时下游会按自己的缩放逻辑处理，别指望自动对齐。",
                }),
            },
        }

    RETURN_TYPES = ("MASK",)
    RETURN_NAMES = ("MASK",)
    FUNCTION = "solid"
    CATEGORY = "🔁XH/工具"
    DESCRIPTION = "实心遮罩：生成 width×height、填充值=value 的遮罩。 | English: solid mask of width×height filled with value."

    def solid(self, value, width, height):
        mask = torch.full((1, height, width), float(value), dtype=torch.float32)
        return (mask,)


class XHVAEDecodeTiled:
    """平铺 VAE 解码：显存不够时分批解码 latent → image（逻辑照搬 Apt_Preset）。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "samples": ("LATENT", {
                    "tooltip": "要解码的 latent（单个或一批都行），低显存时靠分块来救。",
                }),
                "vae": ("VAE", {
                    "tooltip": "用来解码的 VAE。图片类用普通 VAE，视频类用视频 VAE（会启用下面的时间分块）。",
                }),
                "tile_size": ("INT", {
                    "default": 512, "min": 64, "max": 4096, "step": 32,
                    "tooltip": (
                        "空间分块的边长（像素越小越省显存）。默认 512；"
                        "8GB 显存跑大图可以往下压到 320 / 256。\n"
                        "⚠️ 内部会自动保证 tile_size > overlap*4，太小的 overlap 会被回收到 tile_size/4。"
                    ),
                }),
                "overlap": ("INT", {
                    "default": 64, "min": 0, "max": 4096, "step": 32,
                    "tooltip": (
                        "空间块之间的重叠像素，用来抹平块间的接缝。\n"
                        "越大越无缝、代价是更慢更占显存；给 0 就是硬拼，容易看到格子。"
                    ),
                }),
                "temporal_size": ("INT", {"default": 64, "min": 8, "max": 4096, "step": 4,
                                          "tooltip": "仅视频 VAE 用：每次解码的帧数"}),
                "temporal_overlap": ("INT", {"default": 8, "min": 4, "max": 4096, "step": 4,
                                            "tooltip": "仅视频 VAE 用：帧重叠"}),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("IMAGE",)
    FUNCTION = "decode_tiled"
    CATEGORY = "🔁XH/工具"
    DESCRIPTION = "平铺 VAE 解码：低显存分批解码 latent → image（照搬 Apt_Preset 平铺逻辑）。 | English: tiled VAE decode for low VRAM (latent → image)."

    def decode_tiled(self, samples, vae, tile_size, overlap=64, temporal_size=64, temporal_overlap=8):
        if tile_size < overlap * 4:
            overlap = tile_size // 4
        if temporal_size < temporal_overlap * 2:
            temporal_overlap = temporal_overlap // 2
        tc = vae.temporal_compression_decode()
        if tc is not None:
            temporal_size = max(2, temporal_size // tc)
            temporal_overlap = max(1, min(temporal_size // 2, temporal_overlap // tc))
        else:
            temporal_size = None
            temporal_overlap = None
        compression = vae.spacial_compression_decode()
        images = vae.decode_tiled(
            samples["samples"],
            tile_x=tile_size // compression,
            tile_y=tile_size // compression,
            overlap=overlap // compression,
            tile_t=temporal_size,
            overlap_t=temporal_overlap,
        )
        if len(images.shape) == 5:
            images = images.reshape(-1, images.shape[-3], images.shape[-2], images.shape[-1])
        return (images,)


class XHShapeMaskOverlay:
    """形状遮罩覆盖（二合一 / 2026-10-12 升级）：
    ① 覆盖模式（接了 image）：在原图上用形状蒙版把指定区域填成指定颜色，其余像素逐位保留；
    ② 独立出图模式（不接 image）：用 frame_width/height 当画布、background_color 当底，凭空画形状出成品图。
    形状扩到 10 种（圆/方/矩形/半圆/1-4圆/椭圆/三角/十字/星形/放射），并补 rotation 旋转 / opacity 不透明度 / blur_radius 模糊。
    零外部依赖（torch / PIL / numpy 均为 ComfyUI 自带）。
    绘制逻辑参照 ComfyUI-Apt_Preset 的 create_mask_solo 与 kjnodes 的 CreateShapeMask。"""

    # 形状集合（英文值存进工作流；中文显示交给前端 COMBO_LABELS）
    SHAPES = ["circle", "square", "rectangle", "semicircle", "quarter_circle",
              "ellipse", "triangle", "cross", "star", "radial"]

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "shape": (cls.SHAPES, {
                    "default": "circle",
                    "tooltip": "【🔷 形状】circle=圆 / square=正方程(取宽高较小值当直径) / rectangle=矩形(用 shape 宽高) / semicircle=半圆 / quarter_circle=1/4圆 / ellipse=椭圆(扁) / triangle=三角 / cross=十字 / star=星形 / radial=放射扇形。 | English: shape preset.",
                }),
                "coord_center": (["image_center", "left_top"], {
                    "default": "image_center",
                    "tooltip": "【🎯 坐标中心】image_center=以画布中心为锚点(X/Y 为相对中心的偏移)；left_top=以左上角为锚点(X/Y 为相对左上的偏移)。 | English: anchor that X/Y offsets are measured from.",
                }),
                "location_x": ("INT", {"default": 0, "min": -16384, "max": 16384, "step": 1,
                                      "tooltip": "【📍 偏移X】coord_center=image_center 时为相对画布中心的偏移；=left_top 时为相对左上角的偏移。 | English: X offset from the chosen anchor (px)."}),
                "location_y": ("INT", {"default": 0, "min": -16384, "max": 16384, "step": 1,
                                      "tooltip": "【📍 偏移Y】coord_center=image_center 时为相对画布中心的偏移；=left_top 时为相对左上角的偏移。 | English: Y offset from the chosen anchor (px)."}),
                "shape_width": ("INT", {"default": 256, "min": 1, "max": 8192, "step": 1,
                                       "tooltip": "【📏 形状基准宽】形状基准宽度(px)。circle/square/半圆/三角等对称形状取「宽高较小值」当直径。 | English: base shape width (px)."}),
                "shape_height": ("INT", {"default": 256, "min": 1, "max": 8192, "step": 1,
                                        "tooltip": "【📏 形状基准高】形状基准高度(px)。 | English: base shape height (px)."}),
                "scale": ("FLOAT", {"default": 1.0, "min": 0.1, "max": 10.0, "step": 0.1,
                                   "tooltip": "【🔍 缩放】在基准宽高上再乘的倍数。1.0=不缩放。 | English: extra multiplier applied to base size."}),
                "rotation": ("INT", {"default": 0, "min": 0, "max": 360, "step": 1,
                                    "tooltip": "【🔄 旋转】形状绕自身中心旋转角度(度)。0=不转；非0=旋转且画布不留黑边(expand=False)。 | English: rotation around the shape center, degrees."}),
                "opacity": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.05,
                                     "tooltip": "【◐ 不透明度】形状填充不透明度：1.0=完全不透明，0=全透明。遮罩输出同步带此权重。 | English: shape fill opacity 0~1."}),
                "blur_radius": ("INT", {"default": 0, "min": 0, "max": 1000, "step": 1,
                                       "tooltip": "【🌫️ 模糊半径】形状边缘高斯模糊半径(px)。0=硬边；大值=柔和过渡。 | English: gaussian blur radius of the shape edge."}),
                "background_color": ("STRING", {"default": "#000000", "multiline": False,
                                     "tooltip": "【🎨 背景颜色】独立出图模式的背景色(hex)。接了 image 时无效(用原图当底)。 | English: background color (hex) in standalone mode; ignored when image connected."}),
                "shape_color": ("STRING", {"default": "#C8C8C8", "multiline": False,
                                     "tooltip": "【🎨 形状颜色】形状填充色(hex)。默认 #C8C8C8(RGB 200,200,200，三视图/角色设定图推荐)。遮哪张图就填哪张图的实际背景色可无缝融合。 | English: shape fill color (hex)."}),
                "frame_width": ("INT", {"default": 0, "min": 0, "max": 8192, "step": 1,
                                       "tooltip": "【📐 画布宽】接了 image 时 0=跟随图宽；独立出图模式下=输出画布宽(0 则用 1024)。 | English: canvas width; 0=follow input image, or 1024 in standalone mode."}),
                "frame_height": ("INT", {"default": 0, "min": 0, "max": 8192, "step": 1,
                                        "tooltip": "【📐 画布高】同上，控制输出画布高。 | English: canvas height; same rule as width."}),
                "feather": ("INT", {"default": 0, "min": 0, "max": 1000, "step": 1,
                                   "tooltip": "【🌫️ 羽化(兼容旧名)】与 blur_radius 等效的边缘柔化半径，实际取二者较大值。 | English: legacy feather alias; effective radius = max(feather, blur_radius)."}),
                "invert": ("BOOLEAN", {"default": False, "label_on": "反转(形状外填充)", "label_off": "正常(形状内填充)",
                                      "tooltip": "True=填充形状【外】区域，False=填充形状【内】。"}),
                "mask_locate": ("BOOLEAN", {"default": False, "label_on": "开(用mask定位画形状)", "label_off": "关(直接填mask)",
                                      "tooltip": "关=接了 mask 就直接用它填充（SAM3 原样遮盖，形状选项失效）；\n开=只用 mask 定位人脸中心/大小，再自动用上面的 形状 画遮罩盖上去。\n想保留形状审美、又让位置全自动时用它。"}),
                "mask_margin": ("INT", {"default": 15, "min": 0, "max": 200, "step": 1,
                                      "tooltip": "开 mask_locate 时，形状比人脸框外扩的百分比（如15=大出15%）。\n关 mask_locate 时此参数无效。"}),
            },
            "optional": {
                "image": ("IMAGE", {"tooltip": "【🖼️ 原图(可选)】接了=覆盖模式：在这张图上把形状区域填色，其余像素逐位保留。不接=独立出图模式：用 background_color+形状凭空生成成品图。"}),
                "mask": ("MASK", {"tooltip": "可选：接入外部蒙版（如 LoadImage 画的）。mask_locate=关时直接用它填充；=开时只借它定位。"}),
            },
        }

    RETURN_TYPES = ("IMAGE", "MASK", "BOX2")
    RETURN_NAMES = ("IMAGE", "MASK", "BOX2")
    FUNCTION = "overlay"
    CATEGORY = "🔁XH/工具"
    OUTPUT_NODE = False
    DESCRIPTION = ("形状遮罩覆盖（二合一）：接了 image 就把形状区域填色覆盖到原图；不接 image 就用 background_color+形状凭空生成成品图。"
                   "形状扩到 10 种(圆/方/矩形/半圆/1-4圆/椭圆/三角/十字/星形/放射)，补 rotation 旋转 / opacity 不透明度 / blur_radius 模糊，"
                   "覆盖模式额外输出 BOX2 边界框。零外部依赖。相对 Apt_Preset create_mask_solo 多了 feather 羽化 / invert 反转 / "
                   "mask_locate 借 SAM3 自动定位 / hex 自由填色 / geometry 逐张独立计算。")

    @staticmethod
    def _hex_to_rgb(color):
        """hex 字符串 → (r,g,b) 0~1。容错：无 #、3 位简写、非法值回落白。"""
        hexs = (color or "#FFFFFF").lstrip("#").strip()
        if len(hexs) == 3:
            hexs = "".join(c * 2 for c in hexs)
        hexs = (hexs + "000000")[:6]
        try:
            return (int(hexs[0:2], 16) / 255.0, int(hexs[2:4], 16) / 255.0, int(hexs[4:6], 16) / 255.0)
        except Exception:
            return (1.0, 1.0, 1.0)

    @staticmethod
    def _draw_shape(d_rgba, d_mask, shape, cx, cy, radius, sw, sh, rgb, alpha=255):
        """在 RGBA 图层与 L 蒙版上同时画同一形状。
        对称形状半径 = min(sw,sh)/2；rectangle 用独立 half_w/half_h。
        alpha = 填充不透明度(0~255)，RGBA 与 L 蒙版同步使用（保证 opacity 线性生效）。
        返回 (x0,y0,x1,y1) 形状外接框（旋转前）。"""
        import math
        r = max(1, int(radius))
        cx = int(cx); cy = int(cy)
        alpha = int(round(alpha))
        box = (cx - r, cy - r, cx + r, cy + r)
        # ⚠️ rgb 传进来是 0~1 的 float（_hex_to_rgb 的结果），必须 ×255 再取整，
        # 否则 int(0.184)=0 → 画出来纯黑（这就是"颜色填了没用/只有黑块"的元凶）。
        f = (int(round(rgb[0] * 255)), int(round(rgb[1] * 255)), int(round(rgb[2] * 255)), alpha)
        if shape == "rectangle":
            hw = max(1, int(sw // 2)); hh = max(1, int(sh // 2))
            box = (cx - hw, cy - hh, cx + hw, cy + hh)
            d_rgba.rectangle(box, fill=f); d_mask.rectangle(box, fill=alpha)
        elif shape == "circle":
            d_rgba.ellipse(box, fill=f); d_mask.ellipse(box, fill=alpha)
        elif shape == "square":
            d_rgba.rectangle(box, fill=f); d_mask.rectangle(box, fill=alpha)
        elif shape == "ellipse":
            hh = max(1, int(r * 0.7))
            box = (cx - r, cy - hh, cx + r, cy + hh)
            d_rgba.ellipse(box, fill=f); d_mask.ellipse(box, fill=alpha)
        elif shape == "semicircle":
            d_rgba.pieslice(box, 0, 180, fill=f); d_mask.pieslice(box, 0, 180, fill=alpha)
        elif shape == "quarter_circle":
            d_rgba.pieslice(box, 0, 90, fill=f); d_mask.pieslice(box, 0, 90, fill=alpha)
        elif shape == "triangle":
            pts = [(int(cx), int(cy - r)), (int(cx - r), int(cy + r)), (int(cx + r), int(cy + r))]
            d_rgba.polygon(pts, fill=f); d_mask.polygon(pts, fill=alpha)
        elif shape == "cross":
            aw = max(1, int(r / 3))
            h1 = (cx - r, cy - aw, cx + r, cy + aw)
            v1 = (cx - aw, cy - r, cx + aw, cy + r)
            d_rgba.rectangle(h1, fill=f); d_rgba.rectangle(v1, fill=f)
            d_mask.rectangle(h1, fill=alpha); d_mask.rectangle(v1, fill=alpha)
        elif shape == "star":
            pts = []
            for i in range(10):
                ang = i * 2 * math.pi / 10 - math.pi / 2
                rr = r if i % 2 == 0 else r / 2.5
                pts.append((int(cx + rr * math.cos(ang)), int(cy + rr * math.sin(ang))))
            d_rgba.polygon(pts, fill=f); d_mask.polygon(pts, fill=alpha)
        elif shape == "radial":
            # 放射扇形：8 个楔形，中间留缝（与实心圆区分）
            seg = 8
            gap = 3.0
            for i in range(seg):
                a0 = i * 360.0 / seg + gap
                a1 = (i + 1) * 360.0 / seg - gap
                d_rgba.pieslice(box, a0, a1, fill=f); d_mask.pieslice(box, a0, a1, fill=alpha)
        else:
            d_rgba.ellipse(box, fill=f); d_mask.ellipse(box, fill=alpha)
        return box

    @classmethod
    def _render(cls, shape, cx, cy, sw, sh, cw, ch, bg_rgb, shape_rgb, alpha, blur, rotation):
        """核心：在 [cw,ch] 画布上画背景+形状，返回 (canvas_rgb float[H,W,3] numpy, mask float[H,W] numpy, box)。
        alpha 为 0~1 不透明度（内部换算成 0~255 写进图层）。"""
        import numpy as np
        from PIL import Image, ImageDraw, ImageFilter
        radius = max(1, int(min(sw, sh) / 2))
        alpha255 = int(round(max(0.0, min(1.0, float(alpha))) * 255))
        bgv = (int(round(bg_rgb[0] * 255)), int(round(bg_rgb[1] * 255)), int(round(bg_rgb[2] * 255)), 255)
        s_img = Image.new("RGBA", (cw, ch), (0, 0, 0, 0))
        m_img = Image.new("L", (cw, ch), 0)
        d_rgba = ImageDraw.Draw(s_img); d_mask = ImageDraw.Draw(m_img)
        box = cls._draw_shape(d_rgba, d_mask, shape, cx, cy, radius, sw, sh, shape_rgb, alpha255)
        if int(rotation) % 360 != 0:
            s_img = s_img.rotate(int(rotation), center=(cx, cy), expand=False, resample=Image.BICUBIC)
            m_img = m_img.rotate(int(rotation), center=(cx, cy), expand=False, resample=Image.BICUBIC)
        if blur > 0:
            s_img = s_img.filter(ImageFilter.GaussianBlur(radius=blur))
            m_img = m_img.filter(ImageFilter.GaussianBlur(radius=blur))
        # 形状按 alpha 贴到纯色背景上（alpha 由 opacity 决定，已写进 s_img 的 A 通道）
        canvas = Image.new("RGBA", (cw, ch), bgv)
        canvas.paste(s_img, (0, 0), s_img)
        rgb = np.asarray(canvas.convert("RGB"), dtype=np.float32) / 255.0
        m = np.asarray(m_img, dtype=np.float32) / 255.0
        return rgb, m, box

    @staticmethod
    def _anchor_center(coord_center, shape, location_x, location_y, sw, sh, cw, ch):
        """按坐标模式换算出形状中心 (cx,cy)。Apt 语义：对称形状半径 = min(sw,sh)/2。"""
        radius = max(1, int(min(sw, sh) / 2))
        if coord_center == "image_center":
            return (cw // 2 + location_x, ch // 2 + location_y)
        if shape == "rectangle":
            return (location_x + int(sw / 2), location_y + int(sh / 2))
        if shape == "ellipse":
            return (location_x + radius, location_y + int(radius * 0.7))
        if shape == "semicircle":
            return (location_x + radius, location_y)
        if shape == "quarter_circle":
            return (location_x, location_y)
        return (location_x + radius, location_y + radius)

    @staticmethod
    def _resize(rgb, m, H, W):
        """把画布 rgb/mask resize 到输出尺寸 (H,W)。"""
        import numpy as np
        import torch
        import torch.nn.functional as F
        rt = torch.from_numpy(np.ascontiguousarray(rgb)).permute(2, 0, 1).unsqueeze(0)
        rt = F.interpolate(rt, size=(H, W), mode="bilinear", align_corners=False)[0].permute(1, 2, 0).numpy()
        mt = torch.from_numpy(np.ascontiguousarray(m)).unsqueeze(0).unsqueeze(0)
        mt = F.interpolate(mt, size=(H, W), mode="bilinear", align_corners=False)[0, 0].numpy()
        return rt, mt

    def overlay(self, shape, coord_center, location_x, location_y, shape_width, shape_height,
                scale, rotation, opacity, blur_radius, background_color, shape_color,
                frame_width, frame_height, feather, invert, mask_locate=False,
                mask_margin=15, image=None, mask=None):
        import numpy as np
        import torch
        import torch.nn.functional as F

        bg_rgb = self._hex_to_rgb(background_color)
        shape_rgb = self._hex_to_rgb(shape_color)
        blur = max(int(feather or 0), int(blur_radius or 0))
        alpha = max(0.0, min(1.0, float(opacity)))
        sw = max(1, int(round(shape_width * scale)))
        sh = max(1, int(round(shape_height * scale)))

        # ---------- 独立出图模式（不接 image）----------
        if image is None:
            cw = int(frame_width) if frame_width and frame_width > 0 else 1024
            ch = int(frame_height) if frame_height and frame_height > 0 else 1024
            cx, cy = self._anchor_center(coord_center, shape, location_x, location_y, sw, sh, cw, ch)
            rgb, m, _ = self._render(shape, cx, cy, sw, sh, cw, ch, bg_rgb, shape_rgb, alpha, blur, rotation)
            # 直线合成：背景色 + 形状色（用掩码加权），保证 opacity 线性生效
            m3 = m[..., None]
            solid = np.array(shape_rgb, dtype=np.float32)[None, None, :]
            out = np.array(bg_rgb, dtype=np.float32)[None, None, :] * (1.0 - m3) + solid * m3
            if invert:
                out = 1.0 - out
                m = 1.0 - m
            img_t = torch.from_numpy(np.ascontiguousarray(out.astype(np.float32))).unsqueeze(0)
            mask_t = torch.from_numpy(np.ascontiguousarray(m.astype(np.float32))).unsqueeze(0)
            box2 = (cw, ch, int(location_x), int(location_y))
            return (img_t, mask_t, box2)

        # ---------- 覆盖模式（接了 image）----------
        B, H, W, C = image.shape
        cw = int(frame_width) if frame_width and frame_width > 0 else W
        ch = int(frame_height) if frame_height and frame_height > 0 else H
        solid = torch.tensor([shape_rgb[0], shape_rgb[1], shape_rgb[2]], dtype=image.dtype, device=image.device)

        outs = []
        masks_out = []
        for i in range(B):
            if mask is not None and mask_locate:
                # 借 mask 定位人脸 bbox → 用所选形状重画（保留形状审美、位置全自动）
                m_in = mask[i:i + 1].unsqueeze(0)
                if m_in.shape[-2] != H or m_in.shape[-1] != W:
                    m_in = F.interpolate(m_in, size=(H, W), mode="bilinear", align_corners=False)
                m_bin = m_in.clamp(0, 1)[0, 0] > 0.5
                ys, xs = torch.where(m_bin)
                if xs.numel() > 0:
                    cx = int((xs.min().item() + xs.max().item()) / 2)
                    cy = int((ys.min().item() + ys.max().item()) / 2)
                    bw = int((xs.max().item() - xs.min().item()) * (1 + mask_margin / 100.0) * scale)
                    bh = int((ys.max().item() - ys.min().item()) * (1 + mask_margin / 100.0) * scale)
                    rgb, m, _ = self._render(shape, cx, cy, max(1, bw), max(1, bh), cw, ch,
                                             bg_rgb, shape_rgb, alpha, blur, rotation)
                    rgb, m = self._resize(rgb, m, H, W)
                    m = torch.from_numpy(np.ascontiguousarray(m)).to(image.dtype)
                    ov = torch.from_numpy(np.ascontiguousarray(rgb)).to(image.dtype)
                    m3 = m.unsqueeze(-1).expand(H, W, 3)
                    # 覆盖：形状处贴形状色（带 opacity 已烘进 m），其余保留原图
                    outs.append((image[i] * (1.0 - m3) + ov * m3).clamp(0, 1).unsqueeze(0))
                else:
                    m = torch.zeros((H, W), dtype=image.dtype, device=image.device)
                    outs.append(image[i:i + 1])
            elif mask is not None:
                # 直接用外部蒙版填充（形状选项失效）
                m = mask[i:i + 1].unsqueeze(0)
                if m.shape[-2] != H or m.shape[-1] != W:
                    m = F.interpolate(m, size=(H, W), mode="bilinear", align_corners=False)
                m = m.clamp(0, 1)[0, 0].to(image.dtype)
                if invert:
                    m = 1.0 - m
                m3 = m.unsqueeze(-1).expand(H, W, 3)
                outs.append((image[i] * (1.0 - m3) + solid.expand(H, W, 3) * m3).clamp(0, 1).unsqueeze(0))
            else:
                # 纯形状覆盖：逐张独立算（批量时每张位置可不同）
                cx, cy = self._anchor_center(coord_center, shape, location_x, location_y, sw, sh, cw, ch)
                rgb, m, _ = self._render(shape, cx, cy, sw, sh, cw, ch, bg_rgb, shape_rgb, alpha, blur, rotation)
                rgb, m = self._resize(rgb, m, H, W)
                m = torch.from_numpy(np.ascontiguousarray(m)).to(image.dtype)
                if invert:
                    m = 1.0 - m
                ov = torch.from_numpy(np.ascontiguousarray(rgb)).to(image.dtype)
                m3 = m.unsqueeze(-1).expand(H, W, 3)
                outs.append((image[i] * (1.0 - m3) + ov * m3).clamp(0, 1).unsqueeze(0))
            masks_out.append(m.unsqueeze(0))

        box2 = (cw, ch, int(location_x), int(location_y))
        return (torch.cat(outs, dim=0), torch.cat(masks_out, dim=0), box2)

class XHBBoxRegion:
    """用 4 个比例参数(相对真实图尺寸)定义矩形区域，输出 BOUNDING_BOX 喂 SAM3_Detect.bboxes，
    让它只在该区域内找目标(如只遮中间小脸、不碰旁边大脸)。坐标基于真实图片尺寸算，永不错位，
    且比例参数可直接进 XH 循环批量复用。轻量替代官方 CreateBoundingBoxes(画布交互版)。
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "center_x": ("FLOAT", {
                    "default": 0.5, "min": 0.0, "max": 1.0, "step": 0.01,
                    "tooltip": "【📍 中心X占比】区域中心横向位置，占图片宽度的比例(0=最左,1=最右)。三视图遮中间脸填 0.5。 | English: horizontal center of the region as a fraction of image width (0=left,1=right).",
                }),
                "center_y": ("FLOAT", {
                    "default": 0.5, "min": 0.0, "max": 1.0, "step": 0.01,
                    "tooltip": "【📐 中心Y占比】区域中心纵向位置，占图片高度的比例(0=最上,1=最下)。 | English: vertical center as a fraction of image height (0=top,1=bottom).",
                }),
                "box_w": ("FLOAT", {
                    "default": 0.34, "min": 0.01, "max": 1.0, "step": 0.01,
                    "tooltip": "【📏 区域宽占比】区域宽度占图片宽度的比例。三视图中间那张约占 1/3 宽，填 0.34 留点余量。 | English: region width as a fraction of image width. For a 1/3-wide center face use ~0.34.",
                }),
                "box_h": ("FLOAT", {
                    "default": 0.9, "min": 0.01, "max": 1.0, "step": 0.01,
                    "tooltip": "【📏 区域高占比】区域高度占图片高度的比例。 | English: region height as a fraction of image height.",
                }),
            },
            "optional": {
                "image": ("IMAGE", {
                    "tooltip": "【🖼️ 图像】接真实图片(与喂给 SAM3 的是同一张)，用于读取真实宽高。不接则用下面手动宽高。 | English: real image to read true W/H; if omitted, use manual W/H below.",
                }),
                "width": ("INT", {
                    "default": 0, "min": 0, "max": 16384, "step": 16,
                    "tooltip": "【📏 手动宽】未接 image 时的手动宽度(px)。接了 image 此值忽略。 | English: manual width (px) when no image is connected; ignored if image is connected.",
                }),
                "height": ("INT", {
                    "default": 0, "min": 0, "max": 16384, "step": 16,
                    "tooltip": "【📏 手动高】未接 image 时的手动高度(px)。接了 image 此值忽略。 | English: manual height (px) when no image is connected; ignored if image is connected.",
                }),
            },
        }

    RETURN_TYPES = ("BOUNDING_BOX",)
    RETURN_NAMES = ("BBOX",)
    FUNCTION = "make"
    CATEGORY = "🔁XH/工具"
    DESCRIPTION = "【🔁XH-区域限定框】用4个比例参数定义矩形区域，输出 BOUNDING_BOX 喂 SAM3_Detect.bboxes，让 SAM3 只在区域内找目标(如只遮中间小脸)。比官方 CreateBoundingBoxes 多了：①节点上带可视化网格拖拽框编辑器(直接拖拽定位，比例实时回写控件)；②坐标直接基于真实图片尺寸算、永不因网格基准不一致而错位；③比例参数可直接进 XH 循环批量复用。 | English: define a region by 4 fractions, output BOUNDING_BOX for SAM3_Detect.bboxes so detection is confined to the region. vs official CreateBoundingBoxes: ① node ships a visual grid drag-box editor (drag to place, fractions written back live); ② coords derived from real image size (no grid-baseline mismatch); ③ fractions drop straight into XH loops for batch reuse."

    def make(self, center_x, center_y, box_w, box_h, image=None, width=0, height=0):
        if image is not None:
            B, H, W, C = image.shape
        else:
            W = width if width and width > 0 else 1024
            H = height if height and height > 0 else 1024
        W = int(W)
        H = int(H)
        bw = max(1, int(round(box_w * W)))
        bh = max(1, int(round(box_h * H)))
        cx = center_x * W
        cy = center_y * H
        x = max(0, int(round(cx - bw / 2.0)))
        y = max(0, int(round(cy - bh / 2.0)))
        # 越界回拉，确保框完整落在图内
        if x + bw > W:
            x = max(0, W - bw)
        if y + bh > H:
            y = max(0, H - bh)
        return ({"x": x, "y": y, "width": bw, "height": bh},)


NODE_CLASS_MAPPINGS = {
    "XHMathExpression": XHMathExpression,
    "XHNumberConvert": XHNumberConvert,
    "XHSamplerSelect": XHSamplerSelect,
    "XHSolidMask": XHSolidMask,
    "XHVAEDecodeTiled": XHVAEDecodeTiled,
    "XHShapeMaskOverlay": XHShapeMaskOverlay,
    "XHBBoxRegion": XHBBoxRegion,
    "XHSmartFaceMask": XHSmartFaceMask,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "XHMathExpression": "🔁XH-表达式求值",
    "XHNumberConvert": "🔁XH-数值转换",
    "XHSamplerSelect": "🔁XH-采样器选择",
    "XHSolidMask": "🔁XH-实心遮罩",
    "XHVAEDecodeTiled": "🔁XH-平铺VAE解码",
    "XHShapeMaskOverlay": "🔁XH-形状遮罩覆盖",
    "XHBBoxRegion": "🔁XH-区域限定框",
    "XHSmartFaceMask": "🧩XH-智能遮脸",
}
