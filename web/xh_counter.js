// 🔁XH-数字计数器 · 家族前端
// ① 中/EN 切换：节点标题 + **参数控件标签** + **输入/输出端口名**（照 xh_image_tools_lang.js 规范）
// ② 节点自身配色 🎨（XH 家族 12 色 + 自定义取色器）
//
// 铁律：
//   · 只改 label / title，绝不改 name（后端按 name 取参数，改了会坏）
//   · 只改 widget.label，绝不改 COMBO 的 values（values 是要存档的值，翻中文会让后端认不出）
//   · DOM 工具栏 serialize:false 且只 append 不 unshift，绝不顶乱 widgets_values 下标
const { app } = window.comfyAPI.app;

import { ensureLangBridge, makeXHToolbar, onLangChanged, releaseButtons } from "./xh_ui_kit.js";

ensureLangBridge();
const NODE_TYPE = "XHNumberCounter";
// ---- 文案表 ----
const XH_I18N = {
    zh: {
        nodes: { XHNumberCounter: "🔁XH-数字计数器" },
        widgets: {
            number_type: "输出类型",
            mode: "计数模式",
            start: "起始值",
            stop: "停止值",
            step: "步长",
        },
        slots: {
            reset_bool: "重置信号",
            number: "数值",
            float: "浮点",
            int: "整数",
        },
    },
    en: {
        nodes: { XHNumberCounter: "XH Number Counter" },
        widgets: {
            number_type: "number_type",
            mode: "mode",
            start: "start",
            stop: "stop",
            step: "step",
        },
        slots: {
            reset_bool: "reset_bool",
            number: "number",
            float: "float",
            int: "int",
        },
    },
};

function t(lang, kind, key) {
    const pack = XH_I18N[lang] || XH_I18N.zh;
    return (pack[kind] && pack[kind][key]) || null;
}

// ---- 下拉框「值→显示」映射（只改显示，绝不改 value/options.values —— 存档值必须保持英文）----
// 依据（已核实前端源码 settingStore-*.js 的 ComboWidget._displayValue）：
//   combo 显示文本优先走 options.getOptionLabel(value)，下拉列表组件同款回调。
//   函数不会被 JSON 序列化 → 工作流存档里存的仍是 integer/float/increment 等英文原值，后端照常识别。
const VALUE_LABELS = {
    integer: "整数",
    float: "浮点",
    increment: "递增",
    decrement: "递减",
    increment_to_stop: "递增到停止值",
    decrement_to_stop: "递减到停止值",
    reset_after_stop: "到顶后回卷",
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
            // 英文态：删掉映射，恢复原样显示
            delete w.options.getOptionLabel;
        }
    }
    try { node.setDirtyCanvas?.(true, true); } catch (e) {}
}

function applyLang(node, lang) {
    if (!node) return;
    lang = lang || window.XH_LANG || "zh";
    try {
        // 标题：只在还是默认显示名时才重写，保留用户自定义标题
        const zhT = XH_I18N.zh.nodes[NODE_TYPE];
        const enT = XH_I18N.en.nodes[NODE_TYPE];
        const want = t(lang, "nodes", NODE_TYPE);
        if (want && (node.title === zhT || node.title === enT || !node.title)) node.title = want;

        // 参数控件标签（只改 label）
        if (node.widgets) {
            for (const w of node.widgets) {
                if (!w || !w.name) continue;
                const lb = t(lang, "widgets", w.name);
                if (lb) w.label = lb;
            }
        }

        // 下拉框选项显示映射（integer→整数 等；只改显示，value 不动）
        applyComboValueLabels(node, lang);

        // 输入 / 输出端口名
        const applySlots = (arr) => {
            if (!arr) return;
            for (const s of arr) {
                const lb = t(lang, "slots", s && s.name);
                if (lb) s.label = lb;
            }
        };
        applySlots(node.inputs);
        applySlots(node.outputs);

        // Nodes 2.0 端口标签走快照渲染，改完必须显式触发重建（官方 renameWidget 同机制）
        try {
            node.graph?.trigger?.("node:slot-label:changed", { nodeId: node.id, slotType: 1 });
            node.graph?.trigger?.("node:slot-label:changed", { nodeId: node.id, slotType: 2 });
        } catch (e) {}
        try { node.setDirtyCanvas?.(true, true); } catch (e) {}
    } catch (e) {
        console.warn("[XH Counter Lang] 应用语言失败:", e);
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
    name: "XH.NumberCounter",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_TYPE) return;

        const origOnCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = origOnCreated?.apply(this, arguments);
            try {
                // 标准工具条（中/EN + 🎨）—— 家族唯一实现见 web/xh_ui_kit.js
                const { bar, langBtn, colorBtn } = makeXHToolbar(this, { widgetName: "xh_counter_bar" });
                this._xhLangBtn = langBtn;

                applyLang(this);
            } catch (e) {
                console.warn("[XH Counter] 工具栏创建失败:", e);
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
        // 别的家族包切语言 → 同步本节点
        // 语言变更 + 工作流载入重刷 —— 统一走 kit（等价实现，见 web/xh_ui_kit.js）
        onLangChanged(() => applyLangToAll());
    },
});
