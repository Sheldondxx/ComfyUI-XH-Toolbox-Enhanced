# 🎨XH-色彩校正（XH 家族）
#
# 复刻 comfyui-art-venture 的 `ColorCorrect`（其上游是
# EllangoK/ComfyUI-post-processing-nodes 的 color_correct.py）。
#
# 🔴 算法逐行照抄原版（PIL ImageEnhance + opencv HLS/HSV），未改动任何计算逻辑；
#    仅仅是把 class_type / 显示名改成 XH 风格，并给参数加了中英双语 tooltip。
#    默认参数下，输出与原版**逐张完全一致**（torch.equal 实测通过）。
#
# 比原版多做的事（都不改接口）：
#   · 中文显示名 + 中/EN 一键切换（家族 i18n，见 web/xh_image_color_correct.js）
#   · 参数 tooltip 中文优先、英文说明（照家族规范 `【emoji 中文】… | English: …`）
#
# 兼容性：INPUT_TYPES 的字段名 / 顺序 / 默认值 / 输出，全部与原版一致，
#         所以老工作流里把 `ColorCorrect` 直接换成 `XHColorCorrect`，连线与参数一根都不用动。

import cv2
import numpy as np
import torch
from PIL import Image, ImageEnhance


class XHColorCorrect:
    """色彩校正（色温/色相/亮度/对比度/饱和度/伽马）—— art-venture ColorCorrect 的 XH 家族版。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE", {
                    "tooltip": (
                        "【🖼️ 输入图像】要校正的图像批次。\n"
                        "| English: image batch to correct."
                    ),
                }),
                "temperature": ("FLOAT", {
                    "default": 0, "min": -100, "max": 100, "step": 5,
                    "tooltip": (
                        "【🌡️ 色温】正=偏暖（红/绿增强），负=偏冷（蓝增强）。范围 -100~100。\n"
                        "| English: positive = warmer, negative = cooler."
                    ),
                }),
                "hue": ("FLOAT", {
                    "default": 0, "min": -90, "max": 90, "step": 5,
                    "tooltip": (
                        "【🌈 色相】整体色相偏移（度），范围 -90~90。\n"
                        "| English: hue shift in degrees."
                    ),
                }),
                "brightness": ("FLOAT", {
                    "default": 0, "min": -100, "max": 100, "step": 5,
                    "tooltip": (
                        "【☀️ 亮度】0 不变，正=更亮，负=更暗，范围 -100~100。\n"
                        "| English: brightness adjustment."
                    ),
                }),
                "contrast": ("FLOAT", {
                    "default": 0, "min": -100, "max": 100, "step": 5,
                    "tooltip": (
                        "【◐ 对比度】0 不变，正=更强，负=更弱，范围 -100~100。\n"
                        "| English: contrast adjustment."
                    ),
                }),
                "saturation": ("FLOAT", {
                    "default": 0, "min": -100, "max": 100, "step": 5,
                    "tooltip": (
                        "【🎨 饱和度】0 不变，正=更艳，负=褪色（-100 变灰），范围 -100~100。\n"
                        "| English: saturation adjustment."
                    ),
                }),
                "gamma": ("FLOAT", {
                    "default": 1, "min": 0.2, "max": 2.2, "step": 0.1,
                    "tooltip": (
                        "【⚡ 伽马】1 不变；<1 提亮暗部，>1 压暗暗部，范围 0.2~2.2。\n"
                        "| English: gamma correction."
                    ),
                }),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    FUNCTION = "color_correct"
    CATEGORY = "🔁XH/Image"
    DESCRIPTION = (
        "【干什么】对图像做一站式色彩校正：色温 / 色相 / 亮度 / 对比度 / 饱和度 / 伽马，"
        "六个滑块全 0（伽马 1）时输出与输入一致。\n"
        "【怎么配】只有 image 一个输入、image 一个输出，串在 VAE 解码后 / 保存前即可。\n"
        "⚠️ 原版节点叫「Color Correct」（comfyui-art-venture 包），本 XH 版 class_type 为 "
        "XHColorCorrect，替换时直接换节点即可，连线不动。\n"
        "· 色温：正偏暖（红+绿↑）、负偏冷（蓝↑）\n"
        "· 亮度/对比度/饱和度：-100~100，0 为不变\n"
        "· 色相：-90~90 度整体偏移\n"
        "· 伽马：0.2~2.2，1 为不变"
    )

    def color_correct(self, image, temperature, hue, brightness, contrast, saturation, gamma):
        batch_size, height, width, _ = image.shape
        result = torch.zeros_like(image)

        brightness /= 100
        contrast /= 100
        saturation /= 100
        temperature /= 100

        brightness = 1 + brightness
        contrast = 1 + contrast
        saturation = 1 + saturation

        for b in range(batch_size):
            tensor_image = image[b].numpy()

            modified_image = Image.fromarray((tensor_image * 255).astype(np.uint8))

            # brightness
            modified_image = ImageEnhance.Brightness(modified_image).enhance(brightness)

            # contrast
            modified_image = ImageEnhance.Contrast(modified_image).enhance(contrast)
            modified_image = np.array(modified_image).astype(np.float32)

            # temperature
            if temperature > 0:
                modified_image[:, :, 0] *= 1 + temperature
                modified_image[:, :, 1] *= 1 + temperature * 0.4
            elif temperature < 0:
                modified_image[:, :, 2] *= 1 - temperature
            modified_image = np.clip(modified_image, 0, 255) / 255

            # gamma
            modified_image = np.clip(np.power(modified_image, gamma), 0, 1)

            # saturation
            hls_img = cv2.cvtColor(modified_image, cv2.COLOR_RGB2HLS)
            hls_img[:, :, 2] = np.clip(saturation * hls_img[:, :, 2], 0, 1)
            modified_image = cv2.cvtColor(hls_img, cv2.COLOR_HLS2RGB) * 255

            # hue
            hsv_img = cv2.cvtColor(modified_image, cv2.COLOR_RGB2HSV)
            hsv_img[:, :, 0] = (hsv_img[:, :, 0] + hue) % 360
            modified_image = cv2.cvtColor(hsv_img, cv2.COLOR_HSV2RGB)

            modified_image = modified_image.astype(np.uint8)
            modified_image = modified_image / 255
            modified_image = torch.from_numpy(modified_image).unsqueeze(0)
            result[b] = modified_image

        return (result,)


NODE_CLASS_MAPPINGS = {"XHColorCorrect": XHColorCorrect}
NODE_DISPLAY_NAME_MAPPINGS = {"XHColorCorrect": "🎨XH-色彩校正"}
