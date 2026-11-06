# 🔁XH-H3 latent接续（XH 家族）
#
# 解决 H3 长视频多段续接的接缝闪动：把「上一段 sampler 输出的 latent 尾 N token」
# 直接抄进「本段目标 latent 的头 N token」，配合 noise_mask=0 锁死 +
# Drift-Control AV 硬锁/渐隐，在 latent 域锚定接缝，不经过 RGB→VAE 回编码
# （所以没有像素域那次漂移，比 AddGuide 稳得多）。
#
# 这是把 ComfyUI-MiniMaxH3-TimelineDirector 的 MiniMaxH3FiniteLatentContinuation
# 思路搬进 XH 家族：核心两行逻辑（_apply_linear_temporal_noise_mask +
# install_drift_control_av_model）直接 import 导演台那两个**纯函数**，不抄代码
# （避免 GPL 代码纠缠、且单源好维护）。导演台没装时本节点只在真正用到时报错，
# 不拖垮整个 XH 包加载。
#
# 🔴 接线要点
#   · target_latent  = 本段的目标 latent（来自 MiniMaxH3ReferenceToVideo 的 latent 输出）
#   · previous_latent = **上一段** sampler 输出的 latent（接循环回传；首轮为 None）
#   · model / sigmas  = 喂给 sampler 的同一条 model / sigmas
#   · is_first        = 循环首轮（接 XHForLoopStart 的「首轮」）；首轮不续接，原样返回
#   · 输出 masked_target   → sampler 的 latent_image
#   · 输出 patched_model   → BasicGuider 的 model（clone 打补丁，不动原链）
#
# 🔴 配合循环怎么用
#   回传从「尾帧像素」改成「sampler 输出 latent」：XHForLoopEnd 的回传值(0) 接
#   SamplerCustomAdvanced 的 latent 输出，下一轮从 current_value(0) 进本节点。
#   首段全保留；后续每段裁掉前 overlap_frames 帧（那是上段尾的精确拷贝）再拼接。
#
# ⚠ overlap_frames：填 8 会被 _valid_guide_frames 砍成 5；要 ≥8 请填 22 / 39。

import os
import sys


def _find_td_dir():
    """上溯到 custom_nodes，找含 drift_control_av.py 的导演台目录。"""
    here = os.path.dirname(os.path.abspath(__file__))   # .../controls
    custom_nodes = os.path.dirname(os.path.dirname(here))
    guess = os.path.join(custom_nodes, "ComfyUI-MiniMaxH3-TimelineDirector")
    if os.path.isfile(os.path.join(guess, "drift_control_av.py")):
        return guess
    try:
        for name in os.listdir(custom_nodes):
            cand = os.path.join(custom_nodes, name)
            if os.path.isfile(os.path.join(cand, "drift_control_av.py")):
                return cand
    except OSError:
        pass
    return None


def _ensure_td_imports():
    """运行期把导演台目录加入 sys.path 并 import 两个纯函数。"""
    td = _find_td_dir()
    if td is None:
        raise RuntimeError(
            "[XH-H3 latent接续] 找不到 ComfyUI-MiniMaxH3-TimelineDirector 插件（本机应已安装）。"
            "若已卸载，请重装该插件，或把它的目录加到 sys.path。"
        )
    if td not in sys.path:
        sys.path.insert(0, td)
    try:
        from experimental_latent_guide import _apply_linear_temporal_noise_mask
        from drift_control_av import install_drift_control_av_model
    except Exception as _e:  # noqa: BLE001
        raise RuntimeError(
            "[XH-H3 latent接续] 导入导演台函数失败（需 ComfyUI-MiniMaxH3-TimelineDirector）：%s" % _e
        )
    return _apply_linear_temporal_noise_mask, install_drift_control_av_model


class XHH3LatentContinuation:
    """把上一段 latent 尾帧拷进本段开头并用 Drift-Control 锁接缝。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "positive": ("CONDITIONING", {
                    "tooltip": "条件（透传，本节点不改 conditioning）。",
                }),
                "target_latent": ("LATENT", {
                    "tooltip": "本段的目标 latent（来自 MiniMaxH3ReferenceToVideo 的 latent 输出）。",
                }),
                "previous_latent": ("LATENT", {
                    "tooltip": (
                        "**上一段** sampler 输出的 latent（接循环回传，走 XHForLoop 多路回传通道）。\n"
                        "首轮回传未建立时为 None，本节点会自动跳过续接、原样返回。"
                    ),
                }),
                "overlap_frames": ("INT", {
                    "default": 22, "min": 1, "max": 3592, "step": 1,
                    "tooltip": (
                        "接缝锚定的帧数。会被对齐到 1 或 5/22/39/56…\n"
                        "⚠️ 填 8 会被砍成 5；要 ≥8 请填 22（≈0.92s）或 39。"
                    ),
                }),
                "is_first": ("BOOLEAN", {
                    "default": True,
                    "label_on": "首轮(不续接)",
                    "label_off": "续接段",
                    "tooltip": "循环首轮 = 开（不续接，原样返回）。接 XHForLoopStart 的「首轮」。",
                }),
                "drift_control": ("BOOLEAN", {
                    "default": False,
                    "label_on": "开",
                    "label_off": "关",
                    "tooltip": (
                        "是否启用 Drift-Control AV 硬锁+渐隐。\n"
                        "关（默认）= 只做 latent 拷贝 + noise_mask 锁死，无需 sigmas，必定可跑；\n"
                        "开 = 额外用 Drift-Control 按 sigmas 调度硬锁接缝，必须把本节点的 model + sigmas 都接上，"
                        "否则报错。"
                    ),
                }),
            },
            "optional": {
                "model": ("MODEL", {
                    "tooltip": (
                        "喂给 sampler 的同一路 model（本节点会 clone 一份打补丁，不动原链）。\n"
                        "仅 drift_control=开 时需要；默认不接（关 drift_control 时留空即可）。"
                    ),
                }),
                "sigmas": ("SIGMAS", {
                    "tooltip": (
                        "喂给 sampler 的同一路 sigmas（Drift-Control 按调度算硬锁权重）。\n"
                        "仅 drift_control=开 时需要；默认不接（关 drift_control 时留空即可）。"
                    ),
                }),
            },
        }

    RETURN_TYPES = ("CONDITIONING", "LATENT", "MODEL")
    RETURN_NAMES = ("positive", "masked_target", "patched_model")
    FUNCTION = "execute"
    CATEGORY = "🔁XH/Video"
    DESCRIPTION = (
        "H3 长视频 latent 域接缝接续：把上一段 latent 尾帧抄进本段开头，"
        "noise_mask 锁死 + Drift-Control AV 硬锁渐隐，替代 AddGuide 像素锚定。"
    )

    def execute(self, positive, target_latent, previous_latent, model, sigmas,
                overlap_frames, is_first, drift_control):
        # 首轮或没有上一段 → 不续接，原样返回
        if bool(is_first) or previous_latent is None:
            return (positive, target_latent, model)

        apply_mask, install_dc = _ensure_td_imports()

        # 1) latent 域：上段尾 → 本段头 + noise_mask 锁死
        #    gradient=True = 头部从「完全锚定上段尾」线性渐变放开到「本段自由生成」
        #    = 平滑桥接过渡（不静止、不硬切），这是官方默认行为，最流畅。
        masked_target, details = apply_mask(
            target_latent=target_latent,
            source_latent=previous_latent,
            guide_frames=int(overlap_frames),
            include_audio=True,
            gradient=True,
            audio_soft_release=True,
        )

        # 2) Drift-Control AV 硬锁 + 锥形渐隐（prefix_steps = 抄来的 token 数）
        if bool(drift_control):
            patched_model = install_dc(
                model, masked_target, sigmas, prefix_steps=details["video_tokens"]
            )
        else:
            patched_model = model

        return (positive, masked_target, patched_model)


NODE_CLASS_MAPPINGS = {"XHH3LatentContinuation": XHH3LatentContinuation}
NODE_DISPLAY_NAME_MAPPINGS = {"XHH3LatentContinuation": "🔁XH-H3 latent接续"}
