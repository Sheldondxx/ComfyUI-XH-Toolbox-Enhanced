import numpy as np
import torch

from .video_label import render_label_overlay


class XHVideoLabel:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "images": ("IMAGE",),
            "text": ("STRING", {"default": "", "multiline": True,
                                "tooltip": "每路视频的标签，可换行填写模型、步数、CFG、种子等参数。留空不显示。"}),
            "font_size": ("INT", {"default": 28, "min": 8, "max": 200, "step": 1}),
        }}

    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "apply_label"
    CATEGORY = "🔁XH/Video"
    DESCRIPTION = "在每帧左上角绘制多行中文标签：白字、半透明黑底。预览和导出共用标签文字。"

    def apply_label(self, images, text, font_size):
        if not text.strip():
            return (images,)

        height, width = images.shape[1:3]
        layer = render_label_overlay(width, height, text, font_size)

        # Render once; broadcast the same label across all video frames.
        overlay = torch.from_numpy(np.array(layer, dtype=np.float32) / 255.0).to(device=images.device, dtype=images.dtype)
        rgb, alpha = overlay[..., :3], overlay[..., 3:]
        if images.shape[-1] == 4:
            dst_alpha = images[..., 3:]
            out_alpha = alpha + (1 - alpha) * dst_alpha
            out_rgb = rgb * alpha + images[..., :3] * dst_alpha * (1 - alpha)
            out_rgb = torch.where(out_alpha > 1e-5, out_rgb / out_alpha, torch.zeros_like(out_rgb))
            return (torch.cat((out_rgb, out_alpha), dim=-1),)
        return (images * (1 - alpha) + rgb * alpha,)


NODE_CLASS_MAPPINGS = {"XHVideoLabel": XHVideoLabel}
NODE_DISPLAY_NAME_MAPPINGS = {"XHVideoLabel": "🏷️XH-视频参数标签"}
