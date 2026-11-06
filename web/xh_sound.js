// 🔊XH-声音播放 · 家族前端
// ① 中/EN 四处覆盖：节点标题 + 参数标签 + 输入/输出端口名 + 下拉选项文字
// ② 工具条：中/EN + 🎨 + ▶️试听 + ⏹停止 + 🔄重扫音效库（家族唯一实现见 web/xh_ui_kit.js）
// ③ 玩法：后端把「放什么 / 多大声 / 何时放 / 是否掐上一声 / 是否循环」经 ui 字段回传，
//    这里 new Audio() 播放
//
// 🔴 循环播放（loop）的三条命门 —— 改这个文件前必读：
//   · audio.loop = true 之后**没有终点**，必须有地方能停，否则用户只能刷新页面；
//   · 所以工具条上必须有 ⏹；且「再跑一次工作流」也要能把上一轮的循环掐掉（监听 execution_start）；
//   · 播放中的 Audio 按**节点 id** 分开存（PLAYING Map）——
//     单例变量会让「A 节点放循环音乐、B 节点响一声」时把 A 掐死，
//     而「先掐掉上一声」的 tooltip 说的是「只掐本节点自己上一次放的那一声」，单例与说明不符。
//
// 铁律：只改 label / title，绝不改 name；绝不改 COMBO 的 values；工具条只 append 不 unshift。
const { app } = window.comfyAPI.app;

import { ensureLangBridge, makeXHToolbar, applyComboLabels, onLangChanged, releaseButtons , paintBarBtn} from "./xh_ui_kit.js";

ensureLangBridge();

const NODE_TYPE = "XHSoundPlayer";
// 用 import.meta.url 推导扩展根，别硬编码包名（包改名也不用动这里）
const SOUND_BASE = new URL("./", import.meta.url).href; // -> /extensions/<包名>/

const XH_I18N = {
    zh: {
        nodes: { XHSoundPlayer: "🔊XH-声音播放" },
        widgets: {
            file: "音效文件",
            volume: "音量",
            mode: "播放时机",
            stop_previous: "先掐掉上一声",
            loop: "循环播放",
        },
        slots: { any: "任意信号", info: "信息" },
    },
    en: {
        nodes: { XHSoundPlayer: "XH Sound Player" },
        widgets: {
            file: "sound file",
            volume: "volume",
            mode: "when",
            stop_previous: "stop previous",
            loop: "loop",
        },
        slots: { any: "any", info: "info" },
    },
};

const COMBO_LABELS = {
    mode: { always: "立即播放", "on empty queue": "队列跑完再播" },
};

// 分类目录 -> 中文名（下拉里显示成「提示音 · 叮」）
const CAT_ZH = { ui: "提示音", sfx: "音效", music: "音乐", voice: "人声" };

function t(lang, kind, key) {
    const pack = XH_I18N[lang] || XH_I18N.zh;
    return (pack[kind] && pack[kind][key]) || null;
}

// "sfx/嗖.wav" -> "音效 · 嗖"
function fileLabel(v) {
    if (v == null) return "";
    const s = String(v);
    const i = s.indexOf("/");
    if (i < 0) return s; // "(音效库为空 · 见 tooltip)" 这类原样
    const cat = s.slice(0, i);
    const name = s.slice(i + 1).replace(/\.[^.]+$/, "");
    return (CAT_ZH[cat] || cat) + " · " + name;
}

function applyFileLabels(node, zh) {
    const w = (node.widgets || []).find((x) => x && x.name === "file");
    if (!w || !w.options) return;
    if (zh) {
        w.options.getOptionLabel = (v) => fileLabel(v);
    } else {
        try { delete w.options.getOptionLabel; } catch (e) {}
    }
}

function applyLang(node, lang) {
    if (!node) return;
    lang = lang || window.XH_LANG || "zh";
    const zh = lang === "zh";
    try {
        const want = t(lang, "nodes", NODE_TYPE);
        const zhT = XH_I18N.zh.nodes[NODE_TYPE];
        const enT = XH_I18N.en.nodes[NODE_TYPE];
        if (want && (!node.title || node.title === zhT || node.title === enT)) node.title = want;

        for (const w of node.widgets || []) {
            if (!w || !w.name) continue;
            const lb = t(lang, "widgets", w.name);
            if (lb) w.label = lb;
        }
        applyComboLabels(node, lang, COMBO_LABELS);
        applyFileLabels(node, zh);

        const applySlots = (arr) => {
            for (const s of arr || []) {
                if (!s) continue;
                const lb = t(lang, "slots", s.name);
                if (lb) s.label = lb;
            }
        };
        applySlots(node.inputs);
        applySlots(node.outputs);

        // 工具条上 ▶️ / ⏹ / 🔄 的 hover 提示也跟着语言走
        try {
            const b = node._xhSoundBtns;
            if (b) {
                const tips = {
                    0: zh ? "试听当前选中的音效（不跑工作流）" : "Preview the selected sound (no workflow run)",
                    1: zh ? "停止正在播放的声音（循环播放时用它停）" : "Stop the sound that is playing",
                    2: zh ? "重扫音效库：加了新音频后点它（会刷新页面）" : "Rescan the sound library (reloads the page)",
                };
                b.forEach((el, i) => { if (el && tips[i]) el.title = tips[i]; });
            }
        } catch (e) {}

        try {
            node.graph?.trigger?.("node:slot-label:changed", { nodeId: node.id, slotType: 1 });
            node.graph?.trigger?.("node:slot-label:changed", { nodeId: node.id, slotType: 2 });
        } catch (e) {}
        try { node.setDirtyCanvas?.(true, true); } catch (e) {}
    } catch (e) {
        console.warn("[XH Sound] 应用语言失败:", e);
    }
}

function nodesOfType() {
    try {
        return (app.graph?.nodes || app.graph?._nodes || []).filter((n) => n && n.type === NODE_TYPE);
    } catch (e) { return []; }
}

function applyLangToAll() {
    const lang = window.XH_LANG || "zh";
    for (const n of nodesOfType()) applyLang(n, lang);
    try { app.graph?.setDirtyCanvas?.(true, true); } catch (e) {}
}

// ---------------- 播放 ----------------
// 按节点分开存正在播的 Audio（见文件头「命门 ③」）
const PLAYING = new Map(); // nodeId -> Audio

function stopBtnPaint(node, active) {
    const b = node && node._xhStopBtn;
    if (!b) return;
    // 方案 B：播放中 = danger 红实心，停着 = neutral 暗底（原#c0392b/#0f3460 两套色）
    paintBarBtn(b, active ? "danger" : "neutral");
    b.style.background = b._baseBg;
}

function stopSound(node) {
    if (!node) return;
    const a = PLAYING.get(node.id);
    if (a) {
        try { a.pause(); } catch (e) {}
        PLAYING.delete(node.id);
    }
    stopBtnPaint(node, false);
}

function stopAll() {
    for (const n of nodesOfType()) {
        const a = PLAYING.get(n.id);
        if (a) { try { a.pause(); } catch (e) {} }
        PLAYING.delete(n.id);
        stopBtnPaint(n, false);
    }
    // 兜底：节点已被删掉的残留
    for (const [, a] of PLAYING) { try { a.pause(); } catch (e) {} }
    PLAYING.clear();
}

function playSound(node, rel, vol, stop, loop) {
    try {
        if (!rel) return;
        if (stop && node) {
            const prev = PLAYING.get(node.id);
            if (prev) {
                try { prev.pause(); } catch (e) {}
                PLAYING.delete(node.id);
            }
        }
        const url = SOUND_BASE + "sounds/" + String(rel).split("/").map(encodeURIComponent).join("/");
        const audio = new Audio(url);
        audio.volume = Math.min(1, Math.max(0, Number(vol) || 0));
        audio.loop = !!loop; // ★ 循环开关就落在这一行
        if (node) PLAYING.set(node.id, audio);
        audio.addEventListener("ended", () => {
            if (node && PLAYING.get(node.id) === audio) {
                PLAYING.delete(node.id);
                stopBtnPaint(node, false);
            }
        });
        const p = audio.play();
        if (node) stopBtnPaint(node, true);
        if (p && typeof p.catch === "function") {
            p.catch((e) => {
                // 浏览器拦自动播放：把 ⏹ 恢复成「没在响」，否则按钮一直红着骗人
                if (node && PLAYING.get(node.id) === audio) {
                    PLAYING.delete(node.id);
                    stopBtnPaint(node, false);
                }
                console.warn("[XH Sound] 浏览器拦下了自动播放，点一下页面任意处再试：", e);
            });
        }
    } catch (e) {
        console.warn("[XH Sound] 播放失败:", e);
    }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function playFromNode(node, rel, vol, mode, stop, loop) {
    // 「队列跑完再播」：等一会儿再确认一次队列确实空了
    if (mode === "on empty queue") {
        if (app.ui?.lastQueueSize !== 0) await sleep(500);
        if (app.ui?.lastQueueSize !== 0) return;
    }
    playSound(node, rel, vol, stop, loop);
}

function widgetValue(node, name) {
    const w = (node.widgets || []).find((x) => x && x.name === name);
    return w ? w.value : undefined;
}

// ---------------- 小按钮（家族规格：h22 / 深蓝底 / 亮蓝 hover）----------------
function miniBtn(text, tip) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = text;
    b.title = tip;

    b.style.cssText =
        "background:#262d38;color:#d5dde5;border:1px solid rgba(255,255,255,.10);border-radius:4px;" +
        "height:22px;min-width:26px;padding:0 9px;font-size:12px;font-weight:600;line-height:1;" +
        "cursor:pointer;display:flex;align-items:center;justify-content:center;flex:0 0 auto;";
    b.addEventListener("pointerdown", (e) => e.stopPropagation(), true);
    b.addEventListener("mouseenter", () => { b.style.filter = "brightness(1.28)"; });
    b.addEventListener("mouseleave", () => { b.style.filter = "none"; });
    return b;
}

// ---------------- 再跑一次时，把上一轮的循环掐掉 ----------------
// 不这么做：上一轮的音乐还在响，新的要等整条链跑完才盖上去，中间这段会很乱。
function hookQueueStart() {
    const api = (() => {
        try { if (window.comfyAPI?.api?.api) return window.comfyAPI.api.api; } catch (e) {}
        try { if (app?.api?.addEventListener) return app.api; } catch (e) {}
        try { if (window.api?.addEventListener) return window.api; } catch (e) {}
        return null;
    })();
    if (!api || api.__xhSoundHooked) return;
    try {
        api.addEventListener("execution_start", () => stopAll());
        api.__xhSoundHooked = true;
    } catch (e) {
        console.warn("[XH Sound] 监听 execution_start 失败（循环音乐将不会自动停）:", e);
    }
}

app.registerExtension({
    name: "XH.SoundPlayer",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_TYPE) return;

        // ③ 后端执行完 -> 播
        const origExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (message) {
            origExecuted?.apply(this, arguments);
            try {
                const d = message?.xh_sound;
                if (!d || !d.length) return;
                const [rel, vol, mode, stop, loop] = d;
                playFromNode(this, rel, vol, mode, stop, loop);
            } catch (e) {
                console.warn("[XH Sound] 处理执行结果失败:", e);
            }
        };

        const origOnCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = origOnCreated?.apply(this, arguments);
            const node = this;
            try {
                const previewBtn = miniBtn("▶️", "试听当前选中的音效（不跑工作流）");
                previewBtn.addEventListener("click", (e) => {
                    e.stopPropagation();
                    // 试听也按当前「循环播放」设置走 —— 所见即所得，勾了循环就能听到循环效果
                    playSound(node, widgetValue(node, "file"), widgetValue(node, "volume"),
                              true, !!widgetValue(node, "loop"));
                });

                const stopBtn = miniBtn("⏹", "停止正在播放的声音（循环播放时用它停）");
                stopBtn.addEventListener("click", (e) => {
                    e.stopPropagation();
                    stopSound(node);
                });
                node._xhStopBtn = stopBtn;

                const rescanBtn = miniBtn("🔄", "重扫音效库：加了新音频后点它（会刷新页面）");
                rescanBtn.addEventListener("click", (e) => {
                    e.stopPropagation();
                    location.reload();
                });

                node._xhSoundBtns = [previewBtn, stopBtn, rescanBtn];

                const { langBtn } = makeXHToolbar(this, {
                    widgetName: "xh_sound_bar",
                    appendNodes: [previewBtn, stopBtn, rescanBtn],
                });
                this._xhLangBtn = langBtn;

                hookQueueStart();
                applyLang(this);
            } catch (e) {
                console.warn("[XH SoundPlayer] 工具栏创建失败:", e);
            }
            return r;
        };

        const origOnRemoved = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function () {
            try { stopSound(this); } catch (e) {}
            releaseButtons(this);
            return origOnRemoved?.apply(this, arguments);
        };
    },

    async setup() {
        hookQueueStart();
        onLangChanged(() => applyLangToAll());
    },
});
