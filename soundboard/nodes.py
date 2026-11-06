# -*- coding: utf-8 -*-
"""🔊XH-声音播放 —— 后端

机制（与社区 PlaySound 同源，但「音效文件」下拉改成**实时扫描本地音效库**）：

  · 本节点在图上是个「哑节点」——不产出任何张量，只把上游信号原样透传；
  · 真正的声音由**前端**播放：后端通过 `{"ui": {...}}` 把「放哪个文件 / 多大音量 /
    什么时候放 / 要不要掐掉上一声」回传给浏览器，前端收到后 new Audio() 播放；
  · 音效库 = `web/sounds/<分类>/`（提示音 ui / 音效 sfx / 音乐 music / 人声 voice），
    往目录里丢 wav / mp3 文件、按 F5 刷新页面，就能在下拉里选到。

⚠️ 为什么不用 `INPUT_IS_LIST` 之外的花招：本节点只需触发一次。
"""
import os

# web/sounds —— 与 WEB_DIRECTORY 同源（web.static 把整个 web/ 挂在
# /extensions/Comfyui-XH_Toolbox/ 下，所以音频用 URL 直接取得到，不需要额外路由）
_HERE = os.path.dirname(os.path.abspath(__file__))
SOUND_ROOT = os.path.normpath(os.path.join(_HERE, os.pardir, "web", "sounds"))

CATEGORIES = ("ui", "sfx", "music", "voice")
AUDIO_EXTS = (".wav", ".mp3", ".ogg", ".flac", ".m4a", ".aac", ".opus", ".webm")
EMPTY_HINT = "(音效库为空 · 见 tooltip)"


class AnyType(str):
    """「任意类型」哨兵：让 `!=` 恒为假，避免 ComfyUI 做类型校验（社区通行做法）。"""

    def __ne__(self, __value):
        return False


ANY = AnyType("*")


def scan_sounds():
    """扫描音效库，返回 `["ui/叮.wav", ...]`（相对 sounds 根的路径）。

    每次调用都实时读盘 —— ComfyUI 每次请求 /object_info 都会重新调 INPUT_TYPES，
    所以「丢文件 + F5」就能刷新下拉，不需要重启。
    """
    out = []
    for cat in CATEGORIES:
        d = os.path.join(SOUND_ROOT, cat)
        if not os.path.isdir(d):
            continue
        try:
            names = sorted(os.listdir(d), key=lambda s: s.lower())
        except OSError:
            continue
        for name in names:
            if name.startswith("."):
                continue
            if os.path.splitext(name)[1].lower() not in AUDIO_EXTS:
                continue  # 顺手挡掉「把配音放这里.txt」这类说明文件
            if os.path.isfile(os.path.join(d, name)):
                out.append(f"{cat}/{name}")
    return out


def _resolve(rel):
    """把相对路径解析成绝对路径；越界（目录穿越）或不存在则返回 None。"""
    if not rel:
        return None
    rel = str(rel).replace("\\", "/").lstrip("/")
    full = os.path.normpath(os.path.join(SOUND_ROOT, *rel.split("/")))
    # 必须仍在音效库内，且是已知分类下的音频文件
    if os.path.commonpath([full, SOUND_ROOT]) != SOUND_ROOT:
        return None
    if not full.lower().endswith(AUDIO_EXTS):
        return None
    return full if os.path.isfile(full) else None


def _first(v, default=None):
    """INPUT_IS_LIST 下参数是单元素列表；取首元素。"""
    if isinstance(v, (list, tuple)):
        if not v:
            return default
        return v[0]
    return default if v is None else v


class XHSoundPlayer:
    """🔁XH/音频 —— 跑完响一声。"""

    @classmethod
    def INPUT_TYPES(cls):
        files = scan_sounds() or [EMPTY_HINT]
        return {
            "required": {
                "any": (
                    ANY,
                    {
                        "tooltip": (
                            "触发信号：接上游任意一个节点的输出即可（图像 / 潜变量 / 文本都行）。\n"
                            "本节点不改变信号本身，只是「路过时响一声」，所以接在链尾最合适。\n"
                            "⚠️ 不接线本节点不会执行 —— 它是被上游触发的。"
                        ),
                    },
                ),
                "file": (
                    files,
                    {
                        "default": files[0],
                        "tooltip": (
                            "要播放的声音。列表里把音效库全部文件按「分类 · 文件名」列出：\n"
                            "· 提示音 = 叮 / 咚 / 完成 / 失败 这类短提示\n"
                            "· 音效 = 嗖 / 啪 / 哐 / 金币 这类画面音效\n"
                            "· 音乐 = 辉煌 / 悬疑 / 轻松 这类短曲\n"
                            "· 人声 = 留给你自己的配音片段\n"
                            "➕ 想加自己的：把 wav / mp3 丢进\n"
                            "   custom_nodes\\Comfyui-XH_Toolbox\\web\\sounds\\<分类>\\ 再按 F5（前端刷新）即可。\n"
                            "⚠️ 新增文件后**不用重启 ComfyUI**，按 F5 就够。"
                        ),
                    },
                ),
                "volume": (
                    "FLOAT",
                    {
                        "default": 0.6,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.05,
                        "tooltip": (
                            "音量，0 = 静音、1 = 拉满。默认 0.6（不吵但听得清）。\n"
                            "⚠️ 受系统音量与浏览器标签是否被静音影响；\n"
                            "浏览器在**播放过声音之前**可能拦截自动播放 —— 手动点一次页面即可解锁。"
                        ),
                    },
                ),
                "mode": (
                    ["always", "on empty queue"],
                    {
                        "default": "always",
                        "tooltip": (
                            "什么时候响：\n"
                            "· always = 立即播放 —— 流程一经过本节点就响（适合「这一批跑完了」）\n"
                            "· on empty queue = 队列跑完再播 —— 等整个队列清空才响，连着跑多轮时\n"
                            "  不会响成一片（适合放在链尾报「全部完成」）\n"
                            "⚠️ on empty queue 会先等约 0.5 秒确认队列真的空了，略有延迟，这是有意的。"
                        ),
                    },
                ),
                "stop_previous": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "tooltip": (
                            "开（默认）= 播新的之前先把上一声掐掉 —— 连跑时不会好几声叠在一起。\n"
                            "关 = 允许叠着响。\n"
                            "⚠️ 只掐「本节点自己上一次放的那一声」，不会去动别的节点播的声音。"
                        ),
                    },
                ),
                "loop": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "tooltip": (
                            "开 = 循环播放 —— 一遍放完自动从头再来，一直响下去；\n"
                            "关（默认）= 只播一遍就结束。\n"
                            "· 适合「音乐」分类：跑完当背景乐一直放着\n"
                            "· ⚠️ 短音效（叮 / 啪 / 嗖）循环会变成连成一片的噪音，别开\n"
                            "· ⚠️ 怎么停：点节点上的 ⏹ 按钮；或者再跑一次工作流（会按\n"
                            "  「先掐掉上一声」把它掐掉）；刷新页面也会停。"
                        ),
                    },
                ),
            }
        }

    RETURN_TYPES = (ANY, "STRING")
    RETURN_NAMES = ("any", "info")
    # 🔴 这两行是**成对**的，缺一个就炸（2026-10-05 因为漏了 INPUT_IS_LIST 出过 TypeError）：
    #   INPUT_IS_LIST = True  → ComfyUI 把「任意信号」整串当列表一次喂进来，本节点只被调用一次
    #                           （本节点只需触发一次，见文件头说明）
    #   OUTPUT_IS_LIST[0] = True → 顺手把这串信号原样还回去（透传），下游该扇出几次还扇出几次
    # ⛔ 只写 OUTPUT_IS_LIST 不写 INPUT_IS_LIST 时，ComfyUI 会对 any 执行 list(any)：
    #    张量 / 字典能迭代 → 悄悄错（被拆成一批）；ComfyUI 0.38 的 VideoFromComponents
    #    不可迭代 → 直接 TypeError: 'VideoFromComponents' object is not iterable。
    INPUT_IS_LIST = True
    OUTPUT_IS_LIST = (True, False)
    FUNCTION = "play"
    CATEGORY = "🔁XH/音频"
    OUTPUT_NODE = True
    DESCRIPTION = (
        "【干什么】工作流跑到这里时，让浏览器播一段声音 —— 跑完「叮」一声、失败「咚」一声，"
        "不用一直盯着屏幕；勾上「循环播放」还能把音乐一直放着。\n"
        "【怎么配】把上游任意输出接到「任意信号」口；在「音效文件」下拉里挑一个"
        "（提示音 / 音效 / 音乐 / 人声都在同一个列表里，按「分类 · 名字」显示）。\n"
        "【怎么用】音量 0~1；「播放时机」选 always = 每经过就响、on empty queue = 队列清空才响；"
        "「先掐掉上一声」避免连跑时几声叠在一起；「循环播放」开 = 反复响、关（默认）= 只响一遍。\n"
        "【输出】原样透传上游信号 + 一段文字说明（它到底放了哪个文件）。\n"
        "➕ 加自己的音效：把音频丢进 web\\sounds\\<分类>\\ 后按 F5。"
    )

    # 每次都重跑：声音节点被缓存掉就没意义了
    # ⚠️ 必须是 classmethod：ComfyUI 是拿**类**去调 IS_CHANGED 的（execution.py 里传的是 class_def，
    #    不是实例），写成实例方法就会每次报
    #    "XHSoundPlayer.IS_CHANGED() missing 1 required positional argument: 'self'"。
    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("NaN")

    def play(self, any, file, volume, mode, stop_previous, loop=False):
        rel = str(_first(file, "") or "")
        try:
            vol = float(_first(volume, 0.6))
        except (TypeError, ValueError):
            vol = 0.6
        vol = min(1.0, max(0.0, vol))
        md = str(_first(mode, "always") or "always")
        if md not in ("always", "on empty queue"):
            md = "always"
        stop = bool(_first(stop_previous, True))
        lp = bool(_first(loop, False))

        if _resolve(rel) is None:
            info = (
                "未播放：音效库里没有这个文件（"
                + (rel or "空")
                + "）。把音频放进 web\\sounds\\<分类>\\ 后按 F5 刷新前端。"
            )
            return {"ui": {"xh_sound": []}, "result": (any, info)}

        info = (
            f"播放 {rel} | 音量 {vol:.2f} | {md}"
            + (" | 循环" if lp else " | 单次")
            + (" | 先掐上一声" if stop else "")
        )
        return {
            "ui": {"xh_sound": [rel, vol, md, stop, lp]},
            "result": (any, info),
        }


NODE_CLASS_MAPPINGS = {
    "XHSoundPlayer": XHSoundPlayer,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "XHSoundPlayer": "🔊XH-声音播放",
}
