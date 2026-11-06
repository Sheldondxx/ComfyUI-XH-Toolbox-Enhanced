// 🔁XH-帧数对齐 / 🔁XH-分段拼接 · 家族前端（一个 js 管两个节点，与 xh_video_tools.js 同套路）
//
// ① 中/EN 切换：节点标题 + 参数控件标签 + 输入/输出端口名（**只改 label，绝不改 name**）
// ② 下拉框「显示翻译、存档值不变」（官方钩子 options.getOptionLabel，函数不进 JSON）
// ③ 节点自身配色 🎨（XH 家族 12 色 + 自定义取色器）
// ④ 实时信息条（只读，不参与序列化）：
//    · 🔁XH-帧数对齐 → 前端**按后端同一套公式**先算一遍，改数即时看到「该要多少帧」
//    · 🔁XH-分段拼接 → 已接几段 + 校验开关状态（连/断线即刻更新）
// ⑤ 存档重载纠偏走 kit 的 fixWidgetValuesFromSaved（DOM 控件 serialize:false，自动被排除）
//
// ── 为什么这两个节点**不挂 ⚙ 齿轮** ──────────────────────────────────────────
//   ⚙ 的用途是「收起高级参数」。帧数对齐只有 3 个框（秒 / 规矩 / 帧率），全是主参数，
//   收哪一个都会让人找不到；分段拼接唯一的框是「每段应该多少帧」——那是**接缝保险丝**，
//   默认藏起来等于把最该露在外头的东西藏了。家族规范是「有高级参数才配齿轮」，
//   不是「每个节点都必须有齿轮」，所以这里不挂。以后若加高级参数再补。
//
// 铁律：只改 label / title，绝不改 name；绝不改 COMBO 的 values；DOM 控件 serialize:false 且只 append。
const { app } = window.comfyAPI.app;

import {
    ensureLangBridge, makeXHToolbar, onLangChanged, releaseButtons,
    fixWidgetValuesFromSaved, lockDomWidgetHeight,
} from "./xh_ui_kit.js";

ensureLangBridge();

const NODE_TYPES = ["XHFrameAlign", "XHSegmentConcat"];
const MAX_SEGMENTS = 12;                       // 必须与 py/video_concat.py 的 MAX_SEGMENTS 一致
const BAR_WIDGET = "xh_vseg_bar";
const INFO_WIDGET = "xh_vseg_info";

// 后端下拉**存档值**（中文人话，家族铁律：不写模型名、不写数学符号）
const RULE_H3 = "帧数 = 17 的倍数 + 5";
const RULE_LTX = "帧数 = 8 的倍数 + 1";

const FONT_STACK = 'system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif';

// ---------------------------------------------------------------------------
// 语言包：标题 + 控件标签 + 端口名 + 下拉显示 + 信息条
// ---------------------------------------------------------------------------
const XH_I18N = {
    zh: {
        nodes: {
            XHFrameAlign: "🔁XH-帧数对齐",
            XHSegmentConcat: "🔁XH-分段拼接",
        },
        widgets: {
            seconds: "🔢 数值(秒/帧)",
            rule: "📐 帧数规矩",
            fps: "🎞 帧率(帧/秒)",
            expected_frames: "✅ 每段应该多少帧(0=不校验)",
            // 🔴 seconds_link / fps_link 是 forceInput 纯输入口（没有 widget），
            //    端口点标签归下面的 slots 表；但 xh_lang_audit 对"基础类型口"查
            //    widgets 表 ⇒ 两边都登记才过审计（widgets 里这两条永远匹配不到真
            //    widget，零视觉影响）。
            seconds_link: "🔢 数值·接线",
            fps_link: "🎞 帧率·接线",
        },
        slots: {
            // 🔁XH-帧数对齐 输入（接线版，纯输入口 forceInput）
            seconds_link: "🔢 数值·接线",
            fps_link: "🎞 帧率·接线",
            // 🔁XH-帧数对齐 输出
            frame_count: "该要多少帧",
            seconds_actual: "实际多少秒",
            fps: "帧率",
            info: "一句话说明",
            // 🔁XH-分段拼接 输入 / 输出
            images: "拼好的一条",
            expected_frames: "每段应该多少帧",
            report: "每段帧数一览",
        },
        combo: {},                             // 中文态直接显示后端原值
        // 信息条
        faArrow: "→",
        faFrames: "帧",
        faSec: "秒",
        faFps: "帧/秒",
        scSeg: "段",
        scNone: "还没接任何段",
        scOne: "只接了 1 段（不用拼，直接透传）",
        scCheckOn: "校验开",
        scCheckOff: "校验已关（填 0 = 不校验，接缝风险自负）",
        scPerSeg: "每段",
    },
    en: {
        nodes: {
            XHFrameAlign: "XH Frame Align",
            XHSegmentConcat: "XH Segment Concat",
        },
        widgets: {
            seconds: "value (sec/frames)",
            rule: "frame rule",
            fps: "fps",
            expected_frames: "frames per seg (0=off)",
            seconds_link: "value · wired",
            fps_link: "fps · wired",
        },
        slots: {
            seconds_link: "value · wired",
            fps_link: "fps · wired",
            frame_count: "frame count",
            seconds_actual: "seconds (actual)",
            fps: "fps",
            info: "info",
            images: "images",
            expected_frames: "frames per seg",
            report: "report",
        },
        // 只换**显示**，存档值仍是后端那三条中文（模型名不进选项，规矩写人话）
        combo: {
            rule: {
                "帧数 = 17 的倍数 + 5": "a multiple of 17, plus 5",
                "帧数 = 8 的倍数 + 1": "a multiple of 8, plus 1",
                "不调整（取整就行）": "no rule (just round)",
            },
        },
        faArrow: "->",
        faFrames: "frames",
        faSec: "s",
        faFps: "fps",
        scSeg: "segs",
        scNone: "no segment connected",
        scOne: "1 seg only (passthrough)",
        scCheckOn: "check on",
        scCheckOff: "check off (0 = no verify, seam risk)",
        scPerSeg: "per seg",
    },
};

// 「第 N 段」端口名：两个语言都补齐（端口名也是界面文字，家族要求全覆盖）
for (let i = 1; i <= MAX_SEGMENTS; i++) {
    XH_I18N.zh.slots["images_" + i] = "第 " + i + " 段";
    XH_I18N.en.slots["images_" + i] = "seg " + i;
}

function t(lang, kind, key) {
    const pack = XH_I18N[lang] || XH_I18N.zh;
    return (pack[kind] && pack[kind][key]) || null;
}

function T(node, key) {
    const lang = window.XH_LANG || "zh";
    const pack = XH_I18N[lang] || XH_I18N.zh;
    return (pack && pack[key]) || XH_I18N.zh[key] || key;
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------
function widget(node, name) {
    return (node.widgets || []).find((x) => x && x.name === name) || null;
}

function wNum(node, name, dflt) {
    const w = widget(node, name);
    if (!w) return dflt;
    const v = parseFloat(w.value);
    return isFinite(v) ? v : dflt;
}

function wStr(node, name) {
    const w = widget(node, name);
    return w && w.value != null ? String(w.value) : "";
}

function isVueNodes() {
    try { return window.LiteGraph && window.LiteGraph.vueNodesMode === true; } catch (e) { return false; }
}

function relayout(node) {
    try { node.onResize?.(node.size); } catch (e) {}
    if (!isVueNodes()) {
        try {
            const h = node.computeSize([node.size[0], node.size[1]])[1];
            if (h > 0) node.setSize([node.size[0], h]);
        } catch (e) {}
    }
    try { node.setDirtyCanvas?.(true, true); } catch (e) {}
    try { node.graph?.setDirtyCanvas?.(true, true); } catch (e) {}
}

// ---------------------------------------------------------------------------
// ④ 信息条（DOM 控件，serialize:false，只 append，绝不 unshift）
// ---------------------------------------------------------------------------
function makeInfoBar(node) {
    const el = document.createElement("div");
    el.style.cssText =
        "display:flex;align-items:center;gap:6px;padding:5px 9px;width:100%;box-sizing:border-box;"
        + "border-radius:6px;background:rgba(255,255,255,0.10);"
        + `font-family:${FONT_STACK};`
        + "font-size:12px;font-weight:600;color:#ffffff;text-shadow:0 1px 2px rgba(0,0,0,0.35);"
        + "margin:0;user-select:none;white-space:nowrap;overflow:hidden;";
    const dot = document.createElement("span");
    dot.style.cssText = "flex:0 0 auto;width:7px;height:7px;border-radius:50%;background:#8a93a0;";
    const text = document.createElement("span");
    text.style.cssText = "flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;";
    el.appendChild(dot);
    el.appendChild(text);
    el.addEventListener("pointerdown", (e) => e.stopPropagation());
    el.addEventListener("click", (e) => e.stopPropagation());

    let w = null;
    try {
        w = node.addDOMWidget(INFO_WIDGET, "custom", el, {
            serialize: false, hideOnZoom: false,
        });
        lockDomWidgetHeight(w, 26);
        // 三重堵：本机新前端不认 options.serialize=false，照样写进 widgets_values
        w.serialize = false;
        if (w.options) w.options.serialize = false;
        w.serializeValue = () => undefined;
    } catch (e) {
        console.warn("[XH VideoSegments] 信息条挂载失败:", e);
    }
    node._xhVS = node._xhVS || {};
    node._xhVS.dotEl = dot;
    node._xhVS.textEl = text;
    return w;
}

function setInfo(node, txt, color) {
    const s = node && node._xhVS;
    if (!s || !s.textEl) return;
    s.textEl.textContent = txt || "";
    try { s.dotEl.style.background = color || "#8a93a0"; } catch (e) {}
    try { node.setDirtyCanvas?.(true, true); } catch (e) {}
}

// ---------------------------------------------------------------------------
// 🔁XH-帧数对齐：前端复算（与 py/frame_align.py 同一套公式，保证所见即所得）
// ---------------------------------------------------------------------------
/**
 * 🔴 必须复刻 Python 的「取模恒为正」语义（2026-10-21 实测踩坑）：
 *    Python `-6 % 17 === 11`，而 JS `(-6) % 17 === -6`（JS 的 % 保留被除数符号）。
 *    直接写 `(5 - n0 % 17) % 17` ⇒ 前端算出 73 帧、后端真输出 90 帧（3.3 秒 @24fps 实测），
 *    信息条就成了「骗子」。所以这里一律走 pmod()。
 */
function pmod(a, m) {
    return ((a % m) + m) % m;
}

function alignCount(secIn, rule, fpsIn) {
    let fps = parseFloat(fpsIn);
    if (!isFinite(fps) || fps <= 0) fps = 24;
    let sec = parseFloat(secIn);
    if (!isFinite(sec) || sec < 0) sec = 0;

    let n0 = Math.round(sec * fps);                     // 与后端 int(sec*fps + 0.5) 同口径（秒恒为正）
    let n;
    if (rule === RULE_H3) {
        n0 = Math.max(5, n0);
        n = n0 + pmod(5 - n0 % 17, 17);                 // H3：帧数 ≡ 5 (mod 17)，向上对齐
    } else if (rule === RULE_LTX) {
        n0 = Math.max(1, n0);
        n = Math.floor((n0 + 6) / 8) * 8 + 1;           // LTX：帧数 = 8k + 1，向上对齐
    } else {
        n = Math.max(1, n0);
    }
    n = Math.max(1, Math.floor(n));
    return { n, n0: Math.max(1, n0), secActual: n / fps, fps, sec };
}

/** 数字收紧显示：5 →「5」，5.1666 →「5.17」（不做 :g，避免模板串里出现非法表达式） */
function fmtNum(x, d) {
    if (!isFinite(x)) return "-";
    const s = Number(x).toFixed(d == null ? 0 : d);
    return s.replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
}

function refreshFrameAlign(node) {
    const sec = wNum(node, "seconds", 5);
    const rule = wStr(node, "rule");
    const fps = wNum(node, "fps", 24);
    const r = alignCount(sec, rule, fps);
    const zh = (window.XH_LANG || "zh") === "zh";
    const txt = zh
        ? `${fmtNum(r.sec, 2)} 秒 × ${fmtNum(r.fps, 2)} 帧/秒 ${T(node, "faArrow")} `
            + `${r.n} ${T(node, "faFrames")}（实际 ${r.secActual.toFixed(2)} ${T(node, "faSec")}）`
        : `${fmtNum(r.sec, 2)} s x ${fmtNum(r.fps, 2)} ${T(node, "faFps")} ${T(node, "faArrow")} `
            + `${r.n} ${T(node, "faFrames")} (actual ${r.secActual.toFixed(2)}${T(node, "faSec")})`;
    // 规矩对得上就绿，没选规矩（不调整）就灰
    setInfo(node, txt, (rule === RULE_H3 || rule === RULE_LTX) ? "#4BA14B" : "#8a93a0");
}

// ---------------------------------------------------------------------------
// 🔁XH-分段拼接：数已接段数 + 校验开关
// ---------------------------------------------------------------------------
function connectedSegs(node) {
    let n = 0;
    for (const i of (node.inputs || [])) {
        if (!i) continue;
        if (/^images_\d+$/.test(i.name) && i.link != null) n++;
    }
    return n;
}

function refreshSegmentConcat(node) {
    const n = connectedSegs(node);
    const exp = Math.max(0, Math.round(wNum(node, "expected_frames", 0)));
    if (n <= 0) { setInfo(node, T(node, "scNone"), "#8a93a0"); return; }
    if (n === 1) { setInfo(node, T(node, "scOne"), "#1668b3"); return; }
    const head = `${n} ${T(node, "scSeg")}`;
    if (exp > 0) {
        setInfo(node, `${head}｜${T(node, "scCheckOn")}：${T(node, "scPerSeg")} ${exp} ${T(node, "faFrames")}`, "#4BA14B");
    } else {
        setInfo(node, `${head}｜${T(node, "scCheckOff")}`, "#d08a2a");
    }
}

function refreshInfo(node) {
    if (!node) return;
    if (node.type === "XHFrameAlign") refreshFrameAlign(node);
    else if (node.type === "XHSegmentConcat") refreshSegmentConcat(node);
}

// ---------------------------------------------------------------------------
// 语言
// ---------------------------------------------------------------------------
function applyComboValueLabels(node, lang) {
    if (!node || !node.widgets) return;
    const table = (XH_I18N[lang] && XH_I18N[lang].combo) || null;
    for (const w of node.widgets) {
        if (!w || w.type !== "combo" || !w.options) continue;
        const tb = table && table[w.name];
        if (tb) {
            w.options.getOptionLabel = (v) => (v == null ? "" : (tb[String(v)] || String(v)));
        } else {
            delete w.options.getOptionLabel;     // 中文态回落显示后端原值
        }
    }
}

function applyLang(node, lang) {
    if (!node) return;
    lang = lang || window.XH_LANG || "zh";
    try {
        const want = t(lang, "nodes", node.type);
        const zhT = XH_I18N.zh.nodes[node.type];
        const enT = XH_I18N.en.nodes[node.type];
        if (want && (!node.title || node.title === zhT || node.title === enT)) node.title = want;

        for (const w of (node.widgets || [])) {
            if (!w || !w.name) continue;
            const lb = t(lang, "widgets", w.name);
            if (lb) w.label = lb;
        }
        applyComboValueLabels(node, lang);

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

        refreshInfo(node);
        relayout(node);
    } catch (e) {
        console.warn("[XH VideoSegments] 应用语言失败:", e);
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

// ---------------------------------------------------------------------------
// 注册
// ---------------------------------------------------------------------------
app.registerExtension({
    name: "XH.VideoSegments",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (!NODE_TYPES.includes(nodeData.name)) return;

        const origOnCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = origOnCreated?.apply(this, arguments);
            try {
                const node = this;
                node._xhVS = {};

                // 标准工具条（中/EN + 🎨）—— 家族唯一实现见 web/xh_ui_kit.js
                const { bar, langBtn } = makeXHToolbar(node, { widgetName: BAR_WIDGET });
                node._xhLangBtn = langBtn;

                makeInfoBar(node);

                // 参数一改就重算信息条（包住原回调，绝不覆盖）
                for (const nm of ["seconds", "rule", "fps", "expected_frames"]) {
                    const wd = widget(node, nm);
                    if (!wd || wd._xhVSHooked) continue;
                    wd._xhVSHooked = true;
                    const orig = wd.callback;
                    wd.callback = function () {
                        const rr = orig ? orig.apply(this, arguments) : undefined;
                        refreshInfo(node);
                        return rr;
                    };
                }

                applyLang(node);
                refreshInfo(node);
            } catch (e) {
                console.warn("[XH VideoSegments] 界面创建失败:", e);
            }
            return r;
        };

        // 工作流载入 / 切换后：修 widgets 错位 + 重刷信息条
        const origOnConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (info) {
            const r = origOnConfigure?.apply(this, arguments);
            try {
                fixWidgetValuesFromSaved(this, info);
                refreshInfo(this);
            } catch (e) {}
            return r;
        };

        // 上游连上 / 断开：段数、被接管的 seconds/fps 都要立刻反映
        const origOnConnChange = nodeType.prototype.onConnectionsChange;
        nodeType.prototype.onConnectionsChange = function () {
            const rr = origOnConnChange ? origOnConnChange.apply(this, arguments) : undefined;
            try { refreshInfo(this); } catch (e) {}
            return rr;
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
