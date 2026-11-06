"""🖼️XH-宫格故事板三件套

把社区包 `ComfyUI-Storyboard-Tools` 的三个节点做成 XH 家族版（2026-10-09）。
原包来源：桌面备份 `B站up\\FaboroHacks\\ComfyUI资源\\康菲节点备份_20260811\\
custom_nodes\\ComfyUI-Storyboard-Tools`，**核心算法逐条照搬**（不改动计算逻辑），
保证装了旧工作流的人能 1:1 平替，出图结果一致。

三件套与典型用法：
  ① 🖼️XH-宫格底板  (XHStoryboardGrid)
       生成「拼图底板」：白边框 + 灰格子，供 Krea2 / SD 的局部重绘（inpaint）
       往每个格子里画不同镜头。
  ② 🖼️XH-图像对比度 (XHImageContrast)
       中段 0.5 线性拉伸。原版内部**故意打了 0.25 折**防死黑，这里把折扣
       做成可调的 `strength`（默认 0.25 = 原版行为）。
  ③ 🖼️XH-宫格切图  (XHStoryboardPanelCrop)
       把生成好的整张宫格按格子切开成 IMAGE batch，每格可内缩去边框、
       再转成目标比例；另出一张带彩色参考线的预览图，方便调 offset。

── 比原版多出来的（XH 增值，都不改变默认行为）────────────────────
  · 底板：`layout_mode` 可「按格数自动」或「手动指定列×行」；
           格数上限 12 → 24（自动版式表同步扩充）；
           多输出一路 `cell_mask`（格内=1、边框=0）→ 直接接 inpaint 的蒙版口，
           原版只能靠 `transparent_cells` 出 RGBA（很多节点吃不了 4 通道）；
           多输出一路 `info` 文本，一眼看清列×行/格子尺寸。
  · 对比度：多一个 `brightness` 微调；`strength` 把原版写死的 0.25 折扣开放。
  · 切图：多一个 `order`（行优先 / 列优先）；多输出 `panel_count` 面板数，
           方便接「🖼️XH-图像按序取」或循环次数。

⚠️ 术语/约定
  · IMAGE 张量形状固定 [B,H,W,C]，C=3 或 4；MASK 是 [B,H,W]。
  · 缩放一律走 torch 的 interpolate（与原版一致），不引入 PIL，避免结果漂移。
"""

import torch


# ────────────────────────────────────────────────────────────────────────────
# ① 🖼️XH-宫格底板
# ────────────────────────────────────────────────────────────────────────────
class XHStoryboardGrid:
    """生成宫格底板：白分隔线 + 灰格子（可选 RGBA 让格内透明）。"""

    # 自动版式表：格数 → (列, 行)。原版只到 12 格，这里扩到 24 格。
    @staticmethod
    def _auto_layout(num_panels):
        if num_panels <= 1:
            return 1, 1
        if num_panels == 2:
            return 2, 1
        if num_panels <= 4:
            return 2, 2
        if num_panels <= 6:
            return 3, 2
        if num_panels <= 8:
            return 4, 2
        if num_panels <= 9:
            return 3, 3
        if num_panels <= 12:
            return 4, 3
        if num_panels <= 16:
            return 4, 4
        if num_panels <= 20:
            return 5, 4
        return 6, 4

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "width": ("INT", {
                    "default": 2048, "min": 64, "max": 8192, "step": 16,
                    "tooltip": "【📐 底板宽度】像素。喂图模型建议取 16 的倍数。 | English: grid width",
                }),
                "height": ("INT", {
                    "default": 1152, "min": 64, "max": 8192, "step": 16,
                    "tooltip": "【📐 底板高度】像素。 | English: grid height",
                }),
                "layout_mode": (["auto", "manual"], {
                    "default": "auto",
                    "tooltip": (
                        "【🧩 排版方式】\n"
                        "· auto：按「格数」自动定列×行（4→2×2、6→3×2、8→4×2、9→3×3、12→4×3、16→4×4）\n"
                        "· manual：自己填「列数 / 行数」\n"
                        "| English: auto by panel count, or manual columns x rows"
                    ),
                }),
                "num_panels": ("INT", {
                    "default": 4, "min": 1, "max": 24, "step": 1,
                    "tooltip": "【🔢 格数】仅「排版方式 = auto」时生效。 | English: number of panels",
                }),
                "columns": ("INT", {
                    "default": 2, "min": 1, "max": 12, "step": 1,
                    "tooltip": "【🔢 列数】仅「排版方式 = manual」时生效。 | English: columns (manual only)",
                }),
                "rows": ("INT", {
                    "default": 2, "min": 1, "max": 12, "step": 1,
                    "tooltip": "【🔢 行数】仅「排版方式 = manual」时生效。 | English: rows (manual only)",
                }),
                "border_thickness": ("INT", {
                    "default": 4, "min": 0, "max": 64, "step": 2,
                    "tooltip": "【▮ 边框粗细】分隔线的像素宽度（实际线宽约它的一半，居中画在格边界上）。\n"
                               "| English: border thickness in pixels",
                }),
                "background_gray_value": ("INT", {
                    "default": 25, "min": 0, "max": 255, "step": 1,
                    "tooltip": "【🌑 格子灰度】0=纯黑格，255=纯白格。重绘时格子越暗，模型越容易当成「要画的区域」。\n"
                               "| English: gray value of cell background (0-255)",
                }),
                "invert_colors": ("BOOLEAN", {
                    "default": False,
                    "tooltip": "【🔄 反色】把边框与格子的明暗对调（白底黑线 ⇄ 黑底白线）。\n"
                               "| English: invert border / cell colors",
                }),
                "cell_alpha": ("BOOLEAN", {
                    "default": False,
                    "tooltip": (
                        "【◻ 格内透明（RGBA）】输出 4 通道：边框不透明、格内全透明。\n"
                        "⚠ 很多节点吃不下 4 通道图；只是想要蒙版的话，关掉它、用下面的 cell_mask 输出更稳。\n"
                        "| English: output RGBA with transparent cells"
                    ),
                }),
            },
        }

    RETURN_TYPES = ("IMAGE", "MASK", "STRING")
    RETURN_NAMES = ("image", "cell_mask", "info")
    FUNCTION = "generate"
    CATEGORY = "🔁XH/Image"
    DESCRIPTION = (
        "【🖼️ 宫格底板】生成一张「白边框 + 灰格子」的拼图底板，供局部重绘往每格画不同镜头。\n"
        "比原版多两路输出：cell_mask（格内=1，可直接接 inpaint 蒙版口）与 info（列×行 / 格子尺寸）。\n"
        "排版可「按格数自动」或「手动列×行」。"
    )

    def generate(self, width, height, layout_mode, num_panels, columns, rows,
                 border_thickness, background_gray_value, invert_colors, cell_alpha):
        # ① 定版式
        if layout_mode == "manual":
            cols, rws = max(1, int(columns)), max(1, int(rows))
            total = cols * rws
        else:
            cols, rws = self._auto_layout(int(num_panels))
            total = max(1, int(num_panels))

        # ② 底板：1.0 = 边框（白），0.0 = 格子（待填灰）
        grid_map = torch.ones((height, width), dtype=torch.float32)
        bg = background_gray_value / 255.0

        cell_w = width / cols
        cell_h = height / rws
        half = border_thickness / 2

        for r in range(rws):
            for c in range(cols):
                idx = r * cols + c
                if idx >= total:          # 自动模式下格数不满一整排时，多出来的格子留白不挖空
                    continue
                x0 = int(round(c * cell_w + half))
                y0 = int(round(r * cell_h + half))
                x1 = int(round((c + 1) * cell_w - half))
                y1 = int(round((r + 1) * cell_h - half))
                # 外边界贴死画布，避免四周出现半条边框
                if c == 0:
                    x0 = 0
                if r == 0:
                    y0 = 0
                if c == cols - 1:
                    x1 = width
                if r == rws - 1:
                    y1 = height
                grid_map[y0:y1, x0:x1] = 0.0

        final = torch.where(grid_map == 1.0,
                            torch.tensor(1.0, dtype=torch.float32),
                            torch.tensor(bg, dtype=torch.float32))
        if invert_colors:
            final = 1.0 - final

        # ③ 蒙版（XH 新增）：格内 = 1（可重绘），边框 = 0
        cell_mask = torch.where(grid_map == 1.0,
                                torch.tensor(0.0, dtype=torch.float32),
                                torch.tensor(1.0, dtype=torch.float32))
        if invert_colors:
            cell_mask = 1.0 - cell_mask

        # ④ 出图：3 通道 RGB，或 4 通道 RGBA
        rgb = final.unsqueeze(-1).repeat(1, 1, 3)
        if cell_alpha:
            alpha = torch.where(grid_map == 1.0,
                                torch.tensor(1.0, dtype=torch.float32),
                                torch.tensor(0.0, dtype=torch.float32))
            if invert_colors:
                alpha = 1.0 - alpha
            out = torch.cat([rgb, alpha.unsqueeze(-1)], dim=-1)
        else:
            out = rgb
        out = out.unsqueeze(0)                 # [1,H,W,C]
        cell_mask = cell_mask.unsqueeze(0)     # [1,H,W]

        cw = int(round(cell_w)) - border_thickness
        ch = int(round(cell_h)) - border_thickness
        info = (f"{cols}×{rws} · 共 {total} 格 · 单格约 {cw}×{ch} · "
                f"边框 {border_thickness}px · 格子灰度 {background_gray_value}")

        return (out, cell_mask, info)


# ────────────────────────────────────────────────────────────────────────────
# ② 🖼️XH-图像对比度
# ────────────────────────────────────────────────────────────────────────────
class XHImageContrast:
    """中段 0.5 线性拉伸做对比度（原版行为 = strength 0.25）。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE", {
                    "tooltip": "【🖼️ 输入图像】通常是宫格底板或生成好的整张宫格。 | English: input image",
                }),
                "contrast": ("FLOAT", {
                    "default": 1.0, "min": 0.5, "max": 1.5, "step": 0.001,
                    "tooltip": "【◑ 对比度】1.0 = 原样；>1 拉开明暗，<1 压平。 | English: contrast (1.0 = unchanged)",
                }),
                "brightness": ("FLOAT", {
                    "default": 0.0, "min": -0.5, "max": 0.5, "step": 0.001,
                    "tooltip": "【☀ 亮度】XH 新增。在对比度之后整体加/减，0 = 不动。 | English: brightness offset",
                }),
                "strength": ("FLOAT", {
                    "default": 0.25, "min": 0.0, "max": 1.0, "step": 0.01,
                    "tooltip": (
                        "【🎚 作用强度】XH 新增，把原版写死的折扣开放出来：\n"
                        "  实际倍率 = 1 + (对比度 - 1) × strength\n"
                        "· 0.25 = 原版默认（柔和，暗部不轻易死黑）\n"
                        "· 1.00 = 完全按滑块来（最猛，容易死黑/过曝）\n"
                        "· 0.00 = 完全不生效\n"
                        "| English: how much of the contrast slider is actually applied"
                    ),
                }),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    FUNCTION = "adjust"
    CATEGORY = "🔁XH/Image"
    DESCRIPTION = (
        "【🖼️ 图像对比度】以 0.5 为中点做线性拉伸，再可叠加一点亮度偏移。\n"
        "默认 strength=0.25 与原版 Storyboard-Tools 完全一致（柔和、不死黑）；拉到 1.0 才是「所见即所得」。"
    )

    def adjust(self, image, contrast, brightness=0.0, strength=0.25):
        midpoint = 0.5
        soft = 1.0 + (contrast - 1.0) * strength
        out = (image - midpoint) * soft + midpoint
        if brightness:
            out = out + brightness
        return (torch.clamp(out, 0.0, 1.0),)


# ────────────────────────────────────────────────────────────────────────────
# ③ 🖼️XH-宫格切图
# ────────────────────────────────────────────────────────────────────────────
class XHStoryboardPanelCrop:
    """按列×行切开宫格 → IMAGE batch，每格可内缩、可转目标比例。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE", {
                    "tooltip": "【🖼️ 输入宫格】生成好的整张宫格图。 | English: generated storyboard grid",
                }),
                "columns": ("INT", {
                    "default": 2, "min": 1, "max": 20, "step": 1,
                    "tooltip": "【🔢 列数】必须和底板/实际宫格的列数一致。 | English: columns",
                }),
                "rows": ("INT", {
                    "default": 2, "min": 1, "max": 20, "step": 1,
                    "tooltip": "【🔢 行数】必须和底板/实际宫格的行数一致。 | English: rows",
                }),
                "shave_edges_pixels": ("INT", {
                    "default": 4, "min": 0, "max": 50, "step": 1,
                    "tooltip": "【✂ 内缩像素】每格四边各切掉这么多像素，用来去掉底板边框/接缝。\n"
                               "| English: shave N pixels off each panel edge",
                }),
                "offset_y": ("INT", {
                    "default": 0, "min": -500, "max": 500, "step": 1,
                    "tooltip": "【↕ 纵向偏移】整张网格上下平移，用来对齐没画正的宫格。 | English: vertical offset",
                }),
                "offset_x": ("INT", {
                    "default": 0, "min": -500, "max": 500, "step": 1,
                    "tooltip": "【↔ 横向偏移】整张网格左右平移。 | English: horizontal offset",
                }),
                "target_aspect_ratio": ([
                    "original_proportions",
                    "1:1 (Square)",
                    "16:9 (Widescreen)",
                    "9:16 (Vertical)",
                    "21:9 (Ultrawide)",
                ], {
                    "default": "16:9 (Widescreen)",
                    "tooltip": (
                        "【📐 目标比例】\n"
                        "· original_proportions：保持格子原比例，只做内缩、不缩放\n"
                        "· 其余：把每格调整成该比例（配合「填充方式」）\n"
                        "| English: target aspect ratio per panel"
                    ),
                }),
                "padding_mode": (["center_crop_zoom", "letterbox_black"], {
                    "default": "center_crop_zoom",
                    "tooltip": (
                        "【🖼 填充方式】只在「目标比例 ≠ original_proportions」时生效：\n"
                        "· center_crop_zoom：居中裁切后放大（填满，不黑边，会裁掉一点画面）\n"
                        "· letterbox_black：整格缩放后上下补黑边（不裁画面，但有黑边）\n"
                        "| English: crop-to-fill or pad with black bars"
                    ),
                }),
                "order": (["row_major", "column_major"], {
                    "default": "row_major",
                    "tooltip": (
                        "【🔢 输出顺序】XH 新增。\n"
                        "· row_major：行优先（左上→右上→第二行…）＝ 原版顺序\n"
                        "· column_major：列优先（左上→左下→第二列…）\n"
                        "| English: output order of the panels"
                    ),
                }),
            },
        }

    RETURN_TYPES = ("IMAGE", "IMAGE", "INT")
    RETURN_NAMES = ("images", "grid_preview", "panel_count")
    FUNCTION = "crop"
    CATEGORY = "🔁XH/Image"
    DESCRIPTION = (
        "【🖼️ 宫格切图】把整张宫格按列×行切开成 IMAGE batch。\n"
        "每格先内缩 shave 去掉框，再转成目标比例（居中裁切放大 / 补黑边）。\n"
        "第二路 grid_preview 是带黄/红/青参考线的预览图，用来核对 offset 对不对。\n"
        "XH 新增：order 可改列优先，另输出 panel_count 面板数。"
    )

    def crop(self, image, columns, rows, shave_edges_pixels, offset_y, offset_x,
             target_aspect_ratio, padding_mode, order="row_major"):
        batch_size, height, width, channels = image.shape

        # ── 预览图：外框黄 / 分割线红 / 内缩线青（原版配色，照搬）──────────
        preview = image.clone()
        shave = int(shave_edges_pixels)
        if shave > 0:
            preview[:, :shave, :, 0:2] = 1.0
            preview[:, :shave, :, 2] = 0.0
            preview[:, -shave:, :, 0:2] = 1.0
            preview[:, -shave:, :, 2] = 0.0
            preview[:, :, :shave, 0:2] = 1.0
            preview[:, :, :shave, 2] = 0.0
            preview[:, :, -shave:, 0:2] = 1.0
            preview[:, :, -shave:, 2] = 0.0

        seg_w = width / columns
        seg_h = height / rows

        def box(r, c):
            """第 r 行第 c 列的格边界（含 offset，且最右/最下贴死画布）。"""
            x0 = int(round(c * seg_w)) + offset_x
            x1 = int(round((c + 1) * seg_w)) + offset_x
            y0 = int(round(r * seg_h)) + offset_y
            y1 = int(round((r + 1) * seg_h)) + offset_y
            if c == columns - 1:
                x1 = width
            if r == rows - 1:
                y1 = height
            return x0, x1, y0, y1

        for r in range(rows):
            for c in range(columns):
                x0, x1, y0, y1 = box(r, c)
                if 0 <= x0 < width:                       # 竖向分割线（红）
                    preview[:, :, max(0, x0 - 1):min(width, x0 + 2), 0] = 1.0
                    preview[:, :, max(0, x0 - 1):min(width, x0 + 2), 1:] = 0.0
                if 0 <= y0 < height:                      # 横向分割线（红）
                    preview[:, max(0, y0 - 1):min(height, y0 + 2), :, 0] = 1.0
                    preview[:, max(0, y0 - 1):min(height, y0 + 2), :, 1:] = 0.0

                if shave > 0 and (x1 - x0) > shave * 2 and (y1 - y0) > shave * 2:
                    l, rr = x0 + shave, x1 - shave
                    t, b = y0 + shave, y1 - shave
                    if 0 <= l < width:                    # 内缩线（青）
                        preview[:, y0:y1, l, 2] = 1.0
                        preview[:, y0:y1, l, 0:2] = 0.0
                    if 0 <= rr < width:
                        preview[:, y0:y1, rr, 2] = 1.0
                        preview[:, y0:y1, rr, 0:2] = 0.0
                    if 0 <= t < height:
                        preview[:, t, x0:x1, 2] = 1.0
                        preview[:, t, x0:x1, 0:2] = 0.0
                    if 0 <= b < height:
                        preview[:, b, x0:x1, 2] = 1.0
                        preview[:, b, x0:x1, 0:2] = 0.0

        # ── 正式切图 ────────────────────────────────────────────────────────
        ratios = {
            "1:1 (Square)": 1.0,
            "16:9 (Widescreen)": 16.0 / 9.0,
            "9:16 (Vertical)": 9.0 / 16.0,
            "21:9 (Ultrawide)": 21.0 / 9.0,
        }

        # 输出顺序：行优先（原版）或列优先（XH 新增）
        cells = [(r, c) for r in range(rows) for c in range(columns)]
        if order == "column_major":
            cells = [(r, c) for c in range(columns) for r in range(rows)]

        slices = []
        for b in range(batch_size):
            img = image[b]
            for (r, c) in cells:
                x0, x1, y0, y1 = box(r, c)
                # 钳到画布内，防越界索引
                x0 = max(0, min(width, x0))
                x1 = max(0, min(width, x1))
                y0 = max(0, min(height, y0))
                y1 = max(0, min(height, y1))
                if c == columns - 1:
                    x1 = width
                if r == rows - 1:
                    y1 = height

                # 目标尺寸要在「内缩之前」按原格算，否则每格会越切越小
                t_w = x1 - x0
                t_h = y1 - y0

                cropped = img[y0:y1, x0:x1, :]
                if shave > 0 and cropped.shape[0] > shave * 2 and cropped.shape[1] > shave * 2:
                    cropped = cropped[shave:-shave, shave:-shave, :]

                ch, cw, cc = cropped.shape
                if ch <= 0 or cw <= 0:
                    continue

                if target_aspect_ratio == "original_proportions":
                    final = cropped
                elif padding_mode == "letterbox_black":
                    ratio = ratios[target_aspect_ratio]
                    t_h = int(round(t_w / ratio))
                    src = cropped.permute(2, 0, 1).unsqueeze(0)
                    th_pad = int(round(t_w * (ch / cw)))
                    res = torch.nn.functional.interpolate(
                        src, size=(th_pad, t_w), mode="bicubic", align_corners=True)
                    pad = t_h - th_pad
                    if pad > 0:
                        res = torch.nn.functional.pad(
                            res, (0, 0, pad // 2, pad - pad // 2),
                            mode="constant", value=0.0)
                    slices.append(res.squeeze(0).permute(1, 2, 0).unsqueeze(0))
                    continue
                else:                                     # center_crop_zoom
                    ratio = ratios[target_aspect_ratio]
                    t_h = int(round(t_w / ratio))
                    if (cw / ch) > ratio:                 # 偏宽 → 裁左右
                        nw = int(round(ratio * ch))
                        final = cropped[:, (cw - nw) // 2:(cw - nw) // 2 + nw, :]
                    else:                                 # 偏高 → 裁上下
                        nh = int(round(cw / ratio))
                        final = cropped[(ch - nh) // 2:(ch - nh) // 2 + nh, :, :]

                # 放大时补一道轻量锐化（照搬原版，抵消 bicubic 的糊）
                src = final.permute(2, 0, 1).unsqueeze(0)
                res = torch.nn.functional.interpolate(
                    src, size=(t_h, t_w), mode="bicubic", align_corners=True)
                if t_w > cw:
                    res = torch.nn.functional.pad(res, (1, 1, 1, 1), mode="replicate")
                    kernel = torch.tensor(
                        [[0.0, -0.1, 0.0], [-0.1, 1.4, -0.1], [0.0, -0.1, 0.0]],
                        device=src.device, dtype=src.dtype).view(1, 1, 3, 3).repeat(cc, 1, 1, 1)
                    res = torch.nn.functional.conv2d(res, kernel, groups=cc)
                slices.append(torch.clamp(res, 0.0, 1.0).squeeze(0).permute(1, 2, 0).unsqueeze(0))

        out = torch.cat(slices, dim=0) if slices else image
        return (out, preview, int(out.shape[0]))


NODE_CLASS_MAPPINGS = {
    "XHStoryboardGrid": XHStoryboardGrid,
    "XHImageContrast": XHImageContrast,
    "XHStoryboardPanelCrop": XHStoryboardPanelCrop,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "XHStoryboardGrid": "🖼️XH-宫格底板",
    "XHImageContrast": "🖼️XH-图像对比度",
    "XHStoryboardPanelCrop": "🖼️XH-宫格切图",
}
