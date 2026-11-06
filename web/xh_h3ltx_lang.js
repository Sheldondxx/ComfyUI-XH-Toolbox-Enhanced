// 🔀XH-H3LTX-Adapter · 家族前端（2026-10-01 升级到家族规范）
// ① 语言桥：window.XH_LANG accessor + xh:lang-changed 广播（全家族同步）
// ② 中/EN：节点标题 + 参数标签 + 输入/输出端口名
// ③ 🎨 家族 12 色 + 自定义取色器（本版新增，之前缺）
// 覆盖本包两个节点：H3LTXAdapterLoader、H3LTXAdapterConvert
// 铁律：只改 label / title，绝不改 name；class_type 键保持英文，不动序列化。
const { app } = window.comfyAPI.app;
import { ensureLangBridge, makeXHToolbar, onLangChanged, releaseButtons, applyComboLabels, XH_COMBO_COMMON } from "./xh_ui_kit.js";

ensureLangBridge();

// class_type 键 -> { zh, en } 标题。键必须与 nodes.py 的 NODE_CLASS_MAPPINGS 完全一致。
const XH_NODES = {
    H3LTXAdapterLoader: {
        zh: "🔀XH-H3LTX-适配器加载",
        en: "🔀XH-H3LTX-AdapterLoader",
    },
    H3LTXAdapterConvert: {
        zh: "🔀XH-H3LTX-转换",
        en: "🔀XH-H3LTX-Convert",
    },
};

// 参数名 -> { zh, en } 标签。只改 label，绝不改 name（后端按 name 取参）。
const XH_WIDGETS = {
    model_name: { zh: "模型文件", en: "Model file" },
    device: { zh: "设备", en: "Device" },
    precision: { zh: "精度", en: "Precision" },
    reload: { zh: "强制重载", en: "Force reload" },
    pixel_frames: { zh: "像素帧数", en: "Pixel frames" },
    pixel_height: { zh: "像素高", en: "Pixel height" },
    pixel_width: { zh: "像素宽", en: "Pixel width" },
    input_is_raw: { zh: "H3 原始输出", en: "H3 raw" },
    drop_last_frame: { zh: "丢尾帧", en: "Drop last frame" },
    unload_after: { zh: "用后卸载", en: "Unload after" },
    adapter: { zh: "适配器", en: "Adapter" },
    latent: { zh: "潜空间", en: "Latent" },
};

// 端口名 -> { zh, en } 标签（输入 / 输出）。只改 label，绝不改 name。
const XH_SLOTS = {
    adapter: { zh: "适配器", en: "adapter" },
    latent: { zh: "潜空间", en: "latent" },
    ltx_latent: { zh: "LTX latent", en: "ltx_latent" },
    pixel_frames: { zh: "像素帧", en: "pixel_frames" },
    width: { zh: "宽", en: "width" },
    height: { zh: "高", en: "height" },
    report: { zh: "报告", en: "report" },
};

// 下拉框「显示中文、存值仍是英文」（走官方 getOptionLabel 钩子）
// ⚠️ model_name 是模型文件名列表 —— **绝不翻译**，翻了就找不到文件
const COMBO_LABELS = {
    device: { cuda: XH_COMBO_COMMON.cuda, cpu: XH_COMBO_COMMON.cpu },
    precision: { ...XH_COMBO_COMMON },
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
        console.warn("[XH-H3LTX] 应用语言失败:", e);
    }
}

function applyLangToAll() {
    try {
        const nodes = app.graph ? (app.graph.nodes || app.graph._nodes || []) : [];
        for (const n of nodes) applyLangToNode(n);
        app.graph?.setDirtyCanvas?.(true, true);
    } catch (e) {
        console.warn("[XH-H3LTX] 全局应用语言失败:", e);
    }
}

app.registerExtension({
    name: "XH.H3LTXAdapter.FamilyUI",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (!conf(nodeData.name)) return;

        const origOnCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = origOnCreated?.apply(this, arguments);
            try {
                applyLangToNode(this);
                makeXHToolbar(this);
            } catch (e) {
                console.warn("[XH-H3LTX] 工具条创建失败:", e);
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
