# XH-LoRA堆栈 —— Nodes 2.0 原生的多 LoRA 加载器
# 数据走单个标准 STRING widget（loras_json），UI 走单个 addDOMWidget（serialize:false）。
# 全程不碰 node.widgets 数组的增删/排序 —— Nodes 2.0 Vue 渲染下唯一稳的做法。
import json
import traceback

import folder_paths
from nodes import LoraLoader

# 分类遵循 XH 家族规范：🔁XH/<类别>（见 xh_style.md 第二节）
CATEGORY_TYPE = "🔁XH/Model"
NODE_CLASS_NAME = "XHPowerLoraStack"
DISPLAY_NAME = "🔁XH-LoRA堆栈"
DISPLAY_NAME_EN = "🔁XH-LoRA Stack"

try:
    from server import PromptServer
    from aiohttp import web

    _ps = PromptServer.instance
    if _ps is not None and hasattr(_ps, "routes"):
        _routes = _ps.routes

        @_routes.get("/xh_lorastack/loras")
        async def _xh_pll_list_loras(request):
            try:
                files = folder_paths.get_filename_list("loras")
            except Exception:
                files = []
            return web.json_response({"loras": files})

        @_routes.get("/xh_lorastack/preview_info")
        async def _xh_pll_preview_info(request):
            # 占位接口：预留 lora 元信息（触发词等）扩展，先返回空
            return web.json_response({"info": {}})
except Exception:
    traceback.print_exc()


class XHPowerLoraStack:
    """多 LoRA 堆栈加载：前端 DOM UI 编辑一个 JSON 字符串，后端逐个套用 LoraLoader。"""

    NAME = NODE_CLASS_NAME
    CATEGORY = CATEGORY_TYPE
    DESCRIPTION = (
        "【干什么】一串 LoRA 按顺序叠着加载：前端用一排卡片管理（开关 / 强度 / 排序 / 删除），"
        "后端依次套官方 LoRA 加载器，省得手动串一长串 LoadLora 节点。\n"
        "【怎么配】· loras_json：数据载体，由界面自动写，**一般不用手动改**\n"
        "· model：主干模型；clip：文本编码器（可空，传空时 CLIP 强度自动按 0 处理）\n"
        "· 界面上每条 LoRA 可以单独设 model 强度和 clip 强度\n"
        "【怎么用】替代一长串 LoraLoader 链；哪个 LoRA 不合适直接在节点上关掉，不必断线重连。\n"
        "【输出】MODEL、CLIP（都是串完所有 LoRA 之后的结果）。\n"
        "⚠️ 顺序=生效顺序，**排在后面的影响更大**；同一份权重叠两次是允许的效果加倍。\n"
        "⚠️ 文件找不到的那条只会在控制台警告并跳过，不会中断整条链。\n"
        "⚠️ 你的 LoRA 里如果带文本编码器（TE）权重就必须接 clip；"
        "只训主干的 LoRA（H3/LightX2V 系基本都是）用不带 clip 的版本结果一样。"
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                # 唯一的数据载体：标准 STRING widget，进存档 + 进 prompt，序列化天然无错位
                "loras_json": (
                    "STRING",
                    {
                        "default": "[]", "multiline": False, "advanced": True,
                        "tooltip": (
                            "LoRA 清单（JSON），由节点上的卡片界面自动生成，**通常不用手动编辑**。\n"
                            "每条形如：`{\"lora\":\"文件名\",\"on\":true,\"strength\":0.8,\"strength_clip\":0.8}`\n"
                            "⚠️ 手改 JSON 写坏了会按空列表处理，并在控制台提示。"
                        ),
                    },
                ),
            },
            "optional": {
                "model": ("MODEL", {
                    "tooltip": "主干模型。多条 LoRA 会依次套在它上面，最终从这里输出。",
                }),
                "clip": ("CLIP", {
                    "tooltip": (
                        "文本编码器。**没接时 CLIP 强度自动按 0 处理**，只有主干会被改动。\n"
                        "⚠️ LoRA 里带 TE（文本编码器）权重的话必须接上，否则那部分权重等于白加载。"
                    ),
                }),
            },
        }

    RETURN_TYPES = ("MODEL", "CLIP")
    RETURN_NAMES = ("MODEL", "CLIP")
    FUNCTION = "load_loras"

    def load_loras(self, loras_json="[]", model=None, clip=None):
        try:
            items = json.loads(loras_json or "[]")
        except Exception:
            print("[XH-LoRA堆栈] loras_json 不是合法 JSON，按空处理")
            items = []
        if not isinstance(items, list):
            items = []
        for item in items:
            if not isinstance(item, dict):
                continue
            if not item.get("on", True):
                continue
            name = item.get("lora") or ""
            if not name:
                continue
            try:
                sm = float(item.get("strength", 1.0))
            except (TypeError, ValueError):
                sm = 1.0
            try:
                sc = float(item.get("strength_clip", sm))
            except (TypeError, ValueError):
                sc = sm
            if clip is None:
                sc = 0.0
            if sm == 0.0 and sc == 0.0:
                continue
            path = folder_paths.get_full_path("loras", name)
            if path is None:
                print(f"[XH-LoRA堆栈] ⚠️ 找不到 LoRA 文件，已跳过: {name}")
                continue
            # 注意：ComfyUI 的 LoraLoader.load_lora 内部会自己用 get_full_path_or_raise
            # 再解析一次，只认 loras 目录下的【相对名】，不认绝对路径。
            # 所以这里必须传相对名 name，不能传绝对路径 path，否则会 FileNotFoundError。
            model, clip = LoraLoader().load_lora(model, clip, name, sm, sc)
        return (model, clip)


# ======================================================================
# 纯 LoRA 堆栈（2026-10-02 新增，与上面并存，XHPowerLoraStack 一字未动）
# 唯一差别：**没有 clip 口** —— clip 恒为 None，只套用 UNet 侧权重。
# 适用：只训了 UNet 的 LoRA（加速 / Turbo 类），结果与完整版完全一致。
# ======================================================================
NODE_CLASS_NAME_PURE = "XHPureLoraStack"
DISPLAY_NAME_PURE = "🔁XH-纯LoRA堆栈"
DISPLAY_NAME_EN_PURE = "🔁XH-Pure LoRA Stack"


class XHPureLoraStack:
    """多 LoRA 堆栈加载（纯模型版）：只应用 UNet 侧权重，完全不碰文本编码器。

    LoRA 文件里的 lora_te*（文本编码器）权重一律静默忽略 —— 不应用、不报错、不打印。
    """

    NAME = NODE_CLASS_NAME_PURE
    CATEGORY = CATEGORY_TYPE
    DESCRIPTION = (
        "【干什么】🔁XH-LoRA堆栈 的「只有模型」版本：**不接 CLIP、也不改文本编码器**，"
        "只把 LoRA 的主干权重套到 MODEL 上。\n"
        "【怎么配】· loras_json：与完整版同款数据载体，界面自动生成\n"
        "· model：主干模型（这里是必需口，没有它节点无事可做）\n"
        "【怎么用】给只训了主干的 LoRA 用（**H3 / LightX2V 系加速 LoRA 基本都是这一类**）："
        "结果和完整版完全一致，但线更少、更不容易接错。\n"
        "【输出】MODEL。\n"
        "⚠️ 文件里带 TE（文本编码器）权重的那一部分会被**静默忽略** —— 不应用、不报错、不打印。"
        "如果你的 LoRA 属于这一类（极少见），请改用带 clip 的 🔁XH-LoRA堆栈。\n"
        "⚠️ 「要不要 clip」不看触发词、只看**文件里有没有 TE 权重**；拿不准就跑一次张量名扫描。"
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                # 唯一的数据载体，与完整版同款 STRING widget，存档/序列化链路完全一致
                "loras_json": (
                    "STRING",
                    {
                        "default": "[]", "multiline": False, "advanced": True,
                        "tooltip": (
                            "LoRA 清单（JSON），由节点上的卡片界面自动生成，**通常不用手动编辑**。\n"
                            "每条 `{lora, on, strength}` —— 纯版**没有 strength_clip**，"
                            "写了也会被忽略（不碰 CLIP）。\n"
                            "⚠️ 手改写坏了会按空列表处理，并在控制台提示。"
                        ),
                    },
                ),
                # 纯版没有 clip 输入口，所以 model 必须是必需口，否则节点无事可做
                "model": ("MODEL", {
                    "tooltip": (
                        "主干模型。多条 LoRA 依次套在它上面后原样输出。\n"
                        "⚠️ 本节点不接 CLIP，提示词侧完全不受影响。"
                    ),
                }),
            },
        }

    RETURN_TYPES = ("MODEL",)
    RETURN_NAMES = ("MODEL",)
    FUNCTION = "load_loras"

    def load_loras(self, loras_json="[]", model=None):
        try:
            items = json.loads(loras_json or "[]")
        except Exception:
            print("[XH-纯LoRA堆栈] loras_json 不是合法 JSON，按空处理")
            items = []
        if not isinstance(items, list):
            items = []
        if model is None:
            return (model,)
        for item in items:
            if not isinstance(item, dict):
                continue
            if not item.get("on", True):
                continue
            name = item.get("lora") or ""
            if not name:
                continue
            try:
                sm = float(item.get("strength", 1.0))
            except (TypeError, ValueError):
                sm = 1.0
            if sm == 0.0:
                continue
            path = folder_paths.get_full_path("loras", name)
            if path is None:
                print(f"[XH-纯LoRA堆栈] ⚠️ 找不到 LoRA 文件，已跳过: {name}")
                continue
            # 只碰 model：clip 传 None、strength_clip 传 0.0
            # → comfy.sd.load_lora_for_models 里的 `if clip is not None` 不成立，
            #   clip 侧 key_map 根本不建，LoRA 里的 lora_te* 权重自动落空（静默忽略）。
            # 传相对名 name（不是绝对路径 path）：LoraLoader 内部会自己再解析一次。
            model, _ = LoraLoader().load_lora(model, None, name, sm, 0.0)
        return (model,)
