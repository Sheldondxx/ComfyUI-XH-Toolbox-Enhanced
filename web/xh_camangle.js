// 📷XH-机位描述 · 家族前端
// ① 中/EN 切换：节点标题 + **参数控件标签** + **输出端口名**（照 xh_counter.js 规范）
// ② 节点自身配色 🎨（XH 家族 12 色 + 自定义取色器）
//
// 铁律：
//   · 只改 label / title，绝不改 name（后端按 name 取参数，改了会坏）
//   · DOM 工具栏 serialize:false 且只 append 不 unshift，绝不顶乱 widgets_values 下标
const { app } = window.comfyAPI.app;

import { ensureLangBridge, makeXHToolbar, onLangChanged, releaseButtons, applyComboLabelsBi } from "./xh_ui_kit.js";

ensureLangBridge();
const NODE_TYPE = "XHCameraAnglePrompt";

// ---- 下拉框双语表（显示换文字、存值不动；null = 回落显示原值）----
const COMBO_LABELS = {
    mode: {
        "自定义":   { zh: null, en: "Custom" },
        "预设机位": { zh: null, en: "Preset" },
    },
    preset: {
        "正面·平视·远景":    { zh: null, en: "Front · Eye-level · Wide" },
        "正面·平视·中景":    { zh: null, en: "Front · Eye-level · Medium" },
        "正面·平视·特写":    { zh: null, en: "Front · Eye-level · Close-up" },
        "正面·仰拍·特写":    { zh: null, en: "Front · Low-angle · Close-up" },
        "正面·俯拍·全景":    { zh: null, en: "Front · High-angle · Wide" },
        "斜侧·平视·中景":    { zh: null, en: "Quarter · Eye-level · Medium" },
        "斜侧·俯拍·远景":    { zh: null, en: "Quarter · High-angle · Wide" },
        "右侧·平视·中景":    { zh: null, en: "Right · Eye-level · Medium" },
        "左侧·平视·中景":    { zh: null, en: "Left · Eye-level · Medium" },
        "背面·平视·中景":    { zh: null, en: "Back · Eye-level · Medium" },
        "背面·仰拍·中景":    { zh: null, en: "Back · Low-angle · Medium" },
        "背面·特写":         { zh: null, en: "Back · Close-up" },
        "俯拍·大全景(航拍)": { zh: null, en: "Top-down · Aerial Wide" },
    },
};

// ---- 文案表 ----
const XH_I18N = {
    zh: {
        nodes: { XHCameraAnglePrompt: "📷XH-机位描述" },
        widgets: {
            horizontal_angle: "方位角",
            vertical_angle: "俯仰角",
            zoom: "变焦",
            mode: "模式",
            preset: "预设机位",
            view: "3D预览",
        },
        slots: {
            prompt: "机位描述(英文)",
            camera_info: "机位信息",
            image: "参考图",
            view: "3D预览",
        },
    },
    en: {
        nodes: { XHCameraAnglePrompt: "XH Camera Angle Prompt" },
        widgets: {
            horizontal_angle: "horizontal_angle",
            vertical_angle: "vertical_angle",
            zoom: "zoom",
            mode: "mode",
            preset: "preset",
            view: "view",
        },
        slots: {
            prompt: "prompt(EN)",
            camera_info: "camera_info",
            image: "image",
            view: "view",
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
        // 标题：只在还是默认显示名时才重写，保留用户自定义标题
        const zhT = XH_I18N.zh.nodes[NODE_TYPE];
        const enT = XH_I18N.en.nodes[NODE_TYPE];
        const want = t(lang, "nodes", NODE_TYPE);
        if (want && (node.title === zhT || node.title === enT || !node.title)) node.title = want;

        // 参数控件标签（只改 label）
        if (node.widgets) {
            for (const w of node.widgets) {
                if (!w || !w.name) continue;
                const lb = t(lang, "widgets", w.name);
                if (lb) w.label = lb;
            }
            // 下拉框双语：中/EN 两态都换显示文字（存值不动）
            applyComboLabelsBi(node, lang, COMBO_LABELS);
        }

        // 输入 / 输出端口名
        const applySlots = (arr) => {
            if (!arr) return;
            for (const s of arr) {
                const lb = t(lang, "slots", s && s.name);
                if (lb) s.label = lb;
            }
        };
        applySlots(node.inputs);
        applySlots(node.outputs);

        // Nodes 2.0 端口标签走快照渲染，改完必须显式触发重建（官方 renameWidget 同机制）
        try {
            node.graph?.trigger?.("node:slot-label:changed", { nodeId: node.id, slotType: 1 });
            node.graph?.trigger?.("node:slot-label:changed", { nodeId: node.id, slotType: 2 });
        } catch (e) {}
        try { node.setDirtyCanvas?.(true, true); } catch (e) {}
    } catch (e) {
        console.warn("[XH CamAngle Lang] 应用语言失败:", e);
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

// 模式开关联动：预设机位 → 隐藏三个滑块、显示预设；自定义 → 反之
function refreshVisibility(node) {
    if (!node || !node.widgets) return;
    const modeW = node.widgets.find((w) => w && w.name === "mode");
    if (!modeW) return;
    const isPreset = modeW.value === "预设机位";
    for (const w of node.widgets) {
        if (!w || !w.name) continue;
        if (w.name === "horizontal_angle" || w.name === "vertical_angle" || w.name === "zoom") {
            w.hidden = isPreset;
        } else if (w.name === "preset") {
            w.hidden = !isPreset;
        }
    }
    try { node.setSize?.(node.computeSize?.() || node.size); } catch (e) {}
    try { node.setDirtyCanvas?.(true, true); } catch (e) {}
}

app.registerExtension({
    name: "XH.CameraAnglePrompt",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_TYPE) return;

        // 保险：不管服务器序列化结果如何，在前端 def 上强制补齐官方 3D 预览控件标记
        // （官方 CameraAngle 同款：widgetType=CAMERA_ANGLE_VIEW + socketless）
        try {
            const opt = nodeData?.input?.optional;
            if (opt?.view && Array.isArray(opt.view) && opt.view[0] === "STRING") {
                opt.view[1] = opt.view[1] || {};
                opt.view[1].widgetType = "CAMERA_ANGLE_VIEW";
                opt.view[1].socketless = true;
            }
        } catch (e) {}

        const origOnCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = origOnCreated?.apply(this, arguments);
            try {
                // 标准工具条（中/EN + 🎨）—— 家族唯一实现见 web/xh_ui_kit.js
                makeXHToolbar(this, { widgetName: "xh_camangle_bar" });
                applyLang(this);
                // 模式开关联动：切到「预设机位」隐藏滑块、显示预设（反之亦然）
                const modeW = (this.widgets || []).find((w) => w && w.name === "mode");
                if (modeW) {
                    const prevCb = modeW.callback;
                    modeW.callback = (v) => {
                        try { refreshVisibility(this); } catch (e) {}
                        return prevCb ? prevCb.call(modeW, v) : undefined;
                    };
                }
                refreshVisibility(this);
            } catch (e) {
                console.warn("[XH CamAngle] 工具栏创建失败:", e);
            }
            return r;
        };

        const origOnRemoved = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function () {
            releaseButtons(this);
            return origOnRemoved?.apply(this, arguments);
        };
    },

    async setup() {
        // 别的家族包切语言 → 同步本节点
        onLangChanged(() => applyLangToAll());
    },
});
