# 📺XH-显示文本（XH 家族）
#
# 仿 comfyui-custom-scripts（pysssss）的 `ShowText|pysssss` 做的 XH 版（2026-10-09 读本地源码核对）。
# **机制与官方逐字一致**（这是它唯一正确的做法，别"优化"掉任何一条）：
#   ① `text` 用 forceInput —— 只当输出口用，不给手动填写的框；
#   ② INPUT_IS_LIST + OUTPUT_IS_LIST —— 官方同款，接什么都能过（字符串 / 列表都行）；
#   ③ OUTPUT_NODE = True —— 它是"终点"节点，跑流程时必须执行它，画面才会把文本刷出来；
#   ④ 执行时把收到的 text **回写进工作流存档**（`node["widgets_values"] = [text]`）——
#      这样保存工作流后重开，上次显示的内容还在（前端 onConfigure 从存档恢复）；
#   ⑤ 返回 `{"ui": {"text": text}, "result": (text,)}` —— ui 部分给前端 onExecuted 刷显示，
#      result 照原样传出去 ⇒ 可以串在链路中间当"窥视口"，不影响下游。
#
# 比官方多做的事（都不改机制）：
#   · 中文显示名 + 端口中英切换（家族 i18n，见 web/xh_show_text.js）；
#   · 节点上自带 📋 复制按钮 —— 一键把当前显示的文本拷进剪贴板（官方是靠前端自带的角标，不明显）；
#   · 显示文本框样式统一成家族风（只读、淡显、等宽换行）。
#
# 🔴 家族规范：class_type 与 web/xh_show_text.js 里的 NODE_TYPE 必须逐字一致。
# ⚠ 照抄提醒：hidden 里的 unique_id / extra_pnginfo 必须原样保留，
#   少了任何一个，"重开工作流还能看到上次文本"就失效（其余功能不受影响）。


class XHShowText:
    """把链路上任意字符串显示在节点上（只读），并可原样传给下游 —— Show Text 的 XH 版。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "text": ("STRING", {"forceInput": True}),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
                "extra_pnginfo": "EXTRA_PNGINFO",
            },
        }

    INPUT_IS_LIST = True
    RETURN_TYPES = ("STRING",)
    FUNCTION = "notify"
    OUTPUT_NODE = True
    OUTPUT_IS_LIST = (True,)

    CATEGORY = "🔁XH/工具"
    DESCRIPTION = (
        "【干什么】把链路上任意字符串**显示在节点上**（只读），并原样传给下游。\n"
        "【怎么用】· 接 🔁XH-色调补偿 的 info 口看补偿参数；接表达式求值 / 分段表 / 提示词表看运行结果；\n"
        "· 它是 OUTPUT_NODE：链路末端光有它也能跑 —— 想只看内容不用出图时，拿它当终点。\n"
        "【输出】STRING：收到的文本原样传出（列表进列表出），串在中间不影响下游。\n"
        "【存档】显示的内容会写进工作流存档 ⇒ 保存后重开，上次显示还在。\n"
        "⚠️ 文本只在**跑的时候**刷新 —— 改了上游没重跑，这里还是旧内容，不是坏了。"
    )

    def notify(self, text, unique_id=None, extra_pnginfo=None):
        # 与官方 ShowText|pysssss 逐字一致的存档回写逻辑
        if unique_id is not None and extra_pnginfo is not None:
            if not isinstance(extra_pnginfo, list):
                print("Error: extra_pnginfo is not a list")
            elif (
                not isinstance(extra_pnginfo[0], dict)
                or "workflow" not in extra_pnginfo[0]
            ):
                print("Error: extra_pnginfo[0] is not a dict or missing 'workflow' key")
            else:
                workflow = extra_pnginfo[0]["workflow"]
                node = next(
                    (x for x in workflow["nodes"] if str(x["id"]) == str(unique_id[0])),
                    None,
                )
                if node:
                    node["widgets_values"] = [text]

        return {"ui": {"text": text}, "result": (text,)}


NODE_CLASS_MAPPINGS = {"XHShowText": XHShowText}
NODE_DISPLAY_NAME_MAPPINGS = {"XHShowText": "📺XH-显示文本"}
