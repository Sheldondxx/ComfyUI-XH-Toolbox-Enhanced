// 📋 XH 工具箱 · 设置面板「关于」徽章（纯前端扩展，不是节点）
//
// 作用：在 ComfyUI 设置面板的「🔧 XH 工具箱 → 关于」里画一排徽章：
//   版本号（灰字、纯信息、点不了）+ B 站频道（粉底、可点开新标签）。
//
// 🔴 为什么自己用 CSS 画，不用 shields.io 的图片徽章（小助手那排就是）：
//   ① shields.io 在国内经常打不开 / 加载极慢 ⇒ 整排徽章变成一堆碎图；
//   ② 图片徽章的圆角/字重/边框跟家族工具条按钮对不上；
//   ③ 版本号是纯文字，用图片反而多一次网络往返、还丢掉字体渲染。
//   CSS 画的离线可用、秒开、配色直接取自 web/xh_ui_kit.js 的 BAR_COLORS。
//
// 🔴 版本号唯一真源 = 后端 __init__.py 的 VERSION（启动时 GET /xh/about 取一次）。
//   取不到就显示「版本 —」，**绝不硬编码一个假版本号糊弄** —— 那比不显示更糟。
//
// 🔴 category 三级：[扩展名, 分组, 项名]（同 xh_animated_links.js）。
//   第一级与「连线」同名 ⇒ 两组在同一个折叠面板下；sortOrder 让「关于」排最前。

const { app } = window.comfyAPI.app;

const NS = "XH.About";

/** B 站品牌粉（徽章用，一眼认出是 B 站）。 */
const BILI_PINK = "#fb7299";

/** B 站专属小电视：白天线 + 白机身 + 粉眼睛（眼睛色跟徽章底走）。 */
const BILI_TV_ICON =
    '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true" ' +
    'style="display:block;margin-right:6px">' +
    '<g fill="none" stroke="#ffffff" stroke-width="1.9" stroke-linecap="round">' +
    '<path d="M6.9 2.6 9.9 6.6"/><path d="M17.1 2.6 14.1 6.6"/>' +
    '</g>' +
    '<rect x="2.6" y="6.4" width="18.8" height="15" rx="4.2" fill="#ffffff"/>' +
    '<ellipse cx="8.9" cy="13.3" rx="1.85" ry="2.45" fill="' + BILI_PINK + '"/>' +
    '<ellipse cx="15.1" cy="13.3" rx="1.85" ry="2.45" fill="' + BILI_PINK + '"/>' +
    '</svg>';

/** 从 ui_kit 取家族配色；取不到用同值内联兜底，绝不因加载顺序失败。
 *  🔴 必须在**渲染时**读，不能在文件顶层求值：
 *     web/ 下的 js 按字母序加载，`xh_about.js` 排在 `xh_ui_kit.js` **之前**，
 *     顶层取值那一刻 window.XH_BAR_COLORS 还是 undefined ⇒ 永远拿不到家族色。 */
function _colors() {
    return Object.assign({
        SURFACE: "#262d38",
        BORDER: "rgba(255,255,255,.10)",
        TEXT: "#d5dde5",
    }, (typeof window !== "undefined" && window.XH_BAR_COLORS) || {});
}

/** 拿后端版本信息；只取一次，成功后缓存。失败返回 null（不抛）。 */
let _aboutCache = null;
let _aboutFetching = null;

/**
 *🔴 取API 实例的坑：这版 ComfyUI（前端 1.45.x）上
 *    `window.comfyAPI.api` **不是** ComfyApi 实例（它只是个命名空间壳，
 *    只有 UnauthorizedError / ComfyApi / api 三个键，没有 fetchApi）；
 *    真正的实例是 `window.app.api`。两处都试一遍，谁能用谁上。
 */
function _api() {
    const cands = [
        typeof window !== "undefined" ? window.app && window.app.api : null,
        window.comfyAPI && window.comfyAPI.api && window.comfyAPI.api.api,
        window.comfyAPI && window.comfyAPI.app && window.comfyAPI.app.app && window.comfyAPI.app.app.api,
        window.comfyAPI && window.comfyAPI.api,
    ];
    for (const c of cands) {
        if (c && typeof c.fetchApi === "function") return c;
    }
    return null;
}

/** 实际发请求：原生 fetch 优先，失败再退化到 ComfyUI 内部 api.fetchApi。
 *  🔴 2026-10-20 踩坑：原先只调 api.fetchApi，而 _api() 敲的两扇门
 *     （window.app.api / comfyAPI.api）在这版前端都不对，返回 null 直接放弃，
 *     徽章永远显示「版本 —」，tooltip 还误报"请重启"。
 *     原生 fetch 同源、无需鉴权、实测 200 ⇒ 最抗内部 API 改版，放第一位。 */
function _requestAbout() {
    if (typeof fetch === "function") {
        return fetch("/xh/about", { headers: { Accept: "application/json" } })
            .then((r) => {
                if (!r || !r.ok) throw new Error("HTTP " + (r && r.status));
                return r.json();
            })
            .catch(() => {
                const api = _api();
                if (!api) throw new Error("no api");
                return api.fetchApi("/xh/about")
                    .then((r) => (r && typeof r.json === "function" ? r.json() : r));
            });
    }
    const api = _api();
    if (!api) return Promise.reject(new Error("no api"));
    return api.fetchApi("/xh/about")
        .then((r) => (r && typeof r.json === "function" ? r.json() : r));
}

function fetchAbout() {
    if (_aboutCache) return Promise.resolve(_aboutCache);
    if (_aboutFetching) return _aboutFetching;
    _aboutFetching = _requestAbout()
        .then((d) => {
            if (d && d.version) { _aboutCache = d; return d; }
            return null;
        })
        .catch(() => null)
        .finally(() => { _aboutFetching = null; });
    return _aboutFetching;
}

/* ------------------------------------------------------------------ tooltip */
/* ComfyUI 设置面板自带的 tooltip 只认「字符串型 setting」的 tooltip 字段，
   对我们这种自定义 DOM 无效 ⇒ 自己挂一个全局浮层，同一时刻只存在一个。 */
function _showTip(anchor, text) {
    let t = document.getElementById("xh_about_tip");
    if (!t) {
        t = document.createElement("div");
        t.id = "xh_about_tip";
        t.style.cssText =
            "position:fixed;z-index:99999;pointer-events:none;padding:6px 10px;" +
            "border-radius:6px;font-size:12px;line-height:1.6;max-width:300px;" +
            "background:#11161d;color:#d5dde5;border:1px solid rgba(255,255,255,.12);" +
            "box-shadow:0 6px 20px rgba(0,0,0,.55);white-space:pre-wrap;display:none;";
        document.body.appendChild(t);
    }
    const r = anchor.getBoundingClientRect();
    t.textContent = text;
    t.style.display = "block";
    // 贴边保护：右侧放不下就往左挪，底部出屏就翻到上方
    const w = t.offsetWidth || 200;
    const left = Math.max(6, Math.min(r.left, window.innerWidth - w - 10));
    let top = r.bottom + 7;
    if (top + t.offsetHeight > window.innerHeight - 6) top = Math.max(6, r.top - t.offsetHeight - 7);
    t.style.left = left + "px";
    t.style.top = top + "px";
}

function _hideTip() {
    const t = document.getElementById("xh_about_tip");
    if (t) t.style.display = "none";
}

/* ------------------------------------------------------------------- badge */
/**
 * 画一颗药丸徽章。
 * @param text  文字
 * @param o.link   非空 ⇒ 整体可点开新标签
 * @param o.tip    悬停浮层文字（原生 title 只做兜底）
 * @param o.bold   字重 700
 */
function _badge(text, o = {}) {
    const C = _colors();
    const bg = o.bg || C.SURFACE;
    const fg = o.fg || C.TEXT;
    const bd = o.border || C.BORDER;

    const el = document.createElement(o.link ? "a" : "span");
    el.style.cssText =
        "display:inline-flex;align-items:center;height:20px;padding:0 9px;" +
        "border-radius:10px;font-size:12px;line-height:1;white-space:nowrap;" +
        `background:${bg};color:${fg};border:1px solid ${bd};` +
        `font-weight:${o.bold ? 700 : 600};letter-spacing:.2px;font-family:inherit;` +
        "user-select:none;box-sizing:border-box;" +
        (o.link ? "cursor:pointer;text-decoration:none;" : "cursor:default;");

    // 图标（inline SVG 字符串）放在文字前；没有就跳过
    if (o.icon) {
        const ico = document.createElement("span");
        ico.className = "xh-about-ico";
        ico.style.cssText = "display:inline-flex;align-items:center;flex:none;";
        ico.innerHTML = o.icon;
        el.appendChild(ico);
    }
    const tx = document.createElement("span");
    tx.textContent = text;
    el.appendChild(tx);

    if (o.link) {
        el.href = o.link;
        el.target = "_blank";
        el.rel = "noopener noreferrer";
        // hover 提亮：与家族工具条按钮同一套手感
        el.addEventListener("mouseenter", () => { el.style.filter = "brightness(1.28)"; });
        el.addEventListener("mouseleave", () => { el.style.filter = "none"; });
    }
    el.addEventListener("mouseenter", () => { if (o.tip) _showTip(el, o.tip); });
    el.addEventListener("mouseleave", _hideTip);
    el.addEventListener("click", _hideTip);
    if (o.title) el.title = o.title;
    return el;
}

/* --------------------------------------------------------------------- row */
/** 设置项渲染函数：ComfyUI 每次打开设置面板都会调它 ⇒ 每次读最新缓存。 */
function _renderAboutRow() {
    const row = document.createElement("tr");
    row.className = "xh-about-row";
    const cell = document.createElement("td");
    cell.colSpan = 2;
    cell.style.cssText = "display:flex;align-items:center;gap:8px;flex-wrap:wrap;";

    const a = _aboutCache;
    const ver = a ? a.version : null;
    const bili = a ? a.bilibili : "https://space.bilibili.com/96854764";
    const tagline = a ? a.tagline : "8g显存小黑的折腾日记";

    // ① 版本号：灰字药丸、纯信息、不可点 —— 一眼看出"这个是信息不是入口"
    cell.appendChild(_badge(ver ? `版本 ${ver}` : "版本 —", {
        title: ver ? `XH 工具箱 v${ver}` : "未读到后端版本号（后端未重启？）",
        tip: ver
            ? `XH 工具箱 v${ver}\n${tagline}`
            : "没读到版本号\n重开一次设置面板试试",
    }));

    // ② B 站：品牌粉底、白字加粗、可点开新标签 —— 唯一能点的那个
    cell.appendChild(_badge(tagline, {
        bg: BILI_PINK, fg: "#ffffff", border: "rgba(255,255,255,.30)",
        link: bili, bold: true, title: "打开 B 站主页",
        icon: BILI_TV_ICON,
        tip: `${tagline}\n${bili}`,
    }));

    row.appendChild(cell);
    return row;
}

/** 设置项定义（纯展示，不落盘、不参与任何逻辑）。 */
// 🔴 第一级必须与 xh_animated_links.js 的 _cat() **逐字相同**（"🔁 XH 工具箱"），
//    否则 ComfyUI 会当成两个不同扩展 ⇒ 凭空多出一个空折叠面板。
const ABOUT_SETTING = {
    id: `${NS}.about`,
    name: "关于",
    category: ["🔁 XH 工具箱", "关于", "关于"],
    type: _renderAboutRow,
};

/**
 * ComfyUI 的 buildTree 不排序（按注册先后）。
 * 「关于」要排最前 ⇒ sortOrder 必须大于 xh_animated_links.js 那批。
 */
const ABOUT_SORT_ORDER = 100;

function _registerAbout() {
    //🔴 幂等守卫必须查**存储里**，不能只查模块级变量：
    //    模块级 flag 只在同一次模块求值内有效；若本文件被重复执行
    //    （ComfyUI 扩展重复注入 / 用户 F5 时脚本二次求值），
    //    新实例的 flag 是 undefined ⇒ 会再addSetting 一次
    //    ⇒ 控制台报 "Setting already registered"。
    //    查真实存储才是唯一可靠判据。
    const store = app.extensionManager?.setting?.settings;
    if (store && Object.prototype.hasOwnProperty.call(store, ABOUT_SETTING.id)) return;

    const S = app.ui && app.ui.settings;
    if (!S || typeof S.addSetting !== "function") {
        console.error("[XH.About] app.ui.settings.addSetting 不可用");
        return;
    }
    try {
        S.addSetting({ ...ABOUT_SETTING, sortOrder: ABOUT_SORT_ORDER });
    } catch (e) {
        console.error("[XH.About] ❌ 设置注册失败:", e);
    }
}

// 顶层就注册（与 xh_animated_links.js 同策略：脚本求值时注册，排序才稳）
try { _registerAbout(); } catch (e) { console.error("[XH.About] 顶层注册异常:", e); }

// 预取版本号。若设置面板此刻已打开（用户手速极快 / 面板常驻），就地刷一次。
fetchAbout().then((d) => {
    if (!d) return;
    document.querySelectorAll("tr.xh-about-row").forEach((r) => {
        try {
            const cell = r.querySelector("td");
            const fresh = _renderAboutRow().querySelector("td");
            if (!cell || !fresh) return;
            cell.innerHTML = "";
            while (fresh.firstChild) cell.appendChild(fresh.firstChild);
        } catch (e) { /* 单行刷新失败不影响面板 */ }
    });
});