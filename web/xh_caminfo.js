// 🎥XH-相机参数 · 家族前端（V3 版，2026-10-11 深夜重写）
// 本节点后端已逐字对齐官方 CreateCameraInfo（DynamicCombo + camera_info_state）：
//   · 官方 3D 场景视口（网格地面 + 立方体，可拖拽）由官方前端自动挂载 —— 名字/类型对上就有，
//     **不再需要** 旧版的 CameraAngle 轨道球别名桥（已删）。
//   · DynamicCombo 子控件（mode.yaw / mode.pitch / mode.distance / mode.position_* / mode.quat_*）
//     的显隐由官方 DynamicCombo 组件自己管理，前端不要去插手（旧版 refreshVisibility 已删）。
// 我们只做家族增强：
//   ① 中/EN 切换：节点标题 + 参数控件标签 + 输出端口名（照 xh_counter.js 规范）
//   ② 节点自身配色 🎨（XH 家族 12 色 + 自定义取色器）
//   ③ camera_type / mode 下拉显示双语（存值不动）
//
// 铁律：
//   · 只改 label / title，绝不改 name（官方视口按 name 读写参数，改了就断同步）
//   · DOM 工具栏 serialize:false 且只 append 不 unshift，绝不顶乱 widgets_values 下标
const { app } = window.comfyAPI.app;

import { ensureLangBridge, makeXHToolbar, onLangChanged, releaseButtons, applyComboLabelsBi } from "./xh_ui_kit.js";

ensureLangBridge();
const NODE_TYPE = "XHCameraParam";

// ---- 下拉框双语表（显示换文字、存值不动；null = 回落显示原值）----
const COMBO_LABELS = {
    mode: {
        "orbit":      { zh: "环绕模式", en: null },
        "look_at":    { zh: "世界定点", en: null },
        "quaternion": { zh: "四元数",   en: null },
    },
    camera_type: {
        "perspective":  { zh: "透视投影", en: null },
        "orthographic": { zh: "正交投影", en: null },
    },
};

// ---- 文案表（V3 DynamicCombo 子控件名 = mode.前缀，与官方视口读写名一致）----
const XH_I18N = {
    zh: {
        nodes: { XHCameraParam: "🎥XH-相机参数" },
        widgets: {
            "mode": "模式",
            "mode.yaw": "偏航角",
            "mode.pitch": "俯仰角",
            "mode.distance": "距离",
            "mode.position_x": "相机坐标X",
            "mode.position_y": "相机坐标Y",
            "mode.position_z": "相机坐标Z",
            "mode.quat_x": "四元数X",
            "mode.quat_y": "四元数Y",
            "mode.quat_z": "四元数Z",
            "mode.quat_w": "四元数W",
            "target_x": "注视点X",
            "target_y": "注视点Y",
            "target_z": "注视点Z",
            "roll": "滚转角",
            "fov": "视场角",
            "zoom": "变焦",
            "camera_type": "投影方式",
            "camera_info_state": "3D场景视口",
        },
        slots: {
            camera_info: "相机信息",
            camera_json: "相机JSON",
            camera_info_state: "视口状态",
        },
    },
    en: {
        nodes: { XHCameraParam: "XH Camera Param" },
        widgets: {
            "mode": "mode",
            "mode.yaw": "yaw",
            "mode.pitch": "pitch",
            "mode.distance": "distance",
            "mode.position_x": "position_x",
            "mode.position_y": "position_y",
            "mode.position_z": "position_z",
            "mode.quat_x": "quat_x",
            "mode.quat_y": "quat_y",
            "mode.quat_z": "quat_z",
            "mode.quat_w": "quat_w",
            "target_x": "target_x",
            "target_y": "target_y",
            "target_z": "target_z",
            "roll": "roll",
            "fov": "fov",
            "zoom": "zoom",
            "camera_type": "camera_type",
            "camera_info_state": "camera_info_state",
        },
        slots: {
            camera_info: "camera_info",
            camera_json: "cameraJSON",
            camera_info_state: "camera_info_state",
        },
    },
};

function t(lang, kind, key) {
    const pack = XH_I18N[lang] || XH_I18N.zh;
    return (pack[kind] && pack[kind][key]) || null;
}

function applyLang(node, lang) {
    if (!node) return;
    lang = lang || window.XH_LANG || "zh";
    try {
        const zhT = XH_I18N.zh.nodes[NODE_TYPE];
        const enT = XH_I18N.en.nodes[NODE_TYPE];
        const want = t(lang, "nodes", NODE_TYPE);
        if (want && (node.title === zhT || node.title === enT || !node.title)) node.title = want;

        if (node.widgets) {
            for (const w of node.widgets) {
                if (!w || !w.name) continue;
                const lb = t(lang, "widgets", w.name);
                if (lb) w.label = lb;
            }
            // 下拉框双语：中/EN 两态都换显示文字（存值不动）
            applyComboLabelsBi(node, lang, COMBO_LABELS);
        }

        const applySlots = (arr) => {
            if (!arr) return;
            for (const s of arr) {
                const lb = t(lang, "slots", s && s.name);
                if (lb) s.label = lb;
            }
        };
        applySlots(node.inputs);
        applySlots(node.outputs);

        try {
            node.graph?.trigger?.("node:slot-label:changed", { nodeId: node.id, slotType: 1 });
            node.graph?.trigger?.("node:slot-label:changed", { nodeId: node.id, slotType: 2 });
        } catch (e) {}
        try { node.setDirtyCanvas?.(true, true); } catch (e) {}
    } catch (e) {
        console.warn("[XH CamInfo Lang] 应用语言失败:", e);
    }
}

function nodesOfType() {
    try {
        return (app.graph?.nodes || app.graph?._nodes || []).filter((n) => n.type === NODE_TYPE);
    } catch (e) { return []; }
}
function applyLangToAll() {
    const lang = window.XH_LANG || "zh";
    for (const n of nodesOfType()) applyLang(n, lang);
    try { app.graph?.setDirtyCanvas?.(true, true); } catch (e) {}
}

app.registerExtension({
    name: "XH.CameraParam",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_TYPE) return;

        const origOnCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = origOnCreated?.apply(this, arguments);
            try {
                makeXHToolbar(this, { widgetName: "xh_caminfo_bar" });
                applyLang(this);
                // DynamicCombo 子控件（mode.*）由官方组件在 onNodeCreated 之后异步创建，
                // 上面那次 applyLang 摸不到它们 —— 定时补几轮，直到子控件出现。
                const node = this;
                const retryDelays = [0, 300, 1000, 2500];
                const retry = () => {
                    if (!node.graph) return; // 节点已被删
                    applyLang(node);
                    const t0 = retryDelays.shift();
                    if (t0 !== undefined) setTimeout(retry, t0);
                };
                retry();
            } catch (e) {
                console.warn("[XH CamInfo] 工具栏创建失败:", e);
            }
            return r;
        };

        // DynamicCombo 切模式时会新建子控件（mode.yaw / mode.position_* / mode.quat_*），
        // 在 addWidget 层补 label，保证新建即带当前语言（只改 label，绝不动 name）。
        const origAddWidget = nodeType.prototype.addWidget;
        nodeType.prototype.addWidget = function (...args) {
            const w = origAddWidget ? origAddWidget.apply(this, args) : undefined;
            try {
                if (w && w.name && String(w.name).indexOf("mode.") === 0) {
                    const lb = t(window.XH_LANG || "zh", "widgets", w.name);
                    if (lb) w.label = lb;
                }
            } catch (e) {}
            return w;
        };

        const origOnRemoved = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function () {
            releaseButtons(this);
            return origOnRemoved?.apply(this, arguments);
        };
    },

    async setup() {
        onLangChanged(() => applyLangToAll());
    },
});
