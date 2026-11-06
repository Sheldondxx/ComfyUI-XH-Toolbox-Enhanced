// 🔁XH-色调补偿 · 家族前端
// ① 中/EN 切换：节点标题 + 参数控件标签 + 输入/输出端口名（照 xh_mathint.js 规范）
// ② 下拉框「模式」显示中文说明，但**存档值仍是英文**（走官方 options.getOptionLabel，函数不进 JSON）
// ③ 节点自身配色 🎨（XH 家族 12 色 + 自定义取色器）
//
// 铁律：只改 label / title，绝不改 name；绝不改 COMBO 的 values；DOM 工具栏 serialize:false 且只 append。
const { app } = window.comfyAPI.app;

import { ensureLangBridge, makeXHToolbar, onLangChanged, releaseButtons } from "./xh_ui_kit.js";

ensureLangBridge();
const NODE_TYPE = "XHToneCompensate";
const XH_I18N = {
    zh: {
        nodes: { XHToneCompensate: "🔁XH-色调补偿" },
        widgets: {
            mode: "模式",
            overlap: "关键帧帧数",
            strength: "补偿强度",
            lut_bins: "LUT 分箱",
        },
        // ⚠️ slots 表按【端口名】查（不是类型名）：输入口叫 source/target、输出口叫 IMAGE/info。
        //    source/target 是 IMAGE 端口，不是控件 —— 中文必须写在这里，写进 widgets 表永远不生效。
        slots: {
            source: "上一段帧",
            target: "本段帧",
            IMAGE: "图像",
            info: "信息",
        },
    },
    en: {
        nodes: { XHToneCompensate: "XH Tone Compensate" },
        widgets: {
            mode: "mode",
            overlap: "keyframe frames",
            strength: "strength",
            lut_bins: "LUT bins",
        },
        slots: {
            source: "source (prev clip)",
            target: "target (this clip)",
            IMAGE: "IMAGE",
            info: "info",
        },
    },
};

function t(lang, kind, key) {
    const pack = XH_I18N[lang] || XH_I18N.zh;
    return (pack[kind] && pack[kind][key]) || null;
}

// ---- 下拉「模式」显示中文（只改显示，value 保持英文：frame_shift / gain_bias / lut）----
const VALUE_LABELS = {
    frame_shift: "逐帧偏移（最准·推荐）",
    gain_bias: "全局增益+偏置（稳健）",
    lut: "色调曲线 LUT（非线性）",
};

function applyComboValueLabels(node, lang) {
    if (!node || !node.widgets) return;
    const zh = (lang || window.XH_LANG || "zh") === "zh";
    for (const w of node.widgets) {
        if (!w || w.type !== "combo" || !w.options) continue;
        if (zh) {
            w.options.getOptionLabel = (v) => {
                if (v == null) return "";
                return VALUE_LABELS[String(v)] || String(v);
            };
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
        console.warn("[XH Tone Lang] 应用语言失败:", e);
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
    name: "XH.ToneCompensate",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_TYPE) return;

        const origOnCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = origOnCreated?.apply(this, arguments);
            try {
                // 标准工具条（中/EN + 🎨）—— 家族唯一实现见 web/xh_ui_kit.js
                const { bar, langBtn, colorBtn } = makeXHToolbar(this, { widgetName: "xh_tone_bar" });
                this._xhLangBtn = langBtn;

                applyLang(this);
            } catch (e) {
                console.warn("[XH ToneCompensate] 工具栏创建失败:", e);
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
