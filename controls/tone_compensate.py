# 🔁XH-色调补偿（接缝）（XH 家族）
#
# 对照第三方包 ComfyUI-MiniMaxH3-ToneCompensate 的 `MiniMaxH3ToneCompensate` 做的 XH 版（2026-09-30）。
#
# 它解决什么问题：H3 每段生成出来的画面会比「锚定的关键帧」**偏暗 / 偏色**，
# 于是多段续接拼起来时，接缝处会出现一次亮度/色调跳变（一段比一段暗）。
# 本节点用「上一段尾部 N 帧」对着「本段头部 N 帧」把这个偏置估出来，再从本段整段里扣掉。
#
# 🔴 接线要点（最容易搞错的三处）
#   · source = **上一段**的帧（可以直接给整段，内部自动只取尾部 overlap 帧）
#   · target = **本段**生成的帧（要被修的那一段）
#   · overlap = **关键帧的帧数**，不是你整段的帧数！
#       只锚了 1 帧尾帧（AddGuide frame_idx=0 单帧） → 填 1
#       锚了 5 帧的小片段                          → 填 5
#       锚了 2 秒（24fps ⇒ 48 帧）                 → 填 48
#     填错不会报错、但会静默算歪 —— 本节点会主动提示。
#   · 输出 = 补偿后的本段帧序列 ⇒ 拿它去「合成视频」，并取尾帧传给下一段。
#
# 比原版多做的事
#   · **strength 补偿强度**（0~1）：不想 100% 拉平就调小，默认 1.0 与原版结果一致；
#   · overlap 填超了**自动钳到可用帧数**，并在控制台告诉你是哪边帧数不够；
#   · 估到的偏置过大时**主动告警**（说明两段内容差太多，多半是锚定帧没真接上）；
#   · 多一个 **info 文字输出**：模式 / 实际用了几帧 / 估到的偏置 / 强度 —— 接「显示文本」就能看。
#
# 家族规范：class_type 与 web/xh_tone.js 里的 NODE_TYPE 必须逐字一致。
# 🔴 FLOAT/INT 必须显式写 min/max（不写就是默认 0~2048，强度只能填 0~1 会填不进）。

import torch

_LUT_TABLE = 4096   # lut 模式的稠密查找表分辨率


def _fit_affine(src, tgt):
    """逐通道回归 s = A*g + C，返回 [1,1,1,C] 的 (gain, bias)。"""
    c_out = src.shape[-1]
    gain = torch.ones(1, 1, 1, c_out, dtype=torch.float32, device=src.device)
    bias = torch.zeros(1, 1, 1, c_out, dtype=torch.float32, device=src.device)
    for c in range(c_out):
        s = src[..., c].reshape(-1).float()
        g = tgt[..., c].reshape(-1).float()
        gm, sm = g.mean(), s.mean()
        dg = g - gm
        den = (dg * dg).sum()
        if den < 1e-12:
            A, C = 1.0, float(sm - gm)
        else:
            A = float((dg * (s - sm)).sum() / den)
            C = float(sm - A * gm)
        if abs(A) < 1e-6:
            A = 1.0
        gain[0, 0, 0, c] = A
        bias[0, 0, 0, c] = C
    return gain, bias


def _monotone(ys):
    """把控制点压成非递减，防止噪声造成的分箱均值倒挂。"""
    v = ys.tolist()
    best = v[0]
    out = []
    for y in v:
        if y > best:
            best = y
        out.append(best)
    return torch.tensor(out, dtype=torch.float32, device=ys.device)


def _lut_control(s, g, bins):
    """按配对像素建控制点：每个真正出现过的生成值分箱存 (mean 生成值, mean 源值)。"""
    dev = g.device
    idx = torch.clamp(torch.floor(g * bins), 0, bins - 1).long()
    sums_s = torch.zeros(bins, dtype=torch.float32, device=dev)
    sums_g = torch.zeros(bins, dtype=torch.float32, device=dev)
    counts = torch.zeros(bins, dtype=torch.float32, device=dev)
    sums_s.index_add_(0, idx, s)
    sums_g.index_add_(0, idx, g)
    counts.index_add_(0, idx, torch.ones_like(idx, dtype=torch.float32))
    nz = counts > 0
    xs = (sums_g / counts)[nz]
    ys = (sums_s / counts)[nz]
    return xs, _monotone(ys)


def _linfit(x, y):
    """最小二乘直线 y = slope*x + intercept。"""
    xm, ym = x.mean(), y.mean()
    dx = x - xm
    den = (dx * dx).sum()
    if den < 1e-12:
        return 0.0, ym.item()
    slope = float((dx * (y - ym)).sum() / den)
    return slope, float(ym - slope * xm)


def _pwl(query, xs, ys):
    """分段线性求值：内部插值，两端用最外侧 K 点做稳健斜率外推。"""
    n = xs.numel()
    if n == 1:
        return torch.full_like(query, ys.item())
    k = min(5, n)
    ls, lb = _linfit(xs[:k], ys[:k])
    rs, rb = _linfit(xs[-k:], ys[-k:])
    i = torch.clamp(torch.searchsorted(xs, query), 1, n - 1)
    xl, xr = xs[i - 1], xs[i]
    yl, yr = ys[i - 1], ys[i]
    out = yl + (yr - yl) * (query - xl) / (xr - xl)
    left, right = query < xs[0], query > xs[-1]
    out = torch.where(left, ls * query + lb, out)
    out = torch.where(right, rs * query + rb, out)
    return out


def _apply_lut(x, xs, ys, table=_LUT_TABLE):
    """把控制点 LUT 应用到 x（取值 0~1）。"""
    dense = _pwl(torch.linspace(0, 1, table, device=x.device), xs, ys)
    idx = torch.clamp(torch.floor(x * table), 0, table - 1).long()
    return dense[idx]


class XHToneCompensate:
    """估计并扣除 H3 每段生成的色调偏置，消除多段续接处的亮度跳变。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "source": ("IMAGE", {
                    "tooltip": (
                        "**上一段**的帧（参考基准）。可以直接给整段，内部自动只取**尾部 overlap 帧**。\n"
                        "⚠️ 接反是最常见的坑：这里是上一段、不是本段。\n"
                        "循环首轮回传未建立时收到 None 会自动跳过（原样输出），不会报错。"
                    ),
                }),
                "target": ("IMAGE", {
                    "tooltip": (
                        "**本段**生成的帧，也就是要被修正的那一段。内部取它**头部 overlap 帧**去和 source 对齐。\n"
                        "补偿会作用在整段上，不只是头部。"
                    ),
                }),
                "mode": (["frame_shift", "gain_bias", "lut"], {
                    "default": "frame_shift",
                    "tooltip": (
                        "补偿算法：\n"
                        "· frame_shift（默认）：整体平移一个偏置值，最稳\n"
                        "· gain_bias：逐通道拟合 增益+偏置（s = A*g + C），能修轻微的对比度差\n"
                        "· lut：按亮度分箱建曲线，能修非线性偏色（hdr 感），代价是更容易过冲\n"
                        "⚠️ lut_bins 只对 lut 模式起作用。"
                    ),
                }),
                "overlap": ("INT", {
                    "default": 1, "min": 1, "max": 4096, "step": 1,
                    "tooltip": (
                        "**关键帧的帧数**，不是你整段的帧数！\n"
                        "· 只锚了 1 帧尾帧 → 填 1\n"
                        "· 锚了 5 帧小片段 → 填 5\n"
                        "· 锚了 2 秒（24fps = 48 帧）→ 填 48\n"
                        "⚠️ 填错不会报错、但会**静默算歪** —— 帧数不够时本节点会自动钳到可用帧数并在控制台说明。"
                    ),
                }),
                "strength": ("FLOAT", {
                    "default": 1.0, "min": 0.0, "max": 1.0, "step": 0.05,
                    "tooltip": (
                        "补偿强度。1.0 = 完全拉平（与原版效果一致）；"
                        "不想 100% 对齐就调小（如 0.6），保留一点段落自身的色调差异。\n"
                        "⚠️ 0 = 原样输出，等于这个节点没接。"
                    ),
                }),
                "lut_bins": ("INT", {
                    "default": 64, "min": 16, "max": 512, "step": 1,
                    "tooltip": (
                        "lut 模式的亮度分箱数。越多曲线越贴合细节，但太少噪点敏感、太多会过拟合。\n"
                        "⚠️ **只在 mode = lut 时生效**，另外两个模式完全不看它。"
                    ),
                }),
            },
        }

    RETURN_TYPES = ("IMAGE", "STRING")
    RETURN_NAMES = ("IMAGE", "info")
    FUNCTION = "compensate"
    CATEGORY = "🔁XH/工具"
    DESCRIPTION = (
        "色调补偿（接缝）：估计 H3 每段生成的色调偏置并从本段扣除，消除多段续接的亮度跳变。"
        "source=上一段帧，target=本段帧，overlap=关键帧帧数（不是整段帧数）。"
    )

    def compensate(self, source, target, mode, overlap, strength, lut_bins):
        if source is None:
            # 循环首轮回传未建立（current_value=None）⇒ 没有上一段可对齐，跳过补偿
            return (target, "[XH-色调补偿] 无 source（循环首轮回传未建立）⇒ 本轮跳过补偿，原样输出")
        src = source.float()
        tgt = target.float()
        n_src, n_tgt = int(src.shape[0]), int(tgt.shape[0])
        notes = []

        want = int(overlap)
        n = min(want, n_src, n_tgt)
        if want > n:
            notes.append(
                "overlap 填的是 %d，但可用帧只有 source %d / target %d —— 已按 %d 帧算。"
                "（overlap 要填「关键帧的帧数」，不是整段帧数）" % (want, n_src, n_tgt, n)
            )
        if n <= 0:
            return (target, "[XH-色调补偿] overlap 无有效帧，未做补偿，原样返回")

        fit_src = src[-n:]      # 上一段的最后 n 帧
        fit_tgt = tgt[:n]       # 本段的前 n 帧

        if mode == "frame_shift":
            drift = fit_tgt.mean(dim=(1, 2), keepdim=True) - fit_src.mean(dim=(1, 2), keepdim=True)
            full = tgt.clone()
            full[:n] = full[:n] - drift
            full[n:] = full[n:] - drift[-1]
            per = drift.abs().mean(dim=(0, 1)).reshape(-1)
            mag = float(drift.abs().mean())
            desc = "估计偏置 " + " ".join(
                "%s%+.3f" % (c, float(v)) for c, v in zip("RGBA", per)
            ) + "（正 = 本段偏亮，需减掉）"
        elif mode == "gain_bias":
            gain, bias = _fit_affine(fit_src, fit_tgt)
            if bool((gain <= 1e-3).any()):
                notes.append(
                    "gain_bias 算出的增益 ≤ 0（正常应该在 0.9~1.1 附近）—— 说明重叠区两段内容对不上，"
                    "已把异常通道的增益钳回 1.0，只补偏置"
                )
                gain = torch.where(gain <= 1e-3, torch.ones_like(gain), gain)
            full = gain * tgt + bias
            g = gain.reshape(-1)
            b = bias.reshape(-1)
            mag = float(bias.abs().mean())
            desc = "增益 " + "/".join("%.3f" % float(x) for x in g) + \
                   "，偏置 " + "/".join("%+.3f" % float(x) for x in b)
        elif mode == "lut":
            full = torch.empty_like(tgt)
            for c in range(tgt.shape[-1]):
                xs, ys = _lut_control(fit_src[..., c].reshape(-1),
                                      fit_tgt[..., c].reshape(-1), int(lut_bins))
                full[..., c] = _apply_lut(tgt[..., c], xs, ys)
            mag = float((full - tgt).abs().mean())
            desc = "色调曲线 LUT（%d 分箱）" % int(lut_bins)
        else:
            raise ValueError("[XH-色调补偿] 不认识的模式: %s" % mode)

        s = max(0.0, min(1.0, float(strength)))
        head = "[XH-色调补偿] 模式=%s 重叠 %d 帧（source 尾 %d / target 头 %d） 强度 %.2f | %s" % (
            mode, n, n, n, s, desc)

        if s <= 0.001:
            return (target, head + " | 强度为 0，未做补偿")

        if mag > 0.20:
            notes.append(
                "估计的色调差异偏大（平均 %.3f）—— 两段内容/色调差得多，"
                "多半是 source 不是真正的上一段，或锚定帧没接上，请检查接线" % mag
            )
        if s < 0.999:
            notes.append("强度 %.2f：只补偿了 %.0f%%" % (s, s * 100))

        if s >= 0.999:
            out = full
        else:
            out = tgt + (full - tgt) * s
        out = out.clamp_(0.0, 1.0).to(target.dtype)

        info = head + ("\n" + "\n".join("· " + x for x in notes) if notes else "")
        if notes:
            for x in notes:
                print(head + "\n  ↳ " + x)
        return (out, info)


NODE_CLASS_MAPPINGS = {"XHToneCompensate": XHToneCompensate}
NODE_DISPLAY_NAME_MAPPINGS = {"XHToneCompensate": "🔁XH-色调补偿"}
