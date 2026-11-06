"""🔁 ComfyUI-XH_AudioSep —— XH 自有的人声/伴奏分离 + 音频工具节点。

提供 4 个节点的「自有实现」，用于替代需要安装别人包才能跑的第三方节点：
  · XHVoiceSeparatorLoader / XHVoiceSeparatorSampler  —— 替代 ComfyUI-MelBandRoFormer
  · XHAudioDuration                                —— 替代 SoundFlow 的取时长节点
  · XHSimpleMath                                   —— 替代 ComfyUI-essentials 的简易数学

说明（重要）：
  · 分离模型架构代码来自 Kijai 公开的 Mel-Band-RoFormer（MIT 类许可），本包已自带在 model/ 下，
    不依赖 audio-separator 这个 pip 包；只依赖 rotary_embedding_torch + einops（requirements.txt）。
  · 这 4 个节点一律用 XH 独占的 type 名（XH 开头）注册，**不和任何第三方包抢名**，
    分享出去可放心安装，粉丝即便装了原版包也不会 type 冲突。
  · 旧的 LTX2.3 工作流（引用原版 type 名）已另存为「_XH独立版」配套使用；
    原作 JSON 仅作历史存档（依赖原版包），不再由本包提供。
"""

import os
import torch
import torch.nn.functional as F
import torchaudio.functional as TAF

import folder_paths

from .model.mel_band_roformer import MelBandRoformer

from comfy import model_management as mm
from comfy.utils import load_torch_file, ProgressBar

device = mm.get_torch_device()
offload_device = mm.unet_offload_device()


def get_windowing_array(window_size, fade_size, device):
    fadein = torch.linspace(0, 1, fade_size)
    fadeout = torch.linspace(1, 0, fade_size)
    window = torch.ones(window_size)
    window[-fade_size:] *= fadeout
    window[:fade_size] *= fadein
    return window.to(device)


# =========================================================================
# 人声 / 伴奏分离（替代 ComfyUI-MelBandRoFormer；XH 独占命名 XHVoiceSeparatorLoader）
# =========================================================================

class MelBandRoFormerModelLoader:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "model_name": (folder_paths.get_filename_list("diffusion_models"), {
                    "tooltip": "模型放在 ComfyUI/models/diffusion_models 目录（XH 实测模型根目录为 ComfyUI-Shared/models/diffusion_models）",
                }),
            },
        }

    RETURN_TYPES = ("MELROFORMERMODEL",)
    RETURN_NAMES = ("model",)
    FUNCTION = "loadmodel"
    CATEGORY = "🔁XH/音频分离"
    DESCRIPTION = (
        "【干什么】加载自带实现的 Mel-Band-RoFormer 分离模型，输出给「🔁XH-人声分离(采样)」用。\n"
        "【怎么配】· model_name：模型文件列表，放在 models/diffusion_models 目录下\n"
        "【怎么用】只需要加载一次，后面可以多个采样节点共用同一个 model 口。\n"
        "【输出】model（MELROFORMERMODEL）。\n"
        "⚠️ 模型架构代码已内置在包里（Kijai 公开的 Mel-Band-RoFormer），"
        "不依赖 audio-separator 那个 pip 包，只依赖 rotary_embedding_torch + einops。\n"
        "⚠️ 换一个 checkpoints / 不同训练配置的权重通常会报 state_dict 不匹配 —— "
        "本节点是按 dim=384、depth=6、num_stems=1 这套参数硬写的。"
    )

    def loadmodel(self, model_name):
        model_config = {
            "dim": 384,
            "depth": 6,
            "stereo": True,
            "num_stems": 1,
            "time_transformer_depth": 1,
            "freq_transformer_depth": 1,
            "num_bands": 60,
            "dim_head": 64,
            "heads": 8,
            "attn_dropout": 0,
            "ff_dropout": 0,
            "flash_attn": True,
            "dim_freqs_in": 1025,
            "sample_rate": 44100,  # needed for mel filter bank from librosa
            "stft_n_fft": 2048,
            "stft_hop_length": 441,
            "stft_win_length": 2048,
            "stft_normalized": False,
            "mask_estimator_depth": 2,
            "multi_stft_resolution_loss_weight": 1.0,
            "multi_stft_resolutions_window_sizes": (4096, 2048, 1024, 512, 256),
            "multi_stft_hop_size": 147,
            "multi_stft_normalized": False,
        }
        model = MelBandRoformer(**model_config).eval()
        model_path = folder_paths.get_full_path_or_raise("diffusion_models", model_name)
        model.load_state_dict(load_torch_file(model_path), strict=True)
        return (model,)


class MelBandRoFormerSampler:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "model": ("MELROFORMERMODEL", {
                    "tooltip": "「🔁XH-人声分离(模型加载)」输出的那张模型卡，本节点负责真正跑分离。",
                }),
                "audio": ("AUDIO", {
                    "tooltip": (
                        "要分离的音频（单声道会自动复制成双声道）。\n"
                        "内部固定按 44.1kHz 处理，采样率不一致时会重采样。"
                    ),
                }),
            },
        }

    RETURN_TYPES = ("AUDIO", "AUDIO",)
    RETURN_NAMES = ("vocals", "instruments",)
    FUNCTION = "process"
    CATEGORY = "🔁XH/音频分离"
    DESCRIPTION = (
        "【干什么】用 Mel-Band-RoFormer 把一段音频拆成「人声」和「伴奏」两轨。\n"
        "【怎么配】· model：模型加载节点输出的那张卡\n"
        "· audio：要分离的音频\n"
        "【怎么用】先把模型加载出来，再把音频插到这里，两轨各自往下接（人声可以拿去配音/清唱，"
        "伴奏可以当背景）。\n"
        "【输出】两路 AUDIO：vocals（人声）与 instruments（伴奏）。\n"
        "⚠️ 走 chunk + overlap 滑窗处理长音频，所以很吃时间；输入越长越慢。"
    )

    def process(self, model, audio):
        audio_input = audio["waveform"]
        sample_rate = audio["sample_rate"]
        B, audio_channels, audio_length = audio_input.shape
        sr = 44100

        if audio_channels == 1:
            audio_input = audio_input.repeat(1, 2, 1)
            audio_channels = 2
            print("XH_AudioSep: 单声道输入已复制为立体声。")

        if sample_rate != sr:
            print(f"XH_AudioSep: 重采样 {sample_rate} -> {sr}")
            audio_input = TAF.resample(audio_input, orig_freq=sample_rate, new_freq=sr)
        audio_input = original_audio = audio_input[0]

        C = 352800
        N = 2
        step = C // N
        fade_size = C // 10
        border = C - step

        if audio_length > 2 * border and border > 0:
            audio_input = F.pad(audio_input, (border, border), mode='reflect')

        windowing_array = get_windowing_array(C, fade_size, device)
        audio_input = audio_input.to(device)
        vocals = torch.zeros_like(audio_input, dtype=torch.float32).to(device)
        counter = torch.zeros_like(audio_input, dtype=torch.float32).to(device)

        total_length = audio_input.shape[1]
        num_chunks = (total_length + step - 1) // step

        model.to(device)
        comfy_pbar = ProgressBar(num_chunks)

        for i in range(0, total_length, step):
            part = audio_input[:, i:i + C]
            length = part.shape[-1]
            if length < C:
                if length > C // 2 + 1:
                    part = F.pad(input=part, pad=(0, C - length), mode='reflect')
                else:
                    part = F.pad(input=part, pad=(0, C - length, 0, 0), mode='constant', value=0)

            x = model(part.unsqueeze(0))[0]
            window = windowing_array.clone()
            if i == 0:
                window[:fade_size] = 1
            elif i + C >= total_length:
                window[-fade_size:] = 1

            vocals[..., i:i + length] += x[..., :length] * window[..., :length]
            counter[..., i:i + length] += window[..., :length]
            comfy_pbar.update(1)

        model.to(offload_device)
        estimated_sources = vocals / counter

        if audio_length > 2 * border and border > 0:
            estimated_sources = estimated_sources[..., border:-border]

        vocals_out = {
            "waveform": estimated_sources.unsqueeze(0).cpu(),
            "sample_rate": sr,
        }
        instruments_out = {
            "waveform": (original_audio.to(device) - estimated_sources).unsqueeze(0).cpu(),
            "sample_rate": sr,
        }
        return (vocals_out, instruments_out)


# =========================================================================
# 音频取时长（替代 SoundFlow_GetLength；XH 独占命名 XHAudioDuration）
#   输入 AUDIO，输出 FLOAT（秒）。下游通常接 INT 计算帧数。
# =========================================================================

class XHAudioDuration:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "audio": ("AUDIO", {
                    "tooltip": "要量时长的音频；按 采样点数 ÷ 采样率 算，与实际听感一致。",
                }),
            },
        }

    RETURN_TYPES = ("FLOAT",)
    RETURN_NAMES = ("FLOAT",)
    FUNCTION = "get_length"
    CATEGORY = "🔁XH/音频工具"
    DESCRIPTION = (
        "【干什么】读出一段音频的时长（秒）。\n"
        "【怎么配】· audio：任意 AUDIO 输入\n"
        "【怎么用】拿它去算「几秒对应多少帧」「配几段提示词」这类换算，是做音画同步的尺子。\n"
        "【输出】FLOAT：时长（秒）。\n"
        "⚠️ 量的是**音频本身**的长度，跟视频/图像帧数没关系。"
    )

    def get_length(self, audio):
        waveform = audio["waveform"]          # [1, channels, samples]
        sample_rate = audio["sample_rate"]
        samples = waveform.shape[-1]
        duration = samples / float(sample_rate)
        return (float(duration),)


# =========================================================================
# 简易表达式计算器（替代 ComfyUI-essentials 的 SimpleMath+；XH 独占命名 XHSimpleMath）
#   接口 100% 对齐原版 SimpleMath+，配套的 XH 独立版工作流已改引用 XHSimpleMath：
#     · 唯一 widget:  value（STRING 表达式，支持变量 a/b/c/d、+-*/ // % **、
#                    比较/逻辑运算、min/max/round/sum/len、下标取值）
#     · 纯输入端口(forceInput, 不占 widget): a / b（INT,FLOAT）、c（*）
#     · 输出: (INT, FLOAT) —— 顺序与原版一致，下游连线原样对接。
# =========================================================================

import ast
import math
import operator as _op


class XHMathExpr:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "value": ("STRING", {
                    "multiline": False, "default": "",
                    "tooltip": (
                        "表达式本体，例：`a * 2`、`min(a, b)`、`round(a / 3)`、`a[0]`。\n"
                        "支持：变量 a / b / c / d，算符 + - * / // % **，"
                        "比较与逻辑运算，以及函数 min / max / round / sum / len，还有下标取值。\n"
                        "⚠️ 表达式里没用到的输入口不会被计算；变量名写成 d 却没有 d 口，按 0 处理。"
                    ),
                }),
            },
            "optional": {
                "a": ("INT,FLOAT", {
                    "forceInput": True,
                    "tooltip": "变量 a 的值（只能是线上接进来的数，不能手动敲）。表达式里写 a 就用它。",
                }),
                "b": ("INT,FLOAT", {
                    "forceInput": True,
                    "tooltip": "变量 b 的值（同 a，只能接线）。",
                }),
                "c": ("*", {
                    "forceInput": True,
                    "tooltip": (
                        "变量 c 的值，任意类型（*）。\n"
                        "接到张量 / 元组时会取它的 shape（`(1,3,512,512)` → 列表 `[1,3,512,512]`），"
                        "所以能直接写 `c[2]` 拿高、`c[3]` 拿宽。"
                    ),
                }),
            },
        }

    RETURN_TYPES = ("INT", "FLOAT")
    FUNCTION = "execute"
    CATEGORY = "🔁XH/数学"
    DESCRIPTION = (
        "【干什么】一个能写一行表达式的小计算器，用来替代 ComfyUI-essentials 的 SimpleMath+。\n"
        "【怎么配】· value：表达式字符串，支持 a/b/c/d 四个变量\n"
        "· a / b：纯输入口（forceInput），接 INT 或 FLOAT\n"
        "· c：任意类型输入口，接张量/元组时自动取它的 shape\n"
        "【怎么用】算帧数、算分辨率、算拼接比例这类「一步就得」的数值，省得搭一串数学节点。\n"
        "【输出】(INT, FLOAT)：同一个结果的两个类型，方便直接插到不同类型口上。\n"
        "⚠️ 表达式是受限求值的（走 AST 白名单），不支持函数调用到其他模块。"
    )

    def execute(self, value, a=0.0, b=0.0, c=0.0, d=0.0):
        # 兼容 tensor / 元组（取 shape）与字符串数字，与原版行为一致
        if hasattr(a, "shape"):
            a = list(a.shape)
        if hasattr(b, "shape"):
            b = list(b.shape)
        if hasattr(c, "shape"):
            c = list(c.shape)
        if hasattr(d, "shape"):
            d = list(d.shape)
        if isinstance(a, str):
            a = float(a)
        if isinstance(b, str):
            b = float(b)
        if isinstance(c, str):
            c = float(c)
        if isinstance(d, str):
            d = float(d)

        _operators = {
            ast.Add: _op.add, ast.Sub: _op.sub, ast.Mult: _op.mul,
            ast.Div: _op.truediv, ast.FloorDiv: _op.floordiv, ast.Pow: _op.pow,
            ast.USub: _op.neg, ast.Mod: _op.mod,
            ast.Eq: _op.eq, ast.NotEq: _op.ne, ast.Lt: _op.lt, ast.LtE: _op.le,
            ast.Gt: _op.gt, ast.GtE: _op.ge,
            ast.And: lambda x, y: x and y, ast.Or: lambda x, y: x or y, ast.Not: _op.not_,
        }
        _functions = {
            "min": min, "max": max, "round": round, "sum": sum, "len": len,
        }

        def _eval(node):
            if isinstance(node, ast.Constant):
                return node.value
            if isinstance(node, ast.Num):  # 老版本 ast 兼容
                return node.n
            if isinstance(node, ast.Name):
                return {"a": a, "b": b, "c": c, "d": d}.get(node.id, 0.0)
            if isinstance(node, ast.BinOp):
                return _operators[type(node.op)](_eval(node.left), _eval(node.right))
            if isinstance(node, ast.UnaryOp):
                return _operators[type(node.op)](_eval(node.operand))
            if isinstance(node, ast.Compare):
                left = _eval(node.left)
                for op, comp in zip(node.ops, node.comparators):
                    if not _operators[type(op)](left, _eval(comp)):
                        return 0
                return 1
            if isinstance(node, ast.BoolOp):
                return _operators[type(node.op)](*[_eval(v) for v in node.values])
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
                if node.func.id in _functions:
                    return _functions[node.func.id](*[_eval(arg) for arg in node.args])
            if isinstance(node, ast.Subscript):
                val = _eval(node.value)
                if isinstance(node.slice, ast.Constant):
                    return val[node.slice.value]
                return 0
            return 0

        try:
            result = _eval(ast.parse(value, mode="eval").body)
        except Exception:
            result = 0.0
        if isinstance(result, bool) or not isinstance(result, (int, float)):
            try:
                result = float(result)
            except Exception:
                result = 0.0
        if isinstance(result, float) and math.isnan(result):
            result = 0.0
        return (int(round(result)), float(result))
