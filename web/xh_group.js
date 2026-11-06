// XH 分组控制器 - Nodes 2.0 兼容（2026-09-29 升级版）
// 对齐 rgthree Fast Groups Bypasser 的三条能力：颜色/标题过滤、单开限制、自动刷新。
// 组内节点判定沿用中心点法（与 rgthree fast_groups_service 一致）。
const { app } = window.comfyAPI.app;
import { ensureLangBridge, makeXHToolbar , paintBarBtn, showXHDropdown, BAR_COLORS } from "./xh_ui_kit.js";

// ① 语言桥：window.XH_LANG 变 accessor —— 赋值即写 localStorage + 广播 xh:lang-changed
ensureLangBridge();
// ② 家族同步：别的 XH 节点切语言时，所有分组控制节点跟着重绘（本节点是自绘 DOM）
window.addEventListener("xh:lang-changed", () => {
    try {
        for (const n of (app.graph ? (app.graph.nodes || app.graph._nodes || []) : [])) {
            if (n && n.type === NODE_TYPE && typeof n._render === "function") n._render();
        }
    } catch (e) {}
});

const NODE_TYPE = "XHGroupController";
const MODE_ON = 0;   // LiteGraph.ALWAYS
const MODE_OFF = 4;  // LiteGraph.BYPASS（旁路；rgthree Bypasser 同款）

// 中英文标签
const LABELS = {
    zh: { title: "🔁XH-分组控制", refresh: "🔄 刷新", disableAll: "⛔ 全部禁用", enableAll: "✅ 全部启用", noGroups: "没有找到组，请先 Ctrl+G 创建组", on: "开", off: "关", blocked: "「只保留一个」限制下不能关掉最后一个",
        slots: { opt: "信号输入", OPT_CONNECTION: "控制信号" } },
    en: { title: "XH Group Control", refresh: "🔄 Refresh", disableAll: "⛔ Disable All", enableAll: "✅ Enable All", noGroups: "No groups found. Create one with Ctrl+G first", on: "ON", off: "OFF", blocked: "『always one』restriction: cannot turn off the last one",
        slots: { opt: "signal", OPT_CONNECTION: "control" } },
};

// 输入 / 输出端口名本地化：只改 label，绝不改 name（后端按 name 找端口）。
// Nodes 2.0 端口标签走快照渲染，改完必须显式触发重建（官方 Subgraph 改名同机制）。
function applyPortLabels(node, l) {
    if (!node) return;
    const dict = (LABELS[l] || LABELS.zh).slots;
    if (!dict) return;
    const apply = (arr) => {
        for (const s of arr || []) {
            const lb = s && dict[s.name];
            if (lb) s.label = lb;
        }
    };
    apply(node.inputs);
    apply(node.outputs);
    try {
        node.graph?.trigger?.("node:slot-label:changed", { nodeId: node.id, slotType: 1 });
        node.graph?.trigger?.("node:slot-label:changed", { nodeId: node.id, slotType: 2 });
    } catch (e) {}
    try { node.setDirtyCanvas?.(true, true); } catch (e) {}
}

// ---- 家族语言桥接（window.XH_LANG，与家族其他节点双向联动）----
function getLang(node) {
    let l;
    try { l = window.XH_LANG; } catch (e) {}
    if (l !== "zh" && l !== "en") l = node?.properties?.lang;
    return l === "en" ? "en" : "zh";
}
// setLang 已于 2026-10-05 移除：点「中/EN」现在走 kit 的语言桥（写 localStorage + 广播全家族），
// 本文件的顶层 xh:lang-changed 监听负责重绘，不再需要自己写 node.properties.lang。

// ---- 颜色归一化（照抄 rgthree getFullColor 语义）----
function fullColor(color) {
    if (!color) return "";
    const NC = (typeof LGraphCanvas !== "undefined" && LGraphCanvas.node_colors) || {};
    color = String(color).trim();
    if (NC[color]) color = NC[color].groupcolor;
    color = color.replace("#", "").toLocaleLowerCase();
    if (color.length === 3) color = color.replace(/(.)(.)(.)/, "$1$1$2$2$3$3");
    return "#" + color;
}

function groupColor(g) {
    return fullColor(g.color || g._color || "");
}

// ---- 颜色可读性（2026-10-20 新增）--------------------------------
// 根因：option.style.color =组色，把组色当字色用了 —— 组色是**画在分组框边框上**的，
// 不是给文字用的。实测 10 个官方色在 #1f1f1f 底上，棕 3.76 / 淡蓝 3.45 / 紫 2.68 / 黑 1.69
// 全部低于 WCAG AA 正文 4.5:1，"黑"那一项几乎隐形。
// 修法：字色 = 组色**向白混合**到刚好 4.6:1 —— 保留色相与饱和度，只提亮度。
// ⛔ 绝不能"一律提到 10:1"：那会把红绿蓝全变成灰白，10 行看着一模一样，色彩识别全废。
const XH_SEL_BG = "#1f1f1f";
function _srgbLum(hex) {
    const c = hex.replace("#", "");
    const v = [0, 2, 4].map((i) => {
        let x = parseInt(c.slice(i, i + 2), 16) / 255;
        return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
}
function _contrast(fg, bg) {
    const a = _srgbLum(fg), b = _srgbLum(bg);
    const hi = Math.max(a, b), lo = Math.min(a, b);
    return (hi + 0.05) / (lo + 0.05);
}
function _mixWhite(hex, t) {
    const c = hex.replace("#", "");
    const p = [0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16));
    return "#" + p.map((x) => {
        const v = Math.round(x + (255 - x) * t);
        return v.toString(16).padStart(2, "0");
    }).join("");
}
// 返回在深底上可读的字色；已达标则原样返回（红绿蓝青黄一点不动）
export function readableOn(hex, bg = XH_SEL_BG, target = 4.6) {
    if (!hex || hex === "#") return hex;
    if (_contrast(hex, bg) >= target) return hex;
    let lo = 0, hi = 1;
    for (let i = 0; i < 24; i++) {
        const mid = (lo + hi) / 2;
        if (_contrast(_mixWhite(hex, mid), bg) < target) lo = mid; else hi = mid;
    }
    return _mixWhite(hex, hi);
}

// ---- 节点自身配色（与 XH_LoraStack / XH_Slider 同一套：去官方重复色，12 色高辨识度 + 自定义取色器）----

function groupNodes(g) {
    const b = g._bounding || g.bounding;
    const nodes = [];
    if (!b) return nodes;
    const graph = app.graph;
    graph.nodes.forEach((n) => {
        if (n.type === NODE_TYPE) return;
        const cx = n.pos[0] + (n.size[0] || 200) * 0.5;
        const cy = n.pos[1] + (n.size[1] || 100) * 0.5;
        if (cx >= b[0] && cx < b[0] + b[2] && cy >= b[1] && cy < b[1] + b[3]) nodes.push(n);
    });
    return nodes;
}

function entryActive(g) {
    return groupNodes(g).some((n) => n.mode === MODE_ON);
}

app.registerExtension({
    name: "XH.GroupController",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_TYPE) return;

        nodeType.isVirtualNode = true;

        // 属性面板可编辑（右键节点 → Properties）
        nodeType["@matchColors"] = { type: "string" };
        nodeType["@matchTitle"] = { type: "string" };
        nodeType["@sort"] = { type: "combo", values: ["position", "alphanumeric"] };
        nodeType["@toggleRestriction"] = { type: "combo", values: ["default", "max one", "always one"] };

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = onNodeCreated?.apply(this, arguments);
            this.title = "🔁XH-分组控制";
            this.serialize_widgets = false;
            this.widgets = [];
            this.size = [360, 200];
            this._collapsed = false;
            this._toast = null;
            this._paletteOpen = false;

            const P = (this.properties = this.properties || {});
            P.matchColors = P.matchColors ?? "";
            P.matchTitle = P.matchTitle ?? "";
            P.sort = P.sort ?? "position";
            P.toggleRestriction = P.toggleRestriction ?? "default";
            P.lang = P.lang ?? "zh";

            const container = document.createElement("div");
            container.style.cssText = `position:relative;width:100%;box-sizing:border-box;font-size:13px;color:#e0e0e0;`;
            this._container = container;

            try {
                this.addDOMWidget("groups", "custom", container, { serialize: false, hideOnZoom: false, minWidth: 340, minHeight: 150 });
            } catch (e) {}

            setTimeout(() => this._render(), 300);

            // 自动刷新：每 800ms 比对签名（组列表/颜色/开关态/过滤条件），变了才重绘
            this._sig = "";
            this._timer = setInterval(() => {
                if (!this.graph) return;
                if (this._paletteOpen) return;   // 调色期间暂停自动刷新，避免打断取色
                if (document.getElementById("xh_group_color_pop")) return;   // 颜色下拉开着时别重画，否则点中就消失
                const sig = this._signature();
                if (sig !== this._sig) {
                    this._sig = sig;
                    this._render();
                }
            }, 800);
            return r;
        };

        const onRemoved = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function () {
            if (this._timer) clearInterval(this._timer);
            this._timer = null;
            return onRemoved?.apply(this, arguments);
        };

        nodeType.prototype._signature = function () {
            const P = this.properties || {};
            const gs = this._collectGroups();
            const parts = gs.map((g) => `${g.title}|${groupColor(g)}|${entryActive(g) ? 1 : 0}`);
            return [P.matchColors, P.matchTitle, P.sort, P.toggleRestriction, this._collapsed ? 1 : 0, parts.join(";")].join("#");
        };

        // 收集组：主图 + 子图，按属性过滤与排序
        nodeType.prototype._collectGroups = function (ignoreFilters) {
            const P = this.properties || {};
            let gs = [];
            const graph = app.graph;
            gs.push(...(graph._groups || graph.groups || []));
            try {
                const subs = graph.subgraphs?.values?.();
                if (subs) {
                    let s;
                    while ((s = subs.next().value)) gs.push(...(s.groups || []));
                }
            } catch (e) {}

            // 颜色过滤（逗号分隔，支持 ComfyUI 色名与 hex）
            const filterColors = String(P.matchColors || "").split(",").map((c) => fullColor(c)).filter((c) => c && c !== "#");
            // 标题过滤（字符串或正则）
            const mt = String(P.matchTitle || "").trim();
            let titleRe = null;
            if (mt) {
                try { titleRe = new RegExp(mt, "i"); } catch (e) { titleRe = null; }
            }
            let entries = gs.filter((g) => {
                const b = g._bounding || g.bounding;
                if (!b || b[2] <= 0 || b[3] <= 0) return false;
                if (!ignoreFilters) {
                    if (filterColors.length) {
                        const gc = groupColor(g);
                        if (!gc || !filterColors.includes(gc)) return false;
                    }
                    if (titleRe && !titleRe.test(g.title || "")) return false;
                }
                return true;
            });

            if (P.sort === "alphanumeric") {
                entries.sort((a, b) => String(a.title || "").localeCompare(String(b.title || "")));
            } else {
                // position：按 30px 网格，先 Y 后 X（与 rgthree 一致）
                entries.sort((a, b) => {
                    const pa = a._pos || [0, 0], pb = b._pos || [0, 0];
                    const ay = Math.floor(pa[1] / 30), by = Math.floor(pb[1] / 30);
                    if (ay !== by) return ay - by;
                    return Math.floor(pa[0] / 30) - Math.floor(pb[0] / 30);
                });
            }
            return entries;
        };

        // 兼容旧调用
        nodeType.prototype._getGroups = function () {
            return this._collectGroups().map((g) => ({ title: g.title || "未命名组", nodes: groupNodes(g), group: g }));
        };

        // 切换一组：带「只能开一个 / 必须保留一个」限制
        nodeType.prototype._toggleEntry = function (target) {
            const P = this.properties || {};
            const restriction = P.toggleRestriction || "default";
            const entries = this._collectGroups();
            const hasActive = entryActive(target);
            let newValue = !hasActive;
            if (newValue && restriction.includes(" one")) {
                // 先关掉其他所有组，再开这组
                entries.forEach((g) => { if (g !== target) groupNodes(g).forEach((n) => (n.mode = MODE_OFF)); });
            } else if (!newValue && restriction === "always one") {
                // 不允许关掉唯一开着的组
                const othersOn = entries.some((g) => g !== target && entryActive(g));
                if (!othersOn) {
                    this._flash(LABELS[getLang(this)].blocked);
                    return;
                }
            }
            groupNodes(target).forEach((n) => (n.mode = newValue ? MODE_ON : MODE_OFF));
            this._render();
        };

        nodeType.prototype._flash = function (msg) {
            if (this._toast) clearTimeout(this._toast);
            this._toast = { msg, until: Date.now() + 1800 };
            this._render();
            setTimeout(() => { if (this._toast && Date.now() >= this._toast.until) { this._toast = null; this._render(); } }, 1900);
        };

        nodeType.prototype._render = function () {
            const c = this._container;
            if (!c) return;
            const lang = getLang(this);
            const L = LABELS[lang];
            applyPortLabels(this, lang); // 端口名跟着语言走（只改 label）
            c.innerHTML = "";

            // 标题栏 = 标准工具条（折叠 + 标题 + 中/EN + 🎨）—— 家族唯一实现见 web/xh_ui_kit.js
            const cb = document.createElement("button");
            cb.textContent = this._collapsed ? "▶" : "▼";
            paintBarBtn(cb, "neutral");   // 方案 B：橙色实心 → 中性暗底（折叠是常规操作不是主操作）
            cb.style.cssText = cb.style.cssText
                + "cursor:pointer;font-size:14px;padding:0 6px;line-height:18px;transition:all 0.2s;";
            cb.onclick = () => { this._collapsed = !this._collapsed; this._render(); };
            cb.onmouseover = () => cb.style.filter = "brightness(1.2)";
            cb.onmouseout = () => cb.style.filter = "none";
            const tn = document.createElement("span");
            tn.style.cssText = `flex:1;font-weight:bold;font-size:12px;color:#aaa;`;
            tn.textContent = L.title;

            // 🎨 与「中/EN」都来自 kit 的唯一实现；点中/EN 由语言桥广播 → 顶部监听统一重绘
            const { bar } = makeXHToolbar(this, { mount: false, prependNodes: [cb, tn] });
            const tb = document.createElement("div");
            tb.style.cssText = "border-bottom:1px solid #333;";
            tb.appendChild(bar);
            c.appendChild(tb);

            if (this._collapsed) { this.size = [360, 28]; app.graph.setDirtyCanvas(true, true); return; }

            // 顶部按钮
            const topBar = document.createElement("div");
            topBar.style.cssText = `display:flex;gap:6px;padding:4px 8px;border-bottom:1px solid #333;`;
            const mkBtn = (text, color, fn) => {
                const b = document.createElement("button");
                b.textContent = text;
                paintBarBtn(b, "primary");   // 原动态传色 → 固定 primary（主操作层级）
                b.style.cssText = b.style.cssText
                    + "padding:4px 10px;cursor:pointer;transition:all 0.15s;";
                b.onmouseover = () => b.style.filter = "brightness(1.2)";
                b.onmouseout = () => b.style.filter = "none";
                b.onclick = (e) => { b.style.transform = "scale(0.9)"; setTimeout(() => { b.style.transform = ""; fn(); }, 80); };
                return b;
            };
            topBar.appendChild(mkBtn(L.refresh, "#555", () => this._render()));

            const P = this.properties || {};
            const restriction = P.toggleRestriction || "default";
            const entries = this._collectGroups();

            // 全部禁用：always one 时保留第一组开着
            topBar.appendChild(mkBtn(L.disableAll, "#c0392b", () => {
                entries.forEach((g, i) => {
                    const on = restriction === "always one" && i === 0;
                    groupNodes(g).forEach((n) => (n.mode = on ? MODE_ON : MODE_OFF));
                });
                app.graph.setDirtyCanvas(true, true);
                this._render();
            }));
            // 全部启用：单开限制下只开第一组
            topBar.appendChild(mkBtn(L.enableAll, "#2d7d2d", () => {
                entries.forEach((g, i) => {
                    const on = restriction.includes(" one") ? i === 0 : true;
                    groupNodes(g).forEach((n) => (n.mode = on ? MODE_ON : MODE_OFF));
                });
                app.graph.setDirtyCanvas(true, true);
                this._render();
            }));
            c.appendChild(topBar);

            // ---- 筛选行：颜色下拉 + 标题输入（直接改 properties，存档跟着走）----
            const fBar = document.createElement("div");
            fBar.style.cssText = `display:flex;gap:6px;padding:4px 8px;border-bottom:1px solid #333;align-items:center;`;

            // ★2026-10-20 打磨：字号 11px → 13px（11px 本身低于正文标准 12px），
            //   padding 加大让下拉本体跟方案 B 的 22px 控件同档。
            const mkFilterStyle = (el) => {
                el.style.cssText = `font-size:13px;padding:4px 8px;border-radius:4px;`
                    + `border:1px solid rgba(255,255,255,.25);background:${XH_SEL_BG};color:#e8e8e8;`;
            };

            // ---- 颜色筛选：自绘下拉（2026-10-20 重做）----
            // ⛔ 原来用原生 <select>，靠 option.innerHTML 塞色块 —— **浏览器会把色块整条丢掉**
            //    （Chromium 的 <option> 只渲染文本节点），所以"下拉里没有色块对照"。
            //    现在触发按钮 + 弹出列表都自己画：色块用原组色，字色走 readableOn() 提亮保底。
            const ALL_HEX = "#8b95a1";
            const ALL_LABEL = lang === "zh" ? "全部颜色" : "All colors";
            const mkSwatchEl = (hex) => {
                const sw = document.createElement("span");
                sw.style.cssText = "display:inline-block;width:13px;height:13px;border-radius:3px;flex:none;"
                    + `background:${/^#[0-9a-f]{6}$/i.test(String(hex || "")) ? hex : ALL_HEX};`
                    + "border:1px solid rgba(255,255,255,.45);box-shadow:0 0 0 1px rgba(0,0,0,.45);";
                return sw;
            };
            const choices = this._colorChoices();
            const curVal = String(P.matchColors || "");
            const curItem = choices.find((o) => o.value === curVal);
            const filtering = !!curVal;

            const colorBtn = document.createElement("button");
            colorBtn.id = "xh_group_color_btn";
            colorBtn.title = lang === "zh" ? "按颜色筛选分组" : "Filter groups by color";
            colorBtn.style.cssText = "display:flex;align-items:center;gap:7px;flex:none;height:24px;"
                + "padding:0 9px;border-radius:4px;cursor:pointer;white-space:nowrap;"
                + "font-size:13px;font-weight:" + (filtering ? 700 : 600) + ";"
                + "background:" + (filtering ? BAR_COLORS.ACTIVE_BG : XH_SEL_BG) + ";"
                + "border:1px solid " + (filtering ? BAR_COLORS.ACTIVE_BD : "rgba(255,255,255,.25)") + ";"
                + "color:" + (filtering ? BAR_COLORS.ACTIVE_TX : "#e8e8e8") + ";";
            colorBtn.appendChild(mkSwatchEl(curItem ? curItem.hex : ALL_HEX));
            const cbTx = document.createElement("span");
            cbTx.textContent = curItem ? curItem.label : (curVal || ALL_LABEL);
            colorBtn.appendChild(cbTx);
            const cbArrow = document.createElement("span");
            cbArrow.textContent = "\u25be";
            cbArrow.style.cssText = "font-size:10px;opacity:.75;";
            colorBtn.appendChild(cbArrow);
            colorBtn.onmousedown = (e) => e.stopPropagation();
            colorBtn.onclick = (e) => {
                e.stopPropagation();
                showXHDropdown(colorBtn, {
                    id: "xh_group_color_pop",
                    current: curVal,
                    items: [
                        { value: "", label: ALL_LABEL, hex: ALL_HEX, color: "#e8e8e8",
                          tip: lang === "zh" ? "不按颜色筛选" : "No color filter" },
                        ...choices.map(({ value, label, hex }) => ({
                            value, label, hex, color: readableOn(hex), tip: String(hex).toUpperCase(),
                        })),
                    ],
                    onPick: (v) => {
                        this.properties.matchColors = v || "";
                        this._sig = this._signature();
                        this._render();     // 整体重画：触发按钮的色块/文字跟着换
                    },
                });
            };

            const titleInput = document.createElement("input");
            titleInput.type = "text";
            mkFilterStyle(titleInput);
            titleInput.style.flex = "1";
            titleInput.style.minWidth = "0";
            titleInput.placeholder = lang === "zh" ? "标题包含…（打 / 开头当正则用）" : "Title contains… (/…/ for regex)";
            titleInput.value = String(P.matchTitle || "");
            titleInput.onclick = (e) => e.stopPropagation();
            titleInput.onkeydown = (e) => e.stopPropagation();
            titleInput.oninput = () => {
                this.properties.matchTitle = titleInput.value || "";
                this._sig = this._signature();
                this._renderList();   // 只重画列表，输入框不重建，光标不丢
            };

            const sortSel = document.createElement("select");
            mkFilterStyle(sortSel);
            sortSel.style.flex = "none";
            [
                { v: "position", t: lang === "zh" ? "按位置" : "Position" },
                { v: "alphanumeric", t: lang === "zh" ? "按名称" : "Name" },
            ].forEach(({ v, t }) => {
                const o = document.createElement("option");
                o.value = v;
                o.textContent = t;
                o.style.background = XH_SEL_BG;
                o.style.color = "#e8e8e8";
                o.style.fontSize = "13px";
                o.style.padding = "3px 8px";
                sortSel.appendChild(o);
            });
            sortSel.value = P.sort === "alphanumeric" ? "alphanumeric" : "position";
            sortSel.onclick = (e) => e.stopPropagation();
            sortSel.onchange = () => {
                this.properties.sort = sortSel.value;
                this._sig = this._signature();
                this._renderList();
            };

            // ★2026-10-20 打磨：11px 裸灰字（对比度仅 2.6:1、无底无框）
            //   → 12px/700 药丸徽章 + "组"字。底色/描边走家族方案 B 的中性档，
            //   筛选态由 _renderList 切成 active 蓝，一眼看出"我正在筛选"。
            const countLabel = document.createElement("span");
            countLabel.style.cssText = `font-size:12px;font-weight:700;color:${BAR_COLORS.TEXT};flex:none;`
                + `background:${BAR_COLORS.SURFACE};border:1px solid ${BAR_COLORS.BORDER};`
                + `border-radius:9px;padding:2px 9px;letter-spacing:0.2px;white-space:nowrap;`;
            countLabel.id = "xh_group_count";
            countLabel.title = lang === "zh" ? "当前显示 / 全部组数" : "Shown / total groups";

            fBar.appendChild(colorBtn);
            fBar.appendChild(titleInput);
            fBar.appendChild(sortSel);
            fBar.appendChild(countLabel);
            c.appendChild(fBar);

            // 提示条
            if (this._toast) {
                const toast = document.createElement("div");
                toast.style.cssText = `padding:4px 10px;font-size:11px;color:#ffd0d0;background:rgba(192,57,43,0.25);`;
                toast.textContent = this._toast.msg;
                c.appendChild(toast);
            }

            const list = document.createElement("div");
            list.style.cssText = `padding:6px 8px;`;
            this._listEl = list;
            c.appendChild(list);
            this._renderList();
        };

        // 官方 9 色的中文名（色表取自前端源码 LGraphCanvas.node_colors）
        const COLOR_NAME_ZH = {
            red: "红", brown: "棕", green: "绿", blue: "蓝", pale_blue: "淡蓝",
            cyan: "青", purple: "紫", yellow: "黄", black: "黑", white: "白",
        };
        const OFFICIAL_ORDER = ["red", "brown", "green", "blue", "pale_blue", "cyan", "purple", "yellow", "black", "white"];

        // 颜色下拉：官方色常驻（不受当前工作流影响），再追加工作流里出现过的自定义色
        nodeType.prototype._colorChoices = function () {
            const lang = getLang(this);
            const NC = (typeof LGraphCanvas !== "undefined" && LGraphCanvas.node_colors) || {};
            const out = [];
            const seen = new Set();
            const push = (value, hex) => {
                if (!hex || hex === "#" || seen.has(hex)) return;
                seen.add(hex);
                const zh = COLOR_NAME_ZH[value] || value;
                out.push({ value, hex, label: lang === "zh" ? zh : value.replace(/_/g, " ") });
            };
            const keys = [
                ...OFFICIAL_ORDER.filter((k) => NC[k]),
                ...Object.keys(NC).filter((k) => !OFFICIAL_ORDER.includes(k)),
            ];
            keys.forEach((k) => push(k, fullColor(NC[k].groupcolor || NC[k])));
            // 工作流里用到但不在官方表里的颜色
            this._collectGroups(true).forEach((g) => push(groupColor(g), groupColor(g)));
            // 当前存档里存的值（可能是手填的多色串）
            const cur = String(this.properties?.matchColors || "").trim();
            if (cur && !out.some((o) => o.value === cur)) {
                out.push({ value: cur, hex: fullColor(cur), label: cur });
            }
            return out;
        };

        // 只重画列表（筛选输入时调用，保住光标）
        nodeType.prototype._renderList = function () {
            const list = this._listEl;
            if (!list) return;
            const lang = getLang(this);
            const L = LABELS[lang];
            const P = this.properties || {};
            const restriction = P.toggleRestriction || "default";
            const entries = this._collectGroups();
            const total = this._collectGroups(true).length;

            const cnt = this._container?.querySelector("#xh_group_count");
            if (cnt) {
                const filtered = entries.length !== total;
                const zh = getLang(this) === "zh";
                cnt.textContent = zh
                    ? (filtered ? `${entries.length}/${total} 组` : `${total} 组`)
                    : (filtered ? `${entries.length}/${total}` : `${total}`);
                // 筛选态 → active 蓝档（家族同一套）；全部态 → 中性暗底
                cnt.style.color = filtered ? BAR_COLORS.ACTIVE_TX : BAR_COLORS.TEXT;
                cnt.style.background = filtered ? BAR_COLORS.ACTIVE_BG : BAR_COLORS.SURFACE;
                cnt.style.borderColor = filtered ? BAR_COLORS.ACTIVE_BD : BAR_COLORS.BORDER;
            }

            list.innerHTML = "";
            if (entries.length === 0) {
                list.innerHTML = `<div style="padding:20px;text-align:center;color:#888;">${L.noGroups}</div>`;
                this.size = [360, 130];
                app.graph.setDirtyCanvas(true, true);
                return;
            }

            entries.forEach((g) => {
                const title = g.title || "未命名组";
                const gc = groupColor(g);
                const isOn = entryActive(g);
                const card = document.createElement("div");
                card.style.cssText = `display:flex;align-items:center;padding:5px 8px;margin:4px 0;border:2px solid #444;border-radius:4px;background:rgba(255,255,255,0.03);transition:border-color 0.2s;`;

                // 颜色小圆点（有组色才显示，方便核对过滤）
                // ★2026-10-20 打磨：10px → 13px + 2px 亮白环 + 外侧 1px 暗描边。
                //   关键在**环**：不靠自身亮度靠边界，深色组色（黑 #444 / 棕 #b06634）
                //   在#444 卡片描边上也能分清。不换形状 —— 圆点是通用"颜色标记"符号。
                if (gc && gc !== "#") {
                    const dot = document.createElement("span");
                    dot.style.cssText = `width:13px;height:13px;border-radius:50%;flex:none;margin-right:7px;`
                        + `background:${gc};border:2px solid rgba(255,255,255,0.72);`
                        + `box-shadow:0 0 0 1px rgba(0,0,0,0.5);`;
                    dot.title = `${title}　组色`;
                    card.appendChild(dot);
                }

                const name = document.createElement("span");
                name.style.cssText = `flex:1;font-weight:bold;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;`;
                name.textContent = title;
                name.title = title;
                card.appendChild(name);

                // 导航按钮 - 开关左边
                const nodes = groupNodes(g);
                const navBtn = document.createElement("button");
                navBtn.textContent = "➤";
                paintBarBtn(navBtn, "neutral");   // 定位按钮：中性档
                navBtn.style.cssText = navBtn.style.cssText
                    + "width:24px;height:24px;font-size:13px;cursor:pointer;margin-left:8px;transition:all 0.15s;";
                navBtn.onmouseover = () => navBtn.style.filter = "brightness(1.28)";
                navBtn.onmouseout = () => navBtn.style.filter = "none";
                navBtn.onclick = (e) => {
                    e.stopPropagation();
                    if (nodes.length > 0 && app.canvas && typeof app.canvas.centerOnNode === "function") {
                        app.canvas.centerOnNode(nodes[0]);
                    }
                };
                card.appendChild(navBtn);

                // 开关
                const toggle = document.createElement("div");
                toggle.style.cssText = `display:flex;align-items:center;gap:2px;margin-left:8px;padding:2px 4px;border-radius:4px;cursor:pointer;position:relative;width:50px;height:22px;font-size:11px;font-weight:bold;transition:background 0.2s,transform 0.15s;background:${isOn ? "#2d7d2d" : "#c0392b"};color:${isOn ? "#fff" : "#ffd0d0"};`;
                toggle.onclick = (e) => {
                    e.stopPropagation();
                    toggle.style.transform = "scale(0.9)";
                    setTimeout(() => { toggle.style.transform = ""; this._toggleEntry(g); }, 80);
                };
                const lbl = document.createElement("span");
                lbl.style.cssText = `position:absolute;top:3px;font-size:11px;font-weight:bold;`;
                lbl.textContent = isOn ? L.on : L.off;
                toggle.appendChild(lbl);
                card.appendChild(toggle);

                // ★2026-10-20：#2980b9 是上轮清掉的旧色，此处统一到家族 #4a90d9
                card.onmouseover = () => card.style.borderColor = "#4a90d9";
                card.onmouseout = () => card.style.borderColor = "#444";

                list.appendChild(card);
            });

            // 92 = 标题栏 + 按钮栏 + 筛选行；每行 42
            this.size = [360, Math.max(150, 92 + entries.length * 42)];
            app.graph.setDirtyCanvas(true, true);
        };
    },
});
