// 🎲XH-种子 · 家族前端
//
// ① 复刻 rgthree-comfy Seed 的**核心机制**（2026-10-09 逐行核对源码 py/seed.py + web/comfyui/seed.ts）：
//    种子在「前端排队瞬间」就被换成真种子——
//      · 包一层 api.queuePrompt：提交前扫 prompt.output 里所有 XHSeed 节点，
//        seed ∈ {-1 每次随机, -2 上次+1, -3 上次-1} ⇒ 算出真种子，**同时改**：
//          ① API prompt 的 inputs.seed（真正执行的值）
//          ② 工作流存档 widgets_values（出图元数据里记录的是真种子，可复现）
//          ③ 工作流存档 properties.last_seed（重启后"♻️ 用上次"仍可用，比 rgthree 多的）
//      · 子图内的种子节点也支持（output key 形如 "实例id:内部id"，取末段匹配）。
//      · 存档里永远是 -1（= 每次随机），下次出图又是新种子；后端只做兜底（见 controls/seed.py）。
//
// ② 界面（2026-10-09 按 XH 家族规范重写）：
//      · 标准工具条（中/EN + 🎨）→ 唯一实现在 web/xh_ui_kit.js
//      · 中英双语三张表（nodes / widgets / slots）+ 语言桥（切一个节点，全家跟着切）
//      · 三个功能键改成 **DOM 真按钮**（家族配色）：
//          按下 = scale(0.93) + 压暗回弹；点完 = 按钮上闪 "✅ 值"；
//          再叠一条**状态条闪烁**（绿底 + ✅ 文案），1.6s 后自动回落。
//          ⛔ 不再用 LiteGraph 的 addWidget("button") —— canvas 画的按钮点下去没有任何视觉反馈。
//      · **常驻状态条**：随时能看到"现在到底是什么种子"（-1 每次随机 / 固定 123456 / 上次+1 …），
//        排队成功后还会闪 "🚀 本次出图用：xxxxxx"（真种子，可直接抄去复现）。
//      · 载入存档后的恢复逻辑挂 onConfigure（onNodeCreated 时 widgets 还是默认值）。
//
// 铁律：只改 label / title 不改 name；DOM 控件一律 serialize:false；
//       ⛔ 父容器/包裹层拦截事件只用**冒泡**，绝不用捕获（2026-10-09 血案：捕获会把按钮自己的 handler 掐死）。
const { app } = window.comfyAPI.app;

import { ensureLangBridge, makeXHToolbar, onLangChanged, releaseButtons, currentLang, lockDomWidgetHeight , paintBarBtn} from "./xh_ui_kit.js";

ensureLangBridge();
const NODE_TYPE = "XHSeed";

// ---- 文案表（家族规范：nodes / widgets / slots 三张 + ui 自用文案）----
const XH_I18N = {
    zh: {
        nodes: { XHSeed: "🎲XH-种子" },
        widgets: { seed: "种子" },
        slots: { SEED: "种子" },
        ui: {
            btnRandom: "🎲 每次随机",
            btnFixed: "🔢 生成固定值",
            btnLast: "♻️ 用上次",
            btnLastNone: "♻️ 暂无",
            tipRandom: "设成 -1：每次出图都换新种子（推荐）",
            tipFixed: "立刻摇一个随机数字当成固定种子（可复现）",
            tipLast: "把上一次实际用过的种子填回来",
            noLast: "还没有上次种子（先跑一次图）",
            txtRandom: "🎲 每次出图都随机",
            txtInc: "♻️ 上次种子 +1",
            txtDec: "♻️ 上次种子 -1",
            txtFixed: "🔢 固定种子：{v}",
            used: "🚀 本次出图用：{v}",
            ok: "✅",
        },
    },
    en: {
        nodes: { XHSeed: "XH Seed" },
        widgets: { seed: "seed" },
        slots: { SEED: "SEED" },
        ui: {
            btnRandom: "🎲 Random",
            btnFixed: "🔢 Roll fixed",
            btnLast: "♻️ Reuse last",
            btnLastNone: "♻️ None yet",
            tipRandom: "Set -1: a fresh seed every run (recommended)",
            tipFixed: "Roll a random number and lock it as a fixed seed",
            tipLast: "Put back the seed actually used last time",
            noLast: "No last seed yet (run once first)",
            txtRandom: "🎲 Randomize every run",
            txtInc: "♻️ Last seed + 1",
            txtDec: "♻️ Last seed - 1",
            txtFixed: "🔢 Fixed seed: {v}",
            used: "🚀 Used this run: {v}",
            ok: "✅",
        },
    },
};

function uiText(lang) {
    const p = XH_I18N[lang] || XH_I18N.zh;
    return p.ui;
}
function t(lang, kind, key) {
    const pack = XH_I18N[lang] || XH_I18N.zh;
    return (pack[kind] && pack[kind][key]) || null;
}

// ---- 特殊种子（与后端 controls/seed.py 逐字一致）----
const SEED_RANDOM = -1;
const SEED_INCREMENT = -2;
const SEED_DECREMENT = -3;
const SPECIALS = [SEED_RANDOM, SEED_INCREMENT, SEED_DECREMENT];
const MAX_SEED = 1125899906842624; // 2^50，与 rgthree / 后端一致

function randSeed() {
    let s = Math.floor(Math.random() * MAX_SEED);
    if (SPECIALS.includes(s)) s = 0; // 撞上特殊值就给 0（照抄 rgthree）
    return s;
}

// ── 活实例登记（排队后要刷新界面状态；子图内部节点也能被 onNodeCreated 登记到）──
const live = new Set();

function findWfNode(workflow, idStr) {
    if (!workflow) return null;
    for (const n of workflow.nodes || []) {
        if (String(n.id) === idStr) return n;
    }
    for (const sg of ((workflow.definitions || {}).subgraphs) || []) {
        for (const n of sg.nodes || []) {
            if (String(n.id) === idStr) return n;
        }
    }
    return null;
}

function patchPrompt(prompt) {
    const output = prompt && prompt.output;
    if (!output) return;
    for (const key of Object.keys(output)) {
        const entry = output[key];
        if (!entry || entry.class_type !== "XHSeed") continue;
        const inputs = entry.inputs;
        if (!inputs || inputs.seed === undefined) continue;
        const cur = Number(inputs.seed);
        if (!SPECIALS.includes(cur)) continue;

        const idStr = key.includes(":") ? key.slice(key.lastIndexOf(":") + 1) : key;
        const wfNode = findWfNode(prompt.workflow, idStr);
        const last = wfNode && wfNode.properties ? wfNode.properties.last_seed : undefined;

        // 照抄 rgthree 的 getSeedToUse：±1 只有在"上次是真种子"时才生效，否则退回随机
        let s;
        if (cur === SEED_INCREMENT && typeof last === "number" && !SPECIALS.includes(last)) s = last + 1;
        else if (cur === SEED_DECREMENT && typeof last === "number" && !SPECIALS.includes(last)) s = last - 1;
        else s = randSeed();
        if (!Number.isFinite(s) || SPECIALS.includes(s)) s = randSeed();
        s = Math.max(-MAX_SEED, Math.min(MAX_SEED, Math.floor(s)));

        // ① API prompt：真正执行的种子
        inputs.seed = s;
        // ② 工作流存档：元数据可复现
        if (wfNode) {
            if (Array.isArray(wfNode.widgets_values)) {
                const i = wfNode.widgets_values.findIndex((v) => Number(v) === cur);
                if (i >= 0) wfNode.widgets_values[i] = s;
            }
            if (!wfNode.properties) wfNode.properties = {};
            wfNode.properties.last_seed = s;
        }
        // ③ 界面反馈：状态条闪 "🚀 本次出图用：xxx" + 「用上次」按钮点亮
        for (const n of live) {
            if (String(n.id) === idStr && typeof n.__xhSeedGotSeed === "function") {
                try { n.__xhSeedGotSeed(s); } catch (e) {}
            }
        }
    }
}

// ── 拦截排队（只包一层，防重复包裹）──
const apiNS = window.comfyAPI && window.comfyAPI.api;
const api = apiNS && apiNS.api;
if (!api) {
    console.warn("[🎲XH-种子] 拿不到 comfyAPI.api，随机种子回退为后端兜底模式");
} else if (!api.__xhSeedHooked) {
    api.__xhSeedHooked = true;
    const origQueuePrompt = api.queuePrompt;
    api.queuePrompt = async function (index, prompt, ...args) {
        try { patchPrompt(prompt); } catch (e) { console.warn("[🎲XH-种子] 换种子失败:", e); }
        return origQueuePrompt.call(this, index, prompt, ...args);
    };
}

// ══════════════ 界面：按钮 / 状态条（家族 DOM 控件）══════════════

/** 按下动效：缩一下 + 压暗，110ms 回弹（给"我点到了"的即时手感）。 */
function pressBtn(b) {
    try {
        b.style.transform = "scale(0.93)";
        b.style.filter = "brightness(0.85)";
        setTimeout(() => {
            b.style.transform = "";
            if (!b._xhFlashing) b.style.filter = "none";
        }, 110);
    } catch (e) {}
}

/** 点完的确认反馈：按钮文字临时变 "✅ xxx" 并提亮，ms 后恢复（恢复值取 _baseText，避免被旧文案顶掉）。 */
function flashBtn(b, text, ms) {
    if (!b) return;
    try {
        b._xhFlashing = true;
        b.textContent = text;
        b.style.filter = "brightness(1.5)";
        clearTimeout(b._xhFlashT);
        b._xhFlashT = setTimeout(() => {
            b._xhFlashing = false;
            b.textContent = b._baseText || text;
            b.style.filter = "none";
            b._xhFlashT = 0;
        }, ms || 900);
    } catch (e) {}
}

function seedValue(node) {
    const v = Number(node && node.seedWidget ? node.seedWidget.value : NaN);
    return Number.isFinite(v) ? v : SEED_RANDOM;
}

/** 状态条常驻文案：现在到底是什么种子 */
function statusText(node) {
    const L = uiText(currentLang());
    const v = seedValue(node);
    if (v === SEED_RANDOM) return L.txtRandom;
    if (v === SEED_INCREMENT) return L.txtInc;
    if (v === SEED_DECREMENT) return L.txtDec;
    return L.txtFixed.replace("{v}", v);
}

function refreshStatus(node) {
    const el = node && node._xhSeedStatusEl;
    const tx = node && node._xhSeedStatusTx;
    if (!el || !tx) return;
    try {
        const f = node._xhSeedFlash;
        if (f && Date.now() < f.until) {
            tx.textContent = f.msg;
            el.style.background = "rgba(39,174,96,0.45)";       // 家族绿
            el.style.boxShadow = "0 0 0 2px rgba(39,174,96,0.55)";
        } else {
            node._xhSeedFlash = null;
            tx.textContent = statusText(node);
            el.style.background = "rgba(255,255,255,0.10)";
            el.style.boxShadow = "none";
        }
        node.setDirtyCanvas && node.setDirtyCanvas(true, true);
    } catch (e) {}
}

/** 状态条闪一下（点按钮 / 排队后都用它当"事情办成了"的信号）。 */
function flashStatus(node, msg, ms) {
    if (!node || !node._xhSeedStatusEl) return;
    node._xhSeedFlash = { msg, until: Date.now() + (ms || 1600) };
    clearTimeout(node._xhSeedFlashT);
    refreshStatus(node);
    node._xhSeedFlashT = setTimeout(() => { node._xhSeedFlash = null; refreshStatus(node); }, (ms || 1600) + 80);
}

function setSeed(node, v) {
    if (node && node.seedWidget) node.seedWidget.value = v;
    refreshStatus(node);
    try { node.setDirtyCanvas && node.setDirtyCanvas(true, true); } catch (e) {}
}

/** 「♻️ 用上次」按钮：没有上次种子就灰掉并禁用。 */
function updateLastBtn(node) {
    const b = node && node._xhSeedBtns && node._xhSeedBtns.last;
    if (!b) return;
    const L = uiText(currentLang());
    const last = node.properties ? node.properties.last_seed : undefined;
    const ok = typeof last === "number" && !SPECIALS.includes(last);
    b._baseText = ok ? `${L.btnLast}: ${last}` : L.btnLastNone;
    if (!b._xhFlashing) b.textContent = b._baseText;
    b.disabled = !ok;
    b.title = ok ? L.tipLast : L.noLast;
    b.style.background = ok ? "#DCA02B" : "#555555";   // 家族金 / 禁用灰
    b.style.cursor = ok ? "pointer" : "not-allowed";
    b.style.opacity = ok ? "1" : "0.55";
}

/** 语言切换 / 载入后：把按钮文字、状态条一起刷成当前语言。 */
function refreshUI(node) {
    if (!node) return;
    const L = uiText(currentLang());
    const bs = node._xhSeedBtns;
    if (bs) {
        for (const [k, txt] of [["random", L.btnRandom], ["fixed", L.btnFixed]]) {
            const b = bs[k];
            if (!b) continue;
            b._baseText = txt;
            if (!b._xhFlashing) b.textContent = txt;
            b.title = k === "random" ? L.tipRandom : L.tipFixed;
        }
    }
    updateLastBtn(node);
    refreshStatus(node);
}

/** 三个功能键（DOM 真按钮，家族配色；serialize:false 不进存档）。 */
function makeBtnBar(node) {
    const L = uiText(currentLang());
    const bar = document.createElement("div");
    bar.style.cssText = "display:flex;gap:6px;padding:4px 6px;width:100%;box-sizing:border-box;flex-wrap:wrap;background:transparent;";

    const mk = (text, color, fn, tip) => {
        const b = document.createElement("button");
        b.type = "button";
        b._baseText = text;
        b.textContent = text;
        b.title = tip || "";
        // flex:1 1 auto + min-width —— 窄节点自动换行，不会把文字挤成一片省略号
        paintBarBtn(b, "primary");      // 原动态传色 → 统一 primary 蓝
        b.style.cssText = b.style.cssText
            + "flex:1 1 auto;min-width:74px;box-sizing:border-box;"
            + "padding:5px 6px;font-size:11px;line-height:1.3;";
            + "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"
            + "transition:filter .15s,transform .08s,background .15s;";
        b.onmouseenter = () => { if (!b.disabled) b.style.filter = "brightness(1.2)"; };
        b.onmouseleave = () => { if (!b._xhFlashing) b.style.filter = "none"; };
        b.onclick = (e) => {
            e.stopPropagation();
            pressBtn(b);
            try { fn(b); } catch (err) { console.warn("[🎲XH-种子] 按钮回调失败:", err); }
        };
        bar.appendChild(b);
        return b;
    };

    const btnRandom = mk(L.btnRandom, "#2F8FD8", (b) => {
        setSeed(node, SEED_RANDOM);
        flashBtn(b, "✅ -1", 900);
        flashStatus(node, "✅ " + L.txtRandom, 1600);
    }, L.tipRandom);

    const btnFixed = mk(L.btnFixed, "#4BA14B", (b) => {
        const s = randSeed();
        setSeed(node, s);
        flashBtn(b, "✅ " + s, 1200);
        flashStatus(node, "✅ " + L.txtFixed.replace("{v}", s), 1800);
    }, L.tipFixed);

    const btnLast = mk(L.btnLast, "#DCA02B", (b) => {
        const last = node.properties ? node.properties.last_seed : undefined;
        if (typeof last === "number" && !SPECIALS.includes(last)) {
            setSeed(node, last);
            flashBtn(b, "✅ " + last, 1200);
            flashStatus(node, "✅ " + L.txtFixed.replace("{v}", last), 1800);
        } else {
            flashStatus(node, "⚠ " + L.noLast, 1800);
        }
    }, L.tipLast);

    node._xhSeedBtns = { random: btnRandom, fixed: btnFixed, last: btnLast };

    // ⛔ 冒泡阶段拦截（绝不用捕获 —— 捕获会掐死按钮自己的 handler）
    ["pointerdown", "mousedown", "dblclick", "click", "keydown"].forEach((ev) =>
        bar.addEventListener(ev, (e) => e.stopPropagation())
    );

    let w = null;
    try {
        w = node.addDOMWidget("xh_seed_buttons", "custom", bar, {
            serialize: false,
            hideOnZoom: false,
            getMinHeight: () => 30,
        });
    } catch (e) {
        console.warn("[🎲XH-种子] 按钮条挂载失败:", e);
    }
    // 🔴 2026-10-13 修复：按钮条只给了 getMinHeight，没 computeSize → 基类 computeLayoutSize 让它「可生长」，
    //    节点拖高后多余空间全灌进按钮条。钉死固定高度。
    //    🔴 2026-10-14 补：只写 computeSize 对 **Vue Nodes 无效**（行高只看 hasLayoutSize）⇒ 改 lockDomWidgetHeight。
    lockDomWidgetHeight(w, 30);
    return w;
}

/** 常驻状态条（照 web/xh_resolution.js 的预览条风格）。 */
function makeStatusBar(node) {
    const el = document.createElement("div");
    el.style.cssText = "display:flex;align-items:center;justify-content:center;padding:6px 8px;width:100%;box-sizing:border-box;"
        + "border-radius:6px;background:rgba(255,255,255,0.10);font-family:system-ui,-apple-system,\"Segoe UI\",\"Microsoft YaHei\",sans-serif;"
        + "font-size:12px;font-weight:700;color:#ffffff;text-shadow:0 1px 2px rgba(0,0,0,0.35);"
        + "user-select:none;cursor:default;transition:background .2s,box-shadow .2s;";
    const tx = document.createElement("span");
    el.appendChild(tx);
    node._xhSeedStatusEl = el;
    node._xhSeedStatusTx = tx;

    let w = null;
    try {
        w = node.addDOMWidget("xh_seed_status", "custom", el, {
            serialize: false,      // 🔴 绝不进工作流 JSON
            hideOnZoom: false,
            getMinHeight: () => 26,
        });
    } catch (e) {
        console.warn("[🎲XH-种子] 状态条挂载失败:", e);
    }
    // 🔴 2026-10-13 修复：状态条只给了 getMinHeight，没 computeSize → 拖高节点时被撑成大片空条。钉死固定高度。
    //    🔴 2026-10-14 补：Vue Nodes 下行高只看 hasLayoutSize ⇒ lockDomWidgetHeight 连 computeLayoutSize 一起撤。
    lockDomWidgetHeight(w, 26);
    refreshStatus(node);
    return w;
}

// ---- 中/EN ----
function applyLang(node, lang) {
    if (!node) return;
    lang = lang || currentLang();
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
        refreshUI(node);
        try { node.setDirtyCanvas && node.setDirtyCanvas(true, true); } catch (e) {}
    } catch (e) {
        console.warn("[🎲XH-种子] 应用语言失败:", e);
    }
}

function nodesOfType() {
    try {
        return (app.graph?.nodes || app.graph?._nodes || []).filter((n) => n.type === NODE_TYPE);
    } catch (e) { return []; }
}
function applyLangToAll() {
    const lang = currentLang();
    for (const n of nodesOfType()) applyLang(n, lang);
    try { app.graph?.setDirtyCanvas?.(true, true); } catch (e) {}
}

app.registerExtension({
    name: "XH.Seed",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_TYPE) return;

        const origOnCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = origOnCreated ? origOnCreated.apply(this, arguments) : undefined;
            const node = this;
            try {
                node.serialize_widgets = true;

                // ① 标准工具条（中/EN + 🎨）—— 家族唯一实现见 web/xh_ui_kit.js
                const { langBtn } = makeXHToolbar(node, { widgetName: "xh_seed_bar" });
                node._xhLangBtn = langBtn;

                // ② 处理自带 widget：删掉 control_after_generate（它会把 -1 改写成随机数，抢我们的活）
                for (let i = (node.widgets || []).length - 1; i >= 0; i--) {
                    const w = node.widgets[i];
                    if (w.name === "control_after_generate") node.widgets.splice(i, 1);
                    else if (w.name === "seed") node.seedWidget = w;
                }
                if (node.seedWidget) {
                    node.seedWidget.value = SEED_RANDOM; // 默认 -1 = 每次随机（同 rgthree）
                    // 手改数字也要刷新状态条（只包一层，不覆盖原回调）
                    if (!node.seedWidget._xhSeedHooked) {
                        node.seedWidget._xhSeedHooked = true;
                        const origCb = node.seedWidget.callback;
                        node.seedWidget.callback = function () {
                            const rr = origCb ? origCb.apply(this, arguments) : undefined;
                            refreshStatus(node);
                            return rr;
                        };
                    }
                }

                // ③ 功能键 + 状态条（DOM，serialize:false）
                makeBtnBar(node);
                makeStatusBar(node);

                // ④ 排队拿到真种子后的界面反馈
                node.__xhSeedGotSeed = (s) => {
                    if (!node.properties) node.properties = {};
                    node.properties.last_seed = s;
                    updateLastBtn(node);
                    flashStatus(node, "🚀 " + uiText(currentLang()).used.replace("{v}", s), 2600);
                    try { node.setDirtyCanvas && node.setDirtyCanvas(true, true); } catch (e) {}
                };

                live.add(node);
                const origOnRemoved = node.onRemoved;
                node.onRemoved = function () {
                    live.delete(node);
                    return origOnRemoved ? origOnRemoved.apply(this, arguments) : undefined;
                };

                applyLang(node);
            } catch (e) {
                console.warn("[🎲XH-种子] 界面创建失败:", e);
            }
            return r;
        };

        // 🔴 载入 / 切换工作流后恢复（onNodeCreated 时 widgets 还是默认值）
        const origOnConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            const r = origOnConfigure ? origOnConfigure.apply(this, arguments) : undefined;
            try {
                if (!this.seedWidget) {
                    this.seedWidget = (this.widgets || []).find((w) => w && w.name === "seed");
                }
                refreshUI(this);
            } catch (e) {}
            return r;
        };

        const origOnRemoved = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function () {
            releaseButtons(this);
            live.delete(this);
            return origOnRemoved ? origOnRemoved.apply(this, arguments) : undefined;
        };
    },

    async setup() {
        // 语言变更 + 工作流载入重刷 —— 统一走 kit（见 web/xh_ui_kit.js）
        onLangChanged(() => applyLangToAll());
    },
});
