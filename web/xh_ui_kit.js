// 🔧 XH 家族 UI 套件 —— 家族 UI 规范的**唯一实现**，所有 xh_*.js 共用
//
// 规范（2026-10-01 定稿，取自 xh_tone.js）：
//   ① 语言桥：window.XH_LANG 做成 accessor —— 任何地方赋值都会
//      a) 写 localStorage(xh_node_lang)  b) 广播 `xh:lang-changed` 事件
//      ⇒ 全家族节点语言状态同步（点一个节点上的 中/EN，所有 XH 节点一起切）
//   ② 标准工具条：36×22 的「中/EN」按钮（中=#2d6cdf / EN=#c0392b）+ 🎨 颜色块
//   ③ 颜色块：XH 家族 12 色 + 自定义取色器（写 node.color / node.bgcolor）
//   ④ 工具条走 addDOMWidget({serialize:false})，绝不进工作流 JSON
//   ⑤ 节点框上色后，标题栏底色是亮色 → 标题文字按底色自动切黑/白（installTitleAutoColor）
//
// 用法：
//   import { ensureLangBridge, makeXHToolbar, onLangChanged } from "./xh_ui_kit.js";
//   ensureLangBridge();                      // 文件顶部，早于任何 window.XH_LANG 使用
//   // onNodeCreated 里： makeXHToolbar(this);
//   // setup 里：          onLangChanged(() => applyLangToAll());
//
// 铁律：只改 label / title，绝不改 name；绝不改 COMBO 的 values；DOM 只 append 不乱插。
const { app } = window.comfyAPI.app;
export const XH_LANG_KEY = "xh_node_lang";

export function currentLang() {
    return window.XH_LANG || "zh";
}

// ---- ① 语言桥（幂等：已有 accessor 就直接返回）----
export function ensureLangBridge() {
    let cur = "zh";
    try { cur = localStorage.getItem(XH_LANG_KEY) || window.XH_LANG || "zh"; } catch (e) { cur = window.XH_LANG || "zh"; }
    try {
        const d = Object.getOwnPropertyDescriptor(window, "XH_LANG");
        if (d && (d.get || d.set)) return false;      // 已被别的家族文件装过
        let _l = cur;
        Object.defineProperty(window, "XH_LANG", {
            get: () => _l,
            set: (v) => {
                _l = v;
                try { localStorage.setItem(XH_LANG_KEY, v); } catch (e) {}
                window.dispatchEvent(new CustomEvent("xh:lang-changed", { detail: { lang: v } }));
            },
            configurable: true,
            enumerable: true,
        });
        return true;
    } catch (e) {
        window.XH_LANG = cur;
        return false;
    }
}

export function toggleLang() {
    window.XH_LANG = currentLang() === "zh" ? "en" : "zh";
    return window.XH_LANG;
}

// ---- ③ 家族 12 色 + 自定义取色器 ----
export const XH_PALETTE = [
    { zh: "番茄红", en: "Tomato", hex: "#D64541" },
    { zh: "南瓜橙", en: "Orange", hex: "#E07B39" },
    { zh: "金黄", en: "Gold", hex: "#DCA02B" },
    { zh: "草绿", en: "Green", hex: "#4BA14B" },
    { zh: "青绿", en: "Teal", hex: "#17A2A2" },
    { zh: "天蓝", en: "Sky", hex: "#2F8FD8" },
    { zh: "靛蓝", en: "Indigo", hex: "#5A6FD8" },
    { zh: "紫", en: "Purple", hex: "#9B59D0" },
    { zh: "品红", en: "Magenta", hex: "#DE4FA3" },
    { zh: "咖啡棕", en: "Brown", hex: "#A0674A" },
    { zh: "橄榄", en: "Olive", hex: "#7E8C3A" },
    { zh: "石板灰", en: "Slate", hex: "#7A8699" },
];

export function darkenHex(hex, f) {
    const m = String(hex || "").replace("#", "");
    const v = m.length === 3 ? m.split("").map((c) => c + c).join("") : m;
    if (v.length < 6) return hex;
    const r = Math.round(parseInt(v.slice(0, 2), 16) * f);
    const g = Math.round(parseInt(v.slice(2, 4), 16) * f);
    const b = Math.round(parseInt(v.slice(4, 6), 16) * f);
    return "#" + [r, g, b].map((x) => Math.max(0, Math.min(255, x)).toString(16).padStart(2, "0")).join("");
}

export function applyNodeColor(node, hex) {
    // 🔴 2026-10-13 修复「点默认没反应」：原来用 delete node.color / delete node.bgcolor。
    //   Vue Nodes 模式下 delete 不触发响应式重渲染（赋值才触发）⇒ 界面纹丝不动；
    //   而选颜色（赋值）一直有效，正好对上用户实测「颜色能上、默认收不回」。
    //   改成显式赋 undefined：LiteGraph 判 falsy 走默认色、序列化时 undefined 被丢弃，等价于删掉。
    if (!hex) { node.color = undefined; node.bgcolor = undefined; }
    else { node.color = hex; node.bgcolor = darkenHex(hex, 0.42); }
    // 发一次图变更事件：Vue 前端靠它把 node 颜色同步进响应式 store（canvas 模式无害）
    try { node.graph && typeof node.graph.change === "function" && node.graph.change(); } catch (e) {}
    installTitleAutoColor(node);   // 兜底：没走 makeXHToolbar 的调用方也能有清晰标题字
    refreshVueTitles();            // Vue 节点：DOM 标题栏也要跟着换字色
    syncVueNodeColorDom(node);     // Vue 节点兜底：清/写标题栏容器 inline 背景色（防 Vue 不重渲染）
    try { node.setDirtyCanvas?.(true, true); } catch (e) {}
}

/**
 * Vue Nodes 的标题栏背景兜底（2026-10-13）。
 * 标题栏底色挂在 .lg-node → .lg-node-header 之间某个带 inline background-color 的容器上。
 * 不管 Vue 有没有重渲染，这里直接按 node 当前颜色把 inline 背景对齐：
 *   node.color 有值 → 写成 applyLightThemeColor 同款亮色（深色主题原样、浅色主题 lighten）
 *   node.color 空  → 清空 inline 背景，交回主题默认
 * 幂等；找不到 DOM（canvas 模式）直接返回 false。
 */
function syncVueNodeColorDom(node) {
    if (!node || node.id === undefined || node.id === null) return false;
    let header = null;
    try { header = document.querySelector(`.lg-node-header[data-testid="node-header-${node.id}"]`); } catch (e) { return false; }
    if (!header) return false;
    const _lum = (h) => { const v = String(h || "").replace("#", ""); if (!/^[0-9a-f]{6}$/i.test(v)) return null; const c = [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16) / 255).map((u) => (u <= 0.03928 ? u / 12.92 : Math.pow((u + 0.055) / 1.055, 2.4))); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
    const lightTheme = (() => { try { return document.body.classList.contains("theme-light") || document.documentElement.dataset.theme === "light"; } catch (e) { return false; } })();
    let touched = false;
    // 沿祖先链找第一个带 inline backgroundColor 的容器，最多 6 层（实测 1 层即中）
    let el = header.parentElement;
    for (let i = 0; i < 6 && el; i++) {
        const inline = el.style && el.style.backgroundColor;
        if (inline) {
            if (!node.color) {
                el.style.backgroundColor = "";   // 默认：清掉，交回主题
            } else {
                // 浅色主题下官方会 lighten(.5)；深色主题原样。粗略对齐官方 applyLightThemeColor。
                el.style.backgroundColor = lightTheme ? _lightenHex(node.color, 0.5) : node.color;
            }
            touched = true;
            break;
        }
        el = el.parentElement;
    }
    return touched;
}

/** 变亮：hex 每通道向 255 插值 t（0~1）。与官方 lighten 语义近似，仅供 DOM 兜底用。 */
function _lightenHex(hex, t) {
    const m = String(hex || "").replace("#", "");
    const v = m.length === 3 ? m.split("").map((c) => c + c).join("") : m;
    if (!/^[0-9a-f]{6}$/i.test(v)) return hex;
    return "#" + [0, 2, 4].map((i) => Math.round(parseInt(v.slice(i, i + 2), 16) + (255 - parseInt(v.slice(i, i + 2), 16)) * t).toString(16).padStart(2, "0")).join("");
}

// ---- ⑤ 标题栏文字自动黑/白（2026-10-05）----
//
// 背景：家族上色写的是 node.color = 用户选的**亮色**（标题栏底）、
//       node.bgcolor = darkenHex(hex, 0.42)（节点主体）。
//      而标题文字色由 LiteGraph 决定：
//         ctx.fillStyle = this.selected ? NODE_SELECTED_TITLE_COLOR
//                                       : (this.constructor.title_text_color || default_title_color)
//      其中 default_title_color 是画布主题色（深色主题 #999）—— 亮底压浅灰字，
//      实测家族 12 色的对比度只有 1.04~1.63（WCAG 要求 ≥ 4.5），必然看不清。
//
// 做法（不改 LiteGraph 绘制逻辑、零复刻）：包一层**实例**的 drawTitleText，
//   把入参 default_title_color 换成「按底色算出的黑/白」，其余原样交给官方实现。
//   · 前端源码实测 title_text_color 全项目**零赋值** ⇒ constructor 上是 undefined
//     ⇒ 入参永远生效，不必去改类级静态属性（也就不会波及其他节点）。
//   · 选中态走官方分支（NODE_SELECTED_TITLE_COLOR），原样不干预。
//   · low_quality（拖动中降质绘制）也放过，省掉一次无谓的重算。
//   · try/catch 兜底：前端哪天删了这个入参，最坏只是「回到老样子」，不会报错。
//
// 判据：黑字 / 白字取对比度大者 ⇒ max ≥ √21 = 4.58 > 4.5，对任意底色恒成立。
//   ⚠️ 必须用纯 #000 / #fff：黑字若改成 #151515，数学下限掉到 4.32 就不保证了。
//   ⚠️ 以后往 XH_PALETTE 加新色也**不用调任何阈值** —— 判据自带保证。

function _srgbToLinear(u8) {
    const c = u8 / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** WCAG 相对亮度（0~1）；色值非法返回 null。支持 #abc / #aabbcc。 */
export function hexLuminance(hex) {
    const m = String(hex || "").replace("#", "").trim();
    const v = m.length === 3 ? m.split("").map((c) => c + c).join("") : m;
    if (!/^[0-9a-f]{6}$/i.test(v)) return null;
    return 0.2126 * _srgbToLinear(parseInt(v.slice(0, 2), 16))
        + 0.7152 * _srgbToLinear(parseInt(v.slice(2, 4), 16))
        + 0.0722 * _srgbToLinear(parseInt(v.slice(4, 6), 16));
}

/** 给定底色，返回对比度更高的标题文字色（#000000 / #ffffff）；判断不了返回 null。 */
export function pickTitleTextColor(bgHex) {
    const L = hexLuminance(bgHex);
    if (L === null) return null;
    const onBlack = (L + 0.05) / 0.05;
    const onWhite = 1.05 / (L + 0.05);
    return onBlack >= onWhite ? "#000000" : "#ffffff";
}

/**
 * 让「标题栏底色 ↔ 标题文字色」始终看得清。**幂等**；makeXHToolbar 已自动调用。
 * 只作用于传进来的这一个节点实例：不碰类原型、不影响别的节点、不进工作流 JSON。
 * @returns true = 本次挂上了
 */
export function installTitleAutoColor(node) {
    if (!node || node.__xhTitleAuto) return false;
    const proto = Object.getPrototypeOf(node);
    if (!proto || typeof proto.drawTitleText !== "function") return false;
    const orig = node.drawTitleText;          // 原型上的官方实现
    node.drawTitleText = function (ctx, opts) {
        try {
            const o = opts || {};
            if (!o.low_quality && !this.selected) {
                const want = pickTitleTextColor(this.color);
                if (want) {
                    return orig.call(this, ctx, Object.assign({}, o, { default_title_color: want }));
                }
            }
        } catch (e) { /* 出任何岔子就落回官方绘制 */ }
        return orig.call(this, ctx, opts);
    };
    node.__xhTitleAuto = true;
    return true;
}

// ---- ⑥ Vue Nodes（Nodes 2.0）标题栏文字自动黑/白（2026-10-05 浏览器实测后补）----
//
// 背景：Comfy.VueNodes.Enabled = true 时 LiteGraph.vueNodesMode 为 true，
//   **canvas 完全不绘制节点**（⑤ 那套 drawTitleText 一次都不会被调用），
//   节点改由 Vue 组件渲染成 DOM。实测结构（headless Chromium 直读）：
//     .graph-canvas-container
//       └ div[style: transform scale/translate]                    ← 视图缩放层
//         └ div.lg-node[style: transform: translate(x,y); z-index]  ← 节点根
//           └ div[style: background-color: rgb(220,160,43)]         ← 标题栏底色 = node.color（亮色）
//             └ div
//               └ div.lg-node-header[data-testid="node-header-<id>"]
//                      class 里带 text-node-component-slot-text，**没有任何 inline style**
//
//   标题栏**背景** = 那颗 inline background-color（用户选的亮色）；
//   标题文字的**颜色**只由 class 决定 → var(--node-component-slot-text)：
//   深色主题 = smoke-700 = rgb(160,160,160)、浅色主题 = ash-800。
//   ⇒ 亮底压中灰字，实测对比度 1.04~1.63（WCAG 要 ≥ 4.5），必然看不清。
//
// 做法：`.lg-node-header` 上没有 style 绑定（Vue patch 不会擦掉它），
//   所以**直接给它设 inline color** 最稳：沿祖先链找第一个不透明背景色 →
//   用 WCAG 取对比度更高的纯黑/纯白 → 写进 style.color。
//   用 MutationObserver 兜住所有节点（新建 / 加载 / 重渲染 / 上色都会触发），rAF 节流。
//
// ⚠️ 为什么不去读 node.color：浅色主题下 ComfyUI 会先把颜色 lighten(.5) 再上图，
//   读 DOM 的**真实**背景色才不会猜错（也不依赖它的内部实现）。
// ⚠️ ⑤（canvas 那套）保留互补：关掉 Vue Nodes 后 drawTitleText 会恢复被调用。

export const XH_VUE_HEADER_SEL = ".lg-node-header";

/** 沿祖先链找第一个不透明背景色，返回 "#rrggbb"；找不到返回 null。 */
function _xhOpaqueBg(el) {
    let e = el;
    for (let i = 0; i < 5 && e; i++) {
        let bg = "";
        try { bg = getComputedStyle(e).backgroundColor || ""; } catch (err) { break; }
        const m = /rgba?\(([^)]+)\)/.exec(bg);
        if (m) {
            const p = m[1].split(",").map((x) => parseFloat(x));
            const a = p.length > 3 ? p[3] : 1;
            if (a > 0.5) {
                return "#" + p.slice(0, 3)
                    .map((x) => Math.round(x).toString(16).padStart(2, "0")).join("");
            }
        }
        e = e.parentElement;
    }
    return null;
}

/** "rgb(r,g,b)" / "#rrggbb" → "#rrggbb"；半透明或无解返回 null。 */
function _xhCssToHex(c) {
    const m = /rgba?\(([^)]+)\)/.exec(String(c || ""));
    if (!m) {
        const s = String(c || "").trim();
        return /^#[0-9a-f]{6}$/i.test(s) ? s : null;
    }
    const p = m[1].split(",").map((x) => parseFloat(x));
    if (p.length > 3 && p[3] < 0.5) return null;
    return "#" + p.slice(0, 3).map((x) => Math.round(x).toString(16).padStart(2, "0")).join("");
}

/** WCAG 对比度（0~21）。 */
function _xhContrast(aHex, bHex) {
    const a = hexLuminance(aHex);
    const b = hexLuminance(bHex);
    if (a === null || b === null) return 0;
    const hi = Math.max(a, b);
    const lo = Math.min(a, b);
    return (hi + 0.05) / (lo + 0.05);
}

/**
 * 给单个标题栏元素上色。**最小干预**：原生字色对底色本来就看得清（≥4.5）就不碰它 ——
 * 没上过色的节点保持 ComfyUI 自己的观感，只有真看不清的才改成纯黑/纯白。
 * 幂等：值没变不写（避免 MutationObserver 自激）。
 */
export function paintVueHeader(el) {
    if (!el || !el.style) return false;
    const bg = _xhOpaqueBg(el);
    if (!bg) return false;
    let cur = "";
    try { cur = getComputedStyle(el).color || ""; } catch (e) { cur = ""; }
    const curHex = _xhCssToHex(cur);
    if (curHex && _xhContrast(bg, curHex) >= 4.5) return false;   // 已经看得清 → 不插手
    const want = pickTitleTextColor(bg);
    if (!want) return false;
    if (el.dataset && el.dataset.xhTitleFg === want) return false;
    try {
        el.style.color = want;
        if (el.dataset) el.dataset.xhTitleFg = want;
    } catch (e) { return false; }
    return true;
}

let _xhVueRaf = 0;

/** 扫全画布刷新所有标题栏。rAF 合并 —— 连调多次只真正跑一次。 */
export function refreshVueTitles() {
    if (_xhVueRaf) return;
    const run = () => {
        _xhVueRaf = 0;
        let list = [];
        try { list = document.querySelectorAll(XH_VUE_HEADER_SEL); } catch (e) { return; }
        for (const el of list) paintVueHeader(el);
    };
    try { _xhVueRaf = requestAnimationFrame(run); } catch (e) { run(); }
}

let _xhVueObserver = null;

/**
 * 幂等：给 Vue Nodes 的标题栏挂上自动配色。makeXHToolbar 会自动调用。
 * 返回 true = 本次挂上了（Vue 模式）；false = 已挂过或环境不支持（canvas 模式）。
 */
export function installVueTitleAutoColor() {
    if (_xhVueObserver) { refreshVueTitles(); return false; }
    const host = (() => {
        try { return document.getElementById("graph-canvas-container") || document.body; } catch (e) { return null; }
    })();
    if (!host) return false;
    try {
        _xhVueObserver = new MutationObserver(() => refreshVueTitles());
        _xhVueObserver.observe(host, {
            childList: true, subtree: true,
            attributes: true, attributeFilter: ["class", "style"],
        });
    } catch (e) { _xhVueObserver = null; return false; }
    refreshVueTitles();
    return true;
}

/**
 * 通用取色弹窗（家族唯一实现）—— XH 12 色 + 自定义取色器 + 「默认」项。
 * **只管弹窗和取色，不碰任何状态**：选中后一律回调 onPick(hex)。
 *
 * @param anchorBtn 锚点按钮（弹窗对齐它）
 * @param opts.id             弹窗 DOM id（默认 xh_palette_pop；同一时刻同名只留一个）
 * @param opts.current        当前色，用于给已选项加高亮描边
 * @param opts.onPick         (hex) 选中回调
 * @param opts.resetLabel     「默认」项文案（默认 中文=默认 / EN=Default）
 * @param opts.resetValue     「默认」项回传值（默认 null；allowTransparent=true 时为 "transparent"）
 * @param opts.allowTransparent 「默认」项回传 "transparent" 而不是 null
 */
export function showXHPicker(anchorBtn, opts = {}) {
    const id = opts.id || "xh_palette_pop";
    const old = document.getElementById(id);
    if (old) old.remove();
    const box = document.createElement("div");
    box.id = id;
    box.style.cssText = "position:fixed;z-index:99999;background:#222;border:1px solid #555;border-radius:6px;padding:6px;display:flex;flex-wrap:wrap;gap:4px;width:176px;box-shadow:0 4px 12px rgba(0,0,0,.5);";
    const isZh = currentLang() === "zh";
    const curHex = String(opts.current || "").toLowerCase();
    const fire = (hex) => { if (typeof opts.onPick === "function") opts.onPick(hex); };
    const onDoc = (e) => {
        if (!box.contains(e.target) && e.target !== anchorBtn && !anchorBtn.contains(e.target)) {
            box.remove(); document.removeEventListener("pointerdown", onDoc, true);
        }
    };
    const closeAnd = (fn) => () => { try { fn(); } finally { box.remove(); document.removeEventListener("pointerdown", onDoc, true); } };

    const reset = document.createElement("button");
    reset.textContent = opts.resetLabel || (isZh ? "默认" : "Default");
    reset.style.cssText = "width:100%;background:#333;color:#e8e8e8;border:1px solid #555;border-radius:4px;padding:3px 0;font-size:11px;cursor:pointer;";
    const resetVal = opts.resetValue !== undefined ? opts.resetValue : (opts.allowTransparent ? "transparent" : null);
    reset.onclick = closeAnd(() => { fire(resetVal); });
    box.appendChild(reset);

    XH_PALETTE.forEach((col) => {
        const d = document.createElement("button");
        d.style.cssText = `width:22px;height:22px;border-radius:50%;border:1px solid rgba(255,255,255,.35);cursor:pointer;background:${col.hex};${col.hex.toLowerCase() === curHex ? "outline:2px solid #fff;outline-offset:1px;" : ""}`;
        d.title = isZh ? col.zh : col.en;
        d.onclick = closeAnd(() => { fire(col.hex); });
        box.appendChild(d);
    });

    const custom = document.createElement("button");
    custom.textContent = isZh ? "自定义…" : "Custom…";
    custom.style.cssText = "width:100%;background:#333;color:#e8e8e8;border:1px solid #555;border-radius:4px;padding:3px 0;font-size:11px;cursor:pointer;margin-top:2px;";
    const picker = document.createElement("input");
    picker.type = "color";
    picker.style.cssText = "position:absolute;width:0;height:0;padding:0;border:none;opacity:0;pointer-events:none;";
    if (/^#[0-9a-f]{6}$/i.test(opts.current || "")) picker.value = opts.current;
    picker.addEventListener("input", () => { fire(picker.value); });
    picker.addEventListener("change", closeAnd(() => { fire(picker.value); }));
    custom.onclick = (e) => { e.stopPropagation(); picker.click(); };
    box.appendChild(picker);
    box.appendChild(custom);

    const rect = anchorBtn.getBoundingClientRect();
    box.style.top = (rect.bottom + 4) + "px";
    box.style.left = rect.left + "px";
    document.body.appendChild(box);
    setTimeout(() => document.addEventListener("pointerdown", onDoc, true), 0);
}

/**
 * 节点框取色弹窗（写 node.color / node.bgcolor）。
 * @param node 目标节点
 * @param anchorBtn 锚点按钮
 * @param onPick 可选回调 (hex|null) —— 某些节点（XHLabel / XHTimer）除了上色还要同步自身状态。
 */
export function showXHPalette(node, anchorBtn, onPick) {
    const pick = typeof onPick === "function" ? onPick : null;
    showXHPicker(anchorBtn, {
        id: "xh_palette_pop",
        current: node.color,
        resetValue: null,
        onPick: (hex) => { applyNodeColor(node, hex); if (pick) pick(hex); },
    });
}

/**
 * 通用下拉弹窗（2026-10-20 新增，家族唯一实现）—— 每一行 = 色块 + 文字，当前项打勾高亮。
 * ⛔ 为什么不用原生 <select>：Chromium 的 <option> **只渲染文本节点**，
 *    option.innerHTML 里塞的 <span> 会被整条丢弃 —— 色块永远画不出来。
 *    这就是「下拉里看不到色块」的唯一根因，跟主题 / CSS 无关，只能自绘。
 * @param anchor 触发元素（按钮）
 * @param opts.items    [{value,label,hex?,color?,tip?}] —— hex 合法才画色块
 * @param opts.color    行文字色（不给用中性浅灰；调用方一般传 readableOn(hex)）
 * @param opts.current  当前值（按字符串比）
 * @param opts.onPick   (value)=>void
 * @param opts.id       弹窗 id（同一时刻同名只留一个）
 * @returns {{close:()=>void}}
 */
export function showXHDropdown(anchor, opts = {}) {
    const id = opts.id || "xh_dropdown_pop";
    const old = document.getElementById(id);
    if (old) old.remove();
    const items = (opts.items || []).filter((it) => it && it.value !== undefined && it.value !== null);
    const cur = String(opts.current == null ? "" : opts.current);
    const fallbackTx = opts.color || "#dde3ea";
    const fire = (v) => { if (typeof opts.onPick === "function") opts.onPick(v); };

    // 色块：hex 非法（工作流里存了脏值 / 手填了色名）时画**空心虚线框**，
    // ⛔ 不能退回中性灰 —— 那个灰跟「全部颜色」的色块一模一样，用户会以为是同一个颜色。
    const validHex = (h) => (/^#[0-9a-f]{6}$/i.test(String(h || "")) ? String(h) : "");

    const box = document.createElement("div");
    box.id = id;
    box.style.cssText = "position:fixed;z-index:99999;min-width:136px;max-height:314px;overflow-y:auto;"
        + "background:#1c1f26;border:1px solid #4a5260;border-radius:6px;padding:4px;"
        + "box-shadow:0 6px 18px rgba(0,0,0,.62);font-size:13px;";

    const close = () => {
        box.remove();
        document.removeEventListener("pointerdown", onDoc, true);
    };
    const onDoc = (e) => {
        if (!box.contains(e.target) && !anchor.contains(e.target)) close();
    };

    items.forEach((it) => {
        const on = String(it.value) === cur;
        const row = document.createElement("div");
        row.style.cssText = "display:flex;align-items:center;gap:8px;padding:4px 9px;border-radius:4px;"
            + "cursor:pointer;white-space:nowrap;user-select:none;-webkit-user-select:none;"
            + "font-weight:" + (on ? 700 : 600) + ";"
            + "background:" + (on ? BAR_COLORS.ACTIVE_BG : "transparent") + ";"
            + "color:" + (on ? BAR_COLORS.ACTIVE_TX : (it.color || fallbackTx)) + ";";
        if (it.hex) {
            const ok = validHex(it.hex);
            const sw = document.createElement("span");
            sw.style.cssText = "display:inline-block;width:13px;height:13px;border-radius:3px;flex:none;"
                + (ok
                    ? "background:" + ok + ";border:1px solid rgba(255,255,255,.45);box-shadow:0 0 0 1px rgba(0,0,0,.45);"
                    : "background:transparent;border:1px dashed rgba(255,255,255,.40);")
                + (ok ? "" : 'title="这个值没有对应颜色"');
            row.appendChild(sw);
        }
        const tx = document.createElement("span");
        tx.style.cssText = "flex:1;overflow:hidden;text-overflow:ellipsis;";
        tx.textContent = it.label;
        row.appendChild(tx);
        if (on) {
            const ck = document.createElement("span");
            ck.textContent = "\u2713";
            ck.style.cssText = "font-size:12px;opacity:.95;";
            row.appendChild(ck);
        }
        if (it.tip) row.title = it.tip;
        row.onmouseenter = () => { if (!on) row.style.background = "rgba(255,255,255,.07)"; };
        row.onmouseleave = () => { if (!on) row.style.background = "transparent"; };
        row.onclick = (e) => { e.stopPropagation(); close(); fire(it.value); };
        box.appendChild(row);
    });

    document.body.appendChild(box);
    const r = anchor.getBoundingClientRect();
    const bw = box.offsetWidth, bh = box.offsetHeight;
    // 下方放不下就翻到上方；左右贴边内收
    let top = r.bottom + 4;
    if (top + bh > window.innerHeight - 8 && r.top - bh - 4 > 8) top = r.top - bh - 4;
    let left = r.left;
    if (left + bw > window.innerWidth - 8) left = Math.max(8, window.innerWidth - bw - 8);
    box.style.top = Math.max(8, top) + "px";
    box.style.left = left + "px";
    setTimeout(() => document.addEventListener("pointerdown", onDoc, true), 0);
    return { close };
}

// ---- ② 标准按钮 ----
const _LANG_BTNS = new Set();

// ================================================================
//工具条按钮皮肤 —— 方案 B（2026-10-20，家族唯一实现）
// 用户原话：「提示词表那个功能键的，你用的是个白色白底儿的那个……你觉得合适吗？
//            我希望我们做这个节点上按键的时候，就符合那种大众专业的一些按键的风格。」
// 改前家族一条工具条上有 5 套并存皮肤（实心 #1668b3 / #3a7bd5 / #2d6cdf / #0f3460 /
// 淡紫 #EEEDFE 白底 + 0.5px 边框），外加 bold 字重 = "不专业"的三个成因。
// 方案 B 规则：**层级用明度表达，不用色相**。主角（齿轮 / 主操作）= 蓝实心；
//             配角（其余全部）= 同一档暗底 #262d38 + 1px rgba(255,255,255,.10) 描边。
// ================================================================

/** 工具条配色常量 —— 家族唯一数据源，勿在节点里另写 hex */
export const BAR_COLORS = {
    SURFACE:    "#262d38",               // 中性按钮底
    BORDER:     "rgba(255,255,255,.10)",  // 中性按钮描边
    TEXT:       "#d5dde5",               // 中性按钮字
    PRIMARY:    "#1668b3",               // 主操作实心底（=齿轮底，同色）
    PRIMARY_TX: "#ffffff",
    ACTIVE_BG:  "#1d3a52",               // 激活态底（起跑段已设偏移 / 清空可撤销）
    ACTIVE_BD:  "#2f7dbf",
    ACTIVE_TX:  "#8fd0ff",
    // 🔴 danger 档（2026-10-20 用户拍板「危险按钮保留红色实心」）：
    //    破坏性操作（停止 / 清空列表 / 删除 LoRA）的红色是**语义色**，不是皮肤不一致。
    //    仍用**实心**，但压到克制的深红 —— 不再是原来那种 #E53935 大红块抢眼。
    DANGER_BG:  "#a63232",
    DANGER_BD:  "rgba(255,255,255,.22)",
    DANGER_TX:  "#ffffff",
};

// 🔴 挂一份到 window：给「不能静态 import 本模块」的调用方用。
//    典型 = xh_about.js（设置面板徽章）—— web/ 下按字母序加载，xh_about.js 排在
//    xh_ui_kit.js **之前**，它顶层 import 本模块会因 app.js 未就绪而抛；
//    而设置面板的渲染函数是在用户点开面板时才跑的，那一刻本模块早已加载完。
//    ⇒ 只在**渲染时**读 window.XH_BAR_COLORS 才拿得到颜色（顶层读必为 undefined）。
if (typeof window !== "undefined") window.XH_BAR_COLORS = BAR_COLORS;

/** 按钮统一尺寸 —— 22px 高是家族标准（工具条行高 28px 的一半多一像素，肉眼刚好贴满不挤） */
export const BAR_BTN_H = 22;
export const BAR_BTN_W_MIN = 26;
export const BAR_BTN_PAD = "0 9px";

/**
 * 统一外观。四档：
 *   "neutral" （默认，配角）暗底 #262d38 + 1px 半透明白描边 + 字重 600
 *   "primary"（主角）    蓝实心 #1668b3 + 白字 + 字重 700
 *   "active" （状态）    蓝边蓝字 #1d3a52/#2f7dbf/#8fd0ff + 字重 700
 *   "danger" （破坏性）  红实心 #a63232 + 白字 + 字重 700 —— ⛔ 别中性化，红是语义色
 */
export function paintBarBtn(btn, role = "neutral") {
    if (!btn) return btn;
    const C = BAR_COLORS;
    const base =
        "display:flex;align-items:center;justify-content:center;height:" + BAR_BTN_H + "px;"
        + "min-width:" + BAR_BTN_W_MIN + "px;padding:" + BAR_BTN_PAD + ";margin:0;"
        + "border-radius:4px;font-size:12px;font-family:inherit;cursor:pointer;flex:0 0 auto;"
        + "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:auto;"
        + "user-select:none;-webkit-user-select:none;line-height:1;"
        + "transition:filter .15s,background .15s,border-color .15s,color .15s;";

    if (role === "danger") {
        // 🔴 危险操作保留红色实心（用户拍板）：破坏性语义不能被"中性化"掉，
        //    否则用户会习惯性点下去 —— 但压成深红，别像原来那样大红块抢整条工具条的戏。
        btn.style.cssText = base
            + "background:" + C.DANGER_BG + ";border:1px solid " + C.DANGER_BD + ";"
            + "color:" + C.DANGER_TX + ";font-weight:700;";
    } else if (role === "primary") {
        btn.style.cssText = base
            + "background:" + C.PRIMARY + ";border:1px solid rgba(255,255,255,.16);"
            + "color:" + C.PRIMARY_TX + ";font-weight:700;";
    } else if (role === "active") {
        btn.style.cssText = base
            + "background:" + C.ACTIVE_BG + ";border:1px solid " + C.ACTIVE_BD + ";"
            + "color:" + C.ACTIVE_TX + ";font-weight:700;";
    } else {
        // 主路：中性暗底 + 1px 半透明白描边（0.5px 缩放会渲染成毛边，⛔ 别再用）
        btn.style.cssText = base
            + "background:" + C.SURFACE + ";border:1px solid " + C.BORDER + ";"
            + "color:" + C.TEXT + ";font-weight:600;";   // 600 = 12px 密排下的清晰上限
    }
    btn.style.boxShadow = "";
    return btn;
}

/**
 * 家族统一工具条按钮（方案 B 唯一实现）。
 * @param text按钮文字（或用 html 塞 SVG 图标）
 * @param tip  tooltip
 * @param opts.role  "neutral"(默认) | "primary" | "active"
 * @param opts.width 指定宽度（px），不传按内容自适应
 */
export function makeBarBtn(text, tip, opts = {}) {
    const btn = document.createElement("button");
    btn.type = "button";
    if (text != null) btn.textContent = text;
    if (tip) btn.title = tip;
    paintBarBtn(btn, opts.role || "neutral");
    if (opts.width) btn.style.width = opts.width + "px";

    btn.onmouseenter = () => { btn.style.filter = "brightness(1.28)"; };
    btn.onmouseleave = () => { btn.style.filter = "none"; };
    ["pointerdown", "mousedown", "dblclick", "keydown", "click"].forEach((ev) =>
        btn.addEventListener(ev, (e) => e.stopPropagation())
    );
    return btn;
}

export function styleLangBtn(btn, lang) {
    if (!btn) return;
    lang = lang || currentLang();
    btn.textContent = lang === "zh" ? "中" : "EN";
    // 方案 B：不再用 #2d6cdf / #c0392b 两种实心色刷状态（那是"5套皮肤并存"之一），
    // 改用 active 档（蓝底蓝边蓝字），状态一眼可辨又与全家族同源。
    paintBarBtn(btn, "active");
}

export function makeLangBtn(node) {
    const btn = makeBarBtn(null, null, { width: 36 });
    btn.onclick = (e) => { e.stopPropagation(); toggleLang(); };
    styleLangBtn(btn);
    _LANG_BTNS.add(btn);
    if (node) node._xhLangBtn = btn;
    return btn;
}

/**
 * 🎨 按钮（唯一实现）。
 * @param node 目标节点
 * @param onPick 可选回调 (hex|null) —— XHLabel 之类除了给节点框上色，还要把颜色同步进自己的状态。
 */
export function makeColorBtn(node, onPick) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "🎨";
    btn.title = currentLang() === "zh" ? "节点颜色" : "Node color";
    // 方案 B：#0f3460 暗蓝 → 中性暗底（这条也是"5套皮肤并存"之一）
    paintBarBtn(btn, "neutral");
    btn.style.width = "36px";
    btn.style.fontSize = "13px";
    btn.onmouseenter = () => (btn.style.filter = "brightness(1.28)");
    btn.onmouseleave = () => (btn.style.filter = "none");
    btn.onclick = (e) => { e.stopPropagation(); showXHPalette(node, btn, onPick); };
    return btn;
}

export function releaseButtons(node) {
    if (node && node._xhLangBtn) _LANG_BTNS.delete(node._xhLangBtn);
}

/**
 * 把 DOM widget 提到 node.widgets 最前面（置顶）。
 * serialize:false 的 widget 不参与 widgets_values 序列化，移动顺序不影响存档。
 * 这样中/EN + 🎨 永远贴在节点内容区最上方，不会被参数控件挤到中间/底部。
 */
export function pinWidgetToTop(node, widget) {
    if (!node || !widget || !Array.isArray(node.widgets)) return;
    const i = node.widgets.indexOf(widget);
    if (i > 0) {
        node.widgets.splice(i, 1);
        node.widgets.unshift(widget);
    }
    try { node.setDirtyCanvas?.(true, true); } catch (e) {}
}

/**
 * 🔴 把 DOM widget 的行高**永久钉死**为 px（家族唯一实现，2026-10-14 第三轮修「节点上下一大片空白」）。
 *
 * 为什么必须连 `computeLayoutSize` 一起撤掉 —— 前端源码实证（comfyui_frontend_package 1.55.14）：
 *   ① 画布布局 `_arrangeWidgets`：`if(e.computeSize){高度=computeSize()[1]+4}` →
 *      我们给了 computeSize ⇒ 走「固定」分支，画布模式下本来就正常。
 *   ② **Vue Nodes（Nodes 2.0）根本不看 computeSize**。它把控件渲染成 CSS Grid
 *      （`WidgetGrid` → `lg-node-widgets`，`flex:1`），每行的尺寸是：
 *          rowSize = shouldExpand(type) || hasLayoutSize ? "auto" : "min-content"
 *      （源码：settingStore 里 `deriveWidgetRenderState` → `hasLayoutSize: typeof e.computeLayoutSize === "function"`）
 *      而 `DOMWidgetImpl` 的**基类自带** `computeLayoutSize` ⇒ 每个 DOM widget 的行都是 `auto`
 *      ⇒ 节点多出来的竖向空间被**平均灌进所有 `auto` 行**（工具条行 / 状态行 / 文本框行）
 *      ⇒ 工具条下面、状态条下面各留一大块空白，而且**节点拖得越大、空白越大**。
 *      官方节点没这毛病，是因为它的控件不是 DOM widget（native textarea 走 `shouldExpand`，
 *      只有文本框那一行是 `auto`）—— 所以「只有文本款跟着变大」。
 *
 *   修法：本函数已用 computeSize 把高度定死，于是**把 computeLayoutSize 抹掉**
 *      · Vue：`hasLayoutSize = false` ⇒ 行变 `min-content` ⇒ 不再吸收空白
 *      · 画布：`_arrangeWidgets` 先命中 `e.computeSize` 分支，行为不变
 *   只对「固定高度」的 DOM widget 用（工具条 / 状态条 / 信息条 / 按钮条 / 开关轨…）；
 *   **会生长的**（图片画廊 / 3D 预览 / 视频播放器 / LoRA 行栈 / 滑块）**不要调**，
 *   它们就该吃掉多余空间。
 *
 * @param widget addDOMWidget 返回的 widget
 * @param px     固定高度（px）；也可以传**函数** `() => 高度`（高度会变、但对「节点尺寸」不敏感的
 *               场景，例如视频播放器按宽高比算出的高度）—— 函数每次问都要给同一个答案，
 *               绝不能用 `node.size` 反推，否则会和节点尺寸互相喂成无限增长。
 */
export function lockDomWidgetHeight(widget, px) {
    if (!widget) return null;
    const resolve = (typeof px === "function") ? px : () => px;
    const size = () => Math.max(1, Math.round(Number(resolve()) || 1));
    try { widget.computeSize = (w) => [w || 200, size()]; } catch (e) {}
    try { widget.getMinHeight = () => size(); } catch (e) {}
    try { if (widget.options) widget.options.getMinHeight = () => size(); } catch (e) {}
    try { widget.computeLayoutSize = undefined; } catch (e) {}
    return widget;
}

/**
 * 🔴🔴 2026-10-16 无头浏览器真机实锤：Vue 前端（settingStore 的 ComfyNode）构造节点时会把
 *    `node.size` **换成 Float64Array**（调用栈：setInitialSize ← new ComfyNode ← expandToFitContent）。
 *    `Array.isArray(new Float64Array([400,1994]))` === **false**！
 *    ⇒ 全族所有 `Array.isArray(node.size)` 守卫**集体失效**：
 *      compactNodeSize / forceCompactOnSpawn / SetGet refreshLayout 从来没真正执行过一次，
 *      「拖出来就巨高」从头到尾没修掉就是这个原因（2026-10-13/16 两轮修复全打在空气上）。
 *    判断「能不能当 [w, h] 用」必须**数组和类型化数组都认**；读 `size[1]` / 写 `size[1]=x`
 *    对两者都通用（Float64Array 支持下标读写，且前端认原地写 —— 实测写 360/800 都立即生效）。
 *
 * @param v 待判断的值（通常是 node.size 或 computeSize() 的返回值）
 * @returns 是否为可当 [宽, 高] 用的序列
 */
export function isSizeLike(v) {
    return !!v && typeof v === "object" && typeof v.length === "number" && v.length >= 2
        && typeof v[0] === "number" && typeof v[1] === "number";
}

/**
 * 🔴🔴 2026-10-16「生成/读档虚高」通杀补丁 —— XH 家族节点一拖出来就巨高的根因与解法。
 * 改这个函数前先读这段（无头浏览器真机测量实锤，不是猜的）：
 *
 *  根因链：
 *   ① 节点**构造期**（LiteGraph.createNode）前端就按**全部声明控件**算初始 size 并写进
 *      node.size —— 提示词表 32 个 prompt 框 → 实测 size[1]=1994；分段表 64 行 → 1800；
 *      MSR / 视频加载默认收起的 6~7 个高级参数也各吃一份。**此时我们的折叠代码还没跑**
 *      （onNodeCreated 在构造之后才调）。
 *   ② 我们在 onNodeCreated 里 w.hidden 折叠掉多余控件，但 **node.size 不缩**。
 *   ③ Vue 网格铁律（前端 settingStore 源码）：只要有一行是 `auto`（`textarea` 就在
 *      shouldExpand 名单里），整个 widget 网格 `flex:1` 撑满节点身体 ⇒ 多出的高度
 *      **全灌进那个多行框**（提示词表实测 prompt_0 行高 1465px）；没有多行框的节点
 *      则底部留一条空白。
 *   ④ 老 compactNodeSize 想缩，但 `_xh_*_user_resized` 被生成期间的前端布局同步
 *      **误触发**成 true（实测两个节点 spawn 后 ur 全是 true）⇒ 永久罢工。
 *   ⑤ 🔴 2026-10-16 无头真机实锤（前两轮修复全死在这一点上）：Vue 前端把 node.size
 *      换成 **Float64Array**（setInitialSize ← new ComfyNode），`Array.isArray(node.size)`
 *      恒为 false ⇒ compactNodeSize / 本函数 / SetGet refreshLayout 的 Array.isArray 守卫
 *      **每次都直接 return，一次都没执行过**。已全族改用 isSizeLike()（数组/类型化数组都认）。
 *
 *  实测两条定心事实：
 *   · createNode 一造出来 size 就是虚高值（构造期写好，早于 onNodeCreated/onConfigure）；
 *   · add 之后 2 秒内 size 稳定不反弹 ⇒ **带锁单次写回就能钉住**，不存在无限反馈环。
 *
 *  本函数的对策（排 5 个延迟任务 +120/+350/+700/+1300/+2200ms）：
 *   · 只在「高度明显高于内容（> cs + maxExcess）」时才动手，只改高度不碰宽度；
 *   · **spawnSize 护栏**：调用方在折叠前把 node.size[1] 传进来，之后只缩「还等于这个
 *     虚高值」的情况 —— 用户一拖动尺寸就绝不等于它 ⇒ 绝不跟用户抢尺寸（2026-10-01
 *      「改框数把手动拖大的节点缩回原形」事故的教训）；
 *   · 没传 spawnSize 时退化成「第一次见到就缩」（120ms 内人类不可能拖完节点）；
 *   · 写尺寸时给 lockKeys / _xh_auto_sizing 上锁，防止被 onResize 误判成用户操作；
 *     确认缩的是 bug 虚高时，把 userKeys（被误触发的 user_resized）一并清掉，
 *     让后续 compactNodeSize 恢复正常工作。
 *
 * @param node    节点实例
 * @param opts.maxExcess  认为「虚高」的最小超出量 px。巨肥通病（提示词表 +1634 /
 *                        分段表 +1312）用默认 400；只藏一两个小控件的节点传 12~100。
 * @param opts.spawnSize  折叠前读到的 node.size[1]（构造期虚高值）。给了就只缩相等的。
 * @param opts.lockKeys   本节点 onResize 用的 auto_sizing 锁名数组（如 ["_xh_cp_auto_sizing"]）
 * @param opts.userKeys   本节点的 user_resized 标志名数组（如 ["_xh_cp_user_resized"]）
 */
export function forceCompactOnSpawn(node, opts = {}) {
    if (!node) return;
    const maxExcess = Number.isFinite(opts.maxExcess) ? opts.maxExcess : 400;
    const spawnSize = Number.isFinite(opts.spawnSize) ? opts.spawnSize : null;
    const lockKeys = Array.isArray(opts.lockKeys) ? opts.lockKeys : [];
    const userKeys = Array.isArray(opts.userKeys) ? opts.userKeys : [];
    const DELAYS = [120, 350, 700, 1300, 2200];
    let seen = null;      // 第一次见到的虚高值（布局延迟写回时按它认亲）
    let handsOff = false; // 用户动过尺寸 ⇒ 收手
    const shrink = (cs) => {
        try { node._xh_auto_sizing = true; } catch (e) {}
        for (const k of lockKeys) { try { node[k] = true; } catch (e) {} }
        try { node.size[1] = cs[1]; } catch (e) {}
        for (const k of lockKeys) { try { node[k] = false; } catch (e) {} }
        try { node._xh_auto_sizing = false; } catch (e) {}
        for (const k of userKeys) { try { if (k in node) node[k] = false; } catch (e) {} }
        try { node.setDirtyCanvas?.(true, true); } catch (e) {}
        try { node.graph?.setDirtyCanvas?.(true, true); } catch (e) {}
    };
    for (const d of DELAYS) {
        setTimeout(() => {
            try {
                if (handsOff || !node || !isSizeLike(node.size)) return;
                const cs = node.computeSize ? node.computeSize() : null;
                if (!isSizeLike(cs)) return;
                const cur = node.size[1];
                const excess = cur - cs[1];
                if (excess <= maxExcess) { seen = null; return; }   // 已经紧凑，重置认亲值
                // ① 还等于出生时那个虚高值 ⇒ 铁定是 bug（用户拖过就绝不相等）
                if (spawnSize !== null && Math.abs(cur - spawnSize) <= 4) { shrink(cs); return; }
                // ② 第一次见到虚高：120ms 内人类不可能拖完 ⇒ 记下就缩；之后才见到 ⇒ 记下等认亲
                if (seen === null) {
                    if (d > 120) return;          // 迟到 sighting 且没有 spawnSize 佐证 ⇒ 不赌，收手
                    seen = cur;
                } else if (Math.abs(cur - seen) > 4) {
                    handsOff = true; return;      // 值变了 = 用户动过 ⇒ 收手
                }
                shrink(cs);
            } catch (e) {}
        }, d);
    }
}

/**
 * 给节点挂标准工具条（中/EN + 🎨），内部 addDOMWidget，返回 {bar, langBtn, colorBtn, widget}。
 *
 * 🔴 工具条会**强制置顶**：addDOMWidget 后把该 widget 移到 node.widgets 数组最前面，
 *    中/EN + 🎨 永远贴在节点内容区最上方。
 *    （serialize:false 的 widget 不参与 widgets_values 序列化，移动顺序不影响存档。）
 *
 * 宽度自适应：bar 设了 width:100%，ComfyUI 会把 DOM widget 分配到节点内容区整宽，
 *    按钮横向排满（中/EN 与 🎨 永远并排）；图片画廊同理，节点拉宽时自动多排几列。
 * 高度：由 `lockDomWidgetHeight(widget, 28)` 钉死 —— 画布与 Vue Nodes 两种模式下
 *    都**不再吸收**节点多余的竖向空间（2026-10-14 修复）；多余空间改由文本框 /
 *    3D 预览等真正「可生长」的控件吃下，与官方节点行为一致。
 *
 * @param node 节点实例
 * @param opts.widgetName DOM widget 名（默认 xh_ui_bar）
 * @param opts.prependNodes 放在「中/EN」**左边**的额外元素（可选）
 * @param opts.appendNodes  放在「🎨」**右边**的额外元素（可选）
 * @param opts.mount        false = **只造条不挂载**（返回的 widget 为 null），
 *                          由调用方自己 addDOMWidget —— 给「工具条要嵌在复合容器里 /
 *                          要贴节点底部而不是置顶」的节点用（XH-Slider / XH-LoopStack /
 *                          XH-SetGet / XH-图片列表 / XH-标签 / XH-计时器 等）。
 *                          条本身的样式、按钮、拼装顺序、事件拦截仍是家族唯一实现。
 * @param opts.colorOnPick  🎨 选色后的额外回调 (hex|null) —— 除上色外还要同步自身状态的节点用（XHLabel）。
 */
export function makeXHToolbar(node, opts = {}) {
    installTitleAutoColor(node);        // 家族节点一律：标题文字按标题栏底色自动黑/白
    installVueTitleAutoColor();         // Vue Nodes：canvas 不画标题，改在 DOM 标题栏上落字色
    const bar = document.createElement("div");
    bar.style.cssText = "display:flex;align-items:center;gap:6px;padding:3px 4px;width:100%;box-sizing:border-box;flex-wrap:wrap;background:transparent;";
    for (const el of (opts.prependNodes || [])) if (el) bar.appendChild(el);
    const langBtn = makeLangBtn(node);
    bar.appendChild(langBtn);
    const colorBtn = makeColorBtn(node, opts.colorOnPick);
    bar.appendChild(colorBtn);
    for (const el of (opts.appendNodes || [])) if (el) bar.appendChild(el);
    ["pointerdown", "mousedown", "dblclick", "keydown", "click"].forEach((ev) =>
        bar.addEventListener(ev, (e) => e.stopPropagation())
    );
    let widget = null;
    if (opts.mount !== false) {
        try {
            widget = node.addDOMWidget(opts.widgetName || "xh_ui_bar", "custom", bar, {
                serialize: false,
                hideOnZoom: false,
                getMinHeight: () => 28,
            });
            // 🔴 插槽定高（2026-10-11 二轮 → 2026-10-14 三轮才真正修好，见 lockDomWidgetHeight 注释）：
            //    只写 computeSize 对 **Vue Nodes 无效** —— Vue 把控件渲染成 Grid，
            //    行高只看 `hasLayoutSize = !!computeLayoutSize`，DOM widget 基类自带它，
            //    所以工具条行永远是 `auto`，节点多出的高度全灌进来 → 按钮 28px、下面空一大块。
            //    必须连 computeLayoutSize 一起撤掉，行才会变 `min-content`。
            //    节点多出的高度改流向文本框 / 3D 预览等真正的「可生长」控件（与官方节点行为一致）。
            lockDomWidgetHeight(widget, 28);
        } catch (e) {
            console.warn("[XH UI Kit] 工具条挂载失败:", e);
        }
        // 🔴 序列化加固（2026-10-10）：本机 ComfyUI 新前端**不认** options.serialize=false，
        //    照样把工具条写进 widgets_values（就是数组开头那个 ""）；切换工作流重载时
        //    positional 回填会整体错位一格 → 下拉框变红 / 显示成数字。三重堵住。
        try {
            if (widget) {
                widget.serialize = false;
                if (widget.options) widget.options.serialize = false;
                widget.serializeValue = () => undefined;
            }
        } catch (e) {}
        pinWidgetToTop(node, widget);                   // widgets 数组置顶：中/EN + 🎨 永远在节点内容区最上方

        // 🔴 消除工具条上下留白（2026-10-11，用户反馈节点顶部长块空白）：
        //    Vue 节点把 widgets 渲染成 flex 列，DOM widget 的包装容器默认可被拉伸，
        //    节点多余的竖向空间全灌进工具条行 → 按钮 28px、上下各空一大块。
        //    修法：工具条自身定高不伸缩 + 渲染后把它的包装容器 flex 锁死为「不拉伸」。
        bar.style.flex = "0 0 auto";
        bar.style.height = "28px";
        bar.style.overflow = "hidden";
        const _lockBarRow = () => {
            try {
                const el = widget && widget.element;
                const p = el && el.parentElement;
                if (p) {
                    p.style.flex = "0 0 auto";
                    p.style.height = "28px";
                    p.style.overflow = "hidden";
                    p.style.minHeight = "0";
                }
            } catch (e) {}
        };
        setTimeout(_lockBarRow, 0);
        setTimeout(_lockBarRow, 300);                   // Vue 二次渲染后再锁一次
        onLangChanged(() => setTimeout(_lockBarRow, 50)); // 语言切换重排后再锁（kit 末尾已挂全局事件，这里复用）
    }
    return { bar, langBtn, colorBtn, widget };
}

// ---- ④ 下拉框「显示中文、存值不变」（官方钩子 options.getOptionLabel）----
//
// 铁律：**绝不改 w.options.values**（那是存档值），只用 getOptionLabel 换显示文字。
// 函数不进工作流 JSON，所以分享出去不会污染别人的图。
//
// @param table { widgetName: { value: "中文显示" } }；英文态直接删掉钩子 → 回落显示原值
export function applyComboLabels(node, lang, table) {
    if (!node || !node.widgets || !table) return;
    const zh = (lang || "zh") === "zh";
    for (const w of node.widgets) {
        if (!w || !w.options) continue;
        const map = table[w.name];
        if (!map) continue;
        if (zh) {
            w.options.getOptionLabel = (v) => (v == null ? "" : (map[String(v)] || String(v)));
        } else {
            try { delete w.options.getOptionLabel; } catch (e) {}
        }
    }
    try { node.setDirtyCanvas?.(true, true); } catch (e) {}
}

/**
 * 双向下拉标签（2026-10-11）：中/EN 两种语言**都**装 getOptionLabel 钩子，
 * 解决「原值是中文 → EN 态显示中文；原值是英文 → 中文态显示英文」的双向问题。
 * applyComboLabels 只覆盖「zh 映射 / en 回落」单向场景，本函数是它的双向版。
 *
 * 铁律不变：**绝不改 w.options.values**（存档值），只换显示文字。
 *
 * @param table { widgetName: { 原值: { zh: "中文显示|null", en: "EN display|null" } } }
 *   某语言为 null / 缺失 → 回落显示原值。
 */
export function applyComboLabelsBi(node, lang, table) {
    if (!node || !node.widgets || !table) return;
    const l = (lang || currentLang()) === "zh" ? "zh" : "en";
    for (const w of node.widgets) {
        if (!w || !w.options) continue;
        const map = table[w.name];
        if (!map) continue;
        w.options.getOptionLabel = (v) => {
            if (v == null) return "";
            const e = map[String(v)];
            if (!e) return String(v);
            return e[l] || String(v);
        };
    }
    try { node.setDirtyCanvas?.(true, true); } catch (e) {}
}

// 常用的「精度 / 设备」中文显示（多个节点共用，避免各写一份；中文态纯中文，英文态回落原值）
/**
 * 🔴 切换工作流重载时「下拉框变红 / 显示成数字」的自愈（2026-10-10）
 *
 * 病根：XH 工具条 DOM widget（xh_ui_bar）被新前端写进 widgets_values，占了第 0 格；
 *       而它是在 onNodeCreated 里才挂载、并被 pinWidgetToTop 塞到 node.widgets 最前面的。
 *       挂载时机在「首次加载」与「切回来」时不一致 → positional 回填整体错位一格
 *       → COMBO 拿到隔壁槽位的数字 → 不在 options.values 里 → 变红 + 显示成数字。
 *
 * 用法：beforeRegisterNodeDef 里包 onConfigure，调 fixWidgetValuesFromSaved(this, info)。
 *
 * 策略：① 有 widgets_values_named → 按**名字**回填（与顺序无关，永远对）；
 *       ② 无 named → positional 纠偏：存档比真实 widget 多 1 项、且首尾是空值（工具条残留）
 *          就剔掉再对位；
 *       ③ 长度对不上就**不动**（宁可不动，也不乱写）。
 */
export function fixWidgetValuesFromSaved(node, saved) {
    if (!node || !Array.isArray(node.widgets) || !saved) return;
    const BAR = "xh_ui_bar";
    // 🔴 2026-10-15：排除条件从「只认 xh_ui_bar 这个名字」改成「与前端序列化判据一致」。
    //    前端（settingStore-*.js）存档时的循环是：
    //        for (const [idx, w] of widgets.entries())
    //            if (!w.name || w.options.serialize === false) continue;   // ← 不存档
    //    而 positional 纠偏要把「存档数组」与「真实 widget」对齐 ——
    //    若 real 里仍留着**不存档**的自定义 DOM widget（如 XH Set/Get 的通道行 xh_sg_rowN、
    //    或其它带自绘行的节点），长度必然对不上 ⇒ 直接落到「③ 不动」，自愈形同虚设。
    //    补上 options.serialize === false 的排除后，real 就与前端存档口径一致。严格更正确，无回归。
    const real = node.widgets.filter((w) => w && w.name !== BAR && !(w.options && w.options.serialize === false));
    if (!real.length) return;
    const dirty = () => { try { node.setDirtyCanvas?.(true, true); } catch (e) {} };

    // ① 按名字回填（最可靠）
    const named = saved.widgets_values_named;
    if (named && typeof named === "object") {
        for (const w of real) {
            if (!(w.name in named)) continue;
            const v = named[w.name];
            if (v === undefined) continue;
            // COMBO 只在值合法时写回，避免又把不在选项里的值塞进去
            if (w.type === "combo" && Array.isArray(w.options && w.options.values)) {
                if (!w.options.values.includes(v)) continue;
            }
            w.value = v;
        }
        dirty();
        return;
    }

    // ② 老存档（只有 widgets_values）positional 纠偏
    const vals = saved.widgets_values;
    if (!Array.isArray(vals) || !vals.length) return;
    const isBlank = (x) => x === "" || x === null || x === undefined;
    let arr = vals.slice();
    if (arr.length === real.length + 1) {
        if (isBlank(arr[0])) arr = arr.slice(1);                        // 工具条残留在开头
        else if (isBlank(arr[arr.length - 1])) arr = arr.slice(0, -1);  // 残留在结尾
    }
    if (arr.length !== real.length) return;                             // 对不上就不动
    real.forEach((w, i) => {
        let v = arr[i];
        if ((w.type === "boolean" || w.type === "toggle") && typeof v === "number") v = !!v;
        w.value = v;
    });
    dirty();
}

export const XH_COMBO_COMMON = {
    fp16: "半精度（快·省）",
    bf16: "脑浮点（稳）",
    fp32: "全精度（慢·占显存）",
    cuda: "显卡",
    cpu: "处理器",
};

// ---- 全局：语言一变，所有已注册按钮一起换字；回调在调用方注册 ----
window.addEventListener("xh:lang-changed", (e) => {
    const lang = (e.detail && e.detail.lang) || currentLang();
    for (const b of _LANG_BTNS) styleLangBtn(b, lang);
});

/**
 * 注册"语言变化"处理：先立刻执行一次，再挂到 xh:lang-changed 上。
 * 顺带处理工作流载入（app.graph.configure）后的重刷。
 */
export function onLangChanged(handler, opts = {}) {
    const run = () => { try { handler(currentLang()); } catch (e) { console.warn("[XH UI Kit] 语言回调失败:", e); } };
    window.addEventListener("xh:lang-changed", run);
    setTimeout(run, opts.initialDelay ?? 150);
    if (opts.wrapConfigure !== false) {
        try {
            if (app.graph && app.graph.configure && !app.graph.__xhUiKitWrapped) {
                const orig = app.graph.configure.bind(app.graph);
                app.graph.configure = function (...args) {
                    const r = orig.apply(app.graph, args);
                    setTimeout(run, 250);
                    return r;
                };
                app.graph.__xhUiKitWrapped = true;
            }
        } catch (e) {}
    }
}

// ══════════════════════════════════════════════════════════════════════
// ⑤ 家族统一滑块（唯一实现）—— XH-滑块节点、悬浮窗不透明度 等一律共用
// ══════════════════════════════════════════════════════════════════════
// 🔴 2026-10-20 补记（用户原话："家族还有一个节点是拥有滑块的……能不能统一风格统一一下"）：
//    之前做悬浮窗时又画了一套自制滑块（深蓝大把手 + 进度填充），跟家族 XH-滑块 长得完全不一样。
//    ⇒ 把 XH-滑块 节点的滑块抽到这里，**一处实现、两处使用**，外观从此只有一种。
//    外观 = 家族原版：原生 input[type=range] + accent-color 家族蓝 + 右侧数字框（74px）。
//    `zoom:1.2` 是应用户"大一些、明显一些"的要求，只整体放大 20%（accent-color 造型保留）；
//    不支持 zoom 的浏览器自动退回原尺寸，不会有样式破掉的风险。
let _xhSliderCssDone = false;
function ensureXHSliderCss() {
    if (_xhSliderCssDone) return;
    _xhSliderCssDone = true;
    const el = document.createElement("style");
    el.textContent = `
    .xh-sl-root{display:flex;flex-direction:column;gap:4px;padding:6px;width:100%;
        box-sizing:border-box;font-family:sans-serif;font-size:12px;color:inherit;}
    .xh-sl-row{display:flex;gap:6px;align-items:center;}
    .xh-sl-row .xh-sl-label{flex:0 0 auto;font-size:11px;color:#cfd8e3;white-space:nowrap;}
    .xh-sl-row input[type=range]{flex:1 1 auto;min-width:0;cursor:pointer;
        accent-color:#4a90d9;zoom:1.2;}
    /* 🔴 2026-10-21 用户截图：数字框原生 ▲▼ 上三角被裁一刀 ——
       根因是 input 没定高，仅靠 font-size+padding 撑出约 18px，原生 spinner 需要更高
       才画得下上下两个三角。钉 24px + line-height:1 + border-box 让它完整显示。 */
    .xh-sl-row input[type=number]{width:74px;flex:none;font-size:12px;padding:0 4px;
        height:24px;line-height:1;box-sizing:border-box;
        border-radius:3px;border:1px solid rgba(0,0,0,.3);background:#1f1f1f;color:#e8e8e8;
        text-align:right;}
    .xh-sl-toolbar{display:flex;gap:4px;align-items:center;}
    .xh-sl-toolbar .spacer{flex:1;}
    /* 方案 B：与 makeBarBtn 同源（暗底 + 1px 半透明白描边 + 字重 600），⛔ 不再 #0f3460/bold */
    .xh-sl-toolbar button{border:1px solid rgba(255,255,255,.10);border-radius:4px;padding:2px 8px;
        font-size:11px;font-weight:600;cursor:pointer;color:#d5dde5;background:#262d38;}
    .xh-sl-toolbar button:hover{background:#2f3946;}
    .xh-sl-toolbar button.xh-sl-lang{width:36px;height:22px;padding:0;font-size:12px;}
    .xh-sl-settings{display:flex;gap:6px;align-items:center;flex-wrap:wrap;
        background:rgba(127,127,127,.12);border:1px solid rgba(0,0,0,.2);
        border-radius:4px;padding:4px;}
    .xh-sl-settings label{display:flex;gap:3px;align-items:center;font-size:11px;opacity:.85;}
    .xh-sl-settings input[type=number]{width:62px;font-size:11px;padding:1px 3px;border-radius:3px;
        border:1px solid rgba(0,0,0,.3);background:#1f1f1f;color:#e8e8e8;}
    .xh-sl-settings.hidden{display:none;}
    `;
    document.head.appendChild(el);
}

/**
 * 家族统一滑块。
 * @param {object} o
 *   min / max / step / value / decimals  基本参数
 *   label      可选，左侧文字（XH-滑块 节点本身不需要，悬浮窗这种需要）
 *   numWidth   数字框宽度，默认 74（家族规格）
 *   onInput    (v)=>{}  拖动/输入数字后回调（**set() 不会触发它**，避免回环）
 * @returns {{root:HTMLElement,row:HTMLElement,range:HTMLInputElement,
 *            numBox:HTMLInputElement,set:(v:number,dec?:number)=>void,get:()=>number}}
 */
export function makeXHSlider(o = {}) {
    ensureXHSliderCss();
    const min = Number.isFinite(Number(o.min)) ? Number(o.min) : 0;
    const maxRaw = Number(o.max);
    const max = Number.isFinite(maxRaw) && maxRaw !== min ? maxRaw : min + 100;
    const step = Math.max(Number(o.step) || 1, 0.0001);
    let decimals = Math.min(4, Math.max(0, Math.floor(Number(o.decimals ?? 0) || 0)));

    const root = document.createElement("div");
    root.className = "xh-sl-root";
    const row = document.createElement("div");
    row.className = "xh-sl-row";

    let labelEl = null;
    if (o.label) {
        labelEl = document.createElement("span");
        labelEl.className = "xh-sl-label";
        labelEl.textContent = o.label;
        row.appendChild(labelEl);
    }

    const range = document.createElement("input");
    range.type = "range";
    range.min = String(min);
    range.max = String(max);
    range.step = String(step);
    const numBox = document.createElement("input");
    numBox.type = "number";
    numBox.min = String(min);
    numBox.max = String(max);
    numBox.step = String(step);
    if (o.numWidth) numBox.style.width = o.numWidth + "px";
    if (labelEl) labelEl.title = o.labelTitle || "";
    range.title = o.tip || "";

    row.appendChild(range);
    row.appendChild(numBox);
    root.appendChild(row);

    // 家族铁律：DOM 控件必须吞掉画布事件，否则拖滑块会变成拖节点
    for (const el of [range, numBox]) {
        ["pointerdown", "mousedown", "dblclick", "keydown", "click"].forEach((ev) =>
            el.addEventListener(ev, (e) => e.stopPropagation(), true)
        );
    }

    const clamp = (v) => {
        let x = Number(v);
        if (!Number.isFinite(x)) x = min;
        const p = Math.pow(10, decimals);
        x = Math.round(x * p) / p;
        return Math.min(max, Math.max(min, x));
    };
    const paint = (v, dec) => {
        const d = dec == null ? decimals : dec;
        range.value = String(v);
        numBox.value = Number(v).toFixed(d);
    };
    const emit = (raw) => {
        const v = clamp(raw);
        paint(v);
        try { o.onInput?.(v); } catch (e) { console.warn("[XH Slider] onInput 抛错:", e); }
    };
    range.addEventListener("input", () => emit(range.value));
    numBox.addEventListener("change", () => emit(numBox.value));

    paint(clamp(o.value == null ? min : o.value));

    return {
        root, row, range, numBox,
        /** 更新显示（**不触发 onInput**，用于外部同步回填） */
        set: (v, dec) => paint(clamp(v), dec),
        get: () => Number(range.value),
        setDecimals: (d) => { decimals = Math.min(4, Math.max(0, Math.floor(Number(d) || 0))); paint(clamp(range.value)); },
    };
}

/** 滑块所在 DOM widget 的动态高度（XH-滑块 节点已验证：getMinHeight/getHeight 比 lockDomWidgetHeight 管用） */
export function sliderHeight(el, fallback = 44) {
    try {
        return (el?.scrollHeight || el?.offsetHeight || fallback) + 4;
    } catch (e) {
        return fallback;
    }
}

// ---- ⑬ ⚙ 齿轮按钮（家族唯一样式，2026-10-20）------------------------------
//
// 为什么抽到 kit：家族里带齿轮的节点有 4 个（XH-滑块 / XH-链式提示词 / XH-加载视频 /
// XH-MSR中继），此前是**两份 emoji（⚙）+ 两份自写 SVG**，底色 #0f3460 偏暗、齿画得细、
// 挂载位置还各不相同（prepend / append 混用）。用户明确要求「统一起来」⇒ 一处实现。
//
// 图标：8 齿**粗壮实心**齿轮（齿根 r=8.7 / 齿顶 r=11.4，中心孔 r=3.9），
//       同一 fill 描边 0.9 + round join 把尖角磨圆 ⇒ 15px 下依旧「有肉」，不再是细线团。
// 颜色：收起=亮蓝 #1668b3（原 #0f3460 太暗）、展开=绿 #1d9e75，一眼分辨状态。
// 尺寸：26×22（与家族其它小按钮同排不突兀）。
// 位置：**永远排工具条最左**（调用方一律传 makeXHToolbar 的 prependNodes）。
//
// 用法：
//   const gear = makeGearBtn({
//       titleFn: (col) => col ? "点开展开参数" : "点此收起参数",   // 语言切换自动跟随
//       onToggle: (col) => setCollapsed(node, col),
//   });
//   makeXHToolbar(node, { prependNodes: [gear] });
export const XH_GEAR_SVG =
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" '
    + 'style="display:block;flex:0 0 auto">'
    + '<path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.5.5 0 0 0 '
    + '.12-.61l-1.92-3.32a.5.5 0 0 0-.59-.22l-2.39.96a7.03 7.03 0 0 0-1.62-.94l-.36-2.54a.5.5 '
    + '0 0 0-.48-.41h-3.84a.5.5 0 0 0-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.5.5 0 '
    + '0 0-.59.22L2.74 8.87a.5.5 0 0 0 .12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 '
    + '1.58a.5.5 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 '
    + '2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39'
    + '.96c.22.08.47 0 .59-.22l1.92-3.32a.5.5 0 0 0-.12-.61l-2.01-1.58zM12 15.6a3.6 3.6 0 1 1 '
    + '0-7.2 3.6 3.6 0 0 1 0 7.2z"/></svg>';

/** 齿轮底色（收起 / 展开）—— 家族统一，勿在节点里另写 */
export const GEAR_BG_COLLAPSED = "#1668b3";   // 亮蓝（展开参数）
export const GEAR_BG_OPEN = "#1d9e75";       // 绿（收起参数）

/**
 * 家族统一齿轮按钮。
 * @param opts.collapsed 初始是否收起（默认 true）
 * @param opts.title     静态 title（无 titleFn 时用）
 * @param opts.titleFn   (collapsed) => string，动态 title；语言切换后调 btn._xhGearPaint() 即刷新
 * @param opts.onToggle  (collapsed) => void，点击后调用（collapsed 为**切换后**的状态）
 * @returns HTMLButtonElement，附带 _xhGearCollapsed / _xhGearSet(c) / _xhGearPaint()
 */
export function makeGearBtn(opts = {}) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.innerHTML = XH_GEAR_SVG;
    btn.style.cssText =
        "display:flex;align-items:center;justify-content:center;width:26px;height:22px;padding:0;"
        + "border:1px solid rgba(255,255,255,.16);border-radius:4px;color:#fff;cursor:pointer;"
        + "flex:0 0 auto;font-family:inherit;"
        + "user-select:none;transition:filter .15s,background .15s,box-shadow .15s;";

    const paint = () => {
        const col = !!btn._xhGearCollapsed;
        btn.style.background = col ? GEAR_BG_COLLAPSED : GEAR_BG_OPEN;
        btn.style.boxShadow = col ? "none" : "inset 0 0 0 1px rgba(255,255,255,.5)";
        const t = (typeof opts.titleFn === "function") ? opts.titleFn(col) : opts.title;
        if (t) btn.title = t;
    };

    btn._xhGearCollapsed = opts.collapsed !== false;
    btn._xhGearSet = (c) => { btn._xhGearCollapsed = !!c; paint(); };
    btn._xhGearPaint = paint;
    paint();

    btn.addEventListener("mouseenter", () => { btn.style.filter = "brightness(1.28)"; });
    btn.addEventListener("mouseleave", () => { btn.style.filter = ""; });
    if (typeof opts.onToggle === "function") {
        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            btn._xhGearCollapsed = !btn._xhGearCollapsed;
            paint();
            opts.onToggle(btn._xhGearCollapsed, btn);
        });
    }
    ["pointerdown", "mousedown", "dblclick", "keydown", "click"].forEach((ev) =>
        btn.addEventListener(ev, (e) => e.stopPropagation()));

    return btn;
}
