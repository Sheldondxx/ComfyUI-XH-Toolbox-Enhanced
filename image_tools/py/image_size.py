"""
🖼️ XH-图像尺寸（XHImageSize）

参考「获取图像尺寸」节点做的 XH 家族版本。

从 IMAGE tensor 直接读取 batch / height / width，
ComfyUI 的 IMAGE 张量形状固定为 [B, H, W, C]（channels=3/4）。
同时输出一个 info 字符串，方便在预览/打印里直接看到 "width: 544, height: 967 batch size: 1"。
"""


class XHImageSize:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "image": ("IMAGE", {
                    "tooltip": "【🖼️ 输入图像】读取其 batch / 高 / 宽。 | English: input image",
                }),
            },
        }

    RETURN_TYPES = ("INT", "INT", "INT", "STRING")
    RETURN_NAMES = ("width", "height", "batch_size", "info")
    FUNCTION = "get_size"
    CATEGORY = "🔁XH/Image"
    DESCRIPTION = (
        "【🖼️ 图像尺寸】读取 IMAGE 张量的宽度、高度、批次大小，"
        "并输出一条可读的 info 字符串（width: 544, height: 967 batch size: 1）。"
    )

    def get_size(self, image):
        # ComfyUI IMAGE tensor shape: [B, H, W, C]
        batch_size, height, width = image.shape[0], image.shape[1], image.shape[2]
        info = f"width: {width}, height: {height} batch size: {batch_size}"
        return (width, height, batch_size, info)


NODE_CLASS_MAPPINGS = {"XHImageSize": XHImageSize}
NODE_DISPLAY_NAME_MAPPINGS = {"XHImageSize": "🖼️XH-图像尺寸"}
