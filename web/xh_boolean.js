// 🔘XH-布尔开关 / 🔀XH-切换 · 家族前端
//
// 2026-10-23 家族模式化重写（用户截图实证后的定论）：
//   老方案 = 「把原生布尔 widget 从 node.widgets 里摘掉，自绘绿/红滑块顶替」，工具条（中/EN + 🎨）
//   是硬塞进滑块那一行里的（makeXHToolbar mount:false + 手动 appendChild）。
//   1.57 前端（Vue 渲染器）下这条路走不通：滑块 DOM 没渲染出来 ⇒ 连同一行的工具条一起消失，
//   节点只剩「标题 + 三个端口」，参数全是裸的（用户 2026-10-22 的截图就是这个）。
//   ⇒ 改回**家族标准形态**（跟其它 XH 节点一模一样）：
//        · 顶部一行标准工具条：makeXHToolbar（中/EN + 🎨），自带置顶 / 锁高 / 序列化加固
//        · 布尔值用**官方原生控件**：后端已传 label_on="开" / label_off="关"，
//          不会再出现官方那套机翻的「为真实 / 为假实」
//        · 端口与控件天生共存，不用再手工补 co-exist 输入口
//   删掉的东西都在 xh_boolean.js.家族模式化前_*.bak 里：
//        takeOverNativeWidget / ensurePort / makeToggleRow / 整套滑块绘制与拖拽。
const { app } = window.comfyAPI.app;

import {
    ensureLangBridge, makeXHToolbar, onLangChanged, releaseButtons, currentLang,
} from "./xh_ui_kit.js";

ensureLangBridge();

const NODE_TYPES = ["XHBooleanToggle", "XHBooleanSwitch"];

// ---- 文案表（家族三件套：nodes / widgets / slots）----
const XH_I18N = {
    zh: {
        nodes: {
            XHBooleanToggle: "🔘XH-布尔开关",
            XHBooleanSwitch: "🔀XH-切换",
        },
        widgets: {
            value: "开关",
            switch: "开关",
        },
        slots: {
            value: "值",
            BOOLEAN: "布尔值",
            switch: "开关",
            on_false: "假时值（关）",
            on_true: "真时值（开）",
            output: "输出",
        },
    },
    en: {
        nodes: {
            XHBooleanToggle: "XH Boolean Toggle",
            XHBooleanSwitch: "XH Switch",
        },
        widgets: {
            value: "value",
            switch: "switch",
        },
        slots: {
            value: "value",
            BOOLEAN: "boolean",
            switch: "switch",
            on_false: "on_false",
            on_true: "on_true",
            output: "output",
        },
    },
};

function t(lang, kind, key) {
    const pack = XH_I18N[lang] || XH_I18N.zh;
    return (pack[kind] && pack[kind][key]) || null;
}

// ---- 中/EN ----
function applyLang(node, lang) {
    if (!node) return;
    lang = lang || currentLang();
    try {
        const want = t(lang, "nodes", node.type);
        const zhT = XH_I18N.zh.nodes[node.type];
        const enT = XH_I18N.en.nodes[node.type];
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
        try { node.setDirtyCanvas && node.setDirtyCanvas(true, true); } catch (e) {}
    } catch (e) {
        console.warn("[🔘XH-布尔] 应用语言失败:", e);
    }
}

function nodesOfType() {
    try {
        return (app.graph?.nodes || app.graph?._nodes || []).filter((n) => NODE_TYPES.includes(n.type));
    } catch (e) { return []; }
}
function applyLangToAll() {
    const lang = currentLang();
    for (const n of nodesOfType()) applyLang(n, lang);
    try { app.graph?.setDirtyCanvas?.(true, true); } catch (e) {}
}

app.registerExtension({
    name: "XH.Boolean",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (!NODE_TYPES.includes(nodeData.name)) return;

        const origOnCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = origOnCreated ? origOnCreated.apply(this, arguments) : undefined;
            try {
                this.serialize_widgets = true;
                // 家族标准工具条：一行（中/EN + 🎨），自带 pinWidgetToTop / lockDomWidgetHeight / 序列化加固
                makeXHToolbar(this, { widgetName: "xh_boolean_bar" });
                applyLang(this);
            } catch (e) {
                console.warn("[🔘XH-布尔] 界面创建失败:", e);
            }
            return r;
        };

        // 载入 / 切换工作流后补一次（标题、端口名、控件名都按当前语言重刷）
        const origOnConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            const r = origOnConfigure ? origOnConfigure.apply(this, arguments) : undefined;
            try { applyLang(this); } catch (e) {}
            return r;
        };

        const origOnRemoved = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function () {
            releaseButtons(this);
            return origOnRemoved ? origOnRemoved.apply(this, arguments) : undefined;
        };
    },

    async setup() {
        onLangChanged(() => applyLangToAll());
    },
});
