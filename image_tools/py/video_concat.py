"""
🔁 XH-分段拼接（XHSegmentConcat）

把多段 IMAGE 批**按帧序首尾相接**（torch.cat），用于长视频分段生成后的合并。

── 它不是「重新生成」────────────────────────────────────────────
只是把几段已有的图像批连成一条：不重采样、不重新编码、零画质损失。
帧率是在「加载」那一刻就定死的，本节点不改帧率。

── 为什么要带校验 ────────────────────────────────────────────────
长视频分段最怕接缝错位：某一段多一帧 / 少一帧，拼出来就会「跳一下」。
所以本节点会拿每段实际帧数和「每段应该多少帧」比对：
  · 对不上 → 直接红字报错，点名是哪一段、多了还是少了
  · 尺寸不一致 → 也报错（torch.cat 本来就会崩，提前说清比崩了强）
把 expected_frames 接 🔁XH-帧数对齐 的 frame_count，就形成闭环校验。

── 用法 ──────────────────────────────────────────────────────────
images_1 必接，images_2 … images_12 可选（接几段拼几段）。
段数超过 12 时，可以先两两拼、再拼结果（本节点输出也是 IMAGE，可串联）。
"""

import torch

MAX_SEGMENTS = 12


class XHSegmentConcat:
    """多段 IMAGE → 一条 IMAGE（首尾相接，零损失），并校验每段帧数。"""

    @classmethod
    def INPUT_TYPES(cls):
        required = {
            "images_1": ("IMAGE", {
                "tooltip": (
                    "【🎬 第 1 段】必须接。后面 images_2、images_3… 按顺序接就是拼接顺序。\n"
                    "⚠️ 顺序 = 接口编号顺序，不是接线先后。"
                ),
            }),
        }
        optional = {}
        for i in range(2, MAX_SEGMENTS + 1):
            optional[f"images_{i}"] = ("IMAGE", {
                "tooltip": f"【🎬 第 {i} 段】可选。接了就按顺序拼在后面；没接就跳过。",
            })
        optional["expected_frames"] = ("INT", {
            "default": 0, "min": 0, "max": 2 ** 31 - 1, "step": 1,
            "tooltip": (
                "【✅ 每段应该多少帧】用来校验（填 0 = 不校验，直接拼）。\n"
                "· 接 🔁XH-帧数对齐 的 frame_count（H3 的 5 秒 = 124 帧）\n"
                "· 某一段帧数对不上 → 红字报错并点名，防止接缝漏帧/多帧\n"
                "⚠️ 这是「保险丝」：宁可报错，也别让你拼出一条接缝跳动的视频。"
            ),
        })
        return {"required": required, "optional": optional}

    RETURN_TYPES = ("IMAGE", "INT", "STRING")
    RETURN_NAMES = ("images", "frame_count", "report")
    FUNCTION = "concat"
    CATEGORY = "🔁XH/Video"
    DESCRIPTION = (
        "【干什么】把多段图像批首尾相接拼成一条（torch.cat），给长视频分段生成收尾。\n"
        "【不是什么】不是重新生成、不重采样、不改帧率 —— 只是把已有画面连起来，零画质损失。\n"
        "【怎么用】images_1 必接，images_2…images_12 按编号顺序接（编号 = 拼接顺序）。\n"
        "【校验】expected_frames 接 🔁XH-帧数对齐 的 frame_count：\n"
        "· 每段帧数必须等于它，否则红字报错并点名哪一段多了/少了\n"
        "· 高宽或通道数不一致也报错（torch.cat 本来就会崩，提前说清）\n"
        "· 填 0 = 关掉校验，直接拼\n"
        "【输出】images（拼好的一条）· frame_count（总帧数）· report（每段帧数一览）\n"
        "⚠️ 段数超过 12：先两两拼，再把结果当一段继续拼（输出也是 IMAGE，可串联）。"
    )

    def concat(self, images_1, expected_frames=0, **kwargs):
        # ── 收集所有接了的段（按编号顺序）──────────────────────────
        segs = [images_1]
        for i in range(2, MAX_SEGMENTS + 1):
            v = kwargs.get(f"images_{i}")
            if v is not None:
                segs.append(v)

        try:
            exp = int(expected_frames)
        except (TypeError, ValueError):
            exp = 0
        if exp < 0:
            exp = 0

        # ── 逐段体检 ───────────────────────────────────────────────
        ref_hw = None
        ref_c = None
        lines = []
        bad = []

        for idx, seg in enumerate(segs, start=1):
            if seg is None:
                continue
            if seg.dim() != 4:
                raise ValueError(
                    f"第 {idx} 段不是合法的图像批（维度 {seg.dim()}，应为 4：[帧数,高,宽,通道]）。"
                )
            n, h, w, c = seg.shape[0], seg.shape[1], seg.shape[2], seg.shape[3]
            if ref_hw is None:
                ref_hw, ref_c = (h, w), c
            elif (h, w) != ref_hw or c != ref_c:
                raise ValueError(
                    f"第 {idx} 段尺寸和第 1 段对不上，拼不了：\n"
                    f"· 第 1 段：{ref_hw[1]}×{ref_hw[0]}、{ref_c} 通道\n"
                    f"· 第 {idx} 段：{w}×{h}、{c} 通道\n"
                    f"→ 请让所有段的分辨率和通道数一致（在生成节点里统一尺寸）。"
                )

            if exp > 0 and n != exp:
                diff = n - exp
                bad.append(
                    f"· 第 {idx} 段：{n} 帧（应为 {exp} 帧，{'多' if diff > 0 else '少'}了 {abs(diff)} 帧）"
                )
            lines.append(f"第 {idx} 段：{n} 帧")

        if bad:
            raise ValueError(
                f"有 {len(bad)} 段的帧数不等于「每段应该 {exp} 帧」，拼出来接缝会跳动：\n"
                + "\n".join(bad)
                + f"\n→ 检查：每段是否都用了同一个 frame_count 去切；"
                f"是否中途改过帧率（改帧率 = 段边界整体错位）。"
            )

        # ── 拼接 ───────────────────────────────────────────────────
        if len(segs) == 1:
            out = segs[0]
        else:
            try:
                out = torch.cat(segs, dim=0)
            except Exception as e:                                  # noqa: BLE001
                raise ValueError(
                    f"拼接失败（{type(e).__name__}: {e}）。\n"
                    f"各段帧数：{', '.join(lines)}"
                ) from None

        total = int(out.shape[0])
        head = f"共 {len(segs)} 段 → {total} 帧"
        if exp > 0:
            head += f"（每段 {exp} 帧 ✅ 校验通过）"
        report = head + "\n" + "\n".join(lines)
        return (out, total, report)


NODE_CLASS_MAPPINGS = {"XHSegmentConcat": XHSegmentConcat}
NODE_DISPLAY_NAME_MAPPINGS = {"XHSegmentConcat": "🔁XH-分段拼接"}
