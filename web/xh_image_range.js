// 🖼️XH-取帧范围 · 家族前端
// ① 中/EN 切换：节点标题 + 参数控件标签 + 输入/输出端口名（照 xh_mathint.js 规范）
// ② 节点自身配色 🎨（XH 家族 12 色 + 自定义取色器）
//
// 铁律：只改 label / title，绝不改 name；绝不改 COMBO 的 values；DOM 工具栏 serialize:false 且只 append。
const { app } = window.comfyAPI.app;

import { ensureLangBridge, makeXHToolbar, onLangChanged, releaseButtons } from "./xh_ui_kit.js";

ensureLangBridge();
const NODE_TYPE = "XHImageRangeFromBatch";
const XH_I18N = {
    zh: {
        nodes: { XHImageRangeFromBatch: "🖼️XH-取帧范围" },
        widgets: {
            start_index: "起始帧", num_frames: "取几帧", clamp: "越界自动钳制",
            images: "图像（输入）", masks: "遮罩（输入）",
        },
        slots: { IMAGE: "图像", MASK: "遮罩", images: "图像（输入）", masks: "遮罩（输入）" },
    },
    en: {
        nodes: { XHImageRangeFromBatch: "XH Image Range From Batch" },
        widgets: {
            start_index: "start index", num_frames: "num frames", clamp: "clamp",
            images: "images", masks: "masks",
        },
        slots: { IMAGE: "IMAGE", MASK: "MASK", images: "images", masks: "masks" },
    },
};

function t(lang, kind, key) {
    const pack = XH_I18N[lang] || XH_I18N.zh;
    return (pack[kind] && pack[kind][key]) || null;
}

const VALUE_LABELS = {};   // 本节点没有下拉；留着保持家族 js 结构一致

function applyComboValueLabels(node, lang) {
    if (!node || !node.widgets) return;
    const zh = (lang || window.XH_LANG || "zh") === "zh";
    for (const w of node.widgets) {
        if (!w || w.type !== "combo" || !w.options) continue;
        if (zh) {
            const table = VALUE_LABELS[w.name];
            if (table) w.options.getOptionLabel = (v) => (v == null ? "" : (table[String(v)] || String(v)));
        } else {
            delete w.options.getOptionLabel;
        }
    }
    try { node.setDirtyCanvas?.(true, true); } catch (e) {}
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
        applyComboValueLabels(node, lang);

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
        console.warn("[XH ImageRange Lang] 应用语言失败:", e);
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
    name: "XH.ImageRangeFromBatch",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_TYPE) return;

        const origOnCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = origOnCreated?.apply(this, arguments);
            try {
                // 标准工具条（中/EN + 🎨）—— 家族唯一实现见 web/xh_ui_kit.js
                const { bar, langBtn, colorBtn } = makeXHToolbar(this, { widgetName: "xh_imgrange_bar" });
                this._xhLangBtn = langBtn;

                applyLang(this);
            } catch (e) {
                console.warn("[XH ImageRangeFromBatch] 工具栏创建失败:", e);
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
        // 语言变更 + 工作流载入重刷 —— 统一走 kit（等价实现，见 web/xh_ui_kit.js）
        onLangChanged(() => applyLangToAll());
    },
});
