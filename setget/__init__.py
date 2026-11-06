"""🔁 XH Set / Get —— Python 端仅 noop 占位（共 4 个类型）。

真正的节点行为（单路 1 对 1 / 多路 1 对多广播、动态通道、类型自动跟随、与 KJ 互通）
由前端虚拟节点 `web/xh_setget.js` 通过 registerCustomNodes + LiteGraph.registerNodeType 接管。

这里只提供 NODE_CLASS_MAPPINGS，让 ComfyUI 后端 /object_info 里有这四个类型，
节点库搜索框才能搜到它们（节点库数据源是后端 object_info）。

⚠️ 不要在这里给 INPUT_TYPES 写真实端口：前端虚拟节点会自己定义 inputs/outputs，
   后端端口声明只用于 object_info 展示，写多了反而和实际不符。
⚠️ 前端虚拟节点带 isVirtualNode=true ⇒ 出图时**不进 prompt**：官方前端会把
   「下游 ← 虚拟节点输出口」的连接，用 resolveVirtualOutput / getInputLink 钩子
   直接接到真正的源节点上。所以这里**不需要**任何执行函数。
"""


class XHSet_Noop:
    """Python 端占位：真正的单路设置节点由 web/xh_setget.js 的虚拟节点接管。"""

    CATEGORY = "🔁XH/SetGet"
    DESCRIPTION = (
        "【干什么】给一个值取个名字挂起来，画布另一端用同名「获取」就能直接取到。\n"
        "【怎么用】把要复用的输出接到它的输入口，然后在名字框里写个名字（连上时若还空着会自动借用上游口名）。\n"
        "【输出】右边那个口是**透传**：接进来的东西原样送出去，方便顺手往下串。\n"
        "【互通】跟 KJNodes 的 Set/Get 是同一套官方机制，两边可以混用（XH 的获取能取 KJ 设置的值）。\n"
        "⚠️ Python 侧是空壳占位，真正的端口由前端定义；配对的获取要写同一个名字。"
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}}

    RETURN_TYPES = ()
    RETURN_NAMES = ()
    FUNCTION = "set"

    def set(self):
        return ()


class XHGet_Noop:
    """Python 端占位：真正的单路获取节点由 web/xh_setget.js 的虚拟节点接管。"""

    CATEGORY = "🔁XH/SetGet"
    DESCRIPTION = (
        "【干什么】把某个名字的「设置」挂起来的值，在这里取出来用。\n"
        "【怎么配】在名字框里写上与设置端**完全一样**的名字；右键菜单里能直接点选当前可用的名字。\n"
        "【怎么用】消灭画布上的长距离飞线 —— 一次发出，各处按需取用。\n"
        "【互通】也能取 KJNodes「Set」挂的值（互通，不用改 KJ）。\n"
        "⚠️ 找不到同名的设置端（或名字写错）时，这个口取到的是空值。\n"
        "⚠️ Python 侧是空壳占位，真正的端口由前端定义。"
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}}

    RETURN_TYPES = ()
    RETURN_NAMES = ()
    FUNCTION = "get"

    def get(self):
        return ()


class XHMultiSet_Noop:
    """Python 端占位：真正的多路设置节点由 web/xh_setget.js 的虚拟节点接管。"""

    CATEGORY = "🔁XH/SetGet"
    DESCRIPTION = (
        "【干什么】一对多广播：多个值从这一个节点进去，各自取个名字，所有同名的获取都能拿到。\n"
        "【怎么配】节点上可以随时「+ 通道」加出更多条独立通道，每条通道有自己的名字与颜色。\n"
        "【怎么用】用来消灭画布上的长距离飞线 —— 一次发出，各处按需取用。\n"
        "典型场景：把采样器 / LoRA 汇出来的模型、条件、潜空间一次性发给好几个分支。\n"
        "【端口】每个通道一个数据输入口（由前端虚拟节点动态生成）。\n"
        "⚠️ Python 侧是空壳占位；配对的获取要取同一个通道名。"
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}}

    RETURN_TYPES = ()
    RETURN_NAMES = ()
    FUNCTION = "set"

    def set(self):
        return ()


class XHMultiGet_Noop:
    """Python 端占位：真正的多路获取节点由 web/xh_setget.js 的虚拟节点接管。"""

    CATEGORY = "🔁XH/SetGet"
    DESCRIPTION = (
        "【干什么】一个节点上放出多个名字，分别接走对应的设置端挂的值。\n"
        "【怎么配】通道数跟着对应设置端走；可以用「+ 通道」加，也可以在右键菜单里一点直接把某个名字加成一路。\n"
        "【怎么用】和「多路设置」**用同一个通道名**配对使用，画布上就不用拉长线了。\n"
        "【端口】每个通道一个输出口（由前端虚拟节点动态生成），类型自动跟随对应的设置端。\n"
        "⚠️ 找不到配对的设置端（或通道名对不上）时取到的是空值。\n"
        "⚠️ Python 侧是空壳占位，真正的端口由前端定义。"
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}}

    RETURN_TYPES = ()
    RETURN_NAMES = ()
    FUNCTION = "get"

    def get(self):
        return ()


NODE_CLASS_MAPPINGS = {
    "XHSet": XHSet_Noop,
    "XHGet": XHGet_Noop,
    "XHMultiSet": XHMultiSet_Noop,
    "XHMultiGet": XHMultiGet_Noop,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "XHSet": "设置",
    "XHGet": "获取",
    "XHMultiSet": "多路设置",
    "XHMultiGet": "多路获取",
}
