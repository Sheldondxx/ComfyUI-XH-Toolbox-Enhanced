# 🔁XH-MSR 精修编码 · 引擎层
#
# 干什么：让**同一段视频的不同时间段认不同的提示词** ——
#   第 0~2 秒只认「女孩特写」，第 2~5 秒只认「长胡子的男人」……
#   这样 LTX 2.5 二采精修时，切镜点上的提示词不会串味（女孩不会莫名其妙长出胡子）。
#
# 原理（与 Prompt Relay 论文 / 上游 ComfyUI-PromptRelay 的算法等价）：
#   ① 把「全局提示词 + 每段提示词」拼成一条文本，一次性编码；
#      用增量 tokenize 记下每段提示词占哪几个 token；
#   ② 给「视频 token × 文本 token」的交叉注意力加一个**时间惩罚矩阵** ——
#      距离本段中点越远、惩罚越大（窗口内为 0，窗口外按高斯衰减）：
#          cost = strength * ReLU(|frame - midpoint| - window)^2 / (2 * sigma^2)
#      ⇒ 每一帧的视频 token 只会强烈关注「属于它那一段」的文本 token。
#
# 🔴 自持声明：本文件**不 import 上游 ComfyUI-PromptRelay**。
#   只依赖 comfy 官方模块 + torch + 标准库 ⇒ 零第三方依赖、可独立分发。
#   （comfy 的注意力模块是**函数内懒加载**的，这样本文件的纯计算部分
#     不启动 ComfyUI 也能单独自测。）
#
# 支持的模型：LTX（含 2.5，包装 transformer_blocks 的 attn2 / audio_attn2）、
#             Wan（替换 blocks 的 cross_attn）。其余架构明确报错，不猜。

import logging
import math
import re
import types

import torch

log = logging.getLogger(__name__)


# ============================ 一、文本 → token 区间 ============================

def get_raw_tokenizer(clip):
    """从 ComfyUI 的 CLIP 对象里挖出底层原始 tokenizer（SP / HF）。

    做法：在 clip.tokenizer 的各个包装层里，找那个「自己又带 .tokenizer」的。
    找不到就报错并列出字段名，方便定位（不静默返回 None）。
    """
    wrapper = clip.tokenizer
    for name in dir(wrapper):
        if name.startswith("_"):
            continue
        inner = getattr(wrapper, name, None)
        if inner is not None and hasattr(inner, "tokenizer"):
            return inner.tokenizer

    raise RuntimeError(
        "[XH-MSR] 没能从这个 CLIP 里找到原始 tokenizer。"
        f"已知字段：{[a for a in dir(wrapper) if not a.startswith('_')]}"
    )


def map_token_indices(raw_tokenizer, global_prompt, local_prompts):
    """返回 (拼好的整条文本, [每段提示词的 token 区间])。

    增量法：全局提示词后面逐段追加「空格 + 段文本」，每追加一段重新 tokenize 一次，
    长度差就是这一段的 token 区间。这样避开 SentencePiece 的上下文依赖问题。
    """
    prefixed = [" " + lp for lp in local_prompts]
    full_prompt = global_prompt + "".join(prefixed)
    eos_adj = 1 if getattr(raw_tokenizer, "add_eos", False) else 0

    prev = len(raw_tokenizer(global_prompt)["input_ids"]) - eos_adj
    ranges = []
    built = global_prompt
    for plp in prefixed:
        built += plp
        cur = len(raw_tokenizer(built)["input_ids"]) - eos_adj
        if cur <= prev:
            raise ValueError(
                f"[XH-MSR] 有一段提示词没产生任何 token（是不是空段？）：'{plp.strip()}'"
            )
        ranges.append((prev, cur))
        prev = cur

    return full_prompt, ranges


# ============================ 二、段长：像素帧 → 潜在帧 ============================

def convert_to_latent_lengths(pixel_lengths, temporal_stride, latent_frames):
    """像素帧数 → 潜在帧数（最大余数法）。

    · 像素总数看起来是「跑满整段」时（在一个 stride 容差内）→ 目标钉到 latent_frames；
      否则按 round(总像素 / stride) 走，让「只覆盖一部分」的时间轴保持部分覆盖。
    · 每段至少 1 个潜在帧（不够就从最长的那段借 1 个）。
    """
    if not pixel_lengths:
        return []
    total_pixel = sum(pixel_lengths)
    if total_pixel <= 0:
        return [1] * len(pixel_lengths)

    naive_total = max(1, round(total_pixel / temporal_stride))
    target_total = min(latent_frames, naive_total)
    # 差 1 帧以内就算「用户想跑满」→ 直接钉满，避免末尾差一点点
    if target_total >= latent_frames - 1:
        target_total = latent_frames

    exact = [p * target_total / total_pixel for p in pixel_lengths]
    result = [int(e) for e in exact]
    diff = target_total - sum(result)
    if diff > 0:
        order = sorted(range(len(exact)), key=lambda i: -(exact[i] - int(exact[i])))
        for k in range(diff):
            result[order[k % len(order)]] += 1

    for i in range(len(result)):
        if result[i] < 1:
            max_idx = max(range(len(result)), key=lambda j: result[j])
            if result[max_idx] > 1:
                result[max_idx] -= 1
                result[i] = 1

    return result


def distribute_segment_lengths(num_segments, latent_frames, specified_lengths=None):
    """校验 / 自动均分段长，并把总长夹到 latent_frames 以内。

    🔴 段数对不上是**硬报错**（不是静默凑合）—— 这段错位正是「提示词串味」的头号原因。
    """
    if specified_lengths:
        if len(specified_lengths) != num_segments:
            raise ValueError(
                f"[XH-MSR] 秒数段数（{len(specified_lengths)}）和提示词段数（{num_segments}）"
                "必须一一对应，不能多也不能少。"
            )
        lengths = specified_lengths
    else:
        step = -(-latent_frames // num_segments)      # ceil
        lengths = [step] * num_segments

    effective = []
    cursor = 0
    for L in lengths:
        end = min(cursor + L, latent_frames)
        effective.append(max(end - cursor, 0))
        cursor = end
    return effective


# ============================ 三、惩罚矩阵与遮罩 ============================

def build_segments(token_ranges, segment_lengths, epsilon=1e-3, relay_options=None):
    """给每一段算出：token 区间、时间中点、平窗宽度、sigma、强度。"""
    # 论文里 sigma 是常数，与段长无关
    sigma = 1.0 / math.log(1.0 / epsilon) if 0 < epsilon < 1 else 0.1448

    opts = relay_options or {}
    v_strength = opts.get("video_strength", 1.0)
    v_window_scale = opts.get("video_window_scale", 1.0)
    a_epsilon = opts.get("audio_epsilon")
    a_strength = opts.get("audio_strength", 1.0)
    a_window_scale = opts.get("audio_window_scale", 1.0)

    if a_epsilon is not None and 0 < a_epsilon < 1:
        sigma_audio = 1.0 / math.log(1.0 / a_epsilon)
    else:
        sigma_audio = sigma

    if opts:
        log.info(
            "[XH-MSR] 高级选项生效 —— 画面：strength=%.3f window_scale=%.3f | "
            "音频：epsilon=%s strength=%.3f window_scale=%.3f",
            v_strength, v_window_scale,
            f"{a_epsilon:.4f}" if a_epsilon is not None else "继承",
            a_strength, a_window_scale,
        )

    segs = []
    frame_cursor = 0
    for (tok_start, tok_end), L in zip(token_ranges, segment_lengths):
        if L <= 0:
            frame_cursor += L
            continue
        midpoint = (2 * frame_cursor + L) // 2
        base_window = max(L // 2 - 2, 0)
        segs.append({
            "local_token_idx": torch.arange(tok_start, tok_end),
            "midpoint": midpoint,
            "window": max(base_window * v_window_scale, 0.0),
            "sigma": sigma,
            "strength": v_strength,
            "window_audio": max(base_window * a_window_scale, 0.0),
            "sigma_audio": sigma_audio,
            "strength_audio": a_strength,
        })
        frame_cursor += L

    return segs


def _build_temporal_cost(segs, Lq, Lk, device, dtype, tokens_per_frame):
    """视频路径：query 帧号是整数（每个视频 token 属于哪一帧是确定的）。"""
    offset = torch.zeros(Lq, Lk, device=device, dtype=dtype)
    query_frames = torch.arange(Lq, device=device, dtype=torch.long) // tokens_per_frame

    for seg in segs:
        local = seg["local_token_idx"].to(device=device)
        d = (query_frames.float()[:, None] - seg["midpoint"]).abs()
        cost = seg["strength"] * (torch.relu(d - seg["window"]) ** 2) / (2 * seg["sigma"] ** 2)
        offset[:, local] = cost.to(offset.dtype)

    return offset


def _build_temporal_cost_scaled(segs, Lq, Lk, device, dtype, latent_frames):
    """缩放路径：query 不落在整数帧上（例如 LTX 的音频 token）→ 把 query 位置线性摊到帧上。"""
    offset = torch.zeros(Lq, Lk, device=device, dtype=dtype)
    query_frames = torch.arange(Lq, device=device, dtype=torch.float32) * latent_frames / Lq

    for seg in segs:
        local = seg["local_token_idx"].to(device=device)
        d = (query_frames[:, None] - seg["midpoint"]).abs()
        cost = (seg["strength_audio"]
                * (torch.relu(d - seg["window_audio"]) ** 2)
                / (2 * seg["sigma_audio"] ** 2))
        offset[:, local] = cost.to(offset.dtype)

    return offset


def create_mask_fn(segs, fallback_tokens_per_frame, latent_frames):
    """闭包：mask_fn(Lq, Lk, dtype, device, transformer_options) → 加性遮罩 或 None。

    只收形状/dtype/device（不收张量）⇒ 可以在还没算出 q/k 投影时就先建遮罩，
    也方便我们「包装」别人已经打好的注意力，而不是把人家整段替换掉。
    """
    cache = {}
    max_token_idx = max(int(seg["local_token_idx"].max().item()) for seg in segs) + 1

    def mask_fn(Lq, Lk, dtype, device, transformer_options):
        if Lq == Lk:
            return None                                # 自注意力不打遮罩

        # 只在「有条件」的那一趟打（负向提示词那一趟不打）
        cond_or_uncond = transformer_options.get("cond_or_uncond", [])
        if 1 in cond_or_uncond and 0 not in cond_or_uncond:
            return None

        grid_sizes = transformer_options.get("grid_sizes", None)
        video_tpf = int(grid_sizes[1]) * int(grid_sizes[2]) if grid_sizes is not None else fallback_tokens_per_frame
        video_lq = latent_frames * video_tpf

        # 跳过跨模态注意力：文本 key 会被补齐到固定长度（≠ video_lq）
        if Lk == video_lq or Lk < max_token_idx:
            return None

        mode = "video" if Lq == video_lq else "scaled"

        key = (Lq, Lk, mode, device)
        if key not in cache:
            if mode == "video":
                cost = _build_temporal_cost(segs, Lq, Lk, device, dtype, video_tpf)
            else:
                cost = _build_temporal_cost_scaled(segs, Lq, Lk, device, dtype, latent_frames)
            log.info(
                "[XH-MSR] 惩罚矩阵已生成（%s）：Lq=%d, Lk=%d, 非零=%d/%d",
                mode, Lq, Lk, (cost > 0).sum().item(), cost.numel(),
            )
            cache[key] = -cost

        return cache[key].to(dtype)

    return mask_fn


# ============================ 四、打补丁（往注意力层挂钩子） ============================

def _masked_attention(q, k, v, heads, mask, transformer_options=None, **kwargs):
    """绕开 wrap_attn（sage 等后端会丢掉自定义遮罩），直接走官方 attention_pytorch。"""
    from comfy.ldm.modules import attention as comfy_attn
    return comfy_attn.attention_pytorch(
        q, k, v, heads, mask=mask,
        _inside_attn_wrapper=True,
        transformer_options=transformer_options or {},
        **kwargs,
    )


def _make_masked_override(prev_override):
    """transformer_options 里的注意力改写器：带遮罩的调用强制走 attention_pytorch。

    没遮罩时链回上一个 override（这样不会把别人的后端踢掉）。"""
    def override(func, *args, **kwargs):
        if kwargs.get("mask") is not None:
            from comfy.ldm.modules import attention as comfy_attn
            return comfy_attn.attention_pytorch(*args, **kwargs)
        if prev_override is not None:
            return prev_override(func, *args, **kwargs)
        return func(*args, **kwargs)

    return override


def _make_ltx_mask_wrapper(underlying, mask_fn):
    """包装 LTX 已有的交叉注意力 forward，把我们的加性遮罩塞进它本来就认的 mask 参数。

    `underlying` 必须是已经绑好 self 的可调用对象（形如 underlying(x, context=..., mask=..., ...)）。
    这样如果还有别的节点（如 KJNodes NAG）也包过这一层，我们是在它**之上**再包一层，
    遮罩用「相加」而不是「覆盖」⇒ 可共存。
    """
    def wrapped(_self, x, context=None, mask=None, pe=None, k_pe=None, transformer_options=None):
        to = transformer_options if transformer_options is not None else {}

        if context is not None:
            pr_mask = mask_fn(x.shape[1], context.shape[1], x.dtype, x.device, to)
            if pr_mask is not None:
                mask = pr_mask if mask is None else mask + pr_mask

        if mask is not None:
            prev = to.get("optimized_attention_override")
            to = {**to, "optimized_attention_override": _make_masked_override(prev)}

        return underlying(
            x, context=context, mask=mask, pe=pe, k_pe=k_pe,
            transformer_options=to,
        )

    wrapped._xh_msr_wrapper = True
    return wrapped


def _wan_t2v_forward(self, mask_fn, x, context, transformer_options=None, **kwargs):
    from comfy.ldm.modules import attention as comfy_attn
    to = transformer_options if transformer_options is not None else {}

    q = self.norm_q(self.q(x))
    k = self.norm_k(self.k(context))
    v = self.v(context)

    mask = mask_fn(q.shape[1], k.shape[1], q.dtype, q.device, to)
    if mask is not None:
        x = _masked_attention(q, k, v, heads=self.num_heads, mask=mask, transformer_options=to)
    else:
        x = comfy_attn.optimized_attention(q, k, v, heads=self.num_heads, transformer_options=to)
    return self.o(x)


def _wan_i2v_forward(self, mask_fn, x, context, context_img_len, transformer_options=None, **kwargs):
    from comfy.ldm.modules import attention as comfy_attn
    to = transformer_options if transformer_options is not None else {}

    context_img = context[:, :context_img_len]
    context_text = context[:, context_img_len:]

    q = self.norm_q(self.q(x))

    k_img = self.norm_k_img(self.k_img(context_img))
    v_img = self.v_img(context_img)
    img_x = comfy_attn.optimized_attention(q, k_img, v_img, heads=self.num_heads, transformer_options=to)

    k = self.norm_k(self.k(context_text))
    v = self.v(context_text)

    mask = mask_fn(q.shape[1], k.shape[1], q.dtype, q.device, to)
    if mask is not None:
        x = _masked_attention(q, k, v, heads=self.num_heads, mask=mask, transformer_options=to)
    else:
        x = comfy_attn.optimized_attention(q, k, v, heads=self.num_heads, transformer_options=to)

    return self.o(x + img_x)


class _CrossAttnPatch:
    """描述符：把 (impl, mask_fn) 绑成 Wan 交叉注意力模块上的一个方法。"""

    def __init__(self, impl, mask_fn):
        self.impl = impl
        self.mask_fn = mask_fn

    def __get__(self, obj, objtype=None):
        impl, mask_fn = self.impl, self.mask_fn

        def wrapped(self_module, *args, **kwargs):
            return impl(self_module, mask_fn, *args, **kwargs)

        return types.MethodType(wrapped, obj)


def detect_model_type(model):
    """返回 (arch, patch_size, temporal_stride)。

    temporal_stride = VAE 的「像素帧 → 潜在帧」时间压缩比，
    用来把用户填的像素帧数换算成潜在帧数。
    """
    diff_model = model.model.diffusion_model

    if hasattr(diff_model, "patch_size") and not hasattr(diff_model, "patchifier"):
        return "wan", tuple(diff_model.patch_size), 4

    if hasattr(diff_model, "patchifier"):
        return "ltx", (1, 1, 1), int(diff_model.vae_scale_factors[0])

    raise ValueError(
        f"[XH-MSR] 不认识这种模型：{type(diff_model).__name__}。"
        "目前只支持 LTX（含 2.5）和 Wan。"
    )


def _check_unpatched(model_clone, key):
    if key in getattr(model_clone, "object_patches", {}):
        raise RuntimeError(
            f"[XH-MSR] '{key}' 这层交叉注意力已经被别的节点打过补丁了。"
            "Wan 架构不支持叠加，请先把冲突的节点（如另一个 Prompt Relay / 时段遮罩类节点）去掉。"
        )


def apply_patches(model_clone, arch, mask_fn):
    """把遮罩挂到模型的注意力层上。"""
    diffusion_model = model_clone.get_model_object("diffusion_model")

    if arch == "wan":
        from comfy.ldm.wan.model import WanI2VCrossAttention
        for idx, block in enumerate(diffusion_model.blocks):
            key = f"diffusion_model.blocks.{idx}.cross_attn.forward"
            _check_unpatched(model_clone, key)
            cross_attn = block.cross_attn
            impl = _wan_i2v_forward if isinstance(cross_attn, WanI2VCrossAttention) else _wan_t2v_forward
            model_clone.add_object_patch(
                key, _CrossAttnPatch(impl, mask_fn).__get__(cross_attn, cross_attn.__class__)
            )
        return

    if arch == "ltx":
        for idx, block in enumerate(diffusion_model.transformer_blocks):
            for attr in ("attn2", "audio_attn2"):
                module = getattr(block, attr, None)
                if module is None:
                    continue
                key = f"diffusion_model.transformer_blocks.{idx}.{attr}.forward"
                # get_model_object 拿到的是「已有的那层」—— 别人包过就拿到别人的包装，我们叠在它上面
                underlying = model_clone.get_model_object(key)
                wrapper = _make_ltx_mask_wrapper(underlying, mask_fn)
                model_clone.add_object_patch(key, types.MethodType(wrapper, module))
        return

    raise ValueError(f"[XH-MSR] 不认识的架构：{arch}")


# ============================ 五、主流程 ============================

def encode_relay(model, clip, latent, global_prompt, local_prompts,
                 segment_lengths_str, epsilon, relay_options=None):
    """编码 + 打补丁。返回 (打好补丁的 model, 正向条件, 实际生效的段长列表)。

    `segment_lengths_str` 是逗号分隔的**像素空间帧数**；留空 = 按潜在帧均分。
    """
    locals_list = [p.strip() for p in local_prompts.split("|") if p.strip()]
    if not locals_list:
        raise ValueError("[XH-MSR] 至少要有一段提示词（用 | 分隔）。")

    arch, patch_size, temporal_stride = detect_model_type(model)

    samples = latent["samples"]
    latent_frames = samples.shape[2]
    tokens_per_frame = (samples.shape[3] // patch_size[1]) * (samples.shape[4] // patch_size[2])

    parsed_lengths = None
    if segment_lengths_str.strip():
        pixel_lengths = [int(x.strip()) for x in segment_lengths_str.split(",") if x.strip()]
        parsed_lengths = convert_to_latent_lengths(pixel_lengths, temporal_stride, latent_frames)

    raw_tokenizer = get_raw_tokenizer(clip)
    full_prompt, token_ranges = map_token_indices(raw_tokenizer, global_prompt, locals_list)

    log.info("[XH-MSR] 全局提示词：tokens [0:%d]", token_ranges[0][0])
    for i, (s, e) in enumerate(token_ranges):
        log.info("[XH-MSR] 第 %d 段：tokens [%d:%d]（%d 个）", i, s, e, e - s)

    conditioning = clip.encode_from_tokens_scheduled(clip.tokenize(full_prompt))

    effective_lengths = distribute_segment_lengths(len(locals_list), latent_frames, parsed_lengths)

    log.info(
        "[XH-MSR] 潜在帧 %d，每帧 %d 个 token，各段潜在帧数：%s",
        latent_frames, tokens_per_frame, effective_lengths,
    )

    segs = build_segments(token_ranges, effective_lengths, epsilon, relay_options)
    mask_fn = create_mask_fn(segs, tokens_per_frame, latent_frames)

    patched = model.clone()
    apply_patches(patched, arch, mask_fn)

    return patched, conditioning, effective_lengths, temporal_stride, latent_frames


# ============================ 六、MSR 分段稿解析 ============================

# 段尾时间标记：`[3]` / `[3s]` / `[3秒]` / `[0-3]` / `[2 - 5.5]`
#   · 单个数字   → 该段持续几秒
#   · `a-b` 跨度 → 时长 = b - a 秒（起点不用管，节点按顺序自己衔接）
_TAIL_TIME_RE = re.compile(
    r"\[\s*(\d+(?:\.\d+)?)\s*(?:[-~–—]\s*(\d+(?:\.\d+)?))?\s*(?:s|sec|secs|秒)?\s*\]\s*$",
    re.IGNORECASE,
)


def extract_tail_seconds(chunk):
    """从一段文字的**末尾**取时间标记，返回 (去掉标记的文字, 秒数或 None)。"""
    m = _TAIL_TIME_RE.search(chunk or "")
    if not m:
        return (chunk or "").strip(), None
    first = float(m.group(1))
    second = m.group(2)
    dur = (float(second) - first) if second is not None else first
    return chunk[:m.start()].strip(), max(0.0, dur)


def parse_shot_script(text):
    """把一份「分段稿」拆成 [(该段文字, 秒数或 None), ...]。

    怎么分段（从硬到软）：
      ① 有一整行 `---` / `===` / `***` → 按它拆（一段可以写多行，推荐）
      ② 否则若**有两行以上各自带时长标记** → 一行一段
      ③ 其余情况（含「整篇只有一处标记」）→ 整块当 1 段，不把多行描述拆碎

    每段**末尾**写时长；没写就是 None（节点据此报错，绝不猜）。

        女孩特写，她低头看着掌心 [3]
        ---
        镜头转向男人，他脸上长出胡子 [4]

    `[3]` / `[3s]` / `[3秒]` = 本段 3 秒；`[0-3]` / `[3-7]` = 时长 3 秒 / 4 秒。
    """
    raw = (text or "").strip()
    if not raw:
        return []

    lines = raw.splitlines()
    if any(re.fullmatch(r"\s*(?:-{3,}|={3,}|\*{3,})\s*", ln) for ln in lines):
        chunks = re.split(r"^\s*(?:-{3,}|={3,}|\*{3,})\s*$", raw, flags=re.MULTILINE)
    elif sum(1 for ln in lines if _TAIL_TIME_RE.search(ln)) >= 2:
        chunks = lines
    else:
        chunks = [raw]

    out = []
    for chunk in chunks:
        body, sec = extract_tail_seconds(chunk)
        if body:
            out.append((body, sec))
    return out
