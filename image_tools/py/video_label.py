import os

from PIL import Image, ImageDraw, ImageFont


_FONT_PATHS = (
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
    "C:/Windows/Fonts/msyh.ttc",
    "/System/Library/Fonts/PingFang.ttc",
)


def render_label_overlay(width, height, text, font_size):
    font_path = next((p for p in _FONT_PATHS if os.path.isfile(p)), None)
    font = ImageFont.truetype(font_path, font_size) if font_path else ImageFont.load_default(size=font_size)
    text = text.replace("\\n", "\n").replace("\\t", "\t")
    lines = []
    for raw_line in text.split("\n"):
        current = ""
        for character in raw_line:
            if current and font.getlength(current + character) > max(1, width - 40):
                lines.append(current)
                current = ""
            current += character
        lines.append(current)
    block = "\n".join(lines)
    layer = Image.new("RGBA", (width, height))
    draw = ImageDraw.Draw(layer)
    spacing = max(2, font_size // 4)
    box = draw.multiline_textbbox((0, 0), block, font=font, spacing=spacing, stroke_width=1)
    draw.rounded_rectangle((8, 8, box[2] - box[0] + 32, box[3] - box[1] + 32), radius=6, fill=(0, 0, 0, 160))
    draw.multiline_text((20 - box[0], 20 - box[1]), block, font=font, spacing=spacing,
                        fill="white", stroke_width=1, stroke_fill=(0, 0, 0, 255))
    return layer
