// 🔁 XH 提示词表 · 前端（「中/EN」+「📂 文件夹」两个按钮）
// 2026-09-30：框数改成节点自己的参数 —— 纯前端折叠，不写文件、不重建画布、同类节点互不干扰。
//
// 家族规范（照抄 Comfyui-XH_H3MemorySaver/web/xh_memsaver_lang.js）：
//   * Nodes 2.0 / Vue 节点模式下用 node.addDOMWidget(name, "custom", <button>) 挂原生 HTML 按钮
//   * 语言键统一 xh_node_lang，全家族共享；只改 widget.label，绝不改 widget.name
//   * 语言按钮放默认位置（底部），不 unshift —— 避免破坏 widgets_values 下标
//
// ⚠️ 前提：本包 __init__.py 必须声明 WEB_DIRECTORY = "web"，否则本文件不会被加载。
//
// 框数机制（2026-09-30 起：纯前端折叠，不写文件、不重建画布）：
//   · num_slots 是节点自己的参数（存在工作流里，实例级）；后端固定声明 32 个框，前端按 num_slots 折叠/展开。
//   · 改 num_slots 只做本地显隐（w.hidden + computeSize + element.style.display 三保险），秒生效。
//   · 同类节点互不干扰，框数随工作流走。
//
//   ⛔ 不做前端 widget 增删/显隐 —— 那条路在 Vue 节点模式下不可靠（已实测废弃）。
// 2026-10-16：「✅ 应用框数」按钮删除 —— 改数字早就是实时生效，按钮 100% 冗余
//   （后端 /xh_chainprompt/set_slots 路由同轮清理，register_routes 已成空函数）。
const { app } = window.comfyAPI.app;
const { api } = window.comfyAPI.api;
import { ensureLangBridge, makeXHToolbar, onLangChanged, releaseButtons, lockDomWidgetHeight, forceCompactOnSpawn, isSizeLike, makeGearBtn, makeBarBtn, paintBarBtn, BAR_COLORS } from "./xh_ui_kit.js";

// ① 语言桥：window.XH_LANG 变 accessor —— 赋值即写 localStorage + 广播 xh:lang-changed
ensureLangBridge();
// ② 家族同步：按钮换字由 kit 全局负责；本节点的标题/标签/端口名换字走 onLangChanged（见文件底部 setup）
// ---- 节点自身配色（与 XH_LoraStack / XH_Slider / XH_Toolbox 分组控制 同一套：去官方重复色，12 色高辨识度 + 自定义取色器）----

const NODE_TYPE = "XH_ChainPromptSelector";
const NODE_TYPE2 = "XH_DynamicPromptJoin";   // 2026-10-13 新增：动态提示词联结
const MIN_SLOTS = 1;
const MAX_SLOTS = 32;
const DEFAULT_SLOTS = 1;   // 与后端 DEFAULT_PROMPT_SLOTS 保持一致：num_slots 读不到时的兜底（2026-10-13 由 5 改 1：拖出来只给 1 框，要几段自己加）

// Join（动态联结）输入口上限 —— 与后端 XH_DynamicPromptJoin.MAX_INPUTS 保持一致
const JOIN_MAX_INPUTS = 12;
const JOIN_KEEP_INPUTS = 2;  // 常驻口数（prompt_0 / prompt_1）

// 参数 widget 的固定顺序（排在所有 prompt_N 之后）—— 必须与后端 INPUT_TYPES 的声明顺序一致
// ⚠️ follow_loop_turn / all_segments 都是 2026-10-01 新增的，**故意放在最后**：
//    这样老存档的 widgets_values（…, loop, num_slots）前几项仍然对得上，
//    不会把 num_slots 的值错读成新参数。
const XH_I18N = {
    zh: {
        nodes: {
            XH_ChainPromptSelector: "🔁 XH-提示词表",
            XH_DynamicPromptJoin: "🔁 XH-提示词联结(动态)",
        },
        widgets: {
            num_slots: "框数（改数字实时生效）",
            start_index: "起始段（0 = 第 1 段）",
            restart_index: "重置序号（改动→从头跑）",
            loop: "循环（段号用完→绕回第1段）",
            follow_loop_turn: "自动跟随循环轮次（循环体内零接线）",
            all_segments: "自循环·跑全部段（不接循环也能一次出N段）",
            source: "数据来源（文本框 / 文件夹）",
            prompt_folder: "文件夹路径（点「📂 文件夹」选或粘贴）",
            start_offset: "起跑偏移（工具条「▶ 起跑」按钮写的就是它；已隐藏，别手填）",
        },
        folder: "📂 文件夹",
        folderOk: "✅ 已关联：%d 段",
        folderFail: "⚠ 关联失败：%s",
        gearHide: "收起参数（只留提示词框）",
        gearShow: "展开参数设置",
        copyOneTip: "复制这一段（只复制正文）",
        startBtn: (n) => `▶ 起跑 ${n}`,
        startTip: "选从第几段开始跑（选过就以它为准，盖过「起始段」连线；选第1段=恢复跟线）",
        startSet: (n) => `从第 ${n} 段起跑`,
        copy: "复制",
        clear: "清",
        undoLabel: "撤",
        clearTip: "清空全部提示词框（可撤销）",
        undo: "撤销清空 —— 恢复清空前的内容",
        cleared: (n) => `已清空 ${n} 段（点 ↩ 可恢复）`,
        nothingToClear: "本来就是空的",
        copyTip: "复制全部非空提示词到剪贴板",
        copied: (n) => `已复制 ${n} 段`,
        nothingToCopy: "没有内容可复制",
        folderPicking: "已弹出「选择文件夹」窗口…  没弹？在「文件夹路径」那行粘贴路径也行。",
        promptLabel: (i) => `第 ${i} 段提示词`,
        joinLabel: (i) => `提示词${i}`,
        joinDelimiter: "间隔符（相邻两段之间；填 \\n = 换行拼接）",
        joinStatus: (n) => `🔗 已接 ${n} 路（接满自动加下一路）`,
        slots: {
            prompt: "提示词",
            segment_index: "段序号",
            prompt_list: "全部段(列表)",
        },
        btns: {
            fetchDefs: "⏳ 拉取定义…",
            rebuild: "⏳ 重建画布…",
        },
        fail: "设置失败，请查看 ComfyUI 后端控制台日志。",
    },
    en: {
        nodes: {
            XH_ChainPromptSelector: "🔗 XH-ChainPrompt Selector",
            XH_DynamicPromptJoin: "🔗 XH-Prompt Join (Dynamic)",
        },
        widgets: {
            num_slots: "Slots (live)",
            start_index: "Start segment (0 = 1st)",
            restart_index: "Restart (change to rewind)",
            loop: "Loop (rewind after last segment)",
            follow_loop_turn: "Auto-follow loop turn (no wiring in loop body)",
            all_segments: "Self-loop · run all segments (no external loop)",
            source: "Source (text box / folder)",
            prompt_folder: "Folder path (📂 pick or paste)",
            start_offset: "Start offset (written by the ▶ Start button; hidden — set it from the button)",
        },
        folder: "📂 Folder",
        folderOk: "✅ Linked: %d segments",
        folderFail: "⚠ Link failed: %s",
        gearHide: "Collapse params (keep prompt boxes only)",
        gearShow: "Expand params",
        copyOneTip: "Copy this segment only",
        startBtn: (n) => `▶ Start ${n}`,
        startTip: "Pick the first segment to run (overrides wired start_index; pick #1 to follow the wire again)",
        startSet: (n) => `Start at #${n}`,
        copy: "Copy",
        clear: "Clear",
        undoLabel: "Undo",
        clearTip: "Clear all prompt boxes (undoable)",
        undo: "Undo clear - restore previous content",
        cleared: (n) => `Cleared ${n} segments (click to undo)`,
        nothingToClear: "Already empty",
        copyTip: "Copy all non-empty prompts to clipboard",
        copied: (n) => `Copied ${n} segments`,
        nothingToCopy: "Nothing to copy",
        folderPicking: "Folder picker opened…  Nothing appeared? Paste the path into «Folder path» instead.",
        promptLabel: (i) => `Segment ${i}`,
        joinLabel: (i) => `Prompt ${i}`,
        joinDelimiter: "Delimiter (between segments; \\n = newline)",
        joinStatus: (n) => `🔗 ${n} wired (auto-spawns next slot)`,
        slots: {
            prompt: "prompt",
            segment_index: "segment_index",
            prompt_list: "all segments (list)",
        },
        btns: {
            fetchDefs: "⏳ Fetching defs…",
            rebuild: "⏳ Rebuilding canvas…",
        },
        fail: "Failed. Check the ComfyUI backend console log.",
    },
};

// ===== 全局语言状态：由文件顶部的 ensureLangBridge() 统一安装（访问器 + 广播）=====
// 此处不再直接赋值；直接 `window.XH_LANG = x` 会走 setter → 写 localStorage + 广播，家族自动同步。

// 「中/EN」按钮的收集 Map 已于 2026-10-05 移除 —— 换字工作统一交给 xh_ui_kit 的全局集合。

function pack() {
    return XH_I18N[window.XH_LANG] || XH_I18N.zh;
}

// ---------------------------------------------------------------- 基础判定
function normalizeType(type) {
    return typeof type === "string" ? type.replace(/^[^\w]+/, "") : type;
}

function isMyNode(type) {
    return typeof type === "string" && normalizeType(type) === NODE_TYPE;
}

function isPromptName(name) {
    return typeof name === "string" && /^prompt_\d+$/.test(name);
}

function promptIndexOf(w) {
    return Number(String(w.name).replace(/\D/g, ""));
}

// 输入 / 输出端口名本地化：只改 label，绝不改 name（后端按 name 找端口）。
// Nodes 2.0 端口标签走快照渲染，改完必须显式触发重建（官方 Subgraph 改名同机制）。
function applySlotLabels(node, dict) {
    if (!node || !dict) return;
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
}

// ---------------------------------------------------------------- 语言 / 标签
function applyLangToNode(node) {
    if (!node || !isMyNode(node.type)) return;
    const p = pack();
    try {
    // 0. 工具条按钮的**文字 + 悬浮提示**全部跟随语言（📂文件夹 / 📋复制 / 清·撤 / ⚙提示）
    try { refreshBarBtnLabels(node); } catch (e) {}
        // 1. 标题（只在还是默认显示名时改，保留用户自定义标题）
        const zhName = XH_I18N.zh.nodes.XH_ChainPromptSelector;
        const enName = XH_I18N.en.nodes.XH_ChainPromptSelector;
        if (!node.title || node.title === zhName || node.title === enName) {
            node.title = p.nodes.XH_ChainPromptSelector;
        }
        // 2. 参数标签 —— 只改 label，绝不改 name（后端按 name 取参数）
        for (const w of node.widgets || []) {
            if (!w || !w.name) continue;
            if (isPromptName(w.name)) {
                w.label = p.promptLabel(promptIndexOf(w) + 1); // 1 起
            } else if (w.name === "source") {
                w.label = p.widgets.source;
            } else if (w.name === "prompt_folder") {
                w.label = p.widgets.prompt_folder;
            } else if (p.widgets[w.name]) {
                w.label = p.widgets[w.name];
            }
        }
        // 3. 输出端口名（只改 label，绝不改 name；Nodes 2.0 需显式触发重建）
        applySlotLabels(node, p.slots);
    } catch (e) {
        console.warn("[XH-ChainPrompt] 应用语言失败:", e);
    }
    // 4. label 文字变了（第 N 段 ↔ Segment N）⇒ 徽章要重新定位/重上色
    try { paintSlotBadges(node); } catch (e) {}
}

function applyLangToAll() {
    try {
        for (const n of (app.graph ? app.graph._nodes || [] : [])) {
            if (isJoinNode(n.type)) applyLangToJoinNode(n);
            else applyLangToNode(n);
        }
        if (app.graph) app.graph.setDirtyCanvas(true, true);
    } catch (e) {}
}

// ---------------------------------------------------------------- 「中/EN」按钮
// 自建的 createLangBtn / addDomLangBtn / updateAllLangBtns 已于 2026-10-05 移除，
// 一律用 xh_ui_kit 的 makeXHToolbar（内含唯一的「中/EN」+「🎨」实现）。


// ---------------------------------------------------------------- 框数工具
// 2026-09-30 起框数改为纯前端折叠（见 applySlotVisibility），不再重排 widgets_values / 重建画布，故删除旧 remapWidgetsValues。

// ---------------------------------------------------------------- 框数折叠（2026-09-30 大改）
// 框数从「后端公共文件」改成「本节点自己的参数」——
//   ① 同一工作流放两个该节点**不再互相干扰**（原来改一个另一个也变）；
//   ② 不需要写文件 / 重新拉节点定义 / 重建画布 ⇒ **秒生效**，也不会丢画布上未保存的改动；
//   ③ 框数存在工作流里 ⇒ 发给别人时框数跟着走（原来对方看到的是他自己那份文件的值）。
/** 按 num_slots 折叠 / 展开提示词框（只作用于本节点，纯本地）。返回声明总数。
 *  三保险隐藏，覆盖 ComfyUI 新旧前端：
 *    ① w.hidden        —— graph / DOM 节点模式下前端按此隐藏（逻辑层）
 *    ② w.computeSize   —— canvas 模式下高度 -4 不绘制（经典 litegraph 折叠）
 *    ③ w.element.style.display —— DOM 已挂载时直接隐藏元素（兜底）
 */
function applySlotVisibility(node) {
    const n = readSlotsFromNode(node);
    let seen = 0;
    for (const w of node.widgets || []) {
        if (!w || !/^prompt_\d+$/.test(w.name || "")) continue;
        seen++;
        const show = seen <= n;
        // 还原上一轮可能覆盖的 computeSize
        if (show) {
            if (w._xh_cp_collapsed) {
                w._xh_cp_collapsed = false;
                if (w._xh_cp_orig_cs) { w.computeSize = w._xh_cp_orig_cs; }
                else { delete w.computeSize; }
            }
        } else {
            if (!w._xh_cp_collapsed) {
                w._xh_cp_orig_cs = w.computeSize;   // 记下原函数，展开时还原
                w._xh_cp_collapsed = true;
            }
            const cs = () => [0, -4]; cs._xh_cp = true;
            w.computeSize = cs;                      // canvas 模式：高度 -4 不绘制
        }
        // 主机制：逻辑隐藏（graph / DOM 模式）
        w.hidden = !show;
        // DOM 兜底：直接操作已挂载元素
        if (w.element) {
            try { w.element.style.display = show ? "" : "none"; } catch (e) {}
        }
    }
    // 🔴 2026-10-13 紧凑框高：ComfyUI 多行文本框默认 ~90px 太占地方，显示中的框统一压到 58px。
    //    DOM（inputEl.style.height）+ canvas（computeSize 包装）双保险；
    //    只压**显示中**的框，折叠框走原有折叠机制互不干扰；用户手动拖高框 → inputEl 会被用户改，此处只在钩子触发时重设。
    for (const w of node.widgets || []) {
        if (!w || !/^prompt_\d+$/.test(w.name || "") || w.hidden) continue;
        if (!w._xh_cp_compact) {
            w._xh_cp_compact = true;
            const prevCs = w.computeSize;                 // 可能是原始函数，也可能是折叠还原后的函数
            w.computeSize = function () {
                const base = prevCs ? prevCs.apply(this, arguments) : [0, 90];
                return [base[0], Math.min(base[1], 58)];
            };
        }
        // 🔴 2026-10-13 修复①（默认爆高）：去掉 addMultilineWidget 默认的 [400,200] minNodeSize 地板
        //    （否则节点最小宽 400 / 高 200 被强制撑大），宽对齐家族 330 上限。
        try {
            if (w.options && Array.isArray(w.options.minNodeSize) &&
                (w.options.minNodeSize[0] !== 330 || w.options.minNodeSize[1] !== 58)) {
                w.options.minNodeSize = [330, 58];
            }
        } catch (e) {}
        // 🔴 2026-10-13 修复②（工具条下大空白，用户复测 v1.9.22 反馈）：
        //    上一版给 computeLayoutSize 钉死 {minHeight:58, maxHeight:58} → 走 fixed 分支后，
        //    用户拖大节点时多余竖向空间**没人认领**，distributeSpace 分不出去 → 工具条和提示词框之间留一大条空白，
        //    且拖得越大空白越大。
        //    正确做法：minHeight:58 + **有限 maxHeight:480**（可增长但封顶；🔴 2026-10-24 修无限拉长：缺 maxHeight 会被 distributeSpace 当 maxSize=∞ 无限吃空间，节点高与控件高互相喂），
        //    多余竖向空间全部由提示词框吸收 → 拖大节点时「只有提示词框跟着变大」（用户要的正是这个行为）。
        try {
            if (!w._xh_cp_layout_grow) {
                w._xh_cp_layout_grow = true;
                w.computeLayoutSize = () => ({ minHeight: 58, maxHeight: 480, minWidth: 0, maxWidth: 1e6 });
            }
        } catch (e) {}
        // 🔴 2026-10-13 修复③：上一版 inputEl 内联 height:58px 会压过 DomWidget.vue 给的 h-full 类
        //    （内联优先级更高），导致框永远 58px、吸不了空间 → 空白依旧。
        //    改成 min-height:58px 兜底 + 清掉内联 height，让 h-full 生效 → 框填满分到的行高。
        if (w.inputEl) {
            try {
                w.inputEl.style.minHeight = "58px";
                if (w.inputEl.style.height === "58px") w.inputEl.style.height = "";
            } catch (e) {}
        }
    }
    try {
        // 🔴 2026-10-01 修复：这里原来是把节点尺寸强行设成 computeSize() 的结果（已删除），
        //    computeSize() 是按内容算的「最小自然尺寸」，setSize 会把**宽高一起**重置，
        //    于是用户手动拖大的节点一改框数就缩回原形（用户实测反馈）。
        //    折叠只是显示层的事，**节点尺寸归用户**，这里只重绘、不碰 size。
        node.setDirtyCanvas?.(true, true);
        node.graph?.setDirtyCanvas?.(true, true);
    } catch (e) {}
    // 框数变化会重建 label ⇒ 重上色
    try { paintSlotBadges(node); } catch (e) {}
    return seen;
}

// ---------------------------------------------------------------- 段号彩色徽章（2026-10-19 用户要求：每框左上角一个带底色的段号小图标）
// 做法：**只给原生 label 元素上色**（圆角药丸 + 深底色 + 白字），不改 DOM 结构、不动布局。
//   · 定位：以 w.inputEl 为锚 → 向上找 `.lg-node-widget` 行 → 行内找「文本 === w.label」的**叶子元素**
//   · 找不到就跳过（宁可不显示，也不乱盖别人的控件）
//   · Vue Nodes 会异步挂载/重建 ⇒ 在 applySlotVisibility、语言切换、载入后多时机重刷
//   ⚠️ 画布（非 Vue）模式下控件由 canvas 绘制、没有 DOM label ⇒ 本功能不生效，属正常。
// 🔴 与「🖼️XH-图片列表」(web/xh_image_list.js) 的 RANK_COLORS **完全一致**，别各写一套：
//    第 1 段=金 / 第 2 段=银 / 第 3 段=铜 / 第 4 段及以后=蓝（兜底色）
const SLOT_COLORS = ["#e6b800", "#9aa7b3", "#cd7f32"];
const SLOT_COLOR_DEFAULT = "#3a7bd5";

/** 空白归一化：Vue 模板里可能混入 nbsp / 多个空格，直接全等比会失配。 */
function normText(s) {
    return String(s == null ? "" : s).replace(/\s+/g, " ").trim();
}

function paintSlotBadges(node) {
    if (!node || !Array.isArray(node.widgets)) return;

    // ① 节点根元素：node.element 优先，退到 data-node-id
    let nodeEl = null;
    try {
        nodeEl = (node.element && node.element.isConnected) ? node.element : null;
        if (!nodeEl) nodeEl = document.querySelector(`[data-node-id="${node.id}"]`);
    } catch (e) {}

    // ② 一次遍历建「文本 → 最贴近文本的元素」索引
    //    为什么不只认叶子：Vue 可能把「第 1 段提示词」拆成多个 span / 文本节点，
    //    此时任何单个叶子都不等于完整 label，必须选 textContent 全等且**子元素最少**的那层。
    const index = new Map();
    if (nodeEl) {
        for (const e of nodeEl.querySelectorAll("*")) {
            const t = normText(e.textContent);
            if (!t || t.length > 40) continue;
            const kids = e.querySelectorAll("*").length;
            const prev = index.get(t);
            if (!prev || kids < (prev._xh_kids ?? 1e9)) {
                e._xh_kids = kids;
                index.set(t, e);
            }
        }
    }

    let hit = 0;
    for (const w of node.widgets) {
        if (!isPromptName(w.name)) continue;
        const want = normText(w.label);
        if (!want) continue;

        // ③ 首选整节点索引（不依赖 inputEl —— 这是上一版失效的根因）
        let target = index.get(want) || null;

        // ④ 回退：本行容器内再找一次
        if (!target && w.inputEl) {
            const row = w.inputEl.closest?.(".lg-node-widget") || null;
            if (row) {
                let best = null, bestKids = -1;
                for (const e of row.querySelectorAll("*")) {
                    if (normText(e.textContent) !== want) continue;
                    const kids = e.querySelectorAll("*").length;
                    if (bestKids === -1 || kids < bestKids) { best = e; bestKids = kids; }
                }
                target = best;
            }
        }
        if (!target) continue;
        hit++;

        // 顺手把「行容器」记下来：右上角的复制按钮要靠它定位（inputEl 在 Vue 下可能没有）
        try { w._xh_cp_row = target.closest?.(".lg-node-widget") || null; } catch (e) {}

        const idx = promptIndexOf(w);
        const c = idx < SLOT_COLORS.length ? SLOT_COLORS[idx] : SLOT_COLOR_DEFAULT;
        const st = target.style;
        st.display = "inline-block";
        st.background = c;
        st.color = "#ffffff";
        st.borderRadius = "999px";
        // 🔴 上下不留 padding + 收窄行高：整体高度**不超过原生 label**，否则会压住下面第一行提示词
        st.padding = "0 6px";
        st.fontSize = "10.5px";
        st.fontWeight = "600";
        st.lineHeight = "1.3";
        st.whiteSpace = "nowrap";
        st.opacity = "1";
        st.marginBottom = "1px";
        st.verticalAlign = "top";
    }

    // 徽章定位完成后，再补「每框右上角复制」—— 它复用上面算出来的行容器
    try { paintSlotCopyBtns(node); } catch (e) {}

    node._xh_cp_badge_hits = hit;
    // 诊断：只在**一次都没命中**时报一次，方便排查（不刷屏）
    if (!hit && !node._xh_badge_warned) {
        node._xh_badge_warned = true;
        try {
            console.warn("[XH-ChainPrompt] 段号徽章未命中", {
                节点DOM: !!nodeEl,
                控件有inputEl: (node.widgets || []).some((w) => w && w.inputEl),
                前三个label: (node.widgets || []).filter((w) => w && isPromptName(w.name)).slice(0, 3).map((w) => w.label),
                节点内文本样本: [...index.keys()].slice(0, 12),
            });
        } catch (e) {}
    }
}

// ---------------------------------------------------------------- 每框右上角「复制这一段」（2026-10-19）
// 为什么是右上角：**右下角被第三方「提示词小助手」的按钮占了**，硬塞会撞车（且别人没装那个插件时布局还不一样）。
// 交互：默认透明，鼠标移进这一行才淡入；点一下变 ✓ 闪一下。
function ensureCopyBtnStyle() {
    if (document.__xh_cp_copy_style) return;
    const st = document.createElement("style");
    st.id = "xh-cp-copy-style";
    st.textContent =
        ".__xh_cp_row:hover .__xh_cp_copy1{opacity:1 !important;pointer-events:auto !important;}" +
        ".__xh_cp_row:hover .__xh_cp_copy1:hover{background:#DCD8FB !important;}";
    document.head.appendChild(st);
    document.__xh_cp_copy_style = true;
}

/** 复制单个框的正文（不带「第 N 段」标题）。 */
async function copyOnePrompt(w) {
    const v = String(w?.value ?? "");
    if (!v.trim()) return false;
    try {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(v);
        } else {
            const ta = document.createElement("textarea");
            ta.value = v;
            ta.style.position = "absolute";
            ta.style.left = "-9999px";
            document.body.appendChild(ta);
            ta.select();
            document.execCommand("copy");
            document.body.removeChild(ta);
        }
        return true;
    } catch (e) {
        console.warn("[XH-ChainPrompt] 单段复制失败:", e);
        return false;
    }
}

/** 给每个提示词行插一颗「复制」小按钮（幂等：已插过只更新 title）。 */
function paintSlotCopyBtns(node) {
    if (!node || !Array.isArray(node.widgets)) return;
    ensureCopyBtnStyle();

    for (const w of node.widgets) {
        if (!isPromptName(w.name)) continue;
        // 🔴 行容器优先用徽章那一步算出的 `_xh_cp_row`（Vue 下原生 widget 可能没有 inputEl，
        //    这正是「复制按钮没出现」的根因）。inputEl 只作回退。
        let row = (w._xh_cp_row && w._xh_cp_row.isConnected) ? w._xh_cp_row : null;
        if (!row) {
            try { row = w.inputEl?.closest?.(".lg-node-widget") || null; } catch (e) {}
        }
        if (!row || !row.appendChild) continue;

        const existed = row.querySelector(".__xh_cp_copy1");
        if (existed) {
            existed.title = pack().copyOneTip;     // 语言切换时只更新提示
            continue;
        }

        row.classList.add("__xh_cp_row");
        try {
            const pos = getComputedStyle(row).position;
            if (!pos || pos === "static") row.style.position = "relative";
        } catch (e) {}

        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "__xh_cp_copy1";
        btn.textContent = "复制";
        btn.title = pack().copyOneTip;
        // 方案 B：行内小按钮同源配色（暗底 #262d38 + 1px rgba(255,255,255,.10)），
        // 只保留"行内小号"的尺寸差异（17px / 10px 字），不再自成一套淡紫皮。
        btn.style.cssText =
            "position:absolute;top:1px;right:6px;z-index:6;height:17px;padding:0 6px;" +
            "border-radius:4px;border:1px solid " + BAR_COLORS.BORDER + ";" +
            "background:" + BAR_COLORS.SURFACE + ";color:" + BAR_COLORS.TEXT + ";" +
            "font-size:10px;line-height:1;font-weight:600;cursor:pointer;opacity:0;pointer-events:none;" +
            "transition:opacity .12s,background .12s,border-color .12s;";
        btn.addEventListener("pointerdown", (e) => e.stopPropagation(), true);
        btn.addEventListener("click", async (e) => {
            e.stopPropagation();
            const ok = await copyOnePrompt(w);
            pulseButton(btn, { text: ok ? "✓" : "空", ok });
        });
        row.appendChild(btn);
    }
}

/** 绑定 / 重绑 DOM 监听，并在必要时重上色。
 *  🔴 渲染器切换（Nodes 2.0 ↔ 经典）会把**整个节点 DOM 换掉** ⇒ 旧 observer 跟着旧元素一起失效。
 *     所以这里要检测「根元素是不是换了」，换了就断开旧监听、绑新的、并补一次上色。
 *  只监听 childList（增删节点）；我们改的是 style ⇒ 不会自激死循环。 */
function watchSlotBadges(node) {
    if (typeof MutationObserver === "undefined") return;
    let el = null;
    try {
        el = (node.element && node.element.isConnected) ? node.element
            : document.querySelector(`[data-node-id="${node.id}"]`);
    } catch (e) {}
    if (!el) return;

    // 根元素没换、且已绑定 ⇒ 什么都不用做（每秒轮询走的就是这条快路径）
    if (node._xh_badge_observer && node._xh_badge_watch_el === el) return;

    try { node._xh_badge_observer?.disconnect?.(); } catch (e) {}
    node._xh_badge_observer = null;
    node._xh_badge_watch_el = el;

    const mo = new MutationObserver(() => {
        if (node._xh_badge_timer) return;
        node._xh_badge_timer = setTimeout(() => {
            node._xh_badge_timer = null;
            try { paintSlotBadges(node); } catch (e) {}
        }, 120);
    });
    try {
        mo.observe(el, { childList: true, subtree: true });
        node._xh_badge_observer = mo;
    } catch (e) {}

    // 新 DOM 是全新的、没有样式 ⇒ 立刻补一次
    try { paintSlotBadges(node); } catch (e) {}
}

/** 多时机重刷（DOM 挂载 / Vue 重建都是异步的，越晚越保险）。 */
function scheduleSlotBadges(node) {
    for (const d of [0, 80, 260, 800, 1600, 3000]) {
        setTimeout(() => {
            try { paintSlotBadges(node); } catch (e) {}
            try { watchSlotBadges(node); } catch (e) {}
        }, d);
    }
}

/** 给 num_slots 挂 callback：改完数字**不用点按钮**就当场折叠/展开（纯本地）。 */
function bindSlotAutoApply(node) {
    if (node._xh_cp_slot_bound) return;
    const w = (node.widgets || []).find((x) => x && x.name === "num_slots");
    if (!w) return;
    const orig = w.callback;
    w.callback = function (...args) {
        const r = typeof orig === "function" ? orig.apply(this, args) : undefined;
        try {
            applySlotVisibility(node);
            setTimeout(() => compactNodeSize(node), 30);
        } catch (e) {}
        return r;
    };
    node._xh_cp_slot_bound = true;
}

function readSlotsFromNode(node) {
    let n = NaN;
    for (const w of node.widgets || []) {
        if (w && w.name === "num_slots") { n = Number(w.value); break; }
    }
    if (!Number.isFinite(n)) n = DEFAULT_SLOTS;
    return Math.max(MIN_SLOTS, Math.min(Math.round(n), MAX_SLOTS));
}

// 「✅ 应用框数」按钮已于 2026-10-16 删除：改 num_slots 数字就是实时生效（纯前端折叠），
// 按钮与 bindSlotAutoApply 的 callback 做的是同一套动作，100% 冗余；
// 后端 /xh_chainprompt/set_slots 路由同轮清理（register_routes 已成空函数）。

// ---------------------------------------------------------------- 「📂 文件夹」按钮（2026-10-12，与图片列表一致）
// 选了文件夹 → 节点只记路径（prompt_folder 控件），出图时才读 .txt/.md；画布零负担、不卡。
let _xh_cp_dirinput = null;     // 隐藏的「选择文件夹」输入（webkitdirectory），全局复用一份
let _xh_cp_last_node = null;    // 系统选择器关闭后，知道把路径写回哪个节点

// 路径清洗（★ 2026-10-12，照抄图片列表）：资源管理器/浏览器/Git-Bash 各种粘法都认
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
    if (_xh_cp_dirinput) return _xh_cp_dirinput;
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
        const node = _xh_cp_last_node;
        // 绝对路径：Electron（桌面版）直接挂在 File.path 上；纯浏览器沙箱拿不到 → 提示改用粘贴
        let abs = "", first = null;
        for (const f of files) {
            const pp = f.path || f.__electronPath || "";
            if (pp) { first = f; abs = pp; break; }
        }
        if (!abs) {
            console.warn("[XH-ChainPrompt] 无法读取文件夹绝对路径，请在「文件夹路径」框粘贴路径");
            if (node && node._xh_cp_folder_btn) flashFolderBtn(node._xh_cp_folder_btn, "⚠ 请粘贴路径", false);
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
    _xh_cp_dirinput = inp;
    return inp;
}

// ★ 2026-10-19（晚）预览框填充 —— CSS 轨道方案（无头浏览器真机验证通过）：
//    DOM 结构固定为 pe → wrap(flex列) → row(lg-node-widget) → grid(lg-node-widgets)，
//    grid 的 inline gridTemplateRows 是 `min-content auto min-content`。把最后一行（预览行）
//    改写成 `minmax(0,1fr)` + grid/wrap 给 flex:1 ⇒ 预览行吃掉节点全部剩余高度，
//    节点底不再留白；内容超高时 pe（overflow:auto）内部滚动。幂等，每次 layout 重申一遍，
//    防 Vue 重渲染把 inline 样式洗回去。返回 true=已应用（Vue 路径），false=结构不匹配（legacy 回退）。
function applyCpFillCss(node, pe) {
    try {
        const wrap = pe.parentElement;
        const row = wrap && wrap.parentElement;
        const grid = row && row.parentElement;
        if (!wrap || !row || !grid || !grid.style) return false;
        // 结构校验：必须是 Vue 的 widget 网格（class 含 lg-node-widgets）且预览行是最后一行
        const rowOk = /lg-node-widget/.test(String(row.className || ""));
        const gridOk = /lg-node-widgets/.test(String(grid.className || ""));
        const lastOk = row === grid.lastElementChild;
        const tracks = String(grid.style.gridTemplateRows || "").split(/\s+/).filter(Boolean);
        if (!rowOk || !gridOk || !lastOk || tracks.length !== grid.children.length) return false;
        // 预览可见（文件夹模式且有段）才吃满；否则恢复 min-content，剩余高度让回上面的 auto 文本行
        const visible = pe.style.display !== "none" && !!(node._xh_cp_order || []).length;
        const want = tracks.slice();
        want[want.length - 1] = visible ? "minmax(0,1fr)" : "min-content";
        const gtr = want.join(" ");
        if (grid.style.gridTemplateRows !== gtr) grid.style.gridTemplateRows = gtr;
        if (!visible) return false;
        if (grid.style.flex !== "1 1 0") { grid.style.flex = "1 1 0"; grid.style.minHeight = "0"; }
        if (wrap.style.flex !== "1 1 0") { wrap.style.flex = "1 1 0"; wrap.style.minHeight = "0"; }
        if (pe.style.height !== "100%") { pe.style.height = "100%"; pe.style.maxHeight = "none"; }
        node._xh_cp_fill_css = true;   // ★ 粘性标记：Vue 路径成功过一次就锁定（见调用处的回退门控）
        return true;
    } catch (e) { return false; }
}

function renderCpOrderPreview(node) {
    const el = node && node._xh_cp_order_el;
    if (!el) return;
    const order = (node._xh_cp_order || []);
    if (!order.length) { el.textContent = ""; el.style.display = "none"; return; }
    el.style.display = "block";
    el.innerHTML = "";
    const head = document.createElement("div");
    head.style.cssText = "color:#9aa7b3;margin-bottom:2px;";
    head.textContent = `调用顺序（第1段起）：${order.length} 段`;
    el.appendChild(head);
    order.forEach((nm, k) => {
        const s = document.createElement("div");
        s.style.cssText = "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
        s.textContent = `第${k+1}段  ${nm}`;
        el.appendChild(s);
    });
    // 渲染完立刻应用 CSS 填充（gridTemplateRows 是活样式，改完即生效，无需等下一次拖拽）
    applyCpFillCss(node, el);
}

function flashFolderBtn(btn, text, ok) {
    if (!btn) return;
    const old = pack().folder;
    try { btn.textContent = text; } catch (e) {}
    try { btn.style.filter = ok ? "brightness(1.1)" : "brightness(1.3)"; } catch (e) {}
    setTimeout(() => { try { btn.textContent = old; btn.style.filter = "none"; } catch (e2) {} }, 2500);
}

// 关联文件夹：写路径 + 切 source=文件夹 + 折叠提示词框；优先用后端路由拿段数预览，失败也能用
async function scanFolder(node, dir) {
    const pWidget = (node.widgets || []).find((w) => w && w.name === "prompt_folder");
    const sWidget = (node.widgets || []).find((w) => w && w.name === "source");
    const btn = node._xh_cp_folder_btn;
    dir = cleanPath(dir);
    if (!dir || !pWidget) return;
    try {
        const resp = await api.fetchApi(`/xh/promptlist/list?dir=${encodeURIComponent(dir)}`);
        const j = await resp.json().catch(() => ({}));
        if (j.ok) {
            pWidget.value = dir;
            if (sWidget) sWidget.value = "文件夹";
            applyFolderVisibility(node);
            node._xh_cp_order = j.order || [];   // ★ 存调用顺序供预览
            renderCpOrderPreview(node);
            flashFolderBtn(btn, (pack().folderOk || "✅ 已关联：%d 段").replace("%d", String(j.nonempty)), true);
            return;
        }
        // 路由通但文件夹无效：仍写入 + 切模式（出图时后端再明确报错）
        // ★ 2026-10-20：关联失败也要清掉旧调用顺序，别让上一个文件夹的段列表继续挂着
        pWidget.value = dir;
        if (sWidget) sWidget.value = "文件夹";
        node._xh_cp_order = [];
        applyFolderVisibility(node);
        flashFolderBtn(btn, (pack().folderFail || "⚠ 关联失败：%s").replace("%s", j.error || ("HTTP " + resp.status)), false);
    } catch (e) {
        // 路由不可用（未重启/老服务端）⇒ 仍写路径 + 切模式，出图时后端读
        // ★ 2026-10-20：拿不到段数 ⇒ 调用顺序预览置空（不显示上一个文件夹的顺序）
        pWidget.value = dir;
        if (sWidget) sWidget.value = "文件夹";
        node._xh_cp_order = [];
        applyFolderVisibility(node);
        flashFolderBtn(btn, "✅ 已关联（出图时读取）", true);
    }
}

// 文件夹模式 → 隐藏全部 32 个提示词框；文本框模式 → 按本节点框数还原（applySlotVisibility）
function applyFolderVisibility(node) {
    const sWidget = (node.widgets || []).find((w) => w && w.name === "source");
    const folderMode = sWidget && sWidget.value === "文件夹";
    let anyPrompt = false;
    for (const w of node.widgets || []) {
        if (!w || !isPromptName(w.name)) continue;
        anyPrompt = true;
        if (folderMode) {
            w.hidden = true;
            if (w.element) { try { w.element.style.display = "none"; } catch (e) {} }
        }
    }
    if (!folderMode && anyPrompt) applySlotVisibility(node);
    // ★ 2026-10-20 修用户报的 bug：切回文本框模式，「调用顺序」预览要跟着一起消失
    //   （旧代码只管 32 个提示词框的显隐，_xh_cp_order 旧值原样挂着，预览一直显示旧段列表）
    if (!folderMode) node._xh_cp_order = [];
    try { renderCpOrderPreview(node); } catch (e) {}
    try { node.setDirtyCanvas?.(true, true); node.graph?.setDirtyCanvas?.(true, true); } catch (e) {}
}

function bindSourceAutoApply(node) {
    if (node._xh_cp_source_bound) return;
    const w = (node.widgets || []).find((x) => x && x.name === "source");
    if (!w) return;
    const orig = w.callback;
    w.callback = function (...args) {
        const r = typeof orig === "function" ? orig.apply(this, args) : undefined;
        try { applyFolderVisibility(node); } catch (e) {}
        return r;
    };
    node._xh_cp_source_bound = true;
}

function createFolderBtn(node) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = pack().folder;
    // 方案 B：文件夹是"读目录"这类辅助操作，不是主操作 ⇒ 中性暗底，不用实心蓝。
    // （原来它跟齿轮一样是实心蓝，导致眼睛误以为它是主按钮。）
    paintBarBtn(btn, "neutral");
    btn.onmouseenter = () => { btn.style.filter = "brightness(1.28)"; };
    btn.onmouseleave = () => { btn.style.filter = "none"; };
    btn.addEventListener("pointerdown", (e) => e.stopPropagation(), true);
    btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const pWidget = (node.widgets || []).find((w) => w && w.name === "prompt_folder");
        const raw = (pWidget?.value || "").trim();
        if (!raw) {
            _xh_cp_last_node = node;
            node._xh_cp_folder_btn = btn;
            try { ensureDirInput().click(); } catch (err) {
                console.warn("[XH-ChainPrompt] 无法弹文件夹选择框，请改用粘贴路径", err);
            }
            return;
        }
        scanFolder(node, raw);
    });
    return btn;
}

// ---------------------------------------------------------------- ⚙ 一键收起 / 展开 8 个参数（2026-10-19，复刻「加载视频」的齿轮按钮）
// 为什么要它：2026-10-19 把参数从「提示词框下面」上提到「工具条下面」，8 行参数会占掉一截高度；
//             不喜欢的人点一下 ⚙ 就只剩「工具条 + 提示词框」，需要改参数再展开。
//
// 隐藏机制：给目标控件打官方受支持的 legacy facade `w.hidden` ——
//   前端源码里它就是 suppression.byExtension：既不绘制、也不参与布局算高
//   （getLayoutWidgets / isWidgetRowVisible 都会跳过），**与序列化无关** ⇒ 值照样存、照样参与执行。
//   （与 xh_video_load.js 的 setCollapsed 同套思路）
//
// 状态存在 node.properties —— 不占 widgets_values、不影响存档位序，随工作流走。
// 🔴 必须与后端 INPUT_TYPES 的**声明顺序逐字一致**（2026-10-19 定稿）：
//    ① 数据源 → ② 起跑 → ③ 循环 → ④ 调试
const PARAM_KEYS = [
    "num_slots", "source", "prompt_folder",           // ① 数据源
    "start_index", "start_offset",                    // ② 起跑（两个必须相邻）
    "loop", "follow_loop_turn", "all_segments",       // ③ 循环
    "restart_index",                                  // ④ 调试
];

// 🔴 永久隐藏的参数（2026-10-20，用户提问「起跑偏移输入框还有必要吗」→ 定：藏起来，只留按钮）
//    理由：它和工具条的「▶ 起跑 N」按钮**写的是同一个数值**（按钮选第 N 段 ⇒ 偏移 = N-1），
//    两个入口干一件事 = 用户困惑；而且它平时就在折叠区里看不见，日常唯一入口本来就是按钮。
// ⛔⛔ **widget 本体绝不能删**：它在 widgets_values 里占一个位置，
//    删了 ⇒ 后面所有参数往前挪一格 ⇒ 用户所有老工作流打开就全部错位。
//    只用 w.hidden 隐藏（与序列化无关，值照样存、照样参与执行）。
const ALWAYS_HIDDEN_PARAMS = new Set(["start_offset"]);

/** 把 ALWAYS_HIDDEN_PARAMS 里的控件强制藏起来（齿轮展开时也要藏）。 */
function hideAlwaysHiddenParams(node) {
    for (const name of ALWAYS_HIDDEN_PARAMS) {
        const w = (node.widgets || []).find((x) => x && x.name === name);
        if (!w) continue;
        try {
            w.hidden = true;
            // DOM 兜底：Vue Nodes 下已挂载的元素直接 display:none（与 setParamsCollapsed 同套路）
            if (w.element) w.element.style.display = "none";
        } catch (e) {}
    }
}

// 历史布局用的参数顺序（迁移用，别改）
const LEGACY_KEYS_V1_V2 = [
    "start_index", "restart_index", "loop", "num_slots",
    "follow_loop_turn", "all_segments", "source", "prompt_folder",
];
// 布局版本号：存在 node.properties.xh_cp_layout（随工作流走）
const LAYOUT_VERSION = 4;

/** 当前是否收起（默认收起，除非显式存过 false）。 */
function paramsCollapsed(node) {
    try {
        const p = node.properties || (node.properties = {});
        return p.xh_cp_collapsed !== false;
    } catch (e) {
        return true;
    }
}

/** 收起 / 展开 8 个参数区（纯视觉，值不动）。 */
function setParamsCollapsed(node, collapsed) {
    try {
        const p = node.properties || (node.properties = {});
        p.xh_cp_collapsed = !!collapsed;
    } catch (e) {}
    for (const name of PARAM_KEYS) {
        const w = (node.widgets || []).find((x) => x && x.name === name);
        if (!w) continue;
        try {
            w.hidden = !!collapsed;
            // DOM 兜底：Vue Nodes 下已挂载的元素直接设 display（与 applySlotVisibility 同套路）
            if (w.element) w.element.style.display = collapsed ? "none" : "";
        } catch (e) {}
    }
    // 展开态下仍要藏 ALWAYS_HIDDEN_PARAMS（上面循环刚把它们设成可见，这里盖回去）
    hideAlwaysHiddenParams(node);
    paintGearBtn(node);
    try { node.setDirtyCanvas?.(true, true); } catch (e) {}
    try { node.graph?.setDirtyCanvas?.(true, true); } catch (e) {}
    // 收起后节点变矮 —— 只收不放大，且用户手动拖过尺寸就一律不碰（函数内部自保护）
    setTimeout(() => { try { compactNodeSize(node); } catch (e) {} }, 20);
}

/**
 * 刷新齿轮外观：收起=亮蓝（点开展），展开=绿（点收起），一眼分辨状态。
 * ★ 2026-10-20 齿轮统一：外观全部委托 kit.makeGearBtn 的 _xhGearSet（自带 titleFn），
 *   本文件只负责「当前折叠状态」这一个事实，不再自己写颜色 / 尺寸 / 图标。
 */
function paintGearBtn(node) {
    const btn = node._xh_cp_gear_btn;
    if (!btn) return;
    if (btn._xhGearSet) btn._xhGearSet(paramsCollapsed(node));
    else btn.title = paramsCollapsed(node) ? pack().gearShow : pack().gearHide;
}

function createGearBtn(node) {
    // ★ 家族统一齿轮（kit.makeGearBtn）：粗壮实心图标 + 亮蓝/绿状态色 + 26×22 + 全事件拦截
    const btn = makeGearBtn({
        collapsed: paramsCollapsed(node),
        titleFn: (col) => (col ? pack().gearShow : pack().gearHide),
        onToggle: (col) => setParamsCollapsed(node, col),
    });
    node._xh_cp_gear_btn = btn;
    paintGearBtn(node);
    return btn;
}

// ---------------------------------------------------------------- 🔴 旧档迁移（2026-10-19 布局改动的连坐）
/**
 * 2026-10-19 把参数从「提示词框之后」挪到「之前」 ⇒ widgets_values 的**位置顺序**变了：
 *   · 旧顺序：[0..31] = prompt_0..prompt_31 ，[32..39] = 8 个参数（你现在的老工作流就是这套）
 *   · 新顺序：[0..7]  = 8 个参数         ，[8..39] = prompt_0..prompt_31
 * 不迁就会出现「提示词被塞进起始段」这种整档错位，所以必须迁。
 *
 * 两道保险，按可靠性从高到低：
 *   ① saved.widgets_values_named —— **按名字**回填，与顺序无关（最可靠，「加载视频」节点同款做法）
 *   ② 类型判别：旧格式 widgets_values[0] 一定是**字符串**（第 1 段提示词）；
 *      新格式 widgets_values[0] 一定是**数字**（start_index）⇒ 能一眼认出，按名字重排
 *   ③ 两条都没命中 = 本身就是新格式 ⇒ 什么都不做
 *
 * @returns {boolean} 是否真的发生过迁移
 */
// ---------------------------------------------------------------- 🗑 一键清空（2026-10-19 新增，带**撤销缓冲**）
/**
 * 为什么不是单纯清空：几十段提示词误点一下就没了、且**不可恢复** —— 代价太大。
 * 所以这里做成「清空 = 把内容暂存进回收站」，按钮当场变 ↩（绿），再点一下**全部恢复**。
 *
 * 缓冲存在 `node.properties.xh_cp_trash`（不占 widgets_values）：
 *   · 随工作流存档 ⇒ 清空后**关掉重开仍能撤销**，安全感拉满；
 *   · 撤销后立刻 `delete`，不留垃圾。
 *
 * ⚠️ 清的是**全部 32 个框**（含被「框数」折叠隐藏的） —— 否则折叠区还藏着旧内容，
 *    你以为清干净了，一跑又多出几段。这与「只清当前显示范围」的区别要跟用户说清楚。
 */
/** 框里是否还有任何内容（trim 后非空）。 */
function hasAnyPromptContent(node) {
    const list = (node.widgets || []).filter((w) => w && isPromptName(w.name));
    for (const w of list) {
        if (String(w.value ?? "").trim() !== "") return true;
    }
    return false;
}

/**
 * 「↩ 撤销」当前是否处于**可执行**状态。
 *
 * 🔴 判据 = 有备份 **且 当前所有提示词框都是空的**（两个条件缺一不可）。
 *
 * ⛔⛔ 旧版只判「有没有备份」—— 那是 2026-10-19 埋的真 BUG（双向丢数据）：
 *   用户 4 段 → 点清空（备份存下）→ 重新输入 3 段新提示词 → 再点那颗按钮
 *   ⇒ 旧版走 restore 分支，把**旧内容原样盖掉新内容**，然后 `delete trash`
 *   ⇒ 新内容永久丢失、想找回旧内容也没了，两头都没了。
 *   根因：restore 是**无条件覆盖** `w.value = trash[i]`，完全不看框里现在有什么。
 *
 * ✅ 正解：只要用户在清空之后动过笔（哪怕只填了 1 段），那次撤销的前提就不成立
 *   —— 备份自动失效、按钮当场退回「清」。此后再点 = 清空**当前**内容（新内容进备份），
 *   语义跟"回收站"一致，也不存在任何覆盖风险。
 */
function isUndoArmed(node) {
    if (!node || !node.properties || !Array.isArray(node.properties.xh_cp_trash)) return false;
    return !hasAnyPromptContent(node);
}

function clearAllPrompts(node) {
    const list = (node.widgets || []).filter((w) => w && /^prompt_\d+$/.test(w.name || ""));
    if (!list.length) return 0;
    // 只把「有内容」的框记进缓冲；全空就不制造无意义的 trash 字段
    const hasContent = list.some((w) => (w.value ?? "") !== "");
    if (!hasContent) return 0;

    try {
        const p = node.properties || (node.properties = {});
        p.xh_cp_trash = list.map((w) => (w.value ?? ""));
    } catch (e) {}

    let n = 0;
    for (const w of list) {
        try {
            if ((w.value ?? "") !== "") n++;
            w.value = "";
            if (w.inputEl) {
                try { w.inputEl.value = ""; } catch (e) {}
            }
        } catch (e) {}
    }
    try { node.setDirtyCanvas?.(true, true); } catch (e) {}
    try { node.graph?.setDirtyCanvas?.(true, true); } catch (e) {}
    return n;
}

/** 撤销上一次清空：把回收站内容原样写回各个提示词框。 */
function restoreClearedPrompts(node) {
    let trash = null;
    try {
        const p = node.properties || {};
        trash = p.xh_cp_trash || null;
    } catch (e) {}
    if (!Array.isArray(trash)) return 0;
    const list = (node.widgets || []).filter((w) => w && /^prompt_\d+$/.test(w.name || ""));
    if (!list.length) return 0;
    let n = 0;
    for (const w of list) {
        const i = promptIndexOf(w);
        if (i < 0 || i >= trash.length) continue;
        // 🔴 双保险：绝不覆盖用户后来输入的内容。
        //    isUndoArmed() 已经在按钮层挡住这条路，这里再挡一次 ——
        //    万一将来有人新增了别的调用点，也不会重演"覆盖 + 删备份"的双向丢失。
        if (String(w.value ?? "").trim() !== "") continue;
        try {
            w.value = trash[i] ?? "";
            if (w.inputEl) {
                try { w.inputEl.value = trash[i] ?? ""; } catch (e) {}
            }
            if ((trash[i] ?? "") !== "") n++;
        } catch (e) {}
    }
    try { delete node.properties.xh_cp_trash; } catch (e) {}
    try { node.setDirtyCanvas?.(true, true); } catch (e) {}
    try { node.graph?.setDirtyCanvas?.(true, true); } catch (e) {}
    return n;
}

/** 复制全部非空提示词到剪贴板（先备份再清空，配合 🗑 用）。 */
async function copyAllPrompts(node) {
    const list = (node.widgets || [])
        .filter((w) => w && /^prompt_\d+$/.test(w.name || ""))
        .sort((a, b) => promptIndexOf(a) - promptIndexOf(b));
    const parts = [];
    for (const w of list) {
        const v = (w.value ?? "");
        if (v.trim() === "") continue;
        parts.push(`=== 第 ${promptIndexOf(w) + 1} 段 ===\n${v}`);
    }
    if (!parts.length) return 0;
    const text = parts.join("\n\n");
    try {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
        } else {
            const ta = document.createElement("textarea");
            ta.value = text;
            ta.style.position = "absolute";
            ta.style.left = "-9999px";
            document.body.appendChild(ta);
            ta.select();
            document.execCommand("copy");
            document.body.removeChild(ta);
        }
    } catch (e) {
        console.warn("[XH-ChainPrompt] 复制失败:", e);
        return 0;
    }
    return parts.length;
}

/** 造一颗工具条按钮；外观统一，返回 button。 */
// ★ 2026-10-20 工具条皮肤统一（方案 B）：原私有 makeBarBtn 已删，改用 kit 的
//   makeBarBtn()（暗底 #262d38 + 1px 半透明白描边 + 字重 600）——家族唯一实现。


// ---------------------------------------------------------------- 🔴 家族统一的「强烈反馈」
/**
 * 点按钮**必须**看得见 —— 小按钮 + 深色画布，变化太弱用户根本感知不到
 * （2026-10-19 用户实测原话：「我点下去没有什么反馈，我感受不到」）。
 *
 * 所以一次点击叠 **4 层反馈**：
 *   ① 按钮文字直接变结果（如「已复制 4 段!」）
 *   ② 底色在「常态色 ↔ 结果色」之间闪 3 下
 *   ③ 整颗按钮缩放弹跳一下
 *   ④ 节点标题栏整条染色 0.9s（视线在节点上也能看到）
 *
 * @param btn    按钮元素
 * @param opts.text   临时文字（可不填）
 * @param opts.ok     true=绿（成功）/ false=红（危险）
 * @param opts.color 自定义结果色（优先级最高）
 */
function pulseButton(btn, opts = {}) {
    if (!btn) return;
    const oldText = btn.textContent;
    const oldBg = btn.style.background;
    const oldBorder = btn.style.borderColor;
    const oldTransition = btn.style.transition;
    const color = opts.color || (opts.ok !== false ? "#4BA14B" : "#E53935");

    btn._xh_cp_pulsing = true;
    if (opts.text) btn.textContent = opts.text;

    // ③ 弹跳
    btn.style.transition = "transform .12s ease-out, background .12s, border-color .12s";
    btn.style.transform = "scale(1.35)";
    setTimeout(() => { btn.style.transform = "scale(1)"; }, 150);

    // ② 底色闪 3 下
    let i = 0;
    const t = setInterval(() => {
        i++;
        const show = i % 2 === 1;
        btn.style.background = show ? color : oldBg;
        btn.style.borderColor = show ? color : oldBorder;
        if (i >= 6) {
            clearInterval(t);
            btn.style.background = oldBg;
            btn.style.borderColor = oldBorder;
            btn.style.transition = oldTransition;
            btn.textContent = oldText;      // 🔴 必须恢复文字，否则永久停在「已复制 4 段!」
            btn._xh_cp_pulsing = false;
        }
    }, 140);
}


function createClearBtn(node) {
    const btn = makeBarBtn(pack().clear, pack().clearTip);
    btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        // 🔴 判据含"当前是否为空"，不是只看备份在不在（见 isUndoArmed 注释）
        const armed = isUndoArmed(node);
        if (armed) {
            const n = restoreClearedPrompts(node);
            pulseButton(btn, { text: `已恢复 ${n} 段!`, ok: true });
        }
        else {
            const n = clearAllPrompts(node);
            const ok = n > 0;
            pulseButton(btn, { text: ok ? `已清空 ${n} 段` : "本来空", ok });
        }
        paintClearBtn(node);
    });
    node._xh_cp_clear_btn = btn;
    paintClearBtn(node);
    return btn;
}

function createCopyBtn(node) {
    const btn = makeBarBtn(pack().copy, pack().copyTip);
    btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const n = await copyAllPrompts(node);
        const ok = n > 0;
        pulseButton(btn, { text: ok ? `已复制 ${n} 段!` : "没有内容", ok });
    });
    return btn;
}

/** 刷新 🗑 外观：有待撤销内容 → 绿 ↩；否则 → 常态 🗑。 */
function paintClearBtn(node) {
    const btn = node._xh_cp_clear_btn;
    if (!btn) return;
    if (btn._xh_cp_pulsing) return;          // 闪烁进行中 ⇒ 别抢，等它恢复
    const armed = isUndoArmed(node);
    // 🔴 现在 paintClearBtn 会被 1 秒轮询调用 ⇒ 状态没变就直接返回，别每秒重写一次 DOM。
    //    签名带上文案，语言切换时 label 变了自然会重刷（不用额外手动清标记）。
    const sig = (armed ? pack().undoLabel : pack().clear) + "|" + (armed ? "a" : "n");
    if (btn._xh_cp_clear_sig === sig) return;
    btn._xh_cp_clear_sig = sig;
    btn.textContent = armed ? pack().undoLabel : pack().clear;
    btn.title = armed ? pack().undo : pack().clearTip;
    // 方案 B：淡紫 #EEEDFE 白底 + 0.5px 边框 → 统一暗底 + 1px 描边；有得撤销时用 active 档。
    paintBarBtn(btn, armed ? "active" : "neutral");
}

// ---------------------------------------------------------------- ▶ 起跑段（2026-10-19）
// 解决：循环体里原来「起始段」被忽略，想从第 4 段接着跑只能断线 + 手填数字。
// 现在改成「点按钮选段号」——不碰线、不填数字；选过就以它为准（后端 start_index > 0 时覆盖连线）。
/** 读当前起跑偏移（`start_offset`，0-based：0=第1段）。
 *  🔴 读的是**独立的偏移参数**，不是 start_index —— 这样「起始段」口接了线也不会被覆盖。 */
function startIndexOf(node) {
    const w = (node.widgets || []).find((x) => x && x.name === "start_offset");
    const v = Number(w?.value);
    return Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0;
}

/** 刷新按钮：选过（>0）高亮绿 = 已接管连线；显示 1 时为蓝 = 跟线/默认。 */
function paintStartBtn(node) {
    const btn = node._xh_cp_start_btn;
    if (!btn || btn._xh_cp_pulsing) return;
    const i = startIndexOf(node);
    btn.textContent = pack().startBtn(i + 1);
    btn.title = pack().startTip;
    const active = i > 0;
    // 方案 B：同paintClearBtn—— neutral / active 两档，与全家族同源。
    paintBarBtn(btn, active ? "active" : "neutral");
}

/** 写入起跑偏移（0-based），并让画布/工作流感知到改动。 */
function setStartIndex(node, idx) {
    const w = (node.widgets || []).find((x) => x && x.name === "start_offset");
    if (!w) return false;
    try {
        w.value = Math.max(0, Math.round(idx));
        w.callback?.(w.value);
    } catch (e) {}
    try { node.setDirtyCanvas?.(true, true); } catch (e) {}
    paintStartBtn(node);
    return true;
}

/** 弹出选段面板：点哪段就从哪段起跑。 */
function openStartPicker(node, anchor) {
    document.querySelectorAll(".__xh_cp_picker").forEach((el) => el.remove());

    const n = Math.max(1, Math.min(readSlotsFromNode(node), MAX_SLOTS));
    const cur = startIndexOf(node);

    const panel = document.createElement("div");
    panel.className = "__xh_cp_picker";
    panel.style.cssText =
        "position:fixed;z-index:100001;background:#1b2330;border:1px solid #3a4658;border-radius:10px;" +
        "padding:10px;box-shadow:0 10px 30px rgba(0,0,0,.55);display:grid;" +
        "grid-template-columns:repeat(4,minmax(56px,1fr));gap:6px;max-width:280px;";

    for (let i = 0; i < n; i++) {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = `第${i + 1}段`;
        const active = i === cur;
        b.style.cssText =
            "padding:6px 4px;border-radius:6px;font-size:12px;cursor:pointer;white-space:nowrap;" +
            `border:1px solid ${active ? "#0F6E56" : "#3a4658"};` +
            `background:${active ? "#1d9e75" : "#2a3442"};color:#fff;`;
        b.onmouseenter = () => { if (!active) b.style.background = "#36445a"; };
        b.onmouseleave = () => { if (!active) b.style.background = "#2a3442"; };
        b.addEventListener("click", (ev) => {
            ev.stopPropagation();
            if (setStartIndex(node, i)) pulseButton(anchor, { ok: true });
            panel.remove();
        });
        panel.appendChild(b);
    }

    const r = anchor.getBoundingClientRect();
    panel.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 296)) + "px";
    panel.style.top = Math.round(r.bottom + 6) + "px";
    document.body.appendChild(panel);

    const close = (ev) => {
        if (panel.contains(ev.target)) return;
        panel.remove();
        document.removeEventListener("pointerdown", close, true);
    };
    setTimeout(() => document.addEventListener("pointerdown", close, true), 0);
}

function createStartBtn(node) {
    const btn = makeBarBtn(pack().startBtn(startIndexOf(node) + 1), pack().startTip);
    btn.addEventListener("click", (e) => {
        e.stopPropagation();
        openStartPicker(node, btn);
    });
    node._xh_cp_start_btn = btn;
    paintStartBtn(node);
    return btn;
}

/** 工具条按钮文字跟随中/EN（📂文件夹 / 📋复制 / 清·撤 / ⚙提示）。
 *  pulse 期间不抢 —— 等它自己闪完恢复，否则字会闪到一半被改掉。 */
function refreshBarBtnLabels(node) {
    try {
        const p = pack();
        const fb = node._xh_cp_folder_btn;
        if (fb && !fb._xh_cp_pulsing) fb.textContent = p.folder;
        const cb = node._xh_cp_copy_btn;
        if (cb && !cb._xh_cp_pulsing) {
            cb.textContent = p.copy;
            cb.title = p.copyTip;
        }
        paintGearBtn(node);      // 齿轮的 title（收起/展开提示）
        paintStartBtn(node);     // ▶ 起跑 N（文字随语言）
        paintClearBtn(node);     // 清空/撤销：文字 + 底色 + title 一起刷
    } catch (e) {}
}

function migrateLegacyWidgetsValues(node, saved) {
    if (!node || !Array.isArray(node.widgets) || !saved) return false;
    const paramByName = {};
    const promptByName = {};
    for (const w of node.widgets) {
        if (!w) continue;
        if (PARAM_KEYS.indexOf(w.name) !== -1) paramByName[w.name] = w;
        else if (/^prompt_\d+$/.test(w.name || "")) promptByName[w.name] = w;
    }
    if (!Object.keys(paramByName).length && !Object.keys(promptByName).length) return false;

    const assign = (bag, key, val) => {
        const w = bag[key];
        if (w && val !== undefined) {
            try { w.value = val; return true; } catch (e) {}
        }
        return false;
    };

    // ① 按名字回填（顺序无关，最优解）
    const named = saved.widgets_values_named;
    if (named && typeof named === "object") {
        let hit = 0;
        for (const k of PARAM_KEYS) if (assign(paramByName, k, named[k])) hit++;
        for (let i = 0; i < MAX_SLOTS; i++) {
            if (assign(promptByName, `prompt_${i}`, named[`prompt_${i}`])) hit++;
        }
        if (hit) return true;
    }

    // ② 位置数组迁移
    //    🔴 关键：v3（[8参数,offset,32提示词]）和 v4（新四组顺序）的**类型模式完全一样**，
    //       光看类型认不出来 ⇒ 必须靠 `saved.properties.xh_cp_layout` 版本号区分。
    //    布局史：
    //      v1 [32提示词, 8参数]                长度40  wv[0]=字符串
    //      v2 [8参数, 32提示词]                长度40  wv[0]=数字
    //      v3 [8参数, offset, 32提示词]        长度41  wv[0]=数字 & wv[8]=数字
    //      v4 [数据源3, 起跑2, 循环3, 调试1, 32提示词]  ← 当前
    const wv = saved.widgets_values;
    if (!Array.isArray(wv) || wv.length < 33) return false;

    const layoutVer = Number((saved.properties && saved.properties.xh_cp_layout) || 0);

    // v4：已经是最新布局 —— 前端按位置就赋对了，这里按名字再兜一遍（幂等）
    if (layoutVer === LAYOUT_VERSION) {
        for (let i = 0; i < PARAM_KEYS.length; i++) assign(paramByName, PARAM_KEYS[i], wv[i]);
        for (let i = 0; i < MAX_SLOTS; i++) assign(promptByName, `prompt_${i}`, wv[PARAM_KEYS.length + i]);
        return true;
    }

    // v1：最老（提示词在前、参数在后）
    if (typeof wv[0] !== "number") {
        let moved = false;
        for (let i = 0; i < LEGACY_KEYS_V1_V2.length; i++) {
            if (assign(paramByName, LEGACY_KEYS_V1_V2[i], wv[32 + i])) moved = true;
        }
        for (let i = 0; i < MAX_SLOTS; i++) assign(promptByName, `prompt_${i}`, wv[i]);
        return moved;
    }

    // v3：参数在前 + offset 在第 9 格（wv[8] 是数字，而 prompt_0 一定是字符串）
    if (wv.length >= 41 && typeof wv[8] === "number") {
        let moved = false;
        for (let i = 0; i < LEGACY_KEYS_V1_V2.length; i++) {
            if (assign(paramByName, LEGACY_KEYS_V1_V2[i], wv[i])) moved = true;
        }
        if (assign(paramByName, "start_offset", wv[8])) moved = true;
        for (let i = 0; i < MAX_SLOTS; i++) assign(promptByName, `prompt_${i}`, wv[9 + i]);
        return moved;
    }

    // v2：参数在前、没有 offset
    let moved = false;
    for (let i = 0; i < LEGACY_KEYS_V1_V2.length; i++) {
        if (assign(paramByName, LEGACY_KEYS_V1_V2[i], wv[i])) moved = true;
    }
    for (let i = 0; i < MAX_SLOTS; i++) assign(promptByName, `prompt_${i}`, wv[8 + i]);
    return moved;
}

// ---------------------------------------------------------------- 工具栏（单行横排：中 · 🎨 · 📂 文件夹 · ⚙）
// 按钮由 makeXHToolbar 合成【一个】DOM widget（家族唯一实现，见 web/xh_ui_kit.js），
// 行高再锁 28px。2026-10-19 起：工具条下面直接接 8 个参数（可用 ⚙ 收起），再下面是提示词框（沉底、吸收多余空间）。
function addDomToolbar(node) {
    if (node._xh_cp_toolbar) return;
    if (typeof node.addDOMWidget !== "function") return;

    if (!node._xh_cp_folder_btn) node._xh_cp_folder_btn = createFolderBtn(node);
    if (!node._xh_cp_gear_btn) node._xh_cp_gear_btn = createGearBtn(node);
    if (!node._xh_cp_start_btn) node._xh_cp_start_btn = createStartBtn(node);
    if (!node._xh_cp_copy_btn) node._xh_cp_copy_btn = createCopyBtn(node);
    if (!node._xh_cp_clear_btn) node._xh_cp_clear_btn = createClearBtn(node);

    // 标准工具条（中/EN + 🎨）—— 家族唯一实现，额外挂：
    //   📂 文件夹 · ⚙ 收参数 · ▶ 起跑段 · 📋 复制 · 🗑 清空
    //   ⚠️ 顺序刻意把**破坏性最强**的「清空」放最右，减少误点。
    // ★ 2026-10-20 齿轮统一：**⚙ 排工具条最左**（prependNodes），家族 4 个齿轮节点一致
    const { bar, widget } = makeXHToolbar(node, {
        widgetName: "xh_cp_toolbar",
        prependNodes: [
            node._xh_cp_gear_btn,
        ],
        appendNodes: [
            node._xh_cp_folder_btn,
            node._xh_cp_start_btn,
            node._xh_cp_copy_btn,
            node._xh_cp_clear_btn,
        ],
    });
    // 锁定工具栏行高（28px，与 kit 一致）：
    // 🔴 2026-10-14 修正 —— 之前写 `{minHeight:30,maxHeight:30}` 只在**画布模式**有效；
    //    Vue Nodes 的行高只看 `hasLayoutSize = !!computeLayoutSize`，DOM widget 基类自带它，
    //    照旧是 auto 行 → 吃空白。必须连 computeLayoutSize 一起撤（见 lockDomWidgetHeight）。
    lockDomWidgetHeight(widget, 28);

    // ★ 2026-10-19 调用顺序预览：文件夹模式下节点实际出图顺序，与资源管理器对照核对
    // ★ 2026-10-19（晚）第二版 —— 无头浏览器真机实锤：Vue 前端 widget 网格的行轨道是
    //    `min-content auto min-content`，预览行 = min-content = 内容自身高度，
    //    「返回像素值」对 Vue 行高**完全无效**（getMinHeight 只喂 computeSize，不喂网格），
    //    拖大节点多出的高度全灌进 auto 行和底部 ⇒ 用户看到的「框列满、节点底留大空白」。
    //    ✅ 真解法：把最后一行轨道改写成 `minmax(0,1fr)` —— 预览行吃掉节点全部剩余高度，
    //    内容超出就框内滚动。已在真机验证：800→538 / 1000→718 / 420→196 且 scrollable，
    //    且 Vue 不会改写我们写的 inline gridTemplateRows。computeSize 返回固定估值兜底
    //    （legacy 画布模式走旧公式，见 applyCpFillCss 失败分支）。
    if (!node._xh_cp_order_el) {
        const pe = document.createElement("div");
        pe.style.cssText =
            "font-size:10px;line-height:1.35;color:#bcd;background:rgba(58,123,213,.08);" +
            "border:1px solid rgba(120,170,255,.25);border-radius:4px;padding:3px 6px;" +
            "box-sizing:border-box;overflow:auto;white-space:normal;";
        node._xh_cp_order_el = pe;
        const pw = node.addDOMWidget("xh_cp_order", "custom", pe, { serialize: false });
        try { pw.serializeValue = () => undefined; } catch (e) {}
        lockDomWidgetHeight(pw, () => {
            // CSS 方案：预览行 = minmax(0,1fr) 吃满剩余高度；这里返回值只是 computeSize
            // 兜底估值（固定常量、不依赖 node.size ⇒ 无循环引用，compactNodeSize 照常工作）。
            // 🔴 _xh_cp_fill_css 粘性门控：Vue 重排的瞬间结构校验会短暂失配（子节点瞬变），
            //    若放行走 legacy 会算出一个旧公式像素盖回去（真机抓到 662px 残留）——
            //    只要 Vue 路径成功过一次，就永远不再走 legacy。
            if (applyCpFillCss(node, pe) || node._xh_cp_fill_css) return 150;
            // legacy 画布模式回退：旧公式（Vue 下不会走到）
            if (!node._xh_cp_user_resized) {
                try {
                    if (pe.style.maxHeight !== "120px") { pe.style.maxHeight = "120px"; pe.style.height = ""; }
                } catch (e) {}
                return 120;
            }
            let used = 0;
            for (const w of node.widgets || []) {
                if (!w || w === pw || w.hidden) continue;
                let h = 20;
                try { if (typeof w.computeSize === "function") h = (w.computeSize() || [])[1] || 20; } catch (e) {}
                used += h + 4; // +4 = 控件间距估算
            }
            let h = 120;
            try {
                if (isSizeLike(node.size)) {
                    const TITLE = (typeof LiteGraph !== "undefined" && LiteGraph.NODE_TITLE_HEIGHT) || 30;
                    h = Math.max(60, Math.round(node.size[1] - TITLE - used - 14));
                }
            } catch (e) {}
            try {
                const px = h + "px";
                if (pe.style.height !== px) { pe.style.height = px; pe.style.maxHeight = px; }
            } catch (e) {}
            return h;
        });
        renderCpOrderPreview(node);
    }

    node._xh_cp_toolbar = bar;

    // 恢复 / 应用参数折叠状态（默认收起；存在 node.properties，不占 widgets_values）
    try { setParamsCollapsed(node, paramsCollapsed(node)); } catch (e) {}
}

/** 把节点高度收缩到内容实际高度（消掉底部大空白；只收缩不放大）。
 *  🔴 2026-10-01 修复（用户反馈：改框数会把手动拖大的节点缩回原形）：
 *     ① **一旦用户手动拖拽过尺寸（onResize 且非本程序触发），就永久不再自动动它** —— 尺寸归用户；
 *     ② **只改高度，绝不碰宽度**；
 *     ③ 打开工作流（onConfigure）**根本不调用本函数**，一律尊重存档里的尺寸。 */
function compactNodeSize(node) {
    if (!node || node._xh_cp_user_resized) return; // 用户调过 → 一个像素都不动
    const fix = () => {
        try {
            if (node._xh_cp_user_resized) return;
            const cs = node.computeSize ? node.computeSize() : null;
            if (cs && isSizeLike(node.size) && node.size[1] > cs[1]) {
                node._xh_cp_auto_sizing = true;   // 上锁：本次改尺寸不是用户干的，别被 onResize 误判
                node.size[1] = cs[1];             // 只压高度；宽度原样保留
                node._xh_cp_auto_sizing = false;
                node.setDirtyCanvas?.(true, true);
                node.graph?.setDirtyCanvas?.(true, true);
            }
        } catch (e) {}
    };
    fix();
    setTimeout(fix, 200); // DOM 挂载 / 布局稳定后再收一次
}

// ---------------------------------------------------------------- 「🎨 节点颜色」按钮
// 自建的 addDomColorBtn / createColorBtn 已于 2026-10-05 移除 —— 用 xh_ui_kit 的 makeColorBtn（makeXHToolbar 内含）。


// ---------------------------------------------------------------- INT widget 非法值兜底
// start_index / restart_index / num_slots 被用户清空后 value 会变成 ""/NaN，
// 提交时前端弹「无法转换为 INT」。序列化 / 载入前统一钳回合法值（2026-09-30 用户踩到）。
const INT_PARAM_NAMES = new Set(["start_index", "restart_index", "num_slots"]);

function sanitizeIntWidgets(node) {
    for (const w of node.widgets || []) {
        if (!w || !INT_PARAM_NAMES.has(w.name)) continue;
        const raw = typeof w.value === "string" ? w.value.trim() : w.value;
        const n = Number(raw);
        if (typeof raw !== "number" && (raw === "" || !Number.isFinite(n))) {
            // 空串 / 非法值 → 钳回默认（num_slots 用固定的 DEFAULT_SLOTS，绝不能回退到"数现有框数=32"）
            w.value = w.name === "num_slots" ? DEFAULT_SLOTS : 0;
            if (w.inputEl) w.inputEl.value = w.value;
        } else if (typeof w.value === "string") {
            // 合法数字但存成了字符串（如 "2"）→ 转回数字，避免类型校验不一致
            w.value = Math.round(n);
            if (w.inputEl) w.inputEl.value = w.value;
        }
    }
}

// ================================================================ 🔁XH-提示词联结(动态) 2026-10-13
// 效果：把「提示词2」接上线 → 立刻蹦出「提示词3」空口；再接再蹦（上限 12）。
//       末尾多余空口自动收回（常驻前 2 口）。后端 optional 已预定义 prompt_2..prompt_11，
//       前端 addInput 的名字与后端 key 逐字一致 ⇒ 提交/校验不会炸。

function isJoinNode(type) {
    return typeof type === "string" && normalizeType(type) === NODE_TYPE2;
}

function isJoinPromptName(name) {
    return typeof name === "string" && /^prompt_\d+$/.test(name);
}

/** 收集本节点的 prompt 输入口 [{inp, idx}]（idx = node.inputs 里的真实下标）。 */
function joinPromptPorts(node) {
    const out = [];
    for (let i = 0; i < (node.inputs || []).length; i++) {
        const inp = node.inputs[i];
        if (inp && isJoinPromptName(inp.name)) out.push({ inp, idx: i });
    }
    return out;
}

/** 端口名 → 序号（prompt_3 → 3）。 */
function joinPortIndex(name) {
    return Number(String(name).replace(/\D/g, ""));
}

// Join 的 slots 本地化表（prompt_0..prompt_11 → 提示词1..提示词12），按需生成
function joinSlotsDict() {
    const p = pack();
    const d = {};
    for (let i = 0; i < JOIN_MAX_INPUTS; i++) d[`prompt_${i}`] = p.joinLabel(i + 1);
    d.delimiter = p.joinDelimiter;
    return d;
}

/** Join 节点语言应用：标题 + 端口 label（只改 label，绝不改 name）+ 状态条文案。 */
function applyLangToJoinNode(node) {
    if (!node || !isJoinNode(node.type)) return;
    const p = pack();
    try {
        const zhName = XH_I18N.zh.nodes.XH_DynamicPromptJoin;
        const enName = XH_I18N.en.nodes.XH_DynamicPromptJoin;
        if (!node.title || node.title === zhName || node.title === enName) {
            node.title = p.nodes.XH_DynamicPromptJoin;
        }
        const dict = joinSlotsDict();
        applySlotLabels(node, dict);
        // 间隔符 widget label
        for (const w of node.widgets || []) {
            if (w && w.name === "delimiter") w.label = p.joinDelimiter;
        }
        // 状态条（常驻预览条，文案随语言刷新 —— 每帧重绘类文本的死角规矩，见 skill §7.2）
        if (node._xh_join_status) {
            const wired = joinPromptPorts(node).filter((t) => t.inp.link != null).length;
            node._xh_join_status.textContent = p.joinStatus(wired);
        }
    } catch (e) {
        console.warn("[XH-Join] 应用语言失败:", e);
    }
}

/** 🔴 核心动态逻辑：对齐输入口（增长 / 收缩）。幂等，随便重复调用。
 *  增长：所有口都接上线且未到上限 → 追加下一个空口（蹦出提示）。
 *  收缩：末尾连续空口 > 1 → 收回到只留 1 个空口（且常驻前 2 口）。
 *  只在 link==null 的口上 remove ⇒ 不会拉断任何连线、不会触发断线事件死循环。 */
function syncJoinInputs(node) {
    if (!node || !isJoinNode(node.type)) return;
    let changed = false;
    try {
        let ports = joinPromptPorts(node);
        // ---- 收缩：末尾连续空口只留一个 ----
        let trailingEmpty = 0;
        for (let k = ports.length - 1; k >= 0; k--) {
            if (ports[k].inp.link == null) trailingEmpty++;
            else break;
        }
        while (trailingEmpty > 1 && ports.length > JOIN_KEEP_INPUTS) {
            const last = ports[ports.length - 1];
            if (last.inp.link != null) break;         // 保险：绝不删有线口
            node.removeInput(last.idx);
            ports.pop();
            trailingEmpty--;
            changed = true;
        }
        // ---- 增长：全接满 → 蹦出下一个空口 ----
        const allWired = ports.length > 0 && ports.every((t) => t.inp.link != null);
        if (allWired && ports.length < JOIN_MAX_INPUTS) {
            const nextIdx = ports.length;             // 现有 prompt 口数 = 下一个口序号（0 起）
            const name = `prompt_${nextIdx}`;
            const inp = node.addInput(name, "STRING");
            if (inp) inp.label = joinSlotsDict()[name] || name;
            ports.push({ inp, idx: nextIdx });
            changed = true;
        }
    } catch (e) {
        console.warn("[XH-Join] 动态口同步失败:", e);
    }
    if (changed) {
        try {
            const p = pack();
            if (node._xh_join_status) {
                const wired = joinPromptPorts(node).filter((t) => t.inp.link != null).length;
                node._xh_join_status.textContent = p.joinStatus(wired);
            }
            node.setDirtyCanvas?.(true, true);
            node.graph?.setDirtyCanvas?.(true, true);
        } catch (e) {}
    }
}

/** Join 工具条：家族标准 makeXHToolbar（中/EN + 🎨），行高锁 30px。 */
function addJoinToolbar(node) {
    if (node._xh_join_toolbar) return;
    if (typeof node.addDOMWidget !== "function") return;
    const { bar, widget } = makeXHToolbar(node, { widgetName: "xh_join_toolbar" });
    // 行高锁 28px（画布 + Vue 双模式；见 lockDomWidgetHeight 注释）
    lockDomWidgetHeight(widget, 28);
    node._xh_join_toolbar = bar;
}

/** 常驻状态条：显示当前已接几路（照 xh_resolution 预览条惯例，含 onConfigure 重刷）。 */
function addJoinStatusLine(node) {
    if (node._xh_join_status) return;
    if (typeof node.addDOMWidget !== "function") return;
    const el = document.createElement("div");
    el.style.cssText = `
        font-size: 11px; line-height: 16px; color: #9ae6a4;
        background: rgba(39,174,96,0.10); border-radius: 4px;
        padding: 2px 8px; margin: 0; user-select: none; pointer-events: none;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    `;
    const widget = node.addDOMWidget("xh_join_status", "custom", el, { serialize: false });
    try { widget.serializeValue = () => undefined; } catch (e) {}
    node._xh_join_status = el;
    // 🔴 2026-10-13 修复（用户反馈：状态条随节点拖高被撑成一大片空绿条）：
    //    状态条没写 computeSize，基类自带 computeLayoutSize（读 getMinHeight）→ 布局引擎把它当「可生长」，
    //    节点被拖高后的多余竖向空间全灌进状态条。显式钉死固定高度，不再吸空间；
    //    🔴 2026-10-14 补：只写 computeSize 对 **Vue Nodes 无效**（行仍按 hasLayoutSize 判成 auto）⇒
    //    必须连 computeLayoutSize 一起撤（lockDomWidgetHeight 内部已做）。
    //    并紧贴工具条（功能键）下方（index 1），满足「跟功能键贴合」的需求。
    lockDomWidgetHeight(widget, 20);
    try {
        const i = node.widgets.indexOf(widget);
        if (i > 1) { node.widgets.splice(i, 1); node.widgets.splice(1, 0, widget); }
    } catch (e) {}
    const p = pack();
    const wired = joinPromptPorts(node).filter((t) => t.inp.link != null).length;
    el.textContent = p.joinStatus(wired);
}

/** 给 Join 节点上全部 patch（onNodeCreated / onConnectionsChange / onConfigure / onRemoved）。 */
function patchJoinNodeType(nodeType) {
    if (nodeType.prototype.__xh_join_patched) return;
    nodeType.prototype.__xh_join_patched = true;

    const origOnCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
        const r = origOnCreated ? origOnCreated.apply(this, arguments) : undefined;
        try {
            applyLangToJoinNode(this);
            addJoinToolbar(this);
            addJoinStatusLine(this);
            syncJoinInputs(this);       // 新节点：补 label + 首次对齐
        } catch (e) {
            console.warn("[XH-Join] onNodeCreated 失败:", e);
        }
        return r;
    };

    // 🔴 连线事件：连接 / 断开都全量对齐一次（幂等）。LiteGraph 先改数据再回调，
    //    所以这里读到的 input.link 已经是最新状态。
    const origOnConn = nodeType.prototype.onConnectionsChange;
    nodeType.prototype.onConnectionsChange = function (type, slot, isConnect, linkInfo) {
        const r = origOnConn ? origOnConn.apply(this, arguments) : undefined;
        try {
            if (type === 1) syncJoinInputs(this);   // 1 = INPUT 事件
        } catch (e) {}
        return r;
    };

    const origOnConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
        const r = origOnConfigure ? origOnConfigure.apply(this, arguments) : undefined;
        try {
            // 存档恢复：动态口的数量随存档 inputs 走，这里只补 label + 对齐 + 语言
            applyLangToJoinNode(this);
            addJoinToolbar(this);
            addJoinStatusLine(this);
            syncJoinInputs(this);
        } catch (e) {}
        return r;
    };

    const origOnRemoved = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function () {
        try { releaseButtons(this); } catch (e) {}
        return origOnRemoved ? origOnRemoved.apply(this, arguments) : undefined;
    };
}

// ---------------------------------------------------------------- 注册
app.registerExtension({
    name: "XH.ChainPrompt",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        // 2026-10-13：动态联结节点走独立 patch（逻辑互不掺和）
        if (nodeData.name === NODE_TYPE2) {
            patchJoinNodeType(nodeType);
            return;
        }
        if (nodeData.name !== NODE_TYPE) return;
        // 防止同一 class 被重复包裹（registerNodes 会重建 class，新 class 上标记不存在，正好重新包一次）
        if (nodeType.prototype.__xh_cp_patched) return;
        nodeType.prototype.__xh_cp_patched = true;

        const origOnCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = origOnCreated ? origOnCreated.apply(this, arguments) : undefined;
            try {
                // 🔴 2026-10-16：折叠前先记下构造期写进 node.size 的虚高值（实测 1994）。
                //    前端在 LiteGraph.createNode 里就按全部 32 个 prompt 框算好尺寸，
                //    我们的折叠在它之后才跑 ⇒ node.size 不缩 + 网格把 1600px 全灌进 prompt_0。
                const spawnH = isSizeLike(this.size) ? this.size[1] : null;
                // 打布局版本号：新节点直接是新布局，以后读档靠它决定要不要迁移
                try {
                    this.properties = this.properties || {};
                    this.properties.xh_cp_layout = LAYOUT_VERSION;
                } catch (e) {}
                applyLangToNode(this);
                addDomToolbar(this);
                bindSlotAutoApply(this);
                bindSourceAutoApply(this);
                applySlotVisibility(this);   // 按本节点存的「框数」折叠/展开（纯本地）
                applyFolderVisibility(this); // 文件夹模式 → 隐藏 32 个提示词框
                // 🔴 2026-10-13 初始紧凑宽度：默认宽度被超长中文 widget 标签撑到 ~370px 太宽。
                //    只对**新建**节点压一次（用户拖过 / 存档恢复走 onConfigure，一概不碰）。
                if (isSizeLike(this.size) && this.size[0] > 330) {
                    this.size[0] = 330;
                }
                compactNodeSize(this);       // 新节点收紧一次；用户一旦手动拖过尺寸，之后再不自动动它
                // 🔴 2026-10-16 强制收缩（用户复测没修好再次点名）：构造期虚高 + ur 误触发
                //    让上面的 compactNodeSize 永久罢工，这里带 spawnH 护栏直接钉回内容高度。
                forceCompactOnSpawn(this, {
                    maxExcess: 400,
                    spawnSize: spawnH,
                    lockKeys: ["_xh_cp_auto_sizing"],
                    userKeys: ["_xh_cp_user_resized"],
                });
                // 段号彩色徽章：DOM 异步挂载，多时机重刷
                try { scheduleSlotBadges(this); } catch (e) {}
            } catch (e) {
                console.warn("[XH-ChainPrompt] onNodeCreated 失败:", e);
            }
            return r;
        };

        const origOnConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            const r = origOnConfigure ? origOnConfigure.apply(this, arguments) : undefined;
            try {
                // 🔴 2026-10-19：旧档（参数排在 32 个 prompt 之后）迁移到新顺序。
                //    必须跑在所有「按名字取值」的逻辑之前，否则后续读到的全是错位的值。
                try {
                    const _saved = arguments[0];
                    migrateLegacyWidgetsValues(this, _saved);
                    // 迁移完打上版本号（旧档下次打开就不用再迁）
                    try {
                        this.properties = this.properties || {};
                        this.properties.xh_cp_layout = LAYOUT_VERSION;
                    } catch (e) {}
                    // 🔴 双保险：前端「把 widgets_values 回填到控件」的时机各版本不统一，
                    //    有的在 onConfigure 之前、有的在之后。延迟再迁一次即可覆盖两种情况；
                    //    按名字赋值 ⇒ 幂等，重复执行无害。
                    setTimeout(() => {
                        try {
                            migrateLegacyWidgetsValues(this, _saved);
                            sanitizeIntWidgets(this);
                        } catch (e) {}
                    }, 60);
                } catch (e) {}
                sanitizeIntWidgets(this);
                applyLangToNode(this);
                addDomToolbar(this);
                bindSlotAutoApply(this);
                bindSourceAutoApply(this);
                const savedH = isSizeLike(this.size) ? this.size[1] : 0;
                applySlotVisibility(this);   // 打开工作流时按存下来的「框数」折叠
                applyFolderVisibility(this); // 文件夹模式 → 隐藏 32 个提示词框
                // 🔴 2026-10-13 修复：旧版 flex 撑爆 bug 会把节点尺寸写大并存入工作流，
                //    重开时若仍「尊重存档尺寸」就会一直保持巨高。判定：
                //    · 存档高度远超内容高度（> +150px）⇒ 几乎肯定是 bug 留下的 inflated 尺寸，重开即收回内容高度；
                //    · 用户在 +150px 以内手动拖大的仍保留（不动）；+40~+150 也视为用户意图保留。
                try {
                    const cs = this.computeSize ? this.computeSize() : null;
                    if (cs && savedH > cs[1] + 150) this._xh_cp_user_resized = false;
                    else if (cs && savedH > cs[1] + 40) this._xh_cp_user_resized = true;
                } catch (e2) {}
                // 收回到内容高度（仅当未被判定为用户手动拖大时；compactNodeSize 内部自保护）
                try { compactNodeSize(this); } catch (e2) {}
                // 🔴 2026-10-16 强制收缩（读档路径）：构造期就把 size 算成虚高值，Vue 挂载后
                //    可能再次写回 ⇒ compactNodeSize 收一次不够。spawnH 护栏保证只缩
                //    「还等于读档时那个虚高值」的情况，用户存档里合法拖大的尺寸绝不动。
                forceCompactOnSpawn(this, {
                    maxExcess: 400,
                    spawnSize: savedH,
                    lockKeys: ["_xh_cp_auto_sizing"],
                    userKeys: ["_xh_cp_user_resized"],
                });
                // 段号彩色徽章：读档后 label 可能重建，多时机重刷
                try { scheduleSlotBadges(this); } catch (e) {}
            } catch (e) {}
            return r;
        };

        // 🔴 2026-10-01 新增：识别「用户手动拖拽尺寸」。
        //    只要 onResize 不是我们程序自己（_xh_cp_auto_sizing）触发的，就认定用户在调，
        //    从此 compactNodeSize 一律让路 —— 用户拖多大就是多大，改框数不会再缩回去。
        const origOnResize = nodeType.prototype.onResize;
        nodeType.prototype.onResize = function (size) {
            const r = origOnResize ? origOnResize.apply(this, arguments) : undefined;
            try {
                if (!this._xh_cp_auto_sizing) this._xh_cp_user_resized = true;
            } catch (e) {}
            return r;
        };

        // 序列化（保存 / 提交队列）前把非法 INT 值钳回 —— 拦「无法转换为 INT」弹窗
        const origOnSerialize = nodeType.prototype.onSerialize;
        nodeType.prototype.onSerialize = function (o) {
            try { sanitizeIntWidgets(this); } catch (e) {}
            return origOnSerialize ? origOnSerialize.apply(this, arguments) : o;
        };

        const origOnRemoved = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function () {
            try {
                releaseButtons(this);
            } catch (e) {}
            // 徽章的 DOM 监听要断开，否则删节点后还挂着（内存泄漏）
            try {
                this._xh_badge_observer?.disconnect?.();
                this._xh_badge_observer = null;
            } catch (e) {}
            return origOnRemoved ? origOnRemoved.apply(this, arguments) : undefined;
        };
    },

    async nodeCreated(node) {
        if (isJoinNode(node.type)) { try { applyLangToJoinNode(node); } catch (e) {} return; }
        if (!isMyNode(node.type)) return;
        try { applyLangToNode(node); } catch (e) {}
    },

    async loadedGraphNode(node) {
        if (isJoinNode(node.type)) { try { applyLangToJoinNode(node); } catch (e) {} return; }
        if (!isMyNode(node.type)) return;
        try { applyLangToNode(node); } catch (e) {}
    },

    async setup() {
        // 语言变更 + 工作流载入重刷 —— 统一走 kit（等价实现，见 web/xh_ui_kit.js）
        onLangChanged(() => applyLangToAll());
        // 🔴 渲染器切换（Nodes 2.0 ↔ 经典）会重建**全部**节点 DOM：样式没了、observer 也失效。
        //    这里每秒比对一次根元素引用（只是一次引用比较，开销可忽略），换了就重绑 + 重上色。
        setInterval(() => {
            try {
                for (const n of (app.graph ? app.graph._nodes || [] : [])) {
                    if (!isMyNode(n.type)) continue;
                    watchSlotBadges(n);
                    // 🔴 清空按钮的「清 / ↩ 撤」两态取决于**用户有没有重新打字**，
                    //    而打字没有事件可挂（Vue 渲染器连 inputEl 都不保证有）⇒ 走轮询。
                    //    paintClearBtn 内部有签名去重，稳态下不会碰 DOM。
                    try { paintClearBtn(n); } catch (e) {}
                }
            } catch (e) {}
        }, 1000);
    },
});
