"""XH-智能遮脸（SAM3 一体化）：一个节点复刻「盖排除区 → SAM3 找剩余脸 → 套形状覆盖」全流程。

★ 2026-10-12 重写：原理完全对齐用户已验证的三节点工作流（SAM3遮脸_XH覆盖_工作流）。
  用户原工作流原理（三个节点）：
    ① XHShapeMaskOverlay(盖红块) → 输出「盖过红块的图」
    ② SAM3_Detect 吃「盖过红块的图」→ 被盖区域 SAM3 找不到脸 → 只在剩余区域找到目标脸
    ③ XHShapeMaskOverlay(image=原图, mask=SAM3的mask, mask_locate=开) → 借 mask 定位套形状
  ★ 关键（旧版做错的地方）：SAM3 必须吃「盖过排除区的图」，不是原图！
    否则 SAM3 会把被排除的大脸也当目标 → 遮成大块。

本节点内部：
  [1] 按 exclude_* 参数 算出排除区，在图上盖一块（用 XHShapeMaskOverlay 同款几何）
  [2] 把「盖好的图」喂给 SAM3_Detect → 拿到目标 mask
  [3] 覆盖：
      · shape == "head"      → 以 SAM3 的脸框为锚点，四向各自按比例外扩成一块矩形
                               （expand_left/right 单位=脸宽，expand_top/bottom 单位=脸高）
      · 其它 shape           → 只借 mask 定位（中心+尺寸×margin）→ 用该形状重画 → 覆盖到原图
  [4] 找不到目标时退化为「在排除区之外画形状」（可关）

★ v1.9.10（2026-10-12）：**紧急修复 v1.9.9 的致命 bug** ——
  `TypeError: XHSmartFaceMask.run() missing 1 required positional argument: 'model'`
  · 根因：v1.9.9 把 `model`/`image` 挪进 INPUT_TYPES 的 optional 后，**忘了给 run() 的形参加默认值**。
    ComfyUI 执行器对「未连接的 optional 输入」是**直接从 kwargs 里省略**（不是传 None），
    所以 `f(**inputs)` 少一个必需位置参数 ⇒ 一拔模型线就必崩（越修越坏）。
  · 修法：**run() 全部 25 个形参一律给默认值**（Python 语法：一旦某个形参带默认值，
    其后所有位置形参都必须带默认值）。顺带让「任何输入缺失」都不再抛 TypeError。
  · 教训（已写进测试脚本）：桩测**必须模拟 ComfyUI 的真实调用行为** ——
    未连接的 optional 键要「从 kwargs 里删掉」，而不是手写 `model=None`。
    v1.9.9 的桩测就是因为在脚本里手动补了 `model=None` 才漏掉这个 bug。
★ v1.9.9（2026-10-12）：新增【手动模式】—— **不接模型也能跑**。
  · `model` 从 required 挪进 optional ⇒ 拔掉 MODEL 线不再爆红；不接 = 自动进手动模式
  · 手动模式 = 直接把「排除区那个拖拽框」当最终遮挡框（拖到哪遮到哪），完全不跑 SAM3
  · 形状由 `shape` 决定（新增 `manual_box` 档；非图形档一律退化成矩形）
  · 颜色照样支持 auto（取色圈随红框往左/右/上扩）⇒ 手遮也能跟背景无痕融合
  · 四个输入口顺序严格保持 model → image → conditioning → clip，**槽位零迁移**
★ v1.9.8（2026-10-12）：新增【内置提示词】—— 可以省掉独立的 CLIPTextEncode 节点。
  用户诉求：「把写提示词那个盒子并进遮脸节点里，整张图少一个方块」（3 节点 → 2 节点），
  并明确要求：「**不填写提示词时也必须正常跑，别爆红**」。
  实现：新增 1 个 widget `prompt`（默认 "face"，加在参数表**最末尾**，保证老工作流 positional 对齐）
        + 1 个可选输入 `clip`(CLIP)。四条分支全部兜住，任何组合都不报错：
          ① 接 CLIP + 框里有字 → 节点内部 clip.tokenize + encode_from_tokens_scheduled → 自己的 conditioning
          ② 接 CLIP + 框是空的 → **自动用 "face"**（这条就是「不填也能跑」的保证）
          ③ 没接 CLIP          → 完全老行为：用外部 conditioning 输入
          ④ 编码抛异常         → 捕获后退回外部 conditioning
  ⚠️ 显存零增长：CLIP 与 MODEL 由同一个 CheckpointLoaderSimple 一次装载好，
     本节点只是把「读提示词」那半边也接过来用，**不额外加载任何模型**。
  ⚠️ 老节点 XHShapeMaskOverlay 零改动；不接 CLIP 的老工作流行为完全不变。

★ v1.9.7（2026-10-12）：auto 取色的【基准脸】可指定 + 外圈彻底降级。两处关键修复：
  ① **基准脸**：新增参数 color_pick_ref（center/largest/union）。
     多脸时原来拿「所有脸的并集外接框」去取色 —— 元婴1 实测两张脸一左一右，
     并集框 525×512，再按 左0.5/右0.5/上0.9 外扩直接顶出画面 ⇒ 取色区变成「左上大半张图」，
     取到的根本不是「哪张脸周围」的颜色。现在默认 center = **最靠画面中央的那张脸**
     （三视图 = 中间那个人），只围着他往外扩；其余脸框一并挖掉，免得圈里混进别人。
     实现：_runs / _split_boxes（x 或 y 投影切分，纯 torch 零依赖）/ _pick_color_box / _other_face_boxes。
  ② **外圈降级（修 bug）**：v1.9.6 的择优条件写成了 `r_ring >= 0.15 and r_ring >= r_edge`，
     等于「脸圈还必须比外圈更纯」。纯色背景图的外圈几乎 100% 同色，脸圈永远比不过
     ⇒ 外圈偷偷变成主路径（用户原话「你为什么老想着整个图片的边缘」）。
     现在：脸圈占比 ≥15% 就认脸圈，外圈只在脸圈花到没有统一色时才轮到。
  ⚠️ 只改「取哪儿」，不影响「遮住哪些脸」——遮罩仍按并集走，一张不少。
  ⚠️ 另：遮罩/取色分离后，形状档(圆/方…)的取色也走基准脸，但形状本身仍套并集框（行为不变）。

★ v1.9.6（2026-10-12）：auto 取色改成【小脸左/右/上外扩一圈】为主，图像最外圈降为后路。
  用户诉求：「取色应该以脸为中心，往左/右/上扩多少就取哪儿的色 —— 别老拿整张图的边缘说事；
  下面（脖子）不要，脖子以下是脖子和衣服的颜色」。三级策略：
    ① 主取：以 SAM3 脸框为锚，向左扩 expand_left 个脸宽、向右扩 expand_right 个脸宽、
       向上扩 expand_top 个脸高，**下边一步不往下（就停在下巴）**，挖掉脸本身 ⇒
       取这圈里出现最多的颜色。圈的远近由 expand_* 决定 ⇒ **取色位置完全可控**。
    ② 后路：只有①这圈众数占比 < 15%（或还不如最外圈统一）时，才回头看图像最外圈（5% 宽带）。
    ③ 都不行：脸圈均值 → 默认灰白。
  实测：大婚婉儿（人占满画面）上扩 0→#554C42、0.9→#463D34，参数确实在控制取色位置；
        元婴1（白底）无论怎么扩都是 #F4F3F2（脸周围本来就是白背景）。
  零新增参数（复用 head 档就有的 expand_left/right/top）。

★ v1.9.5（2026-10-12）：把 "head" 从「铺满整幅图宽 + 从图顶切下来」改成
  【脸框四向外扩】—— 上一版太狠，会把上半张图整块遮掉。
  用户诉求：「以 SAM3 定位框为中心，手动控制向左扩多少、向右扩多少、向上扩多少、向下不扩」。
  现在四条边各自一个参数：expand_left / expand_right（单位=脸宽）、
  expand_top / expand_bottom（单位=脸高）；中心不动，clamp 在图像内；
  下扩默认 0 ⇒ 刚好停在下巴，不啃脖子和衣服。
  颜色不再强制背景色：走 shape_color（填 auto 就跟背景融合，符合「终极目标」）。

★ v1.9.4（2026-10-12）：新增 shape 选项 "head"（初版：脖子以上整块 + 背景融合）。
★ v1.9.1（2026-10-12）：新增 shape 选项 "sam_mask"（SAM 原始遮罩）并设为默认。
  老工作流那种「加 face 提示词就只遮脸、头发不碰」的原始遮罩能力，现在回来了。

★ v1.9.3（2026-10-12）：auto 取色升级为「背景探测」。
  用户实测反馈：v1.9.2 的 auto 只取「脸框外扩 30% 环带」的均值，三视图里脸周围全是头发和
  衣服 ⇒ 取到的色偏成「衣服色」，和真背景差得远。
  现在改成两级策略：
    ① 先看「图像四周 5% 宽边缘带」的颜色众数（每通道量化到 16 级找最大桶）：
       纯色背景（三视图 / 白底写真）里边缘带绝大多数像素就是背景本身 ⇒ 众数色 ≈ 真背景色；
       众数占比 ≥ 15% 就认定它是背景，直接用它。
    ② 边缘不够纯（背景复杂 / 大面积渐变）时，才退回原来的环带均值。
  实测：大婚婉儿.png（暗调背景 + 红婚服，主色全是棕黑）→ 取 #453D35 ≈ 画面环境色；
        元婴1.png → 与真背景差 3.5（旧算法差 39.5）。

★ v1.9.2（2026-10-12）：三处配色优化。
  ① exclude_color 默认 #D64541 → #000000（纯黑）。黑=排除惯例；黑白都能排除，
     它只是「涂在图上的一块颜料」（靠和周围反差起作用），不是 mask 的 0/1。
     只有原图本身大面积暗色时才建议换白。
  ② shape_color 默认 #D64541 → #C8C8C8（灰白，与老节点 XHShapeMaskOverlay 的「形状色」默认一致）。
  ③ shape_color 支持 "auto"：自动取「脸框外扩 30% 的环带」像素平均色 ⇒ 跟着人物周围背景/头发走。
     纯 torch 均值统计，**不需要任何额外模型**；会自动挖掉排除区，避免被排除色污染。

★ v1.9.0（2026-10-12）：排除区参数从「像素」改成「比例 0~1」。
  旧版 exclude_x/y/w/h 是像素，在 3840×2161 上调好的 -44/-1/1500/1496，
  换到 1536×1024 就变成盖住 97.6%×100%（整张图）→ SAM3 找不到脸 → 什么都不遮。
  现在改成 exclude_cx/cy（中心占比）+ exclude_w/h（宽高占比），换任何尺寸自动换算。
  默认值 = 老工作流像素参数在 3840×2161 上的等价比例（cx .190 / cy .346 / w .379 / h .692）。
  前端配可视化拖拽编辑器（复用 XHBBoxRegion 那套 xhBox_setup，绑 exclude_* 四个 widget）。

零外部依赖：只用 torch / numpy / PIL（ComfyUI 自带）。
老节点 XHShapeMaskOverlay 一个字不改，本节点只读它的几何方法（延迟 import 避免循环依赖）。
"""

import torch
import numpy as np

# ★ v1.9.16（2026-10-12）：提示词「全角 → 半角」静默归一化。
#   起因（真机实测）：SAM3 的 `词:N` 语法只认 ASCII 半角冒号 ——
#   解析正则来自 comfy/text_encoders/sam3_clip.py：r'^(.+?)\s*:\s*([\d.]+)\s*$'，里面的 `:` 是 U+003A。
#   中文输入法的全角 `：`(U+FF1A) 完全不匹配 ⇒ 整串 "face：2" 被当成一个词条文本、max_det 回退 1
#   ⇒ 用户以为写了 face:2，实际只遮 1 张脸（且区域还有漂移）。
#   这里在编码前悄悄把全角标点/数字/字母换成半角，用户不必管输入法。
#   只动「全角 ASCII 形态」的字符，汉字一律不碰 ⇒ 写「人脸」「person」都安全。
_FULL2HALF = str.maketrans({
    "\uff1a": ":",   # ： 全角冒号    ← 最关键的一个
    "\uff0c": ",",   # ， 全角逗号    ← 分概念也靠它
    "\uff08": "(",   # （ 全角左括号
    "\uff09": ")",   # ） 全角右括号
    "\uff1b": ";",   # ； 全角分号
    "\uff01": "!",   # ！ 全角叹号
    "\uff1f": "?",   # ？ 全角问号
    "\u3000": " ",   # 　 全角空格
    **{chr(0xFF10 + i): chr(0x30 + i) for i in range(10)},   # ０-９
    **{chr(0xFF21 + i): chr(0x41 + i) for i in range(26)},   # Ａ-Ｚ
    **{chr(0xFF41 + i): chr(0x61 + i) for i in range(26)},   # ａ-ｚ
})


def _normalize_prompt(text):
    """把提示词里的全角标点/数字/字母静默换成半角（中文输入法最容易踩的坑）。"""
    if not text:
        return text
    return str(text).translate(_FULL2HALF)


def _hex_to_rgb01(color):
    """#RRGGBB → (r,g,b) 0~1，容错 3 位简写 / 无 #。"""
    hexs = (color or "#FFFFFF").lstrip("#").strip()
    if len(hexs) == 3:
        hexs = "".join(c * 2 for c in hexs)
    hexs = (hexs + "000000")[:6]
    try:
        return (int(hexs[0:2], 16) / 255.0, int(hexs[2:4], 16) / 255.0, int(hexs[4:6], 16) / 255.0)
    except Exception:
        return (1.0, 1.0, 1.0)


class XHSmartFaceMask:
    """🧩XH-智能遮脸：复刻「盖排除区 → SAM3 找脸 → 套形状」，一个节点闭环。

    省掉老工作流里的两个 XHShapeMaskOverlay，但原理与效果完全一致。
    """

    # 形状：sam_mask（SAM 原始遮罩，不套形状）+ 与 XHShapeMaskOverlay 完全一致的 10 种形状
    # ★ v1.9.1：新增 "sam_mask" 并设为默认 —— 直接把 SAM3 吐出来的 mask 盖回原图，
    #   只遮它认出来的目标（加 face 提示词就只遮脸、不碰头发），不被任何形状改写。
    # ★ v1.9.5：把 "head" 从「铺满整幅图宽 + 从图顶切下来」（太狠，会把上半张图全遮掉）
    #   改成一【脸框四向外扩】：锚点 = SAM3 的目标框（脸框），中心不动，四个方向各自扩：
    #     左 expand_left / 右 expand_right → 单位是「脸宽」的倍数
    #     上 expand_top  / 下 expand_bottom → 单位是「脸高」的倍数
    #   下扩默认 0 ⇒ 只到下巴，不会啃脖子和衣服。
    #   涂色走 shape_color（填 auto 就跟背景融合），所以「遮多出的部分」落在背景上=没涂。
    # ★ v1.9.9：新增 manual_box =「手动框(不用模型)」。
    #   不接模型时自动进手动模式；也可显式选它（即使接了模型也走手动、不跑 SAM3）。
    #   手动模式下：位置/大小 = 「排除区那个拖拽框」，形状 = shape（矩形/圆/椭圆…），颜色 = 遮挡色。
    SHAPES = ["sam_mask", "head", "manual_box", "circle", "square", "rectangle", "semicircle",
              "quarter_circle", "ellipse", "triangle", "cross", "star", "radial"]

    # 手动模式里可以真正画出来的形状（其余档位一律退化成矩形）
    _RENDER_SHAPES = ("rectangle", "circle", "square", "ellipse", "semicircle",
                      "quarter_circle", "triangle", "cross", "star", "radial")

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "shape": (cls.SHAPES, {
                    "default": "sam_mask",
                    "tooltip": "【🔷 遮脸形状】sam_mask=直接用 SAM3 原始遮罩（只遮它认出的目标，加 face 提示词就只遮脸、头发不碰，不受形状影响）★推荐；"
                               "head=「小脸以上(四向外扩)」——以 SAM3 找到的【脸框】为锚点，中心不动，"
                               "用 expand_left / expand_right（单位=脸宽）和 expand_top / expand_bottom（单位=脸高）"
                               "四个方向各自决定往外扩多少（下扩默认 0 = 只到下巴、不啃脖子和衣服）。"
                               "这个模式不套任何形状，出来的是一块矩形；下扩填 0 再配合 expand_top 调大就能做到「小脸 + 小脸以上」；"
                               "circle/square/rectangle/…=只借 mask 定位中心与大小，再用该形状盖上去。"
                               " | English: sam_mask = raw SAM3 mask; head = a rectangle anchored on the detected face box, expanded independently by expand_left/right (x face width) and expand_top/bottom (x face height); others = locate by mask then draw that shape.",
                }),
                # ------- 排除区（对应老工作流节点28：先把不要找脸的区域盖住）-------
                # 🔴 v1.9.0：全部改成「占整张图的比例 0~1」——换任何尺寸的图都不用重调（旧版是像素，换图就废）。
                "exclude_enable": ("BOOLEAN", {
                    "default": True, "label_on": "开(先盖排除区再找脸)", "label_off": "关(全图找脸)",
                    "tooltip": "【🚫 启用排除区】开=先盖住排除区，SAM3 只在其外找脸（治多脸误检）；关=不盖，SAM3 全图找。 | English: enable the exclusion block before SAM3 detection.",
                }),
                "exclude_cx": ("FLOAT", {
                    "default": 0.19, "min": 0.0, "max": 1.0, "step": 0.001,
                    "tooltip": "【🚫 排除区中心X(占比)】排除块的中心横向位置，0=最左 1=最右。⚠️ 是「比例」不是像素 → 换任何尺寸的图都不用重调。 | English: exclusion block center X as a 0~1 ratio of image width.",
                }),
                "exclude_cy": ("FLOAT", {
                    "default": 0.346, "min": 0.0, "max": 1.0, "step": 0.001,
                    "tooltip": "【🚫 排除区中心Y(占比)】排除块的中心纵向位置，0=最上 1=最下。 | English: exclusion block center Y as a 0~1 ratio of image height.",
                }),
                "exclude_w": ("FLOAT", {
                    "default": 0.379, "min": 0.001, "max": 1.0, "step": 0.001,
                    "tooltip": "【🚫 排除区宽(占比)】排除块宽度占整张图宽的比例。 | English: exclusion block width as a 0~1 ratio.",
                }),
                "exclude_h": ("FLOAT", {
                    "default": 0.692, "min": 0.001, "max": 1.0, "step": 0.001,
                    "tooltip": "【🚫 排除区高(占比)】排除块高度占整张图高的比例。 | English: exclusion block height as a 0~1 ratio.",
                }),
                "exclude_color": ("STRING", {
                    "default": "#000000",
                    "tooltip": "【🎨 排除块颜色（默认纯黑）】往排除区盖的那块色。作用：把这块「抹平」，让 SAM3 在那儿认不出东西，所以它才不会把排除区里的脸也逮住。"
                               "⚠️ 它只喂给 SAM3 看，绝不出现在最终输出里（输出永远用原图）。"
                               "黑/白都能排除（这不是 mask 的 0/1，而是涂在图上的颜料，靠「和周围反差」起作用），"
                               "惯例黑=排除；只有当原图本身大面积是暗色（暗夜/黑衣）时才建议换成白色。"
                               " | English: color painted over the excluded area — fed to SAM3 only, never in the final output. Default pure black (black = exclusion convention).",
                }),
                # ------- SAM3 -------
                "threshold": ("FLOAT", {
                    "default": 0.5, "min": 0.0, "max": 1.0, "step": 0.01,
                    "tooltip": "【🎯 检测阈值】SAM3 置信度阈值。 | English: detection confidence threshold.",
                }),
                # ------- 最终形状覆盖（对应老工作流节点29 mask_locate 分支）-------
                "shape_scale": ("FLOAT", {
                    "default": 1.0, "min": 0.1, "max": 10.0, "step": 0.1,
                    "tooltip": "【🔍 形状缩放】在「人脸框 × 外扩」基础上再乘的倍数（同老节点 scale）。 | English: extra scale on the shape.",
                }),
                "mask_margin": ("INT", {
                    "default": 15, "min": 0, "max": 200, "step": 1,
                    "tooltip": "【📏 定位外扩%（对称·四方向时不用它）】「定位外扩」= 拿 SAM3 找到的人脸框当基准，"
                               "让形状比这个框再往外大一圈，让它盖住整张脸（含边缘）。这里的百分比是"
                               "【四个方向一起以外扩】，15 = 四周各多出 15%。"
                               "⚠️ 只有 circle/square/矩形… 这些「套形状」的档用它；"
                               "要用「只往上扩、往下不扩」这种精细控制，请把 shape 选成 head（小脸以上），改用 expand_left/right/top/bottom。"
                               " | English: symmetric margin % over the detected box (same as the old node). Shape modes only — use shape=head for per-direction control.",
                }),
                "shape_color": ("STRING", {
                    "default": "#C8C8C8",
                    "tooltip": "【🎨 遮挡色（默认灰白 #C8C8C8）】最终盖在脸上的颜色。前端色板上直接点选；"
                               "填 auto（或点色板旁「自动」按钮）= 自动探测背景色 —— ★v1.9.6 主取「小脸左/右/上外扩一圈」里"
                               "出现最多的颜色（**下方一步不往下**，因为下面全是脖子衣服）；这圈靠「左扩/右扩/上扩」调远近，"
                               "调大就把取色位置往背景上推。只有这圈算不出统一点的颜色时，才回头看一眼图像最外圈。"
                               "纯像素统计，不需要任何额外模型 / 不需要抠图模型。"
                               " | English: final overlay color. \"auto\" samples the ring expanded LEFT/RIGHT/TOP from the face box "
                               "(never downward) and takes its dominant color; control how far it reaches with expand_left/right/top. "
                               "Image edge band is only a fallback. No extra model needed.",
                }),
                "opacity": ("FLOAT", {
                    "default": 1.0, "min": 0.0, "max": 1.0, "step": 0.05,
                    "tooltip": "【◐ 不透明度】遮挡色不透明度。 | English: overlay opacity.",
                }),
                "blur_radius": ("INT", {
                    "default": 0, "min": 0, "max": 1000, "step": 1,
                    "tooltip": "【🌫️ 模糊半径】形状边缘高斯模糊（px），0=硬边。 | English: gaussian blur radius of the shape edge.",
                }),
                "rotation": ("INT", {
                    "default": 0, "min": 0, "max": 360, "step": 1,
                    "tooltip": "【🔄 旋转】形状绕自身中心旋转角度。 | English: shape rotation in degrees.",
                }),
                "invert": ("BOOLEAN", {
                    "default": False, "label_on": "反转(形状外填充)", "label_off": "正常(形状内填充)",
                    "tooltip": "【🔃 反转】False=遮住形状内（常规）；True=填充形状外。 | English: invert the shape fill.",
                }),
                "fallback_draw": ("BOOLEAN", {
                    "default": False,
                    "tooltip": "【🛟 兜底】SAM3 没找到脸时：开=在排除区之外画形状；关=原图原样输出（更安全，推荐关）。 | English: fallback draw when no target found.",
                }),
                "refine_iterations": ("INT", {
                    "default": 2, "min": 0, "max": 5, "step": 1,
                    "tooltip": "【✨ 细化次数】SAM 解码器细化轮数。 | English: SAM decoder refinement passes.",
                }),
                # ------- ★ v1.9.5：head（小脸以上）模式的「四向外扩」-------
                #   锚点 = SAM3 找到的脸框，中心不动，四条边各自往外挪：
                #   左/右 用「脸宽」倍数，上/下 用「脸高」倍数。下扩填 0 = 只到下巴。
                "expand_left": ("FLOAT", {
                    "default": 0.50, "min": -0.5, "max": 3.0, "step": 0.05,
                    "tooltip": "【⬅ 左扩(脸宽倍)】shape=head 时用：遮罩左边界从脸框左边再往左扩多少「脸宽」。"
                               "0.5 = 往左扩半个脸宽；0 = 就停在脸框左边；负值 = 往内收。 | English: head mode — expand mask's left edge by N x face width (0 = none, negative = shrink inward).",
                }),
                "expand_right": ("FLOAT", {
                    "default": 0.50, "min": -0.5, "max": 3.0, "step": 0.05,
                    "tooltip": "【➡ 右扩(脸宽倍)】shape=head 时用：遮罩右边界从脸框右边再往右扩多少「脸宽」。 | English: head mode — expand mask's right edge by N x face width.",
                }),
                "expand_top": ("FLOAT", {
                    "default": 0.90, "min": -0.5, "max": 3.0, "step": 0.05,
                    "tooltip": "【⬆ 上扩(脸高倍)】shape=head 时用：遮罩上边界从脸框上边再往上扩多少「脸高」。"
                               "0.9 ≈ 往上盖到头顶/发顶；想只遮到额头就调小。 | English: head mode — expand mask's top edge by N x face height (0.9 ≈ up to the top of the head).",
                }),
                "expand_bottom": ("FLOAT", {
                    "default": 0.00, "min": -0.5, "max": 3.0, "step": 0.05,
                    "tooltip": "【⬇ 下扩(脸高倍)】shape=head 时用：遮罩下边界从脸框下边再往下扩多少「脸高」。"
                               "默认 0 = 刚好停在下巴，不会啃到脖子和衣服。 | English: head mode — expand mask's bottom edge by N x face height (default 0 = stop at the chin).",
                }),
                # ------- ★ v1.9.7：auto 取色的「基准脸」-------
                #   多脸时，以哪张脸为中心往外扩一圈去取色（不再用两张脸的并集大框）。
                "color_pick_ref": (["center", "largest", "union"], {
                    "default": "center",
                    "tooltip": "【🎯 取色基准脸】遮挡色选 auto 时，以「哪张脸」为中心往左/右/上扩一圈取色："
                               "center = 最靠画面中央的那张脸（默认，三视图就取中间那个人）；"
                               "largest = 面积最大的那张脸（特写占主导的构图）；"
                               "union = 所有脸的并集外接框（v1.9.6 及以前的旧行为）。"
                               "⚠️ 它只管「取哪儿的颜色」，不影响「遮住哪些脸」。"
                               " | English: which face the auto color-picker anchors on — center (default) / largest / union (legacy).",
                }),
                # ------- ★ v1.9.8：可选的「内置提示词」-------
                #   接了 CLIP 线 + 在这儿写字 ⇒ 节点自己编码，不用再挂 CLIPTextEncode 节点（省一个方块）。
                #   三种情况都绝不报错：
                #     ① 接了 CLIP、框里有字     → 用框里的字
                #     ② 接了 CLIP、框是空的     → 自动用 "face"
                #     ③ 没接 CLIP              → 完全按老样子，用外部的 conditioning 输入
                "prompt": ("STRING", {
                    "default": "face",
                    "multiline": False,
                    "tooltip": "【💬 提示词（内置）】直接在这儿写字：face / face:2 / person …"
                               "★多目标要几个就写 face:N（N=最多遮几张脸，N 可换 hand / person 等）。"
                               "★中文输入法打出的全角「：，（）」会**自动转成半角**，放心打。"
                               "⚠️ 需要把「读提示词」那根 CLIP 线接到本节点上才生效。"
                               "留空 = 自动用 face（绝不会报错）；CLIP 没接 = 照旧用外部 conditioning，本框忽略。"
                               " | English: built-in text prompt. e.g. face:2 = up to 2 faces. Full-width CJK punctuation is auto-converted to ASCII. "
                               "Needs the CLIP input wired in. Empty = falls back to \"face\". No CLIP = external conditioning is used as before.",
                }),
            },
            # ★ v1.9.9：model / image 从 required 挪进 optional（**不接模型也能跑**的前提）。
            #   ⇒ 四个输入口在节点上的槽位顺序 = 本字典的插入顺序（Python 字典保序）。
            # ★ v1.9.12：按用户要求调整显示顺序（原来 model → image → conditioning → clip）：
            #   「CLIP 排第二、图片排第四」⇒ 现为 model → clip → conditioning → image。
            #   ⚠️ 槽位号变了，老工作流若按位置接会有错位风险（新前端按 name 匹配，通常无碍）。
            "optional": {
                "model": ("MODEL", {
                    "tooltip": "【🧠 SAM3 模型（可选）】接入 SAM3 模型（CheckpointLoaderSimple 输出）。"
                               "★ v1.9.9：**不接也能跑** —— 不接 = 自动进「手动模式」，"
                               "直接用下面那个红框当遮挡框（拖到哪遮到哪），不跑 SAM3、不报错。"
                               " | English: optional SAM3 model. Leave it unwired to use manual mode (the red box becomes the overlay).",
                }),
                "clip": ("CLIP", {
                    "tooltip": "【🔤 CLIP（可选）】接上它，上面的「提示词」框才会生效（CheckpointLoaderSimple 的 CLIP 输出）。"
                               "不接 = 一切照旧，用 conditioning 输入。 | English: optional CLIP — enables the built-in prompt field above.",
                }),
                "conditioning": ("CONDITIONING", {
                    "tooltip": "【💬 文字提示（接线）】可选，如 'face'（CLIPTextEncode 输出）。"
                               "★v1.9.8：若已接 CLIP 且用了内置提示词，这个输入会被忽略。"
                               " | English: optional text prompt conditioning (ignored when CLIP + built-in prompt are in use).",
                }),
                "image": ("IMAGE", {
                    "tooltip": "【🖼️ 原图】要遮脸的图（喂干净原图）。 | English: clean source image.",
                }),
            },
        }

    RETURN_TYPES = ("IMAGE", "MASK", "BOUNDING_BOX")
    RETURN_NAMES = ("image", "mask", "face_box")
    FUNCTION = "run"
    CATEGORY = "🔁XH/工具"
    OUTPUT_NODE = False
    DESCRIPTION = ("【🧩XH-智能遮脸】一个节点复刻「盖排除区 → SAM3 找剩余脸 → 覆盖」全流程——"
                   "原理与「XHShapeMaskOverlay + SAM3_Detect + XHShapeMaskOverlay」三节点完全相同，但省掉两个覆盖节点。"
                   "🔴 关键：SAM3 吃的是「盖过排除区的图」，所以它不会在排除区找脸（治多脸误检）。"
                   "🟢 排除区用「占比 0~1」参数（不是像素），换任何尺寸的图都不用重调；节点内还带可视化拖拽框编辑器。"
                   "🟢 形状默认 sam_mask = 直接用 SAM3 原始遮罩（加 face 提示词就只遮脸、头发不碰）；"
                   "也可切换成圆/方/矩形等 10 种形状（只借 mask 定位，再套形状覆盖）。"
                   "🟢 遮挡色 / 排除块色在节点工具条上是两个可视化色板，点开即选，不用手敲 hex。"
                   "🟢 v1.9.2：排除块色默认改纯黑（黑=排除惯例）；遮挡色默认改灰白 #C8C8C8；"
                   "遮挡色支持 auto —— 自动跟背景走，纯像素统计、零额外模型。"
                   "🟢 v1.9.3：auto 升级为「背景探测」—— 优先取图像四周边缘带的颜色众数（纯色背景命中率极高），"
                   "边缘不够纯才退回脸框环带均值。三视图这类脸周围全是头发衣服的图，现在也能取准背景色。"
                   "🟢 v1.9.4/v1.9.5：shape 新增 head =「小脸以上(四向外扩)」——"
                   "以 SAM3 找到的脸框为锚点，左/右(单位=脸宽)、上/下(单位=脸高)四个方向各自扩多少，"
                   "中心不动、下扩默认 0 只到下巴；涂背景色（auto）就能做到「小脸以上全部隐形」。"
                   "🟢 v1.9.6/v1.9.7：auto 取色 = 以「基准脸」为中心往左/右/上扩一圈去取色，"
                   "下面（下巴以下）一步不往下，绝不碰脖子和衣服；"
                   "基准脸由 color_pick_ref 决定（默认「最靠中间的脸」，多脸时也不会再拿并集大框去取色），"
                   "其他脸一并挖掉；图像最外圈只在脸圈花到没有统一色时才当兜底。"
                   "🟢 v1.9.8：新增「内置提示词」——把 CLIP 线接到本节点，就能直接在节点上写 face / face:2，"
                   "省掉独立的 CLIPTextEncode 节点（3 个方块变 2 个）。框留空自动用 face，没接 CLIP 则照旧走 conditioning 输入，"
                   "任何组合都不会报错；CLIP 与 MODEL 由同一个 CheckpointLoader 装载，不额外吃显存。"
                   "🟢 v1.9.9：新增【手动模式】——**不接模型也能跑**。MODEL 口变成可选，拔掉它不会爆红；"
                   "不接模型（或把 shape 选成 manual_box）时，节点直接把那个可拖拽的框当【最终遮挡框】用："
                   "拖到哪就遮到哪，不跑 SAM3、不吃显存、不报错；形状由 shape 决定（矩形/圆/椭圆…），"
                   "遮挡色照样支持 auto 跟背景融合。"
                   "老节点零改动。零外部依赖。")

    # ---------------- 内部：借用老节点几何（延迟 import 防循环依赖）----------------

    @classmethod
    def _get_overlay_geom(cls):
        """拿到 XHShapeMaskOverlay 的渲染几何（不复制代码，直接用同包老节点的方法）。"""
        from . import XHShapeMaskOverlay as _O
        return _O

    @classmethod
    def _block_image(cls, image, exclude_cx, exclude_cy, exclude_w, exclude_h, exclude_color):
        """按排除区「比例参数」在图上盖一整块矩形 → 返回「盖过的图」（只喂 SAM3 用）。

        🔴 v1.9.0：参数是 0~1 比例（中心 + 宽高），内部 × 当前图尺寸换算出像素矩形
        ⇒ 同一组参数在 3840×2161 / 1536×1024 / 任何尺寸上都盖住「同一个相对位置」。
        """
        import numpy as np
        B, H, W, C = image.shape
        rgb = _hex_to_rgb01(exclude_color)
        solid = torch.tensor([rgb[0], rgb[1], rgb[2]], dtype=image.dtype, device=image.device)
        m = torch.zeros(H, W, dtype=image.dtype, device=image.device)

        # 比例 → 像素（中心 + 半宽/半高）
        cx = int(round(float(exclude_cx) * W))
        cy = int(round(float(exclude_cy) * H))
        hw = max(1, int(round(float(exclude_w) * W / 2.0)))
        hh = max(1, int(round(float(exclude_h) * H / 2.0)))
        x0 = max(0, cx - hw); x1 = min(W, cx + hw)
        y0 = max(0, cy - hh); y1 = min(H, cy + hh)
        if x1 > x0 and y1 > y0:
            m[y0:y1, x0:x1] = 1.0

        m3 = m.unsqueeze(-1).expand(H, W, 3)
        blocked = (image * (1.0 - m3) + solid.view(1, 1, 3) * m3).clamp(0, 1)
        # ★ v1.9.2：顺便把排除区像素框吐出来 —— 自动取色时要「挖掉」这块，免得被排除色污染
        block_box = (x0, y0, x1, y1) if (x1 > x0 and y1 > y0) else None
        return blocked, m, block_box

    # ---------------- v1.9.2 新增：自动遮挡色（跟背景走，零额外模型）----------------

    @staticmethod
    def _is_auto(shape_color):
        """遮挡色是否走「自动跟背景」。支持填 auto / 自动 / AUTO。"""
        return str(shape_color or "").strip().lower() in ("auto", "自动")

    @staticmethod
    def _auto_overlay_rgb(image_hwc, box, block_box=None,
                          expand_l=0.50, expand_r=0.50, expand_t=0.90,
                          extra_void_boxes=None):
        """自动遮挡色（★ v1.9.6：改成「小脸左/右/上外扩一圈」为主）：
        ① **主取「小脸周围一圈」** —— 以 SAM3 脸框为中心，向左扩 expand_l 个脸宽、
           向右扩 expand_r 个脸宽、向上扩 expand_t 个脸高；**下边一步不往下**
           （就停在下巴 —— 下面全是脖子和衣服，往下取必翻车）。再把脸框本身挖掉
           ⇒ 剩下「上 + 左 + 右」那一圈。取样用的是**原图**，所以这圈挪到哪儿就取哪儿的色：
           用户把 expand_* 调大，这圈自然往外走到背景上 ⇒ **取色位置完全可控**，不再是个黑盒。
        ② **后路：图像最外圈** —— 只在上面这圈实在算不出一个统一点的颜色
           （众数占比 < 15%）时才回头看整图最外圈（上下左右各 5% 宽）。
           它本质是「猜画面边缘 = 背景」（v1.9.3 为救三视图加的那版），
           人占满画面时会猜错 ⇒ 只当兜底、绝不当主角。
        ③ 都算不出 → 脸圈均值 → 默认灰白。
        纯统计、**零额外模型**。自动挖掉排除区（我们涂上去的色块）。
        """
        H, W, _ = image_hwc.shape
        gray = (0.78, 0.78, 0.78)     # 取不到时的兜底（默认灰白）

        # 合法区 = 整图 − 排除区
        ok = torch.ones((H, W), dtype=torch.bool, device=image_hwc.device)
        if block_box is not None:
            _bx0 = max(0, int(block_box[0])); _by0 = max(0, int(block_box[1]))
            _bx1 = min(W, int(block_box[2])); _by1 = min(H, int(block_box[3]))
            if _bx1 > _bx0 and _by1 > _by0:
                ok[_by0:_by1, _bx0:_bx1] = False

        def _mode_color(sel):
            """选区 → (出现最多的颜色, 它占的比例)。每通道量化 16 级找最大桶；样本 < 128 或空选返回 (None, 0)。"""
            if sel is None or not bool(sel.any()):
                return None, 0.0
            px = image_hwc[sel].reshape(-1, 3)
            if px.shape[0] < 128:
                return None, 0.0
            arr = (px.detach().float().cpu().numpy() * 255.0).clip(0, 255).astype(np.int32)
            q = arr >> 4                                          # 每通道 16 级（桶宽 16）
            key = (q[:, 0] << 8) | (q[:, 1] << 4) | q[:, 2]
            uniq, counts = np.unique(key, return_counts=True)
            top = uniq[int(np.argmax(counts))]
            ratio = float(counts.max()) / float(key.shape[0])
            sel_px = arr[key == top]
            m = sel_px.mean(axis=0) / 255.0
            return (float(m[0]), float(m[1]), float(m[2])), ratio

        # ---------- ① 主取：小脸「左 / 右 / 上」外扩一圈（★ 下方不外扩）----------
        ring_sel = None
        if box is not None:
            x0, y0, x1, y1 = box
            fw = max(1, int(x1 - x0)); fh = max(1, int(y1 - y0))
            rx0 = max(0, int(x0 - fw * float(expand_l)))
            rx1 = min(W, int(x1 + fw * float(expand_r)))
            ry0 = max(0, int(y0 - fh * float(expand_t)))
            ry1 = min(H, int(y1))                                  # ★ 下边不外扩：停在下巴
            if rx1 > rx0 and ry1 > ry0:
                ring = torch.zeros((H, W), dtype=torch.bool, device=image_hwc.device)
                ring[ry0:ry1, rx0:rx1] = True
                ix0 = max(0, int(x0)); iy0 = max(0, int(y0))
                ix1 = max(ix0, min(W, int(x1))); iy1 = max(iy0, min(H, int(y1)))
                if ix1 > ix0 and iy1 > iy0:
                    ring[iy0:iy1, ix0:ix1] = False                 # 挖掉脸本身
                for (_ox0, _oy0, _ox1, _oy1) in (extra_void_boxes or []):
                    _jx0 = max(0, int(_ox0)); _jy0 = max(0, int(_oy0))
                    _jx1 = max(_jx0, min(W, int(_ox1))); _jy1 = max(_jy0, min(H, int(_oy1)))
                    if _jx1 > _jx0 and _jy1 > _jy0:
                        ring[_jy0:_jy1, _jx0:_jx1] = False         # ★ v1.9.7 其他脸也挖掉
                ring_sel = ring & ok
        c_ring, r_ring = _mode_color(ring_sel)

        # ---------- ② 后路：图像最外圈 ----------
        bw = max(4, int(min(H, W) * 0.05))
        edge = torch.zeros((H, W), dtype=torch.bool, device=image_hwc.device)
        edge[:bw, :] = True
        edge[H - bw:, :] = True
        edge[:, :bw] = True
        edge[:, W - bw:] = True
        c_edge, r_edge = _mode_color(edge & ok)

        # ---------- ③ 择优：脸圈说了算 ----------
        # ★ v1.9.7 修：原来写的是 `r_ring >= 0.15 and r_ring >= r_edge`，
        #   等于「脸圈还必须比外圈更纯」——纯色背景图的外圈几乎 100% 同色，脸圈永远比不过它
        #   ⇒ 外圈偷偷变成主路径（用户原话「你为什么老想着整个图片的边缘」）。
        #   现在改成：只要脸圈占比 ≥15% 就认脸圈；外圈只在脸圈实在花到没有统一色时才轮到。
        if c_ring is not None and r_ring >= 0.15:
            return c_ring                                          # ★ 主路径：脸圈说了算
        if c_edge is not None and r_edge >= 0.15:
            return c_edge                                          # 后路：脸圈太花才轮到他
        if c_ring is not None:
            return c_ring

        # ---------- ④ 最后退路：脸圈均值 → 灰 ----------
        # 用「均值」而不是逐通道中位数：语义上就是「这圈的平均颜色」；
        # 逐通道中位数会因各通道分布不同而偏色（实测偏暗红棕），均值得中性色、更准。
        if ring_sel is not None and bool(ring_sel.any()):
            px = image_hwc[ring_sel].reshape(-1, 3)
            if px.shape[0] > 0:
                avg = px.float().mean(dim=0)
                return (float(avg[0]), float(avg[1]), float(avg[2]))
        return gray

    @classmethod
    def _render_shape(cls, shape, cx, cy, bw, bh, W, H, rgb01, alpha, blur, rotation):
        """复用老节点 _render：返回 (shape_rgb float[H,W,3] numpy, mask float[H,W] numpy)。"""
        O = cls._get_overlay_geom()
        bg = (0.0, 0.0, 0.0)
        rgb, m, _ = O._render(shape, int(cx), int(cy), max(1, int(bw)), max(1, int(bh)),
                              W, H, bg, rgb01, float(alpha), int(blur), int(rotation))
        return rgb, m

    @staticmethod
    def _pick_box(mask_hw, W, H):
        """从 [H,W] mask 取外接框 (x0,y0,x1,y1) 或 None。"""
        if mask_hw is None:
            return None
        ys, xs = torch.where(mask_hw > 0.5)
        if xs.numel() == 0:
            return None
        return (int(xs.min().item()), int(ys.min().item()),
                int(xs.max().item()), int(ys.max().item()))

    # ---------------- ★ v1.9.7：取色基准脸（多脸时不再用「并集大框」）----------------

    @staticmethod
    def _runs(flags_1d):
        """一维布尔张量 → 连续 True 的闭区间列表 [(start,end), ...]。纯 torch，零依赖。"""
        idx = torch.where(flags_1d)[0]
        if idx.numel() == 0:
            return []
        vals = idx.tolist()
        out = []
        s = vals[0]; p = vals[0]
        for v in vals[1:]:
            if v > p + 1:
                out.append((s, p)); s = v
            p = v
        out.append((s, p))
        return out

    @classmethod
    def _split_boxes(cls, mask_hw, W, H):
        """把一张 mask 按「互不相连的目标」切成多张脸的框，返回 [(x0,y0,x1,y1), ...]（闭区间，与 _pick_box 同语义）。

        零依赖做法：先看列方向（x 投影）能切出几段，再看行方向（y 投影），取切得更多的一方。
        · 三视图 / 双人并排（脸左右不重叠）→ 按 x 切 ✓
        · 一上一下（脸上下不重叠）→ 按 y 切 ✓
        · 两张脸连成一片（投影切不开）→ 返回 1 个并集框，即退化成旧行为
        """
        if mask_hw is None:
            return []
        b = (mask_hw > 0.5)
        if b.dim() != 2:
            b = b.reshape(b.shape[-2], b.shape[-1])
        if not bool(b.any()):
            return []
        segs_x = cls._runs(b.any(dim=0))     # 列投影
        segs_y = cls._runs(b.any(dim=1))     # 行投影

        def _drop_specks(boxes):
            """丢掉碎点：白底图实测 SAM3 会吐出 1x3 像素的噪点，会被误当成「一张脸」。"""
            kept = [bx for bx in boxes if (bx[2] - bx[0]) >= 8 and (bx[3] - bx[1]) >= 8]
            return kept if kept else boxes

        if len(segs_x) > 1 and len(segs_x) >= len(segs_y):
            boxes = []
            for (a, c) in segs_x:
                ys = torch.where(b[:, a:c + 1].any(dim=1))[0]
                boxes.append((int(a), int(ys.min()), int(c), int(ys.max())))
            return _drop_specks(boxes)
        if len(segs_y) > 1:
            boxes = []
            for (a, c) in segs_y:
                xs = torch.where(b[a:c + 1, :].any(dim=0))[0]
                boxes.append((int(xs.min()), int(a), int(xs.max()), int(c)))
            return _drop_specks(boxes)
        one = cls._pick_box(mask_hw, W, H)
        return [one] if one is not None else []

    @classmethod
    def _pick_color_box(cls, mask_hw, W, H, ref="center"):
        """★ v1.9.7 取色基准框：auto 取色「以哪张脸为中心」往外扩。

        ref = "center"  → 最靠画面中央的那张脸（默认；三视图取中间那个人）
        ref = "largest" → 面积最大的那张脸（特写占主导的构图）
        ref = "union"   → 所有脸的并集外接框（v1.9.6 及以前的旧行为，留作回退）
        返回 (x0,y0,x1,y1) 或 None（无脸）。
        """
        if mask_hw is None:
            return None
        key = str(ref or "center").strip().lower()
        if key == "union":
            return cls._pick_box(mask_hw, W, H)
        boxes = cls._split_boxes(mask_hw, W, H)
        if not boxes:
            return None
        if len(boxes) == 1:
            return boxes[0]
        if key == "largest":
            return max(boxes, key=lambda b: max(0, b[2] - b[0]) * max(0, b[3] - b[1]))
        # 默认 center：脸框中心离画面中心最近的那张
        wx, wy = float(W) / 2.0, float(H) / 2.0
        return min(boxes, key=lambda b: ((b[0] + b[2]) / 2.0 - wx) ** 2 +
                                         ((b[1] + b[3]) / 2.0 - wy) ** 2)

    @classmethod
    def _other_face_boxes(cls, mask_hw, W, H, keep_box):
        """除 keep_box 之外的其他脸的框（取色时一并挖掉，防止圈里混进另一张脸的颜色）。"""
        if keep_box is None:
            return []
        return [b for b in cls._split_boxes(mask_hw, W, H) if tuple(b) != tuple(keep_box)]

    @staticmethod
    def _blur_mask(mask_hw, radius):
        """对 [H,W] mask 做高斯模糊（复用老节点同一套 PIL 实现），radius<=0 原样返回。"""
        if not radius or int(radius) <= 0:
            return mask_hw
        try:
            from PIL import Image, ImageFilter
            arr = (mask_hw.detach().cpu().numpy() * 255.0).clip(0, 255).astype("uint8")
            im = Image.fromarray(arr, mode="L").filter(ImageFilter.GaussianBlur(radius=int(radius)))
            return torch.from_numpy(np.asarray(im, dtype=np.float32) / 255.0)
        except Exception as e:
            print(f"[XH-智能遮脸] mask 模糊失败(忽略) -> {e}")
            return mask_hw

    def _run_raw_mask(self, image, m_raw, shape_color, alpha, blur_radius, invert, block_box=None,
                      expand_l=0.50, expand_r=0.50, expand_t=0.90, pick_ref="center"):
        """[模式 A] SAM 原始遮罩：把 SAM3 吐出的 mask 按 opacity/模糊/反转 处理后盖回原图。

        ★ v1.9.2：shape_color 支持 "auto" —— 先算好 mask 的框，再取「框外环带平均色」当遮挡色。
        ★ v1.9.6：auto 取色改成「小脸左/右/上外扩一圈」（下面是下巴，不往下扩），
                  圈的大小由 expand_l/r/t 决定 ⇒ 用户能把取色位置往外挪到背景上。
        ★ v1.9.7：auto 取色的**基准脸**由 pick_ref 决定（center/largest/union）——
                  多脸时默认取「最靠画面中央的那张脸」，不再拿两张脸的并集大框去取色。
                  遮罩本身仍是并集（该遮的脸一个不少），只有「取哪儿」变了。
        返回 (merged[H,W,C], mask[H,W], box_dict)。不套任何形状 ⇒ 遮出来的就是目标本身的轮廓。
        """
        H, W, C = image.shape
        m = torch.clamp(m_raw.float().to(image.device), 0.0, 1.0)
        if invert:
            m = 1.0 - m
        m = self._blur_mask(m, blur_radius).to(image.device).float()
        if alpha < 1.0:
            m = m * alpha
        box = self._pick_box(m, W, H)
        # ★ v1.9.6/v1.9.7 遮挡色：auto = 以「基准脸」为中心，左/右/上外扩一圈取色（下方不扩）；否则用 hex
        if self._is_auto(shape_color):
            _face = (m_raw.float().to(image.device) > 0.5)        # 原始脸 mask（不受 invert/alpha 影响）
            _cbox = self._pick_color_box(_face, W, H, pick_ref) or box
            _void = self._other_face_boxes(_face, W, H, _cbox)    # 其他脸一并挖掉，免得圈里混进人
            shape_rgb = self._auto_overlay_rgb(image, _cbox, block_box,
                                               float(expand_l), float(expand_r), float(expand_t),
                                               _void)
        else:
            shape_rgb = _hex_to_rgb01(shape_color)
        m3 = m.unsqueeze(-1).expand(H, W, C)
        solid = torch.tensor(shape_rgb, dtype=image.dtype, device=image.device).view(1, 1, C)
        merged = (image * (1.0 - m3) + solid * m3).clamp(0, 1)
        if box is None:
            bd = {"x": 0.0, "y": 0.0, "width": 0.0, "height": 0.0}
        else:
            x0, y0, x1, y1 = box
            bd = {"x": float(x0), "y": float(y0), "width": float(max(1, x1 - x0)), "height": float(max(1, y1 - y0))}
        return merged, m, bd

    # ---------------- 主逻辑 ----------------

    # ★ v1.9.10 修复（关键）：**所有形参一律给默认值**。
    #   根因：ComfyUI 执行器对「未连接的 optional 输入」是**直接从 kwargs 里省略**
    #   （不是传 None，是压根没有这个键）⇒ 若 run() 的形参没默认值，就抛
    #     TypeError: XHSmartFaceMask.run() missing 1 required positional argument: 'model'
    #   （v1.9.9 把 model/image 挪进 optional 时漏了这步，所以「不接模型」反而必崩。）
    #   Python 语法要求「一旦某个形参带默认值，其后所有**位置形参**都必须带默认值」，
    #   所以 model/image 一加默认值，后面 21 个必须一起加 —— 顺便让任何输入缺失都不崩。
    def run(self, model=None, image=None, shape="sam_mask",
            exclude_enable=True, exclude_cx=0.19, exclude_cy=0.346,
            exclude_w=0.379, exclude_h=0.692, exclude_color="#000000",
            threshold=0.5, shape_scale=1.0, mask_margin=15, shape_color="#C8C8C8",
            opacity=1.0, blur_radius=0, rotation=0, invert=False, fallback_draw=False,
            refine_iterations=2,
            expand_left=0.50, expand_right=0.50, expand_top=0.90, expand_bottom=0.00,
            color_pick_ref="center",
            prompt="face", clip=None,
            conditioning=None):

        if image is None:
            raise ValueError("[XH-智能遮脸] 缺少「原图」输入 —— 请把图片接到 image 口上。")

        # ★ v1.9.9：手动模式判定 —— 不接模型（拔掉 MODEL 线）或显式选 shape=manual_box
        #   ⇒ 直接用「排除区那个拖拽框」当最终遮挡框。不跑 SAM3、不报错、颜色照样支持 auto。
        model_missing = (model is None)
        use_manual = model_missing or (str(shape) == "manual_box")

        B, H, W, C = image.shape
        auto_color = self._is_auto(shape_color)          # ★ v1.9.2：遮挡色 auto = 自动取背景色
        shape_rgb = (0.78, 0.78, 0.78) if auto_color else _hex_to_rgb01(shape_color)
        alpha = max(0.0, min(1.0, float(opacity)))

        # [1] 盖排除区 → 得到「喂 SAM3 的图」（手动模式没有 SAM3 可喂，直接跳过）
        block_box = None
        if exclude_enable and not use_manual:
            blocked_img, block_mask, block_box = self._block_image(
                image, exclude_cx, exclude_cy, exclude_w, exclude_h, exclude_color)
        else:
            blocked_img, block_mask = image, torch.zeros(H, W, dtype=image.dtype, device=image.device)

        # ★ v1.9.8：内置提示词 —— 接了 CLIP 就自己编码（省掉一个 CLIPTextEncode 节点）。
        #   四种情况全部兜住，绝不报错：
        #     ① 接 CLIP + 框里有字 → 用框里的字
        #     ② 接 CLIP + 框是空的 → 自动用 "face"
        #     ③ 没接 CLIP          → 照旧用外部 conditioning（老行为，一点不变）
        #     ④ 编码抛异常         → 退回外部 conditioning
        cond = conditioning
        if clip is not None:
            _raw = str(prompt or "").strip() or "face"        # 空着也绝不爆红
            _p = _normalize_prompt(_raw)                      # ★ v1.9.16：全角 → 半角（静默）
            try:
                cond = clip.encode_from_tokens_scheduled(clip.tokenize(_p))
                if _p != _raw:
                    print(f"[XH-智能遮脸] 提示词里的全角字符已自动转半角：{_raw!r} → {_p!r}")
                print(f"[XH-智能遮脸] 内置提示词 = \"{_p}\"")
            except Exception as e:
                print(f"[XH-智能遮脸] 内置提示词编码失败 -> 退回外部 conditioning -> {e}")
                cond = conditioning

        # [2] SAM3 吃「盖过排除区的图」（★ v1.9.9：手动模式整段跳过，不加载、不报错）
        sam_masks = None
        if not use_manual:
            try:
                from comfy_extras.nodes_sam3 import SAM3_Detect as _SAM3Detect
                out = _SAM3Detect.execute(
                    model=model, image=blocked_img, conditioning=cond,
                    bboxes=None, positive_coords=None, negative_coords=None,
                    threshold=float(threshold), refine_iterations=int(refine_iterations),
                    individual_masks=False,
                )
                sam_masks = out[0]  # [B,H,W]
            except Exception as e:
                print(f"[XH-智能遮脸] SAM3 执行失败 -> 走兜底 -> {e}")
                sam_masks = None
        else:
            print(f"[XH-智能遮脸] 手动模式（{'未接模型' if model_missing else 'shape=manual_box'}）"
                  f" → 红框即遮挡框，不跑 SAM3")

        # [3] 覆盖到原图
        #   ★ shape == "sam_mask" → 模式 A：直接用 SAM3 原始遮罩（不套形状，遮出来就是目标轮廓本身）
        #     其它 shape         → 模式 B：只借 mask 定位（中心+尺寸×margin），再用该形状盖上去
        outs, masks_out, boxes_out = [], [], []
        use_raw = (shape == "sam_mask")
        use_head = (shape == "head")        # ★ v1.9.5：脸框四向外扩
        for i in range(B):
            # ★ v1.9.9 模式 D：手动遮挡 —— 直接用「排除区框」当遮挡框（不接模型也能跑）
            #   位置/大小 = exclude_cx/cy/w/h（就是前端那个能拖拽的框）
            #   形状       = shape（矩形 / 圆 / 椭圆 / 三角 …），非图形档一律退化成矩形
            #   颜色       = 遮挡色；填 auto 照样跟背景融合（取色圈随红框走，左/右/上扩）
            if use_manual:
                _mcx = int(round(float(exclude_cx) * W))
                _mcy = int(round(float(exclude_cy) * H))
                _mhw = max(1, int(round(float(exclude_w) * W / 2.0)))
                _mhh = max(1, int(round(float(exclude_h) * H / 2.0)))
                _mx0 = max(0, _mcx - _mhw); _mx1 = min(W, _mcx + _mhw)
                _my0 = max(0, _mcy - _mhh); _my1 = min(H, _mcy + _mhh)
                if _mx1 > _mx0 and _my1 > _my0:
                    _mk_shape = shape if shape in self._RENDER_SHAPES else "rectangle"
                    _mcx_px = (_mx0 + _mx1) // 2
                    _mcy_px = (_my0 + _my1) // 2
                    _m_rgb = self._auto_overlay_rgb(
                        image[i], (_mx0, _my0, _mx1, _my1), None,
                        float(expand_left), float(expand_right),
                        float(expand_top)) if auto_color else shape_rgb
                    s_rgb, s_m = self._render_shape(
                        _mk_shape, _mcx_px, _mcy_px,
                        max(1, _mx1 - _mx0), max(1, _my1 - _my0),
                        W, H, _m_rgb, alpha, int(blur_radius), int(rotation))
                    s_m_t = torch.from_numpy(np.ascontiguousarray(s_m)).to(image.dtype)
                    s_rgb_t = torch.from_numpy(np.ascontiguousarray(s_rgb)).to(image.dtype)
                    if invert:
                        s_m_t = 1.0 - s_m_t
                    m3 = s_m_t.unsqueeze(-1).expand(H, W, 3)
                    merged = (image[i] * (1.0 - m3) + s_rgb_t * m3).clamp(0, 1)
                    outs.append(merged.unsqueeze(0))
                    masks_out.append(s_m_t.unsqueeze(0))
                    boxes_out.append({"x": float(_mx0), "y": float(_my0),
                                      "width": float(_mx1 - _mx0), "height": float(_my1 - _my0)})
                else:
                    outs.append(image[i:i + 1])
                    masks_out.append(torch.zeros((1, H, W), dtype=image.dtype, device=image.device))
                    boxes_out.append({"x": 0.0, "y": 0.0, "width": 0.0, "height": 0.0})
                continue

            raw = None
            if sam_masks is not None and i < sam_masks.shape[0]:
                raw = sam_masks[i]

            # ★ v1.9.5 模式 C：脸框四向外扩（「小脸 + 小脸以上」的可控遮罩）
            #   ① 锚点 = SAM3 的目标框（脸框），中心不动
            #   ② 四条边各自往外挪：左/右 按「脸宽」倍数，上/下 按「脸高」倍数（expand_* 参数）
            #   ③ clamp 到图像内；下扩默认 0 ⇒ 只到下巴、不啃脖子和衣服
            #   ④ 颜色走 shape_color（填 auto 就跟背景融合）
            if use_head:
                hb = self._pick_box(raw, W, H) if raw is not None else None
                if hb is None and fallback_draw:
                    # 兜底：先假设人脸在中上部（宽 15% 图宽 / 高 20% 图高），再按同样规则扩
                    _fbw, _fbh = max(4, int(W * 0.15)), max(4, int(H * 0.20))
                    _bcx, _bcy = W // 2, int(H * 0.35)
                    hb = (_bcx - _fbw // 2, _bcy - _fbh // 2, _bcx + _fbw // 2, _bcy + _fbh // 2)
                if hb is None:
                    outs.append(image[i:i + 1])
                    masks_out.append(torch.zeros((1, H, W), dtype=image.dtype, device=image.device))
                    boxes_out.append({"x": 0.0, "y": 0.0, "width": 0.0, "height": 0.0})
                    continue
                _fx0, _fy0, _fx1, _fy1 = hb
                _fw = max(1, _fx1 - _fx0)
                _fh = max(1, _fy1 - _fy0)
                _ex0 = max(0, int(round(_fx0 - _fw * float(expand_left))))
                _ex1 = min(W, int(round(_fx1 + _fw * float(expand_right))))
                _ey0 = max(0, int(round(_fy0 - _fh * float(expand_top))))
                _ey1 = min(H, int(round(_fy1 + _fh * float(expand_bottom))))
                if _ex1 <= _ex0:
                    _ex1 = min(W, _ex0 + 1)
                if _ey1 <= _ey0:
                    _ey1 = min(H, _ey0 + 1)
                hm = torch.zeros((H, W), dtype=torch.float32)
                hm[_ey0:_ey1, _ex0:_ex1] = 1.0
                hm = self._blur_mask(hm, int(blur_radius)).to(image.device).float()
                if invert:
                    hm = 1.0 - hm
                if alpha < 1.0:
                    hm = hm * alpha
                if auto_color:
                    # ★ v1.9.7 取色基准脸（默认最靠画面中央那张）；遮罩仍按并集框走
                    _face = (raw.float().to(image.device) > 0.5) if raw is not None else None
                    _cbox = self._pick_color_box(_face, W, H, color_pick_ref) or hb
                    _void = self._other_face_boxes(_face, W, H, _cbox)
                    _h_rgb = self._auto_overlay_rgb(image[i], _cbox, block_box,
                                                    float(expand_left), float(expand_right),
                                                    float(expand_top), _void)
                else:
                    _h_rgb = shape_rgb
                m3 = hm.unsqueeze(-1).expand(H, W, C)
                solid = torch.tensor(_h_rgb, dtype=image.dtype, device=image.device).view(1, 1, C)
                merged = (image[i] * (1.0 - m3) + solid * m3).clamp(0, 1)
                outs.append(merged.unsqueeze(0))
                masks_out.append(hm.unsqueeze(0).to(image.dtype))
                boxes_out.append({"x": float(_ex0), "y": float(_ey0),
                                  "width": float(_ex1 - _ex0), "height": float(_ey1 - _ey0)})
                continue

            if use_raw:
                if raw is not None and float(raw.max()) > 0.5:
                    merged, m_out, bd = self._run_raw_mask(
                        image[i], raw, shape_color, alpha, int(blur_radius), invert, block_box,
                        float(expand_left), float(expand_right), float(expand_top),
                        color_pick_ref)
                    outs.append(merged.unsqueeze(0))
                    masks_out.append(m_out.unsqueeze(0).to(image.dtype))
                    boxes_out.append(bd)
                    continue
                found = None
                draw_shape = "circle"     # 兜底时也不套用户选的形状（那是 sam_mask），退化成实心圆
            else:
                found = self._pick_box(raw, W, H) if raw is not None else None
                draw_shape = shape

            if found is not None:
                x0, y0, x1, y1 = found
                fw = max(1, x1 - x0); fh = max(1, y1 - y0)
                cx = int((x0 + x1) / 2); cy = int((y0 + y1) / 2)
                bw = max(4, int(fw * (1 + mask_margin / 100.0) * shape_scale))
                bh = max(4, int(fh * (1 + mask_margin / 100.0) * shape_scale))
            elif fallback_draw:
                # 兜底：在排除区之外画（老工作流的节点29 位置语义，用 image_center 居中偏下）
                cx = W // 2; cy = int(H * 0.55)
                bw = max(4, int(W * 0.34 * shape_scale))
                bh = max(4, int(H * 0.34 * shape_scale))
            else:
                outs.append(image[i:i + 1])
                masks_out.append(torch.zeros((1, H, W), dtype=image.dtype, device=image.device))
                boxes_out.append({"x": 0.0, "y": 0.0, "width": 0.0, "height": 0.0})
                continue

            # ★ v1.9.2：auto = 自动取「这枚形状框外一圈环带」的平均色（跟着背景/头发走）
            # ★ v1.9.7：取色基准改成「基准脸」（默认最靠画面中央那张）；形状本身仍套并集框，行为不变
            if auto_color:
                _face = (raw.float().to(image.device) > 0.5) if raw is not None else None
                _cbox = self._pick_color_box(_face, W, H, color_pick_ref) or \
                    (cx - bw // 2, cy - bh // 2, cx + bw // 2, cy + bh // 2)
                _void = self._other_face_boxes(_face, W, H, _cbox)
                one_rgb = self._auto_overlay_rgb(image[i], _cbox, block_box,
                                                 float(expand_left), float(expand_right),
                                                 float(expand_top), _void)
            else:
                one_rgb = shape_rgb
            s_rgb, s_m = self._render_shape(draw_shape, cx, cy, bw, bh, W, H,
                                            one_rgb, alpha, int(blur_radius), int(rotation))
            s_m_t = torch.from_numpy(np.ascontiguousarray(s_m)).to(image.dtype)
            s_rgb_t = torch.from_numpy(np.ascontiguousarray(s_rgb)).to(image.dtype)
            if invert:
                s_m_t = 1.0 - s_m_t
            m3 = s_m_t.unsqueeze(-1).expand(H, W, 3)
            merged = (image[i] * (1.0 - m3) + s_rgb_t * m3).clamp(0, 1)
            outs.append(merged.unsqueeze(0))
            masks_out.append(s_m_t.unsqueeze(0))
            boxes_out.append({"x": float(cx - bw / 2), "y": float(cy - bh / 2),
                              "width": float(bw), "height": float(bh)})

        img_out = torch.cat(outs, dim=0)
        mask_out = torch.cat(masks_out, dim=0)
        box_out = boxes_out[0] if len(boxes_out) == 1 else boxes_out
        return (img_out, mask_out, box_out)
