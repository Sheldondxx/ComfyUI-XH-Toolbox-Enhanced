from .nodes import (
    NODE_CLASS_MAPPINGS,
    NODE_DISPLAY_NAME_MAPPINGS,
    register_routes,
)

# 🔴 必须声明 WEB_DIRECTORY，否则 web/ 下的前端 js 全程不会被加载
#    （节点上的「中/EN」和「🔄 刷新框数」两个按钮就都不会出现）
WEB_DIRECTORY = "web"

__all__ = [
    "NODE_CLASS_MAPPINGS",
    "NODE_DISPLAY_NAME_MAPPINGS",
    "WEB_DIRECTORY",
]

# 2026-09-30 起框数已改为节点自身参数，不再需要后端路由；register_routes() 现在是空函数，
# 这里保留调用仅为兼容 nodes.py 里对该函数的引用（不影响任何功能）。
register_routes()
