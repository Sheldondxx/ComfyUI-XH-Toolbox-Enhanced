"""
🔁XH H3 Memory Saver
====================
为 Herrgotts H3 Infinite Continuation Suite 的长链工作流省内存。

背景（源码级核定，2026-09-02）：
    ComfyUI 的 VAE.decode 输出 IMAGE 落在 **CPU**
    （comfy/sd.py:1078 -> output_device = intermediate_device()
     model_management.py:1239 -> 未开 --gpu-only 时返回 CPU）
    SeamlessJoin 的 torch.cat 全程跟随输入设备 -> 拼接也在 CPU。
    所以 03 多段同跑的瓶颈是 **系统内存**，不是显存。

本包提供两种省内存手段：
    1) 🔁XH图像精度   把 IMAGE 转 fp16 -> 整条 Join 链内存砍半
    2) 🔁XH图像落盘/读取  把像素写盘、只传缓存键 -> 打断像素常驻链

⚠️ 反向铁律：永远不要加 --gpu-only，那会把像素链搬回显存。
⚠️ --fp16-vae 省不了内存（只改 VAE 计算精度），本包是改 IMAGE 本身。
"""

import os

import torch
import folder_paths

CATEGORY = "🔁XH/Video"
CACHE_SUBDIR = "xh_image_cache"

# 语言切换按钮由 web/xh_memsaver_lang.js 注入（XH 风格：每节点必备 中/EN）


def _cache_dir() -> str:
    """缓存目录：ComfyUI temp 目录下单独开一个子目录，方便整体清理。"""
    d = os.path.join(folder_paths.get_temp_directory(), CACHE_SUBDIR)
    os.makedirs(d, exist_ok=True)
    return d


def _safe_key(key) -> str:
    """只保留字母数字与 - _ ，防路径穿越。"""
    s = "".join(c for c in str(key or "") if c.isalnum() or c in "-_")
    return s or "xh_default"


def _dtype_of(name: str) -> torch.dtype:
    return {
        "fp16": torch.float16,
        "bf16": torch.bfloat16,
        "fp32": torch.float32,
    }[name]


class XHImagePrecision:
    """🖼 转换 IMAGE 精度。插在 VAEDecode 之后 / 输出之前，让整条链按低精度常驻。"""

    DESCRIPTION = (
        "【干什么】把 IMAGE 批量的浮点精度转成 fp16 / bf16 / fp32，"
        "让整条 H3 长链（VAEDecode → SeamlessJoin → 再编码）按低精度常驻，内存直接砍半。\n"
        "【怎么配】· images：接上游 IMAGE（VAEDecode 或 SeamlessJoin 的输出）\n"
        "· precision：默认 fp16（内存砍半，推荐）；bf16 同样省但需要硬件支持；fp32 用于输出前还原画质\n"
        "· 目标精度与输入相同时**原样返回**，不做无谓拷贝\n"
        "【怎么用】VAEDecode 之后立刻放一个并选 fp16 → 中间所有 Join / 再编码都按低精度跑 → "
        "保存前再串一个本节点选 fp32 还原。\n"
        "【输出】IMAGE（已是目标精度）。\n"
        "⚠️ 它改的是 IMAGE 本身的 dtype，跟 --fp16-vae（只改 VAE 计算精度）不是一回事；"
        "也**不要**为了省内存加 --gpu-only，那会把像素链搬回显存。"
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE", {
                    "tooltip": "输入图像批（VAEDecode / SeamlessJoin 的 IMAGE）| Input IMAGE batch",
                }),
                "precision": (["fp16", "bf16", "fp32"], {
                    "default": "fp16",
                    "tooltip": "目标精度。fp16 内存砍半，推荐；fp32 用于输出前还原 | Target dtype",
                }),
            }
        }

    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "convert"
    CATEGORY = CATEGORY

    def convert(self, images, precision):
        dtype = _dtype_of(precision)
        # dtype 相同则原样返回，不做无谓拷贝（省一次全量复制）
        out = images if images.dtype == dtype else images.to(dtype)
        return (out,)


class XHImageCacheWrite:
    """📤 把 IMAGE 写盘，只向下传缓存键（不传 IMAGE），让上游像素得以释放。"""

    DESCRIPTION = (
        "【干什么】把 IMAGE 写进 ComfyUI temp 目录下独立的 xh_image_cache 子目录，"
        "向下游**只传缓存键（STRING）、不传像素** —— 上游的 IMAGE 随即可以被释放。\n"
        "【怎么配】· images：要落盘的图像批\n"
        "· cache_key：缓存键，同一条链必须保持一致（默认 xh_chain）\n"
        "· store_precision：存盘精度，默认 fp16（省一半磁盘与 IO）\n"
        "【怎么用】用来**打断像素常驻**：在多段同跑的长链中间插一组「落盘 + 读取」，"
        "写盘点之后的内存压力立刻下降，读回点之前不会有任何像素被加载。\n"
        "【输出】cache_key（STRING），交给 🔁XH-图像读取。\n"
        "⚠️ 本节点每轮都重写（IS_CHANGED 返回 NaN），不会让你拿到上一轮的陈旧像素。"
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE", {
                    "tooltip": "要落盘的图像批。本节点不向下传 IMAGE，写盘后上游即可释放 | IMAGE to dump",
                }),
                "cache_key": ("STRING", {
                    "default": "xh_chain",
                    "multiline": False,
                    "tooltip": "缓存键，同一条链保持相同 | Cache key, keep identical in one chain",
                }),
                "store_precision": (["fp16", "fp32"], {
                    "default": "fp16",
                    "tooltip": "存盘精度，fp16 省一半磁盘与 IO | Storage precision",
                }),
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("cache_key",)
    FUNCTION = "write"
    CATEGORY = CATEGORY

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        # 每轮都重写，避免复用上一轮的陈旧像素
        return float("nan")

    def write(self, images, cache_key, store_precision):
        from safetensors.torch import save_file

        key = _safe_key(cache_key)
        dtype = _dtype_of(store_precision)
        tensor = images.detach().to("cpu", dtype, copy=False).contiguous()
        path = os.path.join(_cache_dir(), f"{key}.safetensors")
        save_file({"images": tensor}, path)
        mb = os.path.getsize(path) / (1024 * 1024)
        print(f"[🔁XH] 图像已落盘 {path} | {tuple(tensor.shape)} {tensor.dtype} | {mb:.1f} MiB")
        return (key,)


class XHImageCacheRead:
    """📥 按缓存键把像素读回 IMAGE，重新接回 Join 链。"""

    DESCRIPTION = (
        "【干什么】按缓存键把 🔁XH-图像落盘 写下的像素读回 IMAGE，重新接回后续链路。\n"
        "【怎么配】· cache_key：必须与落盘节点那一侧**完全一致**，否则报「图像缓存不存在」\n"
        "· precision：读回精度；链上还要继续省内存就保持 fp16，出图前想要满画质就 fp32\n"
        "· delete_after：打开会在读完之后删掉缓存文件（省磁盘，但同键再读会失败）\n"
        "【怎么用】放在**真正需要像素的那个分支之前**。不要紧接着落盘节点就读，那样等于一次都没省。\n"
        "【输出】IMAGE（目标精度）。\n"
        "⚠️ 每轮都重读（IS_CHANGED 返回 NaN），不会命中旧缓存。\n"
        "⚠️ 缓存键里的非法字符会被清掉（只留字母数字与 - _），不要靠特殊字符区分两段链。"
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "cache_key": ("STRING", {
                    "default": "xh_chain",
                    "multiline": False,
                    "tooltip": "缓存键，需与落盘节点一致 | Cache key from the write node",
                }),
                "precision": (["fp16", "fp32"], {
                    "default": "fp16",
                    "tooltip": "读回精度。链上保持 fp16 更省；输出前选 fp32 | Output dtype",
                }),
                "delete_after": ("BOOLEAN", {
                    "default": False,
                    "tooltip": "读完后删除缓存文件 | Delete cache file after read",
                }),
            }
        }

    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "read"
    CATEGORY = CATEGORY

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        # 每轮都重读，否则会命中缓存而拿不到磁盘上的最新像素
        return float("nan")

    def read(self, cache_key, precision, delete_after):
        from safetensors.torch import load_file

        key = _safe_key(cache_key)
        path = os.path.join(_cache_dir(), f"{key}.safetensors")
        if not os.path.isfile(path):
            raise FileNotFoundError(
                f"[🔁XH] 图像缓存不存在: {path}\n"
                f"请确认 🔁XH图像落盘 已执行且 cache_key 一致。"
            )
        tensor = load_file(path)["images"]
        dtype = _dtype_of(precision)
        if tensor.dtype != dtype:
            tensor = tensor.to(dtype)
        if delete_after:
            try:
                os.remove(path)
            except OSError:
                pass
        return (tensor,)


NODE_CLASS_MAPPINGS = {
    "XHImagePrecision": XHImagePrecision,
    "XHImageCacheWrite": XHImageCacheWrite,
    "XHImageCacheRead": XHImageCacheRead,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "XHImagePrecision": "🔁XH-图像精度",
    "XHImageCacheWrite": "🔁XH-图像落盘",
    "XHImageCacheRead": "🔁XH-图像读取",
}

WEB_DIRECTORY = "web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
