# 🔁XH-H3 动作校正（XH 家族 · 2026-10-23）
#
# 治什么：H3 采样时的帧间时序不一致 —— 闪烁、小细节跳变（logo/文字/纹理）、
#   人物与服装的身份漂移、不符合物理的运动。MODEL→MODEL 补丁，可配任意采样器，
#   不换采样器、不改工作流结构，运行时开销 1-2%。
#
# 算法出处（按 MIT 论文自研重写，非复制第三方代码）：
#   Temporal State Transport（arXiv:2609.08505，MIT License，官方代码只支持 Wan2.2）。
#   本文件是该方法在 H3 单流 packed attention 上的 XH 自研实现 ——
#   comfyui-SelfLift 包里的 H3 移植代码没有 LICENSE，故不复制其实现，
#   只按论文口径用 ComfyUI 官方 API 重新写（数学等价，验收时逐函数比对）。
#
# 原理（论文 Eq.1-3）：
#   H3 没有独立的时间注意力层。TST 把视频段 post-RoPE 的 q/k 按帧空间平均池化，
#   攒出 F×F 的「帧间传输算子」A（第 i 帧在多大程度上盯着第 j 帧），再算带符号的
#   谱张力 T = H_row − H_vN：
#     T < 0 = 碎裂（帧间各玩各的 ⇒ 闪烁/断裂/身份漂移）
#     T > 0 = 过混（帧被糊成一团 ⇒ 动作发糊/拖影）
#   校正：gamma = exp(tau_eff × T)，只缩放视频行的 query ——
#     T<0 ⇒ gamma<1 ⇒ logits 变小 ⇒ softmax 更平 ⇒ 促帧间混合（治碎裂）
#     T>0 ⇒ gamma>1 ⇒ logits 变大 ⇒ softmax 更尖 ⇒ 让帧更独立（治过混）
#   双向往中间拉，所以论文叫「内稳态（homeostasis）」校正。
#   tau_eff = tau × 层权重 × 步权重（两条余弦）：中层权重大、去噪早期权重大、
#   最后一步趋近 0（快出图了不乱动）。
#
# 🔴 anchored to ComfyUI 官方源码（不碰任何私有结构，注入点全有官方先例）：
#   · 视频段恒为 packed 序列最后一段：comfy/ldm/minimax/model.py 的 PackedLayout
#     （target audio 然后 target video，永远最后两段）⇒ 视频行 = 序列末尾 frames×rows
#   · 注入点：comfy/ldm/modules/attention.py 的 wrap_attn 每个后端都会检查
#     transformer_options["optimized_attention_override"]（官方先例：
#     comfy_extras/nodes_sparse_attention.py:221-226 用的就是这一个）
#   · 每次 forward 的视频形状：WrappersMP.DIFFUSION_MODEL 包 MiniMaxH3Model._forward
#     （官方先例：nodes_easycache / nodes_minimax_h3 / nodes_wan 等同款用法）
#
# 🔴 接线：model 口接在「模型加载 / LoRA 之后、sampler（或接续节点）之前」。
#   一采二采两条链都会自动吃到 —— model.clone() 连 wrappers 和
#   transformer_options 一起深拷，Drift-Control 只往 model_options 追加自己的 key，
#   盖不掉本补丁（model_patcher.py:455 / :477-481 源码实证）。
#
# ⚠ 已知限制：与 SelfLift 采样器的 highres_tiling 不兼容（wrapper 按注册顺序跑，
#   TST 在 tiling 外层只看到全分辨率形状，tile 注意力过不了长度守卫 ⇒ 跳过并警告，
#   不会把 tile 的视频行找错位置）。本家族工作流不用 SelfLift 采样器，不受影响。
#   同一个守卫还会拒掉 token-refiner 的文本注意力调用（文本长度远小于 frames×rows），
#   且只有视频注意力调用会推进层计数器，refiner 插不进来打乱调度。
#
# ⚙ 精确校准探针：环境变量 XH_TST_EXACT=1 时，在中间层用「全行 softmax 的精确算子」
#   复算一遍 T，跟池化近似版对比（控制台打 sign_agree 百分比）。默认关。

import logging
import math
import os
import time
from functools import partial

import torch

import comfy.patcher_extension
from comfy.ldm.modules.attention import AttentionTensorContainer

_ENV_EXACT = "XH_TST_EXACT"


def _unwrap(tensor):
    """H3 会把 q/k/v 包进 AttentionTensorContainer，但 wrap_attn 在调 override 前
    已经 take() 过了，所以拿到裸张量是常态；保险起见还是判一下。"""
    return tensor.peek() if isinstance(tensor, AttentionTensorContainer) else tensor


def _spectral_tension(q, k, v0, frames, rows_per_frame, eps=1e-8):
    """池化近似的帧级谱张力（论文 Eq.1-3）。

    q, k: [1, heads, S, head_dim]，post-norm post-RoPE；视频行从 v0 开始。
    返回 [heads] fp32；T>0 过混，T<0 碎裂。
    """
    heads = q.shape[1]
    head_dim = q.shape[-1]
    # 视频段按帧空间平均池化 ⇒ 每帧一个向量 ⇒ F×F 传输算子
    qv = q[0, :, v0:].reshape(heads, frames, rows_per_frame, head_dim).mean(dim=2).float()
    kv = k[0, :, v0:].reshape(heads, frames, rows_per_frame, head_dim).mean(dim=2).float()
    a = (qv @ kv.transpose(-2, -1) * head_dim ** -0.5).softmax(dim=-1).clamp(min=eps)
    log_f = math.log(frames)
    # H_row：行熵（局部扩散度），除以 logF 归一到 [0,1]
    h_row = -(a * a.log()).sum(dim=-1).mean(dim=-1) / log_f
    # H_vN：Gram 归一化特征值分布的 vN 熵（全局谱多样性）
    gram = a @ a.transpose(-2, -1)
    trace = gram.diagonal(dim1=-2, dim2=-1).sum(dim=-1).clamp(min=eps)
    eig = torch.linalg.eigvalsh(gram / trace[:, None, None]).clamp(min=eps)
    eig = eig / eig.sum(dim=-1, keepdim=True).clamp(min=eps)
    h_vn = -(eig * eig.log()).sum(dim=-1) / log_f
    return h_row - h_vn


def _exact_tension(q, k, v0, frames, rows_per_frame, eps=1e-8, chunk=64):
    """精确的帧质量传输算子张力，仅用于校准池化近似版（XH_TST_EXACT=1）。

    每个 query token 对整条 packed 序列做全行 softmax，视频 key 质量按帧累加、
    再按帧内 query 行平均、最后在帧间重归一化 —— 这才是真正的联合注意力传输算子。
    q, k: [1, heads, S, head_dim]；返回 [heads] fp32，口径同 _spectral_tension。
    """
    heads = q.shape[1]
    head_dim = q.shape[-1]
    qv = q[0, :, v0:]
    k_all = k[0].float()
    log_f = math.log(frames)
    a = q.new_zeros(heads, frames, frames, dtype=torch.float32)
    for start in range(0, frames * rows_per_frame, chunk):
        stop = min(start + chunk, frames * rows_per_frame)
        logits = (qv[:, start:stop].float() @ k_all.transpose(-2, -1)) * head_dim ** -0.5
        m = logits.softmax(dim=-1)[..., v0:]
        m = m.reshape(heads, stop - start, frames, rows_per_frame).sum(dim=-1)
        idx = torch.arange(start, stop, device=m.device) // rows_per_frame
        a.scatter_add_(1, idx.view(1, -1, 1).expand(heads, -1, frames), m)
        del logits, m
    a = a / rows_per_frame
    a = (a / a.sum(dim=-1, keepdim=True).clamp(min=eps)).clamp(min=eps)
    h_row = -(a * a.log()).sum(dim=-1).mean(dim=-1) / log_f
    gram = a @ a.transpose(-2, -1)
    trace = gram.diagonal(dim1=-2, dim2=-1).sum(dim=-1).clamp(min=eps)
    eig = torch.linalg.eigvalsh(gram / trace[:, None, None]).clamp(min=eps)
    eig = eig / eig.sum(dim=-1, keepdim=True).clamp(min=eps)
    h_vn = -(eig * eig.log()).sum(dim=-1) / log_f
    return h_row - h_vn


def _attention_override(state):
    """拦每一次注意力：算帧级谱张力 → 按 gamma 缩放视频行 query → 放行原注意力。"""

    def override(func, q, k, v, heads, mask=None, **kwargs):
        frames = state["frames"]
        rows = state["rows_per_frame"]
        qt = _unwrap(q)
        s = qt.shape[2]
        # 视频行恒为序列末尾 frames×rows；同一个守卫顺带拒掉 token-refiner 的
        # 文本调用（文本长度远小于 frames×rows）。只有视频调用推进层计数器，
        # 所以 forward 里插一个 refiner 也不会打乱层调度。
        if frames is None or frames < 2 or s <= frames * rows:
            if frames is not None and frames >= 2:
                state["guard_misses"] += 1
            return func(q, k, v, heads, mask=mask, **kwargs)
        state["calls_this_forward"] += 1
        # GPU 计时用 cuda event：host 侧 perf_counter 会把下面 float() 转换引发的
        # 同步停顿（等的是整条 GPU 队列，不只是 TST 的 kernel）算成 TST 的耗时
        timed = state["log_diagnostics"]
        if timed and qt.is_cuda:
            tst_start, tst_end = torch.cuda.Event(enable_timing=True), torch.cuda.Event(enable_timing=True)
            tst_start.record()
        elif timed:
            tst_start = time.perf_counter()
        layers = state["layers"]
        layer = (state["calls_this_forward"] - 1) % layers
        total_steps = state["total_steps"]
        step = min(state["step"], total_steps - 1)
        layer_weight = 0.5 - 0.5 * math.cos(math.pi * layer / (layers - 1)) if layers > 1 else 1.0
        step_weight = 0.5 + 0.5 * math.cos(math.pi * step / (total_steps - 1)) if total_steps > 1 else 1.0
        tension = _spectral_tension(qt, _unwrap(k), s - frames * rows, frames, rows)
        gamma = torch.exp(tension * (state["tau"] * layer_weight * step_weight))
        # 精确校准探针需要校正前的 q；下面的缩放是原地的，先克隆一份
        exact_probe = state["exact_debug"] and layer == layers // 2
        q_pre = qt.clone() if exact_probe else None
        if state["tau"] != 0.0:
            qt[0, :, s - frames * rows:].mul_(gamma.to(qt.dtype)[:, None, None])
        if state["log_diagnostics"]:
            if qt.is_cuda:
                tst_end.record()
                state["fw_events"].append((tst_start, tst_end))
            else:
                state["fw_tst_time"].append(time.perf_counter() - tst_start)
            state["fw_abs_tension"].append(float(tension.abs().mean()))
            # 调用内自检（论文附录图 A）：校正后算子的张力必须低于校正前
            post = _spectral_tension(qt, _unwrap(k), s - frames * rows, frames, rows) if state["tau"] != 0.0 else tension
            state["fw_abs_tension_post"].append(float(post.abs().mean()))
            state["fw_gamma"].append(float(gamma.mean()))
            state["fw_active"].append(float(((gamma - 1.0).abs() > 0.03).float().mean()))
            if layer == layers - 1 and state["fw_gamma"]:
                tst_ms = 1000.0 * sum(state["fw_tst_time"])
                for ev_start, ev_end in state["fw_events"]:
                    ev_end.synchronize()
                    tst_ms += ev_start.elapsed_time(ev_end)
                n = len(state["fw_abs_tension"])
                logging.info(
                    "[XH TST] step %d/%d frames=%d grid_rows=%d pre|T|=%.4f post|T|=%.4f mean_gamma=%.4f active_heads=%.0f%% tst_time=%.2fs",
                    state["step"], total_steps, frames, rows,
                    sum(state["fw_abs_tension"]) / n,
                    sum(state["fw_abs_tension_post"]) / len(state["fw_abs_tension_post"]),
                    sum(state["fw_gamma"]) / len(state["fw_gamma"]),
                    100.0 * sum(state["fw_active"]) / len(state["fw_active"]),
                    tst_ms / 1000.0)
                state["fw_abs_tension"].clear()
                state["fw_abs_tension_post"].clear()
                state["fw_gamma"].clear()
                state["fw_active"].clear()
                state["fw_tst_time"].clear()
                state["fw_events"].clear()
        if exact_probe:
            exact = _exact_tension(q_pre, _unwrap(k), s - frames * rows, frames, rows)
            del q_pre
            logging.info(
                "[XH TST exact] step %d layer %d/%d: proto_T=%+.4f exact_T=%+.4f proto|T|=%.4f exact|T|=%.4f sign_agree=%.0f%%",
                state["step"], layer, layers,
                float(tension.mean()), float(exact.mean()),
                float(tension.abs().mean()), float(exact.abs().mean()),
                100.0 * float(((exact > 0) == (tension > 0)).float().mean()))
        return func(q, k, v, heads, mask=mask, **kwargs)

    return override


def _forward_wrapper(state, executor, x, timestep, context, transformer_options, minimax_payload=None, **kwargs):
    """每次 forward 前刷新帧数/行数/当前步号，并学习本模型的层数。"""
    if state["calls_this_forward"] > 0:
        state["layers"] = state["calls_this_forward"]
    elif state["guard_misses"] > 0 and not state["warned_inactive"]:
        # 上一次 forward 的每次注意力都短于登记的视频段 ⇒ wrapper 坐在空间 tiling
        # wrapper 外层（wrapper 按注册顺序跑），只看到全分辨率形状，
        # TST 找不到 tile 的视频行 ⇒ 跳过 + 警告，绝不瞎找位置
        logging.warning(
            "[XH-H3 动作校正] 未生效：packed 序列短于预期视频段，"
            "TST 与 highres_tiling 不兼容，已跳过（不会算错位置）")
        state["warned_inactive"] = True
    state["calls_this_forward"] = 0
    state["guard_misses"] = 0
    # 诊断关着时 fw_tst_time/fw_events 不会有人读；每个 forward 清掉，别泄漏
    state["fw_tst_time"].clear()
    state["fw_events"].clear()
    video = x[0] if isinstance(x, (list, tuple)) else x
    if isinstance(video, torch.Tensor) and video.ndim == 5:
        state["frames"] = int(video.shape[2])
        state["rows_per_frame"] = ((video.shape[3] + 1) // 2) * ((video.shape[4] + 1) // 2)
    else:
        # 非 H3（4D 输入）⇒ frames=None，override 整体放行，不会误缩放
        state["frames"] = None
    sigmas = transformer_options.get("sample_sigmas")
    if sigmas is not None:
        sigma = float(timestep.flatten()[0]) / 1000.0
        state["total_steps"] = max(1, int(sigmas.numel()) - 1)
        state["step"] = int((sigmas.float().cpu() - sigma).abs().argmin())
    return executor(x, timestep, context, transformer_options, minimax_payload=minimax_payload, **kwargs)


def patch_model(model, tau, log_diagnostics=True):
    """给 model 打 TST 补丁，返回克隆体（不动原链）。"""
    state = {
        "tau": float(tau), "log_diagnostics": bool(log_diagnostics),
        "exact_debug": os.environ.get(_ENV_EXACT, "0") == "1",
        "frames": None, "rows_per_frame": None,
        "step": 0, "total_steps": 1, "layers": 50, "calls_this_forward": 0,
        "guard_misses": 0, "warned_inactive": False,
        "fw_abs_tension": [], "fw_abs_tension_post": [], "fw_gamma": [], "fw_active": [],
        "fw_tst_time": [], "fw_events": [],
    }
    patched = model.clone()
    patched.add_wrapper_with_key(comfy.patcher_extension.WrappersMP.DIFFUSION_MODEL,
                                 "xh_h3_tst", partial(_forward_wrapper, state))
    patched.model_options.setdefault("transformer_options", {})["optimized_attention_override"] = _attention_override(state)
    return patched


class XHH3TemporalCorrection:
    """H3 帧间时序校正（TST）：按帧谱张力双向往中拉 query 温度，MODEL→MODEL 补丁。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("MODEL", {
                    "tooltip": (
                        "【🔧 模型】要打补丁的 H3 模型。接在模型加载 / LoRA 之后、"
                        "sampler（或接续节点）之前；本节点 clone 一份，不动原链。\n"
                        "非 H3 模型会自动放行（不会误缩放）。 | English: the H3 model to patch; "
                        "place it after model load/LoRA and before the sampler. Clones internally."
                    ),
                }),
                "tau": ("FLOAT", {
                    "default": 0.2, "min": 0.0, "max": 1.0, "step": 0.05,
                    "tooltip": (
                        "【🎚️ 校正强度】0.2 = 论文推荐值；0 = 关闭校正但保留诊断日志；"
                        "0.5 已明显过强，不建议再往上。\n"
                        "治不了「人物不听原视频的话」这种语义级跟随（那是参考视频采样率 + "
                        "二采预算的问题）。 | English: correction strength; 0.2 is the paper "
                        "setting, 0 disables correction while keeping diagnostics."
                    ),
                }),
                "log_diagnostics": ("BOOLEAN", {
                    "default": True,
                    "label_on": "诊断日志：开启",
                    "label_off": "诊断日志：关闭",
                    "tooltip": (
                        "【📋 诊断日志】开启后控制台每步打一行 [XH TST]："
                        "pre|T| / post|T| / mean_gamma / active_heads / tst_time。\n"
                        "验收标准（论文附录）：post|T| 应低于 pre|T|；mean_gamma 偏离 1 的程度"
                        "就是实际校正强度。 | English: log per-step Spectral Tension stats; "
                        "post|T| should drop below pre|T|."
                    ),
                }),
            },
        }

    RETURN_TYPES = ("MODEL",)
    RETURN_NAMES = ("model",)
    FUNCTION = "patch"
    CATEGORY = "🔁XH/Video"
    DESCRIPTION = (
        "H3 帧间时序校正（TST，arXiv:2609.08505 · MIT，XH 自研 H3 移植）："
        "按帧谱张力 T=H_row-H_vN 诊断「碎裂/过混」，用 query 温度 gamma=exp(tau·T) "
        "双向往中拉。治帧间闪烁、细节跳变、身份漂移、不符合物理的运动。"
        "MODEL→MODEL 补丁，可配任意采样器，开销 1-2%，零第三方依赖。"
    )

    def patch(self, model, tau, log_diagnostics):
        return (patch_model(model, tau, log_diagnostics),)


NODE_CLASS_MAPPINGS = {"XHH3TemporalCorrection": XHH3TemporalCorrection}
NODE_DISPLAY_NAME_MAPPINGS = {"XHH3TemporalCorrection": "🔁XH-H3 动作校正"}
