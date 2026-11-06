// 📺XH-显示文本 · 家族前端
// 仿 comfyui-custom-scripts（pysssss）的 `ShowText|pysssss` 前端（web/js/showText.js）做的 XH 版。
// 机制与官方一致：
//   ① onExecuted 时把后端发来的 ui.text 生成为**只读多行文本框**铺在节点上（旧的先删）；
//   ② onConfigure 时从工作流存档 widgets_values 恢复上次显示（后端执行时已回写）；
//   ③ 显示后按 computeSize 自动撑大节点。
// XH 增加：
//   ① 家族工具条（中/EN + 🎨）+ 📋 复制按钮（一键拷当前显示文本）；
//   ② 端口中文（text→文本 / 输出 STRING→字符串）；
//   ③ 文本框淡显样式统一家族风。
//
// 🔴 铁律：populate 删旧文本框时**只能删 text_N**，绝不能清空整个 widgets 数组 ——
//    家族工具条也是 widget（serialize:false），按官方那样 `widgets.length = n` 会把工具条一起删掉。
const { app } = window.comfyAPI.app;

import { ensureLangBridge, makeXHToolbar, onLangChanged, releaseButtons , paintBarBtn} from "./xh_ui_kit.js";

ensureLangBridge();
const NODE_TYPE = "XHShowText";
const XH_I18N = {
    zh: {
        nodes: { XHShowText: "📺XH-显示文本" },
        widgets: {},
        // ⚠️ slots 表按【端口名】查：输入口叫 text，输出口叫 STRING
        slots: { text: "文本", STRING: "字符串" },
    },
    en: {
        nodes: { XHShowText: "XH Show Text" },
        widgets: {},
        slots: { text: "text", STRING: "STRING" },
    },
};

function t(lang, kind, key) {
    const pack = XH_I18N[lang] || XH_I18N.zh;
    return (pack[kind] && pack[kind][key]) || null;
}

// ---- 把收到的文本铺成只读文本框（照官方 populate，删旧只删 text_N）----
async function populate(text) {
    let ComfyWidgets = null;
    try {
        ({ ComfyWidgets } = await import("../../../scripts/widgets.js"));
    } catch (e) {
        console.warn("[XH ShowText] 拿不到 ComfyWidgets，无法显示文本:", e);
        return;
    }
    if (this.widgets) {
        // 官方是 `widgets.length = n` 清尾巴 —— 这里不行：会把家族工具条一起删掉。
        // 只删动态生成的 text_N，其余（工具条 / 转换来的 text 控件）原样保留。
        for (const w of [...this.widgets]) {
            if (w && /^text_\d+$/.test(w.name || "")) {
                w.onRemove?.();
                const i = this.widgets.indexOf(w);
                if (i >= 0) this.widgets.splice(i, 1);
            }
        }
    }

    const v = [...text];
    if (!v[0]) {
        v.shift();
    }
    let lastText = "";
    for (let list of v) {
        // Force list to be an array, not sure why sometimes it is/isn't（官方原注释）
        if (!(list instanceof Array)) list = [list];
        for (const l of list) {
            const w = ComfyWidgets["STRING"](this, "text_" + this.widgets?.length ?? 0, ["STRING", { multiline: true }], app).widget;
            w.inputEl.readOnly = true;
            w.inputEl.style.opacity = 0.7;
            w.inputEl.style.color = "#e8e8e8";
            w.inputEl.style.background = "rgba(0,0,0,0.25)";
            w.inputEl.style.borderRadius = "6px";
            try { w.label = ""; } catch (e) {}
            w.value = l;
            lastText = String(l);
        }
    }
    if (lastText) this._xhLastText = lastText;

    requestAnimationFrame(() => {
        const sz = this.computeSize();
        if (sz[0] < this.size[0]) {
            sz[0] = this.size[0];
        }
        if (sz[1] < this.size[1]) {
            sz[1] = this.size[1];
        }
        this.onResize?.(sz);
        app.graph.setDirtyCanvas(true, false);
    });
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
        console.warn("[XH ShowText Lang] 应用语言失败:", e);
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

// ---- 📋 复制当前显示的文本 ----
function copyText(node, btn) {
    const txt = node._xhLastText || "";
    const flash = () => {
        try {
            const old = btn.textContent;
            btn.textContent = "✅";
            setTimeout(() => { btn.textContent = old; }, 600);
        } catch (e) {}
    };
    if (!txt) return;
    const fallback = () => {
        try {
            const ta = document.createElement("textarea");
            ta.value = txt;
            ta.style.cssText = "position:fixed;opacity:0;";
            document.body.appendChild(ta);
            ta.select();
            document.execCommand("copy");
            document.body.removeChild(ta);
            flash();
        } catch (e) {
            console.warn("[XH ShowText] 复制失败:", e);
        }
    };
    if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(txt).then(flash).catch(fallback);
    } else {
        fallback();
    }
}

app.registerExtension({
    name: "XH.ShowText",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_TYPE) return;

        // 标准家族界面：工具条（中/EN + 🎨 + 📋）
        const origOnCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = origOnCreated?.apply(this, arguments);
            try {
                const copyBtn = document.createElement("button");
                copyBtn.textContent = "📋";
                copyBtn.title = (window.XH_LANG || "zh") === "zh"
                    ? "复制显示的文本" : "Copy displayed text";
                paintBarBtn(copyBtn, "neutral");
                copyBtn.style.cssText = copyBtn.style.cssText
                    + "width:26px;font-size:13px;line-height:1;padding:0;";
                    + "transition:all 0.2s;";
                // 方案 B：hover 统一用亮度滤镜，不再写死色值（全家族一致）
                copyBtn.onmouseover = () => copyBtn.style.filter = "brightness(1.28)";
                copyBtn.onmouseout = () => copyBtn.style.background = "rgba(0,0,0,0.25)";
                copyBtn.onclick = (e) => { e.stopPropagation(); copyText(this, copyBtn); };
                ["pointerdown", "mousedown", "dblclick", "keydown"].forEach((ev) =>
                    copyBtn.addEventListener(ev, (e) => e.stopPropagation()));
                this._xhCopyBtn = copyBtn;

                const { langBtn } = makeXHToolbar(this, {
                    widgetName: "xh_showtext_bar",
                    appendNodes: [copyBtn],
                });
                this._xhLangBtn = langBtn;

                applyLang(this);
            } catch (e) {
                console.warn("[XH ShowText] 界面创建失败:", e);
            }
            return r;
        };

        // 跑完流程：后端 ui.text → 铺到节点上（官方同款钩子）
        const onExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (message) {
            onExecuted?.apply(this, arguments);
            if (message?.text) populate.call(this, message.text);
        };

        // 重开工作流：从存档 widgets_values 恢复（官方同款两段式：configure 先存、onConfigure 再铺）
        const VALUES = Symbol();
        const configure = nodeType.prototype.configure;
        nodeType.prototype.configure = function () {
            this[VALUES] = arguments[0]?.widgets_values;
            return configure?.apply(this, arguments);
        };

        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            onConfigure?.apply(this, arguments);
            const widgets_values = this[VALUES];
            if (widgets_values?.length) {
                requestAnimationFrame(() => {
                    populate.call(this, widgets_values.slice(+(widgets_values.length > 1 && this.inputs?.[0].widget)));
                });
            }
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
