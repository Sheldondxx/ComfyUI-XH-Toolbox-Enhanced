# 🎬XH-视频对比 · 后端实现
# 复刻 comfyui-easy-media 的 EasyCompareVideos（node_id "easy compareVideos"），
# 并按 XH 家族规范改造：
#   · class_type 改名 XHCompareVideos（避免与原包同名互相覆盖）
#   · 分类/显示名 XH 风格：🔁XH/Video · 🎬XH-视频对比
#   · 🔁 多路对比：原版只消费 VIDEO 列表的前两个，本版汇成有序池取前 N 路（N≤4）
#   · 🔁 元数据不用 ffprobe：改用官方 VideoInput 的公开 getter
#     （get_stream_source / get_duration / get_frame_rate / get_frame_count / get_dimensions，
#      内部就是 av，ComfyUI 官方自带）⇒ 零新增依赖
#   · ➕ widget 多选文件（input/temp/output 三目录扫盘，后端路由 /xh/videocompare/files）
#   · 保存输出：按预览排列合成一段带标签的 MP4
# 原版 ui 结构：{"videos": [...PreviewVideo...], "compare_videos": [payload]}
# 本版 ui 结构：{"compare_videos": [{"videos": [payload...], "max_cells": 4}]}
#   payload = {filename, subfolder, type, label, origin, fps, frame_count, duration, width, height}

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile

from .video_label import render_label_overlay

try:
    import folder_paths
except ImportError:                                  # 理论兜底：ComfyUI 环境必有
    folder_paths = None

# 视频文件后缀（扫盘 + 手动路径兜底判断用）
_VIDEO_EXTS = (".mp4", ".webm", ".mov", ".mkv", ".avi", ".flv", ".wmv", ".m4v", ".gif", ".ts")

# 多路对比上限（前端网格同值，超出截断并告知）
_MAX_CELLS = 4


def _settings(value):
    """widget 口（STRING）→ dict。容错：空串/坏 JSON/非 dict 全给 {}。"""
    if isinstance(value, dict):
        return value
    if not isinstance(value, str) or not value.strip():
        return {}
    try:
        parsed = json.loads(value)
    except (TypeError, ValueError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _flatten(value):
    """把「单个 VIDEO / VIDEO 列表 / None」拍成 list。"""
    if value is None:
        return []
    if isinstance(value, (list, tuple)):
        out = []
        for v in value:
            out.extend(_flatten(v))
        return out
    return [value]


def _video_to_path(video, label):
    """VIDEO 对象 → (本地路径, 临时文件列表)。

    官方 VideoFromFile.get_stream_source() 直接给底层文件（str 路径或 BytesIO）；
    BytesIO 用 save_to 落临时文件（用完由调用方删）。
    """
    temp_files = []
    try:
        src = video.get_stream_source()
    except Exception as exc:                          # noqa: BLE001
        raise RuntimeError(f"[XH-视频对比] {label} 视频取源失败：{type(exc).__name__}: {exc}") from exc

    if isinstance(src, str):
        if not os.path.isfile(src):
            raise FileNotFoundError(f"[XH-视频对比] {label} 视频文件不在磁盘上：{src}")
        return src, temp_files

    if isinstance(src, (bytes, bytearray)):
        src = bytes(src)

    if src is not None and hasattr(src, "read"):
        # BytesIO：落临时文件
        try:
            fd, tmp = tempfile.mkstemp(prefix="xh_cmp_", suffix=".mp4")
            with os.fdopen(fd, "wb") as f:
                f.write(src.read())
            temp_files.append(tmp)
            return tmp, temp_files
        except Exception as exc:                      # noqa: BLE001
            raise RuntimeError(f"[XH-视频对比] {label} 视频（内存流）落盘失败：{type(exc).__name__}: {exc}") from exc

    # 兜底：试试 save_to（某些实现只暴露它）
    try:
        fd, tmp = tempfile.mkstemp(prefix="xh_cmp_", suffix=".mp4")
        os.close(fd)
        video.save_to(tmp, format="auto")
        temp_files.append(tmp)
        return tmp, temp_files
    except Exception as exc:                          # noqa: BLE001
        raise RuntimeError(
            f"[XH-视频对比] {label} 视频类型不支持（既不是文件路径也不是内存流）：{type(video).__name__}"
        ) from exc


def _safe_get(video, name):
    try:
        return getattr(video, name)()
    except Exception:                                 # noqa: BLE001
        return None


def _video_meta(video, label):
    """官方 getter 读元数据。任何一项读不到给 None，不中断（前端信息条显示 -）。"""
    meta = {"fps": None, "frame_count": None, "duration": None, "width": None, "height": None}
    try:
        dur = _safe_get(video, "get_duration")
        if isinstance(dur, (int, float)) and dur > 0:
            meta["duration"] = float(dur)
    except Exception:                                 # noqa: BLE001
        pass
    try:
        fr = _safe_get(video, "get_frame_rate")
        if fr is not None:
            # 可能是 Fraction / float / int
            meta["fps"] = float(fr)
    except Exception:                                 # noqa: BLE001
        pass
    try:
        fc = _safe_get(video, "get_frame_count")
        if isinstance(fc, (int, float)) and fc > 0:
            meta["frame_count"] = int(fc)
    except Exception:                                 # noqa: BLE001
        pass
    try:
        dim = _safe_get(video, "get_dimensions")
        if dim and len(dim) == 2:
            meta["width"], meta["height"] = int(dim[0]), int(dim[1])
    except Exception:                                 # noqa: BLE001
        pass

    # 帧数读不到但有 fps+duration ⇒ 估算（与原版 ffprobe 兜底同语义）
    if meta["frame_count"] is None and meta["fps"] and meta["duration"]:
        meta["frame_count"] = max(1, round(meta["duration"] * meta["fps"]))
    if meta["duration"] is None and meta["frame_count"] and meta["fps"]:
        meta["duration"] = meta["frame_count"] / meta["fps"]
    return meta


def _preview_ref(path, label):
    """拷进 ComfyUI temp 目录，返回前端 /view? 能直接放的引用。

    🔴 必须用 folder_paths.get_temp_directory()，不能用系统 tempfile.mkstemp 的
    %TEMP%：widget 多选（source_type="temp"）和扫盘路由都按 ComfyUI temp 目录解析，
    三处目录必须同一个，否则用户勾了刚生成的文件也找不到。
    """
    ext = os.path.splitext(path)[1] or ".mp4"
    base = folder_paths.get_temp_directory()
    fd, tmp = tempfile.mkstemp(prefix=f"xh_cmp_{label}_", suffix=ext, dir=base)
    os.close(fd)
    try:
        shutil.copy2(path, tmp)
    except Exception as exc:                          # noqa: BLE001
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise RuntimeError(f"[XH-视频对比] {label} 视频预览副本制作失败。") from exc
    return {"filename": os.path.basename(tmp), "subfolder": "", "type": "temp"}


def _save_compare(entries, settings):
    """Compose one MP4 from the preview sources, with the same layout and labels."""
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("[XH-视频对比] 保存拼接视频需要安装 ffmpeg。")
    first = entries[0]
    width = (int(first.get("width") or 1280) + 1) // 2 * 2
    height = (int(first.get("height") or 720) + 1) // 2 * 2
    fps = float(first.get("fps") or 24)
    duration = first.get("duration")
    cols = 1 if settings.get("layout") == "vertical" else min(2, len(entries))
    rows = (len(entries) + cols - 1) // cols
    font_size = max(8, int(settings.get("label_font_size") or 28))
    prefix = str(settings.get("filename_prefix") or "video/compare/VideoCompare")
    out_dir, filename, counter, subfolder, _ = folder_paths.get_save_image_path(
        prefix, folder_paths.get_output_directory(), width * cols, height * rows
    )
    out_name = f"{filename}_{counter:05}_.mp4"
    out_path = os.path.join(out_dir, out_name)

    cmd = [ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-filter_complex_threads", "1"]
    for entry in entries:
        cmd.extend(["-i", os.path.join(folder_paths.get_temp_directory(), entry["filename"])])
    with tempfile.TemporaryDirectory(prefix="xh_cmp_labels_", dir=folder_paths.get_temp_directory()) as label_dir:
        filters = []
        streams = []
        label_input = len(entries)
        for i, entry in enumerate(entries):
            filters.append(
                f"[{i}:v]setpts=PTS-STARTPTS,fps={fps},"
                f"scale={width}:{height}:force_original_aspect_ratio=decrease,"
                f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,setsar=1[v{i}]"
            )
            stream = f"[v{i}]"
            if entry["label"].strip():
                png = os.path.join(label_dir, f"label_{i}.png")
                render_label_overlay(width, height, entry["label"], font_size).save(png)
                cmd.extend(["-i", png])
                filters.append(f"[v{i}][{label_input}:v]overlay=0:0:eof_action=repeat[l{i}]")
                label_input += 1
                stream = f"[l{i}]"
            streams.append(stream)
        if len(entries) > 1:
            layout = "|".join(f"{i % cols * width}_{i // cols * height}" for i in range(len(entries)))
            filters.append("".join(streams) + f"xstack=inputs={len(entries)}:layout={layout}:fill=black[compare]")
            stream = "[compare]"
        else:
            stream = streams[0]
        cmd.extend(["-filter_complex", ";".join(filters), "-map", stream,
                    "-map", f"{min(1, len(entries) - 1)}:a:0?"])
        if duration:
            cmd.extend(["-t", str(duration)])
        cmd.extend(["-c:v", "libx264", "-crf", "18", "-preset", "medium", "-threads", "4",
                    "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", out_path])
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode:
            if os.path.exists(out_path):
                os.unlink(out_path)
            raise RuntimeError(f"[XH-视频对比] 拼接视频保存失败：{result.stderr[-2000:]}")
    return {"filename": out_name, "subfolder": subfolder, "type": "output"}


def _selections_to_videos(settings):
    """widget 多选 JSON → VideoFromFile 列表（按用户排列顺序）。

    selections: [{"source_type": "input|temp|output", "file_path": "xxx.mp4"}, ...]
    """
    sels = settings.get("selections")
    if not isinstance(sels, list):
        return []
    out = []
    for s in sels:
        if not isinstance(s, dict):
            continue
        st = str(s.get("source_type") or s.get("type") or "input")
        fp = s.get("file_path") or s.get("path")
        if not fp or not isinstance(fp, str):
            continue
        if os.path.isabs(fp):
            resolved = fp
        elif st == "output":
            resolved = os.path.join(folder_paths.get_output_directory(), fp)
        elif st == "temp":
            resolved = os.path.join(folder_paths.get_temp_directory(), fp)
        else:
            resolved = os.path.join(folder_paths.get_input_directory(), fp)
        if not os.path.isfile(resolved):
            print(f"[XH-视频对比] ⚠️ 多选文件不存在，跳过：{resolved}")
            continue
        try:
            from comfy_api.latest import InputImpl
            out.append(InputImpl.VideoFromFile(resolved))
        except Exception as exc:                      # noqa: BLE001
            print(f"[XH-视频对比] ⚠️ 多选文件加载失败，跳过：{resolved}（{type(exc).__name__}: {exc}）")
    return out


class XHCompareVideos:
    """🎬XH-视频对比：多路视频同步对比（网格 / 单看 / 两两滑块）。

    三路来源汇成有序池（去重保序，上限 4）：
      ① source 口（VIDEO，可接列表）② output 口（VIDEO，可接列表）③ widget 多选文件
    """

    CATEGORY = "🔁XH/Video"

    DESCRIPTION = (
        "【干什么】把多路视频（≤4）摆在一起同步对比：网格同播 / 单看 / 两两滑块对比。\n"
        "【视频从哪来】① source 口接线 ② output 口接线 ③ 节点上「📂 选择文件」按钮多选\n"
        "（input / temp / output 三目录扫盘）—— 三路汇成有序池，自动去重，谁前谁后决定格子顺序。\n"
        "【同步】网格模式全部同一条进度：播/停/拖拽主控，其余对齐；最慢的一路加载完才起播。\n"
        "【信息条】每路 fps / 帧数 / 时长，并列出相对第 1 路的差值（帧数差、时长差）——\n"
        "  查「拼接段动作漂移 / 帧数对不对」直接看数据，不用心算。\n"
        "【标签】节点上的「标签 / 参数」可分别填写各路的多行文字，显示在画面左上角。\n"
        "【保存】开启「保存输出」后运行，按当前左右 / 上下排列保存一段带标签的 MP4。\n"
        "【⇄ 互换】一键左右互换格子顺序（查「成品当源」反向对比）。\n"
        "⚠️ 本节点无输出口（终止节点），只负责看片 + 存档。\n"
        "⚠️ 复刻 comfyui-easy-media 的 Compare Videos：多路化 + 元数据改走官方 getter\n"
        "   （get_stream_source/get_duration/get_frame_rate/get_frame_count，零新增依赖）。"
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "compare_video": ("STRING", {
                    "default": "{}",
                    "tooltip": (
                        "widget 设置口（JSON）：多选文件列表 / 对比模式 / 保存开关 / 输出前缀。\n"
                        "由节点界面自动写入，一般不用手改；手改也行（合法 JSON）。\n"
                        "字段：selections[{source_type,file_path}] / mode(grid|single|pair) /\n"
                        "      save_output(bool) / filename_prefix(str) /\n"
                        "      layout(horizontal|vertical) / labels[str,...] / label_font_size(int)"
                    ),
                }),
            },
            "optional": {
                "source": ("VIDEO", {
                    "forceInput": True,
                    "tooltip": (
                        "源视频（左）。接 VIDEO 口；接列表时全部入池（如循环吐出的多段）。\n"
                        "不接也行 —— 用节点上的「📂 选择文件」多选。"
                    ),
                }),
                "output": ("VIDEO", {
                    "forceInput": True,
                    "tooltip": (
                        "目标视频（右）。接 VIDEO 口；接列表时全部入池。\n"
                        "不接也行 —— 用节点上的「📂 选择文件」多选。"
                    ),
                }),
            },
        }

    RETURN_TYPES = ()
    FUNCTION = "compare_videos"
    OUTPUT_NODE = True
    CATEGORY = "🔁XH/Video"

    def compare_videos(self, source=None, output=None, compare_video="{}"):
        st = _settings(compare_video)
        save_output = st.get("save_output") is True
        max_cells = _MAX_CELLS

        # ---- 有序池：source 口 + output 口 + widget 多选（去重保序）----
        pool = []
        seen = set()

        def _add(v, origin):
            key = id(v)
            if key in seen:
                return
            seen.add(key)
            pool.append((v, origin))

        for v in _flatten(source):
            _add(v, "source")
        for v in _flatten(output):
            _add(v, "output")
        for v in _selections_to_videos(st):
            _add(v, "select")

        if not pool:
            # 没任何输入：给个空 payload，前端显示提示（不报错 —— 原版同款宽容）
            return {"ui": {"compare_videos": [{"videos": [], "max_cells": max_cells,
                                               "hint": "no_input"}]}}

        truncated = len(pool) > max_cells
        pool = pool[:max_cells]

        # ---- 逐路探测 ----
        entries = []
        try:
            for idx, (video, origin) in enumerate(pool):
                labels = st.get("labels")
                label = str(labels[idx]) if isinstance(labels, list) and idx < len(labels) else f"第{idx + 1}路"
                path, temps = _video_to_path(video, label)
                try:
                    meta = _video_meta(video, label)
                    ref = _preview_ref(path, f"video{idx + 1}")
                    entries.append({
                        **ref,
                        "label": label,
                        "origin": origin,
                        "fps": meta["fps"],
                        "frame_count": meta["frame_count"],
                        "duration": meta["duration"],
                        "width": meta["width"],
                        "height": meta["height"],
                    })
                finally:
                    for t in temps:
                        try:
                            os.unlink(t)
                        except OSError:
                            pass
        except Exception as exc:                      # noqa: BLE001
            # 已经成型的路照样返回（部分可见比全崩好），错误打进 ui.hint
            print(f"[XH-视频对比] ⚠️ 探测中断：{type(exc).__name__}: {exc}")
            return {"ui": {"compare_videos": [{"videos": entries, "max_cells": max_cells,
                                               "hint": f"error: {exc}"}]}}

        output_video = _save_compare(entries, st) if save_output else None
        return {"ui": {"compare_videos": [{
            "videos": entries,
            "max_cells": max_cells,
            "truncated": truncated,
            "saved": save_output,
            "output_video": output_video,
        }]}}


NODE_CLASS_MAPPINGS = {
    "XHCompareVideos": XHCompareVideos,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "XHCompareVideos": "🎬XH-视频对比",
}


# ---------------------------------------------------------------------------
# 扫盘路由（2026-10-24）：给前端「📂 选择文件」弹层用
#   GET /xh/videocompare/files?dir=input|temp|output → {ok, dir, files: [{name, size_kb}]}
# ⚠️ 必须 try 住：路由注册失败只打日志，不拖垮 image_tools 其它节点
# ⚠️ 走自己的路由不碰 ComfyUI 内部 API（§11U：内部 API 位置版本间漂移）
# ---------------------------------------------------------------------------
def register_routes():
    try:
        from aiohttp import web
        from server import PromptServer
    except Exception as exc:                          # noqa: BLE001
        print(f"[XH-视频对比] ⚠️ 扫盘路由未注册（「选择文件」不可用，接线对比不受影响）：{exc}")
        return

    @PromptServer.instance.routes.get("/xh/videocompare/files")
    async def _xh_cmp_files(request):
        d = request.query.get("dir", "input")
        if d == "output":
            base = folder_paths.get_output_directory()
        elif d == "temp":
            base = folder_paths.get_temp_directory()
        else:
            base = folder_paths.get_input_directory()
            d = "input"
        files = []
        try:
            for root, _dirs, names in os.walk(base):
                for n in names:
                    if n.lower().endswith(_VIDEO_EXTS):
                        full = os.path.join(root, n)
                        try:
                            kb = os.path.getsize(full) // 1024
                        except OSError:
                            kb = 0
                        rel = os.path.relpath(full, base).replace("\\", "/")
                        files.append({"name": rel, "size_kb": kb})
        except Exception as exc:                      # noqa: BLE001
            return web.json_response({"ok": False, "dir": d, "files": [], "error": str(exc)})
        files.sort(key=lambda x: x["name"].lower())
        return web.json_response({"ok": True, "dir": d, "files": files[:500]})

    print("[XH-视频对比] ✅ 扫盘路由已注册：/xh/videocompare/files")
