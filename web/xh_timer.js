// XH 计时器 - Nodes 2.0 兼容（修复版 + 中英文切换）
const { app } = window.comfyAPI.app;
const { api } = window.comfyAPI.api;
import { ensureLangBridge, makeXHToolbar, releaseButtons , paintBarBtn} from "./xh_ui_kit.js";

// ① 语言桥：window.XH_LANG 变 accessor —— 赋值即写 localStorage + 广播 xh:lang-changed
ensureLangBridge();
// ② 家族同步：别的 XH 节点切语言时，所有计时器跟着切（本节点是自绘 DOM）
window.addEventListener("xh:lang-changed", (e) => {
    const lang = (e.detail && e.detail.lang) || window.XH_LANG || "zh";
    try {
        for (const n of (app.graph ? (app.graph.nodes || app.graph._nodes || []) : [])) {
            if (!n || n.type !== "XHTimer") continue;
            n._lang = lang;
            if (LABELS[lang]) n.title = LABELS[lang].title;
            // 「中/EN」按钮的换字由 kit 的全局集合负责，这里不再自己刷
            if (n._resetBtn && LABELS[lang]) n._resetBtn.textContent = LABELS[lang].reset;
        }
        app.graph?.setDirtyCanvas?.(true, true);
    } catch (err) {}
});

// ---- 节点自身配色（与 XH_LoraStack / XH_Slider / XH_Toolbox 分组控制 同一套：去官方重复色，12 色高辨识度 + 自定义取色器）----

const NODE_TYPE = "XHTimer";
let _timerListenersBound = false;

// 中英文文字
const LABELS = {
    zh: { title: "🔁XH-计时器", reset: "🔄 重置" },
    en: { title: "XH Timer", reset: "🔄 Reset" },
};

// 对图上所有计时器节点执行 fn（graph.nodes 在旧前端上叫 _nodes，两个都兜住）
function forEachTimer(fn) {
    const nodes = (app.graph && (app.graph.nodes || app.graph._nodes)) || [];
    for (const n of nodes) {
        if (n && n.type === NODE_TYPE) fn(n);
    }
}

// ---- ④ 停表后闪烁提醒（2026-10-21 用户提的）--------------------------------
//   用途：跑完/中断/报错后表停住，人又不在电脑前 —— 回来一眼看到「还在闪」就知道跑完了。
//   实现：只切一个 CSS class，动画交给浏览器，**不用 setInterval**（不产生后台空转、不泄漏）。
//   什么时候停闪：下一次执行起表 / 手动点「重设」。
const BLINK_CLASS = "xh-timer-blink";
let _blinkStyleInjected = false;
function ensureBlinkStyle() {
    if (_blinkStyleInjected) return;
    _blinkStyleInjected = true;
    try {
        const st = document.createElement("style");
        st.textContent =
            `@keyframes xhTimerBlink {`
            + `0%,100% { opacity:1; }`
            + `50% { opacity:.15; }`
            + `}`
            + `.${BLINK_CLASS} { animation: xhTimerBlink 1s steps(1,end) infinite; }`
            + `@media (prefers-reduced-motion: reduce) {`
            + `.${BLINK_CLASS} { animation: none; opacity:1; } }`;
        document.head.appendChild(st);
    } catch (e) {}
}
function setBlink(node, on) {
    if (!node || !node._display) return;
    if (on) ensureBlinkStyle();
    try { node._display.classList.toggle(BLINK_CLASS, !!on); } catch (e) {}
}

app.registerExtension({
    name: "XH.Timer",
    async setup() {
        // 全局监听执行事件（注意：执行生命周期事件是 api 派发的，不是 document）
        if (_timerListenersBound) return;
        _timerListenersBound = true;

        // 起表
        // _idleTimer：status 兜底停表的「待确认」定时器；新任务一开始就取消它，避免误停新表
        let _idleTimer = null;
        api.addEventListener("execution_start", () => {
            if (_idleTimer) { clearTimeout(_idleTimer); _idleTimer = null; }
            forEachTimer((n) => n._startTimer?.());
        });

        // 停表：只有这三个是真正的“执行终止”事件。
        // 后端 execution.py 发的是 execution_interrupted（前端 api.js 的 WS 白名单里
        // 也只认这个名字）；老代码监听的 `execution_cancelled` **根本不存在**，
        // 是个死监听 —— 所以手动中断时表一直转。已改为正确事件名。
        const stopAllTimers = () => forEachTimer((n) => n._stopTimer?.());
        api.addEventListener("execution_success", stopAllTimers);
        api.addEventListener("execution_error", stopAllTimers);
        api.addEventListener("execution_interrupted", stopAllTimers); // ← 手动中断 / 点取消

        // 兜底：队列彻底空也停表（覆盖「中断瞬间刚好跑完 / WS 消息丢失」）。
        // 🔴🔴 2026-10-19 修 bug：**不能只凭 queue_remaining === 0 就停表** ——
        //   这个字段在不同 ComfyUI 版本里可能只统计「排队中」、不含「正在执行」，
        //   于是**跑着跑着收到一个 status 事件就把表停了**（用户实测：到某个时长突然停）。
        //   现在的做法：延迟 2 秒，用 /queue 再确认 running 和 pending **都为空**，才真停。
        //   查不到（网络/接口变更）就**不停表** —— 宁可多转，也别误停。
        api.addEventListener("status", (e) => {
            const remaining = e?.detail?.exec_info?.queue_remaining;
            if (remaining !== 0) {
                if (_idleTimer) { clearTimeout(_idleTimer); _idleTimer = null; }
                return;
            }
            if (_idleTimer) clearTimeout(_idleTimer);
            _idleTimer = setTimeout(async () => {
                _idleTimer = null;
                try {
                    const q = await (await fetch("/queue")).json();
                    const running = (q.queue_running || []).length;
                    const pending = (q.queue_pending || []).length;
                    if (running === 0 && pending === 0) stopAllTimers();
                } catch (err) {
                    /* 查不到就不停，宁可多转 */
                }
            }, 2000);
        });
    },

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_TYPE) return;

        nodeType.isVirtualNode = true;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = onNodeCreated?.apply(this, arguments);

            // 从 properties 恢复
            this._lang = window.XH_LANG || this.properties?.lang || "zh";
            this.title = LABELS[this._lang].title;
            this.serialize_widgets = false;
            this.widgets = [];
            this.size = [300, 80];
            this._running = false;
            this._timerId = null;
            this._startTime = null;
            this._lastFontSize = 0;

            // 显示区
            const display = document.createElement("div");
            display.style.cssText = `
                width:100%;height:100%;display:flex;align-items:center;justify-content:center;
                font-family:monospace;font-weight:bold;outline:none;cursor:default;
                white-space:normal;word-break:break-word;
                user-select:none;color:#ffffff;overflow:hidden;
                text-align:center;
            `;
            display.textContent = "00:00:00";
            this._display = display;

            // 标题栏 = 标准工具条（重设 + 中/EN + 🎨）—— 家族唯一实现见 web/xh_ui_kit.js
            const resetBtn = document.createElement("button");
            resetBtn.textContent = LABELS[this._lang].reset;
            resetBtn.style.cssText = `
                background:#262d38;color:#d5dde5;border:1px solid rgba(255,255,255,.10);border-radius:4px;
                padding:4px 8px;font-size:12px;cursor:pointer;transition:all 0.2s;
                display:flex;align-items:center;justify-content:center;white-space:nowrap;
            `;
            resetBtn.onclick = (e) => {
                e.stopPropagation();
                this._startTime = null;
                setBlink(this, false);          // 手动重设 = 人已经看过了，停闪
                this._display.textContent = "00:00:00";
                this._updateFontSize();
            };
            // 方案 B：hover 走亮度滤镜，恢复走 paintBarBtn 重刷（不写死色值）
            resetBtn.onmouseover = () => resetBtn.style.filter = "brightness(1.28)";
            resetBtn.onmouseout = () => { resetBtn.style.filter = "none"; paintBarBtn(resetBtn, "neutral"); };
            this._resetBtn = resetBtn;

            const spacer = document.createElement("div");
            spacer.style.cssText = `flex:1;`;

            // kit 的中/EN onclick 负责 toggleLang（写 localStorage + 广播），按钮换字由 kit 全局负责；
            // 本文件顶部的 xh:lang-changed 监听器再负责把 _lang / title / 「重设」文案刷掉 —— 行为等价。
            const { bar: titleBar } = makeXHToolbar(this, { mount: false, prependNodes: [resetBtn, spacer] });
            titleBar.style.cssText += "background:rgba(0,0,0,0.3);border-radius:6px 6px 0 0;";

            // 组装
            const container = document.createElement("div");
            container.style.cssText = `
                display:flex;flex-direction:column;width:100%;height:100%;
                border-radius:6px;overflow:hidden;min-height:50px;
            `;
            container.appendChild(titleBar);
            container.appendChild(display);
            this._container = container;

            try {
                this.addDOMWidget("timer", "custom", container, {
                    serialize: false,
                    hideOnZoom: false,
                    minWidth: 250,
                    minHeight: 50,
                });
            } catch (e) {}

            // 监听节点尺寸变化
            this._resizeObserver = new ResizeObserver(() => {
                this._updateFontSize();
            });
            this._resizeObserver.observe(container);

            return r;
        };

        // 更新字号（跟随节点大小）
        nodeType.prototype._updateFontSize = function () {
            if (!this._display || !this._container) return;
            const w = this._container.offsetWidth;
            const h = this._container.offsetHeight;
            // 字号自适应：不超过宽度的22%，不超过高度的50%
            const fontSize = Math.max(12, Math.min(w * 0.22, h * 0.5));
            if (fontSize !== this._lastFontSize) {
                this._display.style.fontSize = fontSize + "px";
                this._lastFontSize = fontSize;
            }
        };

        // 保存设置
        nodeType.prototype._save = function () {
            if (!this.properties) this.properties = {};
            this.properties.lang = this._lang;
        };

        // 启动计时（每次执行都从 0 重新起表；万一上一次因异常没停下，也能自愈）
        nodeType.prototype._startTimer = function () {
            if (this._timerId) {
                clearInterval(this._timerId);
                this._timerId = null;
            }
            this._running = true;
            this._startTime = Date.now();
            setBlink(this, false);              // 新的一跑就停闪（上一次跑完的提醒到此为止）

            this._timerId = setInterval(() => {
                if (!this._running) return;
                const elapsed = Date.now() - this._startTime;
                const s = Math.floor(elapsed / 1000);
                const cs = Math.floor((elapsed % 1000) / 10); // 百分秒（2 位，去掉毫秒第三位）
                const mm = String(Math.floor(s / 60)).padStart(2, "0");
                const ss = String(s % 60).padStart(2, "0");
                const cc = String(cs).padStart(2, "0");
                this._display.style.color = "#ffffff";
                this._display.textContent = `${mm}:${ss}:${cc}`;
                this._updateFontSize();
            }, 10);

            this._display.style.color = "#ffffff";
            this._display.textContent = "00:00:00";
            this._updateFontSize();
        };

        // 停止计时（跑完 / 报错 / 手动中断 都走这里 → 数字定住并开始闪烁提醒）
        nodeType.prototype._stopTimer = function () {
            this._running = false;
            if (this._timerId) {
                clearInterval(this._timerId);
                this._timerId = null;
            }
            // 只在「真的计过一段时间」时才闪：压根没起过表（_startTime 为空）就别闪，
            // 免得刚打开工作流、收到一个 status 兜底事件就开始满屏闪。
            if (this._startTime != null) setBlink(this, true);
        };

        // 节点被删除时清理，避免 interval / ResizeObserver 残留（后台空转）
        const onRemoved = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function () {
            this._running = false;
            if (this._timerId) {
                clearInterval(this._timerId);
                this._timerId = null;
            }
            setBlink(this, false);                  // 节点都没了，别让动画留着
            try { this._resizeObserver?.disconnect(); } catch (e) {}
            return onRemoved?.apply(this, arguments);
        };
    },
});