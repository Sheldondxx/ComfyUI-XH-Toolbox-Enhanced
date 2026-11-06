"""
🔁 XH-帧数对齐（XHFrameAlign）

把「一段要多长」换算成**模型认的帧数**。

── 为什么要这个节点 ──────────────────────────────────────────────
不同视频模型对帧数有各自的硬性要求，不满足会被悄悄裁帧或直接报错，
长视频分段拼接时这就意味着接缝错位：
  · MiniMax H3  → 帧数必须「除以 17 余 5」
      源码：comfy_extras/nodes_minimax_h3.py → `while n % 17 != 5:`
  · LTX 2.5     → 帧数必须是「8 的倍数 + 1」
      源码：comfy_extras/nodes_lt.py 原话 "Must be 8*n + 1 frames.
            If the video is not 8*n + 1 frames, it will be cropped..."
例：5 秒 @ 24fps → H3 要 124 帧（124 = 17×7 + 5），LTX 要 121 帧（121 = 8×15 + 1）。
    而按普通取整只有 120 帧，两个模型都不认。

── 两种用法 ──────────────────────────────────────────────────────
  · 秒 → 帧（本行）：左边填秒数，按规矩算出合法帧数；
  · 帧 → INT 中转（2026-10-21 加）：上游是 🔁XH-分段表（单位=帧）时，
    这里透传的就是帧数 —— 规矩选「不调整（取整就行）」，本节点退化成
    「FLOAT 取整成 INT」的桥（ComfyUI 不许 FLOAT 直插 INT 口，
    如 MiniMaxH3ReferenceToVideo 的 length）。

── 家族铁律遵守情况 ──────────────────────────────────────────────
  · 一个节点只干一件事：只做「秒/帧 → 模型帧数」的换算，不碰视频、不碰分段。
  · 下拉选项写人话（不写模型名、不写数学符号），模型名只进 tooltip。
  · 帧数规则 与 帧率 拆成两个独立框（本来就不是一个东西）。
  · fps 做成普通 widget：既能手填兜底，也能被上游同一个帧率源接线覆盖
    （不写成 forceInput，否则就手填不了了）。
  · seconds / fps 另给 `seconds_link` / `fps_link` 两个**纯输入口**：
    上游能推导的参数不许只让手填（2026-10-21 补，家族铁律）。
    接线优先、手填兜底；两个口都追加在 optional 末尾，老存档位序不动。
"""

# 下拉选项：全部人话，模型名只出现在 tooltip 里
RULE_H3 = "帧数 = 17 的倍数 + 5"
RULE_LTX = "帧数 = 8 的倍数 + 1"
RULE_NONE = "不调整（取整就行）"

_RULES = [RULE_H3, RULE_LTX, RULE_NONE]


class XHFrameAlign:
    """一段的时长（秒，或上游透传的帧数）→ 换算成目标模型认的帧数。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "seconds": ("FLOAT", {
                    "default": 5.0, "min": 0.0, "max": 3600.0, "step": 0.1,
                    "tooltip": (
                        "【🔢 数值】这一段要多长（秒）。\n"
                        "· 填 5 → 下面会按你选的规矩，算出这个模型实际要多少帧\n"
                        "· 例：5 秒 + 24 帧/秒 +「17 的倍数 + 5」→ 124 帧\n"
                        "· 上游接 🔁XH-分段表（单位=帧）时，这里透传的是**帧数** ——\n"
                        "  规矩选「不调整（取整就行）」，本节点就当中转把 FLOAT 取整成 INT\n"
                        "  （ComfyUI 不许 FLOAT 直插 INT 口，比如 H3 采样器的 length）\n"
                        "⚠️ 算出来的帧数换算回秒，通常会比这里填的「多一点」\n"
                        "   （124 帧 ÷ 24 = 5.167 秒）—— 这是模型规矩要求的，不是算错。"
                    ),
                }),
                "rule": (_RULES, {
                    "default": RULE_H3,
                    "tooltip": (
                        "【📐 帧数规矩】不同模型认的帧数不一样，选你用的那个模型对应的规矩。\n"
                        "· 「17 的倍数 + 5」→ MiniMax H3 用这个（H3 官方模板就是这么算的）\n"
                        "· 「8 的倍数 + 1」 → LTX 2.5 用这个（不满足它会自动裁帧，接缝会崩）\n"
                        "· 「不调整」       → 只做普通取整，不套任何规矩\n"
                        "⚠️ 选错规矩：轻则模型悄悄裁掉几帧，重则直接报错。\n"
                        "⚠️ 都是「向上对齐」（宁可多几帧，绝不裁掉你要的内容）。"
                    ),
                }),
                "fps": ("FLOAT", {
                    "default": 24.0, "min": 1.0, "max": 120.0, "step": 1.0,
                    "tooltip": (
                        "【🎞 帧率】每秒几帧（24 = 电影感，25/30 = 常规）。\n"
                        "· 可以手填，也可以从上游同一个帧率源**接线进来**\n"
                        "  （推荐接线：这样整条工作流只有一处帧率，不用两处手动同步）\n"
                        "⚠️ 整条工作流所有段必须用同一个帧率，换帧率 = 段边界整体错位。"
                    ),
                }),
            },
            # 🔴 家族铁律：能从上游推导的参数，必须给输入口，不能只让手填。
            #    这两个口是**纯输入口**（forceInput，不占 widget）——没接线就用左边手填的值，
            #    接了线就以上游为准（手填值被忽略，不是相加、不是二选一提示，是直接覆盖）。
            #    追加在 optional 末尾 ⇒ 不动 required 位序，老工作流一个字符都不会串。
            "optional": {
                # 🔴 2026-10-22 "FLOAT" → "FLOAT,INT"：🔁XH-分段表 的 duration 是 **INT** 输出，
                #    单写 FLOAT 时前端 isValidConnection 精确匹配 + 后端 validate_node_input
                #    集合求交都过不了（{INT}∩{FLOAT}=∅）⇒ tooltip 承诺的「接分段表」连不上。
                #    多类型字符串渲染成端口（本就来就没 widget），INT/FLOAT 上游通吃。
                "seconds_link": ("FLOAT,INT", {
                    "forceInput": True,
                    "tooltip": (
                        "【⏱ 我要几秒 · 接线版】接上游的段长（如 🔁XH-分段表 的 duration）。\n"
                        "· 接了线就以它为准，左边手填的秒数被忽略\n"
                        "· 没接线就还是用手填的那个值（行为完全不变）\n"
                        "· 典型用法：循环里每段长度不一样，手填框不可能跟着变，必须接这里。"
                    ),
                }),
                # 🔴 2026-10-22 同上：帧率源可能是 FLOAT（加载视频的 force_rate）也可能是 INT，
                #    多类型一口通吃，免得用户再去找转换节点。
                "fps_link": ("FLOAT,INT", {
                    "forceInput": True,
                    "tooltip": (
                        "【🎞 帧率 · 接线版】接上游的帧率源（全工作流共用同一个）。\n"
                        "· 接了线就以它为准，左边手填的帧率被忽略\n"
                        "· 整条链只有一处帧率 ⇒ 改一处全链生效，绝不会两处不同步。"
                    ),
                }),
            },
        }

    RETURN_TYPES = ("INT", "FLOAT", "FLOAT", "STRING")
    RETURN_NAMES = ("frame_count", "seconds_actual", "fps", "info")
    FUNCTION = "align"
    CATEGORY = "🔁XH/Video"
    DESCRIPTION = (
        "【干什么】把「一段要多长」（秒；接分段表帧单位时透传帧数）换算成**模型认的帧数**，专治长视频分段拼接的接缝错位。\n"
        "【为什么】不同模型对帧数有硬要求，不满足会被裁帧/报错：\n"
        "· MiniMax H3 → 帧数必须「17 的倍数 + 5」（5 秒 @24fps = 124 帧）\n"
        "· LTX 2.5    → 帧数必须「8 的倍数 + 1」（5 秒 @24fps = 121 帧）\n"
        "· 普通取整只有 120 帧 —— 两个模型都不认。\n"
        "【怎么用】数值填秒数 → rule 选规矩 → frame_count 输出去接：\n"
        "· 🔁XH-加载视频 的「最多帧数」\n"
        "· H3 / LTX 采样器的 length（INT 口）\n"
        "【两种喂法】① 段长固定 → 左边手填秒数；② 段长每段不一样（循环）→\n"
        "  把上游（如 🔁XH-分段表 的 duration）接到 `seconds_link` 口，帧率接 `fps_link`。\n"
        "  接了线就以线为准，手填值被忽略；没接线就还是用手填的。\n"
        "【帧 → INT 中转】上游是分段表（单位=帧）时这里透传帧数，规矩选\n"
        "  「不调整（取整就行）」⇒ 本节点退化成 FLOAT→INT 的桥，不改变数值。\n"
        "【输出】frame_count（该要多少帧）· seconds_actual（换算回是多少秒）· fps（透传）· info（一眼看清）\n"
        "⚠️ 都是向上对齐（宁可多几帧，不裁内容）；实际秒数会比填的略多，属正常。\n"
        "⚠️ 本节点只做换算，不碰视频本身 —— 家族铁律：一个节点只干一件事。"
    )

    def align(self, seconds, rule, fps=24.0, seconds_link=None, fps_link=None):
        # 🔴 接线优先于手填：接了 seconds_link / fps_link 就用上游的值，
        #    没接（None）才回落到左边手填的框。两者不是相加、不是取大，是直接覆盖。
        if seconds_link is not None:
            seconds = seconds_link
        if fps_link is not None:
            fps = fps_link

        try:
            fps_v = float(fps)
        except (TypeError, ValueError):
            fps_v = 24.0
        if fps_v <= 0:
            fps_v = 24.0                      # 兜底：帧率不合法就用 24

        try:
            sec = float(seconds)
        except (TypeError, ValueError):
            sec = 0.0
        if sec < 0:
            sec = 0.0

        # 🔴 取整口径必须与前端一致（web/xh_video_segments.js 的 alignCount）：
        #    Python 内置 round() 是「银行家舍入」（2.5 → 2），JS 的 Math.round 是四舍五入（2.5 → 3）。
        #    两边不一致 ⇒ 信息条显示 124 帧、后端真输出 123 帧，接缝直接崩。
        #    这里统一成「四舍五入」= floor(x + 0.5)（秒数恒为正，与 Math.round 完全等价）。
        n0 = int(sec * fps_v + 0.5)           # 先按普通取整（与前端 Math.round 同口径）

        if rule == RULE_H3:
            # H3：帧数 ≡ 5 (mod 17)，且至少 5 帧。向上对齐。
            n0 = max(5, n0)
            n = n0 + (5 - n0 % 17) % 17
        elif rule == RULE_LTX:
            # LTX：帧数 = 8k + 1，至少 1 帧。向上对齐（(x+6)//8*8+1 == ceil 到 8k+1）。
            n0 = max(1, n0)
            n = ((n0 + 6) // 8) * 8 + 1
        else:
            n = max(1, n0)

        n = max(1, int(n))
        sec_actual = round(n / fps_v, 4)
        info = (
            f"{sec:g} 秒 × {fps_v:g} 帧/秒 = {n0} 帧 → 按「{rule}」对齐 = "
            f"{n} 帧（实际 {sec_actual:g} 秒）"
        )
        return (n, sec_actual, fps_v, info)


NODE_CLASS_MAPPINGS = {"XHFrameAlign": XHFrameAlign}
NODE_DISPLAY_NAME_MAPPINGS = {"XHFrameAlign": "🔁XH-帧数对齐"}
