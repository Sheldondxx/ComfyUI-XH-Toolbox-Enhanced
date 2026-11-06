// 🔁XH-MSR精修编码 · 家族前端（2026-10-14 · v2：面板精简 —— 秒数并进段落 + ⚙ 折叠）
// ① 中/EN 切换：节点标题 + 参数控件标签 + 输入/输出端口名（三处全覆盖，照 xh_mathfloat.js 规范）
// ② 节点自身配色 🎨（XH 家族 12 色 + 自定义取色器）
// ③ ⚙ 一键收起/展开 7 个高级参数（默认收起 → 节点只剩「全局提示词 + 分段提示词 + 状态行」）
// ④ 常驻状态行：实时显示「共几段 / 其中几段标了时长」——没标时长的段后端会直接报错，前端先给你看到。
// ⑤ onConfigure 里做 widgets_values 自愈（切工作流重载防错位）
//
// 铁律：只改 label / title，绝不改 name；绝不改 COMBO 的 values；
//      DOM 只 append + serialize:false，禁止 unshift（会顶乱 widgets_values 下标）。
//
// 折叠走官方**受支持的** legacy facade `widget.hidden`（前端源码里它就是 suppression.byExtension）：
// 既不绘制、也不参与布局算高（getLayoutWidgets / isWidgetRowVisible 都会跳过），
// 且与序列化无关（隐藏控件的值照常存档）。
const { app } = window.comfyAPI.app;

import { ensureLangBridge, makeXHToolbar, onLangChanged, releaseButtons, fixWidgetValuesFromSaved, lockDomWidgetHeight, forceCompactOnSpawn, isSizeLike, makeGearBtn } from "./xh_ui_kit.js";

ensureLangBridge();
const NODE_TYPE = "XHMSRRelayEncode";
const BAR_WIDGET = "xh_msr_relay_bar";
const GREEN = "#1D9E75";

// 默认收起的 7 个：帧率 + 硬度六件套
const ADV_KEYS = [
    "fps",
    "epsilon", "video_strength", "video_window_scale",
    "audio_epsilon", "audio_strength", "audio_window_scale",
];

const XH_I18N = {
    zh: {
        nodes: { XHMSRRelayEncode: "🔁XH-MSR精修编码" },
        widgets: {
            global_prompt: "全局提示词（整段不变，可留空）",
            shot_prompts: "分段提示词（每段末尾写时长，如 [3] 或 [0-3]）",
            fps: "帧率 fps",
            epsilon: "画面边界硬度 ε",
            video_strength: "画面惩罚倍率",
            video_window_scale: "画面锚区宽度",
            audio_epsilon: "音频边界硬度 ε",
            audio_strength: "音频惩罚倍率",
            audio_window_scale: "音频锚区宽度",
        },
        slots: {
            model: "模型",
            clip: "文本编码器",
            latent: "空潜空间",
            positive: "正向条件",
            info: "分段报告",
        },
        status: {
            empty: "分段稿还空着",
            segs: "段",
            timed: "已标时长",
            ok: "全部有时长 ✅",
            bad: "有段没写时长 🔴（后端会报错）",
        },
        advShow: "展开高级参数（帧率 / 硬度六件套）",
        advHide: "收起高级参数",
    },
    en: {
        nodes: { XHMSRRelayEncode: "XH MSR Refine Encode" },
        widgets: {
            global_prompt: "global prompt (whole video, optional)",
            shot_prompts: "shot script (put duration at each shot's end, e.g. [3] or [0-3])",
            fps: "fps",
            epsilon: "video boundary ε",
            video_strength: "video penalty scale",
            video_window_scale: "video anchor width",
            audio_epsilon: "audio boundary ε",
            audio_strength: "audio penalty scale",
            audio_window_scale: "audio anchor width",
        },
        slots: {
            model: "model",
            clip: "clip",
            latent: "latent",
            positive: "positive",
            info: "shot report",
        },
        status: {
            empty: "shot script empty",
            segs: "segs",
            timed: "timed",
            ok: "all timed ✅",
            bad: "some shots untimed 🔴 (backend will error)",
        },
        advShow: "Show advanced params (fps / penalty knobs)",
        advHide: "Hide advanced params",
    },
};

function t(lang, kind, key) {
    const pack = XH_I18N[lang] || XH_I18N.zh;
    return (pack[kind] && pack[kind][key]) || null;
}

// ---- 与后端口径一致的拆段（只用来看「几段 / 几段标了时长」，不参与计算）----
// 段尾时间标记：`[3]` / `[3s]` / `[3秒]` / `[0-3]`
const TAIL_TIME_RE = /\[\s*(\d+(?:\.\d+)?)\s*(?:[-~–—]\s*(\d+(?:\.\d+)?))?\s*(?:s|sec|secs|秒)?\s*\]\s*$/i;

function parseShots(text) {
    const raw = String(text == null ? "" : text).trim();
    if (!raw) return [];
    const lines = raw.split(/\r?\n/);
    const isSep = (ln) => /^\s*(?:-{3,}|={3,}|\*{3,})\s*$/.test(ln);
    let chunks;
    if (lines.some(isSep)) {
        chunks = raw.split(/^\s*(?:-{3,}|={3,}|\*{3,})\s*$/m);      // ① 分隔线
    } else if (lines.filter((ln) => TAIL_TIME_RE.test(ln)).length >= 2) {
        chunks = lines;                                              // ② 两行以上带时长 → 一行一段
    } else {
        chunks = [raw];                                              // ③ 整块一段，不拆碎
    }
    const out = [];
    for (const c of chunks) {
        const body = String(c == null ? "" : c);
        const m = TAIL_TIME_RE.exec(body);
        const text = (m ? body.slice(0, m.index) : body).trim();
        if (text) out.push({ text, timed: !!m });
    }
    return out;
}

function widgetByName(node, name) {
    try {
        return (node.widgets || []).find((w) => w && w.name === name) || null;
    } catch (e) { return null; }
}

function refreshStatus(node) {
    const el = node && node._xhMsrStatusEl;
    if (!el) return;
    const lang = window.XH_LANG || "zh";
    const S = (XH_I18N[lang] || XH_I18N.zh).status;

    const w = widgetByName(node, "shot_prompts");
    const shots = parseShots(w ? w.value : "");
    const n = shots.length;
    const timed = shots.filter((s) => s.timed).length;

    let text, color;
    if (!n) {
        text = S.empty;
        color = "#888780";
    } else if (timed === n) {
        text = `${n} ${S.segs}　|　${S.timed} ${timed}/${n}　${S.ok}`;
        color = "#0F6E56";
    } else {
        text = `${n} ${S.segs}　|　${S.timed} ${timed}/${n}　${S.bad}`;
        color = "#A32D2D";
    }
    el.textContent = text;
    el.style.color = color;
}

// 包住分段稿控件的 callback，值一变就重算（不改 name、不改 value 结构）
function hookWidgets(node) {
    const w = widgetByName(node, "shot_prompts");
    if (!w || w._xhMsrHooked) return;
    const orig = w.callback;
    w.callback = function () {
        let r;
        try { r = orig ? orig.apply(this, arguments) : undefined; } catch (e) { r = undefined; }
        try { refreshStatus(node); } catch (e) {}
        return r;
    };
    w._xhMsrHooked = true;
}

function mountStatus(node) {
    if (node._xhMsrStatusEl) return;
    if (typeof node.addDOMWidget !== "function") return;
    const el = document.createElement("div");
    el.style.cssText =
        "padding:2px 6px 4px 6px;font-size:12px;line-height:1.5;" +
        "font-family:inherit;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" +
        "color:#888780;cursor:default;";
    el.addEventListener("pointerdown", (e) => e.stopPropagation());
    el.addEventListener("mousedown", (e) => e.stopPropagation());
    el.addEventListener("click", (e) => e.stopPropagation());
    try {
        const w = node.addDOMWidget("xh_msr_status", "custom", el, {
            serialize: false,
            hideOnZoom: false,
            getMinHeight: () => 20,
        });
        // 🔴 状态行钉死 20px：只写 computeSize 在 Vue Nodes 下无效（行仍会被标成 auto
        //    吸走节点多余的竖向空间 → 节点底部一大块空白），必须连 computeLayoutSize 一起撤，
        //    行变 min-content 才不吃空间。见 xh_ui_kit.js 的 lockDomWidgetHeight 注释。
        lockDomWidgetHeight(w, 20);
        try {
            w.serialize = false;
            if (w.options) w.options.serialize = false;
            w.serializeValue = () => undefined;
        } catch (e) {}
        node._xhMsrStatusEl = el;
    } catch (e) {
        console.warn("[XH MSR] 状态行挂载失败:", e);
    }
}

// ---------------------------------------------------------------------------
// ⚙ 折叠高级参数
// ---------------------------------------------------------------------------
function isVueNodes() {
    try { return !!window.LiteGraph?.vueNodesMode; } catch (e) { return false; }
}

function relayout(node) {
    try { node.onResize?.(node.size); } catch (e) {}
    try { node.setDirtyCanvas?.(true, true); } catch (e) {}
    if (!isVueNodes()) {
        // 老画布：官方自己在 _arrangeWidgets 里就是这么干的
        try {
            const h = node.computeSize([node.size[0], node.size[1]])[1];
            if (h > 0) node.setSize([node.size[0], h]);
        } catch (e) {}
    }
    try { node.graph?.setDirtyCanvas?.(true, true); } catch (e) {}
}

/**
 * 刷新齿轮外观。★ 2026-10-20 齿轮统一：外观全交给 kit.makeGearBtn（_xhGearSet 自带 titleFn），
 *   本文件只提供「当前折叠状态」这一个事实。
 */
function paintGear(node) {
    const btn = node._xhMsrGear;
    if (!btn) return;
    const collapsed = !node._xhMsr || node._xhMsr.collapsed !== false;
    if (btn._xhGearSet) btn._xhGearSet(collapsed);
    else {
        const pack = XH_I18N[(window.XH_LANG === "en") ? "en" : "zh"];
        btn.title = collapsed ? pack.advShow : pack.advHide;
    }
}

function setCollapsed(node, collapsed) {
    const st = node._xhMsr;
    if (!st) return;
    st.collapsed = !!collapsed;
    for (const k of ADV_KEYS) {
        const w = widgetByName(node, k);
        if (!w) continue;
        try { w.hidden = st.collapsed; } catch (e) {}
    }
    paintGear(node);
    relayout(node);
}

function makeGearButton(node) {
    // ★ 家族统一齿轮（kit.makeGearBtn）：粗壮实心图标 + 亮蓝/绿状态色 + 26×22
    const btn = makeGearBtn({
        collapsed: !node._xhMsr || node._xhMsr.collapsed !== false,
        titleFn: (col) => {
            const pack = XH_I18N[(window.XH_LANG === "en") ? "en" : "zh"];
            return col ? pack.advShow : pack.advHide;
        },
        onToggle: (col) => setCollapsed(node, col),
    });
    node._xhMsrGear = btn;
    paintGear(node);
    return btn;
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
        paintGear(node);
        try { node.setDirtyCanvas?.(true, true); } catch (e) {}
        refreshStatus(node);
    } catch (e) {
        console.warn("[XH MSR Lang] 应用语言失败:", e);
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
    name: "XH.MSRRelayEncode",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_TYPE) return;

        const origOnCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = origOnCreated?.apply(this, arguments);
            try {
                // 🔴 2026-10-16：折叠前先记下构造期虚高值 —— 前端在 createNode 里就按**全部**
                //    控件（含默认收起的 7 个高级参数）算好 size，我们的折叠在它之后才跑 ⇒
                //    node.size 不缩，两个多行提示词框（auto 行）把多出的高度全吸走（同款事故）。
                const spawnH = isSizeLike(this.size) ? this.size[1] : null;
                this._xhMsr = { collapsed: true };          // 默认收起高级参数

                mountStatus(this);

                // 标准工具条（中/EN + 🎨）＋ ⚙ —— 家族唯一实现见 web/xh_ui_kit.js
                const gearBtn = makeGearButton(this);
                // ★ 2026-10-20 齿轮统一：**⚙ 排工具条最左**（prependNodes），家族 4 个齿轮节点一致
                const { langBtn } = makeXHToolbar(this, {
                    widgetName: BAR_WIDGET,
                    prependNodes: [gearBtn],
                });
                this._xhLangBtn = langBtn;

                hookWidgets(this);
                applyLang(this);
                setCollapsed(this, true);
                refreshStatus(this);
                // 🔴 2026-10-16 强制收缩（同款「拖出来就虚高」事故）：带 spawnH 护栏钉回内容高度，
                //    用户一旦手动拖过尺寸（值≠spawnH）就绝不抢尺寸。
                forceCompactOnSpawn(this, { maxExcess: 100, spawnSize: spawnH });
            } catch (e) {
                console.warn("[XH MSR] 初始化失败:", e);
            }
            return r;
        };

        // 🔴 切工作流重载时纠偏 widgets_values（工具条占位残留 / 顺序错位 ⇒ 控件错位）
        const origOnConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            const r = origOnConfigure?.apply(this, arguments);
            try {
                fixWidgetValuesFromSaved(this, arguments[0]);
                hookWidgets(this);
                applyLang(this);
                setCollapsed(this, true);
                refreshStatus(this);
            } catch (e) {
                console.warn("[XH MSR] onConfigure 自愈失败:", e);
            }
            return r;
        };

        const origOnRemoved = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function () {
            releaseButtons(this);
            this._xhMsrStatusEl = null;
            this._xhMsrGear = null;
            return origOnRemoved?.apply(this, arguments);
        };
    },

    async setup() {
        onLangChanged(() => applyLangToAll());
    },
});
