// XH-AudioSep · 中英文切换 + 节点配色（与 XH 家族其他节点一致）
// 语言键 xh_node_lang 与 XH 家族其他包共用 -> 全家族语言状态一致。
// 本文件给 XH_AudioSep 的 4 个节点加：① 中英文切换按钮 ② 🎨 颜色板。
// type 名一律以 XH 开头，不与任何第三方包冲突，分享出去可放心装。
const { app } = window.comfyAPI.app;
import { ensureLangBridge, makeXHToolbar, onLangChanged, releaseButtons } from "./xh_ui_kit.js";

// ① 语言桥：window.XH_LANG 做成 accessor —— 赋值即写 localStorage + 广播 xh:lang-changed
ensureLangBridge();
// ② 家族同步：按钮换字由 kit 全局负责；本文件 4 个节点的标题/端口名换字走 onLangChanged（见文件底部 setup）

const XH_I18N = {
    zh: {
        nodes: {
            XHSimpleMath: "🔁XH-简易数学",
            XHVoiceSeparatorLoader: "🔁XH-人声分离(模型加载)",
            XHVoiceSeparatorSampler: "🔁XH-人声分离(采样)",
            XHAudioDuration: "🔁XH-音频取时长",
        },
        widgets: {
            model_name: "模型文件",
            model: "模型",
            audio: "音频",
            value: "数值",
            a: "A",
            b: "B",
            c: "C",
        },
        slots: {
            INT: "整数",
            FLOAT: "浮点",
            model: "模型",
            audio: "音频",
            vocals: "人声",
            instruments: "伴奏",
            a: "A",
            b: "B",
            c: "C",
        },
    },
    en: {
        nodes: {
            XHSimpleMath: "XH Simple Math",
            XHVoiceSeparatorLoader: "XH Voice Separator (Load)",
            XHVoiceSeparatorSampler: "XH Voice Separator (Sample)",
            XHAudioDuration: "XH Audio Duration",
        },
        widgets: {
            model_name: "model file",
            model: "model",
            audio: "audio",
            value: "value",
            a: "a",
            b: "b",
            c: "c",
        },
        slots: {
            INT: "INT",
            FLOAT: "FLOAT",
            model: "model",
            audio: "audio",
            vocals: "vocals",
            instruments: "instruments",
            a: "a",
            b: "b",
            c: "c",
        },
    },
};

// ---- 节点自身配色（与 XH 家族同一套 12 色 + 自定义取色器）----

// ---- 语言状态：由文件顶部的 ensureLangBridge() 统一安装（访问器 + 广播），此处不再直接赋值 ----
// （直接 `window.XH_LANG = x` 现在也会走 setter → 写 localStorage + 广播，家族自动同步）

function normalizeType(type) {
    return typeof type === "string" ? type.replace(/^[^\w]+/, "") : type;
}
function isXHNode(type) {
    if (typeof type !== "string") return false;
    return !!XH_I18N.zh.nodes[normalizeType(type)];
}
function applyLangToNode(node) {
    if (!node || !isXHNode(node.type)) return;
    const lang = window.XH_LANG || "zh";
    const pack = XH_I18N[lang] || XH_I18N.zh;
    try {
        const t = normalizeType(node.type);
        const name = pack.nodes[t];
        const defaultZhName = XH_I18N.zh.nodes[t];
        const defaultEnName = XH_I18N.en.nodes[t];
        if (name && (node.title === defaultZhName || node.title === defaultEnName || !node.title)) {
            node.title = name;
        }
        // 参数控件标签（只改 label，绝不改 name）
        if (node.widgets && pack.widgets) {
            for (const w of node.widgets) {
                if (w && w.name && pack.widgets[w.name]) w.label = pack.widgets[w.name];
            }
        }
        // 输入 / 输出端口名（本版新增）
        const applySlots = (arr) => {
            for (const s of arr || []) {
                if (s && s.name && pack.slots && pack.slots[s.name]) s.label = pack.slots[s.name];
            }
        };
        applySlots(node.inputs);
        applySlots(node.outputs);
        try {
            node.graph?.trigger?.("node:slot-label:changed", { nodeId: node.id, slotType: 1 });
            node.graph?.trigger?.("node:slot-label:changed", { nodeId: node.id, slotType: 2 });
        } catch (e) {}
        try { node.setDirtyCanvas?.(true, true); } catch (e) {}
    } catch (e) {}
}
function applyLangToAll() {
    try {
        const nodes = app.graph ? app.graph._nodes || [] : [];
        for (const n of nodes) applyLangToNode(n);
        app.graph.setDirtyCanvas(true, true);
    } catch (e) {}
}
// 语言切换按钮 / 🎨 颜色板 / 按钮换字 —— 一律用 xh_ui_kit 的唯一实现，本文件不再自建。
// （自建的 createLangBtn / addDomLangBtn / createColorBtn / updateAllDomButtons 已于 2026-10-05 移除）

app.registerExtension({
    name: "XH.AudioSep.UI",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (!isXHNode(nodeData.name)) return;
        const origOnCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = origOnCreated?.apply(this, arguments);
            try {
                // 标准工具条（中/EN + 🎨）—— 家族唯一实现见 web/xh_ui_kit.js
                makeXHToolbar(this, { widgetName: "xh_audiosep_toolbar" });
                applyLangToNode(this);
            } catch (e) {
                console.warn("[XH AudioSep] onNodeCreated 失败:", e);
            }
            return r;
        };
        const origOnRemoved = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function () {
            try {
                releaseButtons(this);
            } catch (e) {}
            return origOnRemoved?.apply(this, arguments);
        };
    },
    async setup() {
        // 语言变更 + 工作流载入重刷 —— 统一走 kit（等价实现，见 web/xh_ui_kit.js）
        onLangChanged(() => applyLangToAll());
    },
});
