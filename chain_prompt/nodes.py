"""
🔁 XH 提示词表  (XH-ChainPrompt)

用途：配合 Motion-Context / Herrgotts 等「一键跑 N 段」的 Chain 工作流，
      让每一段自动拿到属于它自己的那份完整提示词。

设计（2026-09-15 定稿 / 2026-09-30 大改）
  * 提示词框 = 后端**固定声明** prompt_0 .. prompt_{MAX-1}（全常驻，不读写任何文件）。
  * 🔴 2026-09-30 改：**框数不再存后端公共文件**（原来存 slots.json）——
    那样「同一个工作流里放两个该节点」会互相干扰（改一个另一个也变）。
    现在 **num_slots 是节点自己的参数**（存在工作流里，实例级）⇒ 多个节点**完全独立、互不干扰**，
    发给别人时框数也跟着工作流走（原来不会）。
    前端只做**本地显隐**：多余的框被折叠起来（不重建画布、不重新拉定义）。
  * 没填内容的框会被自动跳过，不影响段序。
  * 段序计数器保存在模块级 dict（key = ComfyUI 的 unique_id），**每个节点独立**。
  * IS_CHANGED 返回时间戳 → Chain 每 re-queue 一次都会重算 → 段号自动 +1。
  * 🔴 2026-10-01 新增「自动跟随循环轮次」：在 XH 循环体里**零接线**自动逐段。
    原理：XH 循环展开时会把循环体复制成 `轮次_原ID`（`controls/for_loop.py:64`
    `graph.node(..., f"{position}_{node_id}")`），而节点拿到的 `unique_id`
    就是那个副本 ID（`execution.py:439` `unique_id = current_item`）
    ⇒ **节点可以直接从自己的 ID 前缀读出"这是第几轮"**，不用外接 index。

段号来源优先级（三段式，前两条互斥）：
  ① 开了「自动跟随循环轮次」且自己在循环体里（ID 形如 `2_391`）→ 段号 = 轮次
  ② 否则 → 老逻辑：起始段 + 内部计数器自增（循环体外反复 Queue 用）

输出（三个口都声明成列表，OUTPUT_IS_LIST=(True,True,True)）：
  prompt        (STRING,列表) 受「自循环·跑全部段」开关控制：
                              关（默认）= 当前这一段（长度 1 的列表）→ 下游跑 1 遍；
                              开 = 全部非空段（长度 N 的列表）→ ComfyUI 自动把下游跑 N 遍。
  segment_index (INT,列表)    当前段对应的「物理框号」（0 起，与界面「第 N 段」标签一致）→ 监控/联动。
  prompt_list   (STRING,列表) 永远是「全部非空段」（长度 N 的列表），不受开关影响 ——
                              想不碰开关就直接拿全部段时接这个口（如循环体内想批量则接它）。
                              ⚠️ 语义区分：prompt = 受开关控制；prompt_list = 永远全部段。
"""

import os
import re
import time

# 🔴 2026-10-15 新增：判断某个输入口在 prompt 里是不是「接着线」（用来实现"跳过前 N 段"）
#    原理同 controls/for_loop.py —— 借 DynamicPrompt 看节点自己的 inputs。
from comfy_execution.graph_utils import is_link

# 后端固定声明的框数上限（前端按 num_slots 折叠显示；上限别开太大，声明太多会拖慢节点）
MAX_PROMPT_SLOTS = 32
# 🔴 2026-10-13 用户反馈：默认 5 框拖出来太大 → 默认只给 1 框（要几段自己加，改「框数」当场生效）
DEFAULT_PROMPT_SLOTS = 1

# ------------------------------------------------------------------ 状态
# key = ComfyUI unique_id（字符串）→ {"next": int, "restart": int, "total": int}
# 🔴 用 unique_id 做 key ⇒ 同一工作流里的多个该节点**各自独立**，不会互相影响段序
_STATE: dict = {}

_PROMPT_KEY_RE = re.compile(r"^prompt_(\d+)$")

# XH 循环展开后，循环体里节点的 unique_id 形如 "2_391"（轮次_原ID）
_TURN_RE = re.compile(r"^(\d+)_")


class XH_ChainPromptSelector:
    """🔁 XH-提示词表：按段号自动输出对应那一段的完整提示词。"""

    @classmethod
    def INPUT_TYPES(cls):
        required = {}

        # 🔴 2026-10-19 布局定稿：参数按「数据源 → 起跑位置 → 循环方式 → 调试」四组排。
        #    读下来一条线：有哪些段 → 从哪段起跑 → 跑完绕不绕 → 出问题才动重置。
        #    ① 数据源：num_slots / source / prompt_folder
        #    ② 起跑：  start_index / start_offset      ← 两个必须挨着（同一件事）
        #    ③ 循环：  loop / follow_loop_turn / all_segments
        #    ④ 调试：  restart_index
        #    ⚠️ 声明顺序 = 界面顺序 = widgets_values 位置顺序。
        #      老存档靠前端 `node.properties.xh_cp_layout` 版本号判别后迁移
        #      （新旧布局的「类型模式」一样，光看类型认不出来，必须有版本号）。

        # ---------- ① 数据源 ----------
        # 🔴 这个值只用来控制**本节点**显示几个框（前端本地折叠，不写任何文件、不影响别的节点）
        required["num_slots"] = (
            "INT",
            {
                "default": DEFAULT_PROMPT_SLOTS,
                "min": 1,
                "max": MAX_PROMPT_SLOTS,
                "step": 1,
                "tooltip": (
                    "本节点显示几个提示词框（只影响本节点的显示，不干扰别的同类节点）。\n"
                    "改数字**实时生效**，不用点任何按钮。\n"
                    "⚠️ 运行时也只收集这个数量范围内的框；被折叠隐藏的框即使以前填过内容，"
                    "也不会被当成一段来跑。想重新启用，先把「框数」调大。"
                ),
            },
        )
        required["source"] = (
            ["文本框", "文件夹"],
            {
                "default": "文本框",
                "tooltip": (
                    "提示词从哪来：\n"
                    "· 文本框（默认）= 用下面的提示词框手填；\n"
                    "· 文件夹 = 指定一个文件夹，里面每个 .txt/.md 文件 = 一段提示词。\n"
                    "排序：按文件名自然排序（数字段按数值比：1、2、3…10，101/112 等多位数同样正确）。\n"
                    "🔴 注意：纯中文名（不带数字前缀）时按 Unicode 码位排，可能与资源管理器的拼音序不一致"
                    "（例如「二当家」会排在「动漫男」前面）；给文件统一加 01_、02_… 数字前缀后两者必然一致。\n"
                    "关联文件夹后节点上会显示实际调用顺序（第1段、第2段…），以此为准即可。\n"
                    "文件夹模式会忽略下面的文本框，且不限 32 段；空文件跳过、不占段序。"
                ),
            },
        )
        required["prompt_folder"] = (
            "STRING",
            {
                "default": "",
                "multiline": False,
                "placeholder": "📂 文件夹路径（例：D:\\素材\\婉儿提示词），点工具栏「📂 文件夹」选，或粘贴后回车",
                "tooltip": (
                    "文件夹模式下的提示词来源：每个 .txt / .md 文件 = 一段提示词。\n"
                    "空文件会被跳过、不占段序（和文本框里空框一样）。\n"
                    "选了「文件夹」来源后这里才有用；出图时按文件名自然排序读取（数字按数值比）。\n"
                    "🔴 建议文件名统一加 01_、02_… 数字前缀：纯中文名的排序可能与资源管理器（拼音序）不同；\n"
                    "文件夹里加/换文件后重跑即刷新；节点上会显示实际调用顺序，可直接核对。"
                ),
            },
        )

        # ---------- ② 起跑位置 ----------
        required["start_index"] = (
            "INT",
            {
                "default": 0, "min": 0, "max": MAX_PROMPT_SLOTS - 1, "step": 1,
                "tooltip": (
                    "从第几段开始（0 = 第 1 段）。\n"
                    "· 循环体外：反复 Queue 时从这一段起步\n"
                    "· 循环体内：作为「轮次偏移」，第 1 轮 = 第 (起始段+1) 段\n"
                    "· 这个口接了线时：以线上传来的值为准（绝对段号）"
                ),
            },
        )
        # 🔴 2026-10-19 新增：起跑偏移（工具条「▶ 起跑 N」按钮写的就是它）
        #    与「起始段」的区别：它**永远叠加**，且不受「起始段口接线」影响 ⇒
        #    接了线也能用按钮选起跑段（这正是加它的原因）。
        required["start_offset"] = (
            "INT",
            {
                "default": 0, "min": 0, "max": MAX_PROMPT_SLOTS - 1, "step": 1,
                "tooltip": (
                    "起跑偏移（建议直接用工具条「▶ 起跑 N」按钮选，别手填）。\n"
                    "· 循环体里：第 1 轮 = 第 (偏移+1) 段，之后依次往后。\n"
                    "· 「起始段」口接了线时：线上传来的值 + 这个偏移 = 实际用哪段。\n"
                    "· 0 = 不偏移（默认；老工作流行为完全不变）。"
                ),
            },
        )

        # ---------- ③ 循环方式 ----------
        required["loop"] = (
            "BOOLEAN",
            {
                "default": False,
                "tooltip": (
                    "段号用完之后的处理方式：\n"
                    "· 关（默认）= 停在最后一段，一直用它\n"
                    "· 开 = 绕回第 1 段重新开始\n"
                    "例：填了 3 段却要跑 6 次 —— 关 → 0,1,2,2,2；开 → 0,1,2,0,1,2\n"
                    "⚠️ 这个开关不会「启动循环」，循环是 XH-循环开始/结束 的活。"
                ),
            },
        )
        # 🔴 2026-10-01：在 XH 循环体里零接线自动逐段（读自己 unique_id 的轮次前缀）
        required["follow_loop_turn"] = (
            "BOOLEAN",
            {
                "default": True,
                "tooltip": (
                    "在 XH-循环体里自动跟随轮次（推荐保持开启）。\n"
                    "· 开：进循环体后，第 1 轮读第 1 段、第 2 轮读第 2 段……\n"
                    "  一根线都不用接，也不用再给「起始段」接循环的 index。\n"
                    "  此时段号 = 轮次 + 起始段 + 起跑偏移（两个都为 0 就是纯逐段）。\n"
                    "· 关：回到老做法 —— 段号只看「起始段」（需要自己接 XH-循环开始 的 index）。\n"
                    "不在循环体里时，这个开关没有任何影响。"
                ),
            },
        )
        # 🔴 2026-10-01 第二改：让下游「一次跑完 N 遍」（不用 XH 循环也能批量出片）
        required["all_segments"] = (
            "BOOLEAN",
            {
                "default": False,
                "tooltip": (
                    "让节点「不用外接循环也一次跑完 N 段」。\n"
                    "· 开 = prompt 口与 prompt_list 口都给出【全部非空段】"
                    "⇒ ComfyUI 自动把下游跑 N 遍（一次 Queue 出 N 张/段）。\n"
                    "· 关（默认）= 两个口都只给【当前这一段】（下游跑 1 遍）。\n"
                    "提示：prompt_list 口【任何时候】都是全部段，不靠这个开关也能批量；"
                    "这个开关主要是让 prompt 口也变成全部段。\n"
                    "⚠️ 绝对不能和任何循环（XH-循环 / easy-use 循环）一起用！"
                    "节点在循环里会被反复执行，每次又吐全部段 ⇒ N×N 重复跑、又慢又费显存。"
                    "循环体内请改用「自动跟随循环轮次」+ prompt 口（零接线逐段）。"
                ),
            },
        )

        # ---------- ④ 调试 ----------
        required["restart_index"] = (
            "INT",
            {
                "default": 0, "min": 0, "max": 9999, "step": 1,
                "tooltip": (
                    "「从头跑」的开关：把这个数字改一下（比如 0 改成 1），\n"
                    "段号就会归零重来。只影响循环体外「反复 Queue」的用法。\n"
                    "💡 只想从中间某段接着跑，用工具条的「▶ 起跑 N」更直观。"
                ),
            },
        )

        # ---- 提示词框（2026-10-19 起排在参数**之后** → 沉到节点底部）----
        #    固定上限，前端按 num_slots 折叠；它们是「可生长」控件（components/widgets 里的
        #    multiline textarea），节点多余的竖向空间全由它们吸收 ⇒ 底部不留空白。
        for i in range(MAX_PROMPT_SLOTS):
            required[f"prompt_{i}"] = (
                "STRING",
                {
                    "multiline": True,
                    "default": "",
                    "dynamicPrompts": True,
                    "tooltip": (
                        f"第 {i + 1} 段提示词（可多行）。\n"
                        "按顺序取用，留空的框会被自动跳过、不占段序。\n"
                        "框数量由上面的「框数」决定 —— 参数区被「⚙」收起时也照改这里的数量。"
                    ),
                },
            )

        hidden = {"unique_id": "UNIQUE_ID", "xh_loop_turn": "INT", "dynprompt": "DYNPROMPT"}

        return {"required": required, "hidden": hidden}

    RETURN_TYPES = ("STRING", "INT", "STRING")
    RETURN_NAMES = ("prompt", "segment_index", "prompt_list")
    # 🔴 三个输出**全部声明成「列表」** ⇒ ComfyUI 的 merge_result_data(execution.py:330)
    #    对每个 is_list 口做 extend；下游节点再按列表长度自动执行 N 遍
    #    （execution.py:258 max_len_input = 列表长度，决定下游跑几次）。
    #    · 普通模式 / 循环体内：每个口返回「长度为 1 的列表」→ 下游跑 1 遍，行为和以前一致；
    #    · 批量自循环（all_segments 开、且不在循环体内）：prompt / prompt_list 返回「全部段的列表」
    #      ⇒ 下游（如 文生图 / CLIPTextEncode）被自动跑 N 遍，一次 Queue 出 N 张/段。
    #   ⚠️ 既然是列表口，execute 必须**永远返回列表**（哪怕是 1 个元素），否则 extend 会把
    #      字符串当字符迭代、或下游拿不到列表 → 报错。这是 2026-10-01 之前那版崩溃的根因。
    OUTPUT_IS_LIST = (True, True, True)
    FUNCTION = "execute"
    CATEGORY = "🔁XH/链提示词"
    DESCRIPTION = (
        "【干什么】把 N 段提示词填在一个节点里，按段号自动吐出对应那一段 —— "
        "做多段 MV / 连续剧 / 批量出图。\n"
        "【怎么配】每个框填一段完整提示词（可多行），空的框自动跳过、不占段序。\n"
        "【三种用法，按需选一个】\n"
        "  ① 想「一次跑完 N 遍、不用外接循环」→ 把 prompt（或 prompt_list）口接到下游，"
        "再打开「自循环·跑全部段」开关 ⇒ 按一次 Queue 就自动依次跑完你填的 5 段（出 5 张/段）。\n"
        "  ② 想「一段接一段、还能传尾帧」→ 放进 XH-循环开始/结束 之间，"
        "开「自动跟随循环轮次」（默认开），一根线都不用接。\n"
        "  ③ 想「每按一次 Queue 走一段」→ 直接把 prompt 口接下游，"
        "每按一次自动往后走（想归零就改「重置序号」）。\n"
        "【「循环」开关 ≠ 自动循环】它只决定「段号用完后」：关 = 停在最后一段；"
        "开 = 绕回第 1 段（段号=轮次 那种才真正逐段）。想要「不接循环就自动跑全部段」请用 ① 的开关。\n"
        "【显示几个框】由「框数」决定，点「✅ 应用框数」当场折叠/展开，只影响本节点。\n"
        "【输出】prompt = 受开关控制（普通=当前段、开自循环=全部段）；"
        "prompt_list = 永远全部段（不用开开关也能批量）；segment_index = 当前段的物理框号（0 起，与界面标签一致）。"
        "⚠️ 「自循环·跑全部段」与任何循环互斥，循环体内请用「自动跟随循环轮次」+ prompt 口。"
    )

    # 每次 re-queue 都重算，否则 ComfyUI 会命中缓存、段号不前进
    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return time.time()

    # ---- 文件夹模式：从文件夹读 .txt/.md（2026-10-12，与「🖼️XH-图片列表」一致）----
    _TXT_EXT = {".txt", ".md", ".markdown"}

    @staticmethod
    def _natural_key(text):
        """文件名自然排序：'seg_10' 排在 'seg_9' 之后（数字段按数值比）。"""
        return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", text or "")]

    @classmethod
    def _read_folder_prompts(cls, folder):
        """读文件夹里每个 .txt/.md = 一段提示词，按文件名自然排序。返回 (texts, box_indices)。

        · 空文件 = 空段，跳过、不占段序（和文本框里空框一致）；
        · 文件夹里的文件名决定段序（segment_001.txt → 第 1 段）。⚠️ 纯中文名按 Unicode 码位排，
          与资源管理器的拼音序可能不同 —— 加 01_/02_ 数字前缀后两者才必然一致；
        · 画布只存文件夹路径，这里才是真正读盘的地方（出图时才执行，画布零负担）。
        """
        root = os.path.abspath(folder or "")
        if not folder or not os.path.isdir(root):
            raise NotADirectoryError(
                f"文件夹不存在或路径为空：{folder}\n"
                "（点工具栏「📂 文件夹」选一个，或在「文件夹路径」那行粘贴后回车）"
            )
        files = []
        for fn in os.listdir(root):
            full = os.path.join(root, fn)
            if os.path.isfile(full) and os.path.splitext(fn)[1].lower() in cls._TXT_EXT:
                files.append((fn, full))
        files.sort(key=lambda t: cls._natural_key(t[0]))
        if not files:
            raise FileNotFoundError(
                f"这个文件夹里没有 .txt/.md 提示词文件：{folder}\n"
                "（只认 .txt / .md / .markdown，每个文件 = 一段提示词）"
            )
        texts, box_indices = [], []
        for i, (fn, full) in enumerate(files):
            try:
                with open(full, "r", encoding="utf-8-sig", errors="replace") as fh:
                    content = fh.read().strip()
            except OSError as e:
                print(f"[XH-提示词表] ⚠ 读 {fn} 失败，跳过：{e}")
                continue
            if not content:
                continue  # 空文件 = 空段，跳过、不占段序
            texts.append(content)
            box_indices.append(i)
        if not texts:
            raise ValueError(
                f"文件夹里的提示词文件都是空的：{folder}\n"
                "（至少在一个 .txt/.md 里写点东西吧）"
            )
        print(f"[XH-提示词表] 📂 文件夹模式读取 {root} → {len(texts)} 段"
              f"（第 1 段：{files[0][0]}）")
        return texts, box_indices

    def execute(self, start_index=0, restart_index=0, loop=False,
                follow_loop_turn=True, all_segments=False, unique_id=None,
                num_slots=DEFAULT_PROMPT_SLOTS, xh_loop_turn=-1,
                start_offset=0,
                dynprompt=None,
                source="文本框", prompt_folder="", **kwargs):
        # 宽容解析：API 直调时 start/restart 可能传来字符串或小数，别让 int() 直接炸
        def _to_int(v, default=0):
            try:
                return int(round(float(v)))
            except (TypeError, ValueError):
                return default

        def _to_bool(v, default=False):
            if isinstance(v, bool):
                return v
            if isinstance(v, str):
                # 🔴 空串 = 老存档没这个参数（widgets_values 末位是前端工具栏的占位空串）
                #    ⇒ 当「没传」处理、回落到默认值，别把 '' 判成 False。
                if v.strip() == "":
                    return default
                return v.strip().lower() in ("1", "true", "yes", "on")
            if v is None:
                return default
            return bool(v)

        start_index = _to_int(start_index)
        start_offset = max(0, _to_int(start_offset))   # 2026-10-19 起跑偏移
        restart_index = _to_int(restart_index)
        follow_loop_turn = _to_bool(follow_loop_turn, True)
        loop = _to_bool(loop, False)
        all_segments = _to_bool(all_segments, False)

        # 0) 决定轮次 turn：XH 注入的 xh_loop_turn 最可靠（真实 0 起轮次），
        #    其次 unique_id 前缀兜底（仅 follow_loop_turn 开时）。
        #    ※ 之前只用 unique_id 前缀（re ^(\d+)_），但前缀格式随 ComfyUI 的 GraphBuilder
        #      内部计数器变化，第二次运行会错位 ⇒ 从第二段开始。现已用注入值取代。
        xh_loop_turn = _to_int(xh_loop_turn, -1)
        turn = None
        if xh_loop_turn is not None and xh_loop_turn >= 0:
            turn = xh_loop_turn
        elif follow_loop_turn:
            _mt = _TURN_RE.match(str(unique_id) if unique_id is not None else "")
            if _mt:
                try:
                    turn = int(_mt.group(1))
                except (TypeError, ValueError):
                    turn = None

        # 0.5) 数据来源：文件夹模式 vs 文本框模式
        #    文件夹模式：从文件夹读 .txt/.md（每个文件 = 一段），忽略上面的文本框与 32 框上限；
        #    文本框模式：沿用老逻辑（收集 num_slots 范围内的非空框）。
        folder_mode = (str(source) == "文件夹")
        if folder_mode:
            try:
                texts, box_indices = self._read_folder_prompts(prompt_folder)
            except Exception as e:                       # noqa: BLE001
                # 文件夹读取出错 ⇒ 明确报错（包成 ValueError，前端/用户一眼看懂），别让下游拿空串乱跑
                raise ValueError(f"[XH-提示词表] 文件夹模式读取失败：{e}")
        else:
            # 1) 收集「非空」框，但只认当前「框数」范围内的 —— 防止把折叠隐藏的框也算进来
            #    （num_slots 是节点自己的参数，存在工作流里；空框仍然跳过、不占段序）
            max_slot = _to_int(num_slots, DEFAULT_PROMPT_SLOTS)
            max_slot = max(1, min(max_slot, MAX_PROMPT_SLOTS))
            found = []
            for k, v in kwargs.items():
                m = _PROMPT_KEY_RE.match(k)
                if not m:
                    continue
                slot = int(m.group(1))
                if slot >= max_slot:
                    continue
                if isinstance(v, str) and v.strip():
                    found.append((slot, v))
            found.sort(key=lambda x: x[0])
            texts = [v for _, v in found]
            # 物理框号列表（与界面「第 N 段」标签一一对应）：段号 = 你填的那个框的编号，
            # 而不是「非空段里的排位」。这样即使中间有空框，segment_index 也和界面标签对得上。
            box_indices = [b for b, _ in found]

        if not texts:
            return ([""], [0], [""])

        # 🔴 批量自循环（不用外接 XH 循环，一次把全部段交给下游跑 N 遍）
        #    仅在「循环体外」有意义：循环体内每个克隆本就该只输出自己那一段，
        #    若这里也吐全部段 ⇒ 每轮下游再跑 N 次 = N×N，错。
        #    turn is not None 即「在循环体里的副本」（ID 形如 2_391），直接跳过批量逻辑。
        if all_segments and turn is None:
            return (texts, box_indices, texts)

        # 🔴🔴 2026-10-15 新增：「起始索引」口**有连线**时以它为准（= 跳过前 N 段 / 只重跑第 N 段）
        #    为什么：在 XH 循环体里本节点原本只看「轮次」，于是"图跟着段号走、提示词跟着轮次走"，
        #    想从中间某段开跑就得改好几处。改成"有人接线驱动就以它为准"后，
        #    「图 / 每段时长 / 提示词」三处**同源** —— 只改循环的「起始索引」即可全部对齐。
        #    ⚠️ 没接线的老工作流一律走下面的老逻辑，行为与改前逐案一致（已做等价回归）。
        forced = None
        # 🔴 2026-10-19：「起跑段」在节点上被主动设定（> 0）⇒ **优先用它，盖过连线**。
        #    0 = 没特别指定 ⇒ 保持老行为（有线跟线、无线跟轮次/状态机），老工作流零影响。
        #    目的：用户点工具条的「▶ 起跑 N」就能直接选起跑段，不用断线、也不用手填数字。
        if start_index > 0:
            forced = start_index
        else:
            try:
                _dp = dynprompt[0] if isinstance(dynprompt, (list, tuple)) and dynprompt else dynprompt
                if _dp is not None and unique_id is not None:
                    _self_node = _dp.get_node(str(unique_id))
                    if is_link(((_self_node or {}).get("inputs") or {}).get("start_index")):
                        forced = start_index
            except Exception:
                forced = None      # 拿不到图（老引擎 / 单测直调）⇒ 老实走老逻辑，绝不因此报错
        if forced is not None:
            n = len(texts)
            # 「起始段」口接了线 ⇒ 线传来的值 + 起跑偏移
            f2 = max(0, forced) + start_offset
            pos = (f2 % n) if loop else min(f2, n - 1)
            return ([texts[pos]], [box_indices[pos]], [texts[pos]])

        # 2-A) 在循环体里（turn 有值 = XH 注入的真实轮次，或 follow_loop_turn 开的兜底）⇒ 段号 = 轮次，**无状态**
        #      （这里「循环」开关才真正有意义：轮次超过段数时决定绕回还是停在最后一段）
        #      不加 start_index 偏移 —— 避免「既接了 index 又读了轮次」双算。
        if turn is not None:
            n = len(texts)
            # 轮次 + 起始段 + 起跑偏移。三者都为 0 时 t2 === turn ⇒ 与老行为逐案一致。
            off = max(0, min(int(start_index), n - 1))
            t2 = turn + off + start_offset
            pos = (t2 % n) if loop else min(t2, n - 1)
            return ([texts[pos]], [box_indices[pos]], [texts[pos]])

        # 2-B) 老逻辑（循环体外，或关掉了「自动跟随循环轮次」）—— 一字未改
        # 2) 取/建**本节点**的状态（key = unique_id ⇒ 多节点互不干扰）
        key = str(unique_id)
        st = _STATE.get(key)
        if (st is None
                or st.get("restart") != restart_index
                or st.get("total") != len(texts)):
            st = {
                "next": max(0, min(int(start_index) + start_offset, len(texts) - 1)),
                "restart": restart_index,
                "total": len(texts),
            }
            _STATE[key] = st

        # 3) 取当前段
        idx = st["next"]
        if idx >= len(texts):
            idx = 0 if loop else len(texts) - 1
        text = texts[idx]

        # 4) 推进段号（不循环时停在最后一段）
        nxt = idx + 1
        st["next"] = (nxt % len(texts)) if loop else min(nxt, len(texts) - 1)

        # 🔴 三个口都返回「长度为 1 的列表」—— 兼容 OUTPUT_IS_LIST=(True,True,True)，
        #    下游跑 1 遍，行为和改造前（标量输出）完全一致。
        #    segment_index 用物理框号（box_indices[idx]），和界面「第 N 段」标签一致。
        return ([text], [box_indices[idx]], [text])


class XH_DynamicPromptJoin:
    """🔁 XH-提示词联结（动态）：N 路提示词按口序用间隔符拼成一段。

    与官方 StringConcatenate（写死 string_a/string_b 两口）的区别：
      · 输入口**动态增长** —— 前端检测到所有口都接上线后自动蹦出下一个空口（上限 12）；
      · 末尾多余空口自动收回，画布不留死槽；
      · 拼接只算「已连接且内容非空」的口，中间跳线不占序。

    🔴 动态口的后端契约（前端 addInput 的名字必须与此处 key 逐字一致）：
      prompt_0 / prompt_1   required + forceInput（常驻两口）
      prompt_2 .. prompt_11 optional + forceInput（前端按需显出）
      多出的 key 一律走 **kwargs 兜底（照 §13.1b 铁律：声明了就必收）。
    """

    MAX_INPUTS = 12

    @classmethod
    def INPUT_TYPES(cls):
        required = {
            "prompt_0": ("STRING", {"forceInput": True,
                                    "tooltip": "【💬 提示词 1】第 1 路提示词（连线接入）。 | English: Prompt 1 (wire in)."}),
            "prompt_1": ("STRING", {"forceInput": True,
                                    "tooltip": "【💬 提示词 2】第 2 路提示词。接上后自动蹦出「提示词 3」空口。 | English: Prompt 2; connecting it spawns Prompt 3."}),
        }
        optional = {}
        for i in range(2, cls.MAX_INPUTS):
            optional[f"prompt_{i}"] = ("STRING", {"forceInput": True,
                                                  "tooltip": f"【💬 提示词 {i + 1}】第 {i + 1} 路提示词（动态口，未接不占序）。 | English: Prompt {i + 1} (dynamic slot; skipped when unwired)."})
        required["delimiter"] = (
            "STRING",
            {
                "default": "/",
                "multiline": False,
                "tooltip": ("【➗ 间隔符】相邻两段之间插入的文本。\n"
                            "默认「/」；想换行拼接就填 \\n（自动转成真实换行）。 | English: Delimiter text between segments. "
                            "Default '/'. Type \\n for a real newline."),
            },
        )
        return {"required": required, "optional": optional}

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("prompt",)
    FUNCTION = "execute"
    CATEGORY = "🔁XH/链提示词"
    DESCRIPTION = (
        "【🔁XH-提示词联结（动态）】把 N 路提示词按口序用间隔符拼成一段。\n"
        "【动态增长】把「提示词2」接上线，节点立刻蹦出「提示词3」空口；再接再蹦，上限 12 路。\n"
        "【自动回收】末尾没用到的空口自动收回，不留死槽（常驻前 2 口）。\n"
        "【拼接规则】只拼「已连接且内容非空」的口，按口顺序；间隔符插在相邻两段之间。\n"
        "间隔符填 \\n 可换成换行拼接。\n"
        "比官方 Concatenate Text 强在：不用一层层套节点，一路口接到底。"
    )

    def execute(self, delimiter="/", **kwargs):
        # 间隔符宽容处理：空值 → 空串；字面 "\n" → 真实换行
        sep = delimiter if isinstance(delimiter, str) else ("/" if delimiter is None else str(delimiter))
        if sep == "\\n":
            sep = "\n"
        parts = []
        for i in range(self.MAX_INPUTS):
            v = kwargs.get(f"prompt_{i}")
            if isinstance(v, str) and v.strip():
                parts.append(v)
            elif v is not None and not isinstance(v, str):
                # API 直调时可能传来非字符串，宽容转字符串
                try:
                    s = str(v)
                    if s.strip():
                        parts.append(s)
                except Exception:
                    pass
        return (sep.join(parts),)


NODE_CLASS_MAPPINGS = {
    "XH_ChainPromptSelector": XH_ChainPromptSelector,
    "XH_DynamicPromptJoin": XH_DynamicPromptJoin,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "XH_ChainPromptSelector": "🔁XH-提示词表",
    "XH_DynamicPromptJoin": "🔁XH-提示词联结(动态)",
}


# ------------------------------------------------------------------ 文件夹模式路由（2026-10-12）
# 「🔁XH-提示词表」的「📂 文件夹」按钮靠这条路由预览段数（只读、不写盘）。
# 设计约束（与 image_tools/py/local_image_api.py 一致）：
#   · 只读、永不写盘；只认 .txt/.md 白名单；顺序 = 文件名自然排序；
#   · 注册失败只打日志，绝不影响包里其它节点（__init__.py 已 try 包住）。
_ROUTES_DONE = False


def register_routes():
    """把 /xh/promptlist/list 挂到 ComfyUI 的 aiohttp 路由上（幂等）。"""
    global _ROUTES_DONE
    if _ROUTES_DONE:
        return
    try:
        from aiohttp import web
        from server import PromptServer

        routes = PromptServer.instance.routes
        _TXT_EXT = {".txt", ".md", ".markdown"}

        def _natural_key(text):
            return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", text or "")]

        @routes.get("/xh/promptlist/list")
        async def _xh_promptlist_list(request):
            q = request.rel_url.query
            folder = (q.get("dir") or "").strip()
            if not folder:
                return web.json_response({"ok": False, "error": "缺少 dir 参数"}, status=400)
            root = os.path.abspath(folder)
            if not os.path.isdir(root):
                return web.json_response({"ok": False, "error": f"不是有效文件夹：{folder}"}, status=400)
            try:
                files = []
                for fn in os.listdir(root):
                    full = os.path.join(root, fn)
                    if os.path.isfile(full) and os.path.splitext(fn)[1].lower() in _TXT_EXT:
                        files.append((fn, full))
                files.sort(key=lambda t: _natural_key(t[0]))
                out = []
                for fn, full in files:
                    try:
                        with open(full, "r", encoding="utf-8-sig", errors="replace") as fh:
                            chars = len(fh.read().strip())
                    except OSError:
                        chars = 0
                    out.append({"name": fn, "path": full, "chars": chars})
                total = len(out)
                nonempty = sum(1 for o in out if o["chars"] > 0)
                return web.json_response({
                    "ok": True, "dir": root, "count": total, "nonempty": nonempty,
                    "files": out,
                    "order": [o["name"] for o in out if o["chars"] > 0],  # ★ 调用顺序预览：非空段文件名（与实际出图段序一致）
                })
            except Exception as e:
                return web.json_response({"ok": False, "error": str(e)}, status=400)

        _ROUTES_DONE = True
        print("[XH-提示词表] ✅ 本机文件夹提示词接口已注册：/xh/promptlist/list")
    except Exception as e:
        print(f"[XH-提示词表] ⚠️ 本机文件夹提示词接口注册失败"
              f"（「📂 文件夹」预览不可用，出图读取不受影响）：{e}")
