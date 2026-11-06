// 🖼️XH-按比例缩放 · 家族前端
// ① 中/EN 切换：节点标题 + 参数控件标签 + 输入/输出端口名
// ② 下拉框中文显示，但**存档值仍是原版那几个英文串**（走官方 options.getOptionLabel，函数不进 JSON）
// ③ 节点自身配色 🎨（XH 家族 12 色 + 自定义取色器）
//
// 铁律：只改 label / title，绝不改 name；绝不改 COMBO 的 values；DOM 控件 serialize:false 且只 append。
const { app } = window.comfyAPI.app;

import {
    ensureLangBridge, makeXHToolbar, onLangChanged, releaseButtons, applyComboLabels,
} from "./xh_ui_kit.js";

ensureLangBridge();

const NODE_TYPE = "XHImageScaleByAspectRatio";
const XH_I18N = {
    zh: {
        nodes: { XHImageScaleByAspectRatio: "🖼️XH-按比例缩放" },
        widgets: {
            aspect_ratio: "目标比例",
            proportional_width: "自定义宽",
            proportional_height: "自定义高",
            fit: "适配方式",
            method: "缩放算法",
            round_to_multiple: "整除对齐",
            scale_to_side: "按边缩放",
            scale_to_length: "目标边长",
            background_color: "补边颜色",
            image: "图像",
            mask: "遮罩",
        },
        slots: {
            image: "图像",
            mask: "遮罩",
            original_size: "原始大小",
            width: "宽",
            height: "高",
        },
    },
    en: {
        nodes: { XHImageScaleByAspectRatio: "XH Scale By Aspect Ratio" },
        widgets: {
            aspect_ratio: "aspect ratio",
            proportional_width: "prop. width",
            proportional_height: "prop. height",
            fit: "fit mode",
            method: "method",
            round_to_multiple: "round to multiple",
            scale_to_side: "scale to side",
            scale_to_length: "scale to length",
            background_color: "background",
            image: "image",
            mask: "mask",
        },
        slots: {
            image: "image",
            mask: "mask",
            original_size: "original size",
            width: "width",
            height: "height",
        },
    },
};

// 下拉项中文显示（存档值不动）
const COMBO_LABELS = {
    aspect_ratio: {
        "original": "原图比例",
        "custom": "自定义",
        "1:1": "1:1 方形",
        "3:2": "3:2 横版",
        "4:3": "4:3 横版",
        "16:9": "16:9 横屏",
        "2:3": "2:3 竖版",
        "3:4": "3:4 竖版",
        "9:16": "9:16 竖屏",
    },
    fit: {
        "letterbox": "保持比例·补边",
        "crop": "保持比例·裁切",
        "fill": "拉伸填满",
    },
    method: {
        "lanczos": "兰索斯（高画质）",
        "bicubic": "双三次",
        "hamming": "汉明",
        "bilinear": "双线性",
        "box": "盒式",
        "nearest": "最近邻（最快）",
    },
    round_to_multiple: {
        "8": "8", "16": "16", "32": "32", "64": "64",
        "128": "128", "256": "256", "512": "512", "None": "不取整",
    },
    scale_to_side: {
        "None": "不缩放·用原尺寸",
        "longest": "最长边",
        "shortest": "最短边",
        "width": "宽",
        "height": "高",
        "total_pixel(kilo pixel)": "总像素(千像素)",
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
        applyComboLabels(node, lang, COMBO_LABELS);

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
        console.warn("[XH ImageScale] 应用语言失败:", e);
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
    name: "XH.ImageScaleByAspectRatio",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_TYPE) return;

        const origOnCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = origOnCreated?.apply(this, arguments);
            try {
                makeXHToolbar(this, { widgetName: "xh_image_scale_bar" });
                applyLang(this);
            } catch (e) {
                console.warn("[XH ImageScale] 界面创建失败:", e);
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
