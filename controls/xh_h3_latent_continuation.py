# 🔁XH-H3 latent接续（XH 家族 · 零第三方依赖版）
#
# 解决 H3 长视频多段续接的接缝闪动：把「上一段 sampler 输出的 latent 尾 N token」
# 直接抄进「本段目标 latent 的头 N token」，配合 noise_mask 锁死 +
# Drift-Control AV 硬锁/渐隐，在 latent 域锚定接缝，不经过 RGB→VAE 回编码
# （所以没有像素域那次漂移，比 AddGuide 稳得多）。
#
# 🔴 依赖声明（2026-10-23 重写）
#   本文件为 XH 家族自研实现，**不 import 任何第三方 custom_nodes 包**。
#   早期版本曾在运行期 `import` ComfyUI-MiniMaxH3-TimelineDirector 的两个纯函数，
#   而该插件及其上游（ethanfel/ComfyUI-MiniMaxH3-Contex-Loop）均为 GPL-3.0，
#   运行时 import 会把许可传染带进 XH 包的分发物，且未装该插件的机器直接不可用。
#   现已按同样的接口契约与数值语义重新实现，只用 ComfyUI 官方公开 API：
#     · comfy.nested_tensor.NestedTensor          —— H3 音视频嵌套 latent 容器
#     · comfy.ldm.minimax.model.FRAME_PER_TOKEN   —— H3 帧↔token 换算常量
#     · ModelPatcher.set_model_denoise_mask_function / add_wrapper_with_key
#     · comfy.patcher_extension.WrappersMP.APPLY_MODEL
#   以上 API 与官方自带节点（nodes_minimax_h3 / nodes_sparse_attention 等）
#   用法一致，属 ComfyUI 插件生态的标准做法。
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
# ⚠ overlap_frames：填 8 会被网格对齐砍成 5；要 ≥8 请填 22 / 39。
#
# ⚠ 与导演台（ComfyUI-MiniMaxH3-TimelineDirector）的关系：
#   本节点与它的 MiniMaxH3FiniteLatentContinuation 是**平级的两个独立实现**，
#   可以在同一台机器上共存。若同一条 model 上同时装了本节点的 Drift-Control 和
#   导演台的 Drift-Control，会按「后装者报错」处理（官方动态 denoise mask 本身
#   就不允许一个 model 挂两个）。

import math

import torch


# =====================================================================
# H3 音视频嵌套 latent 的结构工具
# =====================================================================

class _H3AVStream:
    """H3 AV latent 的帧↔token 换算、网格对齐与流校验。

    H3 把视频/音频打包成一个 nested latent：video 流 (B,24,T,H,W)，
    audio 流 (B,32,C,L)。token 网格为 17k+5（FRAME_PER_TOKEN=(1,4,4,4,4)
    每 5 个 token 覆盖 17 帧）。
    """

    #: 重叠帧数的合法网格：1 或 17k+5（5 / 22 / 39 / 56 …）
    GRID_BASE = 5
    GRID_STEP = 17

    @staticmethod
    def official_symbols():
        """延迟导入官方符号：没装 H3 支持的 ComfyUI 也不会拖垮整个 XH 包加载。"""
        from comfy.ldm.minimax.model import FRAME_PER_TOKEN
        from comfy.nested_tensor import NestedTensor
        from comfy.patcher_extension import WrappersMP
        return FRAME_PER_TOKEN, NestedTensor, WrappersMP

    @classmethod
    def align_frames(cls, requested):
        """把请求的重叠帧数向下对齐到合法网格（1 或 17k+5）。"""
        n = int(requested)
        if n < cls.GRID_BASE:
            return 1
        while n % cls.GRID_STEP != cls.GRID_BASE:
            n -= 1
        return max(1, n)

    @staticmethod
    def tokens_for_frames(frame_count):
        """帧数 → video token 数（H3 的 17k+5 网格：前 5 帧占 2 token，之后每 17 帧 5 token）。"""
        n = int(frame_count)
        if n <= 5:
            return 2
        return ((n - 5) // 17) * 5 + 2

    @staticmethod
    def frames_for_tokens(token_count, frame_per_token):
        """video token 数 → 帧数（FRAME_PER_TOKEN 的周期累积和）。"""
        period = len(frame_per_token)
        total = 0
        for k in range(int(token_count)):
            total += frame_per_token[k % period]
        return total

    @staticmethod
    def split_streams(latent, label):
        """从 LATENT dict 里取出 (video, audio) 两条嵌套流并做结构校验。"""
        samples = latent.get("samples") if isinstance(latent, dict) else None
        if samples is None or not callable(getattr(samples, "unbind", None)):
            raise ValueError(
                "%s 必须是 MiniMax H3 的音视频嵌套 latent（nested AV latent）。" % label
            )
        streams = tuple(samples.unbind())
        if len(streams) != 2:
            raise ValueError("%s 必须同时包含视频流与音频流。" % label)
        video, audio = streams
        if video.ndim != 5 or video.shape[1] != 24:
            raise ValueError("%s 不是合法的 H3 视频 latent（应为 [B,24,T,H,W]）。" % label)
        if audio.ndim != 4 or audio.shape[1] != 32:
            raise ValueError("%s 不是合法的 H3 音频 latent（应为 [B,32,C,L]）。" % label)
        return video, audio

    @staticmethod
    def audio_tokens_for_frames(frames, source_len, target_len):
        """音频重叠 token 数：按 40 token/s ÷ 24 fps 折算，并不超过任一端长度。"""
        return min(
            round(int(frames) * 40 / 24),
            int(source_len),
            int(target_len),
        )


# =====================================================================
# 重叠区搬运：上段尾部 → 本段头部 + noise_mask
# =====================================================================

def _carry_overlap_tail(target_latent, source_latent, overlap_frames,
                       gradient=True, include_audio=True, audio_soft_release=True):
    """把上一段 latent 的尾部搬进本段开头，并造出配套的 denoise mask。

    H3 的 sampler 把 noise_mask 的 0 读作「保留输入」、1 读作「全新生成」。
    搬过来的重叠区写 0（或 0→1 渐变），其余保持 1。
    mask 只开 1 通道 1×1 空间尺寸，ComfyUI 在采样前会自己展开到各流形状。
    返回 (新 latent dict, 细节 dict)，细节里的 video_tokens 供 Drift-Control 定前缀宽度。
    """
    frame_per_token, NestedTensor, _ = _H3AVStream.official_symbols()

    target_video, target_audio = _H3AVStream.split_streams(target_latent, "目标 latent")
    source_video, source_audio = _H3AVStream.split_streams(source_latent, "上段 latent")

    if tuple(target_video.shape[3:]) != tuple(source_video.shape[3:]):
        raise ValueError(
            "两段 latent 的空间尺寸不一致，无法搬运重叠区：%s -> %s"
            % (tuple(source_video.shape[3:]), tuple(target_video.shape[3:]))
        )

    actual_frames = _H3AVStream.align_frames(overlap_frames)
    video_tokens = _H3AVStream.tokens_for_frames(actual_frames)
    if video_tokens > int(source_video.shape[2]) or video_tokens > int(target_video.shape[2]):
        raise ValueError(
            "源或目标 latent 装不下 %d 帧的重叠区（需要 %d 个 video token）"
            % (actual_frames, video_tokens)
        )

    # ---- 视频：尾部逐值拷进头部 ----
    video = target_video.clone()
    tail = source_video[:1, :, -video_tokens:, :, :].to(
        device=video.device, dtype=video.dtype
    )
    video[:, :, :video_tokens, :, :] = tail.expand(video.shape[0], -1, -1, -1, -1)

    video_mask = torch_ones_like_tokens(target_video.shape[2], target_video.device)
    if gradient:
        video_ramp = torch_linspace(video_tokens, target_video.device)
    else:
        video_ramp = torch_zeros(video_tokens, target_video.device)
    video_mask[:, :, :video_tokens, :, :] = video_ramp.reshape(1, 1, -1, 1, 1)

    # ---- 音频：同步搬运，soft release 用余弦半窗渐隐 ----
    audio = target_audio.clone()
    audio_mask = torch.ones(
        (1, 1, 1, target_audio.shape[-1]),
        dtype=torch.float32,
        device=target_audio.device,
    )
    audio_tokens = 0
    if include_audio:
        audio_tokens = _H3AVStream.audio_tokens_for_frames(
            actual_frames, source_audio.shape[-1], target_audio.shape[-1]
        )
        if audio_tokens < 1:
            raise ValueError("源或目标的 H3 音频 latent 太短，凑不出固定音频重叠区")
        audio_tail = source_audio[:1, :, :, -audio_tokens:].to(
            device=audio.device, dtype=audio.dtype
        )
        audio[..., :audio_tokens] = audio_tail.expand(audio.shape[0], -1, -1, -1)
        audio_mask[..., :audio_tokens] = _audio_release_ramp(
            audio_tokens, gradient, audio_soft_release, target_audio.device
        ).reshape(1, 1, 1, -1)

    output = dict(target_latent)
    output["samples"] = NestedTensor((video, audio))
    output["noise_mask"] = NestedTensor((video_mask, audio_mask))

    details = {
        "frames": actual_frames,
        "video_tokens": video_tokens,
        "audio_tokens": audio_tokens,
        "video_mask_start": float(video_ramp[0].item()),
        "video_mask_end": float(video_ramp[-1].item()),
        "gradient": bool(gradient),
        "audio_soft_release": bool(audio_soft_release and include_audio),
    }
    return output, details


def torch_ones_like_tokens(token_count, device):
    return torch.ones((1, 1, int(token_count), 1, 1), dtype=torch.float32, device=device)


def torch_linspace(steps, device):
    return torch.linspace(0.0, 1.0, steps=int(steps), dtype=torch.float32, device=device)


def torch_zeros(steps, device):
    return torch.zeros(int(steps), dtype=torch.float32, device=device)


def _audio_release_ramp(audio_tokens, gradient, soft_release, device):
    """音频重叠区的权重曲线：硬锁 / 线性渐变 / 余弦渐隐三选一。"""
    if soft_release:
        # 末尾 taper_steps 个 token 走 0.5-0.5cos(pi*i/taper) 的余弦半窗
        taper = min(8, int(audio_tokens))
        ramp = torch_zeros(audio_tokens, device)
        idx = torch.arange(1, taper + 1, dtype=torch.float32, device=device)
        ramp[-taper:] = 0.5 - 0.5 * torch.cos(math.pi * idx / float(taper))
        return ramp
    if gradient:
        return torch_linspace(audio_tokens, device)
    return torch_zeros(audio_tokens, device)


# =====================================================================
# Drift-Control：按 sigma 调度动态收紧 video 前缀的 denoise 权重
# =====================================================================

_DRIFT_LOCK_KEY = "xh_h3_drift_control_av"
_DRIFT_TAPER = 4


def _schedule_ladder(sigmas):
    """把调度表整理成「有限、非负、去重、降序」的阶梯。"""
    if torch.is_tensor(sigmas):
        values = sigmas.detach().float().reshape(-1).cpu()
    else:
        values = sigmas or ()
    ladder = []
    for v in values:
        n = float(v)
        if math.isfinite(n) and n >= 0.0:
            ladder.append(n)
    return tuple(sorted(set(ladder), reverse=True))


def _next_rung(current_sigma, ladder):
    """当前 sigma 的下一级（更小）噪声档；找不到就返回 0。"""
    cur = float(current_sigma)
    if not math.isfinite(cur) or cur <= 0.0:
        return 0.0
    tol = max(1e-7, abs(cur) * 1e-6)
    for rung in ladder:
        if rung < cur - tol:
            return rung
    return 0.0


def _matched_ratio(current_sigma, ladder):
    """本步的硬锁强度 = 下一级 sigma / 当前 sigma，钳在 [0,1]。"""
    cur = float(current_sigma)
    if not math.isfinite(cur) or cur <= 0.0:
        return 0.0
    return max(0.0, min(1.0, _next_rung(cur, ladder) / cur))


def _prefix_ladder(prefix_steps, taper_steps):
    """前缀各 token 的硬锁权重：前 count-taper 个锁满 1.0，末尾 taper 个线性松脱。"""
    count = int(prefix_steps)
    taper = int(taper_steps)
    if count < 1:
        raise ValueError("Drift-Control 的前缀 token 数必须为正")
    if taper < 1 or taper > count:
        raise ValueError("Drift-Control 的渐隐 token 数必须落在前缀之内")
    ladder = [1.0] * (count - taper)
    ladder.extend(float(taper - i - 1) / float(taper) for i in range(taper))
    return tuple(ladder)


def _apply_prefix_weights(packed_mask, video_shape, ratio, prefix_steps):
    """在打包 mask 上重写 video 前缀权重，并返回量化后的 H3 版 video mask。

    ceil(x*256)/256 的量化是为了让 sampler 的混合结果与 H3 模型内部
    逐 token 的 timestep 标签描述同一个实时状态，两边不会各说各话。
    """
    if not torch.is_tensor(packed_mask) or packed_mask.ndim != 3:
        raise ValueError("Drift-Control 需要 [B,1,N] 形状的打包 denoise mask")
    shape = tuple(int(v) for v in video_shape)
    if len(shape) != 5 or shape[0] != int(packed_mask.shape[0]):
        raise ValueError("Drift-Control 需要 [B,C,T,H,W] 的视频 latent，收到 %s" % (shape,))
    if prefix_steps < 1 or prefix_steps > shape[2]:
        raise ValueError("Drift-Control 的前缀宽度超出目标 latent 的时间长度")
    video_elements = math.prod(shape[1:])
    if int(packed_mask.shape[-1]) < video_elements:
        raise ValueError("Drift-Control 的打包 mask 比视频流还短")

    output = packed_mask.clone()
    video_mask = output[..., :video_elements].reshape(shape)
    weights = torch.tensor(
        _prefix_ladder(prefix_steps, min(_DRIFT_TAPER, prefix_steps)),
        device=video_mask.device,
        dtype=video_mask.dtype,
    ).mul_(float(max(0.0, min(1.0, ratio))))
    video_mask[:, :, :prefix_steps] = weights.view(1, 1, prefix_steps, 1, 1)
    quantized = torch.ceil(video_mask[:, :1].float() * 256.0) / 256.0
    return output, quantized


class _XHDriftLock:
    """Drift-Control 的运行时状态：跟着 sigma 走，每步重算前缀权重。"""

    def __init__(self, video_shape, audio_shape, sigmas, prefix_steps):
        self.video_shape = tuple(int(v) for v in video_shape)
        self.audio_shape = tuple(int(v) for v in audio_shape)
        self.ladder = _schedule_ladder(sigmas)
        self.prefix_steps = int(prefix_steps)
        self.packed_mask = None
        self.video_mask = None
        self.audio_mask = None

    def _recompute(self, sigma, packed_mask):
        current = float(torch.as_tensor(sigma).detach().float().reshape(-1)[0])
        output, video_mask = _apply_prefix_weights(
            packed_mask, self.video_shape,
            _matched_ratio(current, self.ladder),
            prefix_steps=self.prefix_steps,
        )
        self.packed_mask = output
        self.video_mask = video_mask
        video_elements = math.prod(self.video_shape[1:])
        audio = output[..., video_elements:]
        if int(audio.numel()) != math.prod(self.audio_shape):
            raise ValueError("Drift-Control 的打包 mask 与音频流长度不匹配")
        self.audio_mask = audio.reshape(self.audio_shape)[:, :1].clone()
        return output

    # ComfyUI 每步采样前调用（samplers.py 里读 model_options["denoise_mask_function"]）
    def denoise_mask_function(self, sigma, denoise_mask, extra_options=None):
        if not self.ladder:
            self.ladder = _schedule_ladder((extra_options or {}).get("sigmas", ()))
        return self._recompute(sigma, denoise_mask)

    # 每次 apply_model 前调用：把当步的 mask 塞进模型调用
    def apply_model_wrapper(self, executor, *args, **kwargs):
        if self.video_mask is not None:
            kwargs["denoise_mask"] = self.video_mask
        if self.audio_mask is not None:
            kwargs["audio_denoise_mask"] = self.audio_mask
        return executor(*args, **kwargs)


def _install_drift_lock(model, latent, sigmas, prefix_steps):
    """clone 一条 model 并装上 Drift-Control 的 mask 钩子（不动原链）。"""
    if model is None or not callable(getattr(model, "clone", None)):
        raise ValueError("Drift-Control 需要有效的 ComfyUI MODEL 输入")
    inner = getattr(model, "model", None)
    model_type = str(getattr(getattr(inner, "model_type", None), "name", ""))
    if model_type != "FLOW_AV" and inner.__class__.__name__ != "MiniMaxH3":
        raise ValueError("Drift-Control 只支持 MiniMax H3 的音视频模型")

    samples = latent.get("samples") if isinstance(latent, dict) else None
    if callable(getattr(samples, "unbind", None)):
        streams = list(samples.unbind())
    elif hasattr(samples, "tensors"):
        streams = list(samples.tensors)
    elif isinstance(samples, (tuple, list)):
        streams = list(samples)
    else:
        streams = []
    if not streams or not torch.is_tensor(streams[0]) or streams[0].ndim != 5:
        raise ValueError("Drift-Control 需要 MiniMax H3 的音视频嵌套 latent")
    if len(streams) < 2 or not torch.is_tensor(streams[1]):
        raise ValueError("Drift-Control 需要同时含视频流与音频流的 latent")

    prefix_steps = int(prefix_steps)
    if prefix_steps < 1 or prefix_steps >= int(streams[0].shape[2]):
        raise ValueError("Drift-Control 的前缀必须落在新生成的 video token 之前")

    patched = model.clone()
    options = getattr(patched, "model_options", None)
    if not isinstance(options, dict):
        raise ValueError("接进来的 MODEL 没有 model_options 字典")
    if callable(options.get("denoise_mask_function")):
        raise ValueError(
            "Drift-Control 不能和另一个动态 denoise-mask 补丁叠加"
            "（一个 model 只能挂一套）"
        )
    if not callable(getattr(patched, "set_model_denoise_mask_function", None)):
        raise RuntimeError("当前 ComfyUI 不支持动态 denoise-mask，请升级")
    if not callable(getattr(patched, "add_wrapper_with_key", None)):
        raise RuntimeError("当前 ComfyUI 不支持 apply-model wrapper，请升级")

    _, _, WrappersMP = _H3AVStream.official_symbols()
    state = _XHDriftLock(
        tuple(streams[0].shape), tuple(streams[1].shape), sigmas, prefix_steps
    )
    patched.set_model_denoise_mask_function(state.denoise_mask_function)
    patched.add_wrapper_with_key(
        WrappersMP.APPLY_MODEL, _DRIFT_LOCK_KEY, state.apply_model_wrapper
    )
    patched.model_options[_DRIFT_LOCK_KEY] = state
    return patched


# =====================================================================
# 节点
# =====================================================================

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
                "hard_lock": ("BOOLEAN", {
                    "default": True,
                    "label_on": "硬锁：重叠区全冻",
                    "label_off": "渐变：平滑过渡",
                    "tooltip": (
                        "【🔒 接缝锁定模式】硬锁（默认）= overlap 区 noise_mask 全 0，22 帧完全复现上一段"
                        "末尾，节奏严格连续——这是导演台 TimelineDirector finite 分段的实测用法"
                        "（gradient=False），专治「段头动作节奏突变」。\n"
                        "渐变 = overlap 区 mask 从 0 线性放到 1，开头冻住、末尾放开，过渡更柔，但渐变区内"
                        "动作会被逐步重新演绎（段头 frequency 漂移的根源）。\n"
                        "⚠️ 默认值 2026-10-24 从「渐变」改为「硬锁」（对齐导演台源码）；老工作流加载时"
                        "自动取新默认值，连接不用动。 | English: hard-lock (default, TimelineDirector "
                        "finite-segment behavior) freezes the whole overlap; gradient fades 0→1 and "
                        "re-interprets the segment head."
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
        "XH 家族自研实现，零第三方插件依赖。"
    )

    def execute(self, positive, target_latent, previous_latent, model, sigmas,
                overlap_frames, is_first, drift_control, hard_lock):
        # 首轮或没有上一段 → 不续接，原样返回
        if bool(is_first) or previous_latent is None:
            return (positive, target_latent, model)

        # 1) latent 域：上段尾 → 本段头 + noise_mask 锁死
        #    hard_lock=True（默认）= gradient=False：overlap 区 mask 全 0，整段 22 帧完全复现上段尾，
        #    节奏严格连续。这是导演台 TimelineDirector finite 分段的实测用法
        #    （minimax_h3_finite_segments.py:613 gradient=False；gradient=True 只是函数签名默认值，
        #    实验路径才用）——分段接续场景就该硬锁，渐变会让段头动作被逐步重新演绎。
        #    hard_lock=False = gradient=True：头部从「完全锚定上段尾」线性渐变放开到「本段自由生成」，
        #    过渡更柔，但渐变区内动作频率会漂（2026-10-24 实测翻车根因）。
        masked_target, details = _carry_overlap_tail(
            target_latent=target_latent,
            source_latent=previous_latent,
            overlap_frames=int(overlap_frames),
            include_audio=True,
            gradient=not bool(hard_lock),
            audio_soft_release=True,
        )

        # 2) Drift-Control AV 硬锁 + 锥形渐隐（prefix_steps = 抄来的 token 数）
        if bool(drift_control):
            patched_model = _install_drift_lock(
                model, masked_target, sigmas, prefix_steps=details["video_tokens"]
            )
        else:
            patched_model = model

        return (positive, masked_target, patched_model)


NODE_CLASS_MAPPINGS = {"XHH3LatentContinuation": XHH3LatentContinuation}
NODE_DISPLAY_NAME_MAPPINGS = {"XHH3LatentContinuation": "🔁XH-H3 latent接续"}
