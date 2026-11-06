// XH-LoRA堆栈 前端 —— Nodes 2.0 原生 DOM UI
// 设计铁律（全部源自 frontend_n2.md 已验证的坑）：
// 1. UI 全部走 addDOMWidget，绝不 canvas 手画
// 2. 行的增删只在自己的 DOM 内部，绝不增删/重排 node.widgets
// 3. 数据唯一载体是后端声明的标准 STRING widget（loras_json），存档/执行走官方链路
const { app } = window.comfyAPI.app;

import { ensureLangBridge, makeXHToolbar, releaseButtons } from "./xh_ui_kit.js";

ensureLangBridge();
const { api } = window.comfyAPI.api;
const NODE_TYPE = "XHPowerLoraStack";
// 2026-10-02：新增纯 LoRA 堆栈（只有 MODEL 口，不碰 CLIP），与完整版共用这一整套 DOM UI。
// 两者前端逻辑完全一样，唯一差异是「强度」提示文案（纯版只作用 model）。
const NODE_TYPE_PURE = "XHPureLoraStack";
const NODE_TYPES = new Set([NODE_TYPE, NODE_TYPE_PURE]);
const isPureType = (t) => t === NODE_TYPE_PURE;
const LANG_KEY = "xh_node_lang";

const I18N = {
    zh: {
        add: "➕ 添加 LoRA",
        toggleAllOn: "👁 全部启用",
        toggleAllOff: "🚫 全部停用",
        strength: "强度",
        empty: "还没有 LoRA，点上面「➕ 添加 LoRA」",
        titleSuffix: "",
        loadFail: "LoRA 列表加载失败",
    },
    en: {
        add: "➕ Add LoRA",
        toggleAllOn: "👁 Enable All",
        toggleAllOff: "🚫 Disable All",
        strength: "Strength",
        empty: "No LoRA yet — click \"➕ Add LoRA\" above",
        titleSuffix: "",
        loadFail: "Failed to load LoRA list",
    },
};

// ---- 与 XH 家族的语言状态桥接 ----
// 家族包（XH_Toolbox / H3MemorySaver …）用全局变量 window.XH_LANG 存语言态。
// 这里把它包成 getter/setter：家族那边一改，我们这边立刻收到通知刷新 UI（双向联动）。

function getLang() {
    try { return (window.XH_LANG === "en" || localStorage.getItem(LANG_KEY) === "en") ? "en" : "zh"; } catch (e) { return "zh"; }
}
function setLang(l) {
    window.XH_LANG = l; // 走 setter：写 localStorage + 通知全家族（含本包所有实例）
}

// ---- 节点配色 ----
// 原则：1) 不重复官方那 9 个低饱和色（红/棕、绿/青难分辨）
//      2) 12 色按色环均匀分布，相邻色相拉得开
//      3) 亮度/饱和度统一，白字标题压得住
//      4) 10 彩色 + 2 中性（棕/灰用于「次要/备份」类节点）

// ---- LoRA 文件列表（后端路由，带缓存）----
let _loraListPromise = null;
function fetchLoraList() {
    if (_loraListPromise) return _loraListPromise;
    _loraListPromise = api.fetchApi("/xh_lorastack/loras")
        .then((r) => r.json())
        .then((d) => (d && Array.isArray(d.loras)) ? d.loras : [])
        .catch(() => []);
    return _loraListPromise;
}

// ---- 样式（一次注入）----
let _styleInjected = false;
function injectStyle() {
    if (_styleInjected) return;
    _styleInjected = true;
    const css = `
    .xh-pll-root{display:flex;flex-direction:column;gap:4px;padding:6px;width:100%;
        box-sizing:border-box;font-family:sans-serif;font-size:12px;color:inherit;}
    .xh-pll-toolbar{display:flex;gap:4px;align-items:center;}
    .xh-pll-toolbar .spacer{flex:1;}
    /* 方案 B：暗蓝 #0f3460 + bold → 暗底 #262d38 + 1px 半透明白描边 + 字重 600（全家族唯一规格） */
    .xh-pll-toolbar button{border:1px solid rgba(255,255,255,.10);border-radius:4px;padding:3px 8px;
        font-size:11px;font-weight:600;cursor:pointer;color:#d5dde5;background:#262d38;}
    .xh-pll-toolbar button:hover{filter:brightness(1.28);border-color:rgba(255,255,255,.20);}
    /* 新增行 = 主操作 → primary 蓝实心 */
    .xh-pll-toolbar button.xh-pll-btn-green{background:#1668b3;border-color:rgba(255,255,255,.16);
        color:#fff;font-weight:700;}
    /* 破坏性 → danger 红实心（用户拍板保留红）*/
    .xh-pll-toolbar button.xh-pll-btn-red{background:#a63232;border-color:rgba(255,255,255,.22);
        color:#fff;font-weight:700;}
    .xh-pll-lang{width:36px;height:22px;padding:0!important;font-size:12px!important;
        border:1px solid rgba(255,255,255,.10)!important;color:#d5dde5;font-weight:600;}
    .xh-pll-rows{display:flex;flex-direction:column;gap:4px;}
    .xh-pll-row{display:flex;gap:4px;align-items:center;background:rgba(127,127,127,.15);
        border:1px solid rgba(0,0,0,.25);border-radius:4px;padding:3px 4px;}
    .xh-pll-row input[type=checkbox]{width:14px;height:14px;cursor:pointer;flex:none;}
    .xh-pll-row select{flex:1;min-width:0;font-size:11px;padding:2px;border-radius:3px;
        border:1px solid rgba(0,0,0,.3);background:#1f1f1f;color:#e8e8e8;cursor:pointer;}
    .xh-pll-row select option{background:#1f1f1f;color:#e8e8e8;}
    .xh-pll-combo{flex:1;min-width:0;display:flex;}
    .xh-pll-combo input{flex:1;min-width:0;font-size:11px;padding:2px 4px;border-radius:3px;
        border:1px solid rgba(0,0,0,.3);background:#1f1f1f;color:#e8e8e8;cursor:text;}
    .xh-pll-combo input:focus{border-color:#2980b9;outline:none;}
    .xh-pll-combo input::placeholder{color:#6b7683;}
    .xh-pll-combo-list{position:fixed;z-index:99999;background:#1a1f26;border:1px solid #3d4652;
        border-radius:4px;max-height:220px;overflow-y:auto;box-shadow:0 6px 16px rgba(0,0,0,.55);
        scrollbar-width:thin;}
    .xh-pll-combo-item{padding:4px 8px;font-size:11px;color:#dfe5ec;cursor:pointer;
        white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
    .xh-pll-combo-item.act{background:#2980b9;color:#fff;}
    .xh-pll-combo-item:hover:not(.none){background:#2980b9;color:#fff;}
    .xh-pll-combo-item.none{opacity:.5;cursor:default;}
    .xh-pll-row input[type=number]{width:64px;flex:none;font-size:11px;padding:2px;border-radius:3px;
        border:1px solid rgba(0,0,0,.3);background:#1f1f1f;color:#e8e8e8;}
    .xh-pll-st{flex:none;display:flex;align-items:center;gap:2px;}
    .xh-pll-st-inp{width:50px;flex:none;font-size:11px;padding:2px 3px;border-radius:3px;text-align:right;
        border:1px solid rgba(0,0,0,.3);background:#1f1f1f;color:#e8e8e8;cursor:text;}
    .xh-pll-st-inp:focus{border-color:#2980b9;outline:none;}
    .xh-pll-st-step{display:flex;flex-direction:column;gap:1px;}
    .xh-pll-st-step button{width:19px;height:14px;font-size:8px;line-height:1;padding:0;border:none;
        border-radius:2px;cursor:pointer;background:#2b3440;color:#cfd8e3;display:flex;align-items:center;
        justify-content:center;transition:background .15s,color .15s;}
    .xh-pll-st-step button:active{background:#2f3946;color:#fff;border-color:rgba(255,255,255,.20);}
    .xh-pll-st-step button:hover{background:#2f3946;color:#fff;border-color:rgba(255,255,255,.20);}
    .xh-pll-row .del{flex:none;width:24px;height:24px;border:1px solid rgba(255,255,255,.18);
        border-radius:4px;cursor:pointer;display:flex;align-items:center;justify-content:center;
        padding:0;background:rgba(0,0,0,.3);color:#c8c8c8;line-height:1;transition:all .15s;}
    /* 删除：常态中性（不抢戏），hover 才泛红 —— 破坏性语义用 hover 表达，不占常态视觉 */
    .xh-pll-row .del:hover{background:#a63232;border-color:rgba(255,255,255,.22);color:#fff;}
    .xh-pll-row .del svg{display:block;}
    .xh-pll-row.off{opacity:.45;}
    .xh-pll-empty{opacity:.5;font-size:11px;text-align:center;padding:4px;}
    .xh-pll-palette{display:flex;flex-wrap:wrap;gap:6px;align-items:center;
        background:rgba(127,127,127,.12);border:1px solid rgba(0,0,0,.25);border-radius:4px;padding:6px 8px;}
    .xh-pll-palette .dot{width:20px;height:20px;border-radius:50%;cursor:pointer;padding:0;
        border:2px solid rgba(255,255,255,.22);transition:transform .1s,border-color .1s;}
    .xh-pll-palette .dot:hover{transform:scale(1.2);border-color:#fff;}
    .xh-pll-palette .dot.cur{border-color:#fff;box-shadow:0 0 0 2px rgba(255,255,255,.4);}
    .xh-pll-palette .reset{border:none;border-radius:4px;padding:2px 8px;font-size:11px;cursor:pointer;
        color:#eee;background:rgba(0,0,0,.35);}
    .xh-pll-palette .reset:hover{background:#555;}
    `;
    const el = document.createElement("style");
    el.textContent = css;
    document.head.appendChild(el);
}

function makeRowEl(row, ctx) {
    const rowEl = document.createElement("div");
    rowEl.className = "xh-pll-row" + (row.on ? "" : " off");

    const on = document.createElement("input");
    on.type = "checkbox";
    on.checked = !!row.on;
    on.title = ctx.lang === "zh" ? "启用/停用" : "On / Off";
    on.addEventListener("change", () => {
        row.on = on.checked;
        rowEl.className = "xh-pll-row" + (row.on ? "" : " off");
        ctx.sync();
    });

    // —— 可搜索 LoRA 下拉：输入框 + 关键词实时过滤 + 锚定面板（替代原生 select 的"飘"）——
    const combo = document.createElement("div");
    combo.className = "xh-pll-combo";
    const inp = document.createElement("input");
    inp.type = "text";
    inp.value = row.lora || "";
    inp.placeholder = ctx.lang === "zh" ? "🔍 输入关键词筛 LoRA" : "🔍 type to filter";
    inp.title = row.lora || "";
    inp.addEventListener("pointerdown", (e) => e.stopPropagation(), true);
    combo.appendChild(inp);

    let listEl = null, items = [], actIdx = -1;
    const closeList = () => {
        if (listEl) { listEl.remove(); listEl = null; items = []; actIdx = -1; }
        document.removeEventListener("pointerdown", onDoc, true);
    };
    const pick = (f) => {
        row.lora = f;
        inp.value = f; inp.title = f;
        closeList();
        ctx.sync();
    };
    const onDoc = (e) => {
        if (listEl && !listEl.contains(e.target) && e.target !== inp) closeList();
    };
    const openList = () => {
        closeList();
        const kw = inp.value.trim().toLowerCase();
        listEl = document.createElement("div");
        listEl.className = "xh-pll-combo-list";
        fetchLoraList().then((list) => {
            if (!listEl) return; // 面板已被关掉
            const hits = kw ? list.filter((f) => f.toLowerCase().includes(kw)) : list;
            if (hits.length === 0) {
                const d = document.createElement("div");
                d.className = "xh-pll-combo-item none";
                d.textContent = ctx.lang === "zh" ? "（无匹配）" : "(no match)";
                listEl.appendChild(d);
            }
            hits.forEach((f, i) => {
                const d = document.createElement("div");
                d.className = "xh-pll-combo-item" + (i === 0 ? " act" : "");
                d.textContent = f; d.title = f;
                d.dataset.f = f;
                d.addEventListener("pointerdown", (e) => e.stopPropagation(), true);
                d.addEventListener("click", (e) => { e.stopPropagation(); pick(f); });
                listEl.appendChild(d); items.push(d);
            });
            actIdx = hits.length ? 0 : -1;
            const r = inp.getBoundingClientRect();
            listEl.style.left = r.left + "px";
            listEl.style.top = (r.bottom + 2) + "px";
            listEl.style.minWidth = Math.max(r.width, 240) + "px";
            document.body.appendChild(listEl);
            setTimeout(() => document.addEventListener("pointerdown", onDoc, true), 0);
        });
    };
    inp.addEventListener("focus", openList);
    inp.addEventListener("input", openList);
    // 失焦还原：没选中就恢复成已选的 LoRA 名（不把搜索词当文件名存进去）
    inp.addEventListener("blur", () => {
        setTimeout(() => {
            if (listEl) return; // 面板还开着（正要点选项），不动
            if (inp.value !== (row.lora || "")) inp.value = row.lora || "";
        }, 140);
    });
    inp.addEventListener("keydown", (e) => {
        if (!listEl) {
            if (e.key === "Enter" || e.key === "ArrowDown") { e.preventDefault(); openList(); }
            return;
        }
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            if (!items.length) return;
            actIdx = (actIdx + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
            items.forEach((d, i) => d.classList.toggle("act", i === actIdx));
            items[actIdx].scrollIntoView({ block: "nearest" });
        } else if (e.key === "Enter") {
            e.preventDefault();
            if (items[actIdx]) pick(items[actIdx].dataset.f);
        } else if (e.key === "Escape") {
            e.preventDefault();
            closeList();
        }
    });

    // —— 强度：手输 + ▲▼ 步进 0.1（Shift = ±1.0），长按连调 ——
    // 不用原生 <input type=number>：它的上下箭头是系统控件，又小又容易误触（就是"不稳当"的来源）
    const stWrap = document.createElement("div");
    stWrap.className = "xh-pll-st";
    const st = document.createElement("input");
    st.type = "text";
    st.inputMode = "decimal";
    st.className = "xh-pll-st-inp";
    st.value = Number(row.strength != null ? row.strength : 1).toFixed(2);
    st.title = ctx.pure
        ? (ctx.lang === "zh" ? "强度（只作用模型，不碰 CLIP）｜可直接输入，▲▼ 步进 0.1，Shift 点 = 1.0"
                            : "Strength (model only — CLIP untouched) | type freely, ▲▼ step 0.1, Shift = 1.0")
        : (ctx.lang === "zh" ? "强度（model 与 clip 共用）｜可直接输入，▲▼ 步进 0.1，Shift 点 = 1.0"
                            : "Strength (model & clip) | type freely, ▲▼ step 0.1, Shift = 1.0");
    st.addEventListener("pointerdown", (e) => e.stopPropagation(), true);

    const commit = (raw) => {
        let v = parseFloat(raw);
        if (isNaN(v)) v = 1.0;
        v = Math.max(-4, Math.min(4, v));
        v = Math.round(v * 100) / 100;   // 两位小数，避免 0.30000000000000004
        row.strength = v;
        st.value = v.toFixed(2);
        ctx.sync();
    };
    const cur = () => {
        const n = parseFloat(st.value);
        return isNaN(n) ? 1.0 : n;
    };
    st.addEventListener("change", () => commit(st.value));
    st.addEventListener("blur", () => commit(st.value));
    st.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); commit(st.value); st.blur(); }
        else if (e.key === "ArrowUp") { e.preventDefault(); commit(cur() + (e.shiftKey ? 1.0 : 0.1)); }
        else if (e.key === "ArrowDown") { e.preventDefault(); commit(cur() - (e.shiftKey ? 1.0 : 0.1)); }
    });

    const stStep = document.createElement("div");
    stStep.className = "xh-pll-st-step";
    const mkStepBtn = (dir) => {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = dir > 0 ? "▲" : "▼";
        b.title = ctx.lang === "zh"
            ? "强度微调：点一下 ±0.1（Shift+点 = ±1.0），按住不放连调"
            : "Fine-tune: click ±0.1 (Shift+click = ±1.0), hold to repeat";
        const apply = (ev) => commit(cur() + dir * (ev && ev.shiftKey ? 1.0 : 0.1));
        let delay = null, rep = null, pressed = false;
        const stopRep = () => { clearTimeout(delay); clearInterval(rep); delay = rep = null; };
        b.addEventListener("pointerdown", (e) => {
            e.stopPropagation(); e.preventDefault();
            pressed = true;
            apply(e);
            try { b.setPointerCapture(e.pointerId); } catch (_) {} // 松手一定落回本按钮（哪怕移出窗口）
            delay = setTimeout(() => {
                rep = setInterval(() => {
                    if (!pressed) { stopRep(); return; }               // 自愈保险丝：不在按下态立刻停
                    apply(e);
                }, 90);
            }, 400);                                                    // 按住 0.4s 后连调
        });
        const release = () => { pressed = false; stopRep(); };
        b.addEventListener("pointerup", (e) => { e.stopPropagation(); release(); });
        b.addEventListener("pointercancel", release);
        b.addEventListener("lostpointercapture", release);
        b.addEventListener("pointerleave", release);
        window.addEventListener("blur", release);
        ["mousedown", "dblclick", "click"].forEach((ev) =>
            b.addEventListener(ev, (e) => e.stopPropagation()));
        return b;
    };
    stStep.appendChild(mkStepBtn(1));
    stStep.appendChild(mkStepBtn(-1));
    // ⚠️ 必须用冒泡阶段（不传 true）：捕获阶段会在按钮之前触发，stopPropagation 会把按钮自己的
    //    pointerdown 一起掐掉 → ▲▼ 完全失效（2026-10-09 踩过）。家族 xh_label.js 也是冒泡写法。
    stStep.addEventListener("pointerdown", (e) => e.stopPropagation());
    stStep.addEventListener("dblclick", (e) => e.stopPropagation());
    stWrap.appendChild(st);
    stWrap.appendChild(stStep);

    const del = document.createElement("button");
    del.type = "button";
    del.className = "del";
    // 矢量垃圾桶（比 emoji 清晰、显眼），悬停变红
    del.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>`;
    del.title = ctx.lang === "zh" ? "删除这一行" : "Remove";
    del.addEventListener("pointerdown", (e) => e.stopPropagation(), true);
    del.addEventListener("click", (e) => {
        e.stopPropagation();
        ctx.rows.splice(ctx.rows.indexOf(row), 1);
        ctx.renderAll();
        ctx.sync();
    });

    rowEl.appendChild(on);
    rowEl.appendChild(combo);
    rowEl.appendChild(stWrap);
    rowEl.appendChild(del);
    return rowEl;
}

function buildUI(node) {
    injectStyle();

    const ctx = {
        lang: getLang(),
        // 纯 LoRA 堆栈：强度只喂 model，clip 侧完全不参与 → 提示文案不同
        pure: isPureType(node?.type),
        rows: [],
        root: null,
        rowsBox: null,
        emptyHint: null,
        toggleAllBtn: null,
        addBtn: null,
        jsonWidget: null,
    };

    const root = document.createElement("div");
    root.className = "xh-pll-root";

    const toggleAllBtn = document.createElement("button");
    toggleAllBtn.type = "button";
    toggleAllBtn.addEventListener("pointerdown", (e) => e.stopPropagation(), true);
    toggleAllBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const allOn = ctx.rows.length > 0 && ctx.rows.every((r) => r.on);
        for (const r of ctx.rows) r.on = !allOn;
        ctx.renderAll();
        ctx.sync();
    });

    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.addEventListener("pointerdown", (e) => e.stopPropagation(), true);
    addBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        ctx.rows.push({ on: true, lora: "", strength: 1.0 });
        ctx.renderAll();
        ctx.sync();
    });

    // 工具条（中/EN + 🎨 + 全开/关 + 新增行）—— 家族唯一实现见 web/xh_ui_kit.js
    const { bar: toolbar } = makeXHToolbar(node, {
        mount: false,                          // 条要嵌进本节点自己的 root，不单独占一个 widget
        appendNodes: [toggleAllBtn, addBtn],
    });
    toolbar.classList.add("xh-pll-toolbar");   // 保留本文件给自定义按钮的皮肤（.xh-pll-toolbar button）

    const rowsBox = document.createElement("div");
    rowsBox.className = "xh-pll-rows";
    const emptyHint = document.createElement("div");
    emptyHint.className = "xh-pll-empty";

    root.appendChild(toolbar);
    root.appendChild(rowsBox);
    root.appendChild(emptyHint);

    ctx.root = root;
    ctx.rowsBox = rowsBox;
    ctx.emptyHint = emptyHint;
    ctx.toggleAllBtn = toggleAllBtn;
    ctx.addBtn = addBtn;

    // 工具条按钮上色：红 = 停用类动作（警示）、绿 = 添加/启用类动作（家族风）
    const paintToolbar = () => {
        const t = I18N[ctx.lang];
        const anyOn = ctx.rows.some((r) => r.on);
        toggleAllBtn.textContent = anyOn ? t.toggleAllOff : t.toggleAllOn;
        toggleAllBtn.className = "xh-pll-btn-" + (anyOn ? "red" : "green");
        addBtn.textContent = t.add;
        addBtn.className = "xh-pll-btn-green";
    };

    ctx.renderAll = function () {
        ctx.rowsBox.innerHTML = "";
        for (const r of ctx.rows) ctx.rowsBox.appendChild(makeRowEl(r, ctx));
        const t = I18N[ctx.lang];
        emptyHint.textContent = ctx.rows.length === 0 ? t.empty : "";
        paintToolbar();
        // 高度随行数变化，通知节点重算布局
        try { node.onResize?.(); node.setDirtyCanvas?.(true, true); } catch (e) {}
    };

    ctx.sync = function () {
        if (!ctx.jsonWidget) return;
        ctx.jsonWidget.value = JSON.stringify(ctx.rows);
    };

    ctx.loadFromJson = function (txt) {
        let arr = [];
        try { arr = JSON.parse(txt || "[]"); } catch (e) { arr = []; }
        if (!Array.isArray(arr)) arr = [];
        ctx.rows = arr
            .filter((x) => x && typeof x === "object")
            .map((x) => ({
                on: !!x.on,
                lora: String(x.lora || ""),
                strength: Number(x.strength != null ? x.strength : 1),
            }));
        ctx.renderAll();
    };

    ctx.applyLang = function () {
        const t = I18N[ctx.lang];
        emptyHint.textContent = ctx.rows.length === 0 ? t.empty : "";
        paintToolbar();
    };

    window.addEventListener("xh:lang-changed", (e) => {
        ctx.lang = (e.detail && e.detail.lang) || getLang();
        ctx.applyLang();
        ctx.renderAll();
    });

    return ctx;
}

app.registerExtension({
    name: "XH.LoraStack",
    async beforeRegisterNodeDef(nodeType, nodeData, appArg) {
        if (!NODE_TYPES.has(nodeData.name)) return;

        const origOnNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = origOnNodeCreated?.apply(this, arguments);
            try {
                const ctx = buildUI(this);

                const w = this.addDOMWidget("xh_lorastack_ui", "custom", ctx.root, {
                    serialize: false,
                    hideOnZoom: false,
                    minWidth: 320,
                    minHeight: 46,
                    getMinHeight: () => 40 + ctx.rows.length * 30 + 10,
                    getHeight: () => 40 + ctx.rows.length * 30 + 10,
                });
                this._xhPllCtx = ctx;

                // 找到数据载体 widget（后端 STRING 输入自动生成），带延时重试
                const bind = () => {
                    const jw = (this.widgets || []).find((x) => x.name === "loras_json");
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
                console.error("[XH-LoRA堆栈] UI 构建失败", e);
            }
            return r;
        };

        // 加载存档：从 widgets_values[0] 恢复（不依赖 DOM widget 序列化）
        const origOnConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (info) {
            const r = origOnConfigure?.apply(this, arguments);
            try {
                const ctx = this._xhPllCtx;
                const raw = (info?.widgets_values || [])[0];
                if (ctx && typeof raw === "string") {
                    ctx.loadFromJson(raw);
                    const jw = (this.widgets || []).find((x) => x.name === "loras_json");
                    if (jw) {
                        jw.hidden = true;
                        if (jw.value !== raw) jw.value = raw;
                    }
                } else if (!ctx && typeof raw === "string") {
                    // DOM 还没建好（罕见时序），挂个临时值等 onNodeCreated 的 bind 兜底
                    this._xhPllPendingJson = raw;
                }
            } catch (e) {}
            return r;
        };

        // 兜底：画布节点加载完成后再刷一次（处理 configure 早于 UI 构建的时序）
        const origLoaded = nodeType.prototype.onLoadedGraphNode;
        nodeType.prototype.onLoadedGraphNode = function (event, info) {
            const r = origLoaded?.apply(this, arguments);
            try {
                const ctx = this._xhPllCtx;
                const raw = this._xhPllPendingJson ?? (info?.widgets_values || [])[0];
                if (ctx && typeof raw === "string") ctx.loadFromJson(raw);
                this._xhPllPendingJson = undefined;
            } catch (e) {}
            return r;
        };

        // 节点移除时把 langBtn 从 kit 的全局集合里摘掉，避免悬挂引用
        const origRemoved = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function () {
            releaseButtons(this);
            return origRemoved?.apply(this, arguments);
        };

        nodeType.prototype.onLoadedGraphNode = function (event, info) {
            const r = origLoaded?.apply(this, arguments);
            try {
                const ctx = this._xhPllCtx;
                const raw = this._xhPllPendingJson ?? (info?.widgets_values || [])[0];
                if (ctx && typeof raw === "string") ctx.loadFromJson(raw);
                this._xhPllPendingJson = undefined;
            } catch (e) {}
            return r;
        };

        // 标题本地化（只在还是默认名时改，不覆盖用户自定义标题）
        // 两个类共用这段代码，标题按当前注册的类名取
        const TITLES = nodeData.name === NODE_TYPE_PURE
            ? { zh: "🔁XH-纯LoRA堆栈", en: "🔁XH-Pure LoRA Stack" }
            : { zh: "🔁XH-LoRA堆栈", en: "🔁XH-LoRA Stack" };
        const origNC = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = origNC?.apply(this, arguments);
            const applyTitle = () => {
                const lang = getLang();
                if (!this.title || this.title === TITLES.zh || this.title === TITLES.en) {
                    this.title = lang === "zh" ? TITLES.zh : TITLES.en;
                }
            };
            applyTitle();
            this._xhTitleHandler = applyTitle;
            return r;
        };
        window.addEventListener("xh:lang-changed", (e) => {
            // 标题刷新在扩展层做（两个类的所有实例都要刷）
            for (const n of appArg.graph?._nodes || []) {
                if (NODE_TYPES.has(n.type) && n._xhTitleHandler) n._xhTitleHandler();
            }
        });
    },
});
