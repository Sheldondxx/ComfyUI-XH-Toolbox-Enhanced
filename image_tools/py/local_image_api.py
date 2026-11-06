# 🖼️XH-本机文件夹图片接口（2026-10-12）
#
# 「🖼️XH-图片列表」的「📂 文件夹」按钮靠这两条路由，**直接引用** input 目录以外的图片：
#   GET /xh/imglist/list?dir=<文件夹>[&recursive=0][&limit=2000]
#       → {"ok":true,"dir":...,"count":N,"files":[{"path","name","rel","size","mtime"}]}
#   GET /xh/imglist/file?path=<图片绝对路径>
#       → 直接吐图片字节（给前端 <img src> 当缩略图用）
#
# 设计约束（改这里之前先读）：
#   · **只读、永不写盘**；只认图片扩展名白名单；非图片一律 404
#   · **不复制文件** —— 文件夹里换图/加图，前端再点一次「📂 文件夹」即刷新
#   · 顺序 = **文件名自然排序**（数字段按数值比：1、2、3…10，而不是 1、10、2）。
#     ⚠️ 纯中文名按 Unicode 码位排，与资源管理器的拼音序可能不同 —— 加 01_/02_ 前缀后两者才必然一致
#   · 路由注册失败 **只打日志**，绝不影响包里其它节点（__init__.py 里已用 try 包住）
#   · 本地自用工具：允许任意绝对路径（ComfyUI 默认只听 127.0.0.1；暴露公网时请自行加白名单）

import os
import re

_IMG_EXT = {
    ".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif",
    ".tif", ".tiff", ".avif", ".jfif",
}

# 注册只做一次
_ROUTES_DONE = False


def _natural_key(text):
    """文件名自然排序：'a10' 排在 'a9' 之后（把数字段按数值比）。"""
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", text or "")]


def list_images(folder, recursive=False, limit=2000):
    """列出文件夹里的图片（自然排序）。返回 (files, total_matched)。

    files 每项：{"path": 绝对路径, "name": 文件名, "rel": 相对路径, "size": 字节, "mtime": 修改时间戳}
    """
    root = os.path.abspath(folder)
    if not os.path.isdir(root):
        raise NotADirectoryError(f"不是有效文件夹：{folder}")

    found = []
    if recursive:
        for dirpath, _dirnames, filenames in os.walk(root):
            for fn in filenames:
                if os.path.splitext(fn)[1].lower() in _IMG_EXT:
                    full = os.path.join(dirpath, fn)
                    found.append((os.path.relpath(full, root).replace("\\", "/"), full, fn))
    else:
        for fn in os.listdir(root):
            full = os.path.join(root, fn)
            if os.path.isfile(full) and os.path.splitext(fn)[1].lower() in _IMG_EXT:
                found.append((fn, full, fn))

    # 自然排序（按相对路径，保证子文件夹也稳定）
    found.sort(key=lambda t: _natural_key(t[0]))

    total = len(found)
    files = []
    for rel, full, fn in found[:max(1, int(limit))]:
        try:
            st = os.stat(full)
            size, mtime = st.st_size, int(st.st_mtime)
        except OSError:
            size, mtime = 0, 0
        files.append({"path": full, "name": fn, "rel": rel, "size": size, "mtime": mtime})
    return files, total


def register_routes():
    """把 /xh/imglist/* 挂到 ComfyUI 的 aiohttp 路由上（幂等）。"""
    global _ROUTES_DONE
    if _ROUTES_DONE:
        return
    try:
        from aiohttp import web
        from server import PromptServer

        routes = PromptServer.instance.routes

        @routes.get("/xh/imglist/list")
        async def _xh_imglist_list(request):
            q = request.rel_url.query
            folder = (q.get("dir") or "").strip()
            if not folder:
                return web.json_response({"ok": False, "error": "缺少 dir 参数"}, status=400)
            recursive = str(q.get("recursive") or "0") in ("1", "true", "True", "yes")
            try:
                limit = int(q.get("limit") or 2000)
            except Exception:
                limit = 2000
            try:
                files, total = list_images(folder, recursive=recursive, limit=limit)
            except Exception as e:
                print(f"[XH-图片列表] 列目录失败：{folder} -> {e}")
                return web.json_response({"ok": False, "error": str(e)}, status=400)
            print(f"[XH-图片列表] 📂 载入文件夹 {os.path.abspath(folder)} -> {total} 张图"
                  f"{'（已截断到 %d）' % len(files) if total > len(files) else ''}")
            return web.json_response({
                "ok": True, "dir": os.path.abspath(folder),
                "count": len(files), "total": total, "files": files,
                "order": [f["name"] for f in files],   # ★ 调用顺序预览：排好序的文件名数组（与出图顺序一致）
            })

        @routes.get("/xh/imglist/file")
        async def _xh_imglist_file(request):
            p = (request.rel_url.query.get("path") or "").strip()
            full = os.path.abspath(p) if p else ""
            if (not full) or (not os.path.isfile(full)) or \
                    (os.path.splitext(full)[1].lower() not in _IMG_EXT):
                return web.json_response({"ok": False, "error": f"不是有效的图片文件：{p}"}, status=404)
            # FileResponse 自动带 content-type / content-length，支持中文路径
            return web.FileResponse(full)

        _ROUTES_DONE = True
        print("[XH-图片列表] ✅ 本机文件夹图片接口已注册：/xh/imglist/list · /xh/imglist/file")
    except Exception as e:
        print(f"[XH-图片列表] ⚠️ 本机文件夹图片接口注册失败（「📂 文件夹」按钮不可用，其它功能不受影响）：{e}")
