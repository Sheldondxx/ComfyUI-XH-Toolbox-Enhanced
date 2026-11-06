// XH 标签 - Nodes 2.0 兼容版（顶部按钮条 + 文字区）
const { app } = window.comfyAPI.app;

import { ensureLangBridge, makeXHToolbar, releaseButtons, showXHPicker, darkenHex , paintBarBtn} from "./xh_ui_kit.js";

ensureLangBridge();
// ② 家族同步：别的 XH 节点切语言时，所有标签节点跟着切（本节点是自绘 DOM）
window.addEventListener("xh:lang-changed", (e) => {
    const lang = (e.detail && e.detail.lang) || window.XH_LANG || "zh";
    try {
        for (const n of (app.graph ? (app.graph.nodes || app.graph._nodes || []) : [])) {
            if (!n || n.type !== "XHLabel" || n._lang === lang) continue;
            n._lang = lang;
            n._applyLangToOwnBtns?.();
            n._save?.();
            n._refresh?.();
        }
        app.graph?.setDirtyCanvas?.(true, true);
    } catch (err) {}
});
// ---- 节点自身配色（与 XH_LoraStack / XH_Slider / XH_Toolbox 分组控制 同一套：去官方重复色，12 色高辨识度 + 自定义取色器）----
//   ⚠️ label 自带「节点透明/显示标题」逻辑（_refresh 会重写 node.color），故用独立 _nodeColor 状态，
//      用户选了色优先、否则回落到原透明逻辑，二者并存不冲突。

// ---- 文字/背景颜色弹出选择器 ----
//   弹窗本体一律用 kit 的 showXHPicker（家族唯一实现，XH 12 色 + 自定义 + 默认项）；
//   本地那份手写弹窗已于 2026-10-05 移除，这里只负责「选中后写回本节点自己的状态」。
//   图标统一用内联 SVG（不用 emoji），与节点框🎨互不混淆。
const SVG_TEXT_COLOR = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M4 19 L9 5 L14 19" stroke="#e8e8e8" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/><line x1="6" y1="15" x2="12" y2="15" stroke="#e8e8e8" stroke-width="2.2" stroke-linecap="round"/><rect x="3" y="20" width="18" height="3" rx="1.5" fill="#2F8FD8"/></svg>`;
const SVG_BG_COLOR = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="3" width="18" height="18" rx="2.5" stroke="#e8e8e8" stroke-width="2.2"/><rect x="6.5" y="6.5" width="11" height="11" rx="1.5" fill="#4BA14B"/></svg>`;
const SVG_COMPACT = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="5" width="18" height="14" rx="2" stroke="#e8e8e8" stroke-width="2"/><line x1="8" y1="12" x2="16" y2="12" stroke="#e8e8e8" stroke-width="2" stroke-linecap="round"/></svg>`;
const SVG_EXPAND = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="5" width="18" height="14" rx="2" stroke="#e8e8e8" stroke-width="2"/><line x1="12" y1="9" x2="12" y2="15" stroke="#e8e8e8" stroke-width="2" stroke-linecap="round"/><line x1="9" y1="12" x2="15" y2="12" stroke="#e8e8e8" stroke-width="2" stroke-linecap="round"/></svg>`;

// ---- 选中文字右键：字号 / 颜色 / 加粗 / 清除格式（2026-10-19）----
// 为什么做：正文是 contentEditable + innerHTML，本来就吃 <span style="font-size">；
//   但让用户手写 HTML 不现实（别人拿到根本不会改）⇒ 给右键菜单：
//   **左键选中 → 右键 → 点一下**，跟 Word 一个操作习惯。
// 🔴 与「A 字号滑块」的关系：滑块改的是**容器整体字号**，这里是给选中文字包一层**内联 span**，
//   内联优先级更高 ⇒ 不冲突；但设过的字会"锁定"（不再跟滑块变），点「↺ 清除格式」恢复跟随。
const XH_LABEL_SIZES = [12, 16, 20, 28, 36, 44, 56];
const XH_LABEL_COLORS = ["#FFFFFF", "#00E5FF", "#FF6B35", "#4BA14B", "#B8C4D4"];

function _xhLabelFireInput(el) {
    try { el?.closest?.('[contenteditable="true"]')?.dispatchEvent(new Event("input", { bubbles: true })); } catch (e) {}
}

/** 给当前选区包一层 span（跨节点选区会走 extract+insert 兜底）。 */
function _xhLabelWrapSelection(styleObj) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return false;
    const range = sel.getRangeAt(0);
    const host = range.commonAncestorContainer;
    const rootEl = host.nodeType === 1 ? host : host.parentElement;
    if (!rootEl || !rootEl.closest || !rootEl.closest('[contenteditable="true"]')) return false;

    const span = document.createElement("span");
    Object.assign(span.style, styleObj);
    try {
        range.surroundContents(span);
    } catch (e) {
        // 选了「跨两个不同样式」的一段 ⇒ surroundContents 抛错，改成抽出内容再包
        try {
            const frag = range.extractContents();
            span.appendChild(frag);
            range.insertNode(span);
        } catch (e2) {
            return false;
        }
    }
    try {
        sel.removeAllRanges();
        const r2 = document.createRange();
        r2.selectNodeContents(span);
        sel.addRange(r2);
    } catch (e) {}
    _xhLabelFireInput(span);
    return true;
}

/** 清除选中文字的格式（恢复跟随滑块的整体字号/颜色）。 */
function _xhLabelClearFormat() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return false;
    const host = sel.getRangeAt(0).commonAncestorContainer;
    const el = host.nodeType === 1 ? host : host.parentElement;
    try { document.execCommand("removeFormat"); } catch (e) { return false; }
    _xhLabelFireInput(el);
    return true;
}

function _xhLabelCloseMenu() {
    document.querySelectorAll(".__xh_label_fmt").forEach((el) => el.remove());
}

/** 弹出格式菜单（定位自动夹在视口内）。 */
function showXHLabelFormatMenu(x, y, lang) {
    _xhLabelCloseMenu();
    const zh = (lang || "zh") !== "en";

    const panel = document.createElement("div");
    panel.className = "__xh_label_fmt";
    panel.style.cssText =
        "position:fixed;z-index:100002;background:#1b2330;border:1px solid #3a4658;border-radius:8px;" +
        "padding:8px;box-shadow:0 10px 30px rgba(0,0,0,.55);display:flex;flex-direction:column;gap:6px;" +
        "font-size:12px;color:#cfd8e3;user-select:none;";

    const label = (t) => {
        const d = document.createElement("div");
        d.textContent = t;
        d.style.cssText = "font-size:11px;color:#7f8fa3;letter-spacing:.5px;";
        return d;
    };
    const mkBtn = (text, extra, onClick) => {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = text;
        paintBarBtn(b, "neutral");   // 方案 B：灰蓝 #2a3442 + 5px 圆角 → 暗底 + 1px 描边 + 4px
        b.style.cssText = b.style.cssText
            + "cursor:pointer;font-size:12px;padding:4px 6px;line-height:1;" + (extra || "");
        b.onmouseenter = () => { b.style.filter = "brightness(1.28)"; };
        b.onmouseleave = () => { b.style.filter = "none"; };
        b.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); });  // 保住选区
        b.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); onClick(); });
        return b;
    };

    // 字号
    panel.appendChild(label(zh ? "字号" : "Size"));
    const sizeRow = document.createElement("div");
    sizeRow.style.cssText = "display:flex;gap:4px;";
    for (const s of XH_LABEL_SIZES) {
        sizeRow.appendChild(mkBtn(String(s), "min-width:30px;text-align:center;", () => {
            _xhLabelWrapSelection({ fontSize: s + "px" });
            _xhLabelCloseMenu();
        }));
    }
    panel.appendChild(sizeRow);

    // 颜色
    panel.appendChild(label(zh ? "颜色" : "Color"));
    const colorRow = document.createElement("div");
    colorRow.style.cssText = "display:flex;gap:6px;";
    for (const c of XH_LABEL_COLORS) {
        const b = document.createElement("button");
        b.type = "button";
        b.title = c;
        b.style.cssText =
            "width:20px;height:20px;border-radius:50%;cursor:pointer;border:2px solid #3a4658;" +
            `background:${c};box-shadow:inset 0 0 0 1px rgba(0,0,0,.35);`;
        b.onmouseenter = () => { b.style.borderColor = "#8ecaff"; };
        b.onmouseleave = () => { b.style.borderColor = "#3a4658"; };
        b.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); });
        b.addEventListener("click", (e) => {
            e.preventDefault(); e.stopPropagation();
            _xhLabelWrapSelection({ color: c });
            _xhLabelCloseMenu();
        });
        colorRow.appendChild(b);
    }
    panel.appendChild(colorRow);

    const hr = document.createElement("div");
    hr.style.cssText = "height:1px;background:#3a4658;margin:1px 0;";
    panel.appendChild(hr);

    const bottomRow = document.createElement("div");
    bottomRow.style.cssText = "display:flex;gap:5px;";
    bottomRow.appendChild(mkBtn(zh ? "加粗" : "Bold", "font-weight:700;flex:1;", () => {
        _xhLabelWrapSelection({ fontWeight: "700" });
        _xhLabelCloseMenu();
    }));
    bottomRow.appendChild(mkBtn(zh ? "↺ 清除格式" : "↺ Clear", "flex:1;", () => {
        _xhLabelClearFormat();
        _xhLabelCloseMenu();
    }));
    panel.appendChild(bottomRow);

    document.body.appendChild(panel);
    const r = panel.getBoundingClientRect();
    panel.style.left = Math.max(8, Math.min(x, window.innerWidth - r.width - 8)) + "px";
    panel.style.top = Math.max(8, Math.min(y, window.innerHeight - r.height - 8)) + "px";

    const close = (ev) => {
        if (panel.contains(ev.target)) return;
        _xhLabelCloseMenu();
        document.removeEventListener("pointerdown", close, true);
    };
    setTimeout(() => document.addEventListener("pointerdown", close, true), 0);
}

const NODE_TYPE = "XHLabel";

app.registerExtension({
    name: "XH.Label",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_TYPE) return;

        nodeType.isVirtualNode = true;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = onNodeCreated?.apply(this, arguments);
            this.title = "";
            this.serialize_widgets = true;
            this.widgets = [];
            this.size = [400, 120];

            // 从 properties 恢复
            this._text = this.properties?.text || "双击编辑";
            this._fontSize = this.properties?.fontSize || 12;
            this._fontColor = this.properties?.fontColor || "#ffffff";
            this._bgColor = this.properties?.bgColor || "transparent";
            this._align = this.properties?.align || "left";
            this._fontFamily = this.properties?.fontFamily || "Arial";
            this._fontWeight = this.properties?.fontWeight || "normal";
            this._lang = this.properties?.lang || "zh";
            this._hideTitle = this.properties?.hideTitle !== false;
            this._nodeColor = null;
            this._compact = this.properties?.compact === true;

            this.color = "transparent";
            this.bgcolor = "transparent";
            this.flags.showTitle = false;

            // 工具条容器 + 中/EN + 🎨 —— 家族唯一实现见 web/xh_ui_kit.js
            //   本节点的工具栏按钮比较多（字号滑块 / 折叠 / 隐藏 / 字体…），
            //   统一插到 spacer 之前，于是排布为「…业务按钮 … spacer 中/EN 🎨」。
            const spacer = document.createElement("div");
            spacer.style.cssText = "flex:1;";
            const { bar: topBar } = makeXHToolbar(this, {
                mount: false,                          // 条要嵌进本节点自己的 container，不单独占一个 widget
                prependNodes: [spacer],
                colorOnPick: (hex) => { this._nodeColor = hex; this._refresh(); },   // 除上色外还要同步自身状态
            });
            topBar.style.cssText += "gap:2px;padding:4px 6px;background:rgba(0,0,0,0.3);border-radius:6px 6px 0 0;";
            this._topBar = topBar;

            // 方案 B：暗蓝 #0f3460 / 3px 圆角 → 暗底 #262d38 + 1px 半透明白描边 + 4px
            const btnStyle = `
                background:#262d38;color:#d5dde5;border:1px solid rgba(255,255,255,.10);border-radius:4px;
                width:28px;height:28px;font-size:13px;cursor:pointer;transition:all 0.2s;
                display:flex;align-items:center;justify-content:center;padding:0;
            `;

            const mkBtn = (text, fn, hoverText) => {
                const b = document.createElement("button");
                b.innerHTML = text;
                b.title = hoverText || "";
                b.style.cssText = btnStyle;
                b.onmouseover = () => b.style.filter = "brightness(1.28)";
                b.onmouseout = () => b.style.filter = "none";
                b.onclick = (e) => { e.stopPropagation(); fn(); };
                return b;
            };

            // 存储所有需要切换语言的按钮
            this._i18nBtns = {};

            const addI18nBtn = (key, zhText, enText, fn, hoverZh, hoverEn) => {
                const b = mkBtn(this._lang === "zh" ? zhText : enText, fn, this._lang === "zh" ? hoverZh : hoverEn);
                this._i18nBtns[key] = { btn: b, zh: zhText, en: enText, hoverZh, hoverEn };
                topBar.insertBefore(b, spacer);
                return b;
            };

            // 字号滑块（替代 +/- 按钮：拖动即改，比点按快）
            const fsWrap = document.createElement("div");
            fsWrap.style.cssText = "display:flex;align-items:center;gap:5px;background:#262d38;border:1px solid rgba(255,255,255,.10);border-radius:4px;padding:0 8px;height:28px;";
            fsWrap.title = this._lang === "zh" ? "字号" : "Font Size";
            const fsIcon = document.createElement("span");
            fsIcon.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M5 19 L12 5 L19 19" stroke="#e8e8e8" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/><line x1="8" y1="14" x2="16" y2="14" stroke="#e8e8e8" stroke-width="2.4" stroke-linecap="round"/></svg>`;
            const fsSlider = document.createElement("input");
            fsSlider.type = "range";
            fsSlider.min = "8";
            fsSlider.max = "1000";
            fsSlider.step = "1";
            fsSlider.value = String(this._fontSize);
            // ★ 2026-10-20 统一家族滑块色：#2980b9 → #4a90d9（与 xh_ui_kit.makeXHSlider / XH-滑块节点一致）
            fsSlider.style.cssText = "width:72px;cursor:pointer;accent-color:#4a90d9;";
            const fsVal = document.createElement("span");
            fsVal.textContent = this._fontSize + "px";
            fsVal.style.cssText = "color:#e8e8e8;font-size:10px;min-width:32px;text-align:right;";
            fsSlider.oninput = (e) => {
                e.stopPropagation();
                this._fontSize = parseInt(fsSlider.value, 10);
                fsVal.textContent = this._fontSize + "px";
                this._save();
                this._refresh();
            };
            fsWrap.appendChild(fsIcon);
            fsWrap.appendChild(fsSlider);
            fsWrap.appendChild(fsVal);
            fsWrap.addEventListener("pointerdown", (e) => e.stopPropagation());
            fsWrap.addEventListener("mousedown", (e) => e.stopPropagation());
            fsWrap.addEventListener("dblclick", (e) => e.stopPropagation());
            topBar.insertBefore(fsWrap, spacer);
            this._fsSlider = fsSlider;
            this._fsVal = fsVal;

            // 字号微调步进器（▲▼，紧跟滑块后面）：点一下 ±1（Shift+点 = ±10），长按 0.4s 后连调
            const fsStep = document.createElement("div");
            fsStep.style.cssText = "display:flex;flex-direction:column;gap:1px;height:28px;";
            const mkStepBtn = (dir) => {
                const b = document.createElement("button");
                b.innerHTML = dir > 0 ? "▲" : "▼";
                b.title = this._lang === "zh"
                    ? "微调字号：点一下 ±1（Shift+点 = ±10），按住不放连调"
                    : "Fine-tune: click ±1 (Shift+click = ±10), hold to repeat";
                b.style.cssText = "background:#2f3946;color:#d5dde5;border:1px solid rgba(255,255,255,.12);border-radius:3px;width:18px;height:13px;"
                    + "font-size:8px;line-height:1;cursor:pointer;padding:0;display:flex;"
                    + "align-items:center;justify-content:center;transition:all 0.2s;";
                b.onmouseover = () => b.style.filter = "brightness(1.28)";
                b.onmouseout = () => b.style.filter = "none";
                const apply = (ev) => {
                    const step = ev && ev.shiftKey ? 10 : 1;
                    const v = Math.max(8, Math.min(1000, this._fontSize + dir * step));
                    if (v === this._fontSize) return;
                    this._fontSize = v;
                    fsSlider.value = String(v);
                    fsVal.textContent = v + "px";
                    this._save();
                    this._refresh();
                };
                let delay = null, rep = null, pressed = false;
                const stopRep = () => { clearTimeout(delay); clearInterval(rep); delay = rep = null; };
                b.addEventListener("pointerdown", (e) => {
                    e.stopPropagation(); e.preventDefault();
                    pressed = true;
                    apply(e);
                    try { b.setPointerCapture(e.pointerId); } catch (_) {}  // 松手事件保证落回本按钮（哪怕移出窗口）
                    delay = setTimeout(() => {
                        rep = setInterval(() => {
                            if (!pressed) { stopRep(); return; }  // 自愈保险丝：不在按下态立即停
                            apply(e);
                        }, 90);
                    }, 400);  // 按住 0.4s 后连调
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
            fsStep.appendChild(mkStepBtn(1));
            fsStep.appendChild(mkStepBtn(-1));
            fsStep.addEventListener("pointerdown", (e) => e.stopPropagation());
            fsStep.addEventListener("dblclick", (e) => e.stopPropagation());
            topBar.insertBefore(fsStep, spacer);

            // 折叠/展开 工具栏 + 标题条（点一下只留文字内容）
            const compactBtn = document.createElement("button");
            compactBtn.innerHTML = SVG_COMPACT;
            compactBtn.title = this._lang === "zh" ? "折叠/展开工具栏" : "Collapse/Expand Toolbar";
            paintBarBtn(compactBtn, "neutral");   // 折叠/展开：中性档
            compactBtn.style.cssText = compactBtn.style.cssText
                + "width:28px;height:28px;font-size:13px;display:flex;align-items:center;justify-content:center;padding:0;transition:all 0.2s;";
            compactBtn.onmouseover = () => compactBtn.style.filter = "brightness(1.28)";
            compactBtn.onmouseout = () => compactBtn.style.filter = "none";
            compactBtn.onclick = (e) => { e.stopPropagation(); this._compact = !this._compact; this._applyCompact(); this._save(); };
            topBar.insertBefore(compactBtn, spacer);

            addI18nBtn("fontColor", SVG_TEXT_COLOR, SVG_TEXT_COLOR, () => {
                showXHPicker(this._i18nBtns.fontColor.btn, {
                    id: "xh_content_pop",
                    current: this._fontColor,
                    resetValue: "#ffffff",
                    resetLabel: (window.XH_LANG || "zh") === "zh" ? "默认白" : "Default White",
                    onPick: (c) => { if (c) { this._fontColor = c; this._save(); this._refresh(); } },
                });
            }, "文字颜色", "Text Color");
            addI18nBtn("bgColor", SVG_BG_COLOR, SVG_BG_COLOR, () => {
                showXHPicker(this._i18nBtns.bgColor.btn, {
                    id: "xh_content_pop",
                    current: this._bgColor === "transparent" ? "" : this._bgColor,
                    allowTransparent: true,
                    resetLabel: (window.XH_LANG || "zh") === "zh" ? "默认透明" : "Default Transparent",
                    onPick: (c) => { if (c) { this._bgColor = c; this._save(); this._refresh(); } },
                });
            }, "背景颜色", "BG Color");
            addI18nBtn("reset", "🔄", "🔄", () => { this._resetDefault(); }, "恢复默认", "Reset Defaults");

            // 字体选择
            addI18nBtn("fontFamily", "🔤", "🔤", () => {
                const fonts = ["Arial", "微软雅黑", "黑体", "宋体", "微软雅黑 Bold", "Consolas", "Courier New", "Georgia", "Times New Roman", "Impact"];
                const idx = fonts.indexOf(this._fontFamily);
                this._fontFamily = fonts[(idx + 1) % fonts.length];
                this._save();
                this._refresh();
                app.canvas.setDirty(true);
            }, `字体: ${this._fontFamily}`, `Font: ${this._fontFamily}`);

            // 粗细
            addI18nBtn("fontWeight", this._fontWeight === "bold" ? "B" : "b", this._fontWeight === "bold" ? "B" : "b", () => {
                this._fontWeight = this._fontWeight === "bold" ? "normal" : "bold";
                this._save();
                this._refresh();
            }, "切换粗细", "Toggle Bold");

            // 居左 居中 居右
            addI18nBtn("alignLeft", "居左", "Left", () => { this._align = "left"; this._save(); this._refresh(); }, "居左", "Align Left");
            addI18nBtn("alignCenter", "居中", "Center", () => { this._align = "center"; this._save(); this._refresh(); }, "居中", "Align Center");
            addI18nBtn("alignRight", "居右", "Right", () => { this._align = "right"; this._save(); this._refresh(); }, "居右", "Align Right");

            // 节点透明度
            const hideBtn = mkBtn(this._hideTitle ? "🙈" : "👁", () => {
                this._hideTitle = !this._hideTitle;
                this.color = this._hideTitle ? "transparent" : "#16213e";
                this.bgcolor = this._hideTitle ? "transparent" : "#1a1a2e88";
                this.flags.showTitle = !this._hideTitle;
                hideBtn.textContent = this._hideTitle ? "🙈" : "👁";
                hideBtn.title = this._hideTitle ? "节点已透明" : "节点显示标题";
                this._save();
                app.graph.setDirtyCanvas(true, true);
            }, this._hideTitle ? "节点已透明" : "节点显示标题");
            topBar.insertBefore(hideBtn, spacer);
            this._hideBtn = hideBtn;

            // 🎨 与 中/EN 由 makeXHToolbar 一并给出（家族唯一实现）：
            //   · 🎨 的 onPick 回调已在上面 colorOnPick 里接好（同步 _nodeColor + 重绘）
            //   · 中/EN 的 onclick 走 kit → toggleLang（写 localStorage + 广播全家族），
            //     本文件顶部的 xh:lang-changed 监听再刷 _lang / 工具栏文案 / 文字区 —— 行为等价，
            //     且能跟着别的 XH 节点一起切（原来只切自己）。
            this._boldBtn = this._i18nBtns.fontWeight.btn;

            // 文字区
            const textArea = document.createElement("div");
            textArea.style.cssText = `
                flex:1;padding:8px;font-family:${this._fontFamily},sans-serif;
                outline:none;cursor:text;overflow-y:auto;
                min-height:60px;white-space:pre-wrap;word-break:break-word;
                font-size:${this._fontSize}px;color:${this._fontColor};background:${this._bgColor};
                text-align:${this._align};font-weight:${this._fontWeight};
            `;
            textArea.contentEditable = true;
            textArea.innerHTML = this._text;

            textArea.oninput = () => {
                this._text = textArea.innerHTML;
                this._save();
            };
            textArea.onkeydown = (e) => {
                if (e.key === "Escape") textArea.blur();
            };
            textArea.ondblclick = () => {
                textArea.focus();
                const sel = window.getSelection();
                sel.selectAllChildren(textArea);
            };

            // ---- 选中文字后右键 → 字号 / 颜色 / 加粗 / 清除格式（2026-10-19）----
            //  没选中文字时**不接管**，走浏览器默认菜单（复制/粘贴照常可用）。
            textArea.addEventListener("contextmenu", (e) => {
                const sel = window.getSelection();
                if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
                const range = sel.getRangeAt(0);
                if (!textArea.contains(range.commonAncestorContainer)) return;
                e.preventDefault();
                e.stopPropagation();
                showXHLabelFormatMenu(e.clientX, e.clientY, this._lang);
            });

            // ---- 便签内超链接：点一下直接开浏览器 ----
            //  为什么需要：textArea 是 contentEditable，浏览器默认**不跟随** <a> 的点击
            //  （只把光标落进去），所以必须手动接管。命中 <a href="http(s)://..."> 就新标签页打开。
            //  便签的主要用途是「看说明 / 点链接」，纯点击即打开；想编辑就别把光标停在链接上。
            textArea.classList.add("xh-label-textarea");
            textArea.addEventListener("click", (e) => {
                const a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
                if (!a) return;
                const href = a.getAttribute("href") || "";
                if (!/^https?:\/\//i.test(href)) return;
                e.preventDefault();
                e.stopPropagation();
                try { window.open(href, "_blank", "noopener,noreferrer"); } catch (_) {}
            });
            // 免得点链接时把「选择/拖动」事件带给画布
            textArea.addEventListener("mousedown", (e) => {
                const a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
                if (a) e.stopPropagation();
            });
            // 链接样式（全局注入一次即可）
            if (!document.getElementById("xh-label-link-style")) {
                const st = document.createElement("style");
                st.id = "xh-label-link-style";
                st.textContent = `
                    .xh-label-textarea a { color:#4aa3ff; text-decoration:underline; cursor:pointer; }
                    .xh-label-textarea a:hover { color:#8ecaff; }
                `;
                document.head.appendChild(st);
            }

            // 组装
            const container = document.createElement("div");
            container.style.cssText = `
                display:flex;flex-direction:column;width:100%;height:100%;
                border-radius:6px;overflow:hidden;min-height:80px;position:relative;
            `;
            container.appendChild(topBar);
            container.appendChild(textArea);

            // 折叠态展开把手（始终可点，点开恢复工具栏）
            const expandHandle = document.createElement("div");
            expandHandle.innerHTML = SVG_EXPAND;
            expandHandle.title = this._lang === "zh" ? "展开工具栏" : "Expand Toolbar";
            expandHandle.style.cssText = "position:absolute;top:3px;left:3px;width:24px;height:24px;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.55);border-radius:4px;cursor:pointer;z-index:6;";
            expandHandle.onclick = (e) => { e.stopPropagation(); this._compact = false; this._applyCompact(); this._save(); };
            container.appendChild(expandHandle);
            this._expandHandle = expandHandle;

            this._container = container;
            this._textArea = textArea;

            try {
                this.addDOMWidget("label", "custom", container, {
                    serialize: true,
                    hideOnZoom: false,
                    minWidth: 360,
                    minHeight: 90,
                    // 把所有状态打包进控件值一起序列化往返（properties 在你这环境不持久化）
                    getValue: () => ({
                        text: this._text,
                        fontSize: this._fontSize,
                        fontColor: this._fontColor,
                        bgColor: this._bgColor,
                        align: this._align,
                        fontFamily: this._fontFamily,
                        fontWeight: this._fontWeight,
                        lang: this._lang,
                        hideTitle: this._hideTitle,
                        nodeColor: this._nodeColor,
                        compact: this._compact,
                    }),
                    setValue: (v) => {
                        if (v == null) return;
                        if (typeof v === "string") {
                            // 兼容旧版纯文本
                            this._text = v;
                        } else {
                            this._text = v.text ?? this._text;
                            this._fontSize = v.fontSize ?? this._fontSize;
                            this._fontColor = v.fontColor ?? this._fontColor;
                            this._bgColor = v.bgColor ?? this._bgColor;
                            this._align = v.align ?? this._align;
                            this._fontFamily = v.fontFamily ?? this._fontFamily;
                            this._fontWeight = v.fontWeight ?? this._fontWeight;
                            this._lang = v.lang ?? this._lang;
                            this._hideTitle = v.hideTitle ?? this._hideTitle;
                            this._nodeColor = v.nodeColor ?? null;
                            this._compact = v.compact ?? false;
                        }
                        if (this._textArea) {
                            this._textArea.innerHTML = this._text;
                            this._applyCompact();
                        }
                    },
                });
            } catch (e) {}

            // 初始刷新（含折叠态）
            this._applyCompact();

            return r;
        };

        // 保存设置
        nodeType.prototype._save = function () {
            if (!this.properties) this.properties = {};
            this.properties.text = this._text;
            this.properties.fontSize = this._fontSize;
            this.properties.fontColor = this._fontColor;
            this.properties.bgColor = this._bgColor;
            this.properties.align = this._align;
            this.properties.fontFamily = this._fontFamily;
            this.properties.fontWeight = this._fontWeight;
            this.properties.lang = this._lang;
            this.properties.hideTitle = this._hideTitle;
            this.properties.compact = this._compact;
        };

        // 刷新
        nodeType.prototype._refresh = function () {
            if (this._textArea) {
                this._textArea.style.fontSize = this._fontSize + "px";
                this._textArea.style.color = this._fontColor;
                this._textArea.style.background = this._bgColor;
                this._textArea.style.textAlign = this._align;
                this._textArea.style.fontFamily = this._fontFamily;
                this._textArea.style.fontWeight = this._fontWeight;
            }
            // 「中/EN」按钮的换字由 kit 的全局集合负责，这里不再自己刷
            // 字号滑块同步（加载存档/恢复默认时让滑块位置和数值跟着走）
            if (this._fsSlider) {
                this._fsSlider.value = String(this._fontSize);
                if (this._fsVal) this._fsVal.textContent = this._fontSize + "px";
            }
            // 透明度 / 节点自身颜色
            //   规则：用户选了节点色优先；仅「透明态」(_hideTitle) 才去背景；
            //        折叠态(_compact) 只藏标题条、保留背景（除非用户同时开了透明态）。
            if (this._nodeColor) {
                this.color = this._nodeColor;
                this.bgcolor = darkenHex(this._nodeColor, 0.42);
            } else if (this._hideTitle) {
                this.color = "transparent";
                this.bgcolor = "transparent";
            } else {
                this.color = "#16213e";
                this.bgcolor = "#1a1a2e88";
            }
            this.flags.showTitle = !(this._hideTitle || this._compact);
            app.graph.setDirtyCanvas(true, true);
        };

        // 把工具栏上所有业务按钮的文案切到当前语言（XHLabel 自己的富文本工具栏）
        nodeType.prototype._applyLangToOwnBtns = function () {
            const zh = this._lang === "zh";
            Object.values(this._i18nBtns || {}).forEach(({ btn, ...rest }) => {
                btn.innerHTML = zh ? rest.zh : rest.en;
                btn.title = zh ? rest.hoverZh : rest.hoverEn;
            });
        };

        // 折叠 / 展开（隐藏工具栏 + 标题条，只留文字内容区；折叠态右上角留展开把手）
        nodeType.prototype._applyCompact = function () {
            if (this._topBar) this._topBar.style.display = this._compact ? "none" : "flex";
            if (this._expandHandle) this._expandHandle.style.display = this._compact ? "flex" : "none";
            this._refresh();
        };

        // 恢复默认
        nodeType.prototype._resetDefault = function () {
            this._fontSize = 12;
            this._fontColor = "#ffffff";
            this._bgColor = "transparent";
            this._align = "left";
            this._fontFamily = "Arial";
            this._fontWeight = "normal";
            this._lang = "zh";
            this._hideTitle = true;
            this._nodeColor = null;
            this._compact = false;
            this._save();
            this._applyCompact();
        };
    },
});