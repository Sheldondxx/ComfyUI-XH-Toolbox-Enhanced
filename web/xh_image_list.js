// 🖼️XH-图片列表 · 家族前端（2026-10-01 重写为使用 xh_ui_kit 套件）
//
// 节点上直接渲染「图片画廊」：每张图显示缩略图 + 显眼的顺序编号（第 1 / 2 / 3 张…），
// 支持：拖拽缩略图改顺序、点 ✕ 删单张、点「清空」全删、点「添加图片」上传多张。
// 配色：添加图片 = 家族草绿 #4BA14B（建设性操作）· 清空 = 标准警示红 #E53935（危险操作）
// 顺序 + 图片信息写回节点的 `images` STRING 控件（JSON），随工作流一起存档。
//
// 中/EN 切换按钮 + 🎨 配色按钮统一走家族套件 xh_ui_kit.js（四之三硬规矩①：新节点一律走 kit）。
// 铁律：只改 label / title，绝不改 name；DOM 画廊 serialize:false 且只 append。
const { app } = window.comfyAPI.app;
const { api } = window.comfyAPI.api;
import {
    ensureLangBridge,
    makeXHToolbar,
    onLangChanged,
    releaseButtons,
    currentLang,
 paintBarBtn} from "./xh_ui_kit.js";

ensureLangBridge();   // ① 早于任何 window.XH_LANG 使用

const NODE_TYPE = "XHImageList";

// 顺序编号配色：前 3 名金/银/铜，其余中性蓝，让「排第几」一眼可辨
const RANK_COLORS = ["#e6b800", "#9aa7b3", "#cd7f32", "#3a7bd5"];
function rankColor(i) {
    return RANK_COLORS[i] || "#3a7bd5";
}

// 画廊内部文案（节点主界面 DOM 自己管理，随语言切换刷新）
const I18N = {
    zh: {
        add: "添加图片",
        clear: "清空",
        hint: "拖拽缩略图可改顺序",
        empty: "（还没有图片：点「添加图片」上传，或在下面那行粘贴文件夹路径后回车）",
        total: "共 %d 张",
        rank: "第 %d 张",
        uploading: "上传中…",
        del: "删除这张",
        batch: "整批",
        loop: "逐张(自循环)",
        modeTip: "切换输出模式：整批输出 或 逐张输出（列表广播）",
        // ★ 2026-10-12：文件夹直接引用（不复制）
        folder: "📂 文件夹",
        folderLoading: "载入中…",
        folderTip: "关联一个文件夹（**不复制、不占硬盘、更不占画布**）：节点上只记下这个路径，"
                 + "151 张图也不会画到画布上，所以画布不会卡；"
                 + "真正出图时才按文件名顺序（1、2、3…10）一张张读。文件夹里换图/加图后点一下即刷新。",
        folderPh: "📂 文件夹路径（例：D:\\素材\\婉儿），粘贴后回车 或 点上方「📂 文件夹」",
        folderEmpty: "这个文件夹里没有图片（或路径不对）",
        folderFail: "载入失败",
        folderNeedPath: "请先在下面这行框里粘贴文件夹路径，再点这里（或直接按回车）",
        folderPicking: "已弹出「选择文件夹」窗口…  没弹出来？把文件夹路径粘到下面那行框里按回车也一样。",
        folderNoPath: "系统读不到这个文件夹的绝对路径。\n请改用粘贴：在资源管理器里进入该文件夹 → 点地址栏 → 复制 → 粘到下面那行框里按回车。",
        folderOk: "✅ 已关联文件夹：%d 张（只记路径，画布零负担；出图时才按顺序读）",
        folderUpd: "✅ 已刷新：%d 张",
        chipN: "%d 张",
        chipTip: "✅ 只记着这个路径 —— 里面的图**没有**加载到画布上（所以不卡）。\n"
               + "出图时会按文件名顺序一张张读。\n"
               + "· 改图/加图后 → 再点一次上面「📂 文件夹」刷新\n"
               + "· 点右上角 ✕ 移除",
        clearConfirm: "确定清空所有图片？",
        clearAgain: "再点一次确认",
    },
    en: {
        add: "Add Images",
        clear: "Clear",
        hint: "Drag thumbnails to reorder",
        empty: "(no images yet — click Add, or paste a folder path in the box below and press Enter)",
        total: "%d images",
        rank: "#%d",
        uploading: "Uploading…",
        del: "Remove",
        batch: "Batch",
        loop: "Each(Loop)",
        modeTip: "Switch output mode: batch or per-image loop",
        folder: "📂 Folder",
        folderLoading: "Loading…",
        folderTip: "Link a folder (no copy, no disk space, and **nothing drawn on the canvas**): the node only "
                 + "remembers the path, so even 151 images won't slow the canvas down. Images are read "
                 + "in filename order (1, 2, 3 … 10) only when you actually run. Click again to refresh "
                 + "after you change files.",
        folderPh: "📂 Folder path (e.g. D:\\assets\\faces) — paste and press Enter",
        folderEmpty: "No images in this folder (or bad path)",
        folderFail: "Load failed",
        folderNeedPath: "Paste a folder path into the box below first, then click here (or just press Enter)",
        folderPicking: "Folder picker opened…  Nothing appeared? Pasting the folder path into the box below works too.",
        folderNoPath: "Cannot read the absolute path of that folder.\nPlease paste it instead: open the folder in Explorer, click the address bar, copy, then paste into the box below and press Enter.",
        folderOk: "✅ Folder linked: %d images (path only — nothing drawn, read in order at run time)",
        folderUpd: "✅ Refreshed: %d",
        chipN: "%d images",
        chipTip: "✅ Only the path is stored — the images are NOT drawn on the canvas (that's why it stays fast).\n"
               + "They are read in filename order when you run.\n"
               + "· Changed/added files? → click 「📂 Folder」 again to refresh\n"
               + "· Click ✕ to remove",
        clearConfirm: "Clear all images?",
        clearAgain: "Click again",
    },
};

// 输出端口名本地化（4B.3）：端口 name 保持英文 count / IMAGE，这里只翻译显示用的 label
const SLOT_I18N = {
    zh: { IMAGE: "图像", count: "数量" },
    en: { IMAGE: "IMAGE", count: "count" },
};
function applySlotLabels(node) {
    const lang = currentLang();
    const dict = SLOT_I18N[lang] || SLOT_I18N.zh;
    for (const s of [...(node.inputs || []), ...(node.outputs || [])]) {
        const txt = s && dict[s.name];
        if (!txt) continue;
        s.label = txt;   // 只改 label，绝不改 name
    }
    try {
        node.graph?.trigger?.("node:slot-label:changed", { nodeId: node.id, slotType: 1 });
        node.graph?.trigger?.("node:slot-label:changed", { nodeId: node.id, slotType: 2 });
    } catch (e) {}
}
function T(key) { return (I18N[currentLang()] || I18N.zh)[key]; }

// 「添加图片」按钮里那个加号 = 内联 SVG
// 🔴 家族铁律：DOM widget 内部的功能图标一律用内联 SVG，不用 emoji
//    （emoji 的 ➕ 在 Windows 上被渲染成**紫色**，控件配色不可控；
//      SVG 用 stroke="currentColor" 就能跟着按钮文字色走，想白就白、想绿就绿）
const ADD_ICON_SVG =
    '<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true" ' +
    'style="display:block;flex:0 0 auto;margin-right:5px">' +
    '<path d="M8 2.6v10.8M2.6 8h10.8" fill="none" stroke="currentColor" ' +
    'stroke-width="2.6" stroke-linecap="round"/></svg>';

// 重写按钮内容 = SVG 加号 + 文字（文案会随语言 / 上传态变，所以统一走这里）
function setAddLabel(btn, text) {
    btn.innerHTML = ADD_ICON_SVG;
    const sp = document.createElement("span");
    sp.style.lineHeight = "1";
    sp.textContent = text;
    btn.appendChild(sp);
}

// 缩略图地址
//   · 普通项（上传进 input/output/temp 的图）→ 走 ComfyUI 自带的 /view
//   · type === "abs"（2026-10-12「📂 文件夹」直接引用的本机文件）→ 走包内路由 /xh/imglist/file
//     带 &v=<mtime>：文件夹里换了图，mtime 变了 ⇒ URL 变了 ⇒ 浏览器缓存放行，缩略图自动更新
function viewUrl(it) {
    if ((it.type || "") === "abs") {
        const p = encodeURIComponent(it.name || "");
        return `/xh/imglist/file?path=${p}${it.mtime ? `&v=${it.mtime}` : ""}`;
    }
    const name = encodeURIComponent(it.name || "");
    const sub = encodeURIComponent(it.subfolder || "");
    const typ = encodeURIComponent(it.type || "input");
    return `/view?filename=${name}&subfolder=${sub}&type=${typ}`;
}

function parseList(str) {
    try {
        const v = typeof str === "string" ? JSON.parse(str) : str;
        return Array.isArray(v) ? v : [];
    } catch (e) { return []; }
}

app.registerExtension({
    name: "XH.ImageList",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_TYPE) return;

        const origOnCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = origOnCreated?.apply(this, arguments);
            try {
                buildGallery(this);                  // 内部已含中/EN + 🎨
                onLangChanged(() => this._xh_refresh_lang?.());  // 语言一变，刷新画廊文案
            } catch (e) {
                console.warn("[XH-图片列表] 初始化失败:", e);
            }
            return r;
        };

        // 从存档加载时，widgets_values 在 onNodeCreated 之后才写入，这里再渲染一次
        const origOnConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            const r = origOnConfigure?.apply(this, arguments);
            const w = this.widgets?.find((x) => x.name === "images");
            this._xh_render?.(w ? w.value : "[]");
            this._xh_restore_folder?.();     // ★ 文件夹路径存在 properties 里，这里回填输入框
            return r;
        };

        const origOnRemoved = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function () {
            releaseButtons(this);
            return origOnRemoved?.apply(this, arguments);
        };
    },
});

function buildGallery(node) {
    const dataWidget = node.widgets?.find((w) => w.name === "images");
    if (!dataWidget) {
        console.warn("[XH-图片列表] 找不到 images 控件");
        return;
    }
    dataWidget.hidden = true;   // 存数据用，不占界面，值照常随工作流存档

    // 把原生 all_segments 开关也隐藏，改到顶部工具条里用一个短按钮切换，
    // 避免它跟中/EN/添加图片按钮挤在同一行重叠。
    const segWidget = node.widgets?.find((w) => w.name === "all_segments");
    if (segWidget) segWidget.hidden = true;

    let list = parseList(dataWidget.value);

    const persist = () => {
        dataWidget.value = JSON.stringify(list);
        try { app.graph?.setDirtyCanvas(true, false); } catch (e) {}
    };

    // ⚠️ min-height:0 是关键：flex 子项默认 min-height:auto ⇒ 不肯收缩到内容以下，
    //    图一多就把整个 DOM 容器撑到几千 px（路径框被挤出节点可视区）。加它才能内部滚动。
    const root = document.createElement("div");
    root.style.cssText = "display:flex;flex-direction:column;gap:6px;padding:4px 2px;width:100%;height:100%;min-height:0;box-sizing:border-box;";
    ["pointerdown", "mousedown", "dblclick", "wheel", "keydown", "click"].forEach((ev) =>
        root.addEventListener(ev, (e) => e.stopPropagation())
    );

    // ---- 内联提示行（★ 2026-10-12）----
    // ⚠️ 桌面版是 Electron，window.alert() 弹窗可能被拦/抛错 ⇒ 反馈一律走这行红/绿字，绝不弹窗。
    // ⚠️ 必须早于 makeXHToolbar 定义：工具条初始化时会立刻回调一次 refreshLang，这里晚了会踩 TDZ。
    const folderMsg = document.createElement("div");
    folderMsg.style.cssText = "display:none;flex:0 0 auto;font-size:11px;line-height:1.35;padding:0 2px;white-space:pre-wrap;word-break:break-all;";
    let msgTimer = 0;
    function showMsg(text, ok, keep) {
        clearTimeout(msgTimer);
        folderMsg.style.display = "block";
        folderMsg.style.color = ok ? "#5FD35F" : "#FF7A7A";
        folderMsg.textContent = text;
        if (ok && !keep) msgTimer = setTimeout(() => { folderMsg.style.display = "none"; }, 4000);
    }

    // ---- 顶部工具条（中/EN + 🎨 + 上传 / 清空 / 提示 / 计数）----
    const addBtn = document.createElement("button");
    addBtn.type = "button";
    // 绿色 = 「添加」这类建设性操作（家族草绿 #4BA14B）
    paintBarBtn(addBtn, "primary");
    addBtn.style.display = "inline-flex";
    addBtn.style.boxSizing = "border-box";
    setAddLabel(addBtn, T("add"));
    addBtn.onmouseenter = () => (addBtn.style.filter = "brightness(1.18)");
    addBtn.onmouseleave = () => (addBtn.style.filter = "none");

    // ---- 输出模式切换按钮（替代原生 all_segments 开关，解决与工具条重叠）----
    const modeBtn = document.createElement("button");
    modeBtn.type = "button";
    modeBtn.title = T("modeTip");
    paintBarBtn(modeBtn, "active");
    modeBtn.style.boxSizing = "border-box";
    function updateModeBtn() {
        const isLoop = segWidget ? !!segWidget.value : false;
        modeBtn.textContent = isLoop ? T("loop") : T("batch");
        // 方案 B：循环模式 = active 档（蓝边蓝字），整批 = neutral 档（暗底）——不写死色值
        paintBarBtn(modeBtn, isLoop ? "active" : "neutral");
        modeBtn.style.filter = "none";
    }
    modeBtn.onmouseenter = () => (modeBtn.style.filter = "brightness(1.18)");
    modeBtn.onmouseleave = () => (modeBtn.style.filter = "none");
    modeBtn.onclick = (e) => {
        e.stopPropagation();
        if (!segWidget) return;
        segWidget.value = !segWidget.value;
        if (typeof segWidget.callback === "function") {
            segWidget.callback(segWidget.value);
        }
        updateModeBtn();
    };
    updateModeBtn();

    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = "image/*";
    fileInput.multiple = true;
    fileInput.style.display = "none";
    addBtn.onclick = (e) => { e.stopPropagation(); fileInput.click(); };

    // ★ 2026-10-12：系统「选择文件夹」对话框。Chromium / Electron 都支持 webkitdirectory
    //   ⇒ 点「📂 文件夹」且输入框为空时弹它（原来只是聚焦输入框 = 用户眼里「点了没反应」）。
    //   能拿到绝对路径就直接走「文件夹引用」（**不复制**）；拿不到（纯浏览器沙箱）只提示改用粘贴，绝不偷偷复制。
    //   取绝对路径的三条路（按可靠性排序）：
    //     ① window.api.getPathForFile(file) —— ComfyUI 桌面版(Electron)自己暴露的桥，内部就是 webUtils
    //     ② file.path                        —— 老版本 Electron 直接挂在 File 上
    //     ③ 都没有（普通浏览器）              → 返回 ""，前端提示「改用粘贴」
    function absPathOf(file) {
        try {
            if (window.api?.getPathForFile) {
                const p = window.api.getPathForFile(file);
                if (p) return String(p);
            }
        } catch (e) {
            console.warn("[XH-图片列表] getPathForFile 失败:", e);
        }
        return file.path || "";
    }

    const dirInput = document.createElement("input");
    dirInput.type = "file";
    dirInput.webkitdirectory = true;
    dirInput.multiple = true;
    dirInput.style.display = "none";
    dirInput.addEventListener("change", (e) => {
        e.stopPropagation();
        const files = Array.from(dirInput.files || []);
        dirInput.value = "";
        if (!files.length) return;
        let first = null, abs0 = "";
        for (const f of files) { const p = absPathOf(f); if (p) { first = f; abs0 = p; break; } }
        if (!first) { showMsg(T("folderNoPath"), false, true); return; }
        const abs = cleanPath(abs0);
        // webkitdirectory 会把子目录的文件也一起返回 ⇒ 按 webkitRelativePath 往上退，回到「你选的那个文件夹」。
        //   rel = 被选文件夹名/…/文件名，层数 n ⇒ 从 abs 往上退 n-1 层（剥掉文件名 + 中间目录）
        //   例：abs=D:/素材/婉儿/raw/1.png，rel=婉儿/raw/1.png（3 层）⇒ 退 2 层 = D:/素材/婉儿
        //   rel 为空（非常规构造，正常 webkitdirectory 不会）⇒ 至少剥掉文件名那一层
        const segs = String(first.webkitRelativePath || "").split("/").filter(Boolean).length;
        const depth = segs > 0 ? segs - 1 : 1;
        let dir = abs;
        for (let i = 0; i < depth; i++) dir = dir.replace(/\/[^/]*$/, "") || dir;
        folderInput.value = dir;
        loadFolder();
    });

    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    // 亮红 = 危险操作（标准警示红 #E53935，原 #5a2230 太闷看不出来是「危险」）
    paintBarBtn(clearBtn, "danger");
    clearBtn.style.boxSizing = "border-box";
    clearBtn.textContent = T("clear");
    clearBtn.onmouseenter = () => (clearBtn.style.filter = "brightness(1.15)");
    clearBtn.onmouseleave = () => (clearBtn.style.filter = "none");
    let clearArmed = 0;   // 「二次点击确认」的计时器（0 = 未武装）
    clearBtn.onclick = (e) => {
        e.stopPropagation();
        if (!list.length) return;
        // ★ 2026-10-12：不用 confirm()（桌面版 Electron 可能拦弹窗 ⇒ 报错）⇒ 改成「二次点击确认」
        if (!clearArmed) {
            clearArmed = setTimeout(() => { clearArmed = 0; clearBtn.textContent = T("clear"); }, 3000);
            clearBtn.textContent = T("clearAgain");
            return;
        }
        clearTimeout(clearArmed);
        clearArmed = 0;
        clearBtn.textContent = T("clear");
        list = [];
        persist();
        render();
    };

    // ---- 📂 文件夹：直接引用本机文件夹里的图（★ 2026-10-12，不复制）----
    // 列表里存 {name: 绝对路径, type: "abs", mtime}；缩略图走后端 /xh/imglist/file 直读原文件；
    // 后端读图（image_list.py）见到 type === "abs" 就直接 open 绝对路径。
    // ⚠️ 不用 window.prompt()：Electron（桌面版）禁用了它，会直接报错 ⇒ 改用节点上这个输入框。
    const folderBtn = document.createElement("button");
    folderBtn.type = "button";
    folderBtn.title = T("folderTip");
    paintBarBtn(folderBtn, "neutral");
    folderBtn.style.boxSizing = "border-box";
    folderBtn.textContent = T("folder");
    folderBtn.onmouseenter = () => (folderBtn.style.filter = "brightness(1.18)");
    folderBtn.onmouseleave = () => (folderBtn.style.filter = "none");

    const folderInput = document.createElement("input");
    folderInput.type = "text";
    folderInput.placeholder = T("folderPh");
    folderInput.style.cssText =
        "width:100%;box-sizing:border-box;height:20px;flex:0 0 auto;" +   // ★ 禁止被 flex 压扁（否则节点一拉小它就消失）
        "background:#0b0f17;color:#cfe3ff;" +
        "border:1px solid rgba(255,255,255,.15);border-radius:4px;padding:0 6px;font-size:11px;outline:none;";
    folderInput.addEventListener("keydown", (e) => {
        e.stopPropagation();                                  // 别让画布抢走回车/按键
        if (e.key === "Enter") loadFolder();
    });
    ["pointerdown", "mousedown", "click", "dblclick", "wheel", "input"].forEach((ev) =>
        folderInput.addEventListener(ev, (e) => e.stopPropagation())
    );

    // 路径随节点一起存档（存在 node.properties，不动后端 INPUT_TYPES）：
    //   下次打开工作流，输入框自动回填上次的文件夹 ⇒ 想刷新只要再点一下「📂 文件夹」
    folderInput.value = node.properties?.xh_folder_path || "";
    node._xh_restore_folder = () => { folderInput.value = node.properties?.xh_folder_path || ""; };

    // ---- 内联提示行在这（见文件上方定义）----
    const INPUT_BORDER = "1px solid rgba(255,255,255,.15)";
    function flashInput(color) {
        folderInput.style.border = `1px solid ${color}`;
        folderInput.style.boxShadow = `0 0 0 2px ${color}55`;
        setTimeout(() => { folderInput.style.border = INPUT_BORDER; folderInput.style.boxShadow = "none"; }, 1500);
    }

    // 路径清洗（★ 2026-10-12）：从资源管理器 / 浏览器 / Git-Bash 各种地方粘来的写法**都认**
    //   "D:\素材"（带引号）· file:///D:/素材 · /d/素材 · D:/素材/ · C:\素材
    function cleanPath(s) {
        let p = String(s || "").trim();
        if (!p) return "";
        const isUNC = p.startsWith("\\\\");                       // \\nas\share 不能被合并成 /nas/share
        if ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'")))
            p = p.slice(1, -1).trim();                            // 去首尾引号
        p = p.replace(/^file:\/\/\/?/i, "");                      // file:///D:/x → D:/x
        const m = p.match(/^\/([a-zA-Z])\/(.*)$/);                // /d/素材 → D:/素材
        if (m) p = `${m[1].toUpperCase()}:/${m[2]}`;
        p = p.replace(/\\/g, "/").replace(/\/+$/, "");            // 统一分隔符、去尾部斜杠
        if (!isUNC) p = p.replace(/\/{2,}/g, "/");
        if (/^[a-zA-Z]:$/.test(p)) p += "/";                      // 光秃秃的 "D:" 补成 "D:/"
        return p;
    }

    // 一次查询（抽出来是为了下面「粘的是图片文件」时能退级重试）
    async function queryDir(dir) {
        const resp = await api.fetchApi(`/xh/imglist/list?dir=${encodeURIComponent(dir)}`);
        const j = await resp.json().catch(() => ({}));
        return { ok: !!resp.ok && !!j.ok, j, status: resp.status };
    }

    // ★ 粘的可能是「某个图片文件」的地址：Win11 在图片上右键 →「复制文件地址」给的就是**带引号的文件路径**，
    //   而不是文件夹路径。原路径必然报「不是有效文件夹」⇒ 自动退到它所在的文件夹再试一次（纯前端兜底，不改后端）。
    const IMG_EXT_RE = /\.(png|jpe?g|webp|bmp|gif|tiff?|avif|jfif)$/i;

    async function loadFolder() {
        const raw = (folderInput.value || "").trim();
        if (!raw) {                                   // ★ 没填路径：明确指路，不再"点了没反应"
            folderInput.focus();
            flashInput("#E53935");
            showMsg(T("folderNeedPath"), false);
            return;
        }
        let dir = cleanPath(raw);
        folderInput.value = dir;                      // 清洗过的路径写回框里，用户看得见
        folderBtn.textContent = T("folderLoading");
        folderBtn.disabled = true;
        try {
            let r = await queryDir(dir);
            let auto = false;
            if (!r.ok && IMG_EXT_RE.test(dir)) {      // 粘的是图片文件 ⇒ 退到它所在的文件夹重试
                const parent = dir.replace(/\/[^/]*$/, "");
                if (parent && parent !== dir) {
                    const r2 = await queryDir(parent);
                    if (r2.ok) { dir = parent; folderInput.value = parent; r = r2; auto = true; }
                }
            }
            if (!r.ok) {
                showMsg(`${T("folderFail")}：${r.j.error || ("HTTP " + r.status)}`, false);
                flashInput("#E53935");
                return;
            }
            const j = r.j;
            if (!j.files || !j.files.length) {
                showMsg(`${T("folderEmpty")}\n${j.dir || dir}`, false);
                flashInput("#E53935");
                return;
            }
            // ★★ 2026-10-12 关键改动：**只往列表里放「一条文件夹条目」**，不再把 151 张图逐个塞进去。
            //    为什么：逐张塞 = 节点上要渲 151 个缩略图 = 151 次图片请求 + 一堆 DOM ⇒ 画布卡成 PPT。
            //    用户在意的就是这件事（他就是为了不卡才用文件夹的）。这里只记路径 + 张数；
            //    真读图在后端出图时（image_list.py::_resolve_paths 见到 type=="folder" 才去列目录）。
            const key = dir.toLowerCase();
            const hit = list.findIndex((x) => (x.type || "") === "folder" &&
                                              String(x.name || "").toLowerCase() === key);
            const entry = { name: dir, subfolder: "", type: "folder",
                            count: j.count, total: j.total, mtime: Date.now(),
                            order: Array.isArray(j.order) ? j.order : [] };  // ★ 调用顺序预览
            let ok;
            if (hit >= 0) { list[hit] = entry; ok = T("folderUpd").replace("%d", String(j.count)); }
            else          { list.push(entry);  ok = T("folderOk").replace("%d", String(j.count)); }
            try {                                   // ★ 记住这个文件夹，随工作流存档（输入框回填用）
                node.properties = node.properties || {};
                node.properties.xh_folder_path = dir;
            } catch (e) {}
            persist();
            render();
            if (auto) ok += `（粘的是图片文件，已自动改用它所在的文件夹：${dir}）`;
            if (j.total > j.count) ok += `（该文件夹共 ${j.total} 张，本次只记前 ${j.count} 张）`;
            showMsg(ok, true);
            flashInput("#4BA14B");
        } catch (e) {
            console.warn("[XH-图片列表] 载入文件夹异常:", e);
            showMsg(`${T("folderFail")}：${e}`, false);
            flashInput("#E53935");
        } finally {
            folderBtn.textContent = T("folder");
            folderBtn.disabled = false;
        }
    }
    // ★ 有路径 → 载入/刷新；没路径 → 弹系统「选择文件夹」框（不再静默无反应）
    //   同时给一行中性提示：万一某些环境弹不出系统选择框，用户也知道可以改用「粘贴路径」。
    folderBtn.onclick = (e) => {
        e.stopPropagation();
        if (!(folderInput.value || "").trim()) {
            showMsg(T("folderPicking"), true);
            dirInput.click();
            return;
        }
        loadFolder();
    };

    const hint = document.createElement("span");
    hint.style.cssText = "color:#9aa7b3;font-size:11px;";
    hint.textContent = T("hint");

    const total = document.createElement("span");
    total.style.cssText = "color:#cfe3ff;font-size:11px;margin-left:8px;";

    // 工具条（中/EN + 🎨 + 输出模式 / 上传 / 清空 / 提示 / 计数）—— 家族唯一实现见 web/xh_ui_kit.js
    const { bar } = makeXHToolbar(node, {
        mount: false,                        // 条要嵌进下面的画廊 root，不单独占一个 widget
        appendNodes: [modeBtn, addBtn, folderBtn, clearBtn, hint, total],
    });

    // ---- 缩略图画廊 ----
    // ⚠️ flex-basis 必须是 0（不是 auto）：用 auto 时画廊会**按内容撑高**，图一多整个 DOM 容器被撑到几千 px，
    //    底下的路径输入框就被挤出节点可视区（用户以为「没这个框」）。basis 0 + min-height:0 ⇒ 内部滚动，不撑父。
    const gallery = document.createElement("div");
    gallery.style.cssText = "display:flex;flex-wrap:wrap;gap:6px;min-height:10px;width:100%;flex:1 1 0%;align-content:flex-start;box-sizing:border-box;overflow:auto;";

    // ★ 顺序：工具条 → 路径输入框 → 提示行 → 缩略图画廊（输入框放顶部，图再多也永远看得见）
    root.appendChild(bar);
    root.appendChild(folderInput);   // ★ 文件夹路径输入框（Electron 下没有 prompt 可用）
    root.appendChild(folderMsg);     // ★ 载入结果提示（绿=成功 / 红=失败），替代被拦的 alert
    root.appendChild(gallery);
    root.appendChild(fileInput);
    root.appendChild(dirInput);      // ★ 隐藏的「选择文件夹」输入（给「📂 文件夹」按钮用）

    // ---- 上传 ----
    fileInput.onchange = async () => {
        const files = Array.from(fileInput.files || []);
        fileInput.value = "";
        if (!files.length) return;
        setAddLabel(addBtn, T("uploading"));
        addBtn.disabled = true;
        try {
            for (const f of files) {
                const fd = new FormData();
                fd.append("image", f);
                fd.append("type", "input");
                const resp = await api.fetchApi("/upload/image", { method: "POST", body: fd });
                if (!resp.ok) { console.warn("[XH-图片列表] 上传失败", resp.status); continue; }
                const info = await resp.json();
                list.push({
                    name: info.name,
                    subfolder: info.subfolder || "",
                    type: info.type || "input",
                });
            }
            persist();
            render();
        } catch (e) {
            console.warn("[XH-图片列表] 上传异常:", e);
        } finally {
            setAddLabel(addBtn, T("add"));
            addBtn.disabled = false;
        }
    };

    // ---- 单张缩略图卡片 ----
    function makeCard(item, index) {
        const card = document.createElement("div");
        card.draggable = true;
        card.style.cssText =
            "position:relative;width:92px;height:104px;border-radius:6px;overflow:hidden;" +
            "border:2px solid rgba(255,255,255,.15);background:#0b0f17;cursor:grab;flex:0 0 auto;";
        card.dataset.idx = String(index);

        const img = document.createElement("img");
        img.src = viewUrl(item);
        img.style.cssText = "width:100%;height:100%;object-fit:cover;display:block;pointer-events:none;";
        img.draggable = false;
        card.appendChild(img);

        const badge = document.createElement("div");
        badge.style.cssText =
            `position:absolute;top:3px;left:3px;min-width:20px;height:20px;padding:0 5px;` +
            `border-radius:10px;background:${rankColor(index)};color:#fff;font-size:12px;font-weight:bold;` +
            `display:flex;align-items:center;justify-content:center;box-shadow:0 1px 3px rgba(0,0,0,.5);`;
        badge.textContent = String(index + 1);
        card.appendChild(badge);

        const cap = document.createElement("div");
        cap.style.cssText =
            "position:absolute;bottom:0;left:0;right:0;background:rgba(0,0,0,.55);color:#fff;" +
            "font-size:10px;text-align:center;padding:1px 0;";
        cap.textContent = T("rank").replace("%d", String(index + 1));
        card.appendChild(cap);

        const del = document.createElement("div");
        del.title = T("del");
        del.textContent = "✕";
        del.style.cssText =
            "position:absolute;top:2px;right:2px;width:18px;height:18px;border-radius:9px;" +
            "background:rgba(0,0,0,.6);color:#fff;font-size:12px;line-height:18px;text-align:center;cursor:pointer;";
        del.onclick = (e) => {
            e.stopPropagation();
            list.splice(index, 1);
            persist();
            render();
        };
        card.appendChild(del);

        card.addEventListener("dragstart", (e) => {
            e.stopPropagation();
            card.style.opacity = "0.4";
            e.dataTransfer.setData("text/xh-img-idx", String(index));
            e.dataTransfer.effectAllowed = "move";
        });
        card.addEventListener("dragend", () => { card.style.opacity = "1"; });
        card.addEventListener("dragover", (e) => { e.preventDefault(); e.stopPropagation(); });
        card.addEventListener("drop", (e) => {
            e.preventDefault();
            e.stopPropagation();
            const from = parseInt(e.dataTransfer.getData("text/xh-img-idx"), 10);
            if (isNaN(from) || from === index) return;
            const [moved] = list.splice(from, 1);
            list.splice(index, 0, moved);
            persist();
            render();
        });

        return card;
    }

    // ---- 文件夹条目卡片（★ 2026-10-12）----
    // 只画一条「📂 文件夹名 · 151 张」的小条，**不渲任何缩略图** ⇒ 画布零负担。
    // 它是列表里的一个可排序项（可拖拽、可 ✕ 删），位置 = 这一组图在输出顺序里的位置。
    function makeFolderChip(item, index) {
        const chip = document.createElement("div");
        chip.draggable = true;
        chip.style.cssText =
            "position:relative;flex:1 1 100%;min-width:0;display:flex;align-items:center;gap:6px;" +
            "box-sizing:border-box;padding:6px 50px 6px 8px;border-radius:6px;cursor:grab;" +
            "border:1px dashed rgba(120,170,255,.45);background:rgba(58,123,213,.12);";
        chip.title = T("chipTip");
        chip.dataset.idx = String(index);

        const ico = document.createElement("span");
        ico.textContent = "📂";
        ico.style.cssText = "flex:0 0 auto;font-size:14px;line-height:1;";
        chip.appendChild(ico);

        const box = document.createElement("div");
        box.style.cssText = "flex:1 1 auto;min-width:0;min-height:0;overflow:hidden;display:flex;flex-direction:column;";
        const nameRow = document.createElement("div");
        nameRow.style.cssText =
            "color:#cfe3ff;font-size:11px;line-height:1.25;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
        nameRow.textContent = String(item.name || "").split(/[\\/]/).filter(Boolean).pop() || item.name || "";
        const sub = document.createElement("div");
        sub.style.cssText = "color:#9aa7b3;font-size:10px;line-height:1.25;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
        sub.textContent = T("chipN").replace("%d", String(item.count || 0));
        box.appendChild(nameRow);
        box.appendChild(sub);
        // ★ 2026-10-19 调用顺序预览：节点实际出图顺序（与资源管理器对照，限高滚动防撑爆）
        if (item.order && item.order.length) {
            const pv = document.createElement("div");
            pv.style.cssText = "margin-top:4px;display:flex;flex-wrap:wrap;gap:3px 6px;max-height:84px;overflow:auto;";
            item.order.forEach((nm, k) => {
                const t = document.createElement("span");
                t.style.cssText = "color:#bcd;font-size:10px;line-height:1.3;background:rgba(120,170,255,.12);border:1px solid rgba(120,170,255,.25);border-radius:3px;padding:0 4px;white-space:nowrap;";
                t.textContent = `第${k+1}段 ${nm}`;
                pv.appendChild(t);
            });
            box.appendChild(pv);
            chip._xh_pv = pv;   // ★ 撑满逻辑（见 render 后的 ResizeObserver）要拿到预览容器
        }
        chip.appendChild(box);

        const badge = document.createElement("div");
        // ★ 2026-10-19（晚）用户反馈：徽标原来垂直居中在右侧，节点拖拽变尺寸时会遮住调用顺序标签
        //    ⇒ 挪到 chip 右上角固定（序号 + ✕ 占住右侧一列，padding-right 已加宽到 50px 让开）
        badge.style.cssText =
            `position:absolute;top:4px;right:26px;min-width:20px;height:20px;padding:0 5px;` +
            `border-radius:10px;background:${rankColor(index)};color:#fff;font-size:12px;font-weight:bold;` +
            `display:flex;align-items:center;justify-content:center;box-shadow:0 1px 3px rgba(0,0,0,.5);`;
        badge.textContent = String(index + 1);
        chip.appendChild(badge);

        const del = document.createElement("div");
        del.title = T("del");
        del.textContent = "✕";
        del.style.cssText =
            "position:absolute;top:4px;right:4px;width:18px;height:18px;border-radius:9px;" +
            "background:rgba(0,0,0,.6);color:#fff;font-size:12px;line-height:18px;text-align:center;cursor:pointer;";
        del.onclick = (e) => {
            e.stopPropagation();
            list.splice(index, 1);
            persist();
            render();
        };
        chip.appendChild(del);

        chip.addEventListener("dragstart", (e) => {
            e.stopPropagation();
            chip.style.opacity = "0.4";
            e.dataTransfer.setData("text/xh-img-idx", String(index));
            e.dataTransfer.effectAllowed = "move";
        });
        chip.addEventListener("dragend", () => { chip.style.opacity = "1"; });
        chip.addEventListener("dragover", (e) => { e.preventDefault(); e.stopPropagation(); });
        chip.addEventListener("drop", (e) => {
            e.preventDefault();
            e.stopPropagation();
            const from = parseInt(e.dataTransfer.getData("text/xh-img-idx"), 10);
            if (isNaN(from) || from === index) return;
            const [moved] = list.splice(from, 1);
            list.splice(index, 0, moved);
            persist();
            render();
        });
        return chip;
    }

    // ★ 2026-10-19（晚）用户要求：只有一个文件夹条目时，让 chip（含调用顺序预览）撑满
    //    画廊剩余高度 —— 节点拖多大预览就多高，下面不留空。多个条目时保持原样（限高滚动）。
    function stretchFolderChip() {
        try {
            const only = (list.length === 1 && list[0].type === "folder"
                          && list[0].order && list[0].order.length) ? gallery.firstElementChild : null;
            if (!only || !only._xh_pv) return;
            const h = gallery.clientHeight - 8;
            if (!(h > 60)) return;
            only.style.height = h + "px";
            only.style.alignItems = "stretch";
            const pv = only._xh_pv;
            pv.style.maxHeight = "none";
            pv.style.flex = "1 1 0";
            pv.style.minHeight = "0";
        } catch (e) {}
    }
    if (typeof ResizeObserver !== "undefined") {
        try { new ResizeObserver(stretchFolderChip).observe(gallery); } catch (e) {}
    }

    function render() {
        while (gallery.firstChild) gallery.removeChild(gallery.firstChild);
        if (!list.length) {
            const empty = document.createElement("div");
            empty.style.cssText = "color:#9aa7b3;font-size:11px;padding:6px 2px;";
            empty.textContent = T("empty");
            gallery.appendChild(empty);
        } else {
            list.forEach((it, i) => gallery.appendChild(
                (it.type === "folder") ? makeFolderChip(it, i) : makeCard(it, i)
            ));
        }
        // 计数按「实际会出多少张图」算：文件夹条目按它的张数计（不是按条目数）
        const n = list.reduce((a, it) => a + ((it.type === "folder") ? (it.count || 0) : 1), 0);
        total.textContent = T("total").replace("%d", String(n));
        // chip 撑满要在挂进 DOM、画廊有实际高度后再算
        requestAnimationFrame(stretchFolderChip);
    }

    // 语言切换时刷新画廊文案（顶部按钮 + 卡片「第N张」+ 端口名）
    function refreshLang() {
        setAddLabel(addBtn, T("add"));
        clearBtn.textContent = T("clear");
        folderBtn.textContent = T("folder");
        folderBtn.title = T("folderTip");
        folderInput.placeholder = T("folderPh");
        folderMsg.style.display = "none";   // ★ 上次的提示是旧语言的文案，切语言时直接收掉
        hint.textContent = T("hint");
        modeBtn.title = T("modeTip");
        updateModeBtn();
        applySlotLabels(node);
        render();
    }

    node._xh_render = (val) => { list = parseList(val); render(); };
    node._xh_refresh_lang = refreshLang;
    render();

    const galleryWidget = node.addDOMWidget("xh_imglist_gallery", "custom", root, {
        serialize: false,
        hideOnZoom: false,
        getMinHeight: () => 240,   // 画廊默认高度；节点拉宽时自动多排几列，图多则内部滚动
    });

    // 把画廊整体上移，盖住 ComfyUI 在标题栏下方预留的 input slots 死区
    requestAnimationFrame(() => {
        const wrap = root.parentElement;
        if (wrap) {
            wrap.style.overflow = "visible";
            wrap.style.paddingTop = "0";
            wrap.style.marginTop = "0";
        }
        root.style.marginTop = "-24px";
    });

    // ★ 画廊高度封顶（2026-10-12）：ComfyUI 的 DOM widget 容器高度是「内容决定」的（auto），
    //   单靠 CSS 的 height:100% / flex 都压不住 ⇒ 图一多整个容器被撑到几千 px。
    //   这里按节点高度给画廊算一个 max-height：超出就在画廊**内部**滚动，节点再也不被撑爆。
    const applyGalleryH = () => {
        const avail = Math.max(80, (node.size?.[1] || 420) - 130);   // 减掉工具条+路径框+提示行+内边距
        gallery.style.maxHeight = avail + "px";
    };
    applyGalleryH();
    const _origOnResize = node.onResize;
    node.onResize = function () {
        const r = _origOnResize?.apply(this, arguments);
        try { applyGalleryH(); } catch (e) {}
        return r;
    };

    // 保留 widget 引用，方便外部需要时调试
    node._xh_gallery_widget = galleryWidget;
}
