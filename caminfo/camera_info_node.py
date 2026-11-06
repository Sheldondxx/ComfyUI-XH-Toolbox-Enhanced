# 🎥 XH-相机参数（V3 节点）
# XH 家族版的官方 CreateCameraInfo —— **结构与官方逐字对应**（2026-10-11 深夜重写）：
#   · mode 用官方同款 DynamicCombo（orbit / look_at / quaternion 三模式全保留），
#     因为官方前端 3D 视口（网格地面 + 立方体场景，Load3D 同款）只认 DynamicCombo 的
#     子控件命名（mode.yaw / mode.pitch / mode.distance / mode.position_* / mode.quat_*），
#     普通平铺参数它根本不认 —— 之前用平铺 yaw/pitch + CameraAngle 轨道球是抄错了控件。
#   · optional 的 camera_info_state（IO.CameraInfoState，socketless）= 官方 3D 场景视口本体，
#     名字/类型逐字对齐官方，官方前端自动挂上可拖拽 3D 场景并回写参数。
#   · zoom 改回官方语义（数字变焦倍率 0.01~100，默认 1.0，>1 拉近不移动相机）——
#     与官方视口的 dolly 手势一致；不再用「景别 0~10」自定义语义（会和官方控件打架）。
#   · 保留的 XH 优化：全中文 tooltip、额外输出 camera_json（人读/复制用字符串）、
#     家族工具条（中/EN + 🎨，见 web/xh_caminfo.js）。
#
# 零第三方依赖：camera_info 字典用纯 Python（math + json）构造，不碰 torch。
# 字典格式与官方 nodes_gaussian_splat 的 _lookat_camera_info / _quat_camera_info 逐字段一致。

import json
import math

from comfy_api.latest import IO


# ---- 纯 Python 复刻官方 nodes_gaussian_splat 的四元数 / look-at（wxyz），含 roll 滚转 ----

def _vsub(a, b):
    return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]


def _vnorm(a):
    n = math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2])
    return [a[0] / n, a[1] / n, a[2] / n] if n > 0 else [0.0, 0.0, 0.0]


def _vcross(a, b):
    return [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]


def _quat_mul_wxyz(a, b):
    # Hamilton product a ⊗ b，四元数均为 wxyz 顺序
    aw, ax, ay, az = a
    bw, bx, by, bz = b
    return [
        aw * bw - ax * bx - ay * by - az * bz,
        aw * bx + ax * bw + ay * bz - az * by,
        aw * by - ax * bz + ay * bw + az * bx,
        aw * bz + ax * by - ay * bx + az * bw,
    ]


def _quat_to_mat_wxyz(q):
    # wxyz 四元数 → 3x3 旋转矩阵（行优先，逐字对齐官方 nodes_gaussian_splat._quat_to_mat）
    n = math.sqrt(q[0] ** 2 + q[1] ** 2 + q[2] ** 2 + q[3] ** 2)
    w, x, y, z = (c / n for c in q) if n > 1e-12 else (1.0, 0.0, 0.0, 0.0)
    return [
        [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
        [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
        [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
    ]


def _mat_to_quat_wxyz(m):
    # 旋转矩阵（行优先 3x3）→ wxyz 四元数；取数值最稳的候选分支，与官方 _mat_to_quat 对齐
    m00, m01, m02 = m[0]
    m10, m11, m12 = m[1]
    m20, m21, m22 = m[2]
    q2 = [1 + m00 + m11 + m22, 1 + m00 - m11 - m22,
          1 - m00 + m11 - m22, 1 - m00 - m11 + m22]
    cand = [
        [q2[0], m21 - m12, m02 - m20, m10 - m01],
        [m21 - m12, q2[1], m10 + m01, m02 + m20],
        [m02 - m20, m10 + m01, q2[2], m12 + m21],
        [m10 - m01, m02 + m20, m12 + m21, q2[3]],
    ]
    sel = 0
    for i in range(1, 4):
        if q2[i] > q2[sel]:
            sel = i
    q = cand[sel]
    n = math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3])
    return [q[0] / n, q[1] / n, q[2] / n, q[3] / n] if n > 0 else [1.0, 0.0, 0.0, 0.0]


def _lookat_quat_wxyz(position, target):
    # three.js lookAt（右-handed, Y-up）：相机局部 +Z = eye - target，up = 世界 +Y → 返回 wxyz
    z = _vnorm(_vsub(position, target))
    up0 = [0.0, 1.0, 0.0]
    if abs(z[0] * up0[0] + z[1] * up0[1] + z[2] * up0[2]) > 0.999:
        up0 = [0.0, 0.0, 1.0]
    x = _vnorm(_vcross(up0, z))
    y = _vcross(z, x)
    R = [
        [x[0], y[0], z[0]],
        [x[1], y[1], z[1]],
        [x[2], y[2], z[2]],
    ]
    return _mat_to_quat_wxyz(R)


def _lookat_camera_info(position, target, fov, zoom, camera_type, roll=0.0):
    # 纯 Python 版，字典格式逐字对齐官方 comfy_extras.nodes_gaussian_splat._lookat_camera_info
    q = _lookat_quat_wxyz(position, target)
    if roll:  # 绕视线轴滚转（相机局部 Z）
        a = math.radians(roll)
        qz = [math.cos(a / 2), 0.0, 0.0, math.sin(a / 2)]
        q = _quat_mul_wxyz(q, qz)
    ci = {
        "position": {"x": float(position[0]), "y": float(position[1]), "z": float(position[2])},
        "target": {"x": float(target[0]), "y": float(target[1]), "z": float(target[2])},
        "quaternion": {"x": float(q[1]), "y": float(q[2]), "z": float(q[3]), "w": float(q[0])},
        "fov": float(fov),
        "cameraType": str(camera_type),
        "zoom": float(zoom),
    }
    if roll:
        ci["useCustomUp"] = True
    return ci


def _quat_camera_info(position, quat_xyzw, fov, zoom, camera_type):
    # 逐字对齐官方 _quat_camera_info：显式世界坐标 + 相机旋转四元数（three.js 局部 -Z 朝前看）
    qx, qy, qz, qw = (float(c) for c in quat_xyzw)
    qwxyz = [qw, qx, qy, qz]
    n = math.sqrt(sum(c * c for c in qwxyz))
    if n > 1e-8:
        qwxyz = [c / n for c in qwxyz]
    R = _quat_to_mat_wxyz(qwxyz)
    col2 = [R[0][2], R[1][2], R[2][2]]           # 相机局部 +Z 轴（背向）
    tgt = [position[0] - col2[0], position[1] - col2[1], position[2] - col2[2]]  # 沿局部 -Z 看一格
    return {
        "position": {"x": float(position[0]), "y": float(position[1]), "z": float(position[2])},
        "target": {"x": float(tgt[0]), "y": float(tgt[1]), "z": float(tgt[2])},
        "quaternion": {"x": float(qwxyz[1]), "y": float(qwxyz[2]), "z": float(qwxyz[3]), "w": float(qwxyz[0])},
        "useCustomUp": True,
        "fov": float(fov),
        "cameraType": str(camera_type),
        "zoom": float(zoom),
    }


def _zoom_to_factor(zoom):
    # 与官方 CameraAngle.zoom_to_factor 一致：0→1.0，10→1.875（3D 数字变焦倍率）
    # 供「📷XH-机位描述」(camangle) 复用；本节点已改回官方 zoom 语义，不再经过它。
    MIN_ZOOM_FACTOR = 1.0
    MAX_ZOOM_FACTOR = 1.875
    return MIN_ZOOM_FACTOR + (MAX_ZOOM_FACTOR - MIN_ZOOM_FACTOR) * (zoom / 10.0)


class XHCameraParam(IO.ComfyNode):
    @classmethod
    def define_schema(cls):
        return IO.Schema(
            node_id="XHCameraParam",
            display_name="🎥XH-相机参数",
            category="🔁XH/工具",
            description=(
                "造一个 camera_info 相机参数，直接接官方 3D 节点（Load 3D / Render Splat / Save 3D 等）。"
                "orbit 环绕模式用偏航/俯仰/距离绕目标转；look_at 世界定点直接给相机世界坐标；"
                "quaternion 四元数给位置 + 旋转。坐标系为观察者世界空间（右手系，Y 向上）。"
            ),
            inputs=[
                # —— 官方同款 DynamicCombo：官方 3D 视口按 mode.yaw / mode.pitch / … 读写 ——
                IO.DynamicCombo.Input("mode", options=[
                    IO.DynamicCombo.Option("orbit", [
                        IO.Float.Input("yaw", default=35.0, min=-360.0, max=360.0, step=1.0,
                                       tooltip="偏航角（绕世界 Y 轴，单位度）。0=正前、90=右侧、180=背后、270=左侧。"),
                        IO.Float.Input("pitch", default=30.0, min=-89.0, max=89.0, step=1.0,
                                       tooltip="俯仰角（单位度）。正=从上往下俯看，负=从下往上仰看。"),
                        IO.Float.Input("distance", default=4.0, min=0.01, max=1000.0, step=0.01,
                                       tooltip="相机到目标点的距离（场景单位）。"),
                    ]),
                    IO.DynamicCombo.Option("look_at", [
                        IO.Float.Input("position_x", default=4.0, min=-1000.0, max=1000.0, step=0.01,
                                       tooltip="相机世界坐标 X（右手系，Y 向上）。"),
                        IO.Float.Input("position_y", default=4.0, min=-1000.0, max=1000.0, step=0.01,
                                       tooltip="相机世界坐标 Y。"),
                        IO.Float.Input("position_z", default=4.0, min=-1000.0, max=1000.0, step=0.01,
                                       tooltip="相机世界坐标 Z。"),
                    ]),
                    IO.DynamicCombo.Option("quaternion", [
                        IO.Float.Input("position_x", default=4.0, min=-1000.0, max=1000.0, step=0.01,
                                       tooltip="相机世界坐标 X（右手系，Y 向上）。"),
                        IO.Float.Input("position_y", default=4.0, min=-1000.0, max=1000.0, step=0.01,
                                       tooltip="相机世界坐标 Y。"),
                        IO.Float.Input("position_z", default=4.0, min=-1000.0, max=1000.0, step=0.01,
                                       tooltip="相机世界坐标 Z。"),
                        IO.Float.Input("quat_x", default=0.0, min=-1.0, max=1.0, step=0.001,
                                       tooltip="相机旋转四元数 X 分量（three.js 约定：局部 -Z 朝前看）。会自动归一化。"),
                        IO.Float.Input("quat_y", default=0.0, min=-1.0, max=1.0, step=0.001,
                                       tooltip="相机旋转四元数 Y 分量。"),
                        IO.Float.Input("quat_z", default=0.0, min=-1.0, max=1.0, step=0.001,
                                       tooltip="相机旋转四元数 Z 分量。"),
                        IO.Float.Input("quat_w", default=1.0, min=-1.0, max=1.0, step=0.001,
                                       tooltip="相机旋转四元数 W 分量。"),
                    ]),
                ], tooltip="相机定义方式：orbit 环绕（偏航/俯仰/距离）、look_at 世界定点（直接给相机坐标）、quaternion（位置 + 四元数）。"),
                IO.Float.Input("target_x", default=0.0, min=-1000.0, max=1000.0, step=0.01, advanced=True,
                               tooltip="注视点 X（环绕模式的枢轴 / 定点模式的瞄准点）。默认原点；环绕模式挪它 = 整台相机平移。四元数模式下忽略。"),
                IO.Float.Input("target_y", default=0.0, min=-1000.0, max=1000.0, step=0.01, advanced=True,
                               tooltip="注视点 Y。"),
                IO.Float.Input("target_z", default=0.0, min=-1000.0, max=1000.0, step=0.01, advanced=True,
                               tooltip="注视点 Z。"),
                IO.Float.Input("roll", default=0.0, min=-180.0, max=180.0, step=1.0,
                               tooltip="绕视线轴的滚转角（度）。0=水平，非零=荷兰角/倾斜镜头。"),
                IO.Float.Input("fov", default=35.0, min=1.0, max=120.0, step=1.0,
                               tooltip="垂直视场角（度）。越大越广角。"),
                IO.Float.Input("zoom", default=1.0, min=0.01, max=100.0, step=0.01,
                               tooltip="数字变焦倍率。>1 拉近画面但不移动相机（官方同款语义）。"),
                IO.Combo.Input("camera_type", options=["perspective", "orthographic"],
                               tooltip="投影方式：perspective（透视/近大远小）或 orthographic（正交/平行投影）。"),
                # —— 官方 3D 场景视口本体（网格地面 + 立方体，可拖拽），名字/类型逐字对齐官方 ——
                IO.CameraInfoState.Input("camera_info_state", optional=True),
            ],
            outputs=[
                IO.Load3DCamera.Output(display_name="camera_info"),
                IO.String.Output(display_name="camera_json"),
            ],
        )

    @classmethod
    def execute(cls, mode, target_x, target_y, target_z, roll, fov, zoom=1.0,
                camera_type="perspective", camera_info_state=None) -> IO.NodeOutput:
        # camera_info_state：官方 3D 视口的状态位（拖拽结果链），不参与字典构造，忽略。
        kind = mode["mode"]
        if kind == "quaternion":  # 显式世界坐标 + 相机旋转四元数
            position = [mode["position_x"], mode["position_y"], mode["position_z"]]
            quat = [mode["quat_x"], mode["quat_y"], mode["quat_z"], mode["quat_w"]]
            ci = _quat_camera_info(position, quat, fov, zoom, camera_type)
        else:
            target = [float(target_x), float(target_y), float(target_z)]  # 环绕枢轴 / 瞄准点
            if kind == "orbit":  # 偏航/俯仰/距离绕 target（世界 Y 向上）
                y, p = math.radians(mode["yaw"]), math.radians(mode["pitch"])
                cy, sy, cp, sp = math.cos(y), math.sin(y), math.cos(p), math.sin(p)
                d = mode["distance"]
                position = [target_x + d * cp * sy, target_y + d * sp, target_z + d * cp * cy]
            else:  # look_at：显式世界坐标
                position = [mode["position_x"], mode["position_y"], mode["position_z"]]
            ci = _lookat_camera_info(position, target, fov, zoom, camera_type, roll)
        json_str = json.dumps(ci, ensure_ascii=False, indent=2)
        return IO.NodeOutput(ci, json_str)


NODE_CLASS_MAPPINGS = {"XHCameraParam": XHCameraParam}
NODE_DISPLAY_NAME_MAPPINGS = {"XHCameraParam": "🎥XH-相机参数"}
