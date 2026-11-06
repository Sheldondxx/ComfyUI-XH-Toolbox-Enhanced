// 🎬XH-视频对比 · 前端实现（web/xh_video_compare.js）
// 2026-10-24 新增。复刻 comfyui-easy-media 的 Compare Videos 前端交互，XH 家族化：
//   · 多路网格同步播放（≤4 格，主从时钟）
//   · 三种模式：网格同播 / 单看大图 / 两两滑块对比
//   · 「📂 选择文件」弹层：input/temp/output 三目录扫盘多选（后端 /xh/videocompare/files）
//   · 差值信息条：每路 fps/帧数/时长 + 相对第 1 路的差值
//   · ⇄ 互换按钮（纯前端交换显示顺序，不动后端池）
//   · 家族标准：makeXHToolbar 工具条（中/EN + 🎨）/ 齿轮折叠 / lockDomWidgetHeight 锁高
//     / i18n 三表（标题 + 控件 + 端口）/ ensureLangBridge 语言桥
// ⚠️ 控件规范见 references/xh_style.md；DOM 锁高见 frontend_n2.md §13.7。
// ⚠️ 本文件 CRLF 行尾（与 web/ 目录一致）。

const { app } = window.comfyAPI.app;

import {
    ensureLangBridge, makeXHToolbar, onLangChanged, releaseButtons,
    lockDomWidgetHeight, makeGearBtn, forceCompactOnSpawn, currentLang,
} from "./xh_ui_kit.js";

ensureLangBridge();

const NODE_TYPE = "XHCompareVideos";
const MAX_CELLS = 4;
const FONT_STACK =
    '-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif';

// ---------------------------------------------------------------------------
// i18n 三表（标题 nodes / 控件 widgets / 端口 slots）—— 4B.1 缺一不可
// ---------------------------------------------------------------------------
const XH_I18N = {
    zh: {
        nodes: { [NODE_TYPE]: "🎬XH-视频对比" },
        widgets: {
            compare_video: "对比设置",
        },
        slots: {
            source: "源视频",
            output: "目标视频",
        },
        ui: {
            mode: "模式",
            modeGrid: "网格",
            modeSingle: "单看",
            modePair: "两两",
            layoutHorizontal: "排列：左右",
            layoutVertical: "排列：上下",
            layoutTip: "切换左右 / 上下排列；保存拼接视频时使用当前排列",
            labels: "标签 / 参数",
            labelsHint: "每路视频左上角标签（支持中文和换行，留空隐藏）",
            fontSize: "标签字号",
            outputPrefix: "保存文件前缀",
            saveHint: "开启后运行，将当前排列和标签保存为一个拼接 MP4",
            download: "下载拼接视频",
            pick: "选择文件",
            swap: "⇄ 互换",
            save: "保存",
            saving: "存盘中…",
            saved: "已存档",
            noInput: "没有可对比的视频\n\n接 source / output 口，或点「📂 选择文件」多选",
            loading: "加载中…",
            dirInput: "输入目录",
            dirTemp: "临时目录",
            dirOutput: "输出目录",
            pickOk: "确定",
            pickCancel: "取消",
            pickUp: "上移",
            pickDown: "下移",
            pickEmpty: "这个目录里没有视频文件",
            pickHint: "已接线 {wired} 路，还可选 {remaining} 个文件（总共最多 4 路）",
            infoBar: "信息",
            cell: "路",
            framesDiff: "帧差",
            durDiff: "时长差",
            base: "基准",
            truncated: "入池视频超过 4 个，只取前 4 个",
            fps: "帧率",
            frames: "帧数",
            dur: "时长",
            saveOn: "保存输出：开",
            saveOff: "保存输出：关",
        },
    },
    en: {
        nodes: { [NODE_TYPE]: "🎬XH-Video Compare" },
        widgets: {
            compare_video: "Compare Settings",
        },
        slots: {
            source: "Source",
            output: "Output",
        },
        ui: {
            mode: "Mode",
            modeGrid: "Grid",
            modeSingle: "Single",
            modePair: "Pair",
            layoutHorizontal: "Layout: Horizontal",
            layoutVertical: "Layout: Vertical",
            layoutTip: "Toggle layout for both preview and saved comparison video",
            labels: "Labels / Parameters",
            labelsHint: "Top-left labels (multiline; leave blank to hide)",
            fontSize: "Label size",
            outputPrefix: "Output filename prefix",
            saveHint: "Run with saving enabled to export one MP4 with this layout and labels",
            download: "Download comparison video",
            pick: "Pick Files",
            swap: "⇄ Swap",
            save: "Save",
            saving: "Saving…",
            saved: "Saved",
            noInput: "No video to compare\n\nConnect source/output, or click \"📂 Pick Files\"",
            loading: "Loading…",
            dirInput: "Input",
            dirTemp: "Temp",
            dirOutput: "Output",
            pickOk: "OK",
            pickCancel: "Cancel",
            pickUp: "Up",
            pickDown: "Down",
            pickEmpty: "No video files in this directory",
            pickHint: "{wired} wired inputs; select up to {remaining} files (4 videos total)",
            infoBar: "Info",
            cell: "#",
            framesDiff: "frame diff",
            durDiff: "dur diff",
            base: "base",
            truncated: "More than 4 videos pooled — using the first 4",
            fps: "fps",
            frames: "frames",
            dur: "dur",
            saveOn: "Save output: ON",
            saveOff: "Save output: OFF",
        },
    },
};

function t(node, key) {
    const lang = currentLang();
    const pack = XH_I18N[lang] || XH_I18N.zh;
    return (pack.ui && pack.ui[key]) || XH_I18N.zh.ui[key] || key;
}

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------
function freshState() {
    return {
        mode: "grid",          // grid | single | pair
        layout: "horizontal", // horizontal | vertical
        cells: [],             // [{ref, meta, videoEl, tagEl, loaded:bool}] —— 来自 onExecuted payload
        order: [],             // 显示顺序（cells 下标数组，⇄ 互换用）
        singleIdx: 0,          // 单看模式看哪格
        pairA: 0,              // 两两模式：左格
        pairB: 1,              // 两两模式：右格
        pairPos: 0.5,          // 分割线位置 0~1
        saved: false,          // 后端是否已存档（信息条提示）
        hint: "",
        picker: null,          // 弹层 DOM（节点级，同时只开一个）
        labelsOpen: true,
    };
}

function getSettingsWidget(node) {
    return (node.widgets || []).find((w) => w && w.name === "compare_video") || null;
}

function readSettings(node) {
    const w = getSettingsWidget(node);
    if (!w || !w.value) return {};
    try {
        const v = JSON.parse(w.value);
        return v && typeof v === "object" ? v : {};
    } catch (e) {
        return {};
    }
}

function writeSettings(node, patch) {
    const st = { ...readSettings(node), ...patch };
    const w = getSettingsWidget(node);
    if (w) {
        w.value = JSON.stringify(st);
        try { if (w.options) w.options.serialize = true; } catch (e) {}
    }
    try { node.setDirtyCanvas?.(true, true); } catch (e) {}
    return st;
}

// ---------------------------------------------------------------------------
// URL
// ---------------------------------------------------------------------------
function refToUrl(ref) {
    if (!ref || !ref.filename) return "";
    const type = ref.type || "temp";
    const sub = ref.subfolder || "";
    return `/view?filename=${encodeURIComponent(ref.filename)}&type=${encodeURIComponent(type)}&subfolder=${encodeURIComponent(sub)}`;
}

// ---------------------------------------------------------------------------
// 网格 / 单元
// ---------------------------------------------------------------------------
function gridCols(n) {
    if (n <= 1) return 1;
    if (n <= 2) return 2;
    return 2;
}

function displayCols(st, n) {
    if (st.mode === "single" || st.layout === "vertical") return 1;
    return st.mode === "pair" ? 2 : gridCols(n);
}

function makeCell(node, idx) {
    const cell = document.createElement("div");
    cell.style.cssText =
        "position:relative;box-sizing:border-box;background:#0b0d10;border-radius:6px;overflow:hidden;"
        + `font-family:${FONT_STACK};min-width:0;`;

    const tag = document.createElement("div");
    tag.style.cssText =
        "position:absolute;left:6px;top:6px;z-index:3;padding:1px 7px;border-radius:4px;"
        + "background:rgba(0,0,0,.63);color:#fff;font-size:24px;line-height:1.3;pointer-events:none;"
        + "white-space:pre-wrap;overflow-wrap:anywhere;max-width:calc(100% - 24px);padding:8px 12px;";

    const ve = document.createElement("video");
    ve.muted = true;
    ve.loop = true;
    ve.playsInline = true;
    ve.preload = "metadata";
    ve.setAttribute("controlsList", "nodownload");
    ve.style.cssText = "display:block;width:100%;height:100%;object-fit:contain;background:#0b0d10;";

    const hint = document.createElement("div");
    hint.style.cssText =
        "position:absolute;inset:0;display:none;align-items:center;justify-content:center;"
        + "color:#c9ced6;font-size:12px;pointer-events:none;";

    cell.appendChild(ve);
    cell.appendChild(tag);
    cell.appendChild(hint);
    return { el: cell, videoEl: ve, tagEl: tag, hintEl: hint, loaded: false };
}

// ---------------------------------------------------------------------------
// 同步时钟（主从：master = 显示顺序第 0 格）
// ---------------------------------------------------------------------------
function syncAll(node, masterTime) {
    const st = node._xhCMP;
    if (!st) return;
    for (const c of st.cells) {
        if (c === st.cells[st.order[0]]) continue;
        if (c.videoEl && Math.abs((c.videoEl.currentTime || 0) - masterTime) > 0.08) {
            try { c.videoEl.currentTime = masterTime; } catch (e) {}
        }
    }
}

function bindSyncEvents(node) {
    const st = node._xhCMP;
    if (!st) return;
    st.cells.forEach((c, i) => {
        const ve = c.videoEl;
        ve.addEventListener("loadeddata", () => {
            c.loaded = true;
            maybeStart(node);
            relayout(node);
        });
        ve.addEventListener("play", () => {
            for (const o of st.cells) {
                if (o === c) continue;
                try { o.videoEl.play?.(); } catch (e) {}
            }
        });
        ve.addEventListener("pause", () => {
            for (const o of st.cells) {
                if (o === c) continue;
                try { o.videoEl.pause?.(); } catch (e) {}
            }
        });
        ve.addEventListener("seeking", () => syncAll(node, ve.currentTime));
        ve.addEventListener("timeupdate", () => {
            if (st.order[0] === i) syncAll(node, ve.currentTime);
        });
        // 播放区不吃画布手势
        ["pointerdown", "mousedown", "dblclick", "wheel"].forEach((ev) =>
            c.el.addEventListener(ev, (e) => e.stopPropagation()));
        // 单击格子 → 单看模式看它
        c.el.addEventListener("click", () => {
            if (st.mode === "grid" && st.cells.length > 1) {
                st.singleIdx = i;
                setMode(node, "single");
            }
        });
    });
}

function maybeStart(node) {
    const st = node._xhCMP;
    if (!st || !st.cells.length) return;
    // 全部加载完才起播（最慢的一路不拖后腿）
    if (st.cells.every((c) => c.loaded)) {
        const m = st.cells[st.order[0]];
        try { m.videoEl.play?.(); } catch (e) {}
    }
}

// ---------------------------------------------------------------------------
// 模式切换
// ---------------------------------------------------------------------------
function setMode(node, mode) {
    const st = node._xhCMP;
    if (!st) return;
    st.mode = mode;
    if (st.cells.length) {
        st.pairA = 0;
        st.pairB = Math.min(1, st.cells.length - 1);
    }
    writeSettings(node, { mode });
    renderCells(node);
    paintModeBtns(node);
    relayout(node);
}

function renderCells(node) {
    const st = node._xhCMP;
    if (!st) return;
    const n = st.cells.length;
    const cols = displayCols(st, n);

    // 单看模式：只显示 singleIdx 那格
    // 两两模式：A/B 两格叠成滑块对比（DOM 简化：上下排列 + 各自 controls，进度同步）
    st.order = [];
    for (let i = 0; i < n; i++) st.order.push(i);

    if (!st.gridEl) return;
    st.gridEl.innerHTML = "";

    const showIdx = st.mode === "single" ? [st.singleIdx]
        : st.mode === "pair" ? [st.pairA, st.pairB]
            : st.order;

    st.gridEl.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;

    for (const i of showIdx) {
        const c = st.cells[i];
        if (!c) continue;
        c.el.style.aspectRatio = `${c.meta.width || 16} / ${c.meta.height || 9}`;
        st.gridEl.appendChild(c.el);
        updateCellTag(node, i);
        // 主格显示原生 controls，从格隐藏（同步播）
        const isMaster = st.mode === "pair" ? (i === st.pairA) : (i === st.order[0]);
        c.videoEl.controls = isMaster;
        c.el.style.cursor = st.mode === "grid" && n > 1 ? "zoom-in" : "default";
    }
    if (st.mode === "single" && n > 1) {
        // 给个退出提示：双击回网格
        const m = st.cells[st.singleIdx];
        if (m) {
            m.el.addEventListener("dblclick", () => setMode(node, "grid"), { once: true });
            m.el.style.cursor = "zoom-out";
        }
    }
}

function cellTag(node, i) {
    const labels = readSettings(node).labels;
    if (Array.isArray(labels) && i < labels.length) return String(labels[i]);
    return node._xhCMP.cells[i]?.meta?.label ?? `${t(node, "cell")}${i + 1}`;
}

function updateCellTag(node, i) {
    const st = node._xhCMP;
    const c = st.cells[i];
    const text = cellTag(node, i);
    const settings = readSettings(node);
    const cols = displayCols(st, st.cells.length);
    const cellWidth = (node.size[0] - 16 - (cols - 1) * 6) / cols;
    c.tagEl.textContent = text;
    c.tagEl.style.display = text.trim() ? "" : "none";
    c.tagEl.style.fontSize = `${(Number(settings.label_font_size) || 28) * cellWidth / (c.meta.width || cellWidth)}px`;
}

function ensureLabels(node) {
    if (readSettings(node).max_cells !== MAX_CELLS) writeSettings(node, { max_cells: MAX_CELLS });
    if (Array.isArray(readSettings(node).labels)) return;
    const labels = ["source", "output"].map((name, i) => {
        const index = node.inputs?.findIndex(input => input.name === name);
        return node.getInputNode?.(index)?.title || `${t(node, "cell")}${i + 1}`;
    });
    writeSettings(node, { labels });
}

function buildLabelPanel(node) {
    const st = node._xhCMP;
    if (!st?.labelPanel) return;
    const settings = readSettings(node);
    const connected = (node.inputs || []).filter(i => ["source", "output"].includes(i.name) && i.link != null).length;
    const count = Math.min(MAX_CELLS, Math.max(st.cells.length, 2, connected + (settings.selections?.length || 0)));
    const panel = st.labelPanel;
    panel.replaceChildren();
    panel.style.display = st.labelsOpen ? "flex" : "none";
    const hint = document.createElement("div");
    hint.textContent = t(node, "labelsHint");
    panel.appendChild(hint);
    const fields = document.createElement("div");
    fields.style.cssText = `display:grid;grid-template-columns:repeat(${node.size[0] < 560 ? 1 : 2},minmax(0,1fr));gap:8px;`;
    st.labelInputs = [];
    for (let i = 0; i < count; i++) {
        const label = document.createElement("label");
        label.textContent = `${t(node, "cell")}${i + 1}`;
        const input = document.createElement("textarea");
        input.rows = 3;
        input.value = cellTag(node, i);
        input.placeholder = t(node, "labelsHint");
        input.style.cssText = "display:block;box-sizing:border-box;width:100%;height:76px;margin-top:4px;resize:vertical;background:#12171e;color:#fff;border:1px solid #3a4553;border-radius:4px;padding:6px;font:13px/1.4 sans-serif;";
        input.addEventListener("input", () => {
            const labels = st.labelInputs.map(field => field.value);
            writeSettings(node, { labels });
            st.cells.forEach((_, index) => updateCellTag(node, index));
        });
        label.appendChild(input);
        fields.appendChild(label);
        st.labelInputs.push(input);
    }
    panel.appendChild(fields);
    const options = document.createElement("div");
    options.style.cssText = "display:flex;gap:12px;align-items:center;";
    const sizeLabel = document.createElement("label");
    sizeLabel.textContent = t(node, "fontSize") + " ";
    const size = document.createElement("input");
    size.type = "number"; size.min = "8"; size.max = "200";
    size.value = settings.label_font_size || 28;
    size.style.cssText = "width:60px;background:#12171e;color:#fff;border:1px solid #3a4553;padding:3px;";
    size.addEventListener("change", () => {
        writeSettings(node, { label_font_size: Math.max(8, Number(size.value) || 28) });
        st.cells.forEach((_, index) => updateCellTag(node, index));
    });
    sizeLabel.appendChild(size);
    options.appendChild(sizeLabel);
    const prefixLabel = document.createElement("label");
    prefixLabel.textContent = t(node, "outputPrefix") + " ";
    prefixLabel.style.flex = "1";
    const prefix = document.createElement("input");
    prefix.type = "text";
    prefix.value = settings.filename_prefix || "video/compare/VideoCompare";
    prefix.style.cssText = "box-sizing:border-box;width:65%;background:#12171e;color:#fff;border:1px solid #3a4553;padding:3px;";
    prefix.addEventListener("input", () => writeSettings(node, { filename_prefix: prefix.value }));
    prefixLabel.appendChild(prefix);
    options.appendChild(prefixLabel);
    panel.appendChild(options);
}

// ---------------------------------------------------------------------------
// 信息条（差值）
// ---------------------------------------------------------------------------
function refreshInfo(node) {
    const st = node._xhCMP;
    if (!st || !st.infoEl) return;
    const cells = st.cells;
    if (!cells.length) {
        st.infoEl.textContent = st.hint === "no_input" ? t(node, "noInput").replace(/\n/g, " ")
            : (st.hint || "");
        return;
    }
    const base = cells[0].meta || {};
    const lines = [];
    if (st.truncated) lines.push("⚠ " + t(node, "truncated"));
    cells.forEach((c, i) => {
        const m = c.meta || {};
        const seg = [`${t(node, "cell")}${i + 1}`];
        seg.push(`${t(node, "fps")} ${m.fps ? m.fps.toFixed(2) : "-"}`);
        seg.push(`${t(node, "frames")} ${m.frame_count ?? "-"}`);
        seg.push(`${t(node, "dur")} ${m.duration ? m.duration.toFixed(2) + "s" : "-"}`);
        if (i > 0) {
            if (base.frame_count && m.frame_count) {
                seg.push(`${t(node, "framesDiff")} ${m.frame_count - base.frame_count > 0 ? "+" : ""}${m.frame_count - base.frame_count}`);
            }
            if (base.duration && m.duration) {
                const d = m.duration - base.duration;
                seg.push(`${t(node, "durDiff")} ${d > 0 ? "+" : ""}${d.toFixed(2)}s`);
            }
        } else if (cells.length > 1) {
            seg.push(`(${t(node, "base")})`);
        }
        lines.push(seg.join(" · "));
    });
    if (st.saved) lines.push("💾 " + t(node, "saved"));
    st.infoEl.textContent = lines.join("\n");
}

// ---------------------------------------------------------------------------
// 文件选择弹层
// ---------------------------------------------------------------------------
async function openPicker(node) {
    const st = node._xhCMP;
    if (!st || st.picker) return;
    const s = readSettings(node);
    const wired = (node.inputs || []).filter(i => ["source", "output"].includes(i.name) && i.link != null).length;
    const remaining = Math.max(0, MAX_CELLS - wired);
    const chosen = Array.isArray(s.selections) ? s.selections.slice(0, remaining).map(selection => ({ ...selection })) : [];

    const wrap = document.createElement("div");
    wrap.style.cssText =
        "position:absolute;left:0;top:0;width:100%;box-sizing:border-box;z-index:30;"
        + "background:#1b2027;border:1px solid #2f3947;border-radius:8px;padding:8px;"
        + `font-family:${FONT_STACK};color:#d5dde5;font-size:12px;box-shadow:0 6px 24px rgba(0,0,0,.45);`;

    const tabs = document.createElement("div");
    tabs.style.cssText = "display:flex;gap:4px;margin-bottom:6px;";
    const listBox = document.createElement("div");
    listBox.style.cssText =
        "max-height:220px;overflow:auto;border:1px solid #2a3340;border-radius:6px;"
        + "background:#141820;padding:4px;margin-bottom:6px;";
    const btns = document.createElement("div");
    btns.style.cssText = "display:flex;gap:6px;justify-content:flex-end;";

    const pickerHint = document.createElement("div");
    pickerHint.textContent = t(node, "pickHint").replace("{wired}", wired).replace("{remaining}", remaining);
    pickerHint.style.cssText = "margin-bottom:8px;line-height:1.5;";
    wrap.appendChild(pickerHint);
    wrap.appendChild(tabs);
    wrap.appendChild(listBox);
    wrap.appendChild(btns);
    st.picker = wrap;

    let curDir = "output";
    let files = [];

    async function loadDir(d) {
        curDir = d;
        listBox.textContent = t(node, "loading");
        try {
            const r = await fetch(`/xh/videocompare/files?dir=${encodeURIComponent(d)}`);
            const j = await r.json();
            files = (j && j.files) || [];
            renderList();
        } catch (e) {
            listBox.textContent = "⚠ " + (e && e.message ? e.message : String(e));
        }
    }

    function renderList() {
        listBox.innerHTML = "";
        if (!files.length) {
            listBox.textContent = t(node, "pickEmpty");
            return;
        }
        files.forEach((f) => {
            const row = document.createElement("label");
            row.style.cssText =
                "display:flex;align-items:center;gap:6px;padding:3px 4px;border-radius:4px;cursor:pointer;";
            row.addEventListener("pointerdown", (e) => e.stopPropagation());
            const cb = document.createElement("input");
            cb.type = "checkbox";
            cb.checked = chosen.some((c) => c.source_type === curDir && c.file_path === f.name);
            cb.disabled = !cb.checked && chosen.length >= remaining;
            cb.addEventListener("change", () => {
                const i = chosen.findIndex((c) => c.source_type === curDir && c.file_path === f.name);
                if (cb.checked && i < 0) chosen.push({ source_type: curDir, file_path: f.name });
                if (!cb.checked && i >= 0) chosen.splice(i, 1);
                renderList();
            });
            const nm = document.createElement("span");
            nm.textContent = f.name;
            nm.style.cssText = "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
            const kb = document.createElement("span");
            kb.textContent = f.size_kb > 1024 ? (f.size_kb / 1024).toFixed(1) + "MB" : f.size_kb + "KB";
            kb.style.cssText = "opacity:.6;font-size:11px;";
            row.appendChild(cb);
            row.appendChild(nm);
            row.appendChild(kb);
            listBox.appendChild(row);
        });
    }

    for (const d of ["input", "temp", "output"]) {
        const b = document.createElement("button");
        b.textContent = t(node, d === "input" ? "dirInput" : d === "temp" ? "dirTemp" : "dirOutput");
        b.style.cssText =
            "flex:1;padding:3px 0;border:1px solid #2f3947;border-radius:4px;background:#262d38;"
            + `color:#d5dde5;font-size:12px;cursor:pointer;font-family:${FONT_STACK};`;
        b.addEventListener("click", () => {
            for (const x of tabs.children) x.style.background = "#262d38";
            b.style.background = "#1d3a52";
            loadDir(d);
        });
        if (d === "output") b.style.background = "#1d3a52";
        tabs.appendChild(b);
    }

    const ok = document.createElement("button");
    ok.textContent = t(node, "pickOk");
    const cancel = document.createElement("button");
    cancel.textContent = t(node, "pickCancel");
    for (const b of [ok, cancel]) {
        b.style.cssText =
            "padding:3px 14px;border:1px solid #2f3947;border-radius:4px;background:#262d38;"
            + `color:#d5dde5;font-size:12px;cursor:pointer;font-family:${FONT_STACK};`;
    }
    ok.addEventListener("click", () => {
        writeSettings(node, { selections: chosen.slice(0, remaining), max_cells: MAX_CELLS });
        closePicker(node);
        buildLabelPanel(node);
        relayout(node);
        // 让后端重跑：标记输出过期
        try { node.setOutputData?.(0, null); } catch (e) {}
        try { app.graph?.setDirtyCanvas?.(true, true); } catch (e) {}
    });
    cancel.addEventListener("click", () => closePicker(node));
    btns.appendChild(cancel);
    btns.appendChild(ok);

    // 挂到节点 body（playerEl 的父容器）
    const host = (st.playerEl && st.playerEl.parentElement) || node._xhCmpHost;
    if (host) {
        host.style.position = "relative";
        host.appendChild(wrap);
    }
    loadDir("output");
}

function closePicker(node) {
    const st = node._xhCMP;
    if (!st || !st.picker) return;
    try { st.picker.remove(); } catch (e) {}
    st.picker = null;
}

// ---------------------------------------------------------------------------
// 工具条
// ---------------------------------------------------------------------------
function paintModeBtns(node) {
    const st = node._xhCMP;
    if (!st || !st.modeBtns) return;
    if (st.layoutBtn) {
        st.layoutBtn.textContent = t(node, st.layout === "vertical" ? "layoutVertical" : "layoutHorizontal");
        st.layoutBtn.title = t(node, "layoutTip");
    }
    const map = { grid: "modeGrid", single: "modeSingle", pair: "modePair" };
    st.modeBtns.forEach(({ btn, mode }) => {
        const active = st.mode === mode;
        btn.style.background = active ? "#1d3a52" : "#262d38";
        btn.style.borderColor = active ? "#1668b3" : "#2f3947";
        btn.style.fontWeight = active ? "700" : "400";
        btn.textContent = t(node, map[mode]);
    });
}

function makeToolbarButtons(node) {
    const st = node._xhCMP;
    const out = [];

    const mkBtn = (key, tipKey, onClick) => {
        const b = document.createElement("button");
        b.textContent = t(node, key);
        b.title = t(node, tipKey || key);
        b.style.cssText =
            "height:22px;padding:0 9px;border:1px solid #2f3947;border-radius:4px;"
            + "background:#262d38;color:#d5dde5;font-size:12px;cursor:pointer;"
            + `font-family:${FONT_STACK};white-space:nowrap;`;
        b.addEventListener("pointerdown", (e) => e.stopPropagation());
        b.addEventListener("click", (e) => { e.stopPropagation(); onClick(); });
        return b;
    };

    st.modeBtns = [
        { btn: mkBtn("modeGrid", "mode", () => setMode(node, "grid")), mode: "grid" },
        { btn: mkBtn("modeSingle", "mode", () => setMode(node, "single")), mode: "single" },
        { btn: mkBtn("modePair", "mode", () => setMode(node, "pair")), mode: "pair" },
    ];
    out.push(...st.modeBtns.map((x) => x.btn));

    st.layoutBtn = mkBtn("layoutHorizontal", "layoutTip", () => {
        st.layout = st.layout === "vertical" ? "horizontal" : "vertical";
        writeSettings(node, { layout: st.layout });
        renderCells(node);
        paintModeBtns(node);
        relayout(node);
    });
    out.push(st.layoutBtn);

    st.labelsBtn = mkBtn("labels", "labelsHint", () => {
        st.labelsOpen = !st.labelsOpen;
        buildLabelPanel(node);
        relayout(node);
    });
    out.push(st.labelsBtn);

    st.pickBtn = mkBtn("pick", "pick", () => openPicker(node));
    out.push(st.pickBtn);

    const swapBtn = mkBtn("swap", "swap", () => {
        const st2 = node._xhCMP;
        if (!st2 || st2.cells.length < 2) return;
        st2.order.reverse();
        renderCells(node);
        relayout(node);
    });
    out.push(swapBtn);
    st.swapBtn = swapBtn;

    const saveBtn = mkBtn("save", "saveHint", () => {
        const cur = readSettings(node).save_output === true;
        writeSettings(node, { save_output: !cur });
        saveBtn.textContent = t(node, !cur ? "saveOn" : "saveOff");
        try { app.graph?.setDirtyCanvas?.(true, true); } catch (e) {}
    });
    if (readSettings(node).save_output === true) saveBtn.textContent = t(node, "saveOn");
    else saveBtn.textContent = t(node, "saveOff");
    out.push(saveBtn);
    st.saveBtn = saveBtn;

    return out;
}

// ---------------------------------------------------------------------------
// 布局高度（lockDomWidgetHeight 函数式）
// ---------------------------------------------------------------------------
function cellH(node) {
    const st = node._xhCMP;
    if (!st) return 160;
    const n = st.cells.length || 1;
    let w = 320;
    try {
        const sz = node.size;
        if (sz && typeof sz[0] === "number" && sz[0] > 0) w = sz[0];
    } catch (e) {}
    const cols = displayCols(st, n);
    const count = st.mode === "single" ? 1 : st.mode === "pair" ? Math.min(2, n) : n;
    const rows = Math.max(1, Math.ceil(count / cols));
    const meta = st.cells[0]?.meta;
    const aspect = meta?.width && meta?.height ? meta.width / meta.height : 16 / 9;
    const per = Math.max(110, Math.floor((w - 16 - (cols - 1) * 6) / cols / aspect));
    return per * rows + (rows - 1) * 6;
}

function totalH(node) {
    const st = node._xhCMP;
    if (!st) return 220;
    const grid = st.cells.length ? cellH(node) : 120;
    const info = st.infoEl && st.infoEl.textContent ? 34 : 0;
    const labels = st.labelsOpen && st.labelPanel ? st.labelPanel.scrollHeight : 0;
    const saved = st.savedLink?.style.display !== "none" ? 24 : 0;
    return 26 /* 工具条 */ + grid + info + labels + saved + 16;
}

function relayout(node) {
    try {
        node.setSize?.([node.size[0], node.computeSize()[1]]);
        node.setDirtyCanvas?.(true, true);
    } catch (e) {}
}

// ---------------------------------------------------------------------------
// payload → 界面
// ---------------------------------------------------------------------------
function applyPayload(node, data) {
    const st = node._xhCMP;
    if (!st || !data) return;
    st.hint = data.hint || "";
    st.saved = data.saved === true;
    st.truncated = data.truncated === true;
    const vids = Array.isArray(data.videos) ? data.videos : [];
    ensureLabels(node);
    st.cells = vids.map((v) => {
        const c = makeCell(node, 0);
        c.meta = v;
        const url = refToUrl(v);
        if (url) c.videoEl.src = url;
        return c;
    });
    buildLabelPanel(node);
    if (st.savedLink) {
        st.savedLink.style.display = data.output_video ? "block" : "none";
        if (data.output_video) {
            st.savedLink.href = refToUrl(data.output_video);
            st.savedLink.download = data.output_video.filename;
            st.savedLink.textContent = `${t(node, "download")}：${data.output_video.filename}`;
        }
    }
    bindSyncEvents(node);
    renderCells(node);
    refreshInfo(node);
    paintModeBtns(node);
    relayout(node);
    // 已经播放过再换源 ⇒ 尝试续播
    maybeStart(node);
}

// ---------------------------------------------------------------------------
// 语言
// ---------------------------------------------------------------------------
function applyLang(node, lang) {
    if (!node) return;
    lang = lang || currentLang();
    try {
        const want = XH_I18N[lang].nodes[NODE_TYPE];
        const zhT = XH_I18N.zh.nodes[NODE_TYPE];
        const enT = XH_I18N.en.nodes[NODE_TYPE];
        if (want && (!node.title || node.title === zhT || node.title === enT)) node.title = want;

        for (const w of (node.widgets || [])) {
            if (!w || !w.name) continue;
            const lb = XH_I18N[lang].widgets[w.name];
            if (lb) w.label = lb;
        }
        const applySlots = (arr, isOut) => {
            if (!arr) return;
            arr.forEach((s, i) => {
                const lb = XH_I18N[lang].slots[s && s.name];
                if (lb) {
                    s.label = lb;
                    try {
                        node.graph?.trigger?.("node:slot-label:changed", {
                            nodeId: String(node.id), slotType: isOut ? 2 : 1,
                            slotIndex: i, label: lb,
                        });
                    } catch (e) {}
                }
            });
        };
        applySlots(node.inputs, false);
        applySlots(node.outputs, true);

        // 工具条按钮文案
        if (node._xhCMP) {
            const st = node._xhCMP;
            if (st.modeBtns) paintModeBtns(node);
            if (st.swapBtn) st.swapBtn.textContent = t(node, "swap");
            if (st.pickBtn) st.pickBtn.textContent = t(node, "pick");
            if (st.labelsBtn) st.labelsBtn.textContent = t(node, "labels");
            if (st.labelPanel) buildLabelPanel(node);
            if (st.saveBtn) {
                const on = readSettings(node).save_output === true;
                st.saveBtn.textContent = t(node, on ? "saveOn" : "saveOff");
            }
            refreshInfo(node);
        }
        try { node.setDirtyCanvas?.(true, true); } catch (e) {}
    } catch (e) {
        console.warn("[XH VideoCompare] 应用语言失败:", e);
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

// ---------------------------------------------------------------------------
// 注册
// ---------------------------------------------------------------------------
app.registerExtension({
    name: "XH.VideoCompare",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_TYPE) return;

        const origOnCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = origOnCreated?.apply(this, arguments);
            try {
                const node = this;

                node._xhCMP = freshState();

                // ---- 主容器：网格 + 信息条 ----
                const host = document.createElement("div");
                host.style.cssText =
                    "width:100%;box-sizing:border-box;display:flex;flex-direction:column;gap:6px;"
                    + `font-family:${FONT_STACK};padding:2px 0 0 0;`;
                node._xhCmpHost = host;

                const grid = document.createElement("div");
                grid.style.cssText =
                    "display:grid;grid-template-columns:repeat(2,1fr);gap:6px;width:100%;box-sizing:border-box;";
                const info = document.createElement("div");
                info.style.cssText =
                    "white-space:pre-line;font-size:11px;line-height:1.5;color:#9aa5b1;"
                    + "min-height:14px;padding:0 2px;";
                const labelPanel = document.createElement("div");
                labelPanel.style.cssText = "display:flex;flex-direction:column;gap:8px;box-sizing:border-box;padding:10px;background:#1b222c;border-radius:6px;color:#d5dde5;font:12px sans-serif;";
                ["pointerdown", "mousedown", "dblclick", "wheel", "keydown"].forEach(event =>
                    labelPanel.addEventListener(event, e => e.stopPropagation()));
                const savedLink = document.createElement("a");
                savedLink.style.cssText = "display:none;color:#6cb7ff;font:13px sans-serif;overflow-wrap:anywhere;";
                savedLink.addEventListener("pointerdown", e => e.stopPropagation());
                host.appendChild(labelPanel);
                host.appendChild(grid);
                host.appendChild(info);
                host.appendChild(savedLink);

                const st = node._xhCMP;
                st.gridEl = grid;
                st.infoEl = info;
                st.labelPanel = labelPanel;
                st.savedLink = savedLink;

                // 空态提示格
                const emptyCell = makeCell(node, 0);
                emptyCell.tagEl.textContent = "";
                emptyCell.hintEl.textContent = t(node, "noInput");
                emptyCell.hintEl.style.display = "flex";
                grid.appendChild(emptyCell.el);
                st.emptyCell = emptyCell;

                let w = null;
                try {
                    w = node.addDOMWidget("xh_cmp_player", "custom", host, {
                        serialize: false,
                        hideOnZoom: false,
                    });
                } catch (e) {
                    console.warn("[XH VideoCompare] 播放器挂载失败:", e);
                }
                if (w) {
                    // 🔴 锁高：computeLayoutSize 抹成 undefined，Vue 行变 min-content，空带消失
                    lockDomWidgetHeight(w, () => totalH(node));
                    try {
                        w.serialize = false;
                        if (w.options) w.options.serialize = false;
                        w.serializeValue = () => undefined;
                    } catch (e) {}
                }
                st.playerEl = host;
                st.playerWidget = w;

                // ---- 工具条（中/EN + 🎨 家族标准）+ 模式/选择/互换/保存 ----
                // ⚠️ 已核 ui_kit 源码：opts 参数名是 appendNodes（不是 extraButtons）
                const extra = makeToolbarButtons(node);
                const { bar } = makeXHToolbar(node, { appendNodes: extra });

                // 齿轮：折叠 compare_video 控件口（widget 本体不删，§11S 只藏）
                try {
                    const cmpW = getSettingsWidget(node);
                    if (cmpW) cmpW.hidden = true;
                } catch (e) {}

                // 初始语言
                applyLang(node, currentLang());
            } catch (e) {
                console.warn("[XH VideoCompare] onNodeCreated 失败:", e);
            }
            return r;
        };

        // 执行完：拿后端 ui payload
        const origOnExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (output) {
            const r = origOnExecuted?.apply(this, arguments);
            try {
                const d = output?.compare_videos?.[0];
                if (d) applyPayload(this, d);
            } catch (e) {
                console.warn("[XH VideoCompare] onExecuted 失败:", e);
            }
            return r;
        };

        // 读档：恢复设置（模式/多选/save_output）
        const origOnConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (info) {
            const r = origOnConfigure?.apply(this, arguments);
            try {
                const st = this._xhCMP;
                if (!st) return r;
                const s = readSettings(this);
                if (s.mode) st.mode = s.mode;
                st.layout = s.layout === "vertical" ? "vertical" : "horizontal";
                if (st.cells.length) renderCells(this);
                applyLang(this, currentLang());
                paintModeBtns(this);
                setTimeout(() => {
                    if (!this.graph) return;
                    ensureLabels(this);
                    buildLabelPanel(this);
                    this._xhCMP.cells.forEach((_, i) => updateCellTag(this, i));
                    relayout(this);
                }, 0);
            } catch (e) {}
            return r;
        };

        // 删除：清理
        const origOnRemoved = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function () {
            try {
                closePicker(this);
                releaseButtons(this);
                const st = this._xhCMP;
                if (st) {
                    for (const c of st.cells) {
                        try { c.videoEl.pause?.(); } catch (e) {}
                        try { c.videoEl.src = ""; } catch (e) {}
                    }
                }
            } catch (e) {}
            return origOnRemoved?.apply(this, arguments);
        };
    },
});

onLangChanged(() => applyLangToAll());
