// 🖼️XH-图像按序取 · 家族前端（2026-10-01 新建，使用 xh_ui_kit 套件）
//
// 中/EN 切换按钮 + 🎨 配色统一走家族套件 xh_ui_kit.js（四之三硬规矩①：新节点一律走 kit）。
// 参数控件标签 + 输入/输出端口名做中文化（四之二·三处覆盖：①标题 ②参数标签 ③端口名）。
//
// 铁律：只改 label / title，绝不改 name；DOM 工具条 serialize:false 且只 append。
const { app } = window.comfyAPI.app;
import {
    ensureLangBridge,
    makeXHToolbar,
    onLangChanged,
    releaseButtons,
    currentLang,
} from "./xh_ui_kit.js";

ensureLangBridge();   // ① 早于任何 window.XH_LANG 使用

const NODE_TYPE = "XHImageGetByIndex";

// 中/EN 字典：节点标题 + 参数标签 + 端口名（输入 images/index/index_from_one/clamp；输出 IMAGE/实际序号）
const I18N = {
    zh: {
        nodes: { XHImageGetByIndex: "🖼️XH-图像按序取" },
        widgets: {
            images: "图片批次",
            index: "序号",
            index_from_one: "从1起计数",
            clamp: "越界钳制",
        },
        slots: {
            images: "图片批次",
            index: "序号",
            index_from_one: "从1起计数",
            clamp: "越界钳制",
            IMAGE: "图像",
            actual_index: "实际序号(0起)",
        },
    },
    en: {
        nodes: { XHImageGetByIndex: "🖼️XH-Image Get By Index" },
        widgets: {
            images: "images",
            index: "index",
            index_from_one: "index from one",
            clamp: "clamp",
        },
        slots: {
            images: "images",
            index: "index",
            index_from_one: "index_from_one",
            clamp: "clamp",
            IMAGE: "IMAGE",
            actual_index: "actual index",
        },
    },
};

function t(lang, kind, key) {
    const pack = I18N[lang] || I18N.zh;
    return (pack[kind] && pack[kind][key]) || null;
}

// 四之二·三处覆盖：标题 + 参数标签 + 端口名
function applyLang(node, lang) {
    if (!node) return;
    lang = lang || currentLang();
    try {
        const want = t(lang, "nodes", NODE_TYPE);
        const zhT = I18N.zh.nodes[NODE_TYPE];
        const enT = I18N.en.nodes[NODE_TYPE];
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
        console.warn("[XH ImageGetByIndex Lang] 应用语言失败:", e);
    }
}

app.registerExtension({
    name: "XH.ImageGetByIndex",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_TYPE) return;

        const origOnCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = origOnCreated?.apply(this, arguments);
            try {
                makeXHToolbar(this);                          // 中/EN + 🎨 家族工具条
                applyLang(this, currentLang());
                onLangChanged(() => applyLang(this, currentLang()));
            } catch (e) {
                console.warn("[XH-图像按序取] 初始化失败:", e);
            }
            return r;
        };

        const origOnRemoved = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function () {
            releaseButtons(this);
            return origOnRemoved?.apply(this, arguments);
        };
    },
});
