// 🪟 XH-悬浮任意窗口 · 前端（原名：🎬XH-悬浮视频窗）
// ★ 2026-10-20 重做（用户原话："根本就不会用，并且没有按照我们 XH 家族风格来做"）
// ★ 2026-10-20 02:50 重定位：用户自己发现**浏览器自带画中画**看视频更好用（GPU 合成、默认置顶）。
//   画中画只浮得了 <video>，浮不了整个窗口 ⇒ 本节点改成"浮**任意**窗口"。
//   ⚠️ 节点 type 仍是 XHFloatVideo（老工作流不能断），只改显示名。
// ★ 2026-10-20 03:40 **多窗口管理**（用户："每一个窗口是单独控制的，可以多个窗口同时存在"）：
//     · 同一个角落的第 N 个窗口自动级联错开 26px（原来全叠一起 = 等于只浮了一个）
//     · 节点里多一条「已悬浮列表」：每个窗口一行，可**单独重摆 / 单独还原**
//     · 后端 restore 支持传 hwnd ⇒ 只还原这一个；不传才全部还原
//     · 刷新页面后自动把"当前还浮着的窗口"列回来（不然忘了浮了哪些就还原不回去了）
//
// 家族风格：工具条走 xh_ui_kit 的 makeXHToolbar（🌐 中英 + 🎨 颜色 + 统一按钮规格），
//          按钮反馈走《按钮反馈规范》（文字变结果 + 底色闪 + 弹跳），配色一律 #0f3460 深蓝。
import { ensureLangBridge, makeXHToolbar, onLangChanged, lockDomWidgetHeight, makeXHSlider , paintBarBtn} from "./xh_ui_kit.js";

ensureLangBridge();

const { app } = window.comfyAPI.app;
const NODE_TYPE = "XHFloatVideo";

// 程序名 → 中文小名（下拉框里比 msedge.exe 好认多了）
const EXE_LABEL = {
    "msedge.exe": "Edge", "chrome.exe": "Chrome", "firefox.exe": "Firefox",
    "explorer.exe": "资源管理器", "jianyingpro.exe": "剪映",
    "quark_cloud_drive.exe": "夸克", "comfy desktop.exe": "ComfyUI",
    "workbuddy.exe": "WorkBuddy", "code.exe": "VSCode", "notepad++.exe": "Notepad++",
    "potplayermini.exe": "PotPlayer", "potplayer.exe": "PotPlayer",
    "wechat.exe": "微信", "weixin.exe": "微信", "qq.exe": "QQ",
    "windowsterminal.exe": "终端", "powershell.exe": "PowerShell", "cmd.exe": "CMD",
};
const shortExe = (e) =>
    EXE_LABEL[(e || "").toLowerCase()] || String(e || "").replace(/\.exe$/i, "");

// 尺寸预设的「存档 key → 显示文字」映射（key 不动，见后端 SIZE_PRESETS 注释）
const PRESET_LABEL = {
    "小 520×220": "小 640×360",
    "中 700×300": "中 800×450",
    "大 900×400": "大 1024×576",
    "超大 1100×480": "超大 1280×720",
};

const I18N = {
    zh: {
        node: "🪟XH-悬浮任意窗口",
        scan: "🔍 扫描",
        float: "🪟 悬浮",
        restoreAll: "↺ 全还原",
        okFloat: "已悬浮",
        okRestore: "已还原",
        fail: "失败",
        tipScan: "扫描当前打开的**所有**窗口列到下拉框（浏览器排最前，最小化的也能浮）",
        tipFloat: "把选中的窗口钉在画布最上层并缩小（可以连续浮多个）",
        tipRestoreAll: "把**所有**悬浮中的窗口一起还原（只还原某一个请用列表里的 ↺）",
        hint: "① 🔍扫描 → ② 选窗口 → ③ 🪟悬浮 · 可同时浮多个（16:9 适合看视频）",
        scanNone: "没找到可悬浮的窗口：先把要浮的窗口打开（最小化也行）",
        scanOk: (n) => `找到 ${n} 个窗口（浏览器在最前），选一个后点 🪟 悬浮`,
        floated: (t) => `已悬浮：${t}`,
        floatedAt: (t, w, h, x, y) => `✅ 已悬浮 ${w}×${h} @(${x},${y})｜${t}`,
        notTop: "⚠ 已移动但没置顶成功",
        restored: "已全部还原（位置 / 大小 / 透明度都恢复了）",
        restoredOne: (t) => `↺ 已还原：${t}`,
        stillFloating: (n) => `｜还有 ${n} 个在悬浮`,
        needPick: "先在下拉框里选一个窗口",
        needRestart: "⚠ 后端还是旧版：请重启 ComfyUI 后再用（这次误动的窗口已帮你还原）",
        selTitle: "挑一个要悬浮的窗口（浏览器排在最前）",
        minimized: "（最小化）",
        minLimit: (rw, rh, aw, ah) =>
            `⚠ 要 ${rw}×${rh}，但这窗口最小就是 ${aw}×${ah}（Windows 强制，改不了）`,
        // ---- 多窗口管理列表 ----
        listHead: (n) => `已悬浮 ${n} 个（同一角落会自动错开）`,
        listEmpty: "还没悬浮任何窗口",
        tipReFloat: "用节点当前的尺寸/角落/透明度，把这个窗口重新摆一次",
        tipRestoreOne: "只还原这一个窗口，其它浮窗不受影响",
    },
    en: {
        node: "🪟XH-Float Any Window",
        scan: "🔍 Scan",
        float: "🪟 Float",
        restoreAll: "↺ All",
        okFloat: "Floating",
        okRestore: "Restored",
        fail: "Failed",
        tipScan: "Scan all open windows into the dropdown (browsers first, minimized OK)",
        tipFloat: "Pin the selected window on top and shrink it (can float several)",
        tipRestoreAll: "Restore **all** floating windows (use ↺ in the list for just one)",
        hint: "① Scan → ② pick a window → ③ Float · several at once",
        scanNone: "No window found — open the window you want to float",
        scanOk: (n) => `Found ${n} window(s), pick one then press 🪟 Float`,
        floated: (t) => `Floating: ${t}`,
        floatedAt: (t, w, h, x, y) => `✅ Floated ${w}×${h} @(${x},${y}) | ${t}`,
        notTop: "⚠ Moved but could not stay on top",
        restored: "Restored all (position / size / opacity)",
        restoredOne: (t) => `↺ Restored: ${t}`,
        stillFloating: (n) => `| ${n} still floating`,
        needPick: "Pick a window in the dropdown first",
        needRestart: "⚠ Old backend: restart ComfyUI (restored the window)",
        selTitle: "Pick a window to float (browsers first)",
        minimized: " (minimized)",
        minLimit: (rw, rh, aw, ah) =>
            `⚠ Wanted ${rw}x${rh}, but this window min is ${aw}x${ah} (forced by Windows)`,
        listHead: (n) => `${n} floating (same corner auto-cascades)`,
        listEmpty: "Nothing floating yet",
        tipReFloat: "Re-place this window with the current size/corner/opacity",
        tipRestoreOne: "Restore only this window, others stay floating",
    },
};
const pack = () => I18N[window.XH_LANG] || I18N.zh;

const wOf = (node, name) => (node.widgets || []).find((w) => w && w.name === name);
const valOf = (node, name, dflt) => {
    const w = wOf(node, name);
    const v = w ? w.value : dflt;
    return (v === undefined || v === null || v === "") ? dflt : v;
};

/** 家族按钮规格（references/家族配色规范.md 第三节）：22px 高、#0f3460 深蓝、hover 提亮 */
function makeBtn(text, tip) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = text;
    btn.title = tip;
    btn.style.cssText =
        "background:#262d38;color:#d5dde5;border:1px solid rgba(255,255,255,.10);border-radius:4px;padding:0 9px;" +
        "font-size:12px;font-weight:bold;cursor:pointer;display:flex;align-items:center;" +
        "justify-content:center;flex:0 0 auto;white-space:nowrap;user-select:none;" +
        "transition:filter .15s,background .15s,transform .12s;";
    btn.onmouseenter = () => { btn.style.filter = "brightness(1.25)"; };
    btn.onmouseleave = () => { btn.style.filter = "none"; };
    ["pointerdown", "mousedown", "dblclick", "keydown", "click"].forEach((ev) =>
        btn.addEventListener(ev, (e) => e.stopPropagation())
    );
    return btn;
}

/** 列表行里的小按钮（20px，只放一个图标，别把行撑爆） */
function makeMiniBtn(text, tip) {
    const b = makeBtn(text, tip);
    b.style.height = "18px";
    b.style.padding = "0 5px";
    b.style.fontSize = "11px";
    return b;
}

/** 强反馈：文字变结果 + 底色闪 3 下 + 弹跳（家族规范，见 references/按钮反馈规范.md） */
function pulse(btn, text, ok) {
    if (!btn) return;
    const oldText = btn.textContent;
    const oldBg = btn.style.background;
    const color = ok ? "#4BA14B" : "#E53935";
    btn.textContent = text;
    btn.style.transform = "scale(1.3)";
    setTimeout(() => { btn.style.transform = "scale(1)"; }, 150);
    let i = 0;
    const t = setInterval(() => {
        i++;
        btn.style.background = (i % 2) ? color : oldBg;
        if (i >= 6) {
            clearInterval(t);
            btn.style.background = oldBg;
            btn.textContent = oldText;
        }
    }, 140);
}

async function callApi(payload) {
    const resp = await fetch("/xh/floatwindow/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
    return resp.json();
}

// 不透明度滑块：**用家族统一实现** xh_ui_kit.makeXHSlider（和 🔁XH-滑块 节点同一个组件）。
// 🔴 2026-10-20 教训（用户原话："家族还有一个节点是拥有滑块的……能不能统一风格统一一下"）：
//    我原先在这里又画了一套（深蓝大把手 + 进度填充），外观和家族滑块完全不一样 ⇒ 已删除。
//    以后要改滑块样式，只改 xh_ui_kit.js 一处，所有节点一起变。

// 旧后端不认识 action=floating，会把它**当成 float 直接执行** ⇒ 只在第一次提示一次 + 立刻还原兜底
let _WARNED_OLD = false;

function buildToolbar(node) {
    if (node._xh_fw_bar) return;
    const p = pack();

    // 默认尺寸要把「6 个参数行 + 工具条 + 列表(4 行) + 状态行」全装下，
    // 否则最后一行会被节点边框裁掉（实测第三行只显示一半）。
    try {
        if (node.size && (node.size[0] < 390 || node.size[1] < 415)) {
            node.setSize([Math.max(node.size[0] || 0, 390), Math.max(node.size[1] || 0, 415)]);
        }
    } catch (e) {}

    const relabel = (name, txt) => { const w = wOf(node, name); if (w) w.label = txt; };
    relabel("size_preset", "尺寸预设（16:9）");
    relabel("corner", "停靠角落");
    relabel("opacity", "不透明度 %");
    relabel("width", "自定义宽");
    relabel("height", "自定义高");
    // 🔴 隐藏「标题关键词」：扫描后压根不用填，留在节点上白占一行还把滑块挤下去。
    //    只隐藏渲染，widgets 数组里的它还在 ⇒ 老工作流的值照常保存，不会报错。
    try {
        const wKw = wOf(node, "title_keyword");
        if (wKw) { wKw.options.hidden = true; wKw.hidden = true; }
    } catch (e) {}

    // ===== 不透明度：隐藏原生数字框，换成自己画的大滑块 =====
    const wOpacity = wOf(node, "opacity");
    try {
        if (wOpacity) {
            wOpacity.options.hidden = true;
            wOpacity.hidden = true;                 // 真机实测：这两个都要设，只设 advanced 无效
        }
    } catch (e) {}
    const slider = makeXHSlider({
        min: 30, max: 100, step: 5, value: Number(valOf(node, "opacity", 100)),
        label: "不透明度", numWidth: 62,
        labelTitle: "浮窗透明度：100% = 完全不透明，30% = 很淡（压住画布时好用）",
        tip: "浮窗透明度 30~100%",
        onInput: (v) => {
            try {
                if (wOpacity) {
                    wOpacity.value = v;
                    if (wOpacity.callback) wOpacity.callback(v, app.canvas, node, [0, 0], {});
                }
            } catch (e) {}
            if (node.setDirtyCanvas) node.setDirtyCanvas(true, true);
        },
    });
    // 别的控件（尺寸预设等）变了也要同步滑块
    try {
        if (wOpacity && wOpacity.callback) {
            const orig = wOpacity.callback;
            wOpacity.callback = function () {
                try { if (orig) orig.apply(this, arguments); } catch (e) {}
                try { slider.set(Number(wOpacity.value)); } catch (e) {}
            };
        }
    } catch (e) {}

    try {
        const wp0 = wOf(node, "size_preset");
        if (wp0 && wp0.options) {
            // ★ 2026-10-20：后端把预设全改成 16:9 了（原来 700×300 是 2.3:1 超宽扁，看不了视频），
            //   但**存档 key 不能改**（老工作流存的就是 "中 700×300"）⇒ 这里只改显示文字。
            wp0.options.getOptionLabel = (v) => {
                const s = String(v == null ? "" : v);
                if (s === "自定义（用下面两个数值）") return "自定义（用下方宽高）";
                return PRESET_LABEL[s] || s;
            };
        }
    } catch (e) {}

    const CUSTOM = "自定义（用下面两个数值）";
    const wPreset = wOf(node, "size_preset");
    ["width", "height"].forEach((nm) => {
        const w = wOf(node, nm);
        if (!w) return;
        const origCb = w.callback;
        w.callback = function () {
            try { if (origCb) origCb.apply(this, arguments); } catch (e) {}
            try {
                if (wPreset && wPreset.value !== CUSTOM) {
                    wPreset.value = CUSTOM;
                    if (node.setDirtyCanvas) node.setDirtyCanvas(true, true);
                }
            } catch (e) {}
        };
    });

    // ---------- 第一行：扫描下拉 + 扫描按钮 ----------
    const row = document.createElement("div");
    row.style.cssText =
        "display:flex;flex-direction:column;gap:3px;width:100%;box-sizing:border-box;padding:0 2px;";
    const line = document.createElement("div");
    line.style.cssText = "display:flex;gap:4px;align-items:center;width:100%;";

    const sel = document.createElement("select");
    sel.title = p.selTitle;
    sel.style.cssText =
        "flex:1 1 auto;min-width:0;height:22px;background:#222;color:#ddd;border:1px solid #444;" +
        "border-radius:4px;font-size:11px;padding:0 4px;";
    const op0 = document.createElement("option");
    op0.value = "";
    op0.textContent = p.needPick;
    sel.appendChild(op0);

    const scanBtn = makeBtn(p.scan, p.tipScan);
    line.appendChild(sel);
    line.appendChild(scanBtn);

    // ---------- 第二块：已悬浮窗口列表（每个窗口单独一行 → 单独控制）----------
    const head = document.createElement("div");
    head.style.cssText =
        "display:flex;align-items:center;justify-content:space-between;gap:4px;" +
        "font-size:10px;color:#7f96ab;height:14px;";
    const headTxt = document.createElement("span");
    headTxt.textContent = p.listEmpty;
    head.appendChild(headTxt);

    const listBox = document.createElement("div");
    listBox.style.cssText =
        "display:flex;flex-direction:column;gap:2px;max-height:84px;overflow-y:auto;" +
        "border:1px solid #333;border-radius:4px;padding:2px;background:rgba(0,0,0,.18);" +
        "scrollbar-width:thin;";

    /** 拉一次「当前正在悬浮的窗口」，渲染成列表 */
    const refresh = async () => {
        let r = null;
        try {
            r = await callApi({ action: "floating" });
        } catch (e) {
            return;
        }
        // 🔴 旧后端没有 floating 分支 ⇒ 会把请求当 float 执行（误浮窗口）⇒ 提示 + 立刻还原兜底
        if (!r || !Array.isArray(r.floating)) {
            try { await callApi({ action: "restore" }); } catch (e) {}
            if (!_WARNED_OLD) {
                _WARNED_OLD = true;
                status.textContent = p.needRestart;
                status.style.color = "#E53935";
            }
            return;
        }
        headTxt.textContent = r.count ? p.listHead(r.count) : p.listEmpty;
        listBox.innerHTML = "";
        for (const f of r.floating) {
            const li = document.createElement("div");
            li.style.cssText = "display:flex;align-items:center;gap:3px;height:18px;";

            const nm = document.createElement("div");
            nm.style.cssText =
                "flex:1 1 auto;min-width:0;font-size:10px;color:#cfd8e3;cursor:pointer;" +
                "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
            const full = String(f.title || "(无标题)");
            const tag = shortExe(f.exe);
            const sz = (f.size && f.size[0]) ? `${f.size[0]}×${f.size[1]}` : "";
            nm.textContent = `${tag ? tag + " · " : ""}${full.slice(0, 14)}${sz ? " " + sz : ""}`;
            nm.title = `${full}\n${f.exe || ""}\n尺寸 ${sz} · 位置 (${(f.pos || [])[0]},${(f.pos || [])[1]})`
                + `\n${p.tipReFloat}`;
            // 点名字 = 把下拉框切到这个窗口，方便接着改设置重摆
            nm.addEventListener("click", async (e) => {
                e.stopPropagation();
                sel.value = String(f.hwnd);
            });
            li.appendChild(nm);

            // 🪟 单独重摆：用节点当前设置，只动这一个窗口
            const bRe = makeMiniBtn("🪟", p.tipReFloat);
            bRe.addEventListener("click", async (e) => {
                e.stopPropagation();
                await doFloat(f.hwnd, bRe);
            });
            // ↺ 单独还原：只还原这一个，其它浮窗不受影响
            const bRs = makeMiniBtn("↺", p.tipRestoreOne);
            bRs.addEventListener("click", async (e) => {
                e.stopPropagation();
                try {
                    const rr = await callApi({ action: "restore", hwnd: f.hwnd });
                    if (rr && rr.ok) {
                        status.textContent = p.restoredOne(String(f.title || "").slice(0, 16)) +
                            (rr.still_floating ? " " + p.stillFloating(rr.still_floating) : "");
                        status.style.color = "#4BA14B";
                        pulse(bRs, "↺", true);
                    } else {
                        status.textContent = "⚠ " + ((rr && rr.error) ? String(rr.error) : p.fail);
                        status.style.color = "#E53935";
                        pulse(bRs, "⚠", false);
                    }
                } catch (err) {
                    status.textContent = "⚠ " + p.fail;
                    status.style.color = "#E53935";
                }
                await refresh();
            });
            li.appendChild(bRe);
            li.appendChild(bRs);
            listBox.appendChild(li);
        }
    };

    const status = document.createElement("div");
    status.style.cssText =
        "font-size:10px;line-height:1.3;color:#9fb4c7;white-space:normal;word-break:break-all;" +
        "overflow:hidden;max-height:42px;";
    status.textContent = p.hint;

    row.appendChild(slider.root);          // ★ 家族统一滑块（放最上面，最显眼）
    row.appendChild(line);
    row.appendChild(head);
    row.appendChild(listBox);
    row.appendChild(status);
    ["pointerdown", "mousedown", "dblclick", "keydown", "click"].forEach((ev) =>
        row.addEventListener(ev, (e) => e.stopPropagation())
    );

    // ---------- 悬浮一个窗口（工具条按钮 / 列表行内重摆 都走这里）----------
    const doFloat = async (hwnd, feedbackBtn) => {
        const fb = feedbackBtn || floatBtn;
        try {
            const r = await callApi({
                action: "float",
                hwnd,
                size_preset: valOf(node, "size_preset", "中 700×300"),
                width: valOf(node, "width", 480),
                height: valOf(node, "height", 270),
                corner: valOf(node, "corner", "右上"),
                opacity: valOf(node, "opacity", 100),
                title_keyword: valOf(node, "title_keyword", ""),
            });
            if (r && r.ok) {
                const act = r.actual || [];
                const sz = r.size || [];
                const req = r.requested || [];
                const tShort = String(r.title || "").slice(0, 16);
                let extra = "";
                if (req[2] && sz[0] && (Math.abs(req[2] - sz[0]) > 3 || Math.abs(req[3] - sz[1]) > 3)) {
                    extra = "\n" + p.minLimit(req[2], req[3], sz[0], sz[1]);
                }
                if (r.topmost === false) {
                    status.textContent = p.notTop + " " + `${sz[0] || "?"}×${sz[1] || "?"}` + extra;
                    status.style.color = "#E53935";
                } else {
                    status.textContent =
                        p.floatedAt(tShort, sz[0] || "?", sz[1] || "?", act[0], act[1]) + extra;
                    status.style.color = "#4BA14B";
                }
                status.title = `${r.title || ""}\n实际位置 ${JSON.stringify(act)}`;
                pulse(fb, "✅ " + p.okFloat, true);
            } else {
                status.textContent = "⚠ " + ((r && r.error) ? String(r.error) : p.fail);
                status.style.color = "#E53935";
                pulse(fb, "⚠ " + p.fail, false);
            }
        } catch (err) {
            status.textContent = "⚠ " + p.fail;
            status.style.color = "#E53935";
            pulse(fb, "⚠ " + p.fail, false);
        }
        await refresh();
    };

    // ---------- 工具条：🪟 悬浮 / ↺ 全还原 ----------
    const floatBtn = makeBtn(p.float, p.tipFloat);
    floatBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const hwnd = sel.value ? Number(sel.value) : null;
        if (!hwnd) {
            status.textContent = p.needPick;
            status.style.color = "#E53935";
            pulse(floatBtn, "⚠ " + p.fail, false);
            return;
        }
        await doFloat(hwnd, floatBtn);
    });

    const restoreBtn = makeBtn(p.restoreAll, p.tipRestoreAll);
    restoreBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        try {
            const r = await callApi({ action: "restore" });     // 不带 hwnd = 全部还原
            if (r && r.ok) {
                status.textContent = p.restored;
                status.style.color = "#9fb4c7";
                pulse(restoreBtn, "↺ " + p.okRestore, true);
            } else {
                status.textContent = "⚠ " + ((r && r.error) ? String(r.error) : p.fail);
                status.style.color = "#E53935";
                pulse(restoreBtn, "⚠ " + p.fail, false);
            }
        } catch (err) {
            status.textContent = "⚠ " + p.fail;
            status.style.color = "#E53935";
            pulse(restoreBtn, "⚠ " + p.fail, false);
        }
        await refresh();
    });

    scanBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        try {
            const r = await callApi({ action: "list" });
            sel.innerHTML = "";
            if (r && r.ok && r.windows && r.windows.length) {
                for (const w of r.windows) {
                    const op = document.createElement("option");
                    op.value = String(w.hwnd);
                    const tag = shortExe(w.exe);
                    const tail = w.minimized ? p.minimized : "";
                    op.textContent = (tag ? tag + " · " : "") +
                        String(w.title || "(无标题)").slice(0, 30) + tail;
                    sel.appendChild(op);
                }
                status.textContent = p.scanOk(r.windows.length);
                status.style.color = "#9fb4c7";
                pulse(scanBtn, `✅ ${r.windows.length}`, true);
            } else if (r && r.ok && r.title !== undefined && r.windows === undefined) {
                try { await callApi({ action: "restore" }); } catch (e) {}
                const op = document.createElement("option");
                op.value = "";
                op.textContent = p.needRestart;
                sel.appendChild(op);
                status.textContent = p.needRestart;
                status.style.color = "#E53935";
                pulse(scanBtn, "⚠ 重启", false);
            } else {
                const op = document.createElement("option");
                op.value = "";
                op.textContent = p.scanNone;
                sel.appendChild(op);
                status.textContent = (r && r.error) ? String(r.error) : p.scanNone;
                status.style.color = "#E53935";
                pulse(scanBtn, "⚠ 0", false);
            }
        } catch (err) {
            status.textContent = "⚠ " + p.fail;
            status.style.color = "#E53935";
            pulse(scanBtn, "⚠ " + p.fail, false);
        }
    });

    try {
        const { bar } = makeXHToolbar(node, {
            widgetName: "xh_fw_bar",
            appendNodes: [floatBtn, restoreBtn],
        });
        node._xh_fw_bar = bar;
    } catch (e) {
        console.warn("[XH-FloatVideo] 工具条挂载失败:", e);
    }

    try {
        const w2 = node.addDOMWidget("xh_fw_target", "custom", row, {
            serialize: false,
            hideOnZoom: false,
        });
        try {
            // 滑块行 26 + 下拉行 22 + 列表头 14 + 列表区 84（4 行）+ 状态行 ~20 ≈ 182
            lockDomWidgetHeight(w2, 182);
            w2.serialize = false;
            if (w2.options) w2.options.serialize = false;
            w2.serializeValue = () => undefined;
        } catch (e) {}
        // ⚠️ 试过把 w2 在 node.widgets 里挪到「停靠角落」后面 —— **无效**：Vue 组件不监听
        //    widgets 数组的 splice，DOM 不会重排（真机验证：滑块 y 仍在角落下面很远）。
        //    改用「隐藏用不到的控件」来腾位置，见上面的 title_keyword 隐藏。
        node._xh_fw_row = row;
        node._xh_fw_widget = w2;
        node._xh_fw_refresh = refresh;
    } catch (e) {
        console.warn("[XH-FloatVideo] 窗口管理行挂载失败:", e);
    }

    // 🔴 建节点时 widgets_values 还没回填 ⇒ 滑块初值读到的是默认值（不是工作流里存的值）。
    //    等 400ms 再从 widget 同步一次真实值（实测：存 70 会先显示 100）。
    //    顺带把"当前还浮着的窗口"列出来（刷新页面/新增节点都不会丢失对已浮窗口的控制）。
    try {
        setTimeout(() => {
            try { slider.set(Number(valOf(node, "opacity", 100))); } catch (e) {}
            refresh();
        }, 400);
    } catch (e) {}
}

app.registerExtension({
    name: "XH.FloatVideo",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_TYPE) return;
        const orig = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = orig ? orig.apply(this, arguments) : undefined;
            try { buildToolbar(this); } catch (e) {}
            return r;
        };
    },

    async nodeCreated(node) {
        if (node.comfyClass === NODE_TYPE || node.type === NODE_TYPE) {
            try { buildToolbar(node); } catch (e) {}
        }
    },

    async setup() {
        onLangChanged(() => {
            for (const n of (app.graph ? app.graph._nodes || [] : [])) {
                if (n.type !== NODE_TYPE && n.comfyClass !== NODE_TYPE) continue;
                if (n._xh_fw_bar) { try { n._xh_fw_bar.remove(); } catch (e) {} n._xh_fw_bar = null; }
                if (n._xh_fw_row) { try { n._xh_fw_row.remove(); } catch (e) {} n._xh_fw_row = null; }
                try { buildToolbar(n); } catch (e) {}
            }
        });
    },
});
