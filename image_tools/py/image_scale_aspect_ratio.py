# 🖼️XH-按比例缩放（XH 家族）
#
# 复刻 aining2022/ComfyUI_Swwan 的 `LayerUtility: ImageScaleByAspectRatio V2`
# （其上游是 ComfyUI_LayerStyle 的 ImageScaleByAspectRatio）。
#
# 🔴 算法逐行照抄 LayerStyle 原版（aspect_resize + fit_resize_image），未改动任何计算逻辑；
#    仅仅是把 class_type / 显示名改成 XH 风格，并给参数加了中英双语 tooltip。
#    默认参数下，输出与原版**逐张完全一致**（torch.equal 实测通过）。
#
# 比原版多做的事（都不改接口）：
#   · 中文显示名 + 中/EN 一键切换（家族 i18n，见 web/xh_image_scale_aspect_ratio.js）
#   · 参数 tooltip 中文优先、英文说明（照家族规范 `【emoji 中文】… | English: …`）
#
# 兼容性：INPUT_TYPES 的字段名 / 顺序 / 下拉**存档值** / 输出名，全部与原版一致，
#         所以老工作流里把 `LayerUtility: ImageScaleByAspectRatio V2` 直接换成 `XHImageScaleByAspectRatio`，
#         连线与参数一根都不用动。

import math
import numpy as np
import torch
from PIL import Image

# ---------------------------------------------------------------------------
# 从 LayerStyle 搬运的最小工具集（与作者包逐字一致，保证输出逐字节相同）
# ---------------------------------------------------------------------------

def tensor2pil(t_image):
    return Image.fromarray(np.clip(255.0 * t_image.cpu().numpy().squeeze(), 0, 255).astype(np.uint8))


def pil2tensor(image):
    return torch.from_numpy(np.array(image).astype(np.float32) / 255.0).unsqueeze(0)


def image2mask(image):
    if image.mode == 'L':
        return torch.tensor([pil2tensor(image)[0, :, :].tolist()])
    else:
        image = image.convert('RGB').split()[0]
        return torch.tensor([pil2tensor(image)[0, :, :].tolist()])


def is_valid_mask(tensor):
    return not bool(torch.all(tensor == 0).item())


def num_round_up_to_multiple(number, multiple):
    remainder = number % multiple
    if remainder == 0:
        return number
    factor = (number + multiple - 1) // multiple
    return factor * multiple


def fit_resize_image(image, target_width, target_height, fit, resize_sampler,
                     background_color='#000000'):
    image = image.convert('RGB')
    orig_width, orig_height = image.size
    if image is not None:
        if fit == 'letterbox':
            if orig_width / orig_height > target_width / target_height:  # 更宽，上下留黑
                fit_width = target_width
                fit_height = int(target_width / orig_width * orig_height)
            else:  # 更瘦，左右留黑
                fit_height = target_height
                fit_width = int(target_height / orig_height * orig_width)
            fit_image = image.resize((fit_width, fit_height), resize_sampler)
            ret_image = Image.new('RGB', size=(target_width, target_height), color=background_color)
            ret_image.paste(fit_image, box=((target_width - fit_width) // 2,
                                           (target_height - fit_height) // 2))
        elif fit == 'crop':
            if orig_width / orig_height > target_width / target_height:  # 更宽，裁左右
                fit_width = int(orig_height * target_width / target_height)
                fit_image = image.crop(((orig_width - fit_width) // 2, 0,
                                        (orig_width - fit_width) // 2 + fit_width, orig_height))
            else:  # 更瘦，裁上下
                fit_height = int(orig_width * target_height / target_width)
                fit_image = image.crop((0, (orig_height - fit_height) // 2, orig_width,
                                       (orig_height - fit_height) // 2 + fit_height))
            ret_image = fit_image.resize((target_width, target_height), resize_sampler)
        else:  # fill
            ret_image = image.resize((target_width, target_height), resize_sampler)
    return ret_image


def _aspect_resize(aspect_ratio, proportional_width, proportional_height, fit, method,
                   round_to_multiple, scale_to_side, scale_to_length, background_color,
                   image=None, mask=None):
    """原版 aspect_resize 的逐字复刻；见 ComfyUI_Swwan/ops/aspect_resize.py。"""
    orig_images = []
    orig_masks = []
    orig_width = 0
    orig_height = 0
    target_width = 0
    target_height = 0
    ratio = 1.0
    ret_images = []
    ret_masks = []

    if image is not None:
        for i in image:
            i = torch.unsqueeze(i, 0)
            orig_images.append(i)
        orig_width, orig_height = tensor2pil(orig_images[0]).size

    if mask is not None:
        if mask.dim() == 2:
            mask = torch.unsqueeze(mask, 0)
        for m in mask:
            m = torch.unsqueeze(m, 0)
            if not is_valid_mask(m) and m.shape == torch.Size([1, 64, 64]):
                print(f"# 😺dzNodes: ImageScaleByAspectRatio V2 -> "
                      f"input mask is empty, ignore it.")
            else:
                orig_masks.append(m)
        if len(orig_masks) > 0:
            _width, _height = tensor2pil(orig_masks[0]).size
            if (orig_width > 0 and orig_width != _width) or (orig_height > 0 and orig_height != _height):
                print(f"# 😺dzNodes: ImageScaleByAspectRatio V2 -> "
                      f"execute failed, because the mask doesn't match image.")
                return (None, None, None, 0, 0)
            elif orig_width + orig_height == 0:
                orig_width = _width
                orig_height = _height

    if orig_width + orig_height == 0:
        print(f"# 😺dzNodes: ImageScaleByAspectRatio V2 -> "
              f"execute failed, because the image or mask at least one must be input.")
        return (None, None, None, 0, 0)

    if aspect_ratio == 'original':
        ratio = orig_width / orig_height
    elif aspect_ratio == 'custom':
        ratio = proportional_width / proportional_height
    else:
        s = aspect_ratio.split(":")
        ratio = int(s[0]) / int(s[1])

    # calculate target width and height
    if ratio > 1:
        if scale_to_side == 'longest':
            target_width = scale_to_length
            target_height = int(target_width / ratio)
        elif scale_to_side == 'shortest':
            target_height = scale_to_length
            target_width = int(target_height * ratio)
        elif scale_to_side == 'width':
            target_width = scale_to_length
            target_height = int(target_width / ratio)
        elif scale_to_side == 'height':
            target_height = scale_to_length
            target_width = int(target_height * ratio)
        elif scale_to_side == 'total_pixel(kilo pixel)':
            target_width = math.sqrt(ratio * scale_to_length * 1000)
            target_height = target_width / ratio
            target_width = int(target_width)
            target_height = int(target_height)
        else:
            target_width = orig_width
            target_height = int(target_width / ratio)
    else:
        if scale_to_side == 'longest':
            target_height = scale_to_length
            target_width = int(target_height * ratio)
        elif scale_to_side == 'shortest':
            target_width = scale_to_length
            target_height = int(target_width / ratio)
        elif scale_to_side == 'width':
            target_width = scale_to_length
            target_height = int(target_width / ratio)
        elif scale_to_side == 'height':
            target_height = scale_to_length
            target_width = int(target_height * ratio)
        elif scale_to_side == 'total_pixel(kilo pixel)':
            target_width = math.sqrt(ratio * scale_to_length * 1000)
            target_height = target_width / ratio
            target_width = int(target_width)
            target_height = int(target_height)
        else:
            target_height = orig_height
            target_width = int(target_height * ratio)

    if round_to_multiple != 'None':
        multiple = int(round_to_multiple)
        target_width = num_round_up_to_multiple(target_width, multiple)
        target_height = num_round_up_to_multiple(target_height, multiple)

    _mask = Image.new('L', size=(target_width, target_height), color='black')
    _image = Image.new('RGB', size=(target_width, target_height), color='black')

    resize_sampler = Image.LANCZOS
    if method == "bicubic":
        resize_sampler = Image.BICUBIC
    elif method == "hamming":
        resize_sampler = Image.HAMMING
    elif method == "bilinear":
        resize_sampler = Image.BILINEAR
    elif method == "box":
        resize_sampler = Image.BOX
    elif method == "nearest":
        resize_sampler = Image.NEAREST

    if len(orig_images) > 0:
        for i in orig_images:
            _image = tensor2pil(i).convert('RGB')
            _image = fit_resize_image(_image, target_width, target_height, fit, resize_sampler, background_color)
            ret_images.append(pil2tensor(_image))
    if len(orig_masks) > 0:
        for m in orig_masks:
            _mask = tensor2pil(m).convert('L')
            _mask = fit_resize_image(_mask, target_width, target_height, fit, resize_sampler).convert('L')
            ret_masks.append(image2mask(_mask))

    if len(ret_images) > 0 and len(ret_masks) > 0:
        print(f"# 😺dzNodes: ImageScaleByAspectRatio V2 Processed {len(ret_images)} image(s).")
        return (torch.cat(ret_images, dim=0), torch.cat(ret_masks, dim=0),
                [orig_width, orig_height], target_width, target_height)
    elif len(ret_images) > 0 and len(ret_masks) == 0:
        print(f"# 😺dzNodes: ImageScaleByAspectRatio V2 Processed {len(ret_images)} image(s).")
        return (torch.cat(ret_images, dim=0), None, [orig_width, orig_height], target_width, target_height)
    elif len(ret_images) == 0 and len(ret_masks) > 0:
        print(f"# 😺dzNodes: ImageScaleByAspectRatio V2 Processed {len(ret_masks)} image(s).")
        return (None, torch.cat(ret_masks, dim=0), [orig_width, orig_height], target_width, target_height)
    else:
        print(f"# 😺dzNodes: ImageScaleByAspectRatio V2 skipped, "
              f"because the available image or mask is not found.")
        return (None, None, None, 0, 0)


class XHImageScaleByAspectRatio:
    """按比例缩放图像 / 遮罩 —— LayerStyle ImageScaleByAspectRatio 的 XH 家族版。"""

    @classmethod
    def INPUT_TYPES(cls):
        ratio_list = ['original', 'custom', '1:1', '3:2', '4:3', '16:9', '2:3', '3:4', '9:16']
        fit_mode = ['letterbox', 'crop', 'fill']
        method_mode = ['lanczos', 'bicubic', 'hamming', 'bilinear', 'box', 'nearest']
        multiple_list = ['8', '16', '32', '64', '128', '256', '512', 'None']
        scale_to_list = ['None', 'longest', 'shortest', 'width', 'height', 'total_pixel(kilo pixel)']
        return {
            "required": {
                "aspect_ratio": (ratio_list, {
                    "tooltip": (
                        "【📐 目标比例】原图比例 / 自定义 / 常见比例。\n"
                        "| English: target aspect ratio — original / custom / presets."
                    ),
                }),
                "proportional_width": ("INT", {
                    "default": 1, "min": 1, "max": 1e8, "step": 1,
                    "tooltip": (
                        "【🔢 自定义宽】aspect_ratio 选 custom 时，目标宽 = 此值。\n"
                        "| English: target width when aspect_ratio = custom."
                    ),
                }),
                "proportional_height": ("INT", {
                    "default": 1, "min": 1, "max": 1e8, "step": 1,
                    "tooltip": (
                        "【🔢 自定义高】aspect_ratio 选 custom 时，目标高 = 此值。\n"
                        "| English: target height when aspect_ratio = custom."
                    ),
                }),
                "fit": (fit_mode, {
                    "tooltip": (
                        "【🧩 适配方式】letterbox 保持比例补边 / crop 保持比例裁切 / fill 拉伸填满。\n"
                        "| English: letterbox / crop / fill."
                    ),
                }),
                "method": (method_mode, {
                    "tooltip": (
                        "【🔍 缩放算法】lanczos 最清晰（默认），nearest 最快。\n"
                        "| English: resampling method."
                    ),
                }),
                "round_to_multiple": (multiple_list, {
                    "tooltip": (
                        "【📏 整除对齐】结果宽高对齐到此倍数（8/16/…/512），None 不取整。\n"
                        "| English: round width & height up to this multiple."
                    ),
                }),
                "scale_to_side": (scale_to_list, {
                    "tooltip": (
                        "【🎯 按边缩放】把哪条边 / 哪类尺寸固定为 scale_to_length：\n"
                        "longest 最长边 / shortest 最短边 / width 宽 / height 高 / "
                        "total_pixel(kilo pixel) 总像素(千)。None 用原尺寸。\n"
                        "| English: which side to lock to scale_to_length."
                    ),
                }),
                "scale_to_length": ("INT", {
                    "default": 1024, "min": 4, "max": 1e8, "step": 1,
                    "tooltip": (
                        "【📏 目标边长】与 scale_to_side 配合：锁定的那条边 / 总像素的目标值。\n"
                        "| English: target length for the locked side / total pixels."
                    ),
                }),
                "background_color": ("STRING", {
                    "default": "#000000",
                    "tooltip": (
                        "【🎨 补边颜色】letterbox 模式下填充背景色（十六进制）。\n"
                        "| English: background color for letterbox."
                    ),
                }),
            },
            "optional": {
                "image": ("IMAGE", {
                    "tooltip": (
                        "【🖼️ 输入图像】要缩放的图像批次（至少接 image 或 mask 之一）。\n"
                        "| English: image batch to scale."
                    ),
                }),
                "mask": ("MASK", {
                    "tooltip": (
                        "【🎭 输入遮罩】要同步缩放的遮罩（与 image 同尺寸）。\n"
                        "| English: mask to scale in sync."
                    ),
                }),
            },
        }

    RETURN_TYPES = ("IMAGE", "MASK", "BOX", "INT", "INT")
    RETURN_NAMES = ("image", "mask", "original_size", "width", "height")
    FUNCTION = "scale"
    CATEGORY = "🔁XH/Image"
    DESCRIPTION = (
        "【干什么】按比例缩放图像 / 遮罩，并输出原始尺寸与最终宽高 —— "
        "LayerStyle「ImageScaleByAspectRatio」的 XH 家族版，算法逐字一致，默认参数下输出与原版逐张相同。\n"
        "【怎么配】· aspect_ratio 目标比例（原图 / 自定义 / 1:1 / 3:2 / 4:3 / 16:9 / 2:3 / 3:4 / 9:16）\n"
        "· fit 适配方式（letterbox 补边 / crop 裁切 / fill 拉伸）\n"
        "· method 缩放算法（lanczos / bicubic / … / nearest）\n"
        "· round_to_multiple 整除对齐（8~512 / None）\n"
        "· scale_to_side + scale_to_length 按某条边或总像素锁定目标尺寸\n"
        "· background_color 补边颜色\n"
        "【怎么用】image / mask 至少接一个；输出 image 缩放后图像、mask 同步遮罩、"
        "original_size 原始 [宽,高]、width/height 最终尺寸。\n"
        "⚠️ 原版节点叫「LayerUtility: ImageScaleByAspectRatio V2」，本 XH 版 class_type 为 "
        "XHImageScaleByAspectRatio，替换时直接换节点即可，连线不动。"
    )

    def scale(self, aspect_ratio, proportional_width, proportional_height, fit, method,
              round_to_multiple, scale_to_side, scale_to_length, background_color,
              image=None, mask=None):
        return _aspect_resize(aspect_ratio, proportional_width, proportional_height, fit, method,
                              round_to_multiple, scale_to_side, scale_to_length, background_color,
                              image, mask)


NODE_CLASS_MAPPINGS = {"XHImageScaleByAspectRatio": XHImageScaleByAspectRatio}
NODE_DISPLAY_NAME_MAPPINGS = {"XHImageScaleByAspectRatio": "🖼️XH-按比例缩放"}
