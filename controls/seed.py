# 🎲XH-种子（XH 家族）
#
# 复刻 rgthree-comfy 的 `Seed` 节点（py/seed.py + web/comfyui/seed.ts，2026-10-09 逐行核对源码）。
# 核心机制照搬：**种子在"前端排队瞬间"就被换成真种子**——
#   · 存档里永远是 -1（= 每次随机），下次出图又是新种子；
#   · 排队时前端把 -1 换成真种子，同时改 **API prompt** 和 **工作流存档**，
#     ⇒ 出图元数据里记录的是真种子（官方原生 seed 的 control_after_generate 做不到这点）。
#   · 特殊值：-1 = 每次随机 / -2 = 上次+1 / -3 = 上次-1（后端同样兜底，走 API 直连也能出图）。
#
# 比 rgthree 原版多做的事（都不改变接口）：
#   · `last_seed` 存进 node.properties ⇒ **重启后"♻️ 用上次的种子"还在**（原版只在会话内存里）；
#   · 子图内的 widgets_values 回写也做了（extra_pnginfo.definitions.subgraphs）；
#   · 随机数状态隔离：只动自己的随机状态，不污染 ComfyUI 全局 random 序列
#     （照抄 rgthree 的 initial_random_state 保护写法）。
#
# 家族规范：class_type 与 web/xh_seed.js 里的判断名必须逐字一致（"XHSeed"）。

import random
from datetime import datetime

# 随机状态隔离：模块加载时用当前时间重播种一份**私有**状态，
# 避免某些扩展把全局 random 播成固定值导致"随机"出重复种子（rgthree 注释里的原坑）。
_initial_state = random.getstate()
random.seed(datetime.now().timestamp())
_xh_seed_random_state = random.getstate()
random.setstate(_initial_state)

MAX_SEED = 1125899906842624  # 2^50，与 rgthree / 官方一致

SPECIAL_SEED_RANDOM = -1
SPECIAL_SEED_INCREMENT = -2
SPECIAL_SEED_DECREMENT = -3


def new_random_seed():
    """从私有状态取一个新随机种子，不污染全局 random 序列。"""
    global _xh_seed_random_state
    prev_state = random.getstate()
    random.setstate(_xh_seed_random_state)
    seed = random.randint(1, MAX_SEED)
    _xh_seed_random_state = random.getstate()
    random.setstate(prev_state)
    return seed


class XHSeed:
    """🎲XH-种子：输出 INT 种子。-1=每次随机 / -2=上次+1 / -3=上次-1。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "seed": ("INT", {
                    "default": 0,
                    "min": -MAX_SEED,
                    "max": MAX_SEED,
                    # 🔴 min/max 必须显式写（家族教训：默认 0~2048，负数填不进）
                    "tooltip": "【🎲 种子】-1=每次出图都随机（推荐，节点上默认就是这个）；\n"
                               "-2=上次种子+1；-3=上次种子-1；\n"
                               "填具体数字=固定种子（复现用）。\n"
                               "English: -1=randomize each run, -2=last+1, -3=last-1, or a fixed number.",
                }),
            },
            "hidden": {
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
                "unique_id": "UNIQUE_ID",
            },
        }

    RETURN_TYPES = ("INT",)
    RETURN_NAMES = ("SEED",)
    FUNCTION = "main"
    CATEGORY = "🔁XH/工具"
    DESCRIPTION = ("【🎲XH-种子】复刻 rgthree 的 Seed。-1=每次随机 / -2=上次+1 / -3=上次-1，"
                   "排队瞬间换真种子、出图元数据记录真种子；last_seed 存档可跨重启复用。")

    @classmethod
    def IS_CHANGED(cls, seed, prompt=None, extra_pnginfo=None, unique_id=None):
        """特殊种子时强制判定为"已变化"，保证每批都重跑（照抄 rgthree）。"""
        if seed in (SPECIAL_SEED_RANDOM, SPECIAL_SEED_INCREMENT, SPECIAL_SEED_DECREMENT):
            return new_random_seed()
        return seed

    def main(self, seed=0, prompt=None, extra_pnginfo=None, unique_id=None):
        # 正常从前端排队时，js 已在 api.queuePrompt 之前把 -1/-2/-3 换成真种子，
        # 这里只会收到真数字。走到特殊值 = 走 API 直连 / 前端没拦截，兜底生成并写回元数据。
        if seed in (SPECIAL_SEED_RANDOM, SPECIAL_SEED_INCREMENT, SPECIAL_SEED_DECREMENT):
            print(f"[🎲XH-种子] ⚠ 收到特殊种子 {seed}（前端没换真种子，走后端兜底）。"
                  f"注意：重复排队会拿到同一个兜底种子，且不会被缓存。建议从前端排队。")
            original_seed = seed
            seed = new_random_seed()
            print(f"[🎲XH-种子] 兜底生成随机种子 {seed}")

            # ① 写回 API prompt（出图元数据里记录真种子）
            if unique_id is not None and prompt is not None:
                node = prompt.get(str(unique_id)) if isinstance(prompt, dict) else None
                inputs = node.get("inputs") if isinstance(node, dict) else None
                if isinstance(inputs, dict) and "seed" in inputs:
                    inputs["seed"] = seed

            # ② 写回工作流存档 widgets_values（顶层 + 子图内部，尽力而为）
            if unique_id is not None and extra_pnginfo is not None:
                wf = (extra_pnginfo or {}).get("workflow") or {}
                wf_nodes = list(wf.get("nodes") or [])
                for sg in ((wf.get("definitions") or {}).get("subgraphs") or []):
                    wf_nodes.extend(sg.get("nodes") or [])
                for n in wf_nodes:
                    wv = n.get("widgets_values")
                    if isinstance(wv, list):
                        for i, v in enumerate(wv):
                            if v == original_seed:
                                wv[i] = seed
                # ③ last_seed 也存档，前端重启后"♻️ 用上次的种子"仍可用
                #    ⚠ 子图内的节点 unique_id 形如 "实例id:内部id"，按后缀匹配（跟前端 js 同一套规则）
                uid = str(unique_id)
                for n in wf_nodes:
                    nid = str(n.get("id"))
                    if nid == uid or uid.endswith(":" + nid):
                        props = n.get("properties")
                        if isinstance(props, dict):
                            props["last_seed"] = seed

        return (seed,)


NODE_CLASS_MAPPINGS = {"XHSeed": XHSeed}
NODE_DISPLAY_NAME_MAPPINGS = {"XHSeed": "🎲XH-种子"}
