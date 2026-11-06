# -*- coding: utf-8 -*-
"""🩹XH-接缝修正 —— XH 家族 v1 外壳

算法本体**逐字照搬**（未改一行）：`./h3_seam_impl.py`
来源：https://github.com/supElement/ComfyUI_MinimaxH3_AutoContext （Apache-2.0）
原节点：`Minimax_H3_Seam_Correction`（class_type `H3SeamCorrection`）

为什么用"照搬 + 外壳"而不是重写：
  1. 算法零风险 —— 1422 行、40 个纯函数（帧统计/边界检测/色彩 MKL 变换/光流 warp/闪帧抑制），
     重写等于把坑重踩一遍。
  2. 上游更新时可整文件替换 `h3_seam_impl.py` 跟上，外壳不动。
  3. 保留 Apache-2.0 要求：同目录 `h3_seam_impl.py` 头部即原文件（含原作者版权头），
     本包 LICENSE 同 Apache-2.0。

本外壳做的事（只加不删）：
  · 套成 ComfyUI **v1 节点**（INPUT_TYPES / RETURN_TYPES），与 XH_Toolbox 其它节点一致
  · 参数名保持英文（后端按 name 取参），中文显示交给前端 `web/xh_seam_correct.js`
  · 顺手把上游**漏暴露**的 `cut_detection` 补成可调（默认 True，与上游行为一致）
"""

from .h3_seam_impl import H3SeamCorrection

_LEVELS = ["off", "low", "medium", "high", "max"]


class XHSeamCorrect:
    # 2026-10-05：分类从裸「🔁XH」归到家族子树 🔁XH/Video（其它 XH 节点都是这个写法）
    CATEGORY = "🔁XH/Video"
    FUNCTION = "run"
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("images",)

    DESCRIPTION = (
        "【干什么】给多段拼接后的视频修接缝：全局色彩/曝光对齐（去阶跃）+ 接缝处的连续性修补，"
        "专治「一段视频一坨颜色、中间过渡像断层」。\n"
        "【怎么配】· images：解码后的完整视频帧序列（接 VAE Decode 输出）\n"
        "· fix_color_preset：色彩/曝光档位（off/low/medium/high/max，默认 medium），做分段全局对齐\n"
        "· fix_motion_preset：接缝连续性档位（默认 off），用光流对齐 + 局部融合修运动/结构不连续\n"
        "· fix_flash / flash_threshold：闪帧抑制及其阈值（推荐 0.20~0.40，越小越激进）\n"
        "· cut_detection / cut_threshold：先切镜头只在镜头内修（默认开，敏感度推荐 10~20）\n"
        "· blend_frames：接缝处的电平渐变窗口（帧），越大过渡越缓\n"
        "· use_gpu：用 CUDA 做统计、色彩变换与光流，显存不够就关\n"
        "【怎么用】放在 VAE Decode 之后、合成视频之前。算法照搬 "
        "ComfyUI_MinimaxH3_AutoContext（Apache-2.0）。\n"
        "【输出】images（IMAGE）。\n"
        "⚠️ 画面里有闪电/爆炸这类**合理的**快速明暗变化时，别开 fix_flash，会把效果削平。\n"
        "⚠️ blend_frames 给太大（>4）在大运动镜头上会有轻微糊感。"
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE", {
                    "tooltip": "解码后的完整视频帧序列（接 VAE Decode 输出）",
                }),
                "fix_color_preset": (_LEVELS, {
                    "default": "medium",
                    "tooltip": "色彩/曝光档位：分段全局对齐（去阶跃 → MKL/仿射变换）",
                }),
                "fix_motion_preset": (_LEVELS, {
                    "default": "off",
                    "tooltip": "接缝连续性档位：光流对齐 + 局部融合，修运动/结构不连续",
                }),
                "fix_flash": ("BOOLEAN", {
                    "default": False,
                    "tooltip": "闪帧抑制。画面若有闪电/爆炸等合理快速明暗变化，会被削平",
                }),
                "flash_threshold": ("FLOAT", {
                    "default": 0.30, "min": 0.0, "max": 1.0, "step": 0.01,
                    "tooltip": "瞬态修正筛选阈值：越小越激进，推荐 0.20~0.40",
                }),
                "cut_detection": ("BOOLEAN", {
                    "default": True,
                    "tooltip": "先把视频切成镜头，只在镜头内修正，真·切镜处跳过。"
                               "关掉则处理所有分段边界（上游未暴露，这里补上）",
                }),
                "cut_threshold": ("FLOAT", {
                    "default": 15.0, "min": 5.0, "max": 50.0, "step": 0.5,
                    "tooltip": "镜头检测敏感度：越小越敏感，推荐 10~20",
                }),
                "blend_frames": ("INT", {
                    "default": 2, "min": 0, "max": 8, "step": 1,
                    "tooltip": "接缝处电平渐变窗口（帧）。越大过渡越缓，"
                               "运动大的镜头过大会有轻微糊感",
                }),
                "use_gpu": ("BOOLEAN", {
                    "default": True,
                    "tooltip": "用 CUDA 做统计、色彩变换与光流（显存不够就关掉走 CPU）",
                }),
            }
        }

    def run(self, images, fix_color_preset="medium", fix_motion_preset="off",
            fix_flash=False, flash_threshold=0.30, cut_detection=True,
            cut_threshold=15.0, blend_frames=2, use_gpu=True):
        out = H3SeamCorrection.execute(
            images=images,
            fix_color_preset=fix_color_preset,
            fix_motion_preset=fix_motion_preset,
            fix_flash=fix_flash,
            flash_threshold=flash_threshold,
            cut_detection=cut_detection,
            cut_threshold=cut_threshold,
            blend_frames=blend_frames,
            use_gpu=use_gpu,
        )
        # 上游是 v3 节点、返回 io.NodeOutput；取 .result 元组回到 v1 的 return 形式
        res = getattr(out, "result", None)
        if not res:
            return (images,)
        return tuple(res)
