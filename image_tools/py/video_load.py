# 🔁XH-加载视频（XH 家族）
#
# 复刻 comfyui-videohelpersuite 的 LoadVideoUpload（`VHS_LoadVideo`，"Load Video (Upload)"）
# 的实用精简版，2026-10-14。原包可以照常装着，两套并存、互不干扰（class_type 不同）。
#
# ── 复刻范围（用户 2026-10-14 选的「精简实用版」）────────────────────────────
#   保留：video / force_rate / custom_width / custom_height /
#         frame_load_cap / skip_first_frames / select_every_nth
#   砍掉：vae（→LATENT 动态输出）、format 预设下拉、meta_batch（要配 VHS 自家节点）、
#         video_info 第四输出口（VHS 私有类型，别的包不认）
#
# ── 依赖：零新增 ──────────────────────────────────────────────────────────
#   · 读帧 → cv2（XH 包存量依赖，就在本包 _AUTO_DEPS 白名单里，接缝修正也在用）
#   · 音频 → av（PyAV）：**ComfyUI 官方自带**（`comfy_extras/nodes_video.py` 就 import av），
#            所以不算新增依赖。VHS 用 ffmpeg 子进程 + imageio_ffmpeg，我们不引那条链。
#   · 两者都**在函数内 import** —— 万一环境真没有，也只影响这一个节点的执行，
#     不会拖垮 image_tools 子模块里的其他 11 个节点。
#
# ── 相比 VHS 原版，针对 ComfyUI 官方新前端（Nodes 2.0）的优化 ────────────────
#   ① 输出类型固定用**官方标准类型**（IMAGE / INT / AUDIO / VIDEO），不再用 VHS 的
#      `MultiInput("IMAGE", ["IMAGE","LATENT"])` 多类型技巧 —— 新前端对"一个口多种类型"
#      的着色与匹配判断容易乱，固定类型后跟官方节点生态完全互通。
#      （video 口 2026-10-16 补：官方 LoadVideo 同机制 VideoFromFile 原样直通，
#       专门用来接官方「获取视频元素」GetVideoComponents —— 用户实测缺这个口。）
#   ② 不拉 psutil（VHS 只在 meta_batch 估内存时用）→ 依赖更少。
#   ③ 返回值里**不含任何 VHS 私有类型**，工作流可脱离 VHS 独立运行。
#   前端侧的优化（DOM 真按钮 / 拖拽 / 信息条）见 `web/xh_video_load.js` 顶部说明。
#
# ── 行为对齐 ──────────────────────────────────────────────────────────────
#   抽帧逻辑（force_rate 时间步进 / skip_first_frames / select_every_nth / frame_load_cap）
#   与缩放逻辑（custom_width/height → 对齐 8 的倍数 + lanczos 居中裁剪）**逐行照抄 VHS**，
#   默认参数下输出与 VHS 原版一致。

from __future__ import annotations

import os

import numpy as np
import torch

import folder_paths
from comfy.utils import common_upscale

# 视频扩展名（与 VHS 一致）
VIDEO_EXTENSIONS = ("webm", "mp4", "mkv", "gif", "mov")

BIGMAX = (2 ** 53 - 1)
DIMMAX = 8192

# 「精确直读」阈值（2026-10-21）：起始帧 ≤ 2400（≈100 秒 @24fps）时从第 0 帧数帧、
# 不 seek —— 本机 OpenCV 在部分封装上 get(POS_MSEC) 汇报的是请求值而非真实落点
# （实测：请求 4500ms 报 4458ms、实际落在第 11 帧），数帧补齐会整体偏几十帧。
# 超过阈值才走 seek + 数帧（快，精度与老秒模式相同）。
EXACT_SKIP_MAX = 2400


# ---------------------------------------------------------------------------
# 小工具
# ---------------------------------------------------------------------------
def _list_input_videos():
    """扫 ComfyUI 的 input 目录，列出所有视频文件（供下拉框）。"""
    d = folder_paths.get_input_directory()
    out = []
    try:
        for f in os.listdir(d):
            if os.path.isfile(os.path.join(d, f)):
                parts = f.rsplit(".", 1)
                if len(parts) > 1 and parts[-1].lower() in VIDEO_EXTENSIONS:
                    out.append(f)
    except Exception:
        pass
    return sorted(out)


def _target_size(width, height, custom_width, custom_height, downscale_ratio=8):
    """按 custom_width/height 算目标尺寸（照抄 VHS target_size）。"""
    if downscale_ratio is None:
        downscale_ratio = 8
    if custom_width == 0 and custom_height == 0:
        pass
    elif custom_height == 0:
        height = height * custom_width / width
        width = custom_width
    elif custom_width == 0:
        width = width * custom_height / height
        height = custom_height
    else:
        width = custom_width
        height = custom_height
    width = int(width / downscale_ratio + 0.5) * downscale_ratio
    height = int(height / downscale_ratio + 0.5) * downscale_ratio
    return (width, height)


def _estimate_frames(total_frames, fps, force_rate, select_every_nth, frame_load_cap):
    """预计能加载多少帧（照抄 VHS 的 yieldable_frames 算法）。"""
    if total_frames > 0 and fps > 0:
        if force_rate:
            y = int(total_frames / fps * force_rate)
        else:
            y = total_frames
        if select_every_nth:
            y //= select_every_nth
        if frame_load_cap:
            y = min(frame_load_cap, y)
    else:
        y = 0
    return int(y)


# ---------------------------------------------------------------------------
#  seek 续段（2026-10-22）：把解码器跳到「输出帧 start_frame」之前，并给出全局格位相位
# ---------------------------------------------------------------------------
def _seek_to_output_frame(vc, fps, eff_rate, start_frame):
    """跳到输出帧 start_frame 之前（带 keyframe 容错），返回 (skip_first_frames, init_offset)。

    · init_offset 非 None ⇒ 重采样格位与「从第 0 帧连续跑」严格同一把尺，且 skip=0
      （第一个吐出来的帧就是输出帧 start_frame，段间接缝零偏移）。
    · init_offset 为 None ⇒ 回读失败或落点过晚，退回老口径（调用方用返回值里的 skip）。

    实证（本机 FFMPEG 后端 + ComfyUI 自产 mp4）：
      · set(POS_MSEC) 后 POS_FRAMES == 下一个待解码帧的真实索引（50/117/200 全对）；
      · set(POS_MSEC) 后 POS_MSEC 回的是近似值（请求 2000 报 1960），不能当落点用。
    """
    import cv2
    _target_ft = 1.0 / eff_rate
    # 与 _iter_frames 同一把刀尖格容差（见那边注释）：落点相位贴到 target 上时，
    # 浮点毛刺可能让 _io 变成 target-1e-17 混过严格 < 判断 ⇒ 段首帧整体晚一帧。
    _eps = min(1e-7, 0.25 / (fps * eff_rate))
    _start_sec_equiv = start_frame / eff_rate
    try:
        vc.set(cv2.CAP_PROP_POS_MSEC, max(0.0, (_start_sec_equiv - 0.5) * 1000.0))
        _land = int(vc.get(cv2.CAP_PROP_POS_FRAMES) or 0)      # 下一个待解码帧索引（精确）
        _actual_ms = vc.get(cv2.CAP_PROP_POS_MSEC)             # 近似值，仅兜底用
        _actual_sec = (_actual_ms or 0) / 1000.0
        if _land > 0:
            _io = (_land - 1) / fps - (start_frame - 1) / eff_rate
            # 落点至少在段首前一个输出格 ⇒ 相位不会触发“免费吐当前帧”，安全
            # （减 _eps：贴脸到 target 的落点直接判负，退回兜底，避免毛刺混过）
            if _io < _target_ft - _eps:
                return (0, _io)
        if _actual_sec > 0 and _actual_sec <= _start_sec_equiv:
            return (max(0, start_frame - int(_actual_sec * eff_rate)), None)
    except Exception:
        pass
    # 落点竟晚于段首（关键帧太稀）/ 回读全失败 ⇒ 退回从 0 开始按绝对帧索引跳（正确但慢）
    try:
        vc.set(cv2.CAP_PROP_POS_MSEC, 0.0)
    except Exception:
        pass
    try:
        print(f"[XH-LoadVideo] seek 相位修正未生效（回读失败/落点过晚）⇒ 退回从第 0 帧跳过 {start_frame} 帧（结果仍正确，只是慢）")
    except Exception:
        pass
    return (start_frame, None)


# ---------------------------------------------------------------------------
# 读帧（cv2）—— 逻辑照抄 VHS 的 cv_frame_generator
# ---------------------------------------------------------------------------
def _iter_frames(vc, fps, force_rate, frame_load_cap, skip_first_frames, select_every_nth,
                 init_offset=None):
    """按 force_rate 重采样 / 跳帧 / 抽帧，逐帧 yield (H,W,3) float32 的 np 数组。
    init_offset：time_offset 初值（秒）。None = 老行为（从 target 起算，格位锚在“当前帧”）；
        传具体值 = 把重采样格位钉到**全局时间格**上（seek 续段用，见 _seek_to_output_frame）。
        🔴 2026-10-22：起始输出帧 S 的正确初值 = (落点帧号-1)/fps - (S-1)/force_rate，
        S=0 时恰为 target_frame_time ⇒ 与“从第 0 帧连续跑”完全同一把尺。"""
    import cv2

    base_frame_time = 1.0 / fps
    if force_rate == 0:
        target_frame_time = base_frame_time
    else:
        target_frame_time = 1.0 / force_rate

    # 🔴 2026-10-22 浮点"刀尖格"容差：time_offset 的精确值恒在 m/(fps*force_rate) 整数网格上，
    # 与 target 的比较距离都是 1/(fps*force_rate) 的整数倍——非零时 ≥1 格（≈1e-3 量级），
    # 为零时（精确 time_offset+base == target，即"刀尖格"：30→24 每 4 个输出帧一个、
    # 25→24 每 24 个输出帧一个）浮点累积噪声（~1e-17）会让 seek 续段与连续跑做出相反决策
    # （一边多 grab 一次丢源帧 + 下一次免费重吐，整段错位一帧；实测 25→24 段内 4/5 刀尖格翻转）。
    # 减 EPS 后：非刀尖格距离 ≥4×EPS 行为不变；刀尖格按精确数学定案（yield，n=1）⇒ 两条路径逐帧一致。
    _eps = min(1e-7, 0.25 / (fps * (force_rate if force_rate else 1.0)))

    total_frame_count = 0
    total_frames_evaluated = -1
    frames_added = 0
    time_offset = target_frame_time if init_offset is None else float(init_offset)

    while vc.isOpened():
        if time_offset < target_frame_time - _eps:
            if not vc.grab():
                break
            time_offset += base_frame_time
        if time_offset < target_frame_time - _eps:
            continue
        time_offset -= target_frame_time

        total_frame_count += 1
        if total_frame_count <= skip_first_frames:
            continue
        total_frames_evaluated += 1

        if total_frames_evaluated % select_every_nth != 0:
            continue

        ok, frame = vc.retrieve()
        if not ok or frame is None:
            break
        # opencv 是 BGR，转成 ComfyUI 要的 RGB float32 [0,1]
        frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        yield np.array(frame, dtype=np.float32) / 255.0

        frames_added += 1
        if frame_load_cap > 0 and frames_added >= frame_load_cap:
            break


# ---------------------------------------------------------------------------
# 抽音频（av）—— 输出 ComfyUI 官方 AUDIO 格式 {waveform: [B,C,T], sample_rate: int}
# ---------------------------------------------------------------------------
def _empty_audio(sample_rate=44100):
    return {"waveform": torch.zeros((1, 2, 0), dtype=torch.float32), "sample_rate": int(sample_rate)}


def _load_audio(path, start_time=0.0, duration=0.0):
    """用 av（PyAV）从视频里抽音轨。失败不抛错，返回空音频（画面照样能用）。"""
    try:
        import av

        with av.open(path) as cont:
            if not cont.streams.audio:
                return _empty_audio()
            st = cont.streams.audio[0]
            rate = int(getattr(st, "rate", None) or getattr(st, "sample_rate", 0) or 44100)
            channels = int(getattr(st, "channels", 0) or 2)
            layout = "mono" if channels == 1 else "stereo"

            if start_time and start_time > 0:
                # 🔴 不传 stream= —— 传了的话 offset 单位会变成 stream.time_base（音频是 1/44100），
                #    按 av.time_base（1/1000000）传就会 seek 到 22 秒之后（实测：只剩 1024 采样）。
                try:
                    cont.seek(int(start_time * av.time_base))
                except Exception:
                    pass

            resampler = av.AudioResampler(format="fltp", layout=layout, rate=rate)
            limit = int(round(duration * rate)) if duration and duration > 0 else 0
            chunks = []
            total = 0

            def _take(frames):
                nonlocal total
                for rf in frames:
                    arr = rf.to_ndarray()          # planar float：shape (channels, samples)
                    if arr.ndim == 1:
                        arr = arr.reshape(1, -1)
                    chunks.append(arr)
                    total += arr.shape[-1]

            for af in cont.decode(st):
                _take(resampler.resample(af))
                if limit and total >= limit:
                    break
            _take(resampler.resample(None))        # 无条件 flush 尾部残留（超限的部分下面会截掉）

            if not chunks:
                return _empty_audio(rate)

            data = np.concatenate(chunks, axis=-1)
            if limit and data.shape[-1] > limit:
                data = data[:, :limit]
            wav = torch.from_numpy(np.ascontiguousarray(data, dtype=np.float32)).unsqueeze(0)
            return {"waveform": wav, "sample_rate": rate}
    except Exception as e:                              # noqa: BLE001
        print(f"[XH LoadVideo] 抽音频失败，输出空音频（画面不受影响）：{type(e).__name__}: {e}")
        return _empty_audio()


def _video_from_file(path):
    """造官方 VIDEO 类型输出（与官方 LoadVideo 的 video 口同源：原始文件直通）。

    失败不抛错（返回 None）—— 绝不能因为 comfy_api 缺失拖垮整个节点的图像/音频输出。
    """
    try:
        from comfy_api.latest import InputImpl

        return InputImpl.VideoFromFile(path)
    except Exception as e:                              # noqa: BLE001
        print(f"[XH LoadVideo] 造 VIDEO 输出失败（该口输出空，图像/音频不受影响）：{type(e).__name__}: {e}")
        return None


# ---------------------------------------------------------------------------
# 元数据探测（给前端的「视频信息预览条」+ 路由用）
# ---------------------------------------------------------------------------
def _probe_video(path):
    import av

    with av.open(path) as cont:
        streams = cont.streams.video
        if not streams:
            raise ValueError("文件里没有视频轨")
        st = streams[0]
        fps = 0.0
        try:
            if st.average_rate:
                fps = float(st.average_rate)
        except Exception:
            pass
        if fps <= 0:
            try:
                fps = float(st.base_rate) if st.base_rate else 0.0
            except Exception:
                fps = 0.0
        try:
            duration = float(cont.duration / av.time_base) if cont.duration else 0.0
        except Exception:
            duration = 0.0
        width = int(getattr(st.codec_context, "width", 0) or 0)
        height = int(getattr(st.codec_context, "height", 0) or 0)
        if not width or not height:
            for frame in cont.decode(st):
                width, height = frame.width, frame.height
                break
        frames_total = int(getattr(st, "frames", 0) or 0)
        if not frames_total and duration and fps:
            frames_total = int(round(duration * fps))
        if not duration and frames_total and fps:
            duration = frames_total / fps

    return {
        "width": width,
        "height": height,
        "fps": round(fps, 3),
        "frames_total": frames_total,
        "duration": round(duration, 3),
    }


# ---------------------------------------------------------------------------
# 路由（给信息条用）—— 注册失败只打日志，绝不影响节点本身
# ---------------------------------------------------------------------------
_ROUTES_DONE = False


def register_routes():
    global _ROUTES_DONE
    if _ROUTES_DONE:
        return
    from aiohttp import web
    from server import PromptServer

    routes = PromptServer.instance.routes

    @routes.get("/xh/videoload/probe")
    async def _xh_videoload_probe(request):
        q = request.rel_url.query
        fn = (q.get("filename") or "").strip()
        if not fn:
            return web.json_response({"ok": False, "error": "缺少 filename 参数"}, status=400)
        try:
            path = folder_paths.get_annotated_filepath(fn)
        except Exception:
            path = None
        if not path or not os.path.isfile(path):
            return web.json_response({"ok": False, "error": f"文件不存在：{fn}"}, status=404)
        try:
            info = _probe_video(path)
            info["ok"] = True
            info["file"] = os.path.basename(path)
            return web.json_response(info)
        except Exception as e:                          # noqa: BLE001
            # 故意不静默：把原因带回前端显示（VHS 的 /vhs/queryvideo 是 except: pass）
            return web.json_response({"ok": False, "error": f"{type(e).__name__}: {e}"}, status=200)

    _ROUTES_DONE = True


# ---------------------------------------------------------------------------
# 节点
# ---------------------------------------------------------------------------
def _images_output_connected(dynprompt, unique_id):
    """懒加载判定：本节点的 images 输出口（slot 0）有没有被下游接走。

    ComfyUI 跑节点时会把「整个 load_video」都执行、所有输出都算出来，
    哪怕你只连了 audio 口 —— 这正是「只取音频却爆内存」的根因（image 批
    在 audio 之前就堆出来了）。所以：如果 images 口根本没人接，就跳过
    逐帧解码，直接返空占位 + 音频，省掉 158GB 那种全量加载。

    拿不到图（dynprompt 为 None / 解析异常）时保守返回 True（照常解码），
    绝不因探测失败而误跳过。
    """
    if dynprompt is None or unique_id is None:
        return True
    try:
        prompt = dynprompt.get_original_prompt()
        rid = dynprompt.get_real_node_id(unique_id)
    except Exception:
        return True
    if not isinstance(prompt, dict):
        return True
    candidates = {unique_id, rid}
    for nid, node in prompt.items():
        if not isinstance(node, dict):
            continue
        inputs = node.get("inputs") or {}
        if not isinstance(inputs, dict):
            continue
        for v in inputs.values():
            # 连线在 API 格式里表示为 ["源节点id", 源slot]
            if isinstance(v, (list, tuple)) and len(v) == 2 and v[0] in candidates:
                if v[1] == 0:                      # slot 0 = images
                    return True
    return False


class XHLoadVideo:
    """从 input 目录选一个视频，解码成图像批 + 帧数 + 音频。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "video": (_list_input_videos(), {
                    "tooltip": (
                        "【🔁 视频文件】列出的是 ComfyUI 的 input 目录里的视频。\n"
                        "没有你想要的？点节点上的「⬆ 上传视频」按钮选文件，或直接把视频拖到节点上，\n"
                        "上传完会自动选中（也能手动把文件拷进 ComfyUI\\input\\ 后刷新页面）。\n"
                        "支持：mp4 / mkv / webm / mov / gif\n"
                        "⚠️ 列表为空 = input 目录里一个视频都没有。"
                    ),
                }),
                "force_rate": ("FLOAT", {
                    "default": 24.0, "min": 0.0, "max": 60.0, "step": 1.0,
                    "tooltip": (
                        "【🎞 目标帧率】重采样成多少帧/秒（填 0 = 保持视频原本的帧率，不动它）。【节点默认 24】\n"
                        "· 常填数：24（电影感）· 25 / 30（常规）· 16（Wan 系模型）· 8（AnimateDiff）\n"
                        "· 视频 30fps、这里填 24 → 会按时间抽掉一部分帧，成片变 24fps\n"
                        "🔁 循环拼接必读（30→24 实测结论）：\n"
                        "  ① 取帧规则：第 k 个输出帧 = 源视频第 ceil(k×源fps÷目标fps) 帧\n"
                        "     （每个 1/目标fps 秒格，取第一个时间 ≥ 格起点的源帧；纯丢帧、不插值）\n"
                        "     ⇒ 30→24 = 每 5 个源帧丢 1 个；总帧数 = floor(源总帧÷源fps×目标fps)，时长不变\n"
                        "  ② 接缝保证：起始帧按【目标帧率域】计数、每段从同一相位起算 ⇒\n"
                        "     段 n 末帧与段 n+1 首帧严格相邻（不重帧、不漏帧），\n"
                        "     与「整段不间断放遍一遍」逐帧一致（起始 >2400 帧走 seek 快路径，同样对齐）\n"
                        "⚠️ 它只改「每秒取几帧」，不改播放速度；想看原速就填 0。"
                    ),
                }),
                "custom_width": ("INT", {
                    "default": 0, "min": 0, "max": DIMMAX, "step": 8,
                    "tooltip": (
                        "【↔ 目标宽度】等比缩放到这个宽度（填 0 = 用原视频宽度）。\n"
                        "· 只填宽度：高度按比例自动算\n"
                        "· 宽度高度都填：直接拉到该尺寸（不改比例，可能拉伸）\n"
                        "· 常填数：512 / 768 / 832 / 1024 / 1280\n"
                        "⚠️ 最终会自动对齐到 8 的倍数（模型要求）。"
                    ),
                }),
                "custom_height": ("INT", {
                    "default": 0, "min": 0, "max": DIMMAX, "step": 8,
                    "tooltip": (
                        "【↕ 目标高度】等比缩放到这个高度（填 0 = 用原视频高度）。\n"
                        "· 只填高度：宽度按比例自动算\n"
                        "· 竖屏短视频常填 1280 / 1920 那种就填宽；这里填高（如 1280）\n"
                        "⚠️ 和宽度一样，最终对齐到 8 的倍数。"
                    ),
                }),
                "frame_load_cap": ("INT", {
                    "default": 124, "min": 0, "max": BIGMAX, "step": 1,
                    "tooltip": (
                        "【✂ 最多加载帧数】只取前 N 帧（填 0 = 不限，整段都要）。【节点默认 124】\n"
                        "· 短视频模型（H3 / LTX / Wan）一般只要几秒 → 这里限一下省显存\n"
                        "· 例：24fps 想要 5 秒 → 填 120\n"
                        "⚠️ 配合下面的「每隔几帧取一帧」一起用时，是先重采样再截断。"
                    ),
                }),
                "skip_first_frames": ("INT", {
                    "default": 0, "min": 0, "max": BIGMAX, "step": 1,
                    "tooltip": (
                        "【⏭ 跳过开头帧数】从第 N 帧开始取，前面的丢掉（填 0 = 从头开始）。\n"
                        "· 用来掐掉开头不要的部分（如黑场、水印）\n"
                        "⚠️ 数的是「重采样之后」的帧，不是原视频帧。"
                    ),
                }),
                "select_every_nth": ("INT", {
                    "default": 1, "min": 1, "max": BIGMAX, "step": 1,
                    "tooltip": (
                        "【💨 每隔几帧取一帧】抽帧用（填 1 = 每帧都要，不抽）。\n"
                        "· 填 2 = 每 2 帧取 1 帧（帧数减半）· 填 3 = 每 3 帧取 1 帧\n"
                        "· 想要慢动作/定格感可以调大\n"
                        "⚠️ 和「目标帧率」是两套机制，一般只用其中一个，别两个都猛调。"
                    ),
                }),
                # 🔴 2026-10-22 FLOAT→INT：ComfyUI 不许 INT↔FLOAT 互插（前端
                #    LiteGraph.isValidConnection 精确匹配 + 后端 validate_node_input 集合求交），
                #    而 🔁XH-分段表 三个时间口都是 INT ⇒ 这四个口必须同型才连得上，
                #    否则用户被迫中间加一个「数值转换」节点，纯浪费。秒按整数秒走
                #    （家族 2026-10-21 已全链路整数化；要小数秒用 XH-浮点运算自己搭）。
                "start_sec": ("INT", {
                    "default": 0, "min": 0, "max": 86400, "step": 1,
                    "tooltip": (
                        "【⏱ 起始秒】时间段裁剪的**起点**（整数秒）。配合 duration 用：只加载这一段。\n"
                        "· 接 🔁XH-分段表 的 start_sec（INT 口直连，不用转换节点），就能在 🔁XH-循环 里逐轮自动换段（第0轮0–10s、第1轮10–20s…）\n"
                        "· 不接循环也能手动填：start_sec=10、duration=10 = 只取视频的第 10–20 秒\n"
                        "⚠️ 填 0 = 从头开始；start_sec 和 duration **任一 >0** 就进入【时间段模式】。"
                    ),
                }),
                "duration": ("INT", {
                    "default": 0, "min": 0, "max": 86400, "step": 1,
                    "tooltip": (
                        "【⏱ 时长秒】时间段裁剪的**长度**（整数秒）。决定了加载多少秒。\n"
                        "· 接 🔁XH-分段表 的 duration（INT 口直连，不用转换节点），长度由分段表统一管\n"
                        "· 例：force_rate=24、duration=10 → 约加载 240 帧\n"
                        "⚠️ 【时间段模式】下，「最多加载帧数 / 跳过开头帧数」两个帧参数**失效**，长度改由本项决定。\n"
                        "⚠️ 填 0（且 start_sec>0）= 从起点一直取到视频结尾。"
                    ),
                }),
            },
            # 🔴 帧数直供口（2026-10-21）：接 🔁XH-分段表（单位=帧）的 start_sec/duration 口，
            #    完全绕开「秒 → 帧」浮点换算；音频窗也按同一个帧数折算 ⇒ 音画严格等长。
            #    frame_count > 0 即帧模式（优先级高于秒的时间段模式）；两个都填 0 = 不用。
            #    追加在新的 optional 段 ⇒ 不动 required 位序，老存档一个字符都不串。
            # 🔴 2026-10-22：本段两个口与 required 的 start_sec/duration 一起 INT 化
            #    （ComfyUI 的 INT↔FLOAT 不许互插，分段表三个时间口都是 INT，必须同型才连得上）。
            "optional": {
                "start_frame": ("INT", {
                    "default": 0, "min": 0, "max": BIGMAX, "step": 1,
                    "tooltip": (
                        "【🎯 起始帧】从第几帧开始取（帧号，0 起；整数）。\n"
                        "· 接 🔁XH-分段表（单位=帧）的 start_sec 口 —— 帧模式专用\n"
                        "· 帧模式 = 本口配合下面的「取多少帧」>0，完全按帧走，\n"
                        "  绕开秒→帧浮点换算（5 秒不再一会 120 帧一会 124 帧）\n"
                        "⚠️ 帧号按「有效帧率」（force_rate，或源视频帧率）折算秒数；\n"
                        "   要跟下游模型的输出长度对齐，保证有效帧率就是模型那条（如 24）。\n"
                        "🔁 循环拼接：帧号在【目标帧率域】上数（force_rate=24 时 124 = 第 124 个 24fps 帧），\n"
                        "   段 n 末帧与段 n+1 首帧严格相邻；起始 >2400 帧自动走 seek 快路径\n"
                        "   （相位钉在全局时间格上），与逐帧数出来的结果完全一致。\n"
                        "⚠️ 填 0 = 不用帧模式（回到秒模式 / 帧参数模式）。\n"
                        "🔗 本口连着 🔁XH-分段表 时，ComfyUI 连线优先于手填 ⇒ 控件留 0 也会被该轮真起始帧覆盖\n"
                        "   （第 2 段起自动续接，不用手填真起始帧）。\n"
                        "⚠️ 一旦断开连线、手填 0，就是真的「从第 0 帧开始取」⇒ 第 2 段起会跳回视频开头、不再续接。"
                    ),
                }),
                "frame_count": ("INT", {
                    "default": 0, "min": 0, "max": BIGMAX, "step": 1,
                    "tooltip": (
                        "【🎯 取多少帧】这一段要几帧（整数）。\n"
                        "· 接 🔁XH-分段表（单位=帧）的 duration 口 —— 帧模式专用\n"
                        "· >0 = 帧模式：音频窗也按同一个帧数折算（round(帧数×采样率÷帧率)），\n"
                        "  与真正加载的视频帧数严格同一个源，音画不再各算各的\n"
                        "🔁 循环拼接：帧数同样按目标帧率域算；段 n 末帧 ↔ 段 n+1 首帧严格相邻，\n"
                        "   音频窗跟着同一个帧数源走，音画在每一段都严格等长。\n"
                        "⚠️ 填 0 = 不用帧模式（与上面的「起始帧」两个都填 0 = 退回秒模式）；\n"
                        "   起始帧=0 但本口 >0 ⇒ 仍走帧模式，且真的从第 0 帧开始取 N 帧。"
                    ),
                }),
            },
            # 注入连线图/节点 id（经典节点写法，execution.py 会把 DYNPROMPT / UNIQUE_ID 填进来）
            # → 用于「只取音频」时跳过帧解码（详见 load_video 里的懒加载分支）
            "hidden": {"dynprompt": "DYNPROMPT", "unique_id": "UNIQUE_ID"},
        }

    RETURN_TYPES = ("IMAGE", "INT", "AUDIO", "VIDEO")
    RETURN_NAMES = ("images", "frame_count", "audio", "video")
    FUNCTION = "load_video"
    CATEGORY = "🔁XH/Video"
    DESCRIPTION = (
        "【干什么】把 input 目录里的一个视频解码成「图像批 + 帧数 + 音频」三样，喂给下游。\n"
        "【怎么配】· video：选视频（或点节点上「⬆ 上传视频」/ 直接拖文件到节点）\n"
        "· force_rate：重采样帧率，0 = 保持原速；≠原帧率时按 ceil(k×源fps÷目标fps) 取帧\n"
        "  （纯丢帧不插值，时长不变），循环拼接段间严格相邻——详见该参数 tooltip\n"
        "· custom_width / custom_height：目标尺寸，0 = 用原尺寸；会自动对齐 8 的倍数\n"
        "· frame_load_cap：最多取几帧，0 = 整段\n"
        "· skip_first_frames / select_every_nth：跳开头 / 抽帧\n"
        "· ⏱ start_sec / duration：时间段裁剪（任一 >0 生效，**整数秒**）—— 只加载视频的某一段；"
        "接 🔁XH-分段表 的 start_sec/duration（INT 口直连，不用中间加数值转换节点），就能在 🔁XH-循环 里逐轮自动换段（第0轮0–10s、第1轮10–20s…）。时间段模式下「最多加载帧数 / 跳过开头帧数」失效，长度由 duration 决定。\n"
        "· 🎯 start_frame / frame_count：帧数直供（frame_count >0 即生效，优先级高于秒模式）—— 接 🔁XH-分段表（单位=帧）的两个口（INT 直连），"
        "完全按帧走、绕开秒→帧浮点换算；音频窗按同一个帧数折算，与视频帧数严格等长（音画不再各算各的）。\n"
        "  🔗 连着 🔁XH-分段表 时手填值被连线覆盖（控件留 0 即可自动续接）；\n"
        "  ⚠️ 断开连线手填 start_frame=0 ⇒ 从第 0 帧取，第 2 段起不再续接。\n"
        "【怎么用】VIDEO → IMAGE 链（给它接 VAE Encode、或视频模型的首帧/参考帧输入）。\n"
        "【输出】images（IMAGE 批）· frame_count（INT，实际加载帧数）· audio（AUDIO，视频里的音轨）·\n"
        "        video（VIDEO，选中的视频文件原样直通 —— 可直接接官方「获取视频元素」等 VIDEO 输入；\n"
        "        ⚠️ 该口不受抽帧/缩放/帧数上限影响，那些参数只管 images/audio 两口）。\n"
        "⚠️ 无音轨的视频会输出「空音频」，不会报错。\n"
        "⚠️ 懒加载：下游只接了 audio（或 video）口、没接 images 口时，节点会**跳过帧解码**，\n"
        "   只吐音频（images 给一张 1 帧占位图）—— 这样「只提取音频」不会再因视频太大而爆内存。\n"
        "   接了 images 口才解码全部帧（那时才需要靠 frame_load_cap/缩放压内存）。\n"
        "⚠️ 这是 VHS「Load Video (Upload)」的 XH 精简版：没有 vae/format/meta_batch；\n"
        "   原包可继续装着，两套互不干扰。"
    )

    def load_video(self, video, force_rate, custom_width, custom_height,
                   frame_load_cap, skip_first_frames, select_every_nth,
                   start_sec=0, duration=0,
                   start_frame=0, frame_count=0,
                   dynprompt=None, unique_id=None):
        import cv2

        path = folder_paths.get_annotated_filepath(video)
        if not path or not os.path.isfile(path):
            raise FileNotFoundError(f"找不到视频文件：{video}（应在 ComfyUI 的 input 目录下）")

        vc = cv2.VideoCapture(path)
        if not vc.isOpened() or not vc.grab():
            raise ValueError(f"无法解码这个视频：{video}（可能编码不受支持或文件损坏）")

        try:
            fps = float(vc.get(cv2.CAP_PROP_FPS) or 0.0)
            if fps <= 0:
                fps = 25.0                       # 兜底：有些容器读不到帧率
            total_frames = int(vc.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
            width = int(vc.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
            height = int(vc.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
            if width <= 0 or height <= 0:
                ok, fr = vc.retrieve()           # 已经 grab 过，这里取回的是第 1 帧
                if ok and fr is not None:
                    height, width = fr.shape[0], fr.shape[1]
            if width <= 0 or height <= 0:
                raise ValueError(f"读不到视频尺寸：{video}")

            new_w, new_h = width, height
            do_scale = (custom_width != 0 or custom_height != 0)
            if do_scale:
                new_w, new_h = _target_size(width, height, custom_width, custom_height)

            # ── 懒加载：只有 images 口被下游接走时，才真的逐帧解码 ─────────
            # 只连 audio（或 video）口时，ComfyUI 照样会跑完整个函数、把 IMAGE
            # 批也算出来（image 在 audio 之前就堆）→ 大视频必 OOM。这里先探测
            # images 口有没有人接，没人接就跳过解码，直接返空占位图 + 音频。
            decode_frames = _images_output_connected(dynprompt, unique_id)
            # 三种模式（优先级从高到低）：
            #   ① 帧数直供：frame_count > 0 ⇒ 完全按帧走（起始帧 + 帧数），音频同源折算；
            #   ② 时间段：start_sec / duration 任一 >0 ⇒ 秒 → 绝对帧索引（floor）；
            #   ③ 帧模式：skip_first_frames / frame_load_cap（老 VHS 行为）。
            def _f(v):
                try:
                    return float(v) if v is not None else 0.0
                except (TypeError, ValueError):
                    return 0.0
            frame_mode = _f(frame_count) > 0.0
            time_mode = (not frame_mode) and (start_sec > 0.0 or duration > 0.0)
            if frame_mode or time_mode:
                _eff_rate = force_rate if force_rate > 0 else fps
                if frame_mode:
                    # ★★ 帧数直供：起始帧 / 帧数都是上游（分段表·帧单位）算好的整数，
                    #    本节点不再做任何「秒 → 帧」换算 ⇒ 5 秒不会再一会 120 帧一会 124 帧。
                    _start_frame = max(0, int(_f(start_frame) + 0.5))
                    _seg_cap = max(1, int(int(_f(frame_count) + 0.5) / max(1, select_every_nth)))
                else:
                    # ★★ 无缝拼接关键：用「绝对帧索引」，而不是每段各自把秒数 round 成帧数 ★★
                    # 段 n   的结束帧 = floor((start + duration) × rate)
                    # 段 n+1 的起始帧 = floor(start_{n+1} × rate) ，而 start_{n+1} == start_n + duration_n
                    # ⇒ 两个是**同一个表达式** ⇒ 严格相等 ⇒ 段间绝不漏帧、绝不重复帧。
                    # 旧写法 round(duration×rate) / round(start×rate) 各自取整，遇到除不尽的秒数
                    # （如 3.3s×24=79.2）会在不同段给出不一致结果 → 接缝丢 1 帧 → 人物替换会闪一下。
                    _start_frame = int(start_sec * _eff_rate)          # 正数截断 == floor
                    if duration > 0.0:
                        _end_frame = int((start_sec + duration) * _eff_rate)
                        _span = max(1, _end_frame - _start_frame)
                        # frame_load_cap 比的是「抽帧后真正 yield 出来的帧数」，故按 every 折算
                        _seg_cap = max(1, int(_span / max(1, select_every_nth)))
                    else:
                        _seg_cap = BIGMAX
                _eff_skip = _start_frame
                # 段首等效秒：seek 落点与音频窗共用同一个数 ⇒ 音画同源
                # （帧模式下 = 起始帧 ÷ 有效帧率；秒模式下 = floor 后的起始帧 ÷ 有效帧率，
                #   与原 start_sec 相差不到一帧，落点校验逻辑会兜住）
                _start_sec_equiv = _start_frame / _eff_rate
                # ── 精确直读（2026-10-21）────────────────────────────────────
                # 实测（本机 OpenCV + cv2 自写 mp4v）：set(POS_MSEC) 之后
                # get(POS_MSEC) 汇报的是「请求值」而不是真实落点
                # （请求 4500ms → 报 4458ms，实际解码落在第 11 帧）
                # ⇒ 「汇报落点 + 数帧补齐」在这种封装上会整体偏几十帧。
                # 起始帧 ≤ EXACT_SKIP_MAX（2400 帧 ≈ 100 秒 @24fps）时，解码到那里的
                # 代价也就一两秒，换来 100% 准确 —— 接帧错一帧，人物替换就闪一下，值得。
                # 超过阈值才走下面的 seek + 数帧（快，精度与老秒模式相同）。
                if _start_frame <= EXACT_SKIP_MAX:
                    pass                      # 精确直读：不 seek，从第 0 帧数起
                    _init_offset = None
                else:
                    # ★ 2026-10-22 相位修正：POS_FRAMES 回读精确 ⇒ 直接算全局格位初相，
                    #   选帧格与「连续跑」同一把尺 ⇒ 段间接缝严格相邻（实测旧口径 124 帧偏 45 帧）。
                    _eff_skip, _init_offset = _seek_to_output_frame(vc, fps, _eff_rate, _start_frame)
            else:
                _seg_cap = frame_load_cap
                _eff_skip = skip_first_frames
                # 帧模式（老 VHS 行为）：没有 seek、从第 0 帧数起 ⇒ 重采样格位就该锚在
                # “当前帧”（init_offset=None 的老行为）。漏了这行，下面的 _iter_frames
                # 会直接 UnboundLocalError（2026-10-23 修复：帧模式 + frame_count/start_sec/duration 全 0 时必炸）。
                _init_offset = None
            frames = []
            if decode_frames:
                try:
                    for arr in _iter_frames(vc, fps, force_rate, _seg_cap, _eff_skip, select_every_nth, _init_offset):
                        frames.append(arr)
                        if _seg_cap > 0 and len(frames) >= _seg_cap:
                            break
                except MemoryError:
                    _est = width * height * 3 * 4 * max(total_frames, 1) / 1e9
                    raise ValueError(
                        f"内存不足：视频「{video}」太大（{width}x{height}，约 {total_frames} 帧），"
                        f"全量加载约需 {_est:.1f}GB，刚加载了 {len(frames)} 帧就爆了。\n"
                        f"→ 请把「帧数上限」设为有限值（如 100~300），或在「自定义宽/高」里缩小尺寸后再加载。"
                    ) from None
        finally:
            vc.release()

        if decode_frames:
            if not frames:
                raise ValueError(
                    f"一帧都没读到：{video}\n"
                    f"（原视频 {total_frames} 帧 / {fps:.2f}fps；"
                    f"检查「跳过开头帧数」是不是填得比总帧数还大）"
                )

            try:
                images = torch.from_numpy(np.stack(frames, axis=0))
            except MemoryError:
                _est2 = width * height * 3 * 4 * len(frames) / 1e9
                raise ValueError(
                    f"内存不足：{len(frames)} 帧 {width}x{height} 拼成批就爆了（约需 {_est2:.1f}GB）。\n"
                    f"→ 请把「帧数上限」调小，或在「自定义宽/高」里缩小尺寸。"
                ) from None
            if do_scale and (new_w != width or new_h != height):
                x = images.movedim(-1, 1)                              # (N,H,W,3) -> (N,3,H,W)
                x = common_upscale(x, new_w, new_h, "lanczos", "center")
                images = x.movedim(1, -1)                              # -> (N,H,W,3)
            frame_count = int(len(frames))
        else:
            # images 口没人接（只取音频/视频）：给一张 1 帧占位图，不占内存；
            # 帧数从元数据估算（不必真解码）。下游没接这两口，数值不影响结果。
            _h = height if height > 0 else 64
            _w = width if width > 0 else 64
            images = torch.zeros((1, _h, _w, 3), dtype=torch.float32)
            _eff = _seg_cap if (frame_mode or time_mode) else total_frames
            if (not frame_mode) and (not time_mode) and frame_load_cap > 0:
                _eff = min(_eff, frame_load_cap) if _eff > 0 else frame_load_cap
            frame_count = int(_eff)

        # 音频：帧模式 / 时间段模式都按「帧数 ÷ 有效帧率」折算时间窗
        #   ⇒ 与真正加载的视频帧数严格同一个源。老代码音频 round(秒×采样率)、
        #     视频 floor(秒×帧率) 两套口径，音画长度能差几毫秒到几帧。
        if frame_mode or time_mode:
            start_time = _start_frame / _eff_rate
            audio_dur = (_seg_cap / _eff_rate) if _seg_cap < BIGMAX else 0.0
        else:
            target_ft = (1.0 / fps) if force_rate == 0 else (1.0 / force_rate)
            start_time = skip_first_frames * target_ft
            audio_dur = (frame_load_cap * target_ft * select_every_nth) if frame_load_cap > 0 else 0.0
        audio = _load_audio(path, start_time, audio_dur)

        # video 口：原始文件直通（与官方 LoadVideo 同机制），放在末位不串老工作流的旧连线
        return (images, frame_count, audio, _video_from_file(path))

    @classmethod
    def IS_CHANGED(cls, video, **kwargs):
        """文件改了（mtime 变）就重跑 —— 与 VHS 同一口径，避免大文件反复哈希。"""
        try:
            path = folder_paths.get_annotated_filepath(video)
            return f"{video}:{os.path.getmtime(path)}"
        except Exception:
            return float("NaN")

    @classmethod
    def VALIDATE_INPUTS(cls, video, **kwargs):
        try:
            if not folder_paths.exists_annotated_filepath(video):
                return f"输入目录里没有这个视频：{video}"
        except Exception:
            pass
        return True


NODE_CLASS_MAPPINGS = {
    "XHLoadVideo": XHLoadVideo,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "XHLoadVideo": "🔁XH-加载视频",
}
