// =============================================================
//  🔁 XH Set / Get —— 单路 + 多路（前端虚拟节点 · 官方内核 · 与 KJ 互通）
// =============================================================
// 【内核】与 KJNodes 的 SetNode / GetNode 完全同源，官方前端原生支持：
//   · isVirtualNode = true ⇒ 节点自身不进 prompt（官方 graphToPrompt 里直接 continue）
//   · 出图时，任何「下游 ← 虚拟节点输出口」的连接，官方会依次问：
//       ① resolveVirtualOutput(slot) → {node, slot}    （跨子图用）
//       ② getInputLink(slot)         → 上游那条 link   （同图用）
//     于是链路被直接接到真正的源节点上，中间不产生任何 prompt 节点。
//   · ⇒ 本节点**没有 onExecute、没有全局广播表**。旧版的 window.XH_SETGET 那套
//     是结构性失效的（虚拟节点永不执行 ⇒ onExecute 永不触发），已整体废弃。
//
// 【互通】XH-获取 / XH-多路获取 查找配对时**同时认** KJNodes 的 `SetNode`，
//   ⇒「KJ 那边 Set，XH 这边 Get 也能取到」，且一行 KJ 源码都不用改。
//   反向（KJ 的 GetNode 取 XH 的 Set）必须改 KJ 源码，按用户要求不做。
//
// 【四种节点】
//   XHSet       单路设置 —— 1 数据输入 + 1 透传输出，名字写在文本框
//   XHGet       单路获取 —— 1 输出，按名字取
//   XHMultiSet  多路设置 —— N 个输入（每路一个名字），随时 ➕➖
//   XHMultiGet  多路获取 —— N 个输出（每路一个名字），随时 ➕➖
// =============================================================
const { app } = window.comfyAPI.app;
import {
    ensureLangBridge,
    makeXHToolbar,
    onLangChanged,
    releaseButtons,
    lockDomWidgetHeight,
    fixWidgetValuesFromSaved,
    isSizeLike,
 paintBarBtn} from "./xh_ui_kit.js";

ensureLangBridge();

// ---------------- 节点标题（zh / en） ----------------
// ⚠️ 用户要求：**名字精简**。去掉 `XH-` 前缀与 🔁 图标，直接叫「设置 / 获取」；
//   单路节点的标题 = `基础名_名字`（跟 KJ 的 `Set_66` 一模一样），**不带类型后缀**。
const TITLES = {
    XHSet: { zh: "设置", en: "Set" },
    XHGet: { zh: "获取", en: "Get" },
    XHMultiSet: { zh: "多路设置", en: "Multi Set" },
    XHMultiGet: { zh: "多路获取", en: "Multi Get" },
};

// 老版本用过的标题（含 🔁XH- 前缀、含类型后缀）—— 用于升级时自动刷新，
// 否则重启后旧节点会一直卡在 `🔁XH-设置 66 (MASK)` 这种老标题上。
const LEGACY_TITLES = {
    XHSet: ["🔁XH-设置", "🔁XH-Set"],
    XHGet: ["🔁XH-获取", "🔁XH-Get"],
    XHMultiSet: ["🔁XH-多路设置", "🔁XH-Multi Set"],
    XHMultiGet: ["🔁XH-多路获取", "🔁XH-Multi Get"],
};

// 标题是不是「系统自动生成的」（而不是用户手动改的）⇒ 是就允许刷新覆盖
function isAutoTitle(node) {
    if (!node.title) return true;
    const t = TITLES[node.type];
    if (!t) return false;
    const cands = [t.zh, t.en, node.type].concat(LEGACY_TITLES[node.type] || []);
    return cands.some((b) => b && node.title.indexOf(b) === 0);
}

const CFG_MULTI = "xh_sg_cfg";     // 多路：隐藏 text widget，存通道名数组 JSON
const CFG_ONE = "xh_sg_name";      // 单路：可见 text widget，存名字
const SG_TOOLBAR = "xh_sg_toolbar";

// 参与「配对」的设置端类型：自家单路 + 自家多路 + KJNodes 单路（互通）
const SETTER_TYPES = ["XHSet", "XHMultiSet", "SetNode"];

function L(zh, en) { return (window.XH_LANG === "en") ? en : zh; }

// =============================================================
//  连线 / 图 工具
// =============================================================
function linkOf(graph, id) {
    if (!graph || id == null) return null;
    const links = graph.links;
    if (!links) return null;
    return links[id] || null;
}

function rootGraphOf(graph) { return graph ? (graph.rootGraph || graph) : null; }

// [本图, 父图, 父父图, … 根图]（不重复）—— Get 沿这条链往上找 Set（词法作用域）
function graphAncestors(graph) {
    if (!graph) return [];
    const root = rootGraphOf(graph);
    const chain = [graph];
    if (!root || graph === root) return chain;
    const seen = new Set(chain);
    let cur = graph, guard = 0;
    while (cur !== root && guard++ < 32) {
        const subs = root._subgraphs || root.subgraphs;
        const pools = [root];
        if (subs && subs.values) for (const sg of subs.values()) pools.push(sg);
        let up = null;
        for (const g of pools) {
            if (!g || !g._nodes || seen.has(g)) continue;
            if ((g._nodes || []).some((n) => n && n.subgraph === cur)) { up = g; break; }
        }
        if (!up) break;
        seen.add(up); chain.push(up); cur = up;
    }
    if (!seen.has(root)) chain.push(root);
    return chain;
}

// =============================================================
//  配对核心：按名字找「设置端」的上游那条线
//  认三种：XHMultiSet（自家多路）· XHSet（自家单路）· SetNode（KJ 单路 · 互通）
//  @return { link, graph, type, setter } —— link = 「上游数据 → 设置端」的连接
// =============================================================
function findSetter(graph, name) {
    if (!graph || !name) return null;
    for (const g of graphAncestors(graph)) {
        if (!g || !g._nodes) continue;
        for (const n of g._nodes) {
            if (!n || SETTER_TYPES.indexOf(n.type) < 0) continue;

            // ① 自家多路设置：按「通道名」命中，取该通道输入口的上游线
            if (n.type === "XHMultiSet") {
                const i = (n.channels || []).indexOf(name);
                if (i < 0) continue;
                const s = (n.inputs || []).find((x) => x && x._chIdx === i);
                if (!s || s.link == null) continue;
                const lk = linkOf(g, s.link);
                if (lk) return { link: lk, graph: g, type: lk.type || s.type, setter: n };
                continue;
            }

            // ② 单路设置（自家 XHSet / KJ SetNode）：名字都在 widgets[0]
            const w = (n.widgets || [])[0];
            if (!w || w.value !== name) continue;
            const s = (n.inputs || [])[0];
            if (!s || s.link == null) continue;
            const lk = linkOf(g, s.link);
            if (lk) return { link: lk, graph: g, type: lk.type || s.type, setter: n };
        }
    }
    return null;
}

// 当前作用域里所有「设置端」名字（单路 + 多路 + KJ），给单路 Get 的右键菜单用
function listSetNames(graph) {
    const out = [], seen = new Set();
    for (const g of graphAncestors(graph)) {
        if (!g || !g._nodes) continue;
        for (const n of g._nodes) {
            if (!n) continue;
            if (n.type === "XHMultiSet") {
                for (const c of (n.channels || [])) {
                    if (c && !seen.has(c)) { seen.add(c); out.push(c); }
                }
            } else if (n.type === "XHSet" || n.type === "SetNode") {
                const v = (n.widgets || [])[0] ? (n.widgets[0].value || "") : "";
                if (v && !seen.has(v)) { seen.add(v); out.push(v); }
            }
        }
    }
    return out.sort();
}

// =============================================================
//  颜色（点 = 框 = 线 三同色；连线取官方类型色，没连 = 官方灰）
//  颜色来源全部运行时取，不硬编码
// =============================================================
function typeColorOf(t) {
    if (!t) return null;
    const tStr = String(t);
    const tLower = tStr.toLowerCase();

    try {
        const css = getComputedStyle(document.documentElement)
            .getPropertyValue("--color-datatype-" + tStr);
        if (css && css.trim()) return css.trim();
    } catch (e) {}

    const cands = [];
    try {
        const c = app.canvas;
        if (c) {
            if (c.default_connection_color_byType) cands.push(c.default_connection_color_byType);
            if (c.constructor && c.constructor.link_type_colors) cands.push(c.constructor.link_type_colors);
            if (c.link_type_colors) cands.push(c.link_type_colors);
        }
    } catch (e) {}
    try { if (typeof LGraphCanvas !== "undefined" && LGraphCanvas.link_type_colors) cands.push(LGraphCanvas.link_type_colors); } catch (e) {}

    for (const tbl of cands) {
        if (!tbl || typeof tbl !== "object") continue;
        const direct = tbl[tStr];
        if (direct && String(direct).trim()) return direct;
        const k = Object.keys(tbl).find((k) => k.toLowerCase() === tLower);
        if (k) { const v = tbl[k]; if (v && String(v).trim()) return v; }
    }
    return null;
}

function idleColor() {
    try {
        const d = app.canvas && app.canvas.default_connection_color;
        if (d && d.input_off) return d.input_off;
    } catch (e) {}
    return "#777777";
}

function linkColorOf(link) {
    if (!link) return null;
    if (link._colour && String(link._colour).trim()) return link._colour;
    if (link.color && String(link.color).trim()) return link.color;
    return typeColorOf(link.type);
}

// 多路节点：按通道给「输入/输出口 + 通道行边框」上色
function applyColors(node) {
    const upd = (list, isInput) => {
        (list || []).forEach((s) => {
            if (!s || s._chIdx == null) return;
            let color = null;
            if (app.graph && app.graph.links) {
                if (isInput && s.link != null) {
                    const link = app.graph.links[s.link];
                    if (link) color = linkColorOf(link);
                } else if (!isInput && Array.isArray(s.links)) {
                    for (const lid of s.links) {
                        const link = lid != null ? app.graph.links[lid] : null;
                        if (link) { color = linkColorOf(link); if (color) break; }
                    }
                }
            }
            const c = color || (s.type && s.type !== "*" ? (typeColorOf(s.type) || idleColor()) : idleColor());
            s.color = c;
            s.color_on = c;
            s.color_off = c;
            const w = node.widgets && node.widgets.find((x) => x && x._isChName && x._chIdx === s._chIdx);
            if (w && w._input) {
                const el = w._input;
                el.style.borderColor = c;
                el.style.borderWidth = "2px";
                el.style.borderStyle = "solid";
                el.style.borderRadius = "4px";
            }
            if (w && w._tag) w._tag.style.color = c;
        });
    };
    upd(node.inputs, true);
    upd(node.outputs, false);
}

// 单路节点：整节点 1 进 1 出，两个口统一用当前类型色（老画布走这里）
function applySingleColors(node) {
    const t = node._realType;
    const c = (t && t !== "*") ? (typeColorOf(t) || idleColor()) : idleColor();
    (node.inputs || []).forEach((s) => { if (s) { s.color = c; s.color_on = c; s.color_off = c; } });
    (node.outputs || []).forEach((s) => { if (s) { s.color = c; s.color_on = c; s.color_off = c; } });
}

// 🔴 新前端（Vue Nodes）**不看** slot.color，只按槽位的 `type` 上色。
//    所以要把「单路设置」两个口的 type/name 都设成真实类型（KJ 就是这么干的），
//    端口点才会跟着连线颜色变（IMAGE 蓝 / MASK 绿…）；断开 ⇒ 复位成通配 `*`。
function applySingleTypes(node) {
    if (node.type !== "XHSet") return;   // XHGet 的输出类型由 syncGetTypes 管
    const t = (node._realType && node._realType !== "*") ? node._realType : "*";
    const fix = (s) => { if (s) { s.type = t; s.name = t; s.label = t; s.localized_name = t; } };
    (node.inputs || []).forEach(fix);
    (node.outputs || []).forEach(fix);
}

// =============================================================
//  单路节点的「类型跟随」
// =============================================================
function setSlotType(slot, t) {
    t = t || "*";
    if (slot.type === t && slot.name === t) return;
    slot.type = t;
    slot.name = t;
    slot.label = t;
    slot.localized_name = t;
}

// Get 侧：输出口的类型跟随对应的 Set 端；单路顺便把口名也改成类型名
function syncGetTypes(node) {
    if (!node || !node.graph) return;
    if (node.type !== "XHGet" && node.type !== "XHMultiGet") return;
    if (node.type === "XHGet") {
        const o = node.outputs && node.outputs[0];
        if (!o) return;
        const f = findSetter(node.graph, node._mid ? node._mid() : "");
        const t = f && f.type ? f.type : "*";
        node._realType = t;
        setSlotType(o, t);
        return;
    }
    (node.outputs || []).forEach((o) => {
        if (!o || o._chIdx == null) return;
        const name = (node.channels || [])[o._chIdx];
        const f = findSetter(node.graph, name);
        const t = f && f.type ? f.type : "*";
        if (o.type !== t) o.type = t;   // 名字保留通道名
    });
}

// =============================================================
//  让全图的「获取端」立刻重算类型/颜色
//  🔴🔴 2026-10-15 真机实测：**类型同步原来只挂在 onDrawBackground 上**
//      ⇒ 节点滚出视野 / 折叠 / 载入时不在视口内（`isVisible === false`）时，
//        多路获取的输出口类型会一直停在 `*`（灰）、颜色不跟随。
//      实测：手动调一次 onDrawBackground() 就恢复 `["IMAGE","IMAGE"]` ⇒ 证明是「没被画到」而不是算错。
//      所以：**Set 侧任何变化（连线/改名/加删通道）都要主动喊一声全图 Get 重算**，不靠画。
// =============================================================
function refreshGets(graph) {
    if (!graph || !graph._nodes) return;
    for (const n of graph._nodes) {
        if (!n) continue;
        if (n.type === "XHGet" || n.type === "XHMultiGet") {
            syncGetTypes(n);
            if (n.type === "XHGet") { applySingleTypes(n); applySingleTitle(n); applySingleColors(n); }
            else applyColors(n);
        }
    }
    app.canvas?.setDirty?.(true, true);
}

// =============================================================
//  单路标题：基础名 + _ + 名称   （如「设置_66」，与 KJ 的 Set_66 一致）
//  —— 标题**只**跟「名称」走，**不带类型后缀**（类型由端口颜色/端口标签表达）。
//     名称空 ⇒ 只显示基础名（「设置」）。
// =============================================================
function applySingleTitle(node) {
    const t = TITLES[node.type];
    if (!t) return;
    const base = L(t.zh, t.en);
    const nm = node._mid ? String(node._mid() || "") : "";
    const want = nm ? base + "_" + nm : base;
    if (isAutoTitle(node)) node.title = want;
}

// =============================================================
//  多路存档（隐藏 text widget 存通道名数组）
// =============================================================
function ensureCfg(node) {
    let w = (node.widgets || []).find((x) => x && x.name === CFG_MULTI);
    if (!w) {
        w = node.addWidget("text", CFG_MULTI, "[]", () => {}, { serialize: true });
        // 🔴🔴 家族铁律（skill《XH家族新增节点》§4）：
        //   ① 绝不设 w.hidden = true —— 那是「把共存的输入端口一起藏没」的元凶；
        //   ② 这个 widget 是**通道名的存档**（多路 Set/Get 的配对钥匙），
        //      所以**绝不能**套 hardenNoSerialize —— 前端 settingStore 的序列化循环是
        //          for (const [idx, i] of widgets.entries())
        //              if (!i.name || i.options.serialize === false) continue;   // ← 整个跳过
        //              t[i.name] = i.serializeValue ? await i.serializeValue(...) : i.value;
        //      一旦 options.serialize=false，通道名永远存不进工作流
        //      ⇒ 重载后 loadCfg 读到默认 "[]" ⇒ 所有通道名/配对准心全丢。
        //   正确做法：只做「视觉隐藏」，serialize 保持 true。
        hideWidgetVisually(w);
    }
    return w;
}
function saveCfg(node) {
    const w = ensureCfg(node);
    w.value = JSON.stringify(node.channels || []);
}
function loadCfg(node) {
    const w = ensureCfg(node);
    try {
        const v = JSON.parse(w.value || "[]");
        if (Array.isArray(v)) return v;
    } catch (e) {}
    return [];
}

// 🔴 本机新前端**不认** options.serialize=false，会照样把控件写进 widgets_values，
//    切换工作流重载时按位置回填 → 整体错位一格。三重堵住（与 xh_ui_kit 同法）。
function hardenNoSerialize(w) {
    try {
        if (!w) return;
        w.serialize = false;
        if (w.options) w.options.serialize = false;
        w.serializeValue = () => undefined;
    } catch (e) {}
}

// 家族标准的「视觉隐藏」：不删 widget、不设 hidden、值照常存档
// （照 xh_image_tools_lang.js 藏原生文本框的那套；skill §4 明令禁止 w.hidden=true）
function hideWidgetVisually(w) {
    try {
        if (!w) return;
        w.computeSize = () => [0, 0];
        w.getMinHeight = () => 0;
        w.computeLayoutSize = undefined;   // Vue 节点：不撤掉这条，该行仍算 auto 行、白吃高度
        w.draw = () => {};
        w.mouse = () => false;
        const el = w.element || w.el;
        if (el && el.style) {
            el.style.display = "none";
            el.style.height = "0px";
            el.style.overflow = "hidden";
        }
    } catch (e) {}
}

// =============================================================
//  多路通道：增删 / 命名 / 显示
// =============================================================
function chTag(i) { return L("通道", "Channel") + "(" + (i + 1) + ")"; }

function isDefaultChannelName(nm) {
    if (!nm) return true;
    return /^通道\s*\d*$/.test(nm) || /^channel\s*\d*$/i.test(nm);
}

function translateDefaultName(name, idx, lang) {
    const zh = String(name || "").match(/^通道\s*(\d+)$/);
    const en = String(name || "").match(/^channel\s*(\d+)$/i);
    if (lang === "en") return zh ? "Channel " + zh[1] : name;
    return en ? "通道" + en[1] : name;
}

// 通道名同步到对应输入/输出口的显示名（编辑框改名 ⇒ 接入点跟着改名）
function syncChannelSlots(node, idx) {
    const nm = node.channels[idx];
    const list = node._kind === "set" ? node.inputs : node.outputs;
    const s = (list || []).find((x) => x && x._chIdx === idx);
    if (s) { s.name = nm; s.label = nm; s.localized_name = nm; }
}

function destroyChannelWidget(w) {
    try {
        if (typeof w.onRemoved === "function") w.onRemoved();
        else if (w.element && w.element.remove) w.element.remove();
    } catch (e) {}
}

function clearChannels(node) {
    if (node.inputs) {
        for (let i = node.inputs.length - 1; i >= 0; i--) {
            if (node.inputs[i] && node.inputs[i]._chIdx != null) node.removeInput(i);
        }
    }
    if (node.outputs) {
        for (let i = node.outputs.length - 1; i >= 0; i--) {
            if (node.outputs[i] && node.outputs[i]._chIdx != null) node.removeOutput(i);
        }
    }
    if (node.widgets) {
        node.widgets = node.widgets.filter((x) => {
            if (x && x._isChName) { destroyChannelWidget(x); return false; }
            return true;
        });
    }
}

function addChannel(node, name) {
    const idx = (node.channels || (node.channels = [])).length;
    if (name == null || name === "") name = L("通道", "Channel") + (idx + 1);
    node.channels.push(name);

    const chName = L("通道", "Channel") + (idx + 1);

    // Set：每个通道一个数据输入口
    if (node._kind === "set") {
        node.addInput(chName, "*");
        // 🔴🔴 2026-10-15 真机实测（铁证）：本机前端 addInput **返回的是「端口对象」**
        //     （typeof 返回 "object"，`node.inputs[返回对象] === undefined`），
        //     不是老 litegraph 的「数字索引」。拿返回值当索引用 ⇒ 永远取到 undefined
        //     ⇒ `_chIdx` 从来没被写上 ⇒ 多路取不到值 / ➖ 删不掉通道 / 改名不跟端口联动。
        //     取「数组末位」两种 API 都对，最稳。
        const s = node.inputs[node.inputs.length - 1];
        if (s) {
            s.name = chName; s.label = chName; s.localized_name = chName;
            s._chIdx = idx;
            s.color = idleColor();
        }
    }
    // Get：每个通道一个输出口
    if (node._kind === "get") {
        node.addOutput(chName, "*");
        const s = node.outputs[node.outputs.length - 1];   // 同上：addOutput 也返回对象
        if (s) {
            s.name = chName; s.label = chName; s.localized_name = chName;
            s._chIdx = idx;
            s.color = idleColor();
        }
    }

    // 通道行 = 真 DOM widget：左标签 + 右输入框（边框 = 连线类型色）
    // ⚠️ 不能用 addWidget("text") —— 那是画布画的假框，没有 element，上不了色
    const row = document.createElement("div");
    row.style.cssText = "display:flex;align-items:center;gap:6px;width:100%;box-sizing:border-box;padding:0 2px;";
    const tag = document.createElement("span");
    tag.textContent = chTag(idx);
    tag.style.cssText = "flex:0 0 auto;font-size:11px;color:" + idleColor() + ";user-select:none;white-space:nowrap;";
    const input = document.createElement("input");
    input.type = "text";
    input.value = name;
    input.placeholder = L("通道名", "channel");
    input.style.cssText = "flex:1 1 auto;min-width:0;background:#1b1b1b;color:#e2e2e2;" +
        "border:2px solid " + idleColor() + ";border-radius:4px;padding:4px 7px;" +
        "font-size:12px;outline:none;box-sizing:border-box;";
    input.oninput = () => {
        node.channels[idx] = input.value;
        syncChannelSlots(node, idx);
        saveCfg(node);
        refreshGets(node.graph);
    };
    ["pointerdown", "mousedown", "dblclick", "keydown", "wheel", "touchstart"].forEach((ev) =>
        input.addEventListener(ev, (e) => e.stopPropagation()));
    row.appendChild(tag);
    row.appendChild(input);

    const w = node.addDOMWidget("xh_sg_row" + idx, "custom", row, {
        serialize: false,
        hideOnZoom: false,
        getMinHeight: () => 28,
        marginY: 0,
    });
    // 通道行是单行输入，必须定高（否则拖高节点时每行都被撑开）
    lockDomWidgetHeight(w, 28);
    hardenNoSerialize(w);
    if (w) {
        w._isChName = true;
        w._chIdx = idx;
        w._tag = tag;
        w._input = input;
    }

    applyColors(node);
    saveCfg(node);
    ensureToolbarLast(node);
}

function removeChannel(node) {
    const idx = (node.channels || []).length - 1;
    if (idx < 0) return;
    node.channels.pop();

    const list = node._kind === "set" ? node.inputs : node.outputs;
    const si = (list || []).findIndex((x) => x && x._chIdx === idx);
    if (si >= 0) {
        if (node._kind === "set") node.removeInput(si);
        else node.removeOutput(si);
    }
    const wi = (node.widgets || []).findIndex((x) => x && x._isChName && x._chIdx === idx);
    if (wi >= 0) {
        const w = node.widgets[wi];
        node.widgets.splice(wi, 1);
        destroyChannelWidget(w);
    }

    applyColors(node);
    saveCfg(node);
    refreshGets(node.graph);
    ensureToolbarLast(node);
}

// =============================================================
//  紧凑工具条（➕ / ➖ + 中/EN + 🎨）
// =============================================================
const ICON_PLUS = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" style="pointer-events:none;"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>`;
const ICON_MINUS = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" style="pointer-events:none;"><line x1="5" y1="12" x2="19" y2="12"></line></svg>`;

function makeIconBtn(svg, color, onClick) {
    const b = document.createElement("button");
    b.type = "button";
    b.innerHTML = svg;
    b.style.cssText =
        "width:28px;" +
        "background:#262d38;color:#d5dde5;border:1px solid rgba(255,255,255,.10);border-radius:4px;" +
        "cursor:pointer;display:flex;align-items:center;justify-content:center;" +
        "padding:0;margin:0;flex:0 0 auto;box-shadow:0 2px 0 rgba(0,0,0,.25);" +
        "pointer-events:auto;user-select:none;" +
        "transition:transform .05s, filter .15s, box-shadow .05s;";
    b.onmouseenter = () => (b.style.filter = "brightness(1.2)");
    b.onmouseleave = () => { b.style.filter = "none"; b.style.transform = "scale(1)"; b.style.boxShadow = "0 2px 0 rgba(0,0,0,.25)"; };
    b.onmousedown = (e) => { e.stopPropagation(); e.preventDefault(); b.style.transform = "scale(.92)"; b.style.boxShadow = "0 0 0 rgba(0,0,0,.25)"; };
    b.onpointerdown = (e) => {
        e.stopPropagation();
        e.preventDefault();
        b.style.transform = "scale(.92)";
        b.style.boxShadow = "0 0 0 rgba(0,0,0,.25)";
        setTimeout(() => {
            b.style.transform = "scale(1)";
            b.style.boxShadow = "0 2px 0 rgba(0,0,0,.25)";
        }, 90);
        onClick();
    };
    b.onpointerup = (e) => { e.stopPropagation(); b.style.transform = "scale(1)"; b.style.boxShadow = "0 2px 0 rgba(0,0,0,.25)"; };
    b.onclick = (e) => { e.stopPropagation(); e.preventDefault(); };
    return b;
}

// multi=true 时带 ➕➖；单路节点不带
function ensureToolbar(node, multi) {
    if (node._toolbar) return;

    const prepend = [];
    if (multi) {
        prepend.push(makeIconBtn(ICON_PLUS, "#2e8b57", () => addChannel(node)));
        prepend.push(makeIconBtn(ICON_MINUS, "#c0303b", () => removeChannel(node)));
        const spacer = document.createElement("span");
        spacer.style.width = "6px";
        prepend.push(spacer);
    }

    const { bar } = makeXHToolbar(node, { mount: false, prependNodes: prepend });

    let widget = null;
    try {
        widget = node.addDOMWidget(SG_TOOLBAR, "custom", bar, {
            serialize: false,
            hideOnZoom: false,
            getMinHeight: () => 26,
            marginY: 0,
        });
    } catch (e) {
        console.warn("[XH-SetGet] 工具条挂载失败:", e);
    }
    lockDomWidgetHeight(widget, 26);
    hardenNoSerialize(widget);

    node._toolbar = widget;
    ensureToolbarLast(node);
}

// 工具条贴底（不被后加的通道框挤到中间）
function ensureToolbarLast(node) {
    if (!node._toolbar || !Array.isArray(node.widgets)) return;
    const i = node.widgets.indexOf(node._toolbar);
    if (i >= 0 && i < node.widgets.length - 1) {
        node.widgets.splice(i, 1);
        node.widgets.push(node._toolbar);
    }
    refreshLayout(node);
}

function refreshLayout(node) {
    try {
        const computed = node.computeSize ? node.computeSize() : null;
        if (computed && isSizeLike(node.size) && node.size[1] > computed[1] + 2) {
            node.size[1] = computed[1];
        }
        node.setDirtyCanvas?.(true, true);
    } catch (e) {}
}

// =============================================================
//  语言刷新
// =============================================================
function applyLang(node) {
    const t = TITLES[node.type];
    const isSingle = (node.type === "XHSet" || node.type === "XHGet");

    if (t && !isSingle) {
        if (isAutoTitle(node)) node.title = L(t.zh, t.en);
    }
    if (isSingle) applySingleTitle(node);

    // 单路的名称框：标签中英切换
    const nameW = (node.widgets || []).find((x) => x && x.name === CFG_ONE);
    if (nameW) nameW.label = L("名称", "name");

    // 多路：通道行标签 / 编辑框 / 占位符全联动
    if (!isSingle) {
        const lang = window.XH_LANG === "en" ? "en" : "zh";
        let dirty = false;
        (node.channels || []).forEach((nm, i) => {
            const nn = translateDefaultName(nm, i, lang);
            if (nn !== nm) { node.channels[i] = nn; dirty = true; }
            syncChannelSlots(node, i);
            const w = node.widgets && node.widgets.find((x) => x && x._isChName && x._chIdx === i);
            if (w) {
                if (w._tag) w._tag.textContent = chTag(i);
                if (w._input) {
                    w._input.value = node.channels[i];
                    w._input.placeholder = L("通道名", "channel");
                }
            }
        });
        if (dirty) saveCfg(node);
    }
}

// =============================================================
//  注册四个虚拟节点
// =============================================================
app.registerExtension({
    name: "XH.SetGet",
    registerCustomNodes() {

        // ---------------------------------------------------------
        //  ① 单路设置
        // ---------------------------------------------------------
        class XHSet extends LGraphNode {
            constructor(title) {
                super(title || L("设置", "Set"));
                this.properties = this.properties || {};
                this.properties["aux_id"] = "XH_SetGet";
                this.isVirtualNode = true;   // 不进 prompt
                this._realType = "*";
            }
            onNodeCreated() {
                if (!this._nameW) {
                    this._nameW = this.addWidget("text", CFG_ONE, "", () => {
                        if (!app.configuringGraph) { applySingleTitle(this); refreshGets(this.graph); }
                    }, { serialize: true });
                }
                this.addInput("*", "*");
                this.addOutput("*", "*");
                ensureToolbar(this, false);
                applyLang(this);
                applySingleColors(this);
            }
            _mid() { return this._nameW ? String(this._nameW.value || "") : ""; }

            // 🔴 skill《XH家族新增节点》§4：切工作流重载时按名字纠偏 widgets_values
            //    （工具条/通道行哪怕残留一格，positional 回填就会整体错位 ⇒ 名称框被灌错值）
            onConfigure(info) {
                try { fixWidgetValuesFromSaved(this, info); } catch (e) {}
                applyLang(this);
                applySingleTypes(this);
                applySingleTitle(this);
                applySingleColors(this);
                refreshGets(this.graph);
                this._lastSig = null;
            }
            onConnectionsChange(slotType) {
                if (app.configuringGraph) return;
                const s = (this.inputs || [])[0];
                const lk = (s && s.link != null) ? linkOf(this.graph, s.link) : null;
                this._realType = lk ? (lk.type || "*") : "*";
                // 自动命名：名字还空着 ⇒ 借用上游输出口名（全图去重，避免和别的设置端撞名）
                if (lk && !this._mid()) {
                    const src = this.graph.getNodeById(lk.origin_id);
                    const nm = src && src.outputs ? (src.outputs[lk.origin_slot] || {}).name : null;
                    if (nm && this._nameW) {
                        this._nameW.value = uniqueSetterName(this.graph, nm, this, null);
                        this._lastSig = null;   // 让帧检下一帧重新比对
                    }
                }
                applySingleTypes(this);   // 端口 type/name 跟随 ⇒ Vue Nodes 端口点按类型上色
                applySingleTitle(this);
                applySingleColors(this);
                refreshGets(this.graph);  // Set 侧一变 ⇒ 全图 Get 立刻重算（不靠画）
            }
            onDrawBackground() {
                // 帧级轻量自检（事件漏触发时兜底）：签名变了才重算
                const s = (this.inputs || [])[0];
                const sig = (s && s.link != null ? s.link : "") + "|" + (s && s.type ? s.type : "") + "|" + this._mid();
                if (sig !== this._lastSig) {
                    this._lastSig = sig;
                    const lk = (s && s.link != null) ? linkOf(this.graph, s.link) : null;
                    const t = lk ? (lk.type || "*") : "*";
                    if (t !== this._realType) this._realType = t;
                    applySingleTypes(this);
                    applySingleTitle(this);
                    applySingleColors(this);
                }
            }
            onRemoved() { releaseButtons(this); }
        }

        // ---------------------------------------------------------
        //  ② 单路获取
        // ---------------------------------------------------------
        class XHGet extends LGraphNode {
            constructor(title) {
                super(title || L("获取", "Get"));
                this.properties = this.properties || {};
                this.properties["aux_id"] = "XH_SetGet";
                this.isVirtualNode = true;   // 不进 prompt
                this._realType = "*";
            }
            onNodeCreated() {
                if (!this._nameW) {
                    this._nameW = this.addWidget("text", CFG_ONE, "", () => {
                        if (!app.configuringGraph) this.onRename();
                    }, { serialize: true });
                }
                this.addOutput("*", "*");
                ensureToolbar(this, false);
                applyLang(this);
                this.onRename();
            }
            _mid() { return this._nameW ? String(this._nameW.value || "") : ""; }

            // 🔴 skill §4：重载时按名字纠偏 widgets_values，再刷新标题/类型
            onConfigure(info) {
                try { fixWidgetValuesFromSaved(this, info); } catch (e) {}
                this.onRename();
                this._lastSig = null;
            }

            // ---- 官方内核接口：同图 ----
            getInputLink(slot) {
                const f = findSetter(this.graph, this._mid());
                return f ? f.link : null;
            }
            // ---- 官方内核接口：跨子图 ----
            resolveVirtualOutput(slot) {
                const f = findSetter(this.graph, this._mid());
                if (!f || f.graph === this.graph) return undefined;   // 同图交给 getInputLink
                const lk = f.link;
                const src = f.graph.getNodeById(lk.origin_id);
                if (!src) return undefined;
                return { node: src, slot: lk.origin_slot };
            }

            onConnectionsChange() {
                if (app.configuringGraph) return;
                this.onRename();
            }
            onDrawBackground() {
                const o = (this.outputs || [])[0];
                const sig = (o && o.type ? o.type : "") + "|" + this._mid();
                if (sig !== this._lastSig) { this._lastSig = sig; this.onRename(); }
            }
            onRename() {
                syncGetTypes(this);
                applySingleTitle(this);
                applySingleColors(this);
                app.canvas?.setDirty?.(true, true);
            }
            getExtraMenuOptions(canvas, options) {
                const names = listSetNames(this.graph).slice(0, 15);
                if (!names.length) return;
                const items = names.map((nm) => ({
                    content: "🔁 " + nm,
                    callback: () => {
                        if (this._nameW) this._nameW.value = nm;
                        this.onRename();
                    },
                }));
                options.unshift.apply(options, items);
            }
            onRemoved() { releaseButtons(this); }
        }

        // ---------------------------------------------------------
        //  ③ 多路设置（N 个输入，每路一个名字）
        // ---------------------------------------------------------
        class XHMultiSet extends LGraphNode {
            constructor(title) {
                super(title || L("多路设置", "Multi Set"));
                this.properties = this.properties || {};
                this.properties["aux_id"] = "XH_SetGet";
                this.isVirtualNode = true;   // 不进 prompt
                this.channels = [];
                this._kind = "set";
            }
            onNodeCreated() {
                ensureCfg(this);
                ensureToolbar(this, true);
                if (!app.configuringGraph) addChannel(this);   // 动态端口：默认 1 通道
                applyLang(this);
                applyColors(this);
            }
            onConfigure(info) {
                // 🔴 skill §4：先按名字纠偏 widgets_values，**再**读通道名存档（顺序反了会读到错位值）
                try { fixWidgetValuesFromSaved(this, info); } catch (e) {}
                const ch = loadCfg(this);
                if (Array.isArray(ch) && ch.length) {
                    clearChannels(this);
                    this.channels = [];
                    ch.forEach((n) => addChannel(this, n));
                }
                applyLang(this);
                applyColors(this);
                refreshGets(this.graph);
            }
            onConnectionsChange(slotType, slot, connected) {
                if (app.configuringGraph) return;
                if (slotType === LiteGraph.INPUT && slot != null) {
                    const s = (this.inputs || [])[slot];
                    if (s && s._chIdx != null) {
                        const lk = (connected && s.link != null) ? linkOf(this.graph, s.link) : null;
                        const t = lk ? (lk.type || "*") : "*";
                        if (s.type !== t) s.type = t;
                        // 自动命名：通道名还是默认名 ⇒ 借用上游输出口名（并去重）
                        if (lk && isDefaultChannelName(this.channels[s._chIdx])) {
                            const src = this.graph.getNodeById(lk.origin_id);
                            const nm = src && src.outputs ? (src.outputs[lk.origin_slot] || {}).name : null;
                            if (nm) {
                                this.channels[s._chIdx] = uniqueSetterName(this.graph, nm, this, s._chIdx);
                                syncChannelSlots(this, s._chIdx);
                                const w = (this.widgets || []).find((x) => x && x._isChName && x._chIdx === s._chIdx);
                                if (w && w._input) w._input.value = this.channels[s._chIdx];
                                saveCfg(this);
                            }
                        }
                        // 🔴 动态端口语义：
                        //   连线 ⇒ 如果是「最后一个」口，末尾自动补一个空口等待连接
                        //   断线 ⇒ 如果是「最后一个空口」，把它收掉（不让空口一直挂着）
                        if (lk) {
                            if (s._chIdx === (this.channels || []).length - 1) addChannel(this);
                        } else {
                            if (s._chIdx === (this.channels || []).length - 1) removeChannel(this);
                        }
                    }
                }
                applyColors(this);
                refreshGets(this.graph);   // 通道口连线/改名 ⇒ 全图 Get 立刻重算
            }
            onDrawBackground() {
                const sig = (this.inputs || []).map((i) => (i ? (i.link ?? "") + ":" + (i.type || "") : "")).join(",")
                    + "|" + (this.channels || []).join("\u0001");
                if (sig !== this._lastSig) { this._lastSig = sig; applyColors(this); }
            }
            onRemoved() { releaseButtons(this); }
        }

        // ---------------------------------------------------------
        //  ④ 多路获取（N 个输出，每路一个名字）
        // ---------------------------------------------------------
        class XHMultiGet extends LGraphNode {
            constructor(title) {
                super(title || L("多路获取", "Multi Get"));
                this.properties = this.properties || {};
                this.properties["aux_id"] = "XH_SetGet";
                this.isVirtualNode = true;   // 不进 prompt
                this.channels = [];
                this._kind = "get";
            }
            onNodeCreated() {
                ensureCfg(this);
                ensureToolbar(this, true);
                if (!app.configuringGraph) addChannel(this);   // 动态端口：默认 1 通道
                applyLang(this);
                syncGetTypes(this);
                applyColors(this);
            }
            onConfigure(info) {
                // 🔴 skill §4：先按名字纠偏 widgets_values，**再**读通道名存档（顺序反了会读到错位值）
                try { fixWidgetValuesFromSaved(this, info); } catch (e) {}
                const ch = loadCfg(this);
                if (Array.isArray(ch) && ch.length) {
                    clearChannels(this);
                    this.channels = [];
                    ch.forEach((n) => addChannel(this, n));
                }
                applyLang(this);
                syncGetTypes(this);
                applyColors(this);
            }
            _chNameOfSlot(slot) {
                const o = (this.outputs || [])[slot];
                if (!o || o._chIdx == null) return null;
                return (this.channels || [])[o._chIdx] || null;
            }

            // ---- 官方内核接口：同图 ----
            getInputLink(slot) {
                const f = findSetter(this.graph, this._chNameOfSlot(slot));
                return f ? f.link : null;
            }
            // ---- 官方内核接口：跨子图 ----
            resolveVirtualOutput(slot) {
                const f = findSetter(this.graph, this._chNameOfSlot(slot));
                if (!f || f.graph === this.graph) return undefined;   // 同图交给 getInputLink
                const lk = f.link;
                const src = f.graph.getNodeById(lk.origin_id);
                if (!src) return undefined;
                return { node: src, slot: lk.origin_slot };
            }

            onConnectionsChange(slotType, slot, connected) {
                if (app.configuringGraph) return;
                if (slotType === LiteGraph.OUTPUT && slot != null) {
                    const o = (this.outputs || [])[slot];
                    if (o && o._chIdx != null) {
                        const linked = Array.isArray(o.links) && o.links.length > 0;
                        // 🔴 动态端口语义：接住「最后一个」输出口的下游 ⇒ 末尾补空口；断空口 ⇒ 收掉
                        if (linked) {
                            if (o._chIdx === (this.channels || []).length - 1) addChannel(this);
                        } else {
                            if (o._chIdx === (this.channels || []).length - 1) removeChannel(this);
                        }
                    }
                }
                syncGetTypes(this);    // 自己连线/断线 ⇒ 输出口类型立刻跟上（不靠画）
                applyColors(this);
            }
            onDrawBackground() {
                const sig = (this.outputs || []).map((o) => (o ? (o.type || "") : "")).join(",")
                    + "|" + (this.channels || []).join("\u0001");
                if (sig !== this._lastSig) {
                    this._lastSig = sig;
                    syncGetTypes(this);
                    applyColors(this);
                }
            }
            getExtraMenuOptions(canvas, options) {
                const names = listSetNames(this.graph);
                if (!names.length) return;
                const items = names.slice(0, 15).map((nm) => ({
                    content: "➕ " + nm,
                    callback: () => {
                        addChannel(this, nm);
                        syncGetTypes(this);
                    },
                }));
                options.unshift.apply(options, items);
            }
            onRemoved() { releaseButtons(this); }
        }

        LiteGraph.registerNodeType("XHSet", XHSet);
        LiteGraph.registerNodeType("XHGet", XHGet);
        LiteGraph.registerNodeType("XHMultiSet", XHMultiSet);
        LiteGraph.registerNodeType("XHMultiGet", XHMultiGet);
    },
});

// 通道自动去重：全家（含 KJ SetNode）已占用的名字一律避开 → _2 / _3 …
// excludeNode / excludeChIdx = 自己那一路（不算占用）
function uniqueSetterName(graph, base, excludeNode, excludeChIdx) {
    if (!graph || !base) return base;
    const used = new Set();
    for (const n of (graph._nodes || [])) {
        if (!n) continue;
        if (n.type === "XHMultiSet") {
            (n.channels || []).forEach((c, i) => {
                if (n === excludeNode && i === excludeChIdx) return;
                if (c) used.add(c);
            });
        } else if (n.type === "XHSet" || n.type === "SetNode") {
            if (n === excludeNode) continue;   // 自己那一路不算占用
            const v = (n.widgets || [])[0] ? (n.widgets[0].value || "") : "";
            if (v) used.add(v);
        }
    }
    if (!used.has(base)) return base;
    let i = 2;
    while (used.has(base + "_" + i)) i++;
    return base + "_" + i;
}

// =============================================================
//  全局语言切换 / 加载完成刷新
// =============================================================
const ALL_TYPES = ["XHSet", "XHGet", "XHMultiSet", "XHMultiGet"];

function refreshAllLang() {
    if (!app.graph) return;
    for (const n of app.graph._nodes || []) {
        if (n && ALL_TYPES.indexOf(n.type) >= 0) {
            try {
                applyLang(n);
                if (n.type === "XHGet" || n.type === "XHMultiGet") syncGetTypes(n);
                if (n.type === "XHSet" || n.type === "XHGet") applySingleColors(n);
                else applyColors(n);
            } catch (e) {
                console.warn("[XH-SetGet] 刷新节点失败:", n.id, e);
            }
        }
    }
    app.graph?.setDirtyCanvas?.(true, true);
}

window.addEventListener("xh:lang-changed", refreshAllLang);
onLangChanged(refreshAllLang, { initialDelay: 300, wrapConfigure: false });
