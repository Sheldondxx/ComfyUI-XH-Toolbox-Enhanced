// 🔁XH H3 Memory Saver · 家族前端（2026-10-01 升级到家族规范）
// ① 语言桥：window.XH_LANG accessor + xh:lang-changed 广播（全家族同步）
// ② 中/EN 切换：节点标题 + 参数控件标签 + 输入/输出端口名
// ③ 🎨 家族 12 色 + 自定义取色器（本版新增，之前缺）
//
// 铁律：只改 label / title，绝不改 name；绝不改 COMBO 的 values；DOM 只 append。
const { app } = window.comfyAPI.app;
import { ensureLangBridge, makeXHToolbar, onLangChanged, releaseButtons, applyComboLabels, XH_COMBO_COMMON } from "./xh_ui_kit.js";

ensureLangBridge();

const NODE_TYPES = ["XHImagePrecision", "XHImageCacheWrite", "XHImageCacheRead"];

const XH_I18N = {
    zh: {
        nodes: {
            XHImagePrecision: "🔁XH-图像精度",
            XHImageCacheWrite: "🔁XH-图像落盘",
            XHImageCacheRead: "🔁XH-图像读取",
        },
        widgets: {
            images: "图像",
            precision: "精度",
            store_precision: "存盘精度",
            cache_key: "缓存键",
            delete_after: "读后删除",
        },
        slots: {
            images: "图像",
            IMAGE: "图像",
            STRING: "文本",
            cache_key: "缓存键",
        },
    },
    en: {
        nodes: {
            XHImagePrecision: "🔁XH-Image Precision",
            XHImageCacheWrite: "🔁XH-Image Cache Write",
            XHImageCacheRead: "🔁XH-Image Cache Read",
        },
        widgets: {
            images: "images",
            precision: "precision",
            store_precision: "store precision",
            cache_key: "cache key",
            delete_after: "delete after read",
        },
        slots: {
            images: "images",
            IMAGE: "IMAGE",
            STRING: "STRING",
            cache_key: "cache_key",
        },
    },
};

// 下拉框「中文态纯中文、英文态回落原值」（走官方 getOptionLabel 钩子；key 是英文存值，不动）
const COMBO_LABELS = {
    precision: { ...XH_COMBO_COMMON },
    store_precision: {
        fp16: "半精度（省盘·快）",
        fp32: "全精度（大·稳）",
    },
};

function normalizeType(type) {
    return typeof type === "string" ? type.replace(/^[^\w]+/, "") : type;
}

function isXHNode(type) {
    const t = normalizeType(type);
    return !!XH_I18N.zh.nodes[t];
}

function t(lang, kind, key) {
    const pack = XH_I18N[lang] || XH_I18N.zh;
    return (pack[kind] && pack[kind][key]) || null;
}

function applyLangToNode(node) {
    if (!node || !isXHNode(node.type)) return;
    const lang = window.XH_LANG || "zh";
    const typeName = normalizeType(node.type);
    try {
        // ① 标题（只有还是默认名时才改，保留用户自定义标题）
        const want = t(lang, "nodes", typeName);
        const zhT = XH_I18N.zh.nodes[typeName];
        const enT = XH_I18N.en.nodes[typeName];
        if (want && (!node.title || node.title === zhT || node.title === enT)) node.title = want;

        // ② 参数控件标签（只改 label，绝不改 name）
        if (node.widgets) {
            for (const w of node.widgets) {
                if (!w || !w.name) continue;
                const lb = t(lang, "widgets", w.name);
                if (lb) w.label = lb;
            }
        }

        // ③ 输入 / 输出端口名（本版新增）
        const applySlots = (arr) => {
            if (!arr) return;
            for (const s of arr) {
                const lb = t(lang, "slots", s && s.name);
                if (lb) s.label = lb;
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
        console.warn("[XH MemSaver] 应用语言失败:", e);
    }
}

function applyLangToAll() {
    try {
        const nodes = app.graph ? (app.graph.nodes || app.graph._nodes || []) : [];
        for (const n of nodes) applyLangToNode(n);
        app.graph?.setDirtyCanvas?.(true, true);
    } catch (e) {
        console.warn("[XH MemSaver] 全局应用语言失败:", e);
    }
}

app.registerExtension({
    name: "XH.MemorySaver.FamilyUI",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (!isXHNode(nodeData.name)) return;

        const origOnCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = origOnCreated?.apply(this, arguments);
            try {
                applyLangToNode(this);
                makeXHToolbar(this);
            } catch (e) {
                console.warn("[XH MemSaver] 工具条创建失败:", e);
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
