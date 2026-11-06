# -*- coding: utf-8 -*-
"""🎵XH-加载音频（XH 家族）—— 后端

复刻 ComfyUI 官方 `LoadAudio`（`comfy_extras/nodes_audio.py`），2026-10-16。
用户原话：「官方的加载音频节点用着特别不方便，尤其是下面那条线（进度条）太细了，
拖拽都不方便。我们做一个我们 XH 家族的吧。」

── 与官方的关系 ──────────────────────────────────────────────────────────────
  · **输出逐字一致**：`{"waveform": [1, C, T], "sample_rate": int}`，
    解码内核（f32_pcm + load）用一次性脚本从官方 nodes_audio.py **原文切出**
    （只改名 `_xh_f32_pcm` / `_xh_load_audio`，逻辑一行没动）⇒ 换节点不用改线。
  · 文件列表口径与官方 define_schema 相同：
    `folder_paths.filter_files_content_types(os.listdir(input_dir), ["audio", "video"])`
    （官方也列视频文件——有些视频只剩音轨可用）。
  · 缓存指纹：官方 V3 用 fingerprint_inputs 全量 sha256；本包老 API 改用
    **IS_CHANGED = mtime_ns + size**（与包内 XHLoadVideo 同口径，避免大文件反复哈希）。

── 前端（web/xh_audio_load.js）才是本节点的正主 ──────────────────────────────
  自绘播放器：**粗时间线**（10px 轨道 + 16px 圆形拖把手，按住拖动实时 seek、
  轨道任意位置点击跳转）+ 播放/暂停 + 时间显示 + 音量静音切换与滑块 +
  信息条（时长 / 采样率 / 声道，走本文件的 /xh/audioload/probe 路由）。

── 📂 文件夹模式 + 循环轮次索引（2026-10-16，用户原话：「之后我还会加入到
  我们 XH 家族的那个循环节点的循环当中……需不需要加个索引/序号，或者一个
  可以从文件夹里调整个文件夹的功能」）────────────────────────────────────
  · **为什么必须加**：循环体里一个死磕单文件的节点 = 每一轮都读同一个文件，
    循环对音频毫无意义。文件夹模式 = 第 i 轮读第 i 个音频，这才是循环的意义。
  · **零接线拿轮次**：XH-循环展开时给所有 class_type 以 "XH" 开头的节点注入
    隐藏输入 `xh_loop_turn`（真实轮次 0 起，for_loop.py 的 copy.set_input）。
    节点只要在 hidden 里声明它就能收到（execution.py:194：input_category
    非 None 才进 kwargs）⇒ 不声明 = 注入值被静默丢弃、每轮读同一个文件。
  · **索引三段论**（与 🔁XH-提示词表逐字同构）：
      ① start_index 有接线（is_link）⇒ 以它为准（跳过前 N 个 / 只重跑第 N 个）；
      ② 否则在循环体内（xh_loop_turn >= 0）⇒ 段号 = 轮次，无状态；
      ③ 否则（循环体外）⇒ 第 1 个（想换就改 start_index 或接索引）。
    `loop` 开关只决定「索引用完后」：开 = 绕回第 1 个；关 = 停在最后一个。
  · **画布只存文件夹路径**，execute 时才读盘（与 🖼️XH-图片列表 / 提示词表一致），
    文件夹里加/换文件后重跑即刷新；文件口径 = filter_files_content_types
    (["audio","video"])，与下拉框完全一致；自然排序；上限 2000。
  · 🔴 **每轮只解码选中的那一个文件**——绝不一次性解码整个文件夹
    （AUDIO 不是 IMAGE 张量批次，列表广播 = 内存炸弹，8GB 机器上别赌）。
  · 单文件模式行为**一字未动**（老工作流零影响）；新控件全部追加在
    老控件后面，不挤占老存档 widgets_values 的位置。

── 依赖：零新增 ──────────────────────────────────────────────────────────────
  · 解码 → av（PyAV）：ComfyUI 官方自带（nodes_audio 自己就 import av），不算新增。
  · torch：ComfyUI 核心，顶层 import 安全（controls 其余节点同口径）。
  · 🔴 av **绝不顶层 import**：controls/__init__.py 是逐个文件 import 再合并的，
    顶层 import av 一旦遇上没装 av 的环境，整个 controls 模块（循环 / 分段表 /
    布尔开关… 15+ 个节点）全部陪葬。av 由 `_import_av()` 在函数调用前装进全局，
    官方解码段体内直接用（原文零改动）；只影响本节点自己。
  · 路由注册失败只打日志，绝不影响节点本身（照 XHLoadVideo 的 register_routes）。
"""

import os
import json
import re

import folder_paths
import torch

from comfy_execution.graph_utils import is_link


def _import_av():
    """把 av 装进模块全局（官方解码段体内直接用 av.open）。

    软依赖铁律：只在函数被调用时才 import；缺 av 时只废本节点，
    不会拖垮 controls 子模块里的其他节点。
    """
    global av
    import av  # noqa: F401  供下方官方原文段使用


# ---------------------------------------------------------------------------
# input 目录音频列表（供下拉框）—— 口径与官方 define_schema 完全一致
# ---------------------------------------------------------------------------
def _list_input_audios():
    """扫 ComfyUI 的 input 目录，列出所有音频/视频文件（供下拉框）。

    每次 INPUT_TYPES 被调用（ComfyUI 每次请求 /object_info）都实时读盘
    ⇒ 上传新文件后刷新页面就能选到，不用重启（与官方同款行为）。
    """
    try:
        input_dir = folder_paths.get_input_directory()
        os.makedirs(input_dir, exist_ok=True)
        files = folder_paths.filter_files_content_types(
            os.listdir(input_dir), ["audio", "video"])
    except Exception:
        return []
    return sorted(files)


# ---------------------------------------------------------------------------
# 📂 文件夹模式（2026-10-16）—— 与「🔁XH-提示词表 / 🖼️XH-图片列表」同一套范式
# ---------------------------------------------------------------------------
_SOURCE_FILE = "单文件"
_SOURCE_FOLDER = "📂 文件夹"
_SOURCE_MANUAL = "📋 手动清单"     # 2026-10-16 加：自己一个个挑，顺序自己定（可跨文件夹）
_AUDIO_FOLDER_LIMIT = 2000      # 文件夹模式文件数上限（与图片列表一致）
_AUDIO_MANUAL_LIMIT = 200       # 手动清单条数上限（照图片列表的 sane 上限）


def _parse_audio_list(text):
    """解析「📋 手动清单」控件里的 JSON ⇒ [(显示名, 待解码的解析键), ...]。

    · 存的是 **input 目录里的文件名**（添加时已上传进来）⇒ 与单文件模式同一套
      解析（folder_paths.get_annotated_filepath），跨端可靠、文件挪走了也不丢；
    · 兼容两种写法：纯字符串数组 ["a.wav","b.mp3"] 或 [{"name","path"}]；
    · JSON 坏了 / 不是数组 ⇒ 返回空列表（由 VALIDATE_INPUTS 给出人话报错，
      绝不在这里抛异常把整图带崩）。
    """
    raw = (text or "").strip()
    if not raw:
        return []
    try:
        data = json.loads(raw)
    except Exception:
        return []
    if not isinstance(data, list):
        return []
    out = []
    for it in data:
        if isinstance(it, str):
            nm = it.strip()
            if nm:
                out.append((nm, nm))
        elif isinstance(it, dict):
            nm = str(it.get("name") or it.get("path") or "").strip()
            if nm:
                out.append((nm, nm))
        if len(out) >= _AUDIO_MANUAL_LIMIT:
            break
    return out


def _natural_key(text):
    """文件名自然排序：'seg_10' 排在 'seg_9' 之后（数字段按数值比）。"""
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", text or "")]


def _scan_audio_folder(folder):
    """扫文件夹里的音频/视频文件，按文件名自然排序。返回 [(name, fullpath), ...]。

    · 文件口径 = folder_paths.filter_files_content_types(["audio","video"])，
      与下拉框**完全一致**（官方也列视频——有些视频只剩音轨可用）；
    · 画布只存文件夹路径，这里才是真正读盘的地方（出图时才执行，画布零负担）；
    · 上限 2000 个（与图片列表一致），超出截断并打日志。
    """
    root = os.path.abspath(folder or "")
    if not folder or not os.path.isdir(root):
        raise NotADirectoryError(
            f"文件夹不存在或路径为空：{folder}\n"
            "（点工具栏「📂 文件夹」选一个，或在「文件夹路径」那行粘贴后回车）"
        )
    try:
        names = folder_paths.filter_files_content_types(os.listdir(root), ["audio", "video"])
    except Exception:
        names = []
    files = []
    for fn in names:
        full = os.path.join(root, fn)
        if os.path.isfile(full):
            files.append((fn, full))
    files.sort(key=lambda t: _natural_key(t[0]))
    if not files:
        raise FileNotFoundError(
            f"这个文件夹里没有音频文件：{folder}\n"
            "（支持 wav / mp3 / flac / m4a / aac / ogg / opus / webm 等，"
            "视频文件也会收——官方同款口径）"
        )
    if len(files) > _AUDIO_FOLDER_LIMIT:
        print(f"[XH-加载音频] ⚠ 文件夹里文件超过 {_AUDIO_FOLDER_LIMIT} 个，"
              f"只取前 {_AUDIO_FOLDER_LIMIT} 个：{root}")
        files = files[:_AUDIO_FOLDER_LIMIT]
    return files


def _to_int(v, default=0):
    """宽容解析：API 直调时索引可能传来字符串或小数，别让 int() 直接炸。"""
    try:
        return int(round(float(v)))
    except (TypeError, ValueError):
        return default


def _to_bool(v, default=False):
    """宽容解析布尔：API 直调时可能传来 "true"/1/"on" 等字符串。"""
    if v is None:
        return default
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)):
        return bool(v)
    if isinstance(v, str):
        s = v.strip().lower()
        # 🔴 空串 ≠ False：当「没传」处理、回落到默认值（chainprompt 同款教训）
        if s == "":
            return default
        return s in ("1", "true", "yes", "on")
    return bool(v)


def _forced_start_index(dynprompt, unique_id, start_index):
    """"start_index" 口有没有接线：有 ⇒ 返回它的值（以它为准）；否则 None。

    拿不到图就老实返回 None（绝不因此报错）——循环体外 / API 直调都走这条路。
    """
    try:
        _dp = dynprompt[0] if isinstance(dynprompt, (list, tuple)) and dynprompt else dynprompt
        if _dp is None or unique_id is None:
            return None
        _self_node = _dp.get_node(str(unique_id))
        if is_link(((_self_node or {}).get("inputs") or {}).get("start_index")):
            return _to_int(start_index, 0)
    except Exception:
        return None
    return None


def _resolve_folder_index(turn, forced, n, loop):
    """文件夹模式取第几个文件（0 起）。三段论与 🔁XH-提示词表逐字同构：

    ① forced 非 None（start_index 有接线）⇒ 以它为准；
    ② 否则在循环体内（turn >= 0 = XH 注入的真实轮次）⇒ 段号 = 轮次，无状态；
    ③ 否则（循环体外）⇒ 第 1 个。
    `loop` 只决定索引用完后：开 = 绕回；关 = 停在最后一个（绝不越界崩）。
    """
    if forced is not None:
        pos = forced
    elif turn is not None and turn >= 0:
        pos = turn
    else:
        pos = 0
    if loop:
        return pos % n
    return min(max(pos, 0), n - 1)


# ---------------------------------------------------------------------------
# 解码内核 —— 以下两个函数是 comfy_extras/nodes_audio.py 的**原文**
# （L323-357：f32_pcm + load，官方 LoadAudio.execute 调的就是它）。
# 由一次性脚本切出，只改了函数名（f32_pcm→_xh_f32_pcm、load→_xh_load_audio）
# 和内部对应调用，逻辑逐行未动 ⇒ 输出与官方 LoadAudio 逐字一致。
# ⚠️ 函数体内直接用模块级的 torch / av：调用前必须先 _import_av()。
def _xh_f32_pcm(wav: torch.Tensor) -> torch.Tensor:
    """Convert audio to float 32 bits PCM format."""
    if wav.dtype.is_floating_point:
        return wav
    elif wav.dtype == torch.int16:
        return wav.float() / (2 ** 15)
    elif wav.dtype == torch.int32:
        return wav.float() / (2 ** 31)
    raise ValueError(f"Unsupported wav dtype: {wav.dtype}")

def _xh_load_audio(filepath: str) -> tuple[torch.Tensor, int]:
    with av.open(filepath) as af:
        if not af.streams.audio:
            raise ValueError("No audio stream found in the file.")

        stream = af.streams.audio[0]
        sr = stream.codec_context.sample_rate
        n_channels = stream.channels

        frames = []
        length = 0
        for frame in af.decode(streams=stream.index):
            buf = torch.from_numpy(frame.to_ndarray())
            if buf.shape[0] != n_channels:
                buf = buf.view(-1, n_channels).t()

            frames.append(buf)
            length += buf.shape[1]

        if not frames:
            raise ValueError("No audio frames decoded.")

        wav = torch.cat(frames, dim=1)
        wav = _xh_f32_pcm(wav)
        return wav, sr


# ---------------------------------------------------------------------------
# 元数据探测（给前端「信息条」+ 路由用）：时长 / 采样率 / 声道 / 编码
# 只读容器信息，不全量解码（快）。
# ---------------------------------------------------------------------------
def _probe_audio(path):
    _import_av()
    with av.open(path) as cont:
        streams = cont.streams.audio
        if not streams:
            raise ValueError("文件里没有音频轨")
        st = streams[0]
        sr = int(getattr(st.codec_context, "sample_rate", 0) or 0)
        channels = int(getattr(st, "channels", 0) or 0)
        # 编码名（不同 av 版本挂的位置不一样，逐个试）
        codec = ""
        for _get in (
            lambda: st.codec_context.codec.name,
            lambda: st.codec_context.name,
            lambda: st.name,
        ):
            try:
                codec = str(_get() or "")
                if codec:
                    break
            except Exception:
                continue
        # 时长：流时长优先（精确到采样点），容器时长兜底
        duration = 0.0
        try:
            if st.duration and st.time_base:
                duration = float(st.duration * st.time_base)
        except Exception:
            pass
        if duration <= 0:
            try:
                duration = float(cont.duration / av.time_base) if cont.duration else 0.0
            except Exception:
                duration = 0.0

    return {
        "duration": round(duration, 3),
        "sample_rate": sr,
        "channels": channels,
        "codec": codec,
    }


# ---------------------------------------------------------------------------
# 路由（给信息条 / 文件夹按钮 / 播放器用）—— 注册失败只打日志，绝不影响节点本身
#   · /xh/audioload/probe  ：元数据探测（filename=input 目录 或 path=任意绝对路径）
#   · /xh/audiolist/list   ：📂 文件夹模式的文件列表预览（只读、不写盘）
#   · /xh/audioload/file   ：流式播放任意绝对路径的音频（FileResponse 自带
#                            content-type / Range 支持，<audio> 拖动 seek 可用）
# ---------------------------------------------------------------------------
_ROUTES_DONE = False


def register_routes():
    global _ROUTES_DONE
    if _ROUTES_DONE:
        return
    # 🔴 整体收进 try（imglist / chainprompt 同款结构）：PromptServer.instance
    #    在服务器没起来时是 AttributeError，绝不能让它冒泡出注册函数。
    try:
        from aiohttp import web
        from server import PromptServer

        routes = PromptServer.instance.routes

        @routes.get("/xh/audioload/probe")
        async def _xh_audioload_probe(request):
            q = request.rel_url.query
            # path= 任意绝对路径（文件夹模式用）；filename= input 目录里的文件（单文件模式用）
            p = (q.get("path") or "").strip()
            if p:
                full = os.path.abspath(p)
                if not os.path.isfile(full):
                    return web.json_response({"ok": False, "error": f"文件不存在：{p}"}, status=404)
                try:
                    info = _probe_audio(full)
                    info["ok"] = True
                    info["file"] = os.path.basename(full)
                    return web.json_response(info)
                except Exception as e:                  # noqa: BLE001
                    return web.json_response({"ok": False, "error": f"{type(e).__name__}: {e}"}, status=200)
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
                info = _probe_audio(path)
                info["ok"] = True
                info["file"] = os.path.basename(path)
                return web.json_response(info)
            except Exception as e:                      # noqa: BLE001
                # 故意不静默：把原因带回前端显示
                return web.json_response({"ok": False, "error": f"{type(e).__name__}: {e}"}, status=200)

        @routes.get("/xh/audiolist/list")
        async def _xh_audiolist_list(request):
            q = request.rel_url.query
            folder = (q.get("dir") or "").strip()
            if not folder:
                return web.json_response({"ok": False, "error": "缺少 dir 参数"}, status=400)
            try:
                files = _scan_audio_folder(folder)
            except Exception as e:                      # noqa: BLE001
                return web.json_response({"ok": False, "error": str(e)}, status=400)
            out = []
            for name, full in files:
                try:
                    st = os.stat(full)
                    size = int(st.st_size)
                except OSError:
                    size = 0
                out.append({"name": name, "path": full, "size": size})
            return web.json_response({
                "ok": True, "dir": os.path.abspath(folder), "count": len(out), "files": out,
            })

        @routes.get("/xh/audioload/file")
        async def _xh_audioload_file(request):
            p = (request.rel_url.query.get("path") or "").strip()
            full = os.path.abspath(p) if p else ""
            if (not full) or (not os.path.isfile(full)):
                return web.json_response({"ok": False, "error": f"不是有效的音频文件：{p}"}, status=404)
            # FileResponse 自动带 content-type / content-length / Range，支持中文路径
            return web.FileResponse(full)

        _ROUTES_DONE = True
        print("[XH-加载音频] ✅ 本机音频接口已注册：/xh/audioload/probe · /xh/audiolist/list · /xh/audioload/file")
    except Exception as e:                              # noqa: BLE001
        print(f"[XH-加载音频] ⚠️ 本机音频接口注册失败"
              f"（「📂 文件夹」预览 / 播放不可用，节点执行不受影响）：{e}")


# ---------------------------------------------------------------------------
# 节点
# ---------------------------------------------------------------------------
class XHLoadAudio:
    """从 input 目录选一个音频文件（或 📂 文件夹按序取），输出官方 AUDIO 格式。"""

    @classmethod
    def INPUT_TYPES(cls):
        files = _list_input_audios()
        required = {
            "audio": (files or [""], {
                "default": files[0] if files else "",
                "tooltip": (
                    "【🎵 音频文件】列出的是 ComfyUI 的 input 目录里的音频（视频文件也会列出来，"
                    "官方同款口径——有些视频只剩音轨可用）。\n"
                    "没有你想要的？点节点上的「⬆ 上传音频」按钮选文件，或直接把音频拖到节点上，"
                    "上传完会自动选中（也能手动把文件拷进 ComfyUI\\input\\ 后刷新页面）。\n"
                    "支持：wav / mp3 / flac / m4a / aac / ogg / opus / webm 等\n"
                    "⚠️ 列表为空 = input 目录里一个音频都没有。\n"
                    "⚠️ 选了「📂 文件夹 / 📋 手动清单」来源后，这个下拉被忽略。"
                ),
            }),
        }
        # 🔴 新控件全部追加在老控件后面 —— 不挤占老存档 widgets_values 的位置
        #    （提示词表同款教训：source/prompt_folder 故意放最后）。
        required["source"] = (
            [_SOURCE_FILE, _SOURCE_FOLDER, _SOURCE_MANUAL],
            {
                "default": _SOURCE_FILE,
                "tooltip": (
                    "音频从哪来：\n"
                    "· 单文件（默认）= 用上面的下拉选 input 目录里的一个音频；\n"
                    "· 📂 文件夹 = 指定一个文件夹，里面每个音频文件 = 一「段」，"
                    "按文件名自然排序（001.wav → 第 1 个、002.wav → 第 2 个…）；\n"
                    "· 📋 手动清单 = 自己一个个挑（想从哪个文件夹挑都行），"
                    "顺序完全由你定（拖着改），清单存在节点里跟着工作流走。\n"
                    "后两种都忽略上面的下拉。\n"
                    "【循环场景】放进 XH-循环里选后两种 ⇒ 第 0 轮取第 1 个、第 1 轮取第 2 个……"
                    "一根线都不用接（轮次由循环自动注入）。"
                ),
            },
        )
        required["audio_folder"] = (
            "STRING",
            {
                "default": "",
                "multiline": False,
                "placeholder": "📂 文件夹路径（例：D:\\素材\\婉儿音频），点工具栏「📂 文件夹」选，或粘贴后回车",
                "tooltip": (
                    "文件夹模式下的音频来源：每个音频/视频文件 = 一「段」。\n"
                    "选了「📂 文件夹」来源后这里才有用；出图时按文件名自然排序读取，"
                    "文件夹里加/换文件后重跑即刷新。\n"
                    "画布只存路径，读盘发生在执行时（画布零负担）。"
                ),
            },
        )
        required["start_index"] = (
            "INT",
            {
                "default": 0, "min": 0, "max": 9999, "step": 1,
                "tooltip": (
                    "从第几个文件开始取（0 = 第 1 个）。\n"
                    "· 有人给这个口接线（is_link）⇒ 以连过来的值为准，"
                    "「跳过前 N 个 / 只重跑第 N 个」就接它；\n"
                    "· 没接线 + 在循环体内 ⇒ 忽略它，自动跟随循环轮次（零接线逐段）；\n"
                    "· 没接线 + 在循环体外 ⇒ 固定取这一个（文件夹模式下）。\n"
                    "⚠️ 循环体内即使接了线也只会取一次值，不会和轮次双算。"
                ),
            },
        )
        required["loop"] = (
            "BOOLEAN",
            {
                "default": True,
                "label_on": "绕回（文件用完从头再来）",
                "label_off": "停在最后一个",
                "tooltip": (
                    "索引用完后怎么办（只影响文件夹模式）：\n"
                    "· 开（默认）= 绕回第 1 个文件（轮次 5 个文件只有 3 个 → 5%3 循环取）；\n"
                    "· 关 = 停在最后一个文件（第 4 轮起一直用最后一个，不报错）。\n"
                    "单文件模式下这个开关无效。"
                ),
            },
        )
        # 🔴 audio_list 放**最后**：老存档 widgets_values 的前 5 位
        #    （audio/source/audio_folder/start_index/loop）位置纹丝不动，
        #    纯数组档按「前 N 个」回填依旧对得上（前端 fixSavedValues 已同步改）。
        required["audio_list"] = (
            "STRING",
            {
                "default": "[]",
                "multiline": False,
                "placeholder": "📋 手动清单（由节点上的列表自动维护，一般不用手填）",
                "tooltip": (
                    "「📋 手动清单」模式下这份清单的存档位（JSON 数组，节点自动写）。\n"
                    "存的是 **已经传进 ComfyUI input 目录的文件名** —— 点「⬆加音频」"
                    "从任意文件夹挑文件时会自动传进来并记下，所以原文件挪走/改名也不影响。\n"
                    "节点上的列表区可以拖着改顺序、点 ✕ 删单个。\n"
                    "⚠️ 一般不用手改这一行；要改就写 [\"a.wav\", \"b.mp3\"] 这种格式。"
                ),
            },
        )
        # 🔴 真隐藏输入（与 🔁XH-提示词表同款三件套）：XH-循环展开时写入真实
        #    轮次（0 起），优先级高于脆弱的 unique_id 前缀解析；不声明 = 注入值
        #    被 execution.py 静默丢弃（get_input_info 返回 None ⇒ 不进 kwargs）。
        hidden = {"unique_id": "UNIQUE_ID", "xh_loop_turn": "INT", "dynprompt": "DYNPROMPT"}
        return {"required": required, "hidden": hidden}

    RETURN_TYPES = ("AUDIO", "INT")
    RETURN_NAMES = ("audio", "file_index")
    FUNCTION = "load_audio"
    CATEGORY = "🔁XH/音频"
    DESCRIPTION = (
        "【干什么】从 ComfyUI 的 input 目录里选一个音频文件（或 📂 文件夹按序取），"
        "解码成官方 AUDIO 格式（波形 + 采样率）输出——**与官方 Load Audio 逐字一致，可直接互换**。\n"
        "【三种模式】\n"
        "  ① 单文件（默认）：下拉选 input 目录里的音频；没有 → 点「⬆ 上传音频」或直接拖文件到节点上。\n"
        "  ② 📂 文件夹：指定一个文件夹，每个音频文件 = 一「段」，按文件名自然排序。\n"
        "  ③ 📋 手动清单：自己一个个挑（想从哪个文件夹挑都行），顺序完全自己定"
        "（节点上拖着改顺序、点 ✕ 删单个），清单存在节点里跟着工作流走。\n"
        "【循环用法】把本节点放进 XH-循环里、来源选 ② 或 ③ ⇒ 零接线自动逐段换音频"
        "（轮次由循环注入隐藏输入 xh_loop_turn）；想「跳过前 N 个 / 只重跑第 N 个」"
        "就给「起始序号」口接一条线（有人接线以它为准）。\n"
        "③ 的音频在添加时会被传进 ComfyUI 的 input 目录并记下文件名 ⇒ 原文件挪走也不影响。\n"
        "【怎么用】输出口 audio（AUDIO）接任何吃音频的节点"
        "（🎵XH-音乐卡点表 / 音频分离 / 保存音频…都行）；"
        "file_index（INT）回显这轮实际取到第几个文件（0 起，单文件模式 = -1），方便排错。\n"
        "节点自带播放器：**粗时间线按住拖动就能跳转**（官方那条细条很难拖），"
        "还有播放/暂停、时间显示、音量静音切换与滑块、实时频谱律动条。\n"
        "【输出】audio（AUDIO）—— {waveform: [1, 声道, 采样数], sample_rate}。\n"
        "⚠️ 下拉里也会列出视频文件（官方同款口径）。"
    )

    def load_audio(self, audio, source=_SOURCE_FILE, audio_folder="", start_index=0,
                   loop=True, audio_list="[]", unique_id=None, xh_loop_turn=-1,
                   dynprompt=None, **kwargs):
        _import_av()
        if str(source) in (_SOURCE_FOLDER, _SOURCE_MANUAL):
            # ── 📂 文件夹 / 📋 手动清单：第 i 轮读第 i 个（每轮只解码选中的那一个）──
            if str(source) == _SOURCE_MANUAL:
                files = _parse_audio_list(audio_list)
                if not files:
                    raise ValueError(
                        "「📋 手动清单」是空的。\n"
                        "点工具栏「⬆ 加音频」从任意文件夹挑几个音频加进来（会传进 ComfyUI 的 "
                        "input 目录并记下），或在「📋 手动清单」那一行写 [\"a.wav\", \"b.mp3\"]。"
                    )
                tag = "📋 手动清单"
            else:
                files = _scan_audio_folder(audio_folder)
                tag = "📂 文件夹"
            n = len(files)
            # ① start_index 有接线 ⇒ 以它为准（拿不到图就老实忽略，绝不因此报错）
            forced = _forced_start_index(dynprompt, unique_id, start_index)
            turn = _to_int(xh_loop_turn, -1)
            pos = _resolve_folder_index(turn, forced, n, _to_bool(loop, True))
            name, key = files[pos]
            if str(source) == _SOURCE_MANUAL:
                # 手动清单存的是 input 目录里的文件名 ⇒ 与单文件模式同一套解析
                path = folder_paths.get_annotated_filepath(key)
                if not path or not os.path.isfile(path):
                    raise FileNotFoundError(
                        f"手动清单第 {pos + 1} 个文件在 input 目录里找不到了：{key}\n"
                        "（它在加进来时被传进了 ComfyUI 的 input 目录；可能被手动删了"
                        " —— 删掉这一条重新加，或把文件放回 input 目录）"
                    )
            else:
                path = key
            waveform, sample_rate = _xh_load_audio(path)
            out = {"waveform": waveform.unsqueeze(0), "sample_rate": sample_rate}
            print(f"[XH-加载音频] {tag}取第 {pos + 1}/{n} 个：{name}")
            return (out, int(pos))
        # ── 单文件模式（老行为，一字未动）──
        path = folder_paths.get_annotated_filepath(audio)
        if not path or not os.path.isfile(path):
            raise FileNotFoundError(f"找不到音频文件：{audio}（应在 ComfyUI 的 input 目录下）")
        waveform, sample_rate = _xh_load_audio(path)
        audio = {"waveform": waveform.unsqueeze(0), "sample_rate": sample_rate}
        return (audio, -1)

    @classmethod
    def IS_CHANGED(cls, audio, source=_SOURCE_FILE, audio_folder="", start_index=0,
                   loop=True, audio_list="[]", **kwargs):
        """文件改了（mtime / size 变）就重跑 —— 与包内 XHLoadVideo 同口径，
        避免大文件反复全量哈希（官方 fingerprint_inputs 是 sha256 全量读）。
        文件夹模式：目录 mtime + 文件数 + 首末文件名（加/换文件都会变）。
        手动清单：清单内容 + 每项文件的 mtime（改顺序 / 增删 / 文件被换都会重跑）。"""
        try:
            if str(source) == _SOURCE_MANUAL:
                files = _parse_audio_list(audio_list)
                if not files:
                    return float("NaN")
                sig = [str(audio_list)]
                for _, key in files[:32]:           # 只取前 32 个够用（避免长清单每次全量扫）
                    try:
                        p = folder_paths.get_annotated_filepath(key)
                        st = os.stat(p)
                        sig.append(f"{key}:{st.st_mtime_ns}:{st.st_size}")
                    except Exception:
                        sig.append(f"{key}:missing")
                return "|".join(sig)
            if str(source) == _SOURCE_FOLDER:
                # 🔴 必须先判原串：os.path.abspath("") = 服务器 cwd（不是空串），
                #    只判 root 会放过空路径、最后扫整个 ComfyUI 根目录。
                if not (audio_folder or "").strip():
                    return float("NaN")
                root = os.path.abspath(audio_folder)
                if not os.path.isdir(root):
                    return float("NaN")
                files = _scan_audio_folder(root)
                names = [os.path.basename(p) for _, p in files]
                st = os.stat(root)
                return (f"{root}:{st.st_mtime_ns}:{len(names)}:"
                        f"{names[0] if names else ''}:{names[-1] if names else ''}")
            path = folder_paths.get_annotated_filepath(audio)
            st = os.stat(path)
            return f"{audio}:{st.st_mtime_ns}:{st.st_size}"
        except Exception:
            return float("NaN")

    @classmethod
    def VALIDATE_INPUTS(cls, audio, source=_SOURCE_FILE, audio_folder="",
                        audio_list="[]", **kwargs):
        if str(source) == _SOURCE_MANUAL:
            files = _parse_audio_list(audio_list)
            if not files:
                return ("「📋 手动清单」是空的：点工具栏「⬆ 加音频」挑几个音频加进来，"
                        "或在这一行写 [\"a.wav\", \"b.mp3\"]")
            missing = [k for _, k in files
                       if not (folder_paths.get_annotated_filepath(k)
                               and os.path.isfile(folder_paths.get_annotated_filepath(k)))]
            if missing:
                return ("手动清单里有文件找不到了（应在 ComfyUI 的 input 目录里）："
                        + "、".join(missing[:5]) + ("…" if len(missing) > 5 else ""))
            return True
        if str(source) == _SOURCE_FOLDER:
            # 🔴 同 IS_CHANGED：先判原串，abspath("") 会变成服务器 cwd
            if not (audio_folder or "").strip():
                return "文件夹路径是空的（点工具栏「📂 文件夹」选一个，或粘贴后回车）"
            root = os.path.abspath(audio_folder)
            if not os.path.isdir(root):
                return f"文件夹不存在：{audio_folder}（点工具栏「📂 文件夹」选一个）"
            return True
        try:
            if not folder_paths.exists_annotated_filepath(audio):
                return f"输入目录里没有这个音频：{audio}"
        except Exception:
            pass
        return True


NODE_CLASS_MAPPINGS = {
    "XHLoadAudio": XHLoadAudio,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "XHLoadAudio": "🎵XH-加载音频",
}
