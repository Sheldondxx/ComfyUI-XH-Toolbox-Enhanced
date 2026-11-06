// XH-滑块 前端 —— Nodes 2.0 原生 DOM UI（替代 mxToolkit mxSlider 的 canvas 手绘方案）
// 设计铁律（全部源自 frontend_n2.md + XH_LoraStack 已验证的坑）：
// 1. UI 全部走 addDOMWidget，绝不 onDrawForeground 手画
// 2. 数据唯一载体是后端声明的标准 STRING widget（slider_json），存档/执行走官方链路
// 3. 绝不增删/重排 node.widgets
//
// ★ 2026-10-20：滑块本体（CSS + DOM + 数值同步）已抽到 **xh_ui_kit.js 的 makeXHSlider()**，
//   家族共用同一份实现（悬浮窗的"不透明度"也用它）。
//   本文件只保留本节点特有逻辑：⚙ 范围设置行 / 输出类型跟随 decimals / slider_json 存档。
//   ⇒ 以后要改滑块样式，**只改 kit 一处**，所有节点一起变。
const { app } = window.comfyAPI.app;

import { ensureLangBridge, makeXHToolbar, releaseButtons, makeXHSlider, makeGearBtn } from "./xh_ui_kit.js";

ensureLangBridge();
const NODE_TYPE = "XHSlider";
const LANG_KEY = "xh_node_lang"; // 家族统一键，与 XH_Toolbox / H3MemorySaver 等共享
const DEFAULT_CFG = { value: 20, min: 0, max: 100, step: 1, decimals: 0 };

// ---- 与 XH 家族的语言状态桥接 ----
// 家族包（XH_Toolbox / H3MemorySaver …）用全局变量 window.XH_LANG 存语言态。
// 这里把它包成 getter/setter：家族那边一改，我们这边立刻收到通知刷新 UI（双向联动）。

function getLang() {
    try { return (window.XH_LANG === "en" || localStorage.getItem(LANG_KEY) === "en") ? "en" : "zh"; } catch (e) { return "zh"; }
}
function setLang(l) {
    window.XH_LANG = l; // 走 setter：写 localStorage + 通知全家族（含本包所有实例）
}

// ---- 节点配色（与 XH_LoraStack 同一套：去官方重复色，12 色高辨识度 + 自定义取色器）----

// ---- 样式（一次注入）----

function normalize(c) {
    const num = (v, d) => {
        const n = Number(v);
        return (typeof n === "number" && isFinite(n)) ? n : d;
    };
    c.min = num(c.min, 0);
    c.max = num(c.max, 100);
    if (c.min > c.max) { const t = c.min; c.min = c.max; c.max = t; }
    if (c.min === c.max) c.max = c.min + 1;
    c.step = Math.max(num(c.step, 1), 0.0001);
    c.decimals = Math.min(4, Math.max(0, Math.floor(num(c.decimals, 0))));
    c.value = num(c.value, c.min);
    if (c.value < c.min) c.value = c.min;
    if (c.value > c.max) c.value = c.max;
    const p = Math.pow(10, c.decimals);
    c.value = Math.round(c.value * p) / p;
    return c;
}

function buildUI(node) {
    const ctx = {
        lang: getLang(),
        cfg: { ...DEFAULT_CFG },
        jsonWidget: null,
    };

    // 主行：滑块 + 数值框 —— ★ 家族统一实现（xh_ui_kit.makeXHSlider），本文件不再私有一份
    const sl = makeXHSlider({
        min: 0, max: 100, step: 1, value: DEFAULT_CFG.value, decimals: 0,
        onInput: (v) => { ctx.cfg.value = v; ctx.sync(); },
    });
    const range = sl.range;
    const numBox = sl.numBox;
    const root = sl.root;

    // 工具条：⚙ 设置开关 + 中/EN + 🎨 —— 家族唯一实现见 web/xh_ui_kit.js
    // ★ 2026-10-20 齿轮统一：本文件不再私建 emoji 按钮，改用 kit.makeGearBtn
    //   （粗壮实心齿轮 + 亮蓝/绿状态色 + 26×22，与 XH-加载视频 / XH-MSR中继 / XH-链式提示词 同款）
    const gear = makeGearBtn({
        collapsed: true,
        titleFn: (col) => {
            const zh = ctx.lang === "zh";
            if (col) return zh ? "范围 / 步进 / 小数位（点开展开）" : "Min / Max / Step / Decimals (click to expand)";
            return zh ? "点此收起设置" : "Click to collapse";
        },
        onToggle: (col) => {
            settings.classList.toggle("hidden", col);
            // ⚙ 展开后高度变了，必须触发一次重排，否则内容被裁
            setTimeout(() => ctx.relayout?.(), 0);
        },
    });
    const { bar: toolbar } = makeXHToolbar(node, { mount: false, prependNodes: [gear] });
    toolbar.classList.add("xh-sl-toolbar");   // 保留本文件给 ⚙ 按钮的皮肤（.xh-sl-toolbar button）

    // 设置行：min / max / step / decimals
    const settings = document.createElement("div");
    settings.className = "xh-sl-settings hidden";
    const mkSetting = (key, zh, en) => {
        const label = document.createElement("label");
        const span = document.createElement("span");
        const input = document.createElement("input");
        input.type = "number";
        label.appendChild(span);
        label.appendChild(input);
        settings.appendChild(label);
        ctx[key + "Input"] = input;
        input.addEventListener("change", () => {
            let v = parseFloat(input.value);
            if (!isFinite(v)) v = ctx.cfg[key];
            ctx.cfg[key] = v;
            ctx.sync();
        });
        ctx[key + "Label"] = span;
        ctx[key + "Zh"] = zh;
        ctx[key + "En"] = en;
        return input;
    };
    mkSetting("min", "最小", "Min");
    mkSetting("max", "最大", "Max");
    mkSetting("step", "步进", "Step");
    mkSetting("decimals", "小数位", "Dec");
    root.appendChild(toolbar);
    root.appendChild(settings);

    ctx.root = root;
    ctx.settings = settings;
    ctx.row = sl.row;              // ★ row 由 makeXHSlider 提供（本文件不再自建）
    ctx.slider = sl;
    ctx.toolbar = toolbar;

    // ---- 渲染 & 同步 ----
    ctx.refreshUI = function () {
        const c = ctx.cfg;
        range.min = String(c.min);
        range.max = String(c.max);
        range.step = String(c.step);
        numBox.min = String(c.min);
        numBox.max = String(c.max);
        numBox.step = String(c.step);
        sl.set(c.value, c.decimals);          // ★ 统一走 kit 组件的 set（不再各写一份）
        if (ctx.minInput) {
            ctx.minInput.value = c.min;
            ctx.maxInput.value = c.max;
            ctx.stepInput.value = c.step;
            ctx.decimalsInput.value = c.decimals;
            const zh = ctx.lang === "zh";
            ctx.minLabel.textContent = zh ? ctx.minZh : ctx.minEn;
            ctx.maxLabel.textContent = zh ? ctx.maxZh : ctx.maxEn;
            ctx.stepLabel.textContent = zh ? ctx.stepZh : ctx.stepEn;
            ctx.decimalsLabel.textContent = zh ? ctx.decimalsZh : ctx.decimalsEn;
            gear._xhGearPaint();   // title 跟随中/EN（titleFn 读 ctx.lang）
        }
    };

    // 输出类型跟随 decimals（同 mxSlider 行为），类型不匹配的连线自动断开
    ctx.updateOutputType = function () {
        const want = ctx.cfg.decimals > 0 ? "FLOAT" : "INT";
        const out = node.outputs && node.outputs[0];
        if (!out || out.type === want) return;
        if (Array.isArray(out.links)) {
            for (let i = out.links.length - 1; i >= 0; i--) {
                const l = app.graph.links[out.links[i]];
                if (l && l.type !== want && l.type !== "*") {
                    const t = app.graph.getNodeById(l.target_id);
                    try { t?.disconnectInput(l.target_slot); } catch (e) {}
                }
            }
        }
        out.type = want;
        if ("localized_name" in out) out.localized_name = want;
    };

    // 节点高度必须随内容变化（⚙ 展开/收起），否则内容被裁掉
    ctx.measure = function () {
        try {
            return (ctx.root.scrollHeight || ctx.root.offsetHeight || 50) + 4;
        } catch (e) {
            return 60;
        }
    };
    ctx.relayout = function () {
        try {
            node.onResize?.(node.size);
            node.setDirtyCanvas?.(true, true);
        } catch (e) {}
    };

    ctx.sync = function () {
        normalize(ctx.cfg);
        ctx.refreshUI();
        ctx.updateOutputType();
        if (ctx.jsonWidget) {
            const txt = JSON.stringify(ctx.cfg);
            if (ctx.jsonWidget.value !== txt) ctx.jsonWidget.value = txt;
        }
        try { node.setDirtyCanvas?.(true, true); } catch (e) {}
    };

    ctx.loadFromJson = function (txt) {
        let c = txt;
        if (typeof c === "string") {
            try { c = JSON.parse(txt || "{}"); } catch (e) { c = {}; }
        }
        if (!c || typeof c !== "object") c = {};
        ctx.cfg = normalize({ ...DEFAULT_CFG, ...c });
        ctx.refreshUI();
        ctx.updateOutputType();
    };

    // range / numBox 的 input 监听已由 makeXHSlider 内部统一处理（onInput → ctx.sync）
    for (const el of [range, numBox, gear, settings]) {
        el.addEventListener("pointerdown", (e) => e.stopPropagation(), true);
    }

    window.addEventListener("xh:lang-changed", (e) => {
        ctx.lang = (e.detail && e.detail.lang) || getLang();
        ctx.refreshUI();
    });

    return ctx;
}

const defZh = "🔁XH-滑块";
const defEn = "🔁XH-Slider";

app.registerExtension({
    name: "XH.Slider",
    async beforeRegisterNodeDef(nodeType, nodeData, appArg) {
        if (nodeData.name !== NODE_TYPE) return;

        const origOnNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = origOnNodeCreated?.apply(this, arguments);
            try {
                const ctx = buildUI(this);

                // 注意：前端 computeLayoutSize 只认 getMinHeight / getHeight，
                // 传 minHeight / minWidth 不生效（源码 domWidget.ts:246~285）
                const w = this.addDOMWidget("xh_slider_ui", "custom", ctx.root, {
                    serialize: false,
                    hideOnZoom: false,
                    getMinHeight: () => ctx.measure(),
                    getHeight: () => ctx.measure(),
                    afterResize: () => {
                        try { node.setDirtyCanvas?.(true, true); } catch (e) {}
                    },
                });
                if (!w || !w.element) console.error("[XH-滑块] DOM widget 元素为空，UI 不会显示");
                this._xhSlCtx = ctx;

                // 找到数据载体 widget（后端 STRING 输入自动生成），带延时重试
                const bind = () => {
                    const jw = (this.widgets || []).find((x) => x.name === "slider_json");
                    if (!jw) return false;
                    // 藏掉数据载体行（Nodes 2.0 前端 BaseWidget.hidden 只影响渲染，不影响序列化）
                    jw.hidden = true;
                    ctx.jsonWidget = jw;
                    ctx.loadFromJson(jw.value);
                    return true;
                };
                if (!bind()) {
                    for (const d of [80, 300, 1000]) setTimeout(bind, d);
                }
            } catch (e) {
                console.error("[XH-滑块] UI 构建失败", e);
            }
            return r;
        };

        // 加载存档：从 widgets_values[0] 恢复（不依赖 DOM widget 序列化）
        const origOnConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (info) {
            const r = origOnConfigure?.apply(this, arguments);
            try {
                const ctx = this._xhSlCtx;
                const raw = (info?.widgets_values || [])[0];
                if (ctx && typeof raw === "string") {
                    ctx.loadFromJson(raw);
                    const jw = (this.widgets || []).find((x) => x.name === "slider_json");
                    if (jw) {
                        jw.hidden = true;
                        if (jw.value !== raw) jw.value = raw;
                    }
                } else if (!ctx && typeof raw === "string") {
                    this._xhSlPendingJson = raw;
                }
            } catch (e) {}
            return r;
        };

        // 兜底：画布节点加载完成后再刷一次（处理 configure 早于 UI 构建的时序）
        const origLoaded = nodeType.prototype.onLoadedGraphNode;
        nodeType.prototype.onLoadedGraphNode = function (event, info) {
            const r = origLoaded?.apply(this, arguments);
            try {
                const ctx = this._xhSlCtx;
                const raw = this._xhSlPendingJson ?? (info?.widgets_values || [])[0];
                if (ctx && typeof raw === "string") ctx.loadFromJson(raw);
                this._xhSlPendingJson = undefined;
            } catch (e) {}
            return r;
        };

        // 节点移除时把 langBtn 从 kit 的全局集合里摘掉，避免悬挂引用
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
            this._xhSlTitleHandler = applyTitle;
            return r;
        };
        window.addEventListener("xh:lang-changed", () => {
            for (const n of appArg.graph?._nodes || []) {
                if (n.type === NODE_TYPE && n._xhSlTitleHandler) n._xhSlTitleHandler();
            }
        });
    },
});
