// 🎨XH-色彩校正 · 家族前端
// ① 中/EN 切换：节点标题 + 参数控件标签 + 输入/输出端口名
// ② 本节点全部是 FLOAT 滑块，无下拉，无 COMBO_LABELS
// ③ 节点自身配色 🎨（XH 家族 12 色 + 自定义取色器）
//
// 铁律：只改 label / title，绝不改 name；DOM 控件 serialize:false 且只 append。
const { app } = window.comfyAPI.app;

import {
    ensureLangBridge, makeXHToolbar, onLangChanged, releaseButtons,
} from "./xh_ui_kit.js";

ensureLangBridge();

const NODE_TYPE = "XHColorCorrect";
const XH_I18N = {
    zh: {
        nodes: { XHColorCorrect: "🎨XH-色彩校正" },
        widgets: {
            image: "图像",
            temperature: "色温",
            hue: "色相",
            brightness: "亮度",
            contrast: "对比度",
            saturation: "饱和度",
            gamma: "伽马",
        },
        slots: {
            image: "图像",
        },
    },
    en: {
        nodes: { XHColorCorrect: "XH Color Correct" },
        widgets: {
            image: "image",
            temperature: "temperature",
            hue: "hue",
            brightness: "brightness",
            contrast: "contrast",
            saturation: "saturation",
            gamma: "gamma",
        },
        slots: {
            image: "image",
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
        const want = t(lang, "nodes", NODE_TYPE);
        const zhT = XH_I18N.zh.nodes[NODE_TYPE];
        const enT = XH_I18N.en.nodes[NODE_TYPE];
        if (want && (!node.title || node.title === zhT || node.title === enT)) node.title = want;

        if (node.widgets) {
            for (const w of node.widgets) {
                if (!w || !w.name) continue;
                const lb = t(lang, "widgets", w.name);
                if (lb) w.label = lb;
            }
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
        console.warn("[XH ColorCorrect] 应用语言失败:", e);
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
    name: "XH.ColorCorrect",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_TYPE) return;

        const origOnCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = origOnCreated?.apply(this, arguments);
            try {
                makeXHToolbar(this, { widgetName: "xh_color_correct_bar" });
                applyLang(this);
            } catch (e) {
                console.warn("[XH ColorCorrect] 界面创建失败:", e);
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
        onLangChanged(() => applyLangToAll());
    },
});
