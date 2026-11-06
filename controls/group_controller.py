# XH 分组控制器
# 来源：XH_GroupController（2026-09-22 由 XiaoHei_GroupController 改名，同日并入 Toolbox）
# 纯前端节点：py 侧只注册空壳，界面由顶层 web/xh_group.js 画。
# 注意 class 名与 class_type 必须同名（前端 js 用 nodeData.name !== NODE_TYPE 判断）。


class XHGroupController:
    """分组控制：在画布上给一组节点做整体开关/分组管理（界面在 web/xh_group.js）。"""

    DESCRIPTION = (
        "【干什么】一个「组开关」：把若干条通路接到它上面，由界面上的按钮统一控制这一组的通断 / 顺序，"
        "用来快速对比同一套工作流里不同分支的效果。\n"
        "【怎么配】· opt：任意类型（*）的可选输入，接什么都不会改写数据\n"
        "【怎么用】节点上的界面列出接进来的每一路，点一下就能把那一路单独拎出来跑。"
        "适合「几个采样器 / 几套提示词换着试」的场景。\n"
        "【输出】OPT_CONNECTION（*）：原样透传，**不做任何处理**。\n"
        "⚠️ 它是纯控制用的便利节点，删掉不影响主干逻辑。"
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}, "optional": {"opt": ("*", {
            "raw": True,
            "tooltip": (
                "任意类型的透传口：接进来什么值，输出就是什么值，**本节点不做任何计算**。\n"
                "它的作用是让你能在界面上按组切换这一路要不要往下参与。"
            ),
        })}}

    RETURN_TYPES = ("*",)
    RETURN_NAMES = ("OPT_CONNECTION",)
    FUNCTION = "noop"
    CATEGORY = "🔁XH/工具"
    OUTPUT_NODE = True

    def noop(self, opt=None):
        return (None,)


NODE_CLASS_MAPPINGS = {"XHGroupController": XHGroupController}
NODE_DISPLAY_NAME_MAPPINGS = {"XHGroupController": "🔁XH-分组控制"}
