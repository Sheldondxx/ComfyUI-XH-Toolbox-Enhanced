# 🔁XH-MSR 精修编码（XH 家族）
#
# 干什么：把「一段一段的提示词」按时间贴到视频上，再交给 LTX 采样 ——
#   第 0~2 秒只认「女孩特写」，第 2~5 秒只认「长胡子的男人」。
#   专治二采精修时的「切镜晚了 → 女孩长出胡子」。
#
# 为什么要有它（而不是直接用上游 ComfyUI-PromptRelay）：
#   上游三个编码器（基础 / 时间线 / Smart）是**同一个东西的三种输入方式**，
#   但它们**都只吃「帧数」**，而分镜稿上写的是**秒**；
#   而且上游 Smart 版**没有 relay_options 口**（调不了「硬度」），
#   也**没有把解析结果吐出来**（段数配错时只能靠报错猜）。
#
# 🔴 面板只有 2 个文本框（其余全收进 ⚙）：
#   ① 全局提示词 —— 整段不变的东西，可留空
#   ② 分段提示词 —— 每段画面 + **段尾写时长**，一段一行（或用 `---` 分隔）
#       女孩特写，她低头看着掌心 [3]
#       ---
#       镜头转向男人，他脸上长出胡子 [4]
#   时长标记：`[3]` / `[3s]` / `[3秒]` = 本段 3 秒；`[0-3]` / `[3-7]` = 跨度 3 / 4 秒。
#   ⇒ 「文字」和「时间」在同一样东西里，**段数对不上这种错从根上不存在**。
#   （上游那套「段数必须和 segment_lengths 数相等，否则 ValueError」的手工活没了。）
#
# 与上游的关系：算法同源（同一篇 Prompt Relay 论文），实现**完全自持**
#   （见 msr_relay/engine.py，不 import 上游包）。可以并存，也可以只留我们这份。
#
# 2026-10-14 新建（用户要求：「不要只做一个皮」）。
# 2026-10-14 精简（v1.9.35）：删掉 `shot_seconds` 框（并进分段稿）、删掉 `h3_frame_snap`
#   开关（本节点只服务 LTX 2.5，H3 帧格与之无关）、6 个硬度参数收进前端 ⚙。
# ⚠️ INPUT_TYPES 必须写成**内联 dict**（`return {"required": {...}}`）：
#   写成 `required = {...}` 再 return 的话，家族体检脚本 xh_lang_audit.py 的
#   `_section()` 找不到 `"required": {`，会退回「宽松正则 + 只扫前 4000 字」，
#   参数清单被截断 ⇒ 本地化对账出现假 ❌ / 假 ✅（家族「分段表」就是这么中招的）。

import time

from . import engine as _eg

CATEGORY_TYPE = "🔁XH/链提示词"


class XHMSRRelayEncode:
    """把一段分段稿按各自时长贴到视频的不同时间段上（MSR 二采精修用）。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                # ---- 三件必需品（与官方编码器一致：模型 / 文本编码器 / 空潜空间）----
                "model": ("MODEL", {
                    "tooltip": (
                        "要精修的模型（LTX 2.5 或 Wan）。\n"
                        "⚠️ 接在采样器之前、LoRA 之后那一段；本节点会在这份模型上挂时段遮罩。"
                    ),
                }),
                "clip": ("CLIP", {
                    "tooltip": "对应的文本编码器（LTX 2.5 用它的 text encoder；Wan 用 umt5）。",
                }),
                "latent": ("LATENT", {
                    "tooltip": (
                        "空潜空间。**视频长度就是从这里读的**（只读形状，不消耗内容）。\n"
                        "⚠️ 它必须和真正要采样的那一份 latent 尺寸一致，否则段长会算错。"
                    ),
                }),

                # ---- 两个文本框（这就是全部要填的东西）----
                "global_prompt": ("STRING", {
                    "default": "", "multiline": True,
                    "tooltip": (
                        "全局锚：整段视频都不变的那些描述 —— 人物长相、服装、风格、画质词。\n"
                        "留空时自动拿第 1 段的文字当全局锚（与官方 Smart 版同款行为）。\n"
                        "🔴 防串味的要点：**会变的东西别写在这里**，写进下面的分段里。"
                    ),
                }),
                "shot_prompts": ("STRING", {
                    "default": "", "multiline": True,
                    "tooltip": (
                        "每段画面 + **段尾写时长**。一段一行；想一段写多行就用一行 `---` 分隔。\n"
                        "  女孩特写，她低头看着掌心 [3]\n"
                        "  ---\n"
                        "  镜头转向男人，他脸上长出胡子 [4]\n"
                        "时长标记（写在**该段最后**）：\n"
                        "  `[3]` / `[3s]` / `[3秒]` → 本段 3 秒\n"
                        "  `[0-3]` / `[3-7]`      → 第 0~3 秒 / 第 3~7 秒（跨度 3 / 4 秒）\n"
                        "🔴 所有时长加起来应当 = 整段视频时长；对不上时节点会在 info 里算出漂移倍率。\n"
                        "⚠️ 段落文字里不要出现竖线 `|`（那是引擎内部分段符）。"
                    ),
                }),

                # ---- 以下都收进 ⚙（默认展开？不 —— 前端默认收起）----
                "fps": ("FLOAT", {
                    "default": 24.0, "min": 1.0, "max": 240.0, "step": 0.1,
                    "tooltip": (
                        "秒 → 帧的换算基准。H3 / LTX 工作流都是 24。\n"
                        "⚠️ 改这个只影响「秒数怎么变帧数」，不影响模型本身。"
                    ),
                }),
                "epsilon": ("FLOAT", {
                    "default": 1e-3, "min": 1e-6, "max": 0.99, "step": 1e-4,
                    "tooltip": (
                        "画面时间惩罚的衰减参数。\n"
                        "· 越小 → sigma 越小 → 边界越**硬**（论文默认 0.001，0.1 以下基本都一样硬）。\n"
                        "· 0.5 以上 → 边界开始明显变**软**，适合想让镜头之间自然过渡。\n"
                        "🔴 这是「防串味」的主开关：越硬，越不容易把下一镜的提示词提前用上。"
                    ),
                }),
                "video_strength": ("FLOAT", {
                    "default": 1.0, "min": 0.0, "max": 10.0, "step": 0.05,
                    "tooltip": (
                        "画面惩罚的整体倍率。0 = 关掉画面分段（等于没贴）。\n"
                        "· 0~1 区间最有用：调小 → 边界变软。\n"
                        "· >1 在默认 epsilon=0.001 下很快就饱和。想让 >1 起作用，先把 epsilon 提到 0.1 以上。"
                    ),
                }),
                "video_window_scale": ("FLOAT", {
                    "default": 1.0, "min": 0.0, "max": 4.0, "step": 0.05,
                    "tooltip": (
                        "缩放「刚性锚区」的宽度（默认 = 本段帧数/2 - 2 帧）。\n"
                        "· <1 → 更早开始衰减（边界更硬，推荐 0.8~1.0 压串味）。\n"
                        "· >1 → 刚性区更宽（段中间更稳，但边界更软）。"
                    ),
                }),
                "audio_epsilon": ("FLOAT", {
                    "default": 0.0, "min": 0.0, "max": 0.99, "step": 1e-4,
                    "tooltip": (
                        "音频那一流的衰减参数（只对 LTX 音频注意力生效）。\n"
                        "0 = 继承上面的 epsilon。\n"
                        "🔴 这就是「音频该说话时没说话 / 说话不对」的调节旋钮："
                        "调硬 → 每段声音更独立；调软 → 声音更连贯。"
                    ),
                }),
                "audio_strength": ("FLOAT", {
                    "default": 1.0, "min": 0.0, "max": 10.0, "step": 0.05,
                    "tooltip": (
                        "音频惩罚的倍率。0 = 允许声音跨镜延续（画面切了声音不断）。\n"
                        "0~1 区间最有用；>1 需要先提高 audio_epsilon 才有明显效果。"
                    ),
                }),
                "audio_window_scale": ("FLOAT", {
                    "default": 1.0, "min": 0.0, "max": 4.0, "step": 0.05,
                    "tooltip": "音频刚性锚区的宽度倍率。语义同 video_window_scale，只是作用于声音。",
                }),
            },

            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    RETURN_TYPES = ("MODEL", "CONDITIONING", "STRING")
    RETURN_NAMES = ("model", "positive", "info")
    FUNCTION = "run"
    CATEGORY = CATEGORY_TYPE
    OUTPUT_NODE = False
    DESCRIPTION = (
        "【干什么】按「每段自带的时长」把多段提示词贴到视频的不同时间段上，让 LTX 二采精修时"
        "每一段只认自己那段提示词 —— 专治切镜点提示词串味（女孩长出胡子）。\n"
        "【怎么配】① global_prompt 写整段不变的东西（人物长相/风格）；留空则拿第 1 段当全局锚；"
        "② shot_prompts 写每段画面，**在段尾写时长**（`[3]`/`[3s]`=3 秒，`[0-3]`=跨度 3 秒），"
        "一段一行或用一行 `---` 分隔；③ 所有时长之和 = 整段视频时长（对不上会警告）。\n"
        "【输出】model（已挂时段遮罩）、positive（正向条件）、"
        "info（每段起止帧/秒 + 「时长总和和视频长度对不对得上」）。\n"
        "【和上游的区别】秒→帧自动换算；「硬度」六件套在 ⚙ 里直接调；"
        "文字与时间绑在同一段里（段数不可能对不上）；段长结果有 info 可查。\n"
        "【支持模型】LTX（含 2.5）、Wan。其余架构会明确报错。"
    )

    # 每次 queue 都重算：段长来自文本框，改了文字必须立刻生效，绝不命中缓存。
    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return time.time()

    def run(self, model, clip, latent, global_prompt, shot_prompts,
            fps=24.0, epsilon=1e-3,
            video_strength=1.0, video_window_scale=1.0,
            audio_epsilon=0.0, audio_strength=1.0, audio_window_scale=1.0,
            unique_id=None):

        # ---------- 1) 拆段 + 取每段时长 ----------
        shots = _eg.parse_shot_script(shot_prompts)
        if not shots:
            raise ValueError(
                "[XH-MSR] 没拿到任何分段 —— 请在「分段提示词」里写每段画面，"
                "段与段之间用一行 `---` 分隔（或一行一段），并在**每段末尾**写上时长。"
            )

        untimed = [i + 1 for i, (_t, s) in enumerate(shots) if s is None or s <= 0]
        if untimed:
            head = "、".join("第 %d 段" % i for i in untimed[:6])
            more = "……" if len(untimed) > 6 else ""
            raise ValueError(
                "[XH-MSR] 这些段没写时长：%s%s\n"
                "　请在该段**末尾**补上，例：\n"
                "　　女孩特写 [3]　　　← 本段 3 秒\n"
                "　　镜头转向男人 [0-3] ← 第 0~3 秒（跨度 3 秒）\n"
                "　`[3]` / `[3s]` / `[3秒]` 都表示 3 秒。"
                % (head, more)
            )

        texts = [t for t, _s in shots]
        secs = [float(s) for _t, s in shots]
        n = len(shots)

        # 引擎内部用 ` | ` 拼段 —— 段文字里不能含竖线，否则会被拆成两段（静默错位）
        if len([p for p in " | ".join(texts).split("|") if p.strip()]) != n:
            raise ValueError(
                "[XH-MSR] 有段落的文字里出现了竖线 `|`。那是引擎内部的分段符，"
                "会把一段拆成两段 ⇒ 段数与时长对不上。请把它换成 `/`、`，` 之类的符号。"
            )

        # ---------- 2) 秒 → 像素帧 ----------
        try:
            _fps = float(fps)
        except (TypeError, ValueError):
            _fps = 24.0
        if _fps <= 0:
            _fps = 24.0

        frames = [max(1, int(round(s * _fps))) for s in secs]
        segment_lengths_str = ", ".join(str(f) for f in frames)

        # ---------- 3) 编码 + 打补丁 ----------
        opts = {
            "video_strength": video_strength,
            "video_window_scale": video_window_scale,
            "audio_epsilon": audio_epsilon if audio_epsilon > 0 else None,
            "audio_strength": audio_strength,
            "audio_window_scale": audio_window_scale,
        }

        patched, conditioning, eff_lengths, temporal_stride, latent_frames = _eg.encode_relay(
            model, clip, latent,
            (global_prompt or "").strip() or texts[0],
            " | ".join(texts),
            segment_lengths_str, epsilon, opts,
        )

        # ---------- 4) 白纸黑字写 info（上游没有的东西）----------
        total_px = sum(frames)
        # 按模型自己的换算口径，整段视频约等于多少像素帧
        full_px = max(1, latent_frames * temporal_stride)

        lines = []
        lines.append(
            "[XH-MSR] 共 %d 段 ｜ 视频约 %.3f 秒（latent %d 帧 × 时间压缩 %d = %d 像素帧 @%.4g fps）"
            % (n, full_px / _fps, latent_frames, temporal_stride, full_px, _fps)
        )
        if not (global_prompt or "").strip():
            lines.append("（global_prompt 留空 → 已自动把第 1 段当作全局锚）")

        cursor = 0
        for i, (txt, f, s) in enumerate(zip(texts, frames, secs)):
            eff = eff_lengths[i] if i < len(eff_lengths) else 0
            head = txt.replace("\n", " ").strip()[:26]
            lines.append(
                "  第 %d 段：%.4g 秒 = 像素帧 %d~%d（%.3f~%.3f 秒 / 实际潜在帧 %d）　%s…"
                % (i + 1, s, cursor, cursor + f, cursor / _fps, (cursor + f) / _fps, eff, head)
            )
            cursor += f

        # 对得上吗？（这是「切镜点会不会漂」的直接判据）
        if abs(total_px - full_px) <= max(1, temporal_stride):
            lines.append(
                "✅ 时长合计 %d 像素帧 ≈ 视频整段 %d 像素帧 → 边界会钉满，切镜点不会漂。"
                % (total_px, full_px)
            )
        else:
            scale = full_px / max(1, total_px)
            lines.append(
                "🔴 时长合计 %d 像素帧（%.3f 秒），视频整段约 %d 像素帧（%.3f 秒）——"
                "%s。\n"
                "　　⇒ 各段长度会被整体乘上 %.4f 去铺满视频，**你填的切镜点会跟着漂**。\n"
                "　　⇒ 请把时长改成合计等于整段视频时长（%.3f 秒），对齐才对得上。"
                % (total_px, total_px / _fps, full_px, full_px / _fps,
                   "偏短" if total_px < full_px else "偏长",
                   scale, full_px / _fps)
            )

        info = "\n".join(lines)
        print(info)

        return (patched, conditioning, info)


NODE_CLASS_MAPPINGS = {"XHMSRRelayEncode": XHMSRRelayEncode}
NODE_DISPLAY_NAME_MAPPINGS = {"XHMSRRelayEncode": "🔁XH-MSR精修编码"}
