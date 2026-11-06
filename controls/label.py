# XH 标签 (Nodes 2.0 兼容)
# 来源：XH_Label（2026-09-22 由 XiaoHei_Label 改名，同日并入 Toolbox）
# 纯前端节点：py 侧只注册空壳，界面由顶层 web/xh_label.js 画。
# 该节点画布上的标题刻意留空（由用户自己写），所以 js 里 this.title = "" 是正常的。


class XHLabel:
    """🏷️XH-标签：画布上的一块可自由编辑的便签（纯前端，逻辑全在 web/xh_label.js）。"""

    DESCRIPTION = (
        "【干什么】一块贴在画布上的便签 / 标签，用来给工作流写说明、分区或备注。\n"
        "【怎么配】节点内部自带工具条：📝 字号滑块、🎨 颜色、🔤 字体、🙈 隐藏标题、折叠。"
        "默认值随界面语言走（中/EN 按钮在工具条上）。\n"
        "【怎么用】放哪里都行，**不参与任何计算，没有输入也没有输出**，"
        "剪掉它流程照样跑。双击节点直接改文字。\n"
        "【输出】无。\n"
        "⚠️ 画布上的标题默认是**空的**（这是有意设计，标题留给你自己写），"
        "新拖出来的节点看上去「没有名字」属正常，不是显示名丢了。"
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}}

    RETURN_TYPES = ()
    FUNCTION = "noop"
    CATEGORY = "🔁XH/工具"
    OUTPUT_NODE = True

    def noop(self):
        return ()


NODE_CLASS_MAPPINGS = {"XHLabel": XHLabel}
# 显示名带 XH- 才能在菜单里跟家族归堆；画布上的标题仍由 js 清空，不影响用户自己起名字
NODE_DISPLAY_NAME_MAPPINGS = {"XHLabel": "🏷️XH-标签"}
