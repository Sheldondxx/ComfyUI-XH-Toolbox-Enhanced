// 🔁XH-计算器 前端 —— Nodes 2.0 原生 DOM UI（照 xh_slider.js 的架构）
// 设计铁律（全部源自 frontend_n2.md + XH 家族已验证的坑）：
// 1. UI 全部走 addDOMWidget，绝不 onDrawForeground 手画
// 2. 数据唯一载体是后端声明的标准 STRING widget（calc_state），存档/执行走官方链路
// 3. 绝不增删/重排 node.widgets
// 4. 求值走白名单（只允许数字与 + - * / % 与括号），不执行任何代码
const { app } = window.comfyAPI.app;

import { ensureLangBridge, makeXHToolbar, releaseButtons } from "./xh_ui_kit.js";

ensureLangBridge();
const NODE_TYPE = "XHCalculator";
const LANG_KEY = "xh_node_lang";
const DEFAULT_STATE = '{"expr":"","result":0}';

// ---- 与 XH 家族的语言状态桥接 ----
function getLang() {
    try { return (window.XH_LANG === "en" || localStorage.getItem(LANG_KEY) === "en") ? "en" : "zh"; }
    catch (e) { return "zh"; }
}

// ---- 安全求值（与后端白名单一致）----
// 🔴 2026-10-21 修：键盘「−」键是 U+2212（排版用真减号），不是 ASCII "-"。
//    前后端白名单原本只放行 ASCII ⇒ 任何含减号的算式按 = 必报「错误」。
//    这里统一把 U+2212 归一成 ASCII "-" 再进白名单（± 键产生的本来就是 ASCII，不受影响）。
//    顺带放行 e/E（科学计数法）：否则 1e21 这类结果前端能显示、后端却白名单毙掉给 0，
//    两口输出不一致。eval/Function 才是最终裁判，白名单只挡危险字符，不挡合法数字形态。
function safeEval(src) {
    if (src == null) return null;
    let s = String(src).trim();
    if (!s) return null;
    s = s.replace(/×/g, "*").replace(/÷/g, "/").replace(/%/g, "/100").replace(/−/g, "-");
    if (!/^[0-9.()+\-*/ eE]+$/.test(s)) return null;
    try {
        // 白名单已保证 s 只含数字与 + - * / e 与括号，用 Function 构造纯算术表达式求值
        const val = Function(`"use strict";return (${s})`)();
        if (typeof val !== "number" || !isFinite(val)) return null;
        return val;
    } catch (e) { return null; }
}

function fmt(v) {
    if (v == null) return "";
    if (Number.isInteger(v)) return String(v);
    // 去掉浮点尾噪（0.30000000000000004 → 0.3）
    return String(parseFloat(Number(v).toPrecision(12)));
}

// ---- 语言包：节点标题 + 端口标签（按钮符号通用，不翻译）----
const XH_I18N = {
    zh: {
        nodes: { XHCalculator: "🔁XH-计算器" },
        widgets: { calc_state: "状态" },
        slots: { FLOAT: "浮点数", STRING: "字符串" },
    },
    en: {
        nodes: { XHCalculator: "🔁XH-Calculator" },
        widgets: { calc_state: "state" },
        slots: { FLOAT: "FLOAT", STRING: "STRING" },
    },
};
function t(lang, kind, key) {
    const pack = XH_I18N[lang] || XH_I18N.zh;
    return (pack[kind] && pack[kind][key]) || null;
}

// ---- 样式（一次注入）----
let _styleInjected = false;
function injectStyle() {
    if (_styleInjected) return;
    _styleInjected = true;
    const css = `
    .xh-cal-root{display:flex;flex-direction:column;gap:6px;padding:6px;width:100%;box-sizing:border-box;
        font-family:sans-serif;color:inherit;user-select:none;}
    .xh-cal-screen{flex:none;min-height:48px;padding:8px 12px;border-radius:6px;background:#0b0e13;
        border:1px solid rgba(255,255,255,.12);color:#e8edf5;text-align:right;
        font-family:"SF Mono","JetBrains Mono","Roboto Mono",ui-monospace,Menlo,Consolas,monospace;
        font-size:26px;font-weight:700;line-height:1.25;letter-spacing:.5px;
        overflow:hidden;white-space:nowrap;text-overflow:ellipsis;word-break:break-all;}
    .xh-cal-screen.err{color:#ff6b6b;}
    .xh-cal-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:5px;}
    .xh-cal-grid button{height:36px;border:1px solid rgba(255,255,255,.14);border-radius:6px;
        font-size:15px;font-weight:600;cursor:pointer;color:#e8edf5;background:#222831;
        transition:filter .08s;}
    .xh-cal-grid button:hover{filter:brightness(1.18);}
    .xh-cal-grid button:active{filter:brightness(.85);}
    /* 配色对齐家族方案 B：运算符/等号 = primary 蓝实心，功能键 = neutral 暗底。
       ⛔ 保留 36px 大按键尺寸 —— 这是计算器键盘，不是工具条按钮，别硬压成 22px。 */
    .xh-cal-grid button.xh-op{background:#1668b3;color:#fff;}
    .xh-cal-grid button.xh-eq{background:#1668b3;color:#fff;}
    .xh-cal-grid button.xh-fn{background:#262d38;color:#d5dde5;border:1px solid rgba(255,255,255,.10);}
    `;
    const el = document.createElement("style");
    el.textContent = css;
    document.head.appendChild(el);
}

function buildUI(node) {
    injectStyle();
    const ctx = { lang: getLang(), expr: "", justEvaled: false, screen: null, jsonWidget: null, root: null };

    const root = document.createElement("div");
    root.className = "xh-cal-root";

    // 工具条：中/EN + 🎨（家族唯一实现见 web/xh_ui_kit.js）
    const { bar: toolbar } = makeXHToolbar(node, { widgetName: "xh_calculator_bar" });

    // 显示屏（顶部）
    const screen = document.createElement("div");
    screen.className = "xh-cal-screen";
    screen.textContent = "0";

    // 键盘
    const grid = document.createElement("div");
    grid.className = "xh-cal-grid";
    // [label, kind] kind: fn / op / eq / num
    const keys = [
        ["C", "fn"], ["⌫", "fn"], ["±", "fn"], ["%", "fn"],
        ["7", "num"], ["8", "num"], ["9", "num"], ["÷", "op"],
        ["4", "num"], ["5", "num"], ["6", "num"], ["×", "op"],
        ["1", "num"], ["2", "num"], ["3", "num"], ["−", "op"],
        ["0", "num"], [".", "num"], ["=", "eq"], ["+", "op"],
    ];
    const btn = (label, kind) => {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = label;
        b.className = kind === "op" ? "xh-op" : kind === "eq" ? "xh-eq" : kind === "fn" ? "xh-fn" : "";
        b.addEventListener("click", (e) => { e.stopPropagation(); onKey(label); });
        return b;
    };
    for (const [label, kind] of keys) grid.appendChild(btn(label, kind));

    root.appendChild(toolbar);
    root.appendChild(screen);
    root.appendChild(grid);
    ctx.root = root;
    ctx.screen = screen;

    function render() {
        const txt = ctx.expr === "" ? "0" : ctx.expr;
        screen.textContent = txt;
        screen.classList.remove("err");
    }

    function onKey(k) {
        const isOp = (c) => c === "+" || c === "−" || c === "×" || c === "÷";
        if (ctx.justEvaled && k !== "=" && !isOp(k) && k !== "C" && k !== "⌫" && k !== "±" && k !== "%") {
            // 刚算完、接着按数字/小数点 → 开新算式
            ctx.expr = "";
        }
        ctx.justEvaled = false;

        if (k === "C") { ctx.expr = ""; render(); sync(); return; }
        if (k === "⌫") { ctx.expr = ctx.expr.slice(0, -1); render(); sync(); return; }
        if (k === "±") { toggleSign(); render(); sync(); return; }
        if (k === "=") { doEqual(); return; }

        // 运算符：和上一个运算符连续时替换（更符合真计算器手感）
        if (isOp(k)) {
            const last = ctx.expr.slice(-1);
            if (ctx.expr !== "" && isOp(last)) {
                ctx.expr = ctx.expr.slice(0, -1) + k;
            } else if (ctx.expr === "" && k !== "−") {
                // 开头只允许减号（负数），其余运算符忽略
                render(); sync(); return;
            } else {
                ctx.expr += k;
            }
            render(); sync(); return;
        }

        // 小数点：当前数字已有小数点则忽略
        if (k === ".") {
            const m = ctx.expr.match(/(\d*\.?\d*)$/);
            if (m && m[1].includes(".")) { render(); return; }
            if (ctx.expr === "" || isOp(ctx.expr.slice(-1))) ctx.expr += "0";
            ctx.expr += ".";
            render(); sync(); return;
        }

        // 数字
        ctx.expr += k;
        render(); sync();
    }

    function toggleSign() {
        const m = ctx.expr.match(/-?\d*\.?\d*$/);
        if (!m) return;
        const num = m[0];
        if (num === "" || num === "0") return;
        const start = m.index;
        const neg = num.startsWith("-") ? num.slice(1) : "-" + num;
        ctx.expr = ctx.expr.slice(0, start) + neg;
    }

    function doEqual() {
        const r = safeEval(ctx.expr);
        if (r == null) {
            screen.textContent = "错误";
            screen.classList.add("err");
            return;
        }
        const out = fmt(r);
        ctx.expr = out;          // 显示结果，下次按数字开新算式
        ctx.justEvaled = true;
        screen.classList.remove("err");
        screen.textContent = out;
        sync();
    }

    ctx.measure = function () {
        try { return (ctx.root.scrollHeight || 200) + 4; } catch (e) { return 220; }
    };
    ctx.relayout = function () {
        try { node.onResize?.(node.size); node.setDirtyCanvas?.(true, true); } catch (e) {}
    };

    function loadState(txt) {
        let s = txt;
        if (typeof s === "string") { try { s = JSON.parse(s || "{}"); } catch (e) { s = {}; } }
        if (!s || typeof s !== "object") s = {};
        ctx.expr = typeof s.expr === "string" ? s.expr : "";
        ctx.justEvaled = false;
        render();
    }
    ctx.loadState = loadState;

    function sync() {
        if (ctx.jsonWidget) {
            const txt = JSON.stringify({ expr: ctx.expr, result: safeEval(ctx.expr) ?? 0 });
            if (ctx.jsonWidget.value !== txt) ctx.jsonWidget.value = txt;
        }
        try { node.setDirtyCanvas?.(true, true); } catch (e) {}
    }
    ctx.sync = sync;

    // 阻止按键事件冒泡到画布（避免拖动节点/选中）
    for (const el of [toolbar, screen, grid]) {
        el.addEventListener("pointerdown", (e) => e.stopPropagation(), true);
        el.addEventListener("wheel", (e) => e.stopPropagation(), true);
    }

    window.addEventListener("xh:lang-changed", (e) => {
        ctx.lang = (e.detail && e.detail.lang) || getLang();
    });

    return ctx;
}

const defZh = "🔁XH-计算器";
const defEn = "🔁XH-Calculator";

app.registerExtension({
    name: "XH.Calculator",
    async beforeRegisterNodeDef(nodeType, nodeData, appArg) {
        if (nodeData.name !== NODE_TYPE) return;

        const origOnNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = origOnNodeCreated?.apply(this, arguments);
            try {
                const ctx = buildUI(this);

                const w = this.addDOMWidget("xh_calculator_ui", "custom", ctx.root, {
                    serialize: false,
                    hideOnZoom: false,
                    getMinHeight: () => ctx.measure(),
                    getHeight: () => ctx.measure(),
                    afterResize: () => { try { this.setDirtyCanvas?.(true, true); } catch (e) {} },
                });
                if (!w || !w.element) console.error("[XH-计算器] DOM widget 元素为空，UI 不会显示");
                this._xhCalCtx = ctx;

                const bind = () => {
                    const jw = (this.widgets || []).find((x) => x.name === "calc_state");
                    if (!jw) return false;
                    jw.hidden = true;
                    ctx.jsonWidget = jw;
                    ctx.loadState(jw.value);
                    return true;
                };
                if (!bind()) {
                    for (const d of [80, 300, 1000]) setTimeout(bind, d);
                }
            } catch (e) {
                console.error("[XH-计算器] UI 构建失败", e);
            }
            return r;
        };

        // 加载存档：从 widgets_values 恢复
        const origOnConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (info) {
            const r = origOnConfigure?.apply(this, arguments);
            try {
                const ctx = this._xhCalCtx;
                const raw = (info?.widgets_values || [])[0];
                if (ctx && typeof raw === "string") {
                    ctx.loadState(raw);
                    const jw = (this.widgets || []).find((x) => x.name === "calc_state");
                    if (jw) { jw.hidden = true; if (jw.value !== raw) jw.value = raw; }
                }
            } catch (e) {}
            return r;
        };

        const origLoaded = nodeType.prototype.onLoadedGraphNode;
        nodeType.prototype.onLoadedGraphNode = function (event, info) {
            const r = origLoaded?.apply(this, arguments);
            try {
                const ctx = this._xhCalCtx;
                const raw = (info?.widgets_values || [])[0];
                if (ctx && typeof raw === "string") ctx.loadState(raw);
            } catch (e) {}
            return r;
        };

        const origRemoved = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function () {
            releaseButtons(this);
            return origRemoved?.apply(this, arguments);
        };

        // 标题本地化（只在还是默认名时改，不覆盖用户自定义标题）
        const origNC = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = origNC?.apply(this, arguments);
            const applyTitle = () => {
                const lang = getLang();
                if (!this.title || this.title === defZh || this.title === defEn) {
                    this.title = lang === "zh" ? defZh : defEn;
                }
            };
            applyTitle();
            return r;
        };
        window.addEventListener("xh:lang-changed", () => {
            for (const n of appArg.graph?._nodes || []) {
                if (n.type === NODE_TYPE) {
                    const lang = getLang();
                    if (!n.title || n.title === defZh || n.title === defEn) {
                        n.title = lang === "zh" ? defZh : defEn;
                    }
                }
            }
        });
    },
});
