// 📐XH-分辨率选择器 · 家族前端
// ① 中/EN 切换：节点标题 + 参数控件标签 + 输入/输出端口名（照 xh_mathint.js 规范）
// ② 下拉框「宽高比」显示中文，但**存档值仍是官方那 8 个英文串**（走官方 options.getOptionLabel，函数不进 JSON）
// ③ 实时预览条：节点上直接显示最终生效的 `1024 × 1024 · 1.00 MP`
//    —— 与后端 controls/resolution_select.py **同一套公式**（含 Python 的「四舍六入五成双」取整），
//       所以节点上看到的就是真跑出来的值，不是估算。
// ④ 节点自身配色 🎨（XH 家族 12 色 + 自定义取色器）
//
// 铁律：只改 label / title，绝不改 name；绝不改 COMBO 的 values；DOM 控件 serialize:false 且只 append。
const { app } = window.comfyAPI.app;

import {
    ensureLangBridge, makeXHToolbar, onLangChanged, releaseButtons, applyComboLabels, lockDomWidgetHeight,
} from "./xh_ui_kit.js";

ensureLangBridge();
const NODE_TYPE = "XHResolutionSelect";
const XH_I18N = {
    zh: {
        nodes: { XHResolutionSelect: "📐XH-分辨率选择器" },
        widgets: {
            aspect_ratio: "宽高比",
            megapixels: "百万像素 (MP)",
            multiple: "倍数对齐",
        },
        // ⚠️ slots 表按【端口名】查（不是类型名）：输出口叫 width / height。
        slots: { width: "宽", height: "高" },
    },
    en: {
        nodes: { XHResolutionSelect: "XH Resolution Selector" },
        widgets: {
            aspect_ratio: "aspect ratio",
            megapixels: "megapixels (MP)",
            multiple: "multiple of",
        },
        slots: { width: "width", height: "height" },
    },
};

// 必须与 controls/resolution_select.py 的 ASPECT_RATIOS 逐条对应（键 = 存档值）
const RATIO_TABLE = {
    "1:1 (Square)": [1, 1],
    "2:3 (Portrait Photo)": [2, 3],
    "3:2 (Photo)": [3, 2],
    "3:4 (Portrait Standard)": [3, 4],
    "4:3 (Standard)": [4, 3],
    "9:16 (Portrait Widescreen)": [9, 16],
    "16:9 (Widescreen)": [16, 9],
    "21:9 (Ultrawide)": [21, 9],
};
const DEFAULT_RATIO = "1:1 (Square)";

// 下拉「宽高比」的中文显示（存档值不动）
const RATIO_LABELS = {
    "1:1 (Square)": "1:1 方形",
    "2:3 (Portrait Photo)": "2:3 竖版照片",
    "3:2 (Photo)": "3:2 横版照片",
    "3:4 (Portrait Standard)": "3:4 竖版标准",
    "4:3 (Standard)": "4:3 横版标准",
    "9:16 (Portrait Widescreen)": "9:16 竖屏（短视频）",
    "16:9 (Widescreen)": "16:9 横屏",
    "21:9 (Ultrawide)": "21:9 超宽屏",
};

function t(lang, kind, key) {
    const pack = XH_I18N[lang] || XH_I18N.zh;
    return (pack[kind] && pack[kind][key]) || null;
}

function widgetValue(node, name, fallback) {
    const w = (node.widgets || []).find((x) => x && x.name === name);
    if (!w) return fallback;
    const v = w.value;
    return (v === undefined || v === null || v === "") ? fallback : v;
}

// Python 的 round() 是「四舍六入五成双」，JS 的 Math.round 是「逢五进一」——
// 后端是 Python，前端必须跟着用同一套，否则预览条会和实际输出差 1 个倍数。
function pyRound(x) {
    const f = Math.floor(x);
    const d = x - f;
    if (Math.abs(d - 0.5) < 1e-9) return (f % 2 === 0) ? f : f + 1;
    return Math.round(x);
}

function compute(node) {
    const ratio = String(widgetValue(node, "aspect_ratio", DEFAULT_RATIO));
    const pair = RATIO_TABLE[ratio] || RATIO_TABLE[DEFAULT_RATIO];
    let mp = parseFloat(widgetValue(node, "megapixels", 1));
    let mult = parseInt(widgetValue(node, "multiple", 8), 10);
    if (!isFinite(mp) || mp < 0.01) mp = 0.01;
    if (!isFinite(mult) || mult < 1) mult = 1;
    const w_ratio = pair[0], h_ratio = pair[1];
    const scale = Math.sqrt((mp * 1024 * 1024) / (w_ratio * h_ratio));
    let width = pyRound((w_ratio * scale) / mult) * mult;
    let height = pyRound((h_ratio * scale) / mult) * mult;
    width = Math.max(mult, width);
    height = Math.max(mult, height);
    return { width, height, mp: (width * height) / (1024 * 1024) };
}

function fmt(n) {
    return String(Math.round(n));
}

function refreshPreview(node) {
    if (!node || !node._xhResText) return;
    try {
        const r = compute(node);
        node._xhResText.textContent = `${fmt(r.width)} × ${fmt(r.height)}  ·  ${r.mp.toFixed(2)} MP`;
        node.setDirtyCanvas?.(true, true);
    } catch (e) {
        console.warn("[XH Resolution] 预览刷新失败:", e);
    }
}

// ---- 实时预览条（DOM widget，serialize:false，只 append）----
function makePreviewBar(node) {
    const el = document.createElement("div");
    el.style.cssText = "display:flex;align-items:center;justify-content:center;padding:6px 8px;"
        + "width:100%;box-sizing:border-box;border-radius:6px;"
        + "background:rgba(255,255,255,0.10);"
        + "font-family:system-ui,-apple-system,\"Segoe UI\",\"Microsoft YaHei\",sans-serif;"
        + "font-size:12px;font-weight:700;letter-spacing:normal;"
        + "color:#ffffff;text-shadow:0 1px 2px rgba(0,0,0,0.35);"
        + "user-select:none;cursor:default;";
    const text = document.createElement("span");
    el.appendChild(text);
    node._xhResText = text;

    let w = null;
    try {
        w = node.addDOMWidget("xh_resolution_preview", "custom", el, {
            serialize: false,      // 🔴 绝不进工作流 JSON
            hideOnZoom: false,
            getMinHeight: () => 26,
        });
    } catch (e) {
        console.warn("[XH Resolution] 预览条挂载失败:", e);
    }
    // 🔴 2026-10-13 修复：预览条只给了 getMinHeight，没 computeSize → 拖高节点时被撑成大片空条。钉死固定高度。
    //    🔴 2026-10-14 补：Vue Nodes 下行高只看 hasLayoutSize ⇒ lockDomWidgetHeight 连 computeLayoutSize 一起撤。
    lockDomWidgetHeight(w, 26);

    // 参数一改就重算：包住原回调，绝不覆盖
    for (const name of ["aspect_ratio", "megapixels", "multiple"]) {
        const wd = (node.widgets || []).find((x) => x && x.name === name);
        if (!wd || wd._xhResHooked) continue;
        wd._xhResHooked = true;
        const orig = wd.callback;
        wd.callback = function () {
            const r = orig ? orig.apply(this, arguments) : undefined;
            refreshPreview(node);
            return r;
        };
    }

    refreshPreview(node);
    return w;
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
        applyComboLabels(node, lang, { aspect_ratio: RATIO_LABELS });

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
        refreshPreview(node);
        try { node.setDirtyCanvas?.(true, true); } catch (e) {}
    } catch (e) {
        console.warn("[XH Resolution Lang] 应用语言失败:", e);
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
    name: "XH.ResolutionSelect",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_TYPE) return;

        const origOnCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = origOnCreated?.apply(this, arguments);
            try {
                // 标准工具条（中/EN + 🎨）—— 家族唯一实现见 web/xh_ui_kit.js
                const { langBtn } = makeXHToolbar(this, { widgetName: "xh_resolution_bar" });
                this._xhLangBtn = langBtn;

                makePreviewBar(this);
                applyLang(this);
            } catch (e) {
                console.warn("[XH ResolutionSelect] 界面创建失败:", e);
            }
            return r;
        };

        // 🔴 工作流载入 / 切换后重刷预览条（2026-10-09 修 bug）
        // 根因：onNodeCreated 时 widgets 还是默认值（1:1 / 1.0MP → 1024×1024），
        //       存档值要到 graph.configure() 灌进 widgets 之后才有；而 kit 里挂在
        //       app.graph.configure 上的重刷层，在「切换工作流 → graph 对象重建」后会失效。
        // 修法：挂在节点原型的 onConfigure 上 —— LiteGraph 在**本节点的 widgets_values
        //       应用完毕之后**必调它，graph 怎么重建都不受影响。
        const origOnConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            const r = origOnConfigure?.apply(this, arguments);
            try { refreshPreview(this); } catch (e) {}
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
