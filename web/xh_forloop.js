// 🔁XH-循环开始 / 🔁XH-循环结束 · 家族前端
// ① 中/EN 切换：节点标题 + **参数控件标签** + **输入/输出端口名**（照 xh_counter.js 规范）
// ② 节点自身配色 🎨（XH 家族 12 色 + 自定义取色器）
//
// 铁律：
//   · 只改 label / title，绝不改 name（后端按 name 取参数，改了会坏）
//   · DOM 工具栏 serialize:false 且只 append 不 unshift，绝不顶乱 widgets_values 下标
//   · py 的 class_type 必须与下面 NODE_TYPES 逐字一致
const { app } = window.comfyAPI.app;

import { ensureLangBridge, makeXHToolbar, onLangChanged, releaseButtons } from "./xh_ui_kit.js";

ensureLangBridge();
const NODE_TYPES = ["XHForLoopStart", "XHForLoopEnd"];
// ---- 文案表（两个节点共用一张 widgets/slots 表）----
const XH_I18N = {
    zh: {
        nodes: {
            XHForLoopStart: "🔁XH-循环开始",
            XHForLoopEnd: "🔁XH-循环结束",
        },
        widgets: {
            num_iterations: "次数",
            start_index: "起始索引",
            step: "步长",
            cache_iterations: "缓存迭代",
            initial_value: "初始传入值(0)",
            initial_value_1: "初始传入值(1)",
            initial_value_2: "初始传入值(2)",
            initial_value_3: "初始传入值(3)",
            output_value: "本轮产物(0)",
            output_value_1: "本轮产物(1)",
            output_value_2: "本轮产物(2)",
            output_value_3: "本轮产物(3)",
            next_value: "回传值(0)",
            next_value_1: "回传值(1)",
            next_value_2: "回传值(2)",
            next_value_3: "回传值(3)",
            accumulate: "累计",
            terminations: "每轮执行",
            list: "列表",
            list_2: "列表2",
            list_3: "列表3",
        },
        slots: {
            terminations: "每轮执行",
            index: "索引",
            is_first: "首轮",
            is_last: "末轮",
            current_value: "传入值(0)",
            current_value_1: "传入值(1)",
            current_value_2: "传入值(2)",
            current_value_3: "传入值(3)",
            initial_value: "初始传入值(0)",
            initial_value_1: "初始传入值(1)",
            initial_value_2: "初始传入值(2)",
            initial_value_3: "初始传入值(3)",
            output_value: "本轮产物(0)",
            output_value_1: "本轮产物(1)",
            output_value_2: "本轮产物(2)",
            output_value_3: "本轮产物(3)",
            next_value: "回传值(0)",
            next_value_1: "回传值(1)",
            next_value_2: "回传值(2)",
            next_value_3: "回传值(3)",
            outputs: "产物(0)",
            outputs_1: "产物(1)",
            outputs_2: "产物(2)",
            outputs_3: "产物(3)",
            list: "列表",
            list_2: "列表2",
            list_3: "列表3",
            list_item: "当前项",
            list_item_2: "当前项(2)",
            list_item_3: "当前项(3)",
        },
    },
    en: {
        nodes: {
            XHForLoopStart: "XH For Loop Start",
            XHForLoopEnd: "XH For Loop End",
        },
        widgets: {
            num_iterations: "num_iterations",
            start_index: "start_index",
            step: "step",
            cache_iterations: "cache_iterations",
            initial_value: "initial_value",
            initial_value_1: "initial_value_1",
            initial_value_2: "initial_value_2",
            initial_value_3: "initial_value_3",
            output_value: "output_value",
            output_value_1: "output_value_1",
            output_value_2: "output_value_2",
            output_value_3: "output_value_3",
            next_value: "next_value",
            next_value_1: "next_value_1",
            next_value_2: "next_value_2",
            next_value_3: "next_value_3",
            accumulate: "accumulate",
            terminations: "terminations",
            list: "list",
            list_2: "list_2",
            list_3: "list_3",
        },
        slots: {
            terminations: "terminations",
            index: "index",
            is_first: "is_first",
            is_last: "is_last",
            current_value: "current_value",
            current_value_1: "current_value_1",
            current_value_2: "current_value_2",
            current_value_3: "current_value_3",
            initial_value: "initial_value",
            initial_value_1: "initial_value_1",
            initial_value_2: "initial_value_2",
            initial_value_3: "initial_value_3",
            output_value: "output_value",
            output_value_1: "output_value_1",
            output_value_2: "output_value_2",
            output_value_3: "output_value_3",
            next_value: "next_value",
            next_value_1: "next_value_1",
            next_value_2: "next_value_2",
            next_value_3: "next_value_3",
            outputs: "outputs",
            outputs_1: "outputs_1",
            outputs_2: "outputs_2",
            outputs_3: "outputs_3",
            list: "list",
            list_2: "list_2",
            list_3: "list_3",
            list_item: "list_item",
            list_item_2: "list_item_2",
            list_item_3: "list_item_3",
        },
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
        const want = t(lang, "nodes", node.type);
        if (want) {
            const zhT = XH_I18N.zh.nodes[node.type];
            const enT = XH_I18N.en.nodes[node.type];
            if (!node.title || node.title === zhT || node.title === enT) node.title = want;
        }

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
                if (!s || !s.name) continue;
                // 每轮执行端口是自动增长的：termination / termination1...
                if (String(s.name).startsWith("termination")) {
                    s.label = lang === "zh" ? "每轮执行" : "termination";
                    continue;
                }
                const lb = t(lang, "slots", s.name);
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
        console.warn("[XH ForLoop Lang] 应用语言失败:", e);
    }
}

function nodesOfType() {
    try {
        return (app.graph?.nodes || app.graph?._nodes || []).filter((n) => NODE_TYPES.includes(n.type));
    } catch (e) { return []; }
}
function applyLangToAll() {
    const lang = window.XH_LANG || "zh";
    for (const n of nodesOfType()) applyLang(n, lang);
    try { app.graph?.setDirtyCanvas?.(true, true); } catch (e) {}
}


// 标准工具条（中/EN + 🎨）—— 家族唯一实现见 web/xh_ui_kit.js
function buildToolbar(node) {
    makeXHToolbar(node, { widgetName: "xh_forloop_bar" });
}

app.registerExtension({
    name: "XH.ForLoop",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (!NODE_TYPES.includes(nodeData.name)) return;

        const origOnCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = origOnCreated?.apply(this, arguments);
            try {
                // 内部自己 addDOMWidget + 强制置顶
                buildToolbar(this);
                applyLang(this);
            } catch (e) {
                console.warn("[XH ForLoop] 工具栏创建失败:", e);
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
