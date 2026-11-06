# 📷 XH-机位描述
# 把「方位角 / 俯仰角 / 变焦」三个数值翻译成一段英文镜头描述词 + 一个官方格式 camera_info，
# 直接接进 H3 / 文生图提示词当镜头语言；camera_info 口可接官方 3D 节点。
#
# 角度→文案的映射逻辑**逐字搬运**自 ComfyUI 官方节点 CameraAngle
# （comfy_extras/nodes_camera_angle.py 的 describe_camera_angle），
# camera_info 构造与官方 build_camera_info 逐字段一致（target=原点、distance=6、fov=35）。
# 3D 预览 = 白嫖官方前端 CAMERA_ANGLE_VIEW 控件（widgetType 标记），拖拽实时改参数。
#
# 两种用法（mode 开关控制，放在原三个滑块之后，避免旧图错位）：
#   · 自定义：自己拖 方位角 / 俯仰角 / 变焦 三个滑块，自由组合任意机位。
#   · 预设机位：从内置常用机位里直接挑一个（滑块自动隐藏），适合快速出分镜。
#
# 双输出：prompt（英文，喂 H3 / 文生图提示词）+ camera_info（官方格式，接官方 3D 节点）。

import math

# ---- 内置常用机位预设（非自定义模式用）----
# 命名规则：方位 · 俯仰 · 景别；值 = (方位角 ha, 俯仰角 va, 变焦 z)
#   va 取 -20 才真正落到 low-angle（官方规则：va < -15 才是仰拍）
#   va 取 45/60 落到 high-angle（俯拍）；va 0 附近为 eye-level（平视）
#   z 取 5 落在 medium（官方规则：2 ≤ z < 6 才是中景，z=6 会变成 close-up）
_PRESETS = {
    "正面·平视·远景":     (0,    0,   1.0),
    "正面·平视·中景":     (0,    0,   5.0),
    "正面·平视·特写":     (0,    0,  10.0),
    "正面·仰拍·特写":     (0,  -20,  10.0),
    "正面·俯拍·全景":     (0,   45,   1.0),
    "斜侧·平视·中景":     (45,   0,   5.0),
    "斜侧·俯拍·远景":     (45,  45,   1.0),
    "右侧·平视·中景":     (90,   0,   5.0),
    "左侧·平视·中景":     (270,  0,   5.0),
    "背面·平视·中景":     (180,  0,   5.0),
    "背面·仰拍·中景":     (180, -20,  5.0),
    "背面·特写":          (180,  0,  10.0),
    "俯拍·大全景(航拍)":  (0,   60,   0.0),
}
_PRESET_NAMES = list(_PRESETS.keys())


class XHCameraAnglePrompt:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                # —— 原三个滑块保持在最前面，旧图加载不会错位 ——
                "horizontal_angle": ("INT", {
                    "default": 0, "min": 0, "max": 360, "step": 1,
                    "tooltip": (
                        "方位角（绕主体水平转一圈，单位度）。\n"
                        "· 0 = 正前方\n"
                        "· 90 = 右侧\n"
                        "· 180 = 背后\n"
                        "· 270 = 左侧\n"
                        "每 45° 一个档，自动套成 front / right side / back / left 等词。"
                    ),
                }),
                "vertical_angle": ("INT", {
                    "default": 0, "min": -30, "max": 89, "step": 1,
                    "tooltip": (
                        "俯仰角（单位度）。\n"
                        "· 小于 -15 = 从下往上仰拍（low-angle shot）\n"
                        "· 0 附近 = 平视（eye-level shot）\n"
                        "· 大于 15 = 从上往下俯拍（elevated / high-angle shot）\n"
                        "注意：3D 预览球拖拽范围是官方限定的 -30~60；滑块可以填到 89，"
                        "超出部分预览显示会贴到 60，但输出的文案和 camera_info 是真实值。"
                    ),
                }),
                "zoom": ("FLOAT", {
                    "default": 5.0, "min": 0.0, "max": 10.0, "step": 0.1,
                    "tooltip": (
                        "镜头变焦（决定景别）。\n"
                        "· 0 附近 = 远景 wide shot\n"
                        "· 中段 = 中景 medium shot\n"
                        "· 10 = 特写 close-up"
                    ),
                }),
                # —— 模式开关 + 预设，放在最后，旧图安全 ——
                "mode": ("COMBO", {
                    "options": ["自定义", "预设机位"],
                    "default": "自定义",
                    "tooltip": (
                        "机位来源开关。\n"
                        "· 自定义：自己拖上面三个滑块，自由组合任意机位。\n"
                        "· 预设机位：从下方「预设机位」里直接挑一个（三个滑块会自动隐藏），"
                        "适合快速出分镜。"
                    ),
                }),
                "preset": ("COMBO", {
                    "options": _PRESET_NAMES,
                    "default": _PRESET_NAMES[0],
                    "tooltip": (
                        "内置常用机位预设（仅「预设机位」模式生效）。\n"
                        "命名规则：方位 · 俯仰 · 景别，例如「正面·仰拍·特写」。"
                    ),
                }),
            },
            # —— 官方同款 3D 预览（可拖拽轨道球）——
            # config 逐字段对齐官方 CameraAngle 的 node def JSON（object_info 实测）：
            #   "view": ["STRING", {"widgetType": "CAMERA_ANGLE_VIEW", "socketless": true, ...}]
            # 前端按 widgetType 找到官方注册的自定义控件，画出可拖拽的 3D 预览，
            # 并把拖拽结果写回本节点名为 horizontal_angle / vertical_angle / zoom 的滑块。
            "optional": {
                "image": ("IMAGE", {
                    "tooltip": "可选参考图：贴在 3D 预览主体立方体正面上（官方 CameraAngle 同款功能）。",
                }),
                "view": ("STRING", {
                    "default": "", "multiline": False,
                    "widgetType": "CAMERA_ANGLE_VIEW", "socketless": True,
                    "tooltip": "官方 3D 预览控件（拖拽轨道球直接调机位），不用管它。",
                }),
            },
        }

    RETURN_TYPES = ("STRING", "LOAD3D_CAMERA")
    RETURN_NAMES = ("prompt", "camera_info")
    FUNCTION = "generate"
    CATEGORY = "🔁XH/工具"
    DESCRIPTION = (
        "【干什么】一个「角度→镜头词」的翻译器：填方位角 / 俯仰角 / 变焦三个数，"
        "输出英文机位描述（prompt，喂 H3 / 文生图提示词）+ 官方格式 camera_info（可接官方 3D 节点）。\n"
        "【两种用法】· mode=自定义：拖三个滑块自由组合（0~360 方位 / -30~89 俯仰 / 0~10 变焦）。\n"
        "· mode=预设机位：从内置常用机位里直接挑（13 个），三个滑块会自动隐藏。\n"
        "【3D 预览】官方同款可拖拽轨道球：拖球实时改方位/俯仰/变焦，窗口右上角实时显示镜头词。\n"
        "【输出】prompt（英文 STRING）+ camera_info（与官方 CameraAngle 逐字段一致，接 Load 3D / Render Splat 等）。"
    )

    def generate(self, horizontal_angle, vertical_angle, zoom, mode, preset, image=None, view=None):
        # image：仅给 3D 预览贴图用，不参与计算；view：官方 3D 预览控件的状态位，忽略。
        if mode == "预设机位" and preset in _PRESETS:
            ha, va, z = _PRESETS[preset]
        else:
            ha, va, z = horizontal_angle, vertical_angle, zoom
        ha = max(0, min(360, int(ha)))
        va = max(-30, min(89, int(va)))
        z = max(0.0, min(10.0, float(z)))
        return (describe_camera_angle(ha, va, z), build_camera_info(ha, va, z))


# ---- 角度→文案映射（逐字搬运自 ComfyUI 官方 nodes_camera_angle.py，保证一致）----
_HORIZONTAL_TERMS = (
    "front view", "front-right quarter view", "right side view",
    "back-right quarter view", "back view", "back-left quarter view",
    "left side view", "front-left quarter view",
)
_VERTICAL_TERMS = (
    (-15, "low-angle shot"), (15, "eye-level shot"),
    (45, "elevated shot"), (None, "high-angle shot"),
)
_DISTANCE_TERMS = ((2, "wide shot"), (6, "medium shot"), (None, "close-up"))


def _bucket(value, terms):
    for upper, term in terms:
        if upper is None or value < upper:
            return term
    return terms[-1][1]


def horizontal_term(angle):
    sector = int(((angle % 360) + 22.5) // 45) % len(_HORIZONTAL_TERMS)
    return _HORIZONTAL_TERMS[sector]


def vertical_term(angle):
    return _bucket(angle, _VERTICAL_TERMS)


def distance_term(zoom):
    return _bucket(zoom, _DISTANCE_TERMS)


def describe_camera_angle(horizontal_angle, vertical_angle, zoom):
    return f"{horizontal_term(horizontal_angle)} {vertical_term(vertical_angle)} {distance_term(zoom)}"


# ---- camera_info 构造（逐字段对齐官方 nodes_camera_angle.build_camera_info）----
# 主体立方体在原点、相机距离 6、fov 35、透视投影；zoom 0~10 → 3D 数字变焦倍率 1.0~1.875。
# 复用 caminfo 子模块里已数值验证过的纯 Python look-at 实现（不 import torch，零依赖不变）。
from ..caminfo.camera_info_node import _lookat_camera_info, _zoom_to_factor  # noqa: E402

_SUBJECT_CENTER = (0.0, 0.0, 0.0)
_SUBJECT_DISTANCE = 6.0
_CAMERA_FOV = 35.0


def build_camera_info(horizontal_angle, vertical_angle, zoom):
    # 与官方 CameraAngle.build_camera_info 同公式：球面角 → 相机世界坐标，看向原点
    yaw, pitch = math.radians(horizontal_angle), math.radians(vertical_angle)
    cx, cy, cz = _SUBJECT_CENTER
    position = [
        cx + _SUBJECT_DISTANCE * math.cos(pitch) * math.sin(yaw),
        cy + _SUBJECT_DISTANCE * math.sin(pitch),
        cz + _SUBJECT_DISTANCE * math.cos(pitch) * math.cos(yaw),
    ]
    return _lookat_camera_info(
        position, list(_SUBJECT_CENTER), _CAMERA_FOV,
        _zoom_to_factor(zoom), "perspective", 0.0,
    )


NODE_CLASS_MAPPINGS = {"XHCameraAnglePrompt": XHCameraAnglePrompt}
NODE_DISPLAY_NAME_MAPPINGS = {"XHCameraAnglePrompt": "📷XH-机位描述"}
