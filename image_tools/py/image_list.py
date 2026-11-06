# 🖼️XH-图片列表（XH 家族，2026-10-01）
#
# 多图「上传 + 顺序管理」节点。前端画廊（web/xh_image_list.js）负责：
#   · 上传多张图（POST /upload/image，落到 ComfyUI 的 input 目录）
#   · 在节点上渲染缩略图 + 拖拽排序 + 显眼的顺序编号（第 1 / 2 / 3 张…）
#   · 把有序列表写回本节点的 `images` STRING 控件（JSON 数组），随工作流一起存档
#
# 后端只负责：读 `images` 里的顺序，把图片按序堆叠成 IMAGE 批次输出。
#
# ⚠️ 与官方 LoadImage 的区别：LoadImage 一次一张、且无顺序概念；
#    本节点一次管一批、顺序决定进循环的先后（第 1 张 → 第 1 段）。

import os
import json

import numpy as np
import torch
from PIL import Image

import folder_paths


class XHImageList:
    """按上传顺序管理一批图片，输出成 IMAGE 批次（顺序 = 拖拽排序后的顺序）。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                # 这个控件是前端画廊的「数据落地」：存 JSON 数组
                # [{name, subfolder, type}, ...]，顺序即显示 / 输出顺序。
                # 前端会把它 hide 掉（不占界面），但值会随工作流存档。
                "images": ("STRING", {
                    "default": "[]",
                    "multiline": False,
                    "tooltip": (
                        "（内部数据）前端画廊把上传的图片顺序写回这里，随工作流存档。\n"
                        "普通用户不用管：用节点上的「➕ 添加图片 / 拖拽排序 / ✕ 删除」即可。"
                    ),
                }),
                # 自循环开关：开 → 逐张吐 IMAGE 列表（每张独立），下游逐张处理；
                # 关（默认）→ 维持原整批输出，行为不变。
                "all_segments": ("BOOLEAN", {
                    "default": False,
                    "label_on": "逐张输出(自循环)",
                    "label_off": "整批输出",
                    "tooltip": (
                        "【自循环·逐张输出】开 → 把每张图单独作为一个 IMAGE 输出（列表），"
                        "下游逐张独立处理，实现「一张一张跑」。\n"
                        "关（默认）→ 维持原整批输出（所有图打包成一个 IMAGE 批次一起出）。\n"
                        "⚠️ 想要「第1张完整出图→第2张」那种顺序循环，请用 🔁XH-循环把流水线包起来；"
                        "本开关只是列表广播，不是顺序循环。"
                    ),
                }),
            },
        }

    RETURN_TYPES = ("IMAGE", "INT")
    # 端口名一律英文（4B.2 红线：name 不许本地化），中文交给 web/xh_image_list.js 的 slots 字典
    RETURN_NAMES = ("IMAGE", "count")
    OUTPUT_IS_LIST = (True, False)
    FUNCTION = "get_images"
    CATEGORY = "🔁XH/Image"
    DESCRIPTION = (
        "把一批图片按你拖拽排好的顺序管理成一个列表，并输出成 IMAGE 批次："
        "第 1 张 → 第 1 段、第 2 张 → 第 2 段……\n"
        "节点上直接显示每张缩略图，可拖拽改顺序、可删。想接入循环，"
        "把 IMAGE 接到循环体内、配合「🖼️XH-图像按序取」按 index 逐段取图。"
    )

    @staticmethod
    def _resolve_paths(items):
        """把 `images` 里的一串条目展开成「一串要读的绝对路径」。

        ★ 2026-10-12 文件夹模式（type == "folder"）—— 这里的关键设计：
          画布上**只存那一个文件夹路径**（一个条目、几十字节），
          151 张图**不进画布、不渲缩略图** ⇒ 画布不卡；
          真到出图这一刻，才在这里去列目录、按文件名自然排序、逐个读。
        """
        base = folder_paths.get_input_directory()
        out = []
        for it in items:
            if not isinstance(it, dict):
                continue
            name = it.get("name")
            if not name:
                continue
            typ = it.get("type") or "input"
            if typ == "folder":
                try:
                    from .local_image_api import list_images          # 包内相对导入
                except Exception:                                     # noqa: BLE001
                    from local_image_api import list_images           # 兜底：被当独立模块加载时
                try:
                    files, total = list_images(
                        name, recursive=bool(it.get("recursive")), limit=2000
                    )
                except Exception as e:                                # noqa: BLE001
                    raise ValueError(
                        f"[XH-图片列表] 读文件夹失败：{name}\n（{e}）"
                        "路径可能被挪走/改名了，重新关联一次即可。"
                    )
                if not files:
                    raise ValueError(
                        f"[XH-图片列表] 这个文件夹里没有图片：{name}\n"
                        "（只认 png/jpg/jpeg/webp/bmp/gif/tif/avif 这些扩展名）"
                    )
                if total > len(files):
                    print(f"[XH-图片列表] ⚠ 文件夹 {name} 共 {total} 张，本次只读前 {len(files)} 张（上限 2000）")
                print(f"[XH-图片列表] 📂 出图时读取文件夹 {name} → {len(files)} 张"
                      f"（第 1 张：{files[0]['name']}）")
                out.extend(os.path.abspath(f["path"]) for f in files)
            elif typ == "abs":
                # 旧行为（2026-10-12 上午的版本）：逐张存的绝对路径引用
                out.append(os.path.abspath(name))
            else:
                d = folder_paths.get_directory_by_type(typ) or base
                out.append(os.path.abspath(os.path.join(d, it.get("subfolder") or "", name)))
        return out

    def get_images(self, images, all_segments=False):
        try:
            items = json.loads(images) if isinstance(images, str) else (images or [])
        except Exception:
            items = []
        if not isinstance(items, list) or len(items) == 0:
            raise ValueError(
                "[XH-图片列表] 还没有图片：请在节点上点「➕ 添加图片」上传，"
                "或在下面那行粘贴文件夹路径后回车，或确认工作流里这个节点的图片数据没丢。"
            )

        paths = self._resolve_paths(items)
        if not paths:
            raise ValueError("[XH-图片列表] 列表里的图片都加载失败了。")

        tensors = []
        ref_size = None
        for full in paths:
            if not os.path.isfile(full):
                raise FileNotFoundError(
                    f"[XH-图片列表] 找不到图片：{full}。"
                    "可能文件被挪走 / 删了，重新上传或重新关联文件夹即可。"
                )
            with Image.open(full) as im:
                im = im.convert("RGB")
                if ref_size is None:
                    ref_size = im.size
                elif im.size != ref_size:
                    print(
                        f"[XH-图片列表] 图片尺寸不一致（{im.size} ≠ {ref_size}），"
                        f"已缩放到第一张尺寸；想保留原尺寸请统一上传尺寸。"
                    )
                    im = im.resize(ref_size)
                arr = np.array(im).astype(np.float32) / 255.0
                tensors.append(torch.from_numpy(arr)[None,])

        if not tensors:
            raise ValueError("[XH-图片列表] 列表里的图片都加载失败了。")

        if all_segments:
            # 逐张输出：每张独立成 IMAGE，下游逐张处理（列表广播）
            return ([t for t in tensors], len(tensors))

        batch = torch.cat(tensors, dim=0)  # [N, H, W, 3]
        return ([batch], len(tensors))


NODE_CLASS_MAPPINGS = {"XHImageList": XHImageList}
NODE_DISPLAY_NAME_MAPPINGS = {"XHImageList": "🖼️XH-图片列表"}
