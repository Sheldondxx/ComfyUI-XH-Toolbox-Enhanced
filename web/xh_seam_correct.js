// 🩹XH-接缝修正 · 家族前端
// ① 语言桥：window.XH_LANG accessor + xh:lang-changed 广播（全家族同步）
// ② 中/EN：节点标题 + 参数标签 + 端口名 + 下拉框选项文字（四处全覆盖）
// ③ 🎨 家族 12 色 + 自定义取色器
//
// 算法本体在 py/h3_seam_impl.py（照搬 ComfyUI_MinimaxH3_AutoContext，Apache-2.0）。
// 铁律：只改 label / title / getOptionLabel，绝不改 name、绝不改 COMBO 的 values。
const { app } = window.comfyAPI.app;
import { ensureLangBridge, makeXHToolbar, onLangChanged, releaseButtons, applyComboLabels } from "./xh_ui_kit.js";

ensureLangBridge();

const NODE_TYPE = "XHSeamCorrect";

const XH_I18N = {
    zh: {
        nodes: { XHSeamCorrect: "🩹XH-接缝修正" },
        widgets: {
            images: "视频帧",
            fix_color_preset: "色彩/曝光修正",
            fix_motion_preset: "接缝运动修正",
            fix_flash: "闪帧抑制",
            flash_threshold: "闪帧阈值",
            cut_detection: "镜头切分",
            cut_threshold: "镜头检测敏感度",
            blend_frames: "渐变帧数",
            use_gpu: "用 GPU 计算",
        },
        slots: { images: "视频帧" },
    },
    en: {
        nodes: { XHSeamCorrect: "🩹XH-Seam Correct" },
        widgets: {
            images: "images",
            fix_color_preset: "color / exposure fix",
            fix_motion_preset: "seam motion fix",
            fix_flash: "flash suppress",
            flash_threshold: "flash threshold",
            cut_detection: "shot cut detection",
            cut_threshold: "cut sensitivity",
            blend_frames: "blend frames",
            use_gpu: "use GPU",
        },
        slots: { images: "images" },
    },
};

// 下拉框「中文态纯中文、英文态回落原值」（走官方 getOptionLabel 钩子；key 是英文存值，不动）
const COMBO_LABELS = {
    fix_color_preset: {
        off: "关",
        low: "低",
        medium: "中（推荐）",
        high: "高",
        max: "最高（flatten）",
    },
    fix_motion_preset: {
        off: "关（默认）",
        low: "低",
        medium: "中",
        high: "高",
        max: "最高",
    },
};

function normalizeType(t) {
    return typeof t === "string" ? t.replace(/^[^\w]+/, "") : t;
}
function isMyNode(t) {
    return normalizeType(t) === NODE_TYPE;
}

function applyLangToNode(node) {
    if (!node || !isMyNode(node.type)) return;
    const lang = window.XH_LANG || "zh";
    const pack = XH_I18N[lang] || XH_I18N.zh;
    try {
        const zhT = XH_I18N.zh.nodes[NODE_TYPE];
        const enT = XH_I18N.en.nodes[NODE_TYPE];
        if (!node.title || node.title === zhT || node.title === enT) node.title = pack.nodes[NODE_TYPE];

        if (node.widgets) {
            for (const w of node.widgets) {
                if (w && w.name && pack.widgets[w.name]) w.label = pack.widgets[w.name];
            }
        }
        const applySlots = (arr) => {
            for (const s of arr || []) if (s && s.name && pack.slots[s.name]) s.label = pack.slots[s.name];
        };
        applySlots(node.inputs);
        applySlots(node.outputs);

        applyComboLabels(node, lang, COMBO_LABELS);

        try {
            node.graph?.trigger?.("node:slot-label:changed", { nodeId: node.id, slotType: 1 });
            node.graph?.trigger?.("node:slot-label:changed", { nodeId: node.id, slotType: 2 });
        } catch (e) {}
        try { node.setDirtyCanvas?.(true, true); } catch (e) {}
    } catch (e) {
        console.warn("[XH SeamCorrect] 应用语言失败:", e);
    }
}

function applyLangToAll() {
    try {
        for (const n of (app.graph ? (app.graph.nodes || app.graph._nodes || []) : [])) applyLangToNode(n);
        app.graph?.setDirtyCanvas?.(true, true);
    } catch (e) {}
}

app.registerExtension({
    name: "XH.SeamCorrect.FamilyUI",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (!isMyNode(nodeData.name)) return;

        const origOnCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = origOnCreated?.apply(this, arguments);
            try {
                applyLangToNode(this);
                makeXHToolbar(this);
            } catch (e) {
                console.warn("[XH SeamCorrect] 工具条创建失败:", e);
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
