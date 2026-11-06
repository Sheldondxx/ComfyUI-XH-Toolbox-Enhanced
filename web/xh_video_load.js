// 🔁XH-加载视频 · 家族前端（2026-10-18 · v4：布局重排 + 播放器贴底 + ⚙ 折叠 + ▶ 预览开关）
//
// ① 中/EN 切换：节点标题 + 参数控件标签 + 输入/输出端口名
// ② 「⬆ 上传视频」= DOM 真按钮（家族绿 + 三层点击反馈）→ 上传进 input 目录并自动选中
// ③ 拖拽视频文件到节点直接上传（DOM dragover/drop + LiteGraph 老钩子，双保险）
// ④ 节点内嵌 <video> 真播放器（官方 /view 路由；controls + autoplay + loop + 静音起播）
// ⑤ ⚙ 一键收起/展开 6 个高级参数（默认收起 → 节点只剩「视频下拉 + 信息条 + 播放框」；信息条恒显、紧贴播放框上方、永不被折叠）
// ⑥ 实时信息条：分辨率 · 帧率 · 总帧数 · 时长 ·「将加载 N 帧」；重采样激活时帧率/总帧数
//    显示「源→目标」+ 丢帧规律，鼠标悬浮（title）有完整取帧规则/接缝说明
// ⑦ 节点自身配色 🎨（XH 家族 12 色 + 自定义取色器）
// ⑧ ▶/❚❚ **预览总开关**：关了立刻停流 + 卸 src（播放器收成 0 高，不占解码/内存），
//    信息条尾部挂「预览已关」标记；开着恢复拉流播放。
//    ⚠️ 只控制**前端预览**，不影响节点执行（后端照样读帧输出 IMAGE）。状态存在
//    `node.properties.xhPreviewOn`（走 properties ⇒ 不进 widgets_values ⇒ 不会把
//    7 个原生参数挤错位；本文件 fixSavedValues() 那套纠偏逻辑也就不必动）。
//
// ── 为什么不跟官方犯冲（用户 2026-10-14 明确担心过这一点）─────────────────────
//   · 播放器 = 我们自己 createElement 的 <video>，只挂在**我们自己的节点**上。
//     官方 LoadVideo 走的是官方那套（io.UploadType.video + ui.PreviewVideo），两套互不相干。
//   · 视频地址用官方公开路由 /view?filename=…&type=input —— 只「调用」，不重定义路由。
//   · 控件挂载用官方公开接口 node.addDOMWidget —— 家族所有节点都在用。
//   · 折叠参数走官方**受支持的** hidden facade。源码实证（ComfyUI_frontend）：
//       src/types/widgetVisibility.ts → applyLegacyHiddenWrite() 写 suppression.byExtension
//       src/lib/litegraph/src/LGraphNode.ts → isWidgetRowVisible() / getLayoutWidgets() 都会
//         跳过 byExtension 的控件 ⇒ 既不参与绘制、也不参与布局算高；且**不参与序列化**。
//     全程零改动官方任何文件。
//
// ── 尺寸管理（本机前端 1.55.14 源码级确认：LGraphNode.ts `_arrangeWidgets`）────────
//   · Vue 节点模式（Nodes 2.0）：**DOM 才是尺寸的唯一真源**，前端用 ResizeObserver 把量到的
//     高度回填给 node.size ⇒ 这里**绝不能自己 setSize**，否则「撑高 → CSS 变高 → ResizeObserver
//     报更大」会变成无限反馈环。官方源码里就是这么防的：
//         if (!LiteGraph.vueNodesMode && y > bodyHeight) this.setSize([...])
//   · 老画布模式：官方就是这么 setSize 的，我们照做，否则折叠后高度不会缩回去。
//   ⇒ 本文件 relayout() 用 window.LiteGraph.vueNodesMode 分流，两种模式都对。
//
// 铁律：只改 label / title，绝不改 name；DOM 控件 serialize:false 且只 append，禁止 unshift。
const { app } = window.comfyAPI.app;
const { api } = window.comfyAPI.api;

import {
    ensureLangBridge, makeXHToolbar, onLangChanged, releaseButtons, lockDomWidgetHeight, makeGearBtn,
    paintBarBtn,
} from "./xh_ui_kit.js";

ensureLangBridge();

const NODE_TYPE = "XHLoadVideo";
const GREEN = "#4BA14B";
const BAR_WIDGET = "xh_ui_bar";
const INFO_WIDGET = "xh_videoload_info";
const PLAYER_WIDGET = "xh_videoload_player";
const TRIM_WIDGET = "xh_videoload_trim";   // 截取拖动轴（DOM 控件，不序列化）

// 默认收起的「高级参数」（视频下拉不在此列，永远露在外头）
const ADV_KEYS = [
    "force_rate", "custom_width", "custom_height",
    // ⏱ 时间段模式：这两个**能接上游**（🔁XH-分段表 的 start_sec/duration），
    //   用来在循环里逐轮自动换段 —— 替代原先那个只能手拖的截取拖动轴。
    "start_sec", "duration",
    // 🎯 帧数直供（2026-10-21）：接分段表（单位=帧）的帧口，优先于秒模式。
    "start_frame", "frame_count",
    "frame_load_cap", "skip_first_frames", "select_every_nth",
];
// 本节点自己挂的 DOM 控件（不参与 widgets_values 序列化；纠偏时要跳过）
// ⛔ 2026-10-20 取消截取拖动轴（TRIM_WIDGET）：改成可接上游的 start_sec/duration 输入框。
//    轴不再创建（见下方 makeTrimBar 调用已停），这里也移出名单，避免存档纠偏时跳过空名。
const DOM_WIDGETS = [BAR_WIDGET, INFO_WIDGET, PLAYER_WIDGET];

const XH_I18N = {
    zh: {
        nodes: { XHLoadVideo: "🔁XH-加载视频" },
        widgets: {
            video: "视频文件",
            force_rate: "目标帧率(0=原速)",
            custom_width: "目标宽度(0=原)",
            custom_height: "目标高度(0=原)",
            frame_load_cap: "最多帧数(0=不限)",
            skip_first_frames: "跳过帧数",
            select_every_nth: "每隔几帧取一帧",
            start_sec: "⏱ 起始秒(0=从头)",
            duration: "⏱ 时长秒(0=到尾)",
            start_frame: "🎯 起始帧(接分段表)",
            frame_count: "🎯 取多少帧(接分段表)",
        },
        slots: { images: "图像", frame_count: "帧数", audio: "音频", video: "视频" },
        // 按钮 / 信息条
        upload: "上传视频",
        uploading: "上传中…",
        failed: "上传失败",
        notSelected: "未选择视频",
        noProbe: "（读不到视频信息）",
        willLoad: "将加载",
        frames: "帧",
        fps: "帧/秒",
        sec: "秒",
        // ⚙ / 播放器
        advShow: "展开高级参数（帧率 / 尺寸 / 截取）",
        advHide: "收起高级参数（只留视频 + 预览）",
        loading: "正在加载预览…",
        cantPlay: "浏览器预览不了这种封装（如 mkv）\n不影响正常加载，直接运行即可",
        // ▶ 预览总开关
        pvTipOn: "预览已开启 —— 点一下关闭（停止加载视频流看，不占内存）",
        pvTipOff: "预览已关闭 —— 点一下开启播放",
        pvMark: "预览已关",
        // ⑨ 截取拖动轴
        trimDisabled: "选好视频后，这里会出现截取拖动轴",
        trimUpstream: "截取范围正被上游端口控制，拖动轴已停用｜断开上游连线即可恢复拖动",
        trimTip: "拖两端手柄截取片段｜拖中间整段平移｜点空白处移动最近的手柄｜拖动时预览暂停跟随，松手恢复播放｜预览只循环播放选中段",
        trimResampled: "（轴按「重采样后」的帧数算，右边数字框可精确输入）",
    },
    en: {
        nodes: { XHLoadVideo: "XH Load Video" },
        widgets: {
            video: "video",
            force_rate: "force rate (0=keep)",
            custom_width: "width (0=orig)",
            custom_height: "height (0=orig)",
            frame_load_cap: "max frames (0=all)",
            skip_first_frames: "skip frames",
            select_every_nth: "select every nth",
            start_sec: "start sec (0=head)",
            duration: "duration sec (0=end)",
            start_frame: "start frame (from seg table)",
            frame_count: "frame count (from seg table)",
        },
        slots: { images: "images", frame_count: "frame count", audio: "audio", video: "video" },
        upload: "Upload",
        uploading: "Uploading…",
        failed: "Upload failed",
        notSelected: "no video selected",
        noProbe: "(cannot read video info)",
        willLoad: "will load",
        frames: "frames",
        fps: "fps",
        sec: "s",
        advShow: "Show advanced params (rate / size / trim)",
        advHide: "Hide advanced params",
        loading: "Loading preview…",
        cantPlay: "Browser can't preview this container (e.g. mkv)\nLoading still works — just run it",
        pvTipOn: "Preview ON — click to turn off (stops loading the video stream)",
        pvTipOff: "Preview OFF — click to turn on",
        pvMark: "preview off",
        trimDisabled: "pick a video — the trim bar shows up here",
        trimUpstream: "trim range is driven by an upstream input — trim bar disabled | disconnect to re-enable",
        trimTip: "drag the two handles to trim / drag the middle to shift / click the empty track to move the nearest handle / preview pauses and follows while dragging, resumes on release | preview loops only the selected range",
        trimResampled: "(frames counted AFTER resampling; use the number boxes for exact input)",
    },
};

function T(node, key) {
    const lang = window.XH_LANG || "zh";
    const pack = XH_I18N[lang] || XH_I18N.zh;
    return (pack && pack[key]) || XH_I18N.zh[key] || key;
}

function t(lang, kind, key) {
    const pack = XH_I18N[lang] || XH_I18N.zh;
    return (pack[kind] && pack[kind][key]) || null;
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

function fmtNum(x, d) {
    if (!isFinite(x)) return "-";
    return Number(x).toFixed(d == null ? 0 : d);
}

// DOM 控件内部的图标一律内联 SVG（家族铁律：emoji ➕ 在 Windows 会渲染成彩色字/错位）
const SVG_UPLOAD =
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
    + 'stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" style="display:block">'
    + '<path d="M12 16V4"/><path d="m6 10 6-6 6 6"/><path d="M4 20h16"/></svg>';

// ▶ 预览开关的两个图标（开 = 播放三角；关 = 暂停双竖条 → 一眼能分辨状态）
const SVG_PLAY =
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" style="display:block">'
    + '<path d="M8 5.14v13.72a.6.6 0 0 0 .91.51l11.1-6.86a.6.6 0 0 0 0-1.02L8.91 4.63A.6.6 0 '
    + '0 0 8 5.14z"/></svg>';

const SVG_PAUSE =
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" style="display:block">'
    + '<rect x="6" y="5" width="4.2" height="14" rx="1.3"/><rect x="13.8" y="5" width="4.2" '
    + 'height="14" rx="1.3"/></svg>';

// ---------------------------------------------------------------------------
// 上传（照家族 xh_image_list.js 的写法：api.fetchApi("/upload/image")）
// ---------------------------------------------------------------------------
async function uploadToInput(file) {
    const fd = new FormData();
    fd.append("image", file, file.name);
    fd.append("type", "input");
    const resp = await api.fetchApi("/upload/image", { method: "POST", body: fd });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText || ""}`);
    return await resp.json();      // {name, subfolder, type}
}

function selectVideo(node, name) {
    const w = widget(node, "video");
    if (!w) return;
    try {
        const vals = w.options && w.options.values;
        if (Array.isArray(vals) && !vals.includes(name)) vals.push(name);
    } catch (e) {}
    w.value = name;
    try { w.callback && w.callback(name, node, w); } catch (e) {}
    try { node.setDirtyCanvas?.(true, true); } catch (e) {}
    refreshInfo(node, true);
    syncPlayer(node);
}

function makeUploadButton(node, fileInput) {
    const btn = document.createElement("button");
    btn.type = "button";
    // 方案 B：实心绿 #4BA14B → primary 蓝实心（它是本节点唯一主操作，理应与齿轮同级）。
    // 保留了 inline-flex + gap:5px（本按钮要装 SVG 图标 + 文字两段），只换配色/描边。
    paintBarBtn(btn, "primary");
    btn.style.display = "inline-flex";
    btn.style.gap = "5px";
    btn.style.boxSizing = "border-box";
    btn.style.borderRadius = "4px";       // 4px = 家族统一圆角（原来 5px）
    btn.style.transition = "transform .08s ease,filter .12s ease";
    const icon = document.createElement("span");
    icon.innerHTML = SVG_UPLOAD;
    icon.style.cssText = "display:inline-flex;align-items:center;";
    const label = document.createElement("span");
    btn.appendChild(icon);
    btn.appendChild(label);

    const setLabel = (s) => { label.textContent = s; };
    setLabel(T(node, "upload"));
    node._xhVLBtnTip = setLabel;

    btn.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        btn.style.transform = "scale(0.93)";
        btn.style.filter = "brightness(0.85)";
    });
    const up = () => { btn.style.transform = ""; btn.style.filter = ""; };
    btn.addEventListener("pointerup", up);
    btn.addEventListener("pointercancel", up);
    btn.addEventListener("pointerleave", up);
    btn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (btn.disabled) return;
        fileInput.click();
    });
    ["pointerdown", "mousedown", "dblclick", "keydown", "click"].forEach((ev) =>
        btn.addEventListener(ev, (e) => e.stopPropagation()));
    return btn;
}

function wireUpload(node, fileInput, btn) {
    const setLabel = (s) => {
        try { node._xhVLBtnTip && node._xhVLBtnTip(s); } catch (e) {}
    };
    const doUpload = async (file) => {
        if (!file) return false;
        const looksVideo = /video\//.test(file.type || "") || /\.(mp4|mkv|webm|mov|gif)$/i.test(file.name || "");
        if (!looksVideo) {
            setLabel(T(node, "failed"));
            setTimeout(() => setLabel(T(node, "upload")), 1600);
            return false;
        }
        if (btn) { btn.disabled = true; }
        node._xhVLBtnBusy = true;
        setLabel(T(node, "uploading"));
        try {
            const info = await uploadToInput(file);
            const name = info && info.name ? info.name : file.name;
            selectVideo(node, name);
            setLabel(`✅ ${name.length > 14 ? name.slice(0, 13) + "…" : name}`);
            setTimeout(() => setLabel(T(node, "upload")), 1800);
            return true;
        } catch (e) {
            console.warn("[XH LoadVideo] 上传失败:", e);
            setLabel(T(node, "failed"));
            setTimeout(() => setLabel(T(node, "upload")), 1600);
            return false;
        } finally {
            node._xhVLBtnBusy = false;
            if (btn) { btn.disabled = false; }
        }
    };

    fileInput.addEventListener("change", async () => {
        const f = fileInput.files && fileInput.files[0];
        fileInput.value = "";
        await doUpload(f);
    });

    node._xhVLDoUpload = doUpload;
}

// 拖拽上传：DOM 事件（Vue 节点必走）+ LiteGraph 老钩子（canvas 模式）双保险
function attachDrop(node) {
    const el = (node._xhVL && node._xhVL.rootEl) || null;
    const doUpload = (file) => node._xhVLDoUpload && node._xhVLDoUpload(file);

    if (el) {
        const hasFiles = (e) => !!(e && e.dataTransfer && e.dataTransfer.types
            && Array.prototype.includes.call(e.dataTransfer.types, "Files"));
        const onOver = (e) => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            e.stopPropagation();
            try { e.dataTransfer.dropEffect = "copy"; } catch (err) {}
            el.style.outline = `2px solid ${GREEN}`;
            el.style.outlineOffset = "-2px";
        };
        const onLeave = () => { el.style.outline = ""; el.style.outlineOffset = ""; };
        const onDrop = async (e) => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            e.stopPropagation();
            onLeave();
            const f = e.dataTransfer.files && e.dataTransfer.files[0];
            await doUpload(f);
        };
        el.addEventListener("dragover", onOver);
        el.addEventListener("dragleave", onLeave);
        el.addEventListener("drop", onDrop);
        node._xhVLDropCleanup = () => {
            el.removeEventListener("dragover", onOver);
            el.removeEventListener("dragleave", onLeave);
            el.removeEventListener("drop", onDrop);
        };
    }

    // LiteGraph 老钩子（画布渲染模式下有效；Vue 节点下多半不触发，留着不碍事）
    node.onDragOver = function (e) {
        return !!(e && e.dataTransfer && e.dataTransfer.types
            && Array.prototype.includes.call(e.dataTransfer.types, "Files"));
    };
    node.onDragDrop = async function (e) {
        const f = e && e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (!f) return false;
        await doUpload(f);
        return true;
    };
}

// ---------------------------------------------------------------------------
// 尺寸：Vue 模式让 DOM 说话；老画布模式自己 setSize（官方源码同款分流）
// ---------------------------------------------------------------------------
function isVueNodes() {
    try { return window.LiteGraph && window.LiteGraph.vueNodesMode === true; } catch (e) { return false; }
}

function relayout(node) {
    const vl = node._xhVL;
    if (!vl) return;
    applyPlayerBox(node);
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

// ---------------------------------------------------------------------------
// ④ 内嵌播放器
// ---------------------------------------------------------------------------
const FONT_STACK = 'system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif';

/** 把 combo 值拆成 filename + subfolder，拼官方 /view 地址（t = 缓存穿透时间戳） */
function playerUrl(name, stamp) {
    let file = String(name || "");
    let sub = "";
    const i = file.lastIndexOf("/");
    if (i >= 0) { sub = file.slice(0, i); file = file.slice(i + 1); }
    const p = new URLSearchParams();
    p.set("filename", file);
    p.set("type", "input");
    p.set("subfolder", sub);
    p.set("t", String(stamp || 0));
    return api.apiURL("/view?" + p.toString());
}

/** 播放器顶部相对节点根容器顶部的偏移（与播放器自身高度无关，只取决于上方控件占用） */
function playerTopOffset(node) {
    const vl = node._xhVL;
    if (!vl || !vl.rootEl || !vl.playerEl) return 0;
    try {
        const a = vl.rootEl.getBoundingClientRect();
        const b = vl.playerEl.getBoundingClientRect();
        const top = b.top - a.top;
        return top > 0 ? top : 0;
    } catch (e) { return 0; }
}

/** 播放器该占多高：
 *  · 预览关 / 无文件 → 0；放不了 → 提示横条
 *  · 老画布模式：按真实宽高比给固定值（避免与 computeSize 互相喂成环）
 *  · Vue 节点模式：填满节点剩余高度（= 节点高 − 上方控件 − 底留白），
 *    拖拽节点变大时视频框跟着长、贴底无空白（只读取 node.size，绝不做反向 setSize） */
function playerHeight(node) {
    const vl = node._xhVL;
    if (!vl || !vl.hasFile || vl.previewOn === false) return 0;
    if (vl.err) return 62;
    if (!vl.ar) return 140;
    if (!isVueNodes()) {
        const availW = Math.max(120, (node.size?.[0] || 220) - 20);
        return Math.max(90, Math.min(320, Math.round(availW / vl.ar)));
    }
    const top = playerTopOffset(node);
    const bottomPad = 10;
    const nodeH = node.size?.[1] || 0;
    let h = nodeH - top - bottomPad;
    const byWidth = Math.round(Math.max(120, (node.size?.[0] || 220) - 20) / vl.ar);
    if (byWidth > 0) h = Math.min(h, byWidth);   // 宽高比兜底：横向铺满时高度，避免框被拉得过高
    return Math.max(90, Math.round(h));
}

function applyPlayerBox(node) {
    const vl = node._xhVL;
    if (!vl || !vl.playerEl) return;
    const h = playerHeight(node);
    vl.playerEl.style.display = h > 0 ? "flex" : "none";
    vl.playerEl.style.height = h > 0 ? h + "px" : "0px";
}

function showPlayerHint(node, text) {
    const vl = node._xhVL;
    if (!vl || !vl.hintEl) return;
    vl.hintEl.textContent = text || "";
    vl.hintEl.style.display = text ? "flex" : "none";
}

/**
 * 提示条文案跟着语言走。
 * 关键：中/EN 切换（applyLang）与存档重载（onConfigure → syncPlayer）是两条独立入口，
 * 两边都调一次 → 不管从哪条路进来，语言都不会错。
 */
function refreshPlayerText(node) {
    const vl = node._xhVL;
    if (!vl || !vl.err) return;
    showPlayerHint(node, T(node, "cantPlay"));
}

function makePlayer(node) {
    const playerEl = document.createElement("div");
    playerEl.style.cssText =
        "width:100%;box-sizing:border-box;display:none;align-items:center;justify-content:center;"
        + "position:relative;border-radius:6px;overflow:hidden;background:#0b0d10;margin:0;"
        + `font-family:${FONT_STACK};`;

    const videoEl = document.createElement("video");
    videoEl.muted = true;              // 必须静音才允许自动播放
    videoEl.loop = true;
    videoEl.autoplay = true;
    videoEl.playsInline = true;
    videoEl.controls = true;           // 交给浏览器原生控件：播放/暂停/进度/音量都齐
    videoEl.preload = "metadata";
    videoEl.setAttribute("controlsList", "nodownload");
    videoEl.style.cssText = "display:block;width:100%;height:100%;object-fit:contain;background:#0b0d10;";

    const hintEl = document.createElement("div");
    hintEl.style.cssText =
        "position:absolute;inset:0;display:none;align-items:center;justify-content:center;"
        + "padding:0 10px;box-sizing:border-box;text-align:center;white-space:pre-line;"
        + `font-size:12px;line-height:1.45;color:#c9ced6;font-family:${FONT_STACK};`;

    playerEl.appendChild(videoEl);
    playerEl.appendChild(hintEl);

    videoEl.addEventListener("loadedmetadata", () => {
        const vl = node._xhVL;
        if (!vl || vl.previewOn === false) return;      // 预览已关：忽略迟到的元数据
        const w = videoEl.videoWidth, h = videoEl.videoHeight;
        vl.ar = (w > 0 && h > 0) ? (w / h) : 0;
        vl.err = false;
        showPlayerHint(node, "");
        relayout(node);
        try { vl.trimLoop = trimLoopRange(node); } catch (e) {}   // duration 到了才算得准播放段
        try { videoEl.play?.(); } catch (e) {}
    });
    videoEl.addEventListener("error", () => {
        const vl = node._xhVL;
        if (!vl || vl.previewOn === false) return;      // 预览已关：卸 src 触发的 error 不算数
        vl.err = true;
        vl.ar = 0;
        showPlayerHint(node, T(node, "cantPlay"));
        relayout(node);
    });

    // ⑨+ 预览只播选中段（2026-10-20）：播放头越出 [段头, 段尾) 就拉回段头。
    //   · 到段尾 = 自然循环（原来 loop 是整段视频，现在缩到选中段）
    //   · 段头前 0.25s 容差：只在用户拖原生进度条/拖轴 seek 到段外时拉回，不打断 seek 途中态
    //   · vl.trimLoop = null（没选文件 / 上游接管 / 段太短）⇒ 完全不干预，退回整段循环
    videoEl.addEventListener("timeupdate", () => {
        const vl = node._xhVL;
        if (!vl || vl.previewOn === false) return;
        const rg = vl.trimLoop;
        if (!rg) return;
        const t = videoEl.currentTime;
        if (t >= rg[1]) {
            try { videoEl.currentTime = rg[0]; } catch (e) {}
        } else if (t < rg[0] - 0.25) {
            try { videoEl.currentTime = rg[0]; } catch (e) {}
        }
    });

    // 播放器区域不吃画布手势（拖节点请抓标题栏）
    ["pointerdown", "mousedown", "dblclick", "keydown", "click", "wheel"].forEach((ev) =>
        playerEl.addEventListener(ev, (e) => e.stopPropagation()));

    let w = null;
    try {
        w = node.addDOMWidget(PLAYER_WIDGET, "custom", playerEl, {
            serialize: false,
            hideOnZoom: false,
            getMinHeight: () => playerHeight(node),
            getHeight: () => playerHeight(node),
        });
    } catch (e) {
        console.warn("[XH LoadVideo] 播放器挂载失败:", e);
    }
    if (w) {
        // 高度我们自己说了算（不吸收节点多余的竖向空白），与工具条/信息条同一套办法。
        // 🔴 2026-10-14 补：只写 computeSize 对 **Vue Nodes 无效** —— Vue 的行高只看
        //    `hasLayoutSize = !!computeLayoutSize`，DOM widget 基类自带它 ⇒ 播放器行永远是
        //    auto 行，节点拖高后多余空间灌进来、而播放器元素是固定 px 高 ⇒ 视频下方留一条空带。
        //    lockDomWidgetHeight 连 computeLayoutSize 一起撤，行变 min-content ⇒ 空带消失。
        //    （传函数：高度随「宽高比 + 节点宽度」变，但与节点高度无关，不会互相喂成增长环。）
        lockDomWidgetHeight(w, () => playerHeight(node));
        try {
            w.serialize = false;
            if (w.options) w.options.serialize = false;
            w.serializeValue = () => undefined;
        } catch (e) {}
    }

    node._xhVL.playerEl = playerEl;
    node._xhVL.videoEl = videoEl;
    node._xhVL.hintEl = hintEl;
    node._xhVL.playerWidget = w;
    return w;
}

/** 视频下拉一改就重挂 src（同一文件不重复刷，避免反复重新拉流） */
function syncPlayer(node) {
    const vl = node._xhVL;
    if (!vl || !vl.videoEl) return;
    const name = wStr(node, "video");
    // 没选文件 **或** 预览开关被关 → 立刻卸流：不拉、不解码、不占内存
    if (!name || vl.previewOn === false) {
        try { vl.videoEl.pause?.(); } catch (e) {}
        try { vl.videoEl.removeAttribute("src"); vl.videoEl.load?.(); } catch (e) {}
        vl.hasFile = !!name;         // 有文件只是不预览 → 信息条照样显示规格
        vl.curFile = "";             // 清掉「已挂 src」判据 → 重新打开时会再拉一次
        vl.ar = 0;
        vl.err = false;
        showPlayerHint(node, "");
        relayout(node);
        return;
    }
    vl.hasFile = true;
    if (vl.curFile !== name) {
        vl.curFile = name;
        vl.ar = 0;
        vl.err = false;
        vl.stamp = Date.now();                       // 只在换文件时穿透缓存
        try { vl.videoEl.src = playerUrl(name, vl.stamp); } catch (e) {}
        showPlayerHint(node, T(node, "loading"));      // 等 loadedmetadata / error 来改写
        try { vl.videoEl.play?.(); } catch (e) {}
    }
    refreshPlayerText(node);
    relayout(node);
}

// ---------------------------------------------------------------------------
// ⑧ ▶ 预览总开关
//   · 开 → 正常拉流播放；关 → 立刻 pause + 卸 src（连拉流/解码都停），播放器收成 0 高。
//   · 只影响**前端预览**，不改变后端执行（节点照样输出 IMAGE / 帧数 / 音频）。
//   · 状态写 `node.properties.xhPreviewOn`：走 properties ⇒ 不进 widgets_values ⇒
//     7 个原生参数不会错位（本文件 fixSavedValues 那套纠偏逻辑因此不用动），且随工作流保存。
// ---------------------------------------------------------------------------
function previewOn(node) {
    return !(node._xhVL && node._xhVL.previewOn === false);
}

function paintPreview(node) {
    const btn = node._xhVLPv;
    if (!btn) return;
    const on = previewOn(node);
    btn.innerHTML = on ? SVG_PLAY : SVG_PAUSE;
    btn.title = T(node, on ? "pvTipOn" : "pvTipOff");
    // 方案 B：开 = active（蓝底蓝边蓝字，一眼看出"正在预览"）；关 = neutral（退成配角）
    paintBarBtn(btn, on ? "active" : "neutral");
}

function setPreview(node, on) {
    const vl = node._xhVL;
    if (!vl) return;
    vl.previewOn = !!on;
    try { if (node.properties) node.properties.xhPreviewOn = vl.previewOn; } catch (e) {}
    paintPreview(node);
    syncPlayer(node);          // 开 → 重新拉流；关 → 卸流（内部按 previewOn 分流）
    refreshInfo(node, false);
}

function makePreviewButton(node) {
    const btn = document.createElement("button");
    btn.type = "button";
    // 方案 B：26×22 图标按钮，与齿轮同尺寸；开=active 档（蓝边蓝字）关=neutral 档。
    paintBarBtn(btn, "neutral");
    btn.style.width = "26px";
    btn.style.padding = "0";
    btn.addEventListener("mouseenter", () => { btn.style.filter = "brightness(1.25)"; });
    btn.addEventListener("mouseleave", () => { btn.style.filter = ""; });
    btn.addEventListener("click", (e) => {
        e.stopPropagation();
        setPreview(node, !previewOn(node));      // 当前开 → 关；当前关 → 开
    });
    ["pointerdown", "mousedown", "dblclick", "keydown", "click"].forEach((ev) =>
        btn.addEventListener(ev, (e) => e.stopPropagation()));
    node._xhVLPv = btn;
    paintPreview(node);
    return btn;
}

// ---------------------------------------------------------------------------
// ⑥ 信息条
// ---------------------------------------------------------------------------
function makeInfoBar(node) {
    const el = document.createElement("div");
    el.style.cssText =
        "display:flex;align-items:center;gap:6px;padding:6px 9px;width:100%;box-sizing:border-box;"
        + "border-radius:6px;background:rgba(255,255,255,0.10);"
        + `font-family:${FONT_STACK};`
        + "font-size:12px;font-weight:600;color:#ffffff;text-shadow:0 1px 2px rgba(0,0,0,0.35);"
        + "margin:0;user-select:none;cursor:pointer;white-space:nowrap;overflow:hidden;";
    const dot = document.createElement("span");
    dot.style.cssText = "flex:0 0 auto;width:7px;height:7px;border-radius:50%;background:#8a93a0;";
    const text = document.createElement("span");
    text.style.cssText = "flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;";
    el.appendChild(dot);
    el.appendChild(text);

    // 点一下 = 强制重新读取：文件在磁盘上被同名替换后，用它刷新预览与信息
    el.addEventListener("pointerdown", (e) => e.stopPropagation());
    el.addEventListener("click", (e) => {
        e.stopPropagation();
        const vl = node._xhVL;
        if (!vl) return;
        vl.curFile = "";                 // 清掉「同一文件不重挂」的判据 → 下面会重新拉一次
        refreshInfo(node, true);
        syncPlayer(node);
    });

    let w = null;
    try {
        w = node.addDOMWidget(INFO_WIDGET, "custom", el, {
            serialize: false,
            hideOnZoom: false,
            getMinHeight: () => 26,
        });
    } catch (e) {
        console.warn("[XH LoadVideo] 信息条挂载失败:", e);
    }
    if (w) {
        // 🔴 信息条钉死 26px（Vue Nodes 下行高只看 hasLayoutSize ⇒ 必须连 computeLayoutSize 一起撤，
        //    否则节点拖高时多余空间灌进信息条 → 空条；见 xh_ui_kit.js lockDomWidgetHeight 注释）
        lockDomWidgetHeight(w, 26);
        // serialize:false 三重堵（本机新前端不认 options.serialize）
        try {
            w.serialize = false;
            if (w.options) w.options.serialize = false;
            w.serializeValue = () => undefined;
        } catch (e) {}
    }
    node._xhVL.infoEl = el;
    node._xhVL.textEl = text;
    node._xhVL.dotEl = dot;
    return w;
}

function estimateLoaded(node, total, fps) {
    const forceRate = wNum(node, "force_rate", 0);
    const every = Math.max(1, Math.round(wNum(node, "select_every_nth", 1)));
    const cap = Math.round(wNum(node, "frame_load_cap", 0));
    const skip = Math.round(wNum(node, "skip_first_frames", 0));
    const startSec = Math.max(0, wNum(node, "start_sec", 0));
    const durSec = Math.max(0, wNum(node, "duration", 0));
    const rate = forceRate > 0 ? forceRate : (fps > 0 ? fps : 0);

    // 🎯 帧数直供（判定与 Python 端一致：frame_count > 0 优先于秒模式）
    //   帧数就是上游算好的合法帧数，这里只按「有效帧率」核对总量，不再做任何秒→帧换算。
    const fc = Math.max(0, wNum(node, "frame_count", 0));
    if (fc > 0) {
        const startFrame = Math.max(0, Math.round(wNum(node, "start_frame", 0)));
        let n = Math.max(0, Math.round(total || 0));
        if (fps > 0 && forceRate > 0) n = Math.floor(n / fps * forceRate);   // 重采样后的总帧数
        n = Math.max(0, n - startFrame);                                     // 丢掉起点之前的
        n = Math.floor(n / every);
        return Math.min(Math.max(1, Math.floor(fc / every)), n);            // cap 折算到抽帧后
    }

    // ⏱ 时间段模式（判定与 Python 端 time_mode 一致：start_sec / duration 任一 >0）
    //   该模式下按「秒 × 目标帧率」算，跳过帧数/最多帧数两个帧参数不再参与。
    if (startSec > 0 || durSec > 0) {
        // 与 Python 端**同一套口径**：绝对帧索引 + floor（不是各自 round 秒数）
        // ⇒ 段 n 的结束帧 === 段 n+1 的起始帧，长视频拼接绝不漏帧 / 重帧。
        const startFrame = Math.floor(startSec * rate);
        let n = Math.max(0, Math.round(total || 0));
        if (fps > 0 && forceRate > 0) n = Math.floor(n / fps * forceRate);   // 重采样后的总帧数
        n = Math.max(0, n - startFrame);                                     // 丢掉起点之前的
        n = Math.floor(n / every);
        if (durSec > 0) {
            const endFrame = Math.floor((startSec + durSec) * rate);
            const span = Math.max(1, endFrame - startFrame);
            n = Math.min(Math.max(1, Math.floor(span / every)), n);          // cap 折算到抽帧后
        }
        return Math.max(0, n);
    }

    let n = Math.max(0, Math.round(total || 0));
    if (fps > 0 && forceRate > 0) n = Math.floor(n / fps * forceRate);
    n = Math.floor(n / every);
    n = Math.max(0, n - skip);
    if (cap > 0) n = Math.min(cap, n);
    return n;
}

// 🎯 2026-10-22 重采样口径（与 Python 端 _estimate_frames / _iter_frames 同一套规则）：
//    · 重采样后总帧数 = floor(源总帧 / 源fps × 目标fps)（时长不变）
//    · 取帧规则：第 k 个输出帧取源视频第 ceil(k×源fps/目标fps) 帧
//      （每个 1/目标fps 秒格取第一个时间 ≥ 格起点的源帧；纯丢帧、不插值）
//    · 丢帧规律：源:目标 = a:b（最简）⇒ 每 a 个源帧丢 (a-b) 个；a<b 时升采样出重复帧
function _vhGcd(a, b) { a = Math.abs(a); b = Math.abs(b); while (b) { const t = a % b; a = b; b = t; } return a; }

function _vhResample(p, forceRate) {
    // 返回 null = 未重采样；否则 { src, dst, rsTotal, every, a, b, g }
    const src = Number(p && p.fps) || 0;
    const dst = Number(forceRate) || 0;
    if (!(src > 0) || !(dst > 0) || Math.abs(dst - src) < 1e-6) return null;
    const rsTotal = Math.floor((Number(p.frames_total) || 0) / src * dst);
    const a = Math.round(src), b = Math.round(dst);
    const g = a > 0 && b > 0 ? _vhGcd(a, b) : 0;
    const every = g > 0 ? a / g : 0;          // 每 every 个源帧产出 b/g 个输出帧
    return { src, dst, rsTotal, every, a, b, g };
}

function paintInfo(node, state, payload) {
    const vl = node._xhVL;
    if (!vl || !vl.textEl) return;
    const lang = window.XH_LANG || "zh";
    const en = lang !== "zh";
    const off = vl.previewOn === false;                     // 预览开关关着 → 尾部挂个标记
    const mark = off ? ` · ${T(node, "pvMark")}` : "";
    if (state === "empty") {
        vl.dotEl.style.background = "#8a93a0";
        vl.textEl.textContent = T(node, "notSelected") + mark;
        vl.textEl.style.color = "#ffffff";
        return;
    }
    if (state === "error") {
        vl.dotEl.style.background = "#E53935";
        vl.textEl.textContent = (payload || T(node, "noProbe")) + mark;
        vl.textEl.style.color = "#ffb3ae";
        return;
    }
    // state === "ok"
    const p = payload || {};
    const fpsTxt = fmtNum(p.fps, p.fps >= 100 ? 0 : 2);
    const dur = p.duration || 0;
    // 🎯 重采样激活 ⇒ 帧率/总帧数直接显示「源 → 目标」，丢帧规律贴在帧数后面
    //    （放行中而不是行尾：省略号先砍的是行尾，别把关键信息留在那里）
    const rs = _vhResample(p, wNum(node, "force_rate", 0));
    let fpsPart, framesPart;
    if (rs) {
        const dstTxt = fmtNum(rs.dst, rs.dst >= 100 ? 0 : 2);
        fpsPart = `${fpsTxt}→${dstTxt} ${T(node, "fps")}`;
        framesPart = `${p.frames_total}→${rs.rsTotal} ${T(node, "frames")}`;
        const dropped = rs.g > 0 ? (rs.a - rs.b) / rs.g : 0;
        if (dropped >= 1) {
            framesPart += en ? ` (drop ${dropped}/${rs.every})` : ` (每${rs.every}帧丢${dropped}帧)`;
        } else if (rs.b > rs.a) {
            framesPart += en ? ` (dup frames)` : ` (有重复帧)`;
        }
    } else {
        fpsPart = `${fpsTxt} ${T(node, "fps")}`;
        framesPart = `${p.frames_total} ${T(node, "frames")}`;
    }
    const parts = [
        `${p.width}×${p.height}`,
        fpsPart,
        framesPart,
        `${fmtNum(dur, 2)}${en ? "" : " "}${T(node, "sec")}`,
    ];
    const loaded = estimateLoaded(node, p.frames_total, p.fps);
    // ⏱ 选段只读提示（拖动轴取消后，用它保留「当前切的是哪一段」的可视化信息，不参与交互）
    let segTxt = "";
    const _fc = Math.max(0, wNum(node, "frame_count", 0));
    const _sSec = Math.max(0, wNum(node, "start_sec", 0));
    const _dSec = Math.max(0, wNum(node, "duration", 0));
    if (_fc > 0) {
        // 🎯 帧模式：直接显示帧区间（第 124–248 帧）
        const _sf = Math.max(0, Math.round(wNum(node, "start_frame", 0)));
        const _ef = _sf + Math.round(_fc);
        segTxt = en
            ? ` · frames ${_sf}–${_ef}`
            : ` · 第 ${_sf}–${_ef} 帧`;
    } else if (_sSec > 0 || _dSec > 0) {
        const _bSec = _dSec > 0 ? _sSec + _dSec : (p.duration || 0);
        segTxt = en
            ? ` · seg ${fmtNum(_sSec, 1)}–${fmtNum(_bSec, 1)}s`
            : ` · 选段 ${fmtNum(_sSec, 1)}–${fmtNum(_bSec, 1)} 秒`;
    }
    const tail = ` → ${T(node, "willLoad")} ${loaded} ${T(node, "frames")}` + segTxt;
    vl.dotEl.style.background = off ? "#8a93a0" : GREEN;    // 预览关 → 小圆点也灭掉
    vl.textEl.style.color = "#ffffff";
    vl.textEl.textContent = parts.join(" · ") + tail + mark;
    // 🔍 悬浮详述（2026-10-22 用户点名：「底部只显示原视频参数，没显示设置 24 帧后的数据」）：
    //    行子里放不下的「重采样映射 + 接缝规则」全放 title，鼠标悬停即看
    try {
        if (vl.infoEl) {
            const tl = [en
                ? `Source: ${p.width}×${p.height} · ${fpsTxt} fps · ${p.frames_total} frames · ${fmtNum(dur, 2)}s`
                : `源视频：${p.width}×${p.height} · ${fpsTxt} 帧/秒 · ${p.frames_total} 帧 · ${fmtNum(dur, 2)} 秒`];
            if (rs) {
                const dstTxt = fmtNum(rs.dst, rs.dst >= 100 ? 0 : 2);
                tl.push(en
                    ? `Resampled: ${fpsTxt} → ${dstTxt} fps · ${p.frames_total} → ${rs.rsTotal} frames (duration unchanged)`
                    : `重采样：${fpsTxt} → ${dstTxt} 帧/秒 · ${p.frames_total} → ${rs.rsTotal} 帧（时长不变）`);
                tl.push(en
                    ? `Rule: output frame k = source frame ceil(k×${fpsTxt}/${dstTxt}) — first source frame at/after each 1/${dstTxt}s grid point; drop-only, no interpolation`
                    : `取帧规则：第 k 个输出帧 = 源视频第 ceil(k×${fpsTxt}/${dstTxt}) 帧（每个 1/${dstTxt} 秒格取第一个时间 ≥ 格起点的源帧；纯丢帧、不插值）`);
                if (rs.dst < rs.src) {
                    tl.push(en
                        ? `Loop seam: last frame of segment n and first frame of segment n+1 are strictly adjacent in source frames (no dup, no gap). Skip is counted in the ${dstTxt}fps domain, every segment starts from the same phase.`
                        : `循环接缝：段 n 末帧与段 n+1 首帧在源帧上严格相邻（不重帧、不漏帧）；跳帧数按 ${dstTxt} 帧域计算，每段同相位起算 ⇒ 拼接零错位。`);
                } else {
                    tl.push(en
                        ? `Loop seam: a seek-continued segment is frame-identical to playing the source straight through; adjacent output frames may reuse one source frame (dup), never skips.`
                        : `循环接缝：续段与「源视频不间断放遍一遍」逐帧一致；相邻输出帧可能取同一个源帧（重复帧），不会漏帧。`);
                }
            }
            vl.infoEl.title = tl.join("\n");
        }
    } catch (e) {}
}

async function probeVideo(node, name) {
    const url = api.apiURL("/xh/videoload/probe?filename=" + encodeURIComponent(name) + "&type=input");
    const resp = await api.fetchApi(url, { method: "GET" });
    const data = await resp.json();
    if (!data || data.ok !== true) throw new Error((data && data.error) || "probe failed");
    return data;
}

function refreshInfo(node, force) {
    const vl = node._xhVL;
    if (!vl || !vl.textEl) return;
    const name = wStr(node, "video");
    if (!name) {
        vl.data = null; vl.file = "";
        paintInfo(node, "empty");
        paintTrim(node);          // 没选文件 → 轴进禁用态
        return;
    }
    if (!force && vl.file === name && vl.data) {
        paintInfo(node, "ok", vl.data);      // 只改了参数 → 用缓存重算「将加载」
        return;
    }
    vl.file = name;
    probeVideo(node, name)
        .then((data) => {
            if (wStr(node, "video") !== name) return;    // 期间又换文件了
            vl.data = data;
            paintInfo(node, "ok", data);
            clampTrim(node);      // probe 到了才有 total，越界 skip 这时才能判
            paintTrim(node);
        })
        .catch((e) => {
            vl.data = null;
            paintInfo(node, "error", `${T(node, "noProbe")} ${String(e.message || e)}`);
        });
}

// ---------------------------------------------------------------------------
// ⑤ ⚙ 折叠高级参数
// ---------------------------------------------------------------------------
/**
 * 刷新齿轮外观。★ 2026-10-20 齿轮统一：外观全交给 kit.makeGearBtn（_xhGearSet 自带 titleFn），
 *   本文件只提供「当前折叠状态」这一个事实。
 */
function paintGear(node) {
    const btn = node._xhVLGear;
    if (!btn) return;
    const collapsed = !node._xhVL || node._xhVL.collapsed !== false;
    if (btn._xhGearSet) btn._xhGearSet(collapsed);
    else btn.title = T(node, collapsed ? "advShow" : "advHide");
}

function makeGearButton(node) {
    // ★ 家族统一齿轮（kit.makeGearBtn）：粗壮实心图标 + 亮蓝/绿状态色 + 26×22
    const btn = makeGearBtn({
        collapsed: !node._xhVL || node._xhVL.collapsed !== false,
        titleFn: (col) => T(node, col ? "advShow" : "advHide"),
        onToggle: (col) => setCollapsed(node, col),
    });
    node._xhVLGear = btn;
    paintGear(node);
    return btn;
}

/**
 * 收起 / 展开 6 个高级参数。
 * 用官方「受支持的」legacy facade `widget.hidden`：前端源码里它就是
 * suppression.byExtension —— 既不绘制、也不参与布局算高（getLayoutWidgets /
 * isWidgetRowVisible 都会跳过），且与序列化无关（我们另有三重堵 + onConfigure 纠偏）。
 */
function setCollapsed(node, collapsed) {
    const vl = node._xhVL;
    if (!vl) return;
    vl.collapsed = !!collapsed;
    for (const k of ADV_KEYS) {
        const w = widget(node, k);
        if (!w) continue;
        try { w.hidden = vl.collapsed; } catch (e) {}
    }
    // ⑨ 拖动轴跟着齿轮一起收/展（hidden + 元素 display 双保险，与齿轮折叠同机制）
    try { if (vl.trimEl) vl.trimEl.style.display = vl.collapsed ? "none" : "block"; } catch (e) {}
    paintGear(node);
    relayout(node);
}

// ---------------------------------------------------------------------------
// ⑨ 截取拖动轴（剪映式 trim bar）—— 2026-10-20 粉丝 akira7788 的建议
//
//   需求原话：「希望在 XH-加载视频的高级选项中添加一个拖动轴，轴的长度就是要使用的
//    这段视频长度……能拖动在视频总长度中，用这样的方式替代掉跳过开头帧数」。
//
//   ⛔ 不能「替代」：skip_first_frames / frame_load_cap 在 INPUT_TYPES 里占着存档位，
//    删一个 ⇒ widgets_values 整体前移 ⇒ 用户所有老工作流打开即错位（§11S 同款铁律）。
//    且 frame_load_cap 还兼着省显存职责（默认 124），本来就不是单纯的长度开关。
//    ✅ 正解：拖动轴 = 这两个数字框的**可视化遥控器**
//     · 左手柄 → skip_first_frames（起点）
//     · 右手柄 → frame_load_cap = 终点 − 起点（长度）
//     · 数字框原样保留（精确输入 / 老兼容），框改 → 轴跟，轴拖 → 框（pointerup 时）写
//     · 拖动过程中预览播放器实时 seek 到当前手柄位置
//
//   坐标系：轴上是**重采样后**的输出帧（与后端 _iter_frames 的计数口径一致）：
//     total = floor(frames_total / fps * force_rate) / select_every_nth   （force_rate=0 时不变）
//     显示用的原视频秒 = frame × select_every_nth / (force_rate || fps)
// ---------------------------------------------------------------------------
const TRIM_H = 48;                      // 行高（顶行 16 + 轨道 10 + 手柄上下探出 + 余量）
const C_TRIM_TRACK = "#2a2f38";         // 轨道底
const C_TRIM_SEL = "#1668b3";           // 已选段（= kit primary 蓝）
const C_TRIM_HANDLE = "#e8f2fb";        // 手柄芯（近白，深底上最跳）
const C_TRIM_BD = "#1668b3";            // 手柄描边（primary 蓝）

/** mm:ss.d 时间码（短视频场景分钟两位足够） */
function trimTC(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    const m = Math.floor(sec / 60);
    const s = sec - m * 60;
    return String(m).padStart(2, "0") + ":" + s.toFixed(1).padStart(4, "0");
}

function clampInt(v, lo, hi) {
    return Math.max(lo, Math.min(hi, Math.round(v)));
}

/** 轴全长 = 重采样+抽帧之后的输出帧总数（与 estimateLoaded 同口径） */
function trimTotal(node) {
    const vl = node._xhVL;
    const d = vl && vl.data;
    if (!d) return 0;
    let n = Math.round(d.frames_total || 0);
    if (n <= 0 && d.fps > 0 && d.duration > 0) n = Math.round(d.duration * d.fps);
    const every = Math.max(1, Math.round(wNum(node, "select_every_nth", 1)));
    const fr = wNum(node, "force_rate", 0);
    if (n > 0 && d.fps > 0 && fr > 0) n = Math.floor(n / d.fps * fr);
    return Math.max(0, Math.floor(n / every));
}

/** 输出帧 → 原视频秒 的换算率（秒 = frame / trimRate） */
function trimRate(node) {
    const vl = node._xhVL;
    const d = vl && vl.data;
    const fr = wNum(node, "force_rate", 0);
    const every = Math.max(1, Math.round(wNum(node, "select_every_nth", 1)));
    const base = (d && d.fps > 0) ? d.fps : 0;
    const rate = fr > 0 ? fr : base;
    return rate > 0 ? rate / every : 0;
}

/** 当前 [起点, 终点)（输出帧）。读取即钳制，不写回（显示越界由后端自己 min） */
function trimRange(node, total) {
    const s0 = Math.max(0, Math.round(wNum(node, "skip_first_frames", 0)));
    const cap = Math.round(wNum(node, "frame_load_cap", 0));
    const e0 = cap > 0 ? s0 + cap : total;
    const s = clampInt(s0, 0, Math.max(0, total - 1));
    const e = clampInt(e0, s + 1, Math.max(1, total));
    return [s, e];
}

/**
 * 上游接管检测（2026-10-20）。
 * widget 被转成 input 连了上游（数学表达式 / Primitive 数值）后，运行时 link 值覆盖 widget 值
 * ⇒ 拖动轴写回去也白写。表达式节点是运行才算的，前端拿不到真实值 ⇒ 半残的轴只能显示假位置，
 * 比不能拖更误导。正解：整轴进禁用态，tooltip 说清楚怎么恢复。
 * 返回被接管的参数名数组；无则 null。
 */
function trimUpstreamed(node) {
    const ins = node.inputs;
    if (!Array.isArray(ins)) return null;
    const hit = [];
    for (const i of ins) {
        if (!i) continue;
        if ((i.name === "skip_first_frames" || i.name === "frame_load_cap") && i.link != null) {
            hit.push(i.name);
        }
    }
    return hit.length ? hit : null;
}

/**
 * 选中段对应的原视频秒范围 [t0, t1]；拖动轴即预览播放范围（口径：轴上选哪段就播哪段）。
 * 裁剪到视频实际时长内；段太短（<0.1s）返回 null 不启用循环守卫。
 */
function trimLoopRange(node, sIn, eIn) {
    const vl = node._xhVL;
    const ve = vl && vl.videoEl;
    if (!ve) return null;
    const total = trimTotal(node);
    if (total <= 0) return null;
    const rate = trimRate(node);
    if (rate <= 0) return null;
    // 拖动态 widget 还没写回 ⇒ 必须允许调用方传入手里的 (s,e)，否则播放范围是旧段
    let s, e;
    if (sIn != null && eIn != null) {
        s = sIn; e = eIn;
    } else {
        const rg = trimRange(node, total);
        s = rg[0]; e = rg[1];
    }
    let t0 = s / rate;
    let t1 = e / rate;
    const dur = ve.duration;
    if (isFinite(dur) && dur > 0) {
        if (t0 > dur - 0.1) t0 = Math.max(0, dur - 0.1);
        if (t1 > dur) t1 = dur;
        if (t1 - t0 < 0.02) return null;   // 零长/亚半帧段才不启用（1 帧段=0.03~0.05s 要能循环）
    }
    return [t0, t1];
}

/** 写一个 widget 值并触发回调（hook 里包着 refreshInfo → 信息条「将加载 N 帧」跟着重算） */
function trimSetWidget(node, name, v) {
    const w = widget(node, name);
    if (!w) return;
    w.value = v;
    try { w.callback && w.callback(v, node, w); } catch (e) {}
    try { node.setDirtyCanvas?.(true, true); } catch (e) {}
}

/**
 * 拖动过程中让预览播放器跳到某一帧对应的位置。
 * ★ 2026-10-20 修「跳来跳去」：
 *   · 节流从「位置差 < 0.08s 跳过」改为「80ms 时间窗」——慢速精细拖时画面也跟手，
 *     快速拖时每 80ms 最多一次 seek，不产生 seeking 风暴；
 *   · 贴片尾从「跳过不 seek」改为「夹住到 dur-0.05」——否则手柄拖到末尾画面原地不动，
 *     视觉上像卡了一下。配合 beginDrag 的 pause()，seek 后不会自己继续播。
 */
function trimSeek(node, frame) {
    const vl = node._xhVL;
    if (!vl || !vl.videoEl || vl.previewOn === false) return;
    const rate = trimRate(node);
    if (rate <= 0) return;
    const now = (window.performance && performance.now) ? performance.now() : Date.now();
    const last = vl.trimLastSeek;
    if (last != null && now - last < 80) return;
    vl.trimLastSeek = now;
    let t = frame / rate;
    try {
        const dur = vl.videoEl.duration;
        if (isFinite(dur) && dur > 0) {
            if (t < 0) t = 0;
            if (t > dur - 0.05) t = dur - 0.05;   // 贴片尾夹住，不跳过不抖
        }
        vl.videoEl.currentTime = t;
    } catch (e) {}
}

function makeTrimBar(node) {
    const el = document.createElement("div");
    el.style.cssText =
        "display:block;width:100%;box-sizing:border-box;padding:2px 0 4px;margin:0;"
        + `font-family:${FONT_STACK};user-select:none;`;

    // 顶行：起 / 止 / 长 三段（禁用态整行变提示文案）
    const line = document.createElement("div");
    line.style.cssText =
        "display:flex;justify-content:space-between;align-items:center;gap:6px;"
        + "font-size:11px;font-weight:600;color:#cfd6df;height:16px;line-height:16px;"
        + "white-space:nowrap;overflow:hidden;";

    // 轨道 + 已选段 + 双手柄
    const track = document.createElement("div");
    track.style.cssText =
        "position:relative;width:100%;height:10px;margin:7px 0 3px;border-radius:5px;"
        + `background:${C_TRIM_TRACK};cursor:pointer;box-sizing:border-box;`;
    const sel = document.createElement("div");
    sel.style.cssText =
        "position:absolute;left:0;top:0;height:10px;border-radius:5px;display:none;"
        + `background:${C_TRIM_SEL};cursor:move;`;
    const mkHandle = () => {
        const h = document.createElement("div");
        h.style.cssText =
            "position:absolute;top:-8px;width:14px;height:26px;display:none;cursor:ew-resize;";
        const bar = document.createElement("div");
        bar.style.cssText =
            "position:absolute;left:4px;top:3px;width:6px;height:20px;border-radius:3px;"
            + `background:${C_TRIM_HANDLE};border:1px solid ${C_TRIM_BD};box-sizing:border-box;`;
        h.appendChild(bar);
        return h;
    };
    const hL = mkHandle();
    const hR = mkHandle();
    track.appendChild(sel);
    track.appendChild(hL);
    track.appendChild(hR);
    el.appendChild(line);
    el.appendChild(track);

    // 不吃画布手势（拖节点请抓标题栏；把手势全拦在容器上）
    ["pointerdown", "mousedown", "dblclick", "keydown", "click", "wheel"].forEach((ev) =>
        el.addEventListener(ev, (e) => e.stopPropagation()));

    const vl = node._xhVL;
    vl.trimEl = el;
    vl.trimLine = line;
    vl.trimTrack = track;
    vl.trimSel = sel;
    vl.trimHL = hL;
    vl.trimHR = hR;
    vl.trimDrag = null;       // "L" | "R" | "M" | null
    vl.trimS = null;
    vl.trimE = null;
    vl.trimWasPlaying = false;   // 按下手柄时是否在播：停手后据此决定要不要恢复播放
    vl.trimLoop = null;          // 选中段的秒范围 [t0,t1]：预览只循环这一段（null=不限制）

    // ---- 命中与拖动 -------------------------------------------------------
    // L / R 单手柄；M = 中段整体平移（长度不变）；track 空白 = 就近移动最近手柄
    const beginDrag = (which, ev) => {
        const total = trimTotal(node);
        if (total <= 0) return;
        if (trimUpstreamed(node)) return;   // 上游接管中：轴已禁用，别启动拖动
        const w = vl.trimTrack.clientWidth || 1;
        vl.trimTrackW = w;
        vl.trimRectX = vl.trimTrack.getBoundingClientRect().left;
        const [s0, e0] = trimRange(node, total);
        vl.trimS0 = s0;
        vl.trimE0 = e0;
        vl.trimStartX = ev.clientX;
        vl.trimDrag = which;
        vl.trimLastSeek = null;
        try { ev.currentTarget.setPointerCapture(ev.pointerId); } catch (e) {}
        // ★ 2026-10-20 修「跳来跳去」：拖动期间先暂停循环播放。
        //   否则视频自己往后跑、seek 每 80ms 追一次手柄 ⇒ 视频在播/手柄在拽/seek 反复拉回。
        //   记住原播放态，endDrag 据此恢复（用户手动暂停过就不恢复）。
        try {
            if (vl.videoEl) {
                vl.trimWasPlaying = !vl.videoEl.paused && !vl.videoEl.ended;
                vl.videoEl.pause();
            }
        } catch (e) {}
        if (which === "L" || which === "R") trimDragTo(node, ev.clientX, which);
    };
    const moveDrag = (ev) => {
        const which = vl.trimDrag;
        if (!which) return;
        if (which === "M") {
            const total = trimTotal(node);
            const len = Math.max(1, vl.trimE0 - vl.trimS0);
            const df = (ev.clientX - vl.trimStartX) / vl.trimTrackW * total;
            const s = clampInt(vl.trimS0 + df, 0, total - len);
            const e = s + len;
            vl.trimS = s;
            vl.trimE = e;
            trimPaintAt(node, s, e);
            trimSeek(node, s);
        } else {
            trimDragTo(node, ev.clientX, which);
        }
    };
    const endDrag = (ev) => {
        const which = vl.trimDrag;
        if (!which) return;
        vl.trimDrag = null;
        try { ev.currentTarget.releasePointerCapture(ev.pointerId); } catch (e) {}
        if (vl.trimS != null && vl.trimE != null) {
            const s = vl.trimS;
            const e = vl.trimE;
            vl.trimS = null;
            vl.trimE = null;
            vl.trimLastSeek = null;
            trimSetWidget(node, "skip_first_frames", s);
            trimSetWidget(node, "frame_load_cap", Math.max(1, e - s));
        }
        // 停手：按下前是播放态就接着放（从当前手柄位置继续，保持连贯观感）；
        // 原本就暂停 / 预览关 / 没视频元素 → 保持静止。
        // 段外位置先拉回段头再播（80ms 节流可能让最后一次 seek 被跳过 → 播放头留在旧位置）
        try {
            if (vl.trimWasPlaying && vl.previewOn !== false && vl.videoEl) {
                const rg = vl.trimLoop;
                if (rg && (vl.videoEl.currentTime < rg[0] - 0.05 || vl.videoEl.currentTime > rg[1] - 0.02)) {
                    vl.videoEl.currentTime = rg[0];
                }
                const p = vl.videoEl.play?.();
                if (p && p.catch) p.catch(() => {});
            }
        } catch (e) {}
        vl.trimWasPlaying = false;
    };

    function trimDragTo(n, clientX, which) {
        const total = trimTotal(n);
        if (total <= 0) return;
        const f = Math.round((clientX - vl.trimRectX) / vl.trimTrackW * total);
        let s = vl.trimS0;
        let e = vl.trimE0;
        if (which === "L") s = clampInt(f, 0, e - 1);
        else e = clampInt(f, s + 1, total);
        vl.trimS = s;
        vl.trimE = e;
        trimPaintAt(n, s, e);
        trimSeek(n, which === "L" ? s : e - 1);
    }

    const bindEl = (el2, which, onDown) => {
        el2.addEventListener("pointerdown", (ev) => {
            ev.stopPropagation();
            const w = onDown ? onDown(ev) : which;   // track 的 which 现场定（就近半边）
            if (!w) return;
            beginDrag(w, ev);
        });
        el2.addEventListener("pointermove", (ev) => { ev.stopPropagation(); moveDrag(ev); });
        const end = (ev) => { ev.stopPropagation(); endDrag(ev); };
        el2.addEventListener("pointerup", end);
        el2.addEventListener("pointercancel", end);
    };
    bindEl(hL, "L");
    bindEl(hR, "R");
    bindEl(sel, "M");
    // 轨道空白：点了哪半边就近移动哪一端（which 现场决定，返回 null = 不启动拖动）
    bindEl(track, null, (ev) => {
        if (ev.target !== track) return null;       // 冒泡到的不算（双保险）
        const total = trimTotal(node);
        if (total <= 0) return null;
        const rect = vl.trimTrack.getBoundingClientRect();
        const f = (ev.clientX - rect.left) / (vl.trimTrack.clientWidth || 1) * total;
        const [s0, e0] = trimRange(node, total);
        return f < (s0 + e0) / 2 ? "L" : "R";
    });

    let w = null;
    try {
        w = node.addDOMWidget(TRIM_WIDGET, "custom", el, {
            serialize: false,
            hideOnZoom: false,
            getMinHeight: () => TRIM_H,
        });
    } catch (e) {
        console.warn("[XH LoadVideo] 拖动轴挂载失败:", e);
    }
    if (w) {
        lockDomWidgetHeight(w, TRIM_H);
        try {
            w.serialize = false;
            if (w.options) w.options.serialize = false;
            w.serializeValue = () => undefined;
        } catch (e) {}
    }
    vl.trimWidget = w;
    return w;
}

/** 只在拖动过程中调用：按传入位置画（不读 widget，避免和 pointerup 的写回打架） */
function trimPaintAt(node, s, e) {
    const vl = node._xhVL;
    if (!vl || !vl.trimEl) return;
    const total = trimTotal(node);
    if (total <= 0) return;
    const lp = (s / total) * 100;
    const rp = (e / total) * 100;
    vl.trimSel.style.left = lp + "%";
    vl.trimSel.style.width = (rp - lp) + "%";
    vl.trimSel.style.display = "block";
    vl.trimHL.style.left = `calc(${lp}% - 7px)`;
    vl.trimHL.style.display = "block";
    vl.trimHR.style.left = `calc(${rp}% - 7px)`;
    vl.trimHR.style.display = "block";
    const rate = trimRate(node);
    const t0 = rate > 0 ? s / rate : 0;
    const t1 = rate > 0 ? e / rate : 0;
    paintTrimLine(node, s, e, t0, t1);
    vl.trimLoop = trimLoopRange(node, s, e);   // 选段即播放范围：拖到哪，预览循环到哪
}

/** 全量重画（读 widget 当前值）。任何参数变化 / 语言切换 / probe 回来都调它 */
function paintTrim(node) {
    const vl = node._xhVL;
    if (!vl || !vl.trimEl) return;
    const total = trimTotal(node);
    const up = trimUpstreamed(node);
    const off = !(total > 0) || !!up;
    vl.trimEl.style.opacity = off ? "0.55" : "1";
    vl.trimTrack.style.background = off ? "#232830" : C_TRIM_TRACK;
    vl.trimTrack.style.cursor = off ? "default" : "pointer";
    if (off) {
        vl.trimSel.style.display = "none";
        vl.trimHL.style.display = "none";
        vl.trimHR.style.display = "none";
        // 上游接管 ≠ 没选文件：文案分开，禁用态下播放范围也解禁（那归上游管）
        vl.trimLoop = null;
        vl.trimLine.textContent = up ? T(node, "trimUpstream") : T(node, "trimDisabled");
        vl.trimEl.title = up ? T(node, "trimUpstream") : T(node, "trimDisabled");
        return;
    }
    const [s, e] = trimRange(node, total);
    trimPaintAt(node, s, e);
    const tip = T(node, "trimTip")
        + (wNum(node, "force_rate", 0) > 0 || wNum(node, "select_every_nth", 1) > 1
            ? "\n" + T(node, "trimResampled") : "");
    vl.trimEl.title = tip;
}

function paintTrimLine(node, s, e, t0, t1) {
    const vl = node._xhVL;
    if (!vl || !vl.trimLine) return;
    const len = e - s;
    const span = document.createElement("span");
    span.textContent = "起 " + trimTC(t0);
    const span2 = document.createElement("span");
    span2.textContent = "止 " + trimTC(t1);
    const span3 = document.createElement("span");
    const dur = isFinite(t1 - t0) ? (t1 - t0).toFixed(1) : "0.0";
    span3.textContent = "长 " + dur + "s · " + len + " 帧";
    vl.trimLine.textContent = "";
    vl.trimLine.appendChild(span);
    vl.trimLine.appendChild(span2);
    vl.trimLine.appendChild(span3);
}

/** 参数变化后把越界的 skip 拉回合法范围（every 调大后 total 变小，老 skip 可能越界） */
function clampTrim(node) {
    // ⛔ 2026-10-20 拖动轴已取消 → 没有轴就别再回写 skip_first_frames 了。
    //    尤其在 ⏱ 时间段模式下更要住手：那两个帧参数本就不参与计算，改了只会
    //    静默污染用户存档里的数值（切回帧模式时会发现值被改过）。
    const vl0 = node && node._xhVL;
    if (!vl0 || !vl0.trimEl) return;
    const total = trimTotal(node);
    if (total <= 0) return;
    const s = Math.max(0, Math.round(wNum(node, "skip_first_frames", 0)));
    if (s > total - 1) trimSetWidget(node, "skip_first_frames", Math.max(0, total - 1));
}

// ---------------------------------------------------------------------------
// ⑦ 控件顺序：工具条 → 视频下拉 → [拖动轴 + 6 个高级参数，⚙ 折叠] → 信息条（恒显、紧贴播放框）→ 播放框（沉底）
//    DOM 控件都是 serialize:false，改顺序不影响存档（与 kit 的 pinWidgetToTop 同理）
// ---------------------------------------------------------------------------
function arrangeWidgets(node) {
    const w = node.widgets;
    if (!Array.isArray(w)) return;
    const byName = (n) => w.find((x) => x && x.name === n) || null;
    const head = [BAR_WIDGET, "video"].map(byName).filter(Boolean);
    // 2026-10-20：拖动轴已取消，高级参数区直接就是 ADV_KEYS（⏱ start_sec/duration 在列）
    const mid = [...ADV_KEYS].map(byName).filter(Boolean);
    const tail = [INFO_WIDGET, PLAYER_WIDGET].map(byName).filter(Boolean);  // 信息条恒显在前、播放框沉底在后
    if (head.length < 2) return;
    w.length = 0;
    w.push(...head, ...mid, ...tail);
}

// ---------------------------------------------------------------------------
// 存档纠偏（本节点有 3 个 DOM 控件，kit 版只按 1 个过滤 → 这里自己来一遍）
// ---------------------------------------------------------------------------
function fixSavedValues(node, saved) {
    if (!node || !Array.isArray(node.widgets) || !saved) return;
    const real = node.widgets.filter((w) => w && DOM_WIDGETS.indexOf(w.name) === -1);
    if (!real.length) return;
    const dirty = () => { try { node.setDirtyCanvas?.(true, true); } catch (e) {} };
    const isBlank = (x) => x === "" || x === null || x === undefined;

    // ① 有 widgets_values_named → 按名字回填（与顺序无关，永远最可靠）
    const named = saved.widgets_values_named;
    if (named && typeof named === "object") {
        for (const w of real) {
            if (!(w.name in named)) {
                if (["start_sec", "duration", "start_frame", "frame_count"].includes(w.name)) w.value = 0;
                continue;
            }
            const v = named[w.name];
            if (v === undefined) continue;
            if (w.type === "combo" && Array.isArray(w.options && w.options.values)
                && !w.options.values.includes(v)) continue;
            w.value = v;
        }
        dirty();
        return;
    }

    // ② 老存档（只有 widgets_values）→ 先剔掉 DOM 控件留下的空槽，再按位回填。
    //    本节点的原生控件里没有「合法空值」（下拉是文件名、其余全是数字），所以
    //    直接丢掉所有空槽是安全的；数量对不上就**不动**（宁可不动，也不乱写）。
    const vals = saved.widgets_values;
    if (!Array.isArray(vals) || !vals.length) return;
    const arr = vals.filter((v) => !isBlank(v));
    if (arr.length === 7) {
        const names = ["video", "force_rate", "custom_width", "custom_height",
            "frame_load_cap", "skip_first_frames", "select_every_nth"];
        const legacy = Object.fromEntries(names.map((name, i) => [name, arr[i]]));
        fixSavedValues(node, { widgets_values_named: legacy });
        return;
    }
    if (arr.length !== real.length) return;
    real.forEach((w, i) => {
        let v = arr[i];
        if ((w.type === "boolean" || w.type === "toggle") && typeof v === "number") v = !!v;
        w.value = v;
    });
    dirty();
}

// ---------------------------------------------------------------------------
// 语言
// ---------------------------------------------------------------------------
function applyLang(node, lang) {
    if (!node) return;
    lang = lang || window.XH_LANG || "zh";
    try {
        const want = t(lang, "nodes", NODE_TYPE);
        const zhT = XH_I18N.zh.nodes[NODE_TYPE];
        const enT = XH_I18N.en.nodes[NODE_TYPE];
        if (want && (!node.title || node.title === zhT || node.title === enT)) node.title = want;

        for (const w of (node.widgets || [])) {
            if (!w || !w.name) continue;
            const lb = t(lang, "widgets", w.name);
            if (lb) w.label = lb;
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

        // 上传按钮文案（上传中/成功态不覆盖）
        if (node._xhVLBtnTip && !node._xhVLBtnBusy) {
            try { node._xhVLBtnTip(T(node, "upload")); } catch (e) {}
        }
        paintGear(node);
        paintPreview(node);
        refreshPlayerText(node);

        try {
            node.graph?.trigger?.("node:slot-label:changed", { nodeId: node.id, slotType: 1 });
            node.graph?.trigger?.("node:slot-label:changed", { nodeId: node.id, slotType: 2 });
        } catch (e) {}
        refreshInfo(node, false);
        paintTrim(node);
        try { node.setDirtyCanvas?.(true, true); } catch (e) {}
    } catch (e) {
        console.warn("[XH LoadVideo] 应用语言失败:", e);
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

// 尽力找「节点根 DOM 容器」（拖拽热区）—— Vue 节点结构与 canvas 模式不同，多级 fallback
function findRootEl(node, anyEl) {
    if (!anyEl) return null;
    try {
        const byTest = anyEl.closest && (anyEl.closest('[data-testid="node"]')
            || anyEl.closest(".lg-node") || anyEl.closest("[data-node-id]"));
        if (byTest) return byTest;
    } catch (e) {}
    let p = anyEl;
    for (let i = 0; i < 3 && p && p.parentElement; i++) p = p.parentElement;
    return p || anyEl;
}

// ---------------------------------------------------------------------------
// 注册
// ---------------------------------------------------------------------------
app.registerExtension({
    name: "XH.LoadVideo",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_TYPE) return;

        const origOnCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = origOnCreated?.apply(this, arguments);
            try {
                const node = this;

                // 🔴 先把状态挂上，再让任何 helper 用它 —— 否则 "Cannot set properties of
                //    undefined" 会被下面的 try 吞掉，后面整段界面代码全都不执行（假绿）。
                node._xhVL = {
                    collapsed: true,        // 默认收起高级参数
                    previewOn: true,        // ▶ 预览总开关（关 = 卸流不播放；可从 properties 恢复）
                    ar: 0,                  // 视频宽高比（loadedmetadata 后才有）
                    hasFile: false,
                    curFile: "",
                    err: false,
                    stamp: 0,
                    data: null,
                };

                // 隐藏的文件选择器（挂 body，节点删了再移除）
                const fileInput = document.createElement("input");
                fileInput.type = "file";
                fileInput.accept = "video/mp4,video/webm,video/x-matroska,video/quicktime,.mp4,.mkv,.webm,.mov,.gif";
                fileInput.style.display = "none";
                document.body.appendChild(fileInput);
                node._xhVLFileInput = fileInput;

                const uploadBtn = makeUploadButton(node, fileInput);
                const previewBtn = makePreviewButton(node);
                const gearBtn = makeGearButton(node);

                // 标准工具条（中/EN + 🎨）＋ 上传 ＋ ▶预览开关 ＋ ⚙
                // 家族唯一实现见 web/xh_ui_kit.js
                // ★ 2026-10-20 齿轮统一：**⚙ 排工具条最左**（prependNodes），家族 4 个齿轮节点一致
                const { bar, langBtn } = makeXHToolbar(node, {
                    prependNodes: [gearBtn],
                    appendNodes: [uploadBtn, previewBtn],
                });
                node._xhLangBtn = langBtn;

                wireUpload(node, fileInput, uploadBtn);
                makeInfoBar(node);
                makePlayer(node);
                // ⛔ 2026-10-20 取消截取拖动轴：不再创建，改由 ⏱ start_sec / duration 两个
                //    可接线输入框承担「选段」职责（手动填 或 接 🔁XH-分段表 做循环换段）。
                //    paintTrim / clampTrim 内部都有 `if (!vl.trimEl) return` 守卫，不创建即安全空转。
                // makeTrimBar(node);
                arrangeWidgets(node);

                node._xhVL.rootEl = findRootEl(node, node._xhVL.infoEl || bar);
                node._xhVL.barEl = bar;
                attachDrop(node);

                // 宽度一变，播放器高度要跟着重算（按宽高比铺满）
                const origResize = node.onResize;
                node.onResize = function () {
                    const rr = origResize?.apply(this, arguments);
                    try { applyPlayerBox(node); } catch (e) {}
                    return rr;
                };

                // 参数一改就重算信息条（包住原回调，绝不覆盖）
                // ⏱ start_sec / duration、🎯 start_frame / frame_count 也在列：
                //    改这些框时信息条要跟着重算「选段 / 将加载帧数」
                for (const nm of ["video", "force_rate", "custom_width", "custom_height",
                    "frame_load_cap", "skip_first_frames", "select_every_nth",
                    "start_sec", "duration", "start_frame", "frame_count"]) {
                    const wd = widget(node, nm);
                    if (!wd || wd._xhVLHooked) continue;
                    wd._xhVLHooked = true;
                    const orig = wd.callback;
                    wd.callback = function () {
                        const rr = orig ? orig.apply(this, arguments) : undefined;
                        refreshInfo(node, nm === "video");
                        if (nm !== "video") { clampTrim(node); paintTrim(node); }   // 拖动轴跟着框走
                        if (nm === "video") syncPlayer(node);
                        return rr;
                    };
                }

                setCollapsed(node, true);
                applyLang(node);
                refreshInfo(node, true);
                syncPlayer(node);
            } catch (e) {
                console.warn("[XH LoadVideo] 界面创建失败:", e);
            }
            return r;
        };

        // 工作流载入 / 切换后：修 widgets 错位 + 重刷信息条与播放器
        const origOnConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (info) {
            const r = origOnConfigure?.apply(this, arguments);
            try {
                fixSavedValues(this, info);
                // 恢复 ▶ 预览总开关（存在 node.properties，不占 widgets_values、不挤参数）
                try {
                    const pv = this.properties ? this.properties.xhPreviewOn : undefined;
                    if (this._xhVL && pv !== undefined) this._xhVL.previewOn = pv !== false;
                    paintPreview(this);
                } catch (e) {}
                refreshInfo(this, true);
                syncPlayer(this);
                paintTrim(this);
                relayout(this);
            } catch (e) {}
            return r;
        };

        // 上游连上 / 断开（比如数学表达式控制帧数）：trim 轴禁用态要立刻跟着变。
        // litegraph 连断都会走 onConnectionsChange；Vue 节点连线同样经 litegraph.connect。
        const origOnConnChange = nodeType.prototype.onConnectionsChange;
        nodeType.prototype.onConnectionsChange = function (type, index, connected, linkInfo) {
            const rr = origOnConnChange ? origOnConnChange.apply(this, arguments) : undefined;
            try { if (this._xhVL) paintTrim(this); } catch (e) {}
            return rr;
        };

        const origOnRemoved = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function () {
            try { this._xhVLDropCleanup && this._xhVLDropCleanup(); } catch (e) {}
            try { this._xhVLFileInput && this._xhVLFileInput.remove(); } catch (e) {}
            try {
                const v = this._xhVL && this._xhVL.videoEl;
                if (v) { v.pause?.(); v.removeAttribute("src"); v.load?.(); }
            } catch (e) {}
            releaseButtons(this);
            return origOnRemoved?.apply(this, arguments);
        };
    },

    async setup() {
        onLangChanged(() => applyLangToAll());
    },
});
