"""🔀XH-H3LTX-Adapter

NVIDIA H3 -> LTX-2.5 latent adapter (Sol-H3-Spark) 的 ComfyUI 封装节点。

    🔀XH-H3LTX-适配器加载   H3LTXAdapterLoader
    🔀XH-H3LTX-转换         H3LTXAdapterConvert

Model : MATLOWAI / Efficient-Large-Model  H3-to-LTX-Latent-Adapter
Source: NVlabs/Sana @ 144085566a866f9784f3798d4c8d1603f3adbccf

⚠️ class_type 键仍是 H3LTXAdapterLoader / H3LTXAdapterConvert（不改），
   已存工作流不受影响。只有显示名与分类是 XH 风格。
   中/EN 语言切换由 web/xh_h3ltx_lang.js 注入。
"""

from .nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS

WEB_DIRECTORY = "web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
