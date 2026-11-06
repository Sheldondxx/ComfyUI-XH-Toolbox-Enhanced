// 🎵XH-加载音频 · 家族前端（2026-10-16 · v1）
//
// ① 中/EN 切换：节点标题 + 参数控件标签 + 输入/输出端口名
// ② 「⬆ 上传音频」= DOM 真按钮（家族绿 + 三层点击反馈）→ 上传进 input 目录并自动选中
// ③ 拖拽音频文件到节点直接上传（DOM dragover/drop + LiteGraph 老钩子，双保险）
// ④ **自绘播放器（本节点的正主）**：
//    · 粗时间线：10px 轨道 + 16px 圆形大拖把手 —— 官方 Load Audio 的原生进度条
//      只有 ~3px，拖拽极其难受（用户原话：「太细了，我拖拽都不方便」）。
//      这里：轨道任意位置**点一下跳转**、**按住拖动实时 seek**（pointer capture，
//      拖出节点外也不断）、拖动中把手放大。
//    · 播放 / 暂停按钮（内联 SVG 图标随状态切换）
//    · 时间显示 当前 / 总长（mm:ss）
//    · 音量：静音切换 + 滑块（用户 2026-10-16 明确要求做滑块）
// ⑤ 信息条：时长 · 采样率 · 声道 · 编码（走 /xh/audioload/probe 路由，点一下强制重读）
// ⑥ 节点自身配色 🎨（XH 家族 12 色 + 自定义取色器）
// ⑦ **实时频谱律动条（2026-10-16 用户点名要「能随着音频上下动的那个」）**：
//    播放器底部 40px 一排 32 根竖条，随音乐实时跳动 —— Web Audio API 的
//    AnalyserNode 对本节点自己的 <audio> 做实时 FFT，对数分组取峰值画条，
//    条顶带缓慢下落的峰值帽。AudioContext 全图共用一个（浏览器限量约 6 个），
//    createMediaElementSource 每元素只绑一次；播放起 rAF、暂停/结束/删节点停。
// ⑧ **📂 文件夹模式 + 循环轮次索引（2026-10-16，配 controls/audio_load.py）**：
//    · 来源切「📂 文件夹」→ 隐藏单文件下拉，工具栏多一颗「📂 文件夹」按钮
//      （webkitdirectory 选目录 / 粘贴路径均可），节点只记路径，出图时才读盘；
//    · 文件夹里的文件列表走后端 /xh/audiolist/list（只读预览，与后端同口径）；
//    · 播放 / 信息条预览「起始序号」指向的那个文件（与后端循环外口径一致），
//      走 /xh/audioload/file 流式路由（FileResponse 带 Range，seek 可用）；
//    · 循环体内实际放哪个文件由后端按注入的 xh_loop_turn 决定，前端不干预。
// ⑨ **普通 / 循环模式折叠（2026-10-16，用户原话「节点变得特别大了…普通模式下节点比较小」）**：
//    · 工具栏加「🔁 循环模式 / 🎵 普通模式」切换钮：普通模式只剩 audio 下拉 + 播放器
//      + 信息条（和加文件夹功能前一样大），循环模式展开四件套（隐藏 audio）。
//    · 折叠 = 家族标准**视觉隐藏**（computeSize=[0,0] + getMinHeight=0 +
//      computeLayoutSize=undefined + draw/mouse 空 + element display:none），
//      ⛔ 绝不 w.hidden（会牵连输入端口）、绝不 hardenNoSerialize（值丢 = 模式丢）。
//    · 模式状态**不单独存**：由 source 值推导（单文件=普通、📂文件夹=循环）⇒
//      老存档读进来默认小节点，新档存盘自动记住模式，零新增控件、零存档结构变动。
//
// ── 与官方不犯冲 ────────────────────────────────────────────────────────────
//   · 播放器 = 我们自己 createElement 的 <audio>（隐藏、无 controls），只挂在自己节点上；
//     官方 Load Audio 走官方那套（io.UploadType.audio + 原生控件），两套互不相干。
//   · 音频地址用官方公开路由 /view?filename=…&type=input —— 只「调用」，不重定义。
//   · 控件挂载用官方公开接口 node.addDOMWidget。
//
// ── 尺寸管理（与 xh_video_load.js 同一套结论，本机前端 1.55.14 源码级确认）─────
//   · Vue 节点模式（Nodes 2.0）：DOM 才是尺寸唯一真源，绝不能自己 setSize（会喂成增长环）。
//   · 老画布模式：官方自己在 _arrangeWidgets 里 setSize，我们照做。
//   · 播放器 / 信息条高度**固定**（89px / 26px）⇒ 用 kit 的 lockDomWidgetHeight
//     连 computeLayoutSize 一起撤（Vue 行高只看 hasLayoutSize，只写 computeSize 无效）。
//
// 铁律：只改 label / title，绝不改 name；DOM 控件 serialize:false 且只 append，禁止 unshift。
const { app } = window.comfyAPI.app;
const { api } = window.comfyAPI.api;

import {
    ensureLangBridge, makeXHToolbar, onLangChanged, releaseButtons, lockDomWidgetHeight,
 paintBarBtn} from "./xh_ui_kit.js";

ensureLangBridge();

const NODE_TYPE = "XHLoadAudio";
const GREEN = "#4BA14B";
// ★2026-10-20 方案 B：NAVY（工具条暗蓝底）已删，统一走 kit 的 BAR_COLORS.SURFACE
const RED = "#E53935";
// ★2026-10-20 方案 B：AMBER（琥珀模式钮）已删，改用 kit 的 paintBarBtn(btn,"neutral")
const BAR_WIDGET = "xh_ui_bar";
const INFO_WIDGET = "xh_audioload_info";
const PLAYER_WIDGET = "xh_audioload_player";
const LIST_WIDGET = "xh_audioload_list";   // ⑨-2 音频列表区（只在循环模式显示）
const LIST_H = 132;             // 列表区固定高（约 5 行；超出内部滚动，不撑爆节点）

const PLAYER_H = 89;            // 播放器固定高（控件行 33 + 时间线 10 + 频谱 46）
                                  // ⚠️ 实测口径：Vue 节点模式下行高按 min-content（=89），
                                  //    这里的值同时喂 lockDomWidgetHeight 与 playerEl 的 height，
                                  //    两边必须同一个数，否则老画布模式底部会留白。
const TRACK_H = 10;             // 时间线轨道粗（官方原生约 3px）
const HANDLE_D = 16;            // 拖把手直径
const SPEC_H = 40;              // 频谱律动条区高
const SPEC_BARS = 32;           // 频谱条数
const SPEC_GAP = 2;             // 条间距
const SPEC_CAP_H = 2;           // 峰值帽高
const SPEC_CAP_FALL = 0.972;    // 峰值帽每帧衰减（~60fps 下落速度）
// 本节点自己挂的 DOM 控件（不参与 widgets_values 序列化；纠偏时要跳过）
const DOM_WIDGETS = [BAR_WIDGET, INFO_WIDGET, PLAYER_WIDGET, LIST_WIDGET];

const XH_I18N = {
    zh: {
        nodes: { XHLoadAudio: "🎵XH-加载音频" },
        widgets: {
            audio: "音频文件",
            source: "音频来源",
            audio_folder: "文件夹路径",
            start_index: "起始序号",
            loop: "轮次绕回",
        },
        slots: { audio: "音频", file_index: "实际序号" },
        // 按钮 / 信息条
        upload: "上传音频",
        uploading: "上传中…",
        failed: "上传失败",
        notSelected: "未选择音频",
        noProbe: "（读不到音频信息）",
        sec: "秒",
        khz: "kHz",
        hz: "Hz",
        mono: "单声道",
        stereo: "立体声",
        channels: "声道",
        // 📂 文件夹模式
        folder: "📂 文件夹",
        folderTip: "选一个文件夹（里面每个音频 = 一段，配合「🔁 循环模式」按序播放）",
        folderOk: "✅ %d 个音频",
        folderFail: "⚠ %s",
        folderNoList: "📂 文件夹模式（文件列表读不到，重启 ComfyUI 后可预览）",
        folderEmpty: "📂 还没选文件夹（点工具栏「📂 文件夹」）",
        folderTag: "📂 %d/%d · %s",
        manualTag: "📋 %d/%d · %s",
        // 普通 / 循环模式折叠（⑨）
        // 按钮图标（两种语言同形）；完整说明放 title
        modeIconToFolder: "🔁",
        modeIconToFile: "🎵",
        modeToFolder: "🔁 循环模式",
        modeToFile: "🎵 普通模式",
        modeTip: "普通模式 = 只放一个音频（节点小）\n循环模式 = 按序播放一整批音频 + 轮次索引",
        // ⑨-2 手动清单 / 列表区
        addAudio: "⬆ 加音频",
        clearList: "清空",
        listEmpty: "（还没加音频：点「⬆ 加音频」从任意文件夹挑）",
        listTip: "拖着改顺序 · 点一下试听 · 点 ✕ 删掉",
        listTipFolder: "这个文件夹里的音频（按文件名顺序，只读）",
        rank: "第 %d 个",
        delOne: "删掉这一个",
        addOk: "✅ 加了 %d 个",
        addFail: "没加上（不是音频？）",
        clearConfirm: "再点一次确认清空",
        manualEmpty: "（清单是空的：点上面「⬆ 加音频」挑几个进来）",
        // 播放器
        loading: "正在读取音频信息…",
        cantPlay: "浏览器预览不了这种音频格式\n不影响正常加载，直接运行即可",
        play: "播放",
        pause: "暂停",
        mute: "静音",
        unmute: "取消静音",
        seekTip: "按住拖动跳转播放位置（也可以点一下直接跳）",
        volTip: "音量",
        noDuration: "读不到时长，进度条不可用",
    },
    en: {
        nodes: { XHLoadAudio: "XH Load Audio" },
        widgets: {
            audio: "audio file",
            source: "audio source",
            audio_folder: "folder path",
            start_index: "start index",
            loop: "wrap around",
        },
        slots: { audio: "audio", file_index: "file index" },
        upload: "Upload",
        uploading: "Uploading…",
        failed: "Upload failed",
        notSelected: "no audio selected",
        noProbe: "(cannot read audio info)",
        sec: "s",
        khz: "kHz",
        hz: "Hz",
        mono: "mono",
        stereo: "stereo",
        channels: "ch",
        folder: "📂 Folder",
        folderTip: "Pick a folder (each audio inside = one segment for loop mode)",
        folderOk: "✅ %d files",
        folderFail: "⚠ %s",
        folderNoList: "📂 folder mode (file list unavailable until restart)",
        folderEmpty: "📂 no folder picked (use the toolbar 📂 button)",
        folderTag: "📂 %d/%d · %s",
        manualTag: "📋 %d/%d · %s",
        // Basic / loop mode folding (⑨)
        modeIconToFolder: "🔁",
        modeIconToFile: "🎵",
        modeToFolder: "🔁 Loop mode",
        modeToFile: "🎵 Basic mode",
        modeTip: "Basic = single audio (small node)\nLoop = play a batch in order + turn index",
        // ⑨-2 manual list / list area
        addAudio: "⬆ Add audio",
        clearList: "Clear",
        listEmpty: "(none yet — click ⬆ Add audio and pick from any folder)",
        listTip: "Drag to reorder · click to preview · ✕ to remove",
        listTipFolder: "Audio in this folder (by file name, read-only)",
        rank: "#%d",
        delOne: "Remove this one",
        addOk: "✅ added %d",
        addFail: "not added (not an audio file?)",
        clearConfirm: "click again to confirm",
        manualEmpty: "(list is empty — click ⬆ Add audio above)",
        loading: "Reading audio info…",
        cantPlay: "Browser can't preview this audio format\nLoading still works — just run it",
        play: "Play",
        pause: "Pause",
        mute: "Mute",
        unmute: "Unmute",
        seekTip: "Drag to seek (or click to jump)",
        volTip: "Volume",
        noDuration: "No duration available — seek bar disabled",
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

function wStr(node, name) {
    const w = widget(node, name);
    return w && w.value != null ? String(w.value) : "";
}

/**
 * 🔴 家族标准「视觉隐藏 / 恢复」一个原生控件：
 *    · **Vue Nodes 模式只认 w.hidden**（2026-10-16 真机实锤：computeSize=[0,0] 对 Vue
 *      完全无效——Vue 用自己的 DOM 布局，节点实测 405px 纹丝不动；w.hidden=true 才不渲染该行）。
 *      ⛔ 所以 w.hidden 只对**没有输入端口**的控件安全（会连端口一起藏），本节点的
 *      audio / source / audio_folder / start_index / loop 全是纯控件无端口 ⇒ 安全。
 *    · 老画布模式：computeSize=[0,0] + getMinHeight=0 + computeLayoutSize=undefined
 *      + draw/mouse 空 + element display:none（canvas 侧靠这套）。
 *    ⛔ 绝不碰 serialize（值丢了 = 模式/存档丢了）。
 * @param hidden true=藏 false=显（幂等：同一状态重复调用直接返回）
 */
function setWidgetHiddenVis(node, name, hidden) {
    const w = widget(node, name);
    if (!w || w._xhALVis === hidden) return;
    w._xhALVis = hidden;
    // 🟢 Vue Nodes 模式：w.hidden 才是唯一有效的开关（见上方 docstring 实锤）
    try { w.hidden = hidden; } catch (e) {}
    // 🔴 原方法**只在第一次**落档，且不论这次是藏还是显都要落 —— 否则首次调用就是
    //    「显示」分支时 orig 为空 ⇒ 恢复会写回 undefined，控件高度直接崩。
    if (!w._xhALOrigFns) {
        w._xhALOrigFns = {
            computeSize: w.computeSize,
            getMinHeight: w.getMinHeight,
            hasLayout: "computeLayoutSize" in w,
            computeLayoutSize: w.computeLayoutSize,
            draw: w.draw,
            mouse: w.mouse,
        };
    }
    if (hidden) {
        try { w.computeSize = () => [0, 0]; } catch (e) {}
        try { w.getMinHeight = () => 0; } catch (e) {}
        try { delete w.computeLayoutSize; } catch (e) {}
        try { w.draw = () => {}; } catch (e) {}
        try { w.mouse = () => false; } catch (e) {}
        if (w.element) { try { w.element.style.display = "none"; } catch (e) {} }
    } else {
        const o = w._xhALOrigFns || {};
        // 🔴 原方法多半是**原型上继承来的**：恢复时「有就赋值、没有就删掉 own 属性」，
        //    绝不写 own undefined —— 那会遮蔽原型方法，控件高度直接崩。
        const restore = (k) => {
            try {
                if (o[k] === undefined) { delete w[k]; } else { w[k] = o[k]; }
            } catch (e) {}
        };
        restore("computeSize");
        restore("getMinHeight");
        restore("draw");
        restore("mouse");
        try {
            if (o.hasLayout) w.computeLayoutSize = o.computeLayoutSize;
            else delete w.computeLayoutSize;
        } catch (e) {}
        if (w.element) { try { w.element.style.display = ""; } catch (e) {} }
    }
    try { node.setDirtyCanvas?.(true, true); node.graph?.setDirtyCanvas?.(true, true); } catch (e) {}
}

/** 秒 → mm:ss（超过 1 小时用 h:mm:ss） */
function fmtTime(sec) {
    if (!isFinite(sec) || sec < 0) return "--:--";
    let s = Math.floor(sec % 60);
    let m = Math.floor(sec / 60) % 60;
    const h = Math.floor(sec / 3600);
    const pad = (n) => (n < 10 ? "0" + n : "" + n);
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function fmtHz(hz) {
    if (!isFinite(hz) || hz <= 0) return "?";
    if (hz >= 1000) {
        // 恒定一位小数：44.1kHz 是音乐标配，不能为了「整数好看」把它显示成 44
        return (hz / 1000).toFixed(1) + " " + T(null, "khz");
    }
    return hz + " " + T(null, "hz");
}

function chName(ch) {
    const c = parseInt(ch, 10) || 0;
    if (c === 1) return T(null, "mono");
    if (c === 2) return T(null, "stereo");
    if (c > 2) return c + " " + T(null, "channels");
    return "?";
}

// DOM 控件内部的图标一律内联 SVG（家族铁律：emoji 在 Windows 会渲染成彩色字/错位）
const SVG_UPLOAD =
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
    + 'stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" style="display:block">'
    + '<path d="M12 16V4"/><path d="m6 10 6-6 6 6"/><path d="M4 20h16"/></svg>';

const SVG_PLAY =
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" style="display:block">'
    + '<path d="M8 5.14v13.72a.6.6 0 0 0 .91.51l11.1-6.86a.6.6 0 0 0 0-1.02L8.91 4.63A.6.6 0 '
    + '0 0 8 5.14z"/></svg>';

const SVG_PAUSE =
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" style="display:block">'
    + '<rect x="6" y="5" width="4.2" height="14" rx="1.3"/><rect x="13.8" y="5" width="4.2" '
    + 'height="14" rx="1.3"/></svg>';

// 喇叭（有声）—— material volume_up 原路径
const SVG_VOLUME =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style="display:block">'
    + '<path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 '
    + '2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 '
    + '6.71v2.06c4-.91 7-4.49 7-8.77s-3-7.86-7-8.77z"/></svg>';

// 喇叭 + 斜线（静音）
const SVG_MUTE =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style="display:block">'
    + '<path d="M7 9v6h4l5 5V4L11 9H7z"/>'
    + '<path d="M16 8.5l5 7M21 8.5l-5 7" stroke="currentColor" stroke-width="2.1" fill="none" '
    + 'stroke-linecap="round"/></svg>';

// 音量滑块样式（pseudo 元素没法内联，注入一个全局 <style>，防重复注入）
let _STYLE_DONE = false;
function ensureStyle() {
    if (_STYLE_DONE) return;
    _STYLE_DONE = true;
    try {
        const st = document.createElement("style");
        st.id = "xh-audioload-style";
        st.textContent =
            ".xh-al-range{-webkit-appearance:none;appearance:none;background:transparent;"
            + "outline:none;cursor:pointer;flex:0 0 auto;}"
            + ".xh-al-range::-webkit-slider-runnable-track{height:4px;border-radius:2px;"
            + "background:rgba(255,255,255,.28);}"
            + ".xh-al-range::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;"
            + "width:10px;height:10px;border-radius:50%;background:#fff;margin-top:-3px;"
            + "box-shadow:0 0 0 1px rgba(0,0,0,.35);}"
            + ".xh-al-range::-moz-range-track{height:4px;border-radius:2px;"
            + "background:rgba(255,255,255,.28);}"
            + ".xh-al-range::-moz-range-thumb{width:10px;height:10px;border:none;border-radius:50%;"
            + "background:#fff;box-shadow:0 0 0 1px rgba(0,0,0,.35);}";
        document.head.appendChild(st);
    } catch (e) {}
}

// ---------------------------------------------------------------------------
// 上传（照家族 xh_video_load.js 的写法：api.fetchApi("/upload/image")）
// ---------------------------------------------------------------------------
async function uploadToInput(file) {
    const fd = new FormData();
    fd.append("image", file, file.name);
    fd.append("type", "input");
    const resp = await api.fetchApi("/upload/image", { method: "POST", body: fd });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText || ""}`);
    return await resp.json();      // {name, subfolder, type}
}

function looksAudio(file) {
    // 官方 LoadAudio 的下拉里 audio + video 都列（有些视频只剩音轨可用），上传同样放宽
    if (/^audio\//.test(file.type || "")) return true;
    if (/^video\//.test(file.type || "")) return true;
    return /\.(wav|mp3|flac|m4a|aac|ogg|opus|webm|wma|aiff?|caf|mp4|mkv|mov)$/i
        .test(file.name || "");
}

function selectAudio(node, name) {
    const w = widget(node, "audio");
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
    paintBarBtn(btn, "primary");
    btn.style.display = "inline-flex";
    btn.style.gap = "5px";
    btn.style.boxSizing = "border-box";
    btn.style.borderRadius = "4px";     // 4px = 家族统一圆角（原 5px）
    btn.style.transition = "transform .08s ease,filter .12s ease";
    const icon = document.createElement("span");
    icon.innerHTML = SVG_UPLOAD;
    icon.style.cssText = "display:inline-flex;align-items:center;";
    const label = document.createElement("span");
    btn.appendChild(icon);
    btn.appendChild(label);

    const setLabel = (s) => { label.textContent = s; };
    setLabel(T(node, "upload"));
    node._xhALBtnTip = setLabel;

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
        try { node._xhALBtnTip && node._xhALBtnTip(s); } catch (e) {}
    };
    const doUpload = async (file) => {
        if (!file) return false;
        if (!looksAudio(file)) {
            setLabel(T(node, "failed"));
            setTimeout(() => setLabel(T(node, "upload")), 1600);
            return false;
        }
        if (btn) { btn.disabled = true; }
        node._xhALBtnBusy = true;
        setLabel(T(node, "uploading"));
        try {
            const info = await uploadToInput(file);
            const name = info && info.name ? info.name : file.name;
            selectAudio(node, name);
            setLabel(`✅ ${name.length > 14 ? name.slice(0, 13) + "…" : name}`);
            setTimeout(() => setLabel(T(node, "upload")), 1800);
            return true;
        } catch (e) {
            console.warn("[XH LoadAudio] 上传失败:", e);
            setLabel(T(node, "failed"));
            setTimeout(() => setLabel(T(node, "upload")), 1600);
            return false;
        } finally {
            node._xhALBtnBusy = false;
            if (btn) { btn.disabled = false; }
        }
    };

    fileInput.addEventListener("change", async () => {
        const f = fileInput.files && fileInput.files[0];
        fileInput.value = "";
        await doUpload(f);
    });

    node._xhALDoUpload = doUpload;
}

// 拖拽上传：DOM 事件（Vue 节点必走）+ LiteGraph 老钩子（canvas 模式）双保险
function attachDrop(node) {
    const el = (node._xhAL && node._xhAL.rootEl) || null;
    const doUpload = (file) => node._xhALDoUpload && node._xhALDoUpload(file);

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
        node._xhALDropCleanup = () => {
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
// ⑧ 📂 文件夹模式 + 循环轮次索引（2026-10-16，与 xh_chainprompt.js 同一套范式）
//    节点只记文件夹路径；文件列表走后端 /xh/audiolist/list（只读预览）；
//    播放走 /xh/audioload/file 流式路由（FileResponse 带 Range，seek 可用）。
//    循环体内实际放哪个文件由后端按注入的 xh_loop_turn 决定，前端只做预览。
// ---------------------------------------------------------------------------
const SRC_FILE = "单文件";
const SRC_FOLDER = "📂 文件夹";
const SRC_MANUAL = "📋 手动清单";    // ⑨-2：自己一个个挑，顺序自己定（可跨文件夹）
// 序号徽章配色：前 3 名金 / 银 / 铜，其余家族蓝（与 🖼️XH-图片列表逐字一致）
const RANK_COLORS = ["#e6b800", "#9aa7b3", "#cd7f32", "#3a7bd5"];
function rankColor(i) { return RANK_COLORS[i] || "#3a7bd5"; }

let _xhALDirInput = null;      // 隐藏的「选择文件夹」输入（webkitdirectory），全局复用一份
let _xhALTaskNode = null;      // 系统选择器关闭后，知道把路径写回哪个节点

// 路径清洗（照抄 xh_chainprompt.js）：资源管理器/浏览器/Git-Bash 各种粘法都认
function cleanPath(s) {
    let p = String(s || "").trim();
    if (!p) return "";
    const isUNC = p.startsWith("\\\\");
    if ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'")))
        p = p.slice(1, -1).trim();
    p = p.replace(/^file:\/\/\/?/i, "");
    const m = p.match(/^\/([a-zA-Z])\/(.*)$/);
    if (m) p = `${m[1].toUpperCase()}:/${m[2]}`;
    p = p.replace(/\\/g, "/").replace(/\/+$/, "");
    if (!isUNC) p = p.replace(/\/{2,}/g, "/");
    if (/^[a-zA-Z]:$/.test(p)) p += "/";
    return p;
}

// 系统「选择文件夹」对话框：Chromium / Electron 都支持 webkitdirectory
function ensureDirInput() {
    if (_xhALDirInput) return _xhALDirInput;
    const inp = document.createElement("input");
    inp.type = "file";
    inp.webkitdirectory = true;
    inp.multiple = true;
    inp.style.display = "none";
    inp.addEventListener("change", (e) => {
        e.stopPropagation();
        const files = Array.from(inp.files || []);
        inp.value = "";
        if (!files.length) return;
        const node = _xhALTaskNode;
        // 绝对路径：Electron（桌面版）直接挂在 File.path 上；纯浏览器沙箱拿不到 → 提示改用粘贴
        let abs = "", first = null;
        for (const f of files) {
            const pp = f.path || f.__electronPath || "";
            if (pp) { first = f; abs = pp; break; }
        }
        if (!abs) {
            console.warn("[XH LoadAudio] 无法读取文件夹绝对路径，请在「文件夹路径」框粘贴路径");
            if (node) flashFolderBtn(node, node._xhALFolderBtn, T(node, "folderFail").replace("%s", "请粘贴路径"), false);
            return;
        }
        // webkitdirectory 把子目录文件一起返回 ⇒ 按 webkitRelativePath 往上退到「你选的那个文件夹」
        const segs = String(first.webkitRelativePath || "").split("/").filter(Boolean).length;
        const depth = segs > 0 ? segs - 1 : 1;
        let dir = abs;
        for (let i = 0; i < depth; i++) dir = dir.replace(/[/\\][^/\\]*$/, "");
        if (node) scanFolder(node, dir);
    });
    document.body.appendChild(inp);
    _xhALDirInput = inp;
    return inp;
}

function flashFolderBtn(node, btn, text, ok) {
    if (!btn) return;
    const old = "📂";                       // 图标化后复原 = 图标（不是文字）
    try { btn.textContent = text; } catch (e) {}
    try { btn.style.filter = ok ? "brightness(1.1)" : "brightness(1.3)"; } catch (e) {}
    setTimeout(() => {
        try { btn.textContent = old; btn.style.filter = "none"; } catch (e2) {}
    }, 2500);
}

/** 当前是不是文件夹模式（source 控件 = 📂 文件夹） */
function isFolderMode(node) {
    const w = widget(node, "source");
    return !!w && String(w.value) === SRC_FOLDER;
}

/**
 * 拉文件夹里的文件列表（后端 /xh/audiolist/list，只读、与后端同口径）。
 * 存 al.folderFiles = [{name, path}]；返回数量；失败返回 -1（预览降级，
 * 不影响执行——后端执行时自己会读盘并给出明确报错）。
 */
async function fetchFolderFiles(node) {
    const al = node._xhAL;
    if (!al) return -1;
    const folder = (wStr(node, "audio_folder") || "").trim();
    if (!folder) { al.folderFiles = []; al.folderDir = ""; return 0; }
    try {
        const resp = await api.fetchApi("/xh/audiolist/list?dir=" + encodeURIComponent(folder));
        const j = await resp.json().catch(() => ({}));
        if (j && j.ok && Array.isArray(j.files)) {
            al.folderFiles = j.files.map((f) => ({ name: f.name, path: f.path }));
            al.folderDir = j.dir || folder;
            return al.folderFiles.length;
        }
        al.folderFiles = null;      // 路由通但文件夹无效（后端执行时会明确报错）
        return -1;
    } catch (e) {
        al.folderFiles = null;      // 路由不可用（未重启/老服务端）⇒ 预览降级
        return -1;
    }
}

/**
 * 前端预览口径 = 后端「循环体外」口径：取 start_index（clamp 到 [0, n-1]）。
 * ⚠️ 循环体内实际文件由后端按 xh_loop_turn 决定，前端拿不到轮次、也不干预。
 */
function folderPreview(node) {
    const al = node._xhAL;
    if (!al || !Array.isArray(al.folderFiles) || !al.folderFiles.length) return null;
    const n = al.folderFiles.length;
    let i = parseInt(wStr(node, "start_index"), 10);
    if (!Number.isFinite(i) || i < 0) i = 0;
    if (i > n - 1) i = n - 1;
    const f = al.folderFiles[i];
    return { index: i, count: n, name: f.name, path: f.path };
}

/** 当前「播放 / 探测」目标：文件夹模式 → 预览文件（绝对路径）；单文件 / 手动清单 → input 目录文件名 */
function curTarget(node) {
    // 📋 手动清单：条目是 input 目录里的文件名 ⇒ 与单文件同一套播放（/view）
    if (isManualMode(node)) {
        const arr = readManualList(node);
        if (!arr.length) return { kind: "file", name: "", path: "", index: -1, count: 0 };
        const i = curListIndex(node, arr.length);
        return { kind: "file", name: arr[i], path: "", index: i, count: arr.length, manual: true };
    }
    if (isFolderMode(node)) {
        const pv = folderPreview(node);
        if (pv) return { kind: "folder", name: pv.name, path: pv.path, index: pv.index, count: pv.count };
        return { kind: "folder", name: "", path: "", index: 0, count: 0 };
    }
    return { kind: "file", name: wStr(node, "audio"), path: "", index: -1, count: 0 };
}

/** 选到文件夹 → 写路径 + 切来源 + 拉列表预览 + 刷新播放器/信息条 */
async function scanFolder(node, dir) {
    const pWidget = widget(node, "audio_folder");
    const sWidget = widget(node, "source");
    const btn = node._xhALFolderBtn;
    dir = cleanPath(dir);
    if (!dir || !pWidget) return;
    try {
        const resp = await api.fetchApi("/xh/audiolist/list?dir=" + encodeURIComponent(dir));
        const j = await resp.json().catch(() => ({}));
        pWidget.value = dir;
        if (sWidget) sWidget.value = SRC_FOLDER;
        applyModeVisibility(node);
        if (j && j.ok) {
            flashFolderBtn(node, btn, T(node, "folderOk").replace("%d", String(j.count || 0)), true);
        } else {
            flashFolderBtn(node, btn, T(node, "folderFail").replace("%s", (j && j.error) || ("HTTP " + resp.status)), false);
        }
    } catch (e) {
        // 路由不可用（未重启/老服务端）⇒ 仍写路径 + 切模式，出图时后端读
        pWidget.value = dir;
        if (sWidget) sWidget.value = SRC_FOLDER;
        applyModeVisibility(node);
        flashFolderBtn(node, btn, T(node, "folderNoList"), true);
    }
    refreshInfo(node, true);
    syncPlayer(node);
}

/** 当前是不是「📋 手动清单」模式 */
function isManualMode(node) {
    const w = widget(node, "source");
    return !!w && String(w.value) === SRC_MANUAL;
}

/** 循环模式 = 📂 文件夹 或 📋 手动清单（两种都是「一批音频按序」） */
function isLoopMode(node) {
    return isFolderMode(node) || isManualMode(node);
}

/** 读手动清单（audio_list 里的 JSON）⇒ [文件名] */
function readManualList(node) {
    const w = widget(node, "audio_list");
    let raw = "";
    try { raw = (w && w.value != null) ? String(w.value) : ""; } catch (e) { raw = ""; }
    raw = raw.trim();
    if (!raw) return [];
    let arr = null;
    try { arr = JSON.parse(raw); } catch (e) { return []; }
    if (!Array.isArray(arr)) return [];
    const out = [];
    for (const it of arr) {
        const nm = (typeof it === "string") ? it : (it && (it.name || it.path));
        if (nm && String(nm).trim()) out.push(String(nm).trim());
    }
    return out;
}

/** 写回手动清单（拖拽 / 删除 / 添加后）—— 顺带触发刷新链 */
function writeManualList(node, arr) {
    const w = widget(node, "audio_list");
    if (!w) return;
    w.value = JSON.stringify(arr || []);
    try { w.callback && w.callback(w.value, node, w); } catch (e) {}
    try { node.setDirtyCanvas?.(true, true); node.graph?.setDirtyCanvas?.(true, true); } catch (e) {}
}

/** 两种循环模式的「当前条目」统一口径：⇒ [{name, key}]，key = 播放/探测用的标识 */
function curListEntries(node) {
    if (isManualMode(node)) {
        return readManualList(node).map((n) => ({ name: n, key: n }));
    }
    const al = node._xhAL;
    if (al && Array.isArray(al.folderFiles)) {
        return al.folderFiles.map((f) => ({ name: f.name, key: f.path }));
    }
    return [];
}

/** 循环模式下「当前预览第几个」（与后端循环外口径一致：clamp） */
function curListIndex(node, n) {
    let i = parseInt(wStr(node, "start_index"), 10);
    if (!Number.isFinite(i) || i < 0) i = 0;
    if (n > 0 && i > n - 1) i = n - 1;
    return i;
}

// ---------------------------------------------------------------------------
// ⑨-2 音频列表区（DOM widget）：循环模式才显示
//   · 📋 手动清单：可拖拽改顺序、点 ✕ 删、点一下试听（写回 audio_list）
//   · 📂 文件夹  ：只读（顺序由文件名决定），点一下同样试听
// ---------------------------------------------------------------------------
function makeListWidget(node) {
    const al = node._xhAL;
    const wrap = document.createElement("div");
    wrap.style.cssText =
        `width:100%;height:${LIST_H}px;box-sizing:border-box;display:flex;flex-direction:column;`
        + `font-family:${FONT_STACK};user-select:none;overflow:hidden;`
        + "border-radius:6px;background:rgba(0,0,0,0.22);"
        + "box-shadow:inset 0 0 0 1px rgba(255,255,255,0.06);";

    const head = document.createElement("div");
    head.style.cssText =
        "flex:0 0 auto;display:flex;align-items:center;gap:6px;padding:3px 8px;"
        + "font-size:11.5px;font-weight:600;color:#cfd6dd;box-sizing:border-box;";
    const hTxt = document.createElement("span");
    head.appendChild(hTxt);
    wrap.appendChild(head);

    const scroll = document.createElement("div");
    scroll.style.cssText =
        "flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:hidden;padding:2px 0;box-sizing:border-box;";
    wrap.appendChild(scroll);

    let w = null;
    try {
        w = node.addDOMWidget(LIST_WIDGET, "custom", wrap, {
            serialize: false,
            hideOnZoom: false,
            getMinHeight: () => LIST_H,
            getHeight: () => LIST_H,
        });
    } catch (e) {
        console.warn("[XH LoadAudio] 列表区挂载失败:", e);
    }
    if (w) {
        lockDomWidgetHeight(w, LIST_H);
        try {
            w.serialize = false;
            if (w.options) w.options.serialize = false;
            w.serializeValue = () => undefined;
        } catch (e) {}
    }

    al.listEl = wrap;
    al.listScrollEl = scroll;
    al.listHeadEl = hTxt;
    // 列表区不吃画布手势（拖节点请抓标题栏）；但拖拽排序要靠 HTML5 dnd，自己 stopPropagation
    ["mousedown", "dblclick", "keydown", "click", "wheel"].forEach((ev) =>
        wrap.addEventListener(ev, (e) => e.stopPropagation()));
    return w;
}

/** 画列表（两种循环模式共用一套行样式：冠亚季徽章 + 文件名 + 时长/✕） */
function renderList(node) {
    const al = node._xhAL;
    if (!al || !al.listScrollEl) return;
    const manual = isManualMode(node);
    const entries = curListEntries(node);
    const idx = curListIndex(node, entries.length);
    const scroll = al.listScrollEl;

    if (al.listHeadEl) {
        al.listHeadEl.textContent = entries.length
            ? (manual ? `📋 ${entries.length} 个 · ${T(node, "listTip")}` : `📂 ${entries.length} 个`)
            : (manual ? T(node, "manualEmpty") : T(node, "listEmpty"));
    }

    scroll.innerHTML = "";
    if (!entries.length) {
        const em = document.createElement("div");
        em.style.cssText = "padding:10px 9px;font-size:11.5px;color:#8a939f;line-height:1.5;";
        em.textContent = manual ? T(node, "manualEmpty") : T(node, "listEmpty");
        scroll.appendChild(em);
        return;
    }

    entries.forEach((it, i) => {
        const row = document.createElement("div");
        row.style.cssText =
            "display:flex;align-items:center;gap:6px;padding:3px 7px;box-sizing:border-box;"
            + `cursor:${manual ? "grab" : "pointer"};border-left:2px solid transparent;`
            + (i === idx ? "background:#2c3b2e;border-left-color:#4BA14B;" : "");
        row.title = manual ? T(node, "listTip") : T(node, "listTipFolder");

        const badge = document.createElement("span");
        badge.style.cssText =
            `flex:0 0 auto;width:18px;height:18px;border-radius:10px;background:${rankColor(i)};`
            + "color:#fff;font-size:11px;font-weight:600;display:inline-flex;align-items:center;"
            + "justify-content:center;";
        badge.textContent = String(i + 1);

        const nm = document.createElement("span");
        nm.style.cssText =
            "flex:1 1 auto;min-width:0;font-size:11.5px;color:#e8e8e8;overflow:hidden;"
            + "text-overflow:ellipsis;white-space:nowrap;";
        nm.textContent = it.name;

        row.appendChild(badge);
        row.appendChild(nm);

        if (manual) {
            const del = document.createElement("span");
            del.textContent = "✕";
            del.title = T(node, "delOne");
            del.style.cssText = "flex:0 0 auto;color:#E53935;font-size:12px;font-weight:600;cursor:pointer;";
            del.addEventListener("pointerdown", (e) => e.stopPropagation());
            del.addEventListener("click", (e) => {
                e.stopPropagation();
                const arr = readManualList(node);
                arr.splice(i, 1);
                writeManualList(node, arr);
                renderList(node);
                refreshInfo(node, true);
                syncPlayer(node);
            });
            row.appendChild(del);

            // 拖拽改顺序（与 🖼️XH-图片列表同款：HTML5 dnd + splice）
            row.draggable = true;
            row.addEventListener("dragstart", (e) => {
                e.stopPropagation();
                row.style.opacity = "0.4";
                try {
                    e.dataTransfer.setData("text/xh-aud-idx", String(i));
                    e.dataTransfer.effectAllowed = "move";
                } catch (err) {}
            });
            row.addEventListener("dragend", () => { row.style.opacity = ""; });
            row.addEventListener("dragover", (e) => { e.preventDefault(); e.stopPropagation(); });
            row.addEventListener("drop", (e) => {
                e.preventDefault();
                e.stopPropagation();
                const from = parseInt(e.dataTransfer.getData("text/xh-aud-idx"), 10);
                if (!Number.isFinite(from) || from === i) return;
                const arr = readManualList(node);
                if (from < 0 || from >= arr.length || i >= arr.length) return;
                const [moved] = arr.splice(from, 1);
                arr.splice(i, 0, moved);
                writeManualList(node, arr);
                renderList(node);
                refreshInfo(node, true);
                syncPlayer(node);
            });
        }

        // 点一下 = 试听这一个（把「起始序号」指过去）
        row.addEventListener("click", (e) => {
            e.stopPropagation();
            const sw = widget(node, "start_index");
            if (sw) {
                sw.value = i;
                try { sw.callback && sw.callback(i, node, sw); } catch (err) {}
            }
            renderList(node);
            refreshInfo(node, true);
            syncPlayer(node);
        });

        scroll.appendChild(row);
    });
}

/** 「⬆ 加音频」：多选文件 → 一个个传进 input 目录 → 追加进手动清单 */
function createAddAudioBtn(node) {
    const btn = document.createElement("button");
    btn.type = "button";
    paintBarBtn(btn, "primary");
    btn.style.display = "inline-flex";
    btn.style.gap = "5px";
    btn.style.boxSizing = "border-box";
    btn.style.borderRadius = "4px";     // 4px = 家族统一圆角（原 5px）
    btn.style.transition = "transform .08s ease,filter .12s ease";
    const label = document.createElement("span");
    btn.appendChild(label);
    const setLabel = (s) => { label.textContent = s; };
    node._xhALAddTip = setLabel;
    setLabel(T(node, "addAudio"));

    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.accept = "audio/*,.wav,.mp3,.flac,.m4a,.aac,.ogg,.opus,.webm,.wma,.mp4,.mkv,.mov";
    input.style.display = "none";
    document.body.appendChild(input);
    node._xhALAddInput = input;

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
        try { input.click(); } catch (err) {}
    });

    input.addEventListener("change", async () => {
        const files = Array.from(input.files || []);
        input.value = "";
        if (!files.length) return;
        const okFiles = files.filter((f) => looksAudio(f));
        if (!okFiles.length) {
            setLabel(T(node, "addFail"));
            setTimeout(() => setLabel(T(node, "addAudio")), 1600);
            return;
        }
        btn.disabled = true;
        setLabel(T(node, "uploading"));
        const arr = readManualList(node);
        let added = 0;
        for (const f of okFiles) {
            try {
                const info = await uploadToInput(f);
                const name = info && info.name ? info.name : f.name;
                arr.push(name);
                added += 1;
            } catch (e) {
                console.warn("[XH LoadAudio] 加入清单失败:", f && f.name, e);
            }
        }
        btn.disabled = false;
        if (added > 0) {
            writeManualList(node, arr);
            renderList(node);
            refreshInfo(node, true);
            syncPlayer(node);
            setLabel(T(node, "addOk").replace("%d", String(added)));
        } else {
            setLabel(T(node, "addFail"));
        }
        setTimeout(() => setLabel(T(node, "addAudio")), 1800);
    });

    ["pointerdown", "mousedown", "dblclick", "keydown", "click"].forEach((ev) =>
        btn.addEventListener(ev, (e) => e.stopPropagation()));
    return btn;
}

/** 「清空」：红色危险操作，点两次才真清（与图片列表同款防误触） */
function createClearBtn(node) {
    const btn = document.createElement("button");
    btn.type = "button";
    paintBarBtn(btn, "danger");
    btn.style.display = "inline-flex";
    btn.style.gap = "5px";
    btn.style.boxSizing = "border-box";
    btn.style.borderRadius = "4px";     // 4px = 家族统一圆角（原 5px）
    btn.style.transition = "transform .08s ease,filter .12s ease";
    const label = document.createElement("span");
    btn.appendChild(label);
    const setLabel = (s) => { label.textContent = s; };
    node._xhALClearTip = setLabel;
    setLabel(T(node, "clearList"));
    let armed = false;
    let timer = 0;

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
        if (!armed) {
            armed = true;
            setLabel(T(node, "clearConfirm"));
            clearTimeout(timer);
            timer = setTimeout(() => { armed = false; setLabel(T(node, "clearList")); }, 2500);
            return;
        }
        armed = false;
        clearTimeout(timer);
        writeManualList(node, []);
        renderList(node);
        refreshInfo(node, true);
        syncPlayer(node);
        setLabel(T(node, "clearList"));
    });
    ["pointerdown", "mousedown", "dblclick", "keydown", "click"].forEach((ev) =>
        btn.addEventListener(ev, (e) => e.stopPropagation()));
    return btn;
}

/**
 * ⑨ 普通 / 循环模式显隐（模式状态由 source 值推导，不单独存）：
 *   普通模式（source=单文件）：只显示 audio 下拉 ⇒ 节点回到加这些功能前的大小。
 *   循环模式（📂 文件夹 / 📋 手动清单）：audio 藏；来源下拉（用来在两种循环方式间切）、
 *     起始序号、绕回、列表区显示；文件夹路径只在 📂 显示；audio_list 只是存档位永远藏。
 *   ⛔ 隐藏一律走 setWidgetHiddenVis（Vue 只认 w.hidden）；DOM 列表区同理设 w.hidden。
 */
function applyModeVisibility(node) {
    const loop = isLoopMode(node);
    const folder = isFolderMode(node);
    setWidgetHiddenVis(node, "audio", loop);
    setWidgetHiddenVis(node, "source", !loop);        // 循环模式下才让用户切 📂/📋
    setWidgetHiddenVis(node, "audio_folder", !folder);
    setWidgetHiddenVis(node, "audio_list", true);     // 纯存档位，由列表区 UI 代替
    setWidgetHiddenVis(node, "start_index", !loop);
    setWidgetHiddenVis(node, "loop", !loop);

    // 列表区（DOM widget）：只在循环模式出现
    const lw = widget(node, LIST_WIDGET);
    if (lw) {
        try { lw.hidden = !loop; } catch (e) {}
        if (lw.element) { try { lw.element.style.display = loop ? "" : "none"; } catch (e) {} }
    }
    // 工具条按钮：⬆加音频 / 清空 只在手动清单；📂 只在文件夹（普通模式也留着，一点就进循环）
    const showHide = (btn, show) => {
        if (!btn) return;
        try { btn.style.display = show ? "" : "none"; } catch (e) {}
    };
    const manual = isManualMode(node);
    // 🔴 工具条永远只留 5 颗（bar 只有 246px，多了会换行撑乱）：
    //    普通/文件夹 = 中·EN 🎨 ⬆上传 📂 🔁｜手动清单 = 中·EN 🎨 ⬆加音频 清空 🎵
    showHide(node._xhALUploadBtn, !manual);
    showHide(node._xhALFolderBtn, !manual);
    showHide(node._xhALAddBtn, manual);
    showHide(node._xhALClearBtn, manual);

    if (node._xhALModeTip) {
        try { node._xhALModeTip(loop ? T(node, "modeIconToFile") : T(node, "modeIconToFolder")); } catch (e) {}
    }
    try { node.setDirtyCanvas?.(true, true); node.graph?.setDirtyCanvas?.(true, true); } catch (e) {}
}

/** ⑨ 模式切换钮：普通模式显示「🔁 循环模式」（点了展开），循环模式显示「🎵 普通模式」（点了收回） */
function createModeBtn(node) {
    const btn = document.createElement("button");
    btn.type = "button";
    paintBarBtn(btn, "neutral");
    btn.style.display = "inline-flex";
    btn.style.gap = "5px";
    btn.style.boxSizing = "border-box";
    btn.style.borderRadius = "4px";     // 4px = 家族统一圆角（原 5px）
    btn.style.transition = "transform .08s ease,filter .12s ease";
    btn.title = T(node, "modeTip");
    const label = document.createElement("span");
    btn.appendChild(label);
    const setLabel = (s) => { label.textContent = s; };
    node._xhALModeTip = setLabel;
    setLabel(isLoopMode(node) ? T(node, "modeIconToFile") : T(node, "modeIconToFolder"));

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
        // 切 source 值并走它的 callback（与用户点下拉同一条链路：拉/清列表 + 刷新 + 挂流）
        const sw = widget(node, "source");
        if (sw) {
            if (isLoopMode(node)) {
                sw.value = SRC_FILE;                    // 循环 → 普通
            } else {
                // 普通 → 循环：清单里已经有货就进「📋 手动清单」，否则进「📂 文件夹」
                sw.value = readManualList(node).length ? SRC_MANUAL : SRC_FOLDER;
            }
            try { sw.callback && sw.callback(sw.value, node, sw); } catch (err) {}
        }
        applyModeVisibility(node);   // 兜底：callback 链断了也保证显隐与文案正确
        renderList(node);
    });
    ["pointerdown", "mousedown", "dblclick", "keydown", "click"].forEach((ev) =>
        btn.addEventListener(ev, (e) => e.stopPropagation()));
    return btn;
}

function createFolderBtn(node) {
    const btn = document.createElement("button");
    btn.type = "button";
    paintBarBtn(btn, "neutral");
    btn.style.display = "inline-flex";
    btn.style.gap = "5px";
    btn.style.boxSizing = "border-box";
    btn.style.borderRadius = "4px";     // 4px = 家族统一圆角（原 5px）
    btn.style.transition = "transform .08s ease,filter .12s ease";
    const label = document.createElement("span");
    btn.appendChild(label);
    const setLabel = (s) => { label.textContent = s; };
    // 🔴 图标化（2026-10-16）：工具条 5 按钮总宽 282 > bar 246 ⇒ 换行把节点撑乱；
    //    📂 / 🔁 图标化后一行放得下，完整说明放 title（tooltip）
    setLabel("📂");
    btn.title = T(node, "folderTip");
    node._xhALFolderTip = setLabel;

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
        const pWidget = widget(node, "audio_folder");
        const raw = (pWidget && pWidget.value ? String(pWidget.value) : "").trim();
        if (!raw) {
            // 还没路径 ⇒ 弹系统选择器
            _xhALTaskNode = node;
            node._xhALFolderBtn = btn;
            try { ensureDirInput().click(); } catch (err) {
                console.warn("[XH LoadAudio] 无法弹文件夹选择框，请改用粘贴路径", err);
            }
            return;
        }
        scanFolder(node, raw);   // 已有路径 ⇒ 重新扫一遍（刷新预览数量）
    });
    ["pointerdown", "mousedown", "dblclick", "keydown", "click"].forEach((ev) =>
        btn.addEventListener(ev, (e) => e.stopPropagation()));
    return btn;
}

// ---------------------------------------------------------------------------
// ④ 自绘播放器（粗时间线是正主）
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

/** 文件夹模式：任意绝对路径走自家流式路由（FileResponse 带 Range，seek 可用） */
function folderFileUrl(path, stamp) {
    const p = new URLSearchParams();
    p.set("path", String(path || ""));
    p.set("t", String(stamp || 0));
    return api.apiURL("/xh/audioload/file?" + p.toString());
}

/** 当前可用总长：probe 拿到的优先（权威），audio.duration 兜底 */
function curDuration(node) {
    const al = node._xhAL;
    if (!al) return 0;
    let d = 0;
    if (al.data && isFinite(al.data.duration) && al.data.duration > 0) d = al.data.duration;
    if (!d && al.audioEl && isFinite(al.audioEl.duration) && al.audioEl.duration > 0) {
        d = al.audioEl.duration;
    }
    return d;
}

function paintPlayBtn(node) {
    const al = node._xhAL;
    if (!al || !al.playBtn) return;
    const paused = !al.audioEl || al.audioEl.paused;
    al.playBtn.innerHTML = paused ? SVG_PLAY : SVG_PAUSE;
    al.playBtn.title = T(node, paused ? "play" : "pause");
}

function paintMuteBtn(node) {
    const al = node._xhAL;
    if (!al || !al.muteBtn) return;
    const muted = !!(al.audioEl && al.audioEl.muted);
    al.muteBtn.innerHTML = muted ? SVG_MUTE : SVG_VOLUME;
    al.muteBtn.title = T(node, muted ? "unmute" : "mute");
    // 方案 B：静音中 = danger 红实心（破坏性），取消 = neutral 暗底
    paintBarBtn(al.muteBtn, muted ? "danger" : "neutral");
}

function updateProgress(node) {
    const al = node._xhAL;
    if (!al || !al.fillEl || !al.handleEl || !al.timeEl) return;
    const dur = curDuration(node);
    const cur = (al.audioEl && isFinite(al.audioEl.currentTime)) ? al.audioEl.currentTime : 0;
    const pct = dur > 0 ? Math.max(0, Math.min(100, (cur / dur) * 100)) : 0;
    al.fillEl.style.width = pct + "%";
    al.handleEl.style.left = pct + "%";
    al.timeEl.textContent = `${fmtTime(cur)} / ${fmtTime(dur)}`;
    // 读不到时长 → 整条时间线禁用态
    const dead = dur <= 0;
    al.trackHit.style.cursor = dead ? "default" : "pointer";
    al.trackHit.style.opacity = dead ? "0.45" : "1";
    al.trackHit.title = dead ? T(node, "noDuration") : T(node, "seekTip");
}

/** 指针事件 → 秒（轨道任意位置点一下跳转 / 按住拖动实时 seek） */
function seekFromEvent(node, e) {
    const al = node._xhAL;
    if (!al || !al.trackBar || !al.audioEl) return;
    const dur = curDuration(node);
    if (dur <= 0) return;
    const r = al.trackBar.getBoundingClientRect();
    if (!(r.width > 0)) return;
    const x = Math.max(0, Math.min(r.width, e.clientX - r.left));
    const tsec = (x / r.width) * dur;
    try { al.audioEl.currentTime = tsec; } catch (err) {}
    updateProgress(node);          // 不等 timeupdate，立刻跟手
}

// ---------------------------------------------------------------------------
// ⑦ 实时频谱律动条（Web Audio API · AnalyserNode 实时 FFT）
//    · AudioContext **全图共用一个**（浏览器限量约 6 个，每节点建一个迟早爆）
//    · createMediaElementSource 每个 <audio> 元素只能绑一次 → 元素上打标记防重复
//    · 接管音频路由后：source → analyser → destination；volume / muted 仍归 audioEl 管
//    · 播放按钮里先 ctx.resume()（Chromium 自动播放策略：无用户手势不出声）
//    · rAF：play 事件起、pause/ended/error 停（停前画一帧落底静止态）；onRemoved 置死
//    · 一次绘制异常**不许断链**（skill frontend_n2 §16.2：断链 = 频谱全黑且不报错）
// ---------------------------------------------------------------------------
let _xhAudioCtx = null;            // 全局单例 AudioContext

function ensureAudioCtx() {
    if (_xhAudioCtx) return _xhAudioCtx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;                       // 老浏览器 → 走静态兜底
    try { _xhAudioCtx = new AC(); } catch (e) { return null; }
    return _xhAudioCtx;
}

/** 把本节点的 <audio> 接进 AnalyserNode（每元素只做一次；失败置 specDead 走兜底） */
function ensureAudioGraph(node) {
    const al = node && node._xhAL;
    if (!al || !al.audioEl) return null;
    if (al.specDead) return null;
    if (al.analyser) return al.analyser;
    const ctx = ensureAudioCtx();
    if (!ctx) { al.specDead = true; return null; }
    try {
        let src = al.audioEl._xhALSrc;
        if (!src) {
            // 同一元素二次 createMediaElementSource 会抛 InvalidStateError
            src = ctx.createMediaElementSource(al.audioEl);
            al.audioEl._xhALSrc = src;
        }
        const an = ctx.createAnalyser();
        an.fftSize = 2048;                      // frequencyBinCount = 1024
        an.smoothingTimeConstant = 0.75;        // 条子柔和，别跳成噪声
        src.connect(an);
        an.connect(ctx.destination);            // 必须接回 destination，否则没声
        al.analyser = an;
        al.specBuf = new Uint8Array(an.frequencyBinCount);
        al.specPeaks = new Float32Array(SPEC_BARS);   // 峰值帽
        return an;
    } catch (e) {
        console.warn("[XH LoadAudio] 频谱图建立失败（不影响播放）:", e);
        al.specDead = true;                     // 兜底：静态低条，绝不挡播放
        return null;
    }
}

/** 32 个频段（对数分组，贴合听感）：第 i 条取 [n^(i/32), n^((i+1)/32)) 内的峰值 */
function spectrumLevels(buf, n) {
    const out = new Float32Array(n);
    const total = buf.length;
    for (let i = 0; i < n; i++) {
        const a = Math.floor(Math.pow(total, i / n));
        const b = Math.max(a + 1, Math.floor(Math.pow(total, (i + 1) / n)));
        let m = 0;
        for (let k = a; k < b && k < total; k++) if (buf[k] > m) m = buf[k];
        out[i] = m / 255;
    }
    return out;
}

/** 画一帧；levels 为 null = 落底静止态（暂停 / 停止时用） */
function drawSpectrumFrame(node, levels) {
    const al = node && node._xhAL;
    if (!al || !al.specCanvas) return;
    const cv = al.specCanvas;
    const ctx2d = al.specCtx2d || (al.specCtx2d = cv.getContext("2d"));
    if (!ctx2d) return;
    const cw = cv.clientWidth, ch = cv.clientHeight;
    if (!(cw > 0 && ch > 0)) return;            // 未挂载 / 零宽 → 跳过，继续排帧
    const dpr = window.devicePixelRatio || 1;
    const pw = Math.round(cw * dpr), ph = Math.round(ch * dpr);
    if (cv.width !== pw || cv.height !== ph) { cv.width = pw; cv.height = ph; }
    ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx2d.clearRect(0, 0, cw, ch);

    const barW = (cw - SPEC_GAP * (SPEC_BARS - 1)) / SPEC_BARS;
    for (let i = 0; i < SPEC_BARS; i++) {
        const v = levels ? levels[i] : 0;
        // 峰值帽：只涨不跌，每帧衰减下落；静止态直接清零
        al.specPeaks[i] = levels
            ? Math.max(al.specPeaks[i] * SPEC_CAP_FALL, v)
            : 0;
        const h = Math.max(1.5, v * (ch - SPEC_CAP_H - 1));
        const x = i * (barW + SPEC_GAP);
        const y = ch - h;
        const g = ctx2d.createLinearGradient(0, ch, 0, y);
        g.addColorStop(0, "#1F6B24");
        g.addColorStop(0.55, GREEN);
        g.addColorStop(1, "#A5D84F");
        ctx2d.fillStyle = g;
        if (ctx2d.roundRect) {
            ctx2d.beginPath();
            ctx2d.roundRect(x, y, barW, h, Math.min(2, barW / 2));
            ctx2d.fill();
        } else {
            ctx2d.fillRect(x, y, barW, h);
        }
        // 峰值帽（亮白 2px）
        if (al.specPeaks[i] > 0.02) {
            const py = ch - SPEC_CAP_H - al.specPeaks[i] * (ch - SPEC_CAP_H - 1);
            ctx2d.fillStyle = "rgba(255,255,255,0.85)";
            ctx2d.fillRect(x, py, barW, SPEC_CAP_H);
        }
    }
}

function spectrumLoop(node) {
    const al = node && node._xhAL;
    if (!al || al.specDead) return;             // 节点删了 / 建图失败 → 收工
    try {
        if (al.analyser && al.audioEl && !al.audioEl.paused) {
            al.analyser.getByteFrequencyData(al.specBuf);
            drawSpectrumFrame(node, spectrumLevels(al.specBuf, SPEC_BARS));
        }
    } catch (e) { /* 一次异常不许断链 */ }
    al.specRaf = requestAnimationFrame(() => spectrumLoop(node));
}

function startSpectrum(node) {
    const al = node && node._xhAL;
    if (!al || al.specDead || al.specRaf) return;
    ensureAudioGraph(node);                     // 保底：没建过图就现在建
    if (!al.analyser) { drawSpectrumFrame(node, null); return; }
    spectrumLoop(node);
}

function stopSpectrum(node) {
    const al = node && node._xhAL;
    if (!al) return;
    if (al.specRaf) { try { cancelAnimationFrame(al.specRaf); } catch (e) {} }
    al.specRaf = 0;
    try { drawSpectrumFrame(node, null); } catch (e) {}   // 落底静止态
}

function makePlayer(node) {
    ensureStyle();

    const playerEl = document.createElement("div");
    playerEl.style.cssText =
        `width:100%;height:${PLAYER_H}px;box-sizing:border-box;display:flex;flex-direction:column;`
        + `font-family:${FONT_STACK};user-select:none;`;

    // ── 第一行：播放键 · 时间 · （弹性空）· 静音键 · 音量滑块 ──
    const row = document.createElement("div");
    row.style.cssText =
        "display:flex;align-items:center;gap:6px;padding:7px 9px 4px;box-sizing:border-box;"
        + "flex:0 0 auto;";

    const mkBtn = (w, h) => {
        const b = document.createElement("button");
        b.type = "button";
        b.style.cssText =
            `display:flex;align-items:center;justify-content:center;width:${w}px;height:${h}px;`
            + "padding:0;border:none;border-radius:4px;color:#fff;cursor:pointer;flex:0 0 auto;"
            + "transition:filter .15s,background .15s,transform .08s ease;";
        ["pointerdown", "mousedown", "dblclick", "keydown", "click"].forEach((ev) =>
            b.addEventListener(ev, (e) => e.stopPropagation()));
        return b;
    };

    const playBtn = mkBtn(28, 22);
    paintBarBtn(playBtn, "neutral");   // 方案 B：原本就是无条件底色，播放态由 :1234 的 paintPlayBtn 刷
    playBtn.addEventListener("mouseenter", () => { playBtn.style.filter = "brightness(1.3)"; });
    playBtn.addEventListener("mouseleave", () => { playBtn.style.filter = ""; });
    playBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const al = node._xhAL;
        if (!al || !al.audioEl) return;
        if (al.audioEl.paused) {
            // 频谱：先建 Audio 图 + 解锁 ctx（自动播放策略：无手势不出声）
            ensureAudioGraph(node);
            const ctx = _xhAudioCtx;
            if (ctx && ctx.state === "suspended") { try { ctx.resume(); } catch (err) {} }
            try { al.audioEl.play?.(); } catch (err) {}
        } else {
            try { al.audioEl.pause?.(); } catch (err) {}
        }
    });

    const timeEl = document.createElement("span");
    timeEl.style.cssText =
        "flex:0 0 auto;font-size:11.5px;font-weight:600;color:#ffffff;"
        + "font-variant-numeric:tabular-nums;letter-spacing:.2px;text-shadow:0 1px 2px rgba(0,0,0,.35);";
    timeEl.textContent = "--:-- / --:--";

    const spacer = document.createElement("span");
    spacer.style.cssText = "flex:1 1 auto;min-width:0;";

    const muteBtn = mkBtn(22, 22);
    muteBtn.addEventListener("mouseenter", () => { muteBtn.style.filter = "brightness(1.3)"; });
    muteBtn.addEventListener("mouseleave", () => { muteBtn.style.filter = ""; });
    muteBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const al = node._xhAL;
        if (!al || !al.audioEl) return;
        al.audioEl.muted = !al.audioEl.muted;
        paintMuteBtn(node);
    });

    const volInput = document.createElement("input");
    volInput.type = "range";
    volInput.className = "xh-al-range";
    volInput.min = "0";
    volInput.max = "1";
    volInput.step = "0.01";
    volInput.value = "0.8";
    volInput.title = T(node, "volTip");
    volInput.style.cssText = "width:56px;height:14px;flex:0 0 auto;";
    volInput.addEventListener("input", (e) => {
        e.stopPropagation();
        const al = node._xhAL;
        if (!al || !al.audioEl) return;
        let v = parseFloat(volInput.value);
        if (!isFinite(v)) v = 0.8;
        al.audioEl.volume = Math.max(0, Math.min(1, v));
        if (al.audioEl.volume > 0) al.audioEl.muted = false;   // 主动调大 = 想听，解除静音
        paintMuteBtn(node);
    });
    ["pointerdown", "mousedown", "dblclick", "keydown", "click", "wheel"].forEach((ev) =>
        volInput.addEventListener(ev, (e) => e.stopPropagation()));

    row.appendChild(playBtn);
    row.appendChild(timeEl);
    row.appendChild(spacer);
    row.appendChild(muteBtn);
    row.appendChild(volInput);

    // ── 第二行：粗时间线（10px 轨道 + 16px 拖把手；命中区做高到 18px 好点） ──
    // 🔴 flex:0 0 auto（2026-10-16 频谱贴底版）：多余高度全让给频谱区，不再给命中区
    const trackHit = document.createElement("div");
    trackHit.style.cssText =
        "flex:0 0 auto;min-height:0;display:flex;align-items:center;padding:0 9px;"
        + "box-sizing:border-box;cursor:pointer;touch-action:none;";

    const trackBar = document.createElement("div");
    trackBar.style.cssText =
        `position:relative;flex:1 1 auto;height:${TRACK_H}px;border-radius:${TRACK_H / 2}px;`
        + "background:rgba(255,255,255,0.16);box-shadow:inset 0 0 0 1px rgba(255,255,255,0.10);";

    const fillEl = document.createElement("div");
    fillEl.style.cssText =
        `position:absolute;left:0;top:0;bottom:0;width:0;border-radius:${TRACK_H / 2}px;`
        + `background:#262d38;border:1px solid rgba(255,255,255,.10);`;   // 方案 B neutral 档

    const handleEl = document.createElement("div");
    handleEl.style.cssText =
        `position:absolute;top:50%;left:0;width:${HANDLE_D}px;height:${HANDLE_D}px;`
        + "border-radius:50%;background:#ffffff;transform:translate(-50%,-50%);"
        + "box-shadow:0 0 0 1px rgba(0,0,0,0.45),0 1px 3px rgba(0,0,0,0.35);"
        + "transition:transform .1s ease;pointer-events:none;";

    trackBar.appendChild(fillEl);
    trackBar.appendChild(handleEl);
    trackHit.appendChild(trackBar);

    // ── 指针交互：点一下跳转 + 按住拖动 seek（pointer capture：拖出节点也不断） ──
    trackHit.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        e.preventDefault();
        const al = node._xhAL;
        if (!al) return;
        al.dragging = true;
        try { trackHit.setPointerCapture(e.pointerId); } catch (err) {}
        handleEl.style.transform = "translate(-50%,-50%) scale(1.2)";
        seekFromEvent(node, e);
    });
    trackHit.addEventListener("pointermove", (e) => {
        e.stopPropagation();
        const al = node._xhAL;
        if (!al || !al.dragging) return;
        seekFromEvent(node, e);
    });
    const endDrag = (e) => {
        const al = node._xhAL;
        if (!al) return;
        al.dragging = false;
        handleEl.style.transform = "translate(-50%,-50%)";
        try { trackHit.releasePointerCapture(e.pointerId); } catch (err) {}
    };
    trackHit.addEventListener("pointerup", endDrag);
    trackHit.addEventListener("pointercancel", endDrag);

    playerEl.appendChild(row);
    playerEl.appendChild(trackHit);

    // ── 第三行：实时频谱律动条（Web Audio AnalyserNode，播放时才跳） ──
    // 🔴 频谱区是弹性主区（2026-10-16 频谱贴底版）：用户把节点拖高 ⇒ 多出来的高度全给
    //    频谱（配合 applyStretch 把播放器行轨道改成 minmax(89px,1fr)），波形贴住底部。
    //    自然高度时仍是 46px（89 - 控件行 33 - 时间线 10），和老版完全一致。
    // 🔴 canvas 必须**绝对定位 + calc 显式尺寸**：替换元素（canvas）不吃 top/bottom 拉伸
    //    （auto 高直接落到 HTML 默认 150，真机实锤 specWrap 46 高时 canvas 仍 150）；
    //    而纯 height:100% 在不定链里同样解析到 150。绝对定位不参与内容高度 ⇒ 斩断循环。
    const specWrap = document.createElement("div");
    specWrap.style.cssText =
        "flex:1 1 auto;min-height:46px;position:relative;padding:0 9px 6px;box-sizing:border-box;";
    const specCanvas = document.createElement("canvas");
    specCanvas.style.cssText =
        "position:absolute;left:9px;top:0;width:calc(100% - 18px);height:calc(100% - 6px);display:block;";
    specWrap.appendChild(specCanvas);
    playerEl.appendChild(specWrap);

    // 隐藏的 <audio>（无 controls，全部自己画）
    const audioEl = document.createElement("audio");
    audioEl.preload = "metadata";
    audioEl.style.display = "none";
    playerEl.appendChild(audioEl);

    // 播放器区域不吃画布手势（拖节点请抓标题栏）
    ["pointerdown", "mousedown", "dblclick", "keydown", "click", "wheel"].forEach((ev) =>
        playerEl.addEventListener(ev, (e) => e.stopPropagation()));

    audioEl.addEventListener("loadedmetadata", () => {
        const al = node._xhAL;
        if (!al) return;
        updateProgress(node);
    });
    audioEl.addEventListener("durationchange", () => updateProgress(node));
    audioEl.addEventListener("timeupdate", () => updateProgress(node));
    audioEl.addEventListener("play", () => { paintPlayBtn(node); startSpectrum(node); });
    audioEl.addEventListener("pause", () => { paintPlayBtn(node); stopSpectrum(node); });
    audioEl.addEventListener("ended", () => { paintPlayBtn(node); stopSpectrum(node); });
    audioEl.addEventListener("volumechange", () => {
        paintMuteBtn(node);
        const al = node._xhAL;
        if (al && al.volInput && al.audioEl && document.activeElement !== al.volInput) {
            al.volInput.value = String(al.audioEl.muted ? 0 : al.audioEl.volume);
        }
    });
    audioEl.addEventListener("error", () => {
        // 播不了 ≠ 加载不了：信息条切错误态给说明，节点照样能执行
        stopSpectrum(node);
        paintInfo(node, "error", T(node, "cantPlay"));
    });

    let w = null;
    try {
        w = node.addDOMWidget(PLAYER_WIDGET, "custom", playerEl, {
            serialize: false,
            hideOnZoom: false,
            getMinHeight: () => PLAYER_H,
            getHeight: () => PLAYER_H,
        });
    } catch (e) {
        console.warn("[XH LoadAudio] 播放器挂载失败:", e);
    }
    if (w) {
        // 🔴 高度定死：Vue Nodes 行高只看 hasLayoutSize（DOM widget 基类自带
        //    computeLayoutSize）⇒ 只写 computeSize 无效，必须连 computeLayoutSize
        //    一起撤，行变 min-content，节点拖高时不会把播放器撑成空带。
        lockDomWidgetHeight(w, PLAYER_H);
        // serialize:false 三重堵（本机新前端不认 options.serialize）
        try {
            w.serialize = false;
            if (w.options) w.options.serialize = false;
            w.serializeValue = () => undefined;
        } catch (e) {}
    }

    node._xhAL.playerEl = playerEl;
    node._xhAL.audioEl = audioEl;
    node._xhAL.playBtn = playBtn;
    node._xhAL.muteBtn = muteBtn;
    node._xhAL.volInput = volInput;
    node._xhAL.timeEl = timeEl;
    node._xhAL.trackHit = trackHit;
    node._xhAL.trackBar = trackBar;
    node._xhAL.fillEl = fillEl;
    node._xhAL.handleEl = handleEl;
    node._xhAL.specWrap = specWrap;
    node._xhAL.specCanvas = specCanvas;
    node._xhAL.playerWidget = w;

    audioEl.volume = 0.8;
    paintPlayBtn(node);
    paintMuteBtn(node);
    updateProgress(node);
    drawSpectrumFrame(node, null);      // 初始 = 落底静止态
    return w;
}

/** 下拉一改 / 来源一切换就重挂 src（同一文件不重复挂；空文件卸流） */
function syncPlayer(node) {
    const al = node._xhAL;
    if (!al || !al.audioEl) return;
    const tgt = curTarget(node);

    // ── 📂 文件夹模式：播「起始序号」指向的那个文件（绝对路径流式路由）──
    if (tgt.kind === "folder") {
        if (!tgt.path) {
            try { al.audioEl.pause?.(); } catch (e) {}
            stopSpectrum(node);
            try { al.audioEl.removeAttribute("src"); al.audioEl.load?.(); } catch (e) {}
            al.curFile = "";
            updateProgress(node);
            return;
        }
        if (al.curFile !== tgt.path) {
            al.curFile = tgt.path;
            al.stamp = Date.now();                       // 只在换文件时穿透缓存
            try { al.audioEl.src = folderFileUrl(tgt.path, al.stamp); } catch (e) {}
            try { al.audioEl.load?.(); } catch (e) {}
            stopSpectrum(node);                          // 换文件 = 停跳，落底等下一次播放
            updateProgress(node);
        }
        return;
    }

    // ── 单文件模式（老逻辑，一字未动）──
    const name = tgt.name;
    if (!name) {
        try { al.audioEl.pause?.(); } catch (e) {}
        stopSpectrum(node);
        try { al.audioEl.removeAttribute("src"); al.audioEl.load?.(); } catch (e) {}
        al.curFile = "";
        updateProgress(node);
        return;
    }
    if (al.curFile !== name) {
        al.curFile = name;
        al.stamp = Date.now();                       // 只在换文件时穿透缓存
        try { al.audioEl.src = playerUrl(name, al.stamp); } catch (e) {}
        try { al.audioEl.load?.(); } catch (e) {}
        stopSpectrum(node);                          // 换文件 = 停跳，落底等下一次播放
        updateProgress(node);
    }
}

// ---------------------------------------------------------------------------
// ⑤ 信息条（probe 路由：时长 / 采样率 / 声道 / 编码）
// ---------------------------------------------------------------------------
function makeInfoBar(node) {
    const el = document.createElement("div");
    el.style.cssText =
        "display:flex;align-items:center;gap:6px;padding:6px 9px;width:100%;box-sizing:border-box;"
        + "border-radius:6px;background:rgba(255,255,255,0.10);"
        + `font-family:${FONT_STACK};`
        + "font-size:12px;font-weight:600;color:#ffffff;text-shadow:0 1px 2px rgba(0,0,0,0.35);"
        + "user-select:none;cursor:pointer;white-space:nowrap;overflow:hidden;";
    const dot = document.createElement("span");
    dot.style.cssText = "flex:0 0 auto;width:7px;height:7px;border-radius:50%;background:#8a93a0;";
    const text = document.createElement("span");
    text.style.cssText = "flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;";
    el.appendChild(dot);
    el.appendChild(text);

    // 点一下 = 强制重新读取：文件在磁盘上被同名替换后，用它刷新信息与播放
    el.addEventListener("pointerdown", (e) => e.stopPropagation());
    el.addEventListener("click", (e) => {
        e.stopPropagation();
        const al = node._xhAL;
        if (!al) return;
        al.curFile = "";                 // 清掉「同一文件不重挂」的判据 → 重新拉一次
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
        console.warn("[XH LoadAudio] 信息条挂载失败:", e);
    }
    if (w) {
        // 🔴 信息条钉死 26px（理由同播放器：Vue Nodes 必须连 computeLayoutSize 一起撤）
        lockDomWidgetHeight(w, 26);
        try {
            w.serialize = false;
            if (w.options) w.options.serialize = false;
            w.serializeValue = () => undefined;
        } catch (e) {}
    }
    node._xhAL.infoEl = el;
    node._xhAL.textEl = text;
    node._xhAL.dotEl = dot;
    return w;
}

function paintInfo(node, state, payload, folderTag) {
    const al = node._xhAL;
    if (!al || !al.textEl) return;
    if (state === "empty") {
        al.dotEl.style.background = "#8a93a0";
        al.textEl.textContent = folderTag || T(node, "notSelected");
        al.textEl.style.color = "#ffffff";
        return;
    }
    if (state === "error") {
        al.dotEl.style.background = RED;
        al.textEl.textContent = (folderTag ? folderTag + " · " : "") + (payload || T(node, "noProbe"));
        al.textEl.style.color = "#ffb3ae";
        return;
    }
    // state === "ok"
    const p = payload || {};
    const parts = [
        fmtTime(p.duration || 0),
        fmtHz(p.sample_rate || 0),
        chName(p.channels || 0),
    ];
    if (p.codec) parts.push(p.codec);
    al.dotEl.style.background = GREEN;
    al.textEl.style.color = "#ffffff";
    al.textEl.textContent = (folderTag ? folderTag + " · " : "") + parts.join(" · ");
    // 总长以 probe 为准拿到了 → 进度条解锁显示
    updateProgress(node);
}

async function probeAudio(node, name, path) {
    const p = new URLSearchParams();
    if (path) { p.set("path", path); } else { p.set("filename", name); p.set("type", "input"); }
    const url = api.apiURL("/xh/audioload/probe?" + p.toString());
    const resp = await api.fetchApi(url, { method: "GET" });
    const data = await resp.json();
    if (!data || data.ok !== true) throw new Error((data && data.error) || "probe failed");
    return data;
}

function refreshInfo(node, force) {
    const al = node._xhAL;
    if (!al || !al.textEl) return;
    const tgt = curTarget(node);

    // ── 📂 文件夹模式 ──
    if (tgt.kind === "folder") {
        if (!al.folderFiles) {
            // 列表还没拉过（或上次失败）⇒ 先拉，拉完再走一遍
            fetchFolderFiles(node).then(() => { if (node._xhAL) refreshInfo(node, true); });
        }
        if (!tgt.name) {
            al.data = null; al.file = "";
            const raw = (wStr(node, "audio_folder") || "").trim();
            paintInfo(node, "empty",
                raw ? T(node, "folderNoList") : T(node, "folderEmpty"));
            return;
        }
        const key = "folder:" + tgt.path;
        if (!force && al.file === key && al.data) {
            paintInfo(node, "ok", al.data, T(node, "folderTag")
                .replace("%d", String(tgt.index + 1)).replace("%d", String(tgt.count))
                .replace("%s", tgt.name));
            return;
        }
        al.file = key;
        probeAudio(node, "", tgt.path)
            .then((data) => {
                if (curTarget(node).path !== tgt.path) return;    // 期间又换了
                al.data = data;
                paintInfo(node, "ok", data, T(node, "folderTag")
                    .replace("%d", String(tgt.index + 1)).replace("%d", String(tgt.count))
                    .replace("%s", tgt.name));
            })
            .catch((e) => {
                al.data = null;
                paintInfo(node, "error", `${T(node, "noProbe")} ${String(e.message || e)}`,
                    T(node, "folderTag")
                        .replace("%d", String(tgt.index + 1)).replace("%d", String(tgt.count))
                        .replace("%s", tgt.name));
            });
        return;
    }

    // ── 单文件 / 📋 手动清单（同一套：名字都在 input 目录里）──
    const name = tgt.name;
    // 📋 模式的信息条前缀：📋 i/n · 文件名
    const tagKey = tgt.manual ? "manualTag" : null;
    const mkTag = () => (tagKey
        ? T(node, tagKey).replace("%d", String(tgt.index + 1))
            .replace("%d", String(tgt.count)).replace("%s", name)
        : "");
    if (!name) {
        al.data = null; al.file = "";
        paintInfo(node, "empty", tgt.manual ? T(node, "manualEmpty") : undefined, "");
        return;
    }
    if (!force && al.file === name && al.data) {
        paintInfo(node, "ok", al.data, mkTag());
        return;
    }
    al.file = name;
    probeAudio(node, name)
        .then((data) => {
            // 期间又换文件了？手动清单要比对清单里当前那一项，不能拿 audio 下拉比
            const still = tgt.manual
                ? (readManualList(node)[curListIndex(node, readManualList(node).length)] === name)
                : (wStr(node, "audio") === name);
            if (!still) return;
            al.data = data;
            paintInfo(node, "ok", data, mkTag());
        })
        .catch((e) => {
            al.data = null;
            paintInfo(node, "error", `${T(node, "noProbe")} ${String(e.message || e)}`, mkTag());
        });
}

// ---------------------------------------------------------------------------
// 控件顺序：工具条 → 音频下拉 → 来源 → 文件夹路径 → 起始序号 → 绕回 → 播放器 → 信息条
//    DOM 控件都是 serialize:false，改顺序不影响存档（与 kit 的 pinWidgetToTop 同理）
//    ⚠️ 新控件必须排在「音频文件」后面：老存档 widgets_values 只有 1 个值，
//       按位回填时 audio 对第一位才对得上（fixSavedValues ② 的长度校验同理）。
// ---------------------------------------------------------------------------
function arrangeWidgets(node) {
    const w = node.widgets;
    if (!Array.isArray(w)) return;
    const byName = (n) => w.find((x) => x && x.name === n) || null;
    const head = [BAR_WIDGET, "audio", "source", "audio_folder", "audio_list",
                  "start_index", "loop", LIST_WIDGET, PLAYER_WIDGET, INFO_WIDGET]
        .map(byName).filter(Boolean);
    if (head.length < 2) return;
    const rest = w.filter((x) => head.indexOf(x) === -1);
    w.length = 0;
    w.push(...head, ...rest);
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
            if (!(w.name in named)) continue;
            const v = named[w.name];
            if (v === undefined) continue;
            if (w.type === "combo" && Array.isArray(w.options && w.options.values)
                && !w.options.values.includes(v)) continue;
            w.value = v;
        }
        dirty();
        return;
    }

    // ② 老存档（只有 widgets_values）→ 按位回填。
    //    🔴🔴 绝不 filter 空值（2026-10-16 血案）：官方 LGraphNode.configure 遇到空串
    //    会**跳过一位**（实测：["audio","src","","清单JSON",2,true] 会被它填成
    //    audio_folder=清单JSON、audio_list=2 ⇒ 整体错位一格）。我们这轮修正必须
    //    **连空槽一起按原下标对齐**，才能把官方填歪的那一轮纠正回来。
    //    🔴 新控件永远追加在末尾 ⇒ 老档比现在短时，前 N 位依旧一一对应（1 值的老老档
    //    只回填「音频文件」，5 值的 1.15.x 档回填前 5 个，清单位走默认 "[]"）。
    const vals = saved.widgets_values;
    if (!Array.isArray(vals) || !vals.length) return;
    if (vals.length > real.length) return;      // 存档比控件还长 = 对不上，宁可不动
    real.slice(0, vals.length).forEach((w, i) => {
        let v = vals[i];
        if (v === undefined || v === null) return;          // 这位没值 ⇒ 保持默认
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

        // 按钮 / 控件文案（上传中/成功态不覆盖）
        if (node._xhALBtnTip && !node._xhALBtnBusy) {
            try { node._xhALBtnTip(T(node, "upload")); } catch (e) {}
        }
        if (node._xhALFolderTip) {
            try { node._xhALFolderTip("📂"); } catch (e) {}
            try { node._xhALFolderBtn.title = T(node, "folderTip"); } catch (e) {}
        }
        if (node._xhALModeTip) {
            try {
                node._xhALModeTip(isLoopMode(node) ? T(node, "modeIconToFile") : T(node, "modeIconToFolder"));
            } catch (e) {}
        }
        if (node._xhALModeBtn) {
            try { node._xhALModeBtn.title = T(node, "modeTip"); } catch (e) {}
        }
        if (node._xhALAddTip) { try { node._xhALAddTip(T(node, "addAudio")); } catch (e) {} }
        if (node._xhALClearTip) { try { node._xhALClearTip(T(node, "clearList")); } catch (e) {} }
        renderList(node);
        paintPlayBtn(node);
        paintMuteBtn(node);
        updateProgress(node);
        const al = node._xhAL;
        if (al && al.volInput) al.volInput.title = T(node, "volTip");

        try {
            node.graph?.trigger?.("node:slot-label:changed", { nodeId: node.id, slotType: 1 });
            node.graph?.trigger?.("node:slot-label:changed", { nodeId: node.id, slotType: 2 });
        } catch (e) {}
        refreshInfo(node, false);
        try { node.setDirtyCanvas?.(true, true); } catch (e) {}
    } catch (e) {
        console.warn("[XH LoadAudio] 应用语言失败:", e);
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
// ⑩ 频谱贴底（2026-10-16）：用户把节点拖高 ⇒ 波形区吃掉全部新增高度，信息条贴底
// ---------------------------------------------------------------------------
// 真机实锤（8199 无头实验，xh_al_stretch_exp.mjs）：
//   · Vue 行高**只在首帧**读 computeSize —— 运行期换函数完全不理（实验 B）；
//   · 直接改 DOM Vue 不踩回来（实验 C/D，2.8s 后原样）；
//   · 正解 = widgets 网格 flex:1 + 播放器行轨道 minmax(89px,1fr)：
//     拖到 700 后频谱行吃到 526px、信息条下空白回到自然值 36px（实验 E）。
// 所以：不改 computeSize 存档口径（锁高 89 照旧 = 节点最小高度），只在 DOM 上做弹性，
// 并用 RO（节点拖大缩小）+ MO（Vue 重渲染踩掉内联样式时）兜底重贴。
const STRETCH_TRACK = "minmax(89px,1fr)";

function applyStretch(node) {
    const al = node && node._xhAL;
    if (!al || !al.playerEl || !al.playerEl.isConnected) return;
    const grid = al.playerEl.closest(".lg-node-widgets");
    if (!grid) return;                                   // 老画布模式没有这个容器 → 不做（老模式本来就没空白问题）
    try {
        const rowGroup = al.playerEl.closest(".col-span-full") || al.playerEl.closest(".group");
        if (!rowGroup || rowGroup.parentElement !== grid) return;
        const kids = [...grid.children];
        const idx = kids.indexOf(rowGroup);
        if (idx < 0) return;

        // 底版模板：按「行数」为档各存一份。⚠️ 只信 computed 的**非播放器行**原样抄下来
        // （min-content 之类原样保留，渲染结果一致）；播放器行一律记锁高 89px ——
        // computed 会把我们自己的 minmax 解析成拉伸后的 px，绝不能照抄（越拉越肥）。
        const key = kids.length;
        if (!al._stretchBase || al._stretchBaseKey !== key) {
            // 🔴 先摘掉自家内联再读：computed 会连我们的 minmax 一起解析成拉伸后的 px，
            //    照抄 = 越拉越肥；且模式切换后行数变了，残留旧内联会把 grid 行序搅乱。
            grid.style.gridTemplateRows = "";
            rowGroup.style.gridTemplateRows = "";
            const cur = getComputedStyle(grid).gridTemplateRows
                .split(" ").map((s) => s.trim()).filter(Boolean);
            if (cur.length !== key) {
                // 模式切换重渲染的中途快照常常对不上 ⇒ 限时重试（Vue 渲完就能抓稳）
                if ((al._stretchRetryN || 0) < 40) {
                    al._stretchRetryN = (al._stretchRetryN || 0) + 1;
                    clearTimeout(al._stretchRetryT);
                    al._stretchRetryT = setTimeout(() => applyStretch(node), 250);
                }
                return;
            }
            al._stretchRetryN = 0;
            cur[idx] = PLAYER_H + "px";
            al._stretchBase = cur;
            al._stretchBaseKey = key;
        }

        if (grid.style.flex !== "1 1 auto") grid.style.flex = "1 1 auto";
        const want = al._stretchBase.slice();
        want[idx] = STRETCH_TRACK;
        const wantStr = want.join(" ");
        if (grid.style.gridTemplateRows !== wantStr) grid.style.gridTemplateRows = wantStr;
        // 行容器自身若是 subgrid，换自家定模板（真机 E：两处都设最稳）
        rowGroup.style.gridTemplateRows = STRETCH_TRACK;
    } catch (e) {}
    try { drawSpectrumFrame(node, null); } catch (e) {}  // 新尺寸下重画一帧静止态
}

/** 等 Vue 把节点 DOM 挂出来再上观察器（onNodeCreated 时 DOM 往往还没挂，closest 全空） */
function scheduleStretchWatch(node) {
    if (node._xhALStretchTried) return;
    node._xhALStretchTried = true;
    let tries = 0;
    const tick = () => {
        const al = node && node._xhAL;
        if (!al || node._xhALStretch) return;            // 节点已删 / 已挂好
        const root = al.playerEl && al.playerEl.isConnected
            ? al.playerEl.closest(".lg-node") : null;
        if (!root && ++tries < 40) { setTimeout(tick, 250); return; }   // 最多等 10s
        if (!root) return;
        try {
            applyStretch(node);
            const ro = new ResizeObserver(() => {
                if (node._xhALStretchBusy) return;
                node._xhALStretchBusy = true;
                try { applyStretch(node); } finally {
                    requestAnimationFrame(() => { node._xhALStretchBusy = false; });
                }
            });
            ro.observe(root);
            // Vue 重渲染会重建行元素/踩掉内联样式 → 盯住网格容器，踩掉就重贴
            const grid = al.playerEl.closest(".lg-node-widgets");
            let mo = null;
            if (grid) {
                mo = new MutationObserver(() => {
                    if (node._xhALStretchBusy) return;
                    node._xhALStretchBusy = true;
                    try { applyStretch(node); } finally {
                        requestAnimationFrame(() => { node._xhALStretchBusy = false; });
                    }
                });
                mo.observe(grid, { attributes: true, attributeFilter: ["style", "class"], childList: true });
            }
            node._xhALStretch = { ro, mo };
        } catch (e) {}
        // 底版模板还没抓稳（applyStretch 里判行数不符会放弃）⇒ 继续定时重试，抓到即停
        if (!al._stretchBase && tries < 40) { tries++; setTimeout(tick, 250); }
    };
    setTimeout(tick, 400);
}

// ---------------------------------------------------------------------------
// 注册
// ---------------------------------------------------------------------------
app.registerExtension({
    name: "XH.LoadAudio",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_TYPE) return;

        const origOnCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = origOnCreated?.apply(this, arguments);
            try {
                const node = this;

                // 🔴 先把状态挂上，再让任何 helper 用它 —— 否则 "Cannot set properties of
                //    undefined" 会被下面的 try 吞掉，后面整段界面代码全都不执行（假绿）。
                node._xhAL = {
                    dragging: false,       // 时间线是否正在被拖
                    curFile: "",           // 已挂 src 的文件（同一文件不重挂）
                    stamp: 0,
                    data: null,            // probe 结果
                    file: "",              // 已 probe 的文件名（文件夹模式 = "folder:"+路径）
                    // 频谱（⑦）
                    specRaf: 0,            // rAF id（0 = 没在跑）
                    specDead: false,       // 建图失败 / 节点已删 → 不再起循环
                    specPeaks: new Float32Array(SPEC_BARS),   // 峰值帽
                    // 📂 文件夹模式（⑧）：文件列表预览（null = 未拉/失败，[] = 空文件夹）
                    folderFiles: null,
                    folderDir: "",
                };

                // 隐藏的文件选择器（挂 body，节点删了再移除）
                const fileInput = document.createElement("input");
                fileInput.type = "file";
                fileInput.accept =
                    "audio/*,.wav,.mp3,.flac,.m4a,.aac,.ogg,.opus,.webm,.wma,.mp4,.mkv,.mov";
                fileInput.style.display = "none";
                document.body.appendChild(fileInput);
                node._xhALFileInput = fileInput;

                const uploadBtn = makeUploadButton(node, fileInput);
                node._xhALUploadBtn = uploadBtn;
                const folderBtn = createFolderBtn(node);
                node._xhALFolderBtn = folderBtn;
                const addBtn = createAddAudioBtn(node);
                node._xhALAddBtn = addBtn;
                const clearBtn = createClearBtn(node);
                node._xhALClearBtn = clearBtn;
                const modeBtn = createModeBtn(node);
                node._xhALModeBtn = modeBtn;

                // 标准工具条（中/EN + 🎨）＋ 上传 / 📂 / ⬆加音频 / 清空 / 🔁🎵 模式切换
                //    （家族唯一实现见 web/xh_ui_kit.js；按模式显隐，同时最多显示 5 颗）
                const { bar, langBtn } = makeXHToolbar(node, {
                    appendNodes: [uploadBtn, folderBtn, addBtn, clearBtn, modeBtn],
                });
                node._xhLangBtn = langBtn;

                wireUpload(node, fileInput, uploadBtn);
                makeInfoBar(node);
                makeListWidget(node);
                makePlayer(node);
                arrangeWidgets(node);

                node._xhAL.rootEl = findRootEl(node, node._xhAL.infoEl || bar);
                node._xhAL.barEl = bar;
                attachDrop(node);

                // 音频下拉一改 → 重挂 src + 重读信息条（包住原回调，绝不覆盖）
                const wd = widget(node, "audio");
                if (wd && !wd._xhALHooked) {
                    wd._xhALHooked = true;
                    const orig = wd.callback;
                    wd.callback = function () {
                        const rr = orig ? orig.apply(this, arguments) : undefined;
                        refreshInfo(node, true);
                        syncPlayer(node);
                        return rr;
                    };
                }

                // 📂 / 📋 五件套：来源 / 路径 / 清单 / 起始序号 / 绕回 —— 一改就重算
                //    （包住原回调；需要列表时自己拉；最后统一重画列表区）
                for (const name of ["source", "audio_folder", "audio_list", "start_index", "loop"]) {
                    const w2 = widget(node, name);
                    if (!w2 || w2._xhALHooked) continue;
                    w2._xhALHooked = true;
                    const orig2 = w2.callback;
                    w2.callback = function () {
                        const rr = orig2 ? orig2.apply(this, arguments) : undefined;
                        try {
                            // 来源切换 ⇒ 重排显隐；来源 / 路径一改 ⇒ 重拉列表
                            //    （2026-10-16 修：只认 source 时「手动粘贴路径」不刷预览）
                            if (name === "source") applyModeVisibility(node);
                            if (name === "source" || name === "audio_folder") {
                                if (isFolderMode(node)) {
                                    // 拉完列表必须连播放器一起重挂：同步分支已把 src 卸了
                                    // （文件夹路径还没就绪），不同步补挂 = 播放器空到用户动 start_index 为止
                                    fetchFolderFiles(node).then(() => {
                                        if (node._xhAL) {
                                            refreshInfo(node, true); syncPlayer(node); renderList(node);
                                        }
                                    });
                                } else {
                                    node._xhAL.folderFiles = null;
                                }
                            }
                            refreshInfo(node, true);
                            syncPlayer(node);
                            renderList(node);      // 序号高亮 / 条目内容随任一控件变化
                        } catch (e) {}
                        return rr;
                    };
                }

                applyLang(node);
                // ⑨ 无条件做一次显隐：普通模式（含老存档默认）⇒ 藏四件套 = 小节点；
                //    循环模式 ⇒ 展开四件套 + 藏 audio（applyLang 之后做，按钮文案才对）
                applyModeVisibility(node);
                renderList(node);
                // 读档进来可能就是文件夹模式 ⇒ 先拉列表再刷（异步，完成后自会重刷）
                if (isFolderMode(node)) {
                    fetchFolderFiles(node).then(() => {
                        if (node._xhAL) {
                            refreshInfo(node, true); syncPlayer(node); renderList(node);
                        }
                    });
                }
                refreshInfo(node, true);
                syncPlayer(node);
                // ⑩ 频谱贴底：等 Vue 挂好 DOM 再上 RO/MO（内部幂等，多调无害）
                scheduleStretchWatch(node);
            } catch (e) {
                console.warn("[XH LoadAudio] 界面创建失败:", e);
            }
            return r;
        };

        // 工作流载入 / 切换后：修 widgets 错位 + 重刷信息条与播放器
        const origOnConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (info) {
            const r = origOnConfigure?.apply(this, arguments);
            try {
                fixSavedValues(this, info);
                applyModeVisibility(this);
                renderList(this);
                if (isFolderMode(this)) {
                    fetchFolderFiles(this).then(() => {
                        if (this._xhAL) {
                            refreshInfo(this, true); syncPlayer(this); renderList(this);
                        }
                    });
                }
                refreshInfo(this, true);
                syncPlayer(this);
                applyStretch(this);          // ⑩ 读档/切工作流后 Vue 重排，重贴一次弹性
            } catch (e) {}
            return r;
        };

        const origOnRemoved = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function () {
            try { this._xhALDropCleanup && this._xhALDropCleanup(); } catch (e) {}
            try { this._xhALFileInput && this._xhALFileInput.remove(); } catch (e) {}
            try { this._xhALAddInput && this._xhALAddInput.remove(); } catch (e) {}
            // ⑩ 频谱贴底观察器收工（绝不留后台监听）
            try {
                const st = this._xhALStretch;
                if (st) {
                    if (st.ro) { try { st.ro.disconnect(); } catch (e) {} }
                    if (st.mo) { try { st.mo.disconnect(); } catch (e) {} }
                    this._xhALStretch = null;
                }
                this._xhALStretchTried = false;
            } catch (e) {}
            // 频谱收工：置死 + 停 rAF，绝不留后台循环
            try {
                if (this._xhAL) { this._xhAL.specDead = true; stopSpectrum(this); }
            } catch (e) {}
            try {
                const a = this._xhAL && this._xhAL.audioEl;
                if (a) { a.pause?.(); a.removeAttribute("src"); a.load?.(); }
            } catch (e) {}
            releaseButtons(this);
            return origOnRemoved?.apply(this, arguments);
        };
    },

    async setup() {
        onLangChanged(() => applyLangToAll());
    },
});
