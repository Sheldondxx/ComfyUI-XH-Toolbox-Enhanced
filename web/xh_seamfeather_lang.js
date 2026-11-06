// 🔁XH-SeamFeather · 家族前端（2026-10-01 升级到家族规范）
// ① 语言桥：window.XH_LANG accessor + xh:lang-changed 广播（全家族同步）
// ② 中/EN：节点标题 + 参数标签 + 输入/输出端口名
// ③ 🎨 家族 12 色 + 自定义取色器（本版新增，之前缺）
// 覆盖本包一个节点：XHSeamFeather
// 铁律：只改 label / title，绝不改 name；class_type 键保持英文，不动序列化。
const { app } = window.comfyAPI.app;
import { ensureLangBridge, makeXHToolbar, onLangChanged, releaseButtons, applyComboLabels } from "./xh_ui_kit.js";

ensureLangBridge();

// class_type 键 -> { zh, en } 标题。键必须与 core.py 的 NODE_CLASS_MAPPINGS 完全一致。
const XH_NODES = {
    XHSeamFeather: {
        zh: "🔁XH-衔接淡化",
        en: "🔁XH-SeamFeather",
    },
};

// 参数名 -> { zh, en } 标签。只改 label，绝不改 name（后端按 name 取参）。
const XH_WIDGETS = {
    images:      { zh: "视频",     en: "Video" },
    reference:   { zh: "参考帧",   en: "Reference" },
    frames:      { zh: "淡化帧数", en: "Frames" },
    strength:    { zh: "强度",     en: "Strength" },
    falloff:     { zh: "衰减曲线", en: "Falloff" },
    mode:        { zh: "模式",     en: "Mode" },
    ref_pick:    { zh: "参考选取", en: "Ref pick" },
    blur_radius: { zh: "模糊半径", en: "Blur radius" },
};

// 端口名 -> { zh, en } 标签（输入 / 输出）。只改 label，绝不改 name。
const XH_SLOTS = {
    images: { zh: "视频", en: "Video" },
    reference: { zh: "参考帧", en: "Reference" },
};

// 下拉框「中文态纯中文、英文态回落原值」（走官方 getOptionLabel 钩子；key 是英文存值，不动）
const COMBO_LABELS = {
    falloff: {
        linear: "线性（匀速）",
        ease_out: "先快后慢",
        ease_in_out: "两头慢·中间快",
    },
    mode: {
        full: "全通道（RGB 都补）",
        chroma_only: "只调色度",
        low_freq: "只调低频",
    },
    ref_pick: {
        last: "取参考的尾帧",
        first: "取参考的首帧",
    },
};

function normalizeType(type) {
    return typeof type === "string" ? type.replace(/^[^\w]+/, "") : type;
}

function conf(type) {
    if (typeof type !== "string") return null;
    return XH_NODES[normalizeType(type)] || null;
}

function applyLangToNode(node) {
    if (!node) return;
    const c = conf(node.type);
    if (!c) return;
    const lang = window.XH_LANG === "en" ? "en" : "zh";
    try {
        // 只有标题仍是默认显示名（或空）时才重写，保留用户的自定义标题
        const defaults = [c.zh, c.en];
        if (c[lang] && (!node.title || defaults.includes(node.title))) {
            node.title = c[lang];
        }
        if (node.widgets) {
            for (const w of node.widgets) {
                const t = w && w.name ? XH_WIDGETS[w.name] : null;
                if (t) w.label = t[lang];
            }
        }
        // 端口名：只改 label。Nodes 2.0 走快照渲染，改完需显式触发重建
        const applySlots = (arr) => {
            for (const s of arr || []) {
                const t = s && s.name ? XH_SLOTS[s.name] : null;
                if (t) s.label = t[lang];
            }
        };
        applySlots(node.inputs);
        applySlots(node.outputs);
        // 下拉框显示中文（值不变）
        applyComboLabels(node, lang, COMBO_LABELS);
        try {
            node.graph?.trigger?.("node:slot-label:changed", { nodeId: node.id, slotType: 1 });
            node.graph?.trigger?.("node:slot-label:changed", { nodeId: node.id, slotType: 2 });
        } catch (e) {}
        try { node.setDirtyCanvas?.(true, true); } catch (e) {}
    } catch (e) {
        console.warn("[XH-SeamFeather] 应用语言失败:", e);
    }
}

function applyLangToAll() {
    try {
        const nodes = app.graph ? (app.graph.nodes || app.graph._nodes || []) : [];
        for (const n of nodes) applyLangToNode(n);
        app.graph?.setDirtyCanvas?.(true, true);
    } catch (e) {
        console.warn("[XH-SeamFeather] 全局应用语言失败:", e);
    }
}

app.registerExtension({
    name: "XH.SeamFeather.FamilyUI",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (!conf(nodeData.name)) return;

        const origOnCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = origOnCreated?.apply(this, arguments);
            try {
                applyLangToNode(this);
                makeXHToolbar(this);
            } catch (e) {
                console.warn("[XH-SeamFeather] 工具条创建失败:", e);
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
        onLangChanged(applyLangToAll);
    },
});
