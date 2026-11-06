// 🔁XH-工具扩展 · 家族前端（xh_utils 模块）
// 语言桥 / 中·EN 按钮 / 🎨 配色 一律走家族标准套件 xh_ui_kit.js（四之三 4C.2 硬规矩：禁止复制）
// 本文件只做「节点专属文案」+「三处本地化覆盖」（标题 / 参数标签 / 输入输出端口名）
//
// 铁律（与 kit 一致）：
//   · 只改 label / title，绝不改 name（后端按 name 取参数，改了会坏）
//   · 绝不动 COMBO 的 values（values 是存档值，翻中文会让后端认不出）
//   · DOM 工具条 serialize:false 且只 append 不 unshift，绝不顶乱 widgets_values 下标
import {
    ensureLangBridge,
    makeXHToolbar,
    onLangChanged,
    releaseButtons,
    currentLang,
    makeGearBtn,                 // 齿轮一律用家族通用件（用户 2026-10-20「★ 齿轮统一」铁律）
} from "./xh_ui_kit.js";

const { app } = window.comfyAPI.app;                  // 与 kit 同款取法（kit 不 re-export app）
ensureLangBridge();                                   // ① 早于任何 window.XH_LANG 使用

const NODE_TYPES = ["XHMathExpression", "XHNumberConvert", "XHSamplerSelect", "XHSolidMask", "XHVAEDecodeTiled"];

// ── 2026-10-21：🧩XH-智能遮脸 也归本文件管（它在 xh_utils 后端模块里），
//    给它加家族通用 ⚙ 齿轮：把「很少动的高级参数」收起来，面板只剩常用的那几个。
//    收起来的：阈值 / 精修迭代 / 兜底绘制 / 取色参考 / 边距 / 模糊 / 旋转 /
//              四边扩展 / 排除区坐标与颜色
const FACE_NODE = "XHSmartFaceMask";
const FACE_ADV_KEYS = [
    "threshold", "refine_iterations", "fallback_draw", "color_pick_ref",
    "mask_margin", "blur_radius", "rotation",
    "expand_left", "expand_right", "expand_top", "expand_bottom",
    "exclude_cx", "exclude_cy", "exclude_w", "exclude_h", "exclude_color",
];

/**
 * 收起 / 展开 遮脸的高级参数。
 * 用官方「受支持的」legacy facade `widget.hidden`（与 🔁XH-加载视频 同一机制）：
 * 不绘制、不参与布局算高，且与序列化无关（不会挪动 widgets_values 下标）。
 */
function setFaceCollapsed(node, collapsed) {
    if (!node) return;
    node._xhFaceCollapsed = !!collapsed;
    for (const k of FACE_ADV_KEYS) {
        const w = (node.widgets || []).find((x) => x && x.name === k);
        if (!w) continue;
        try { w.hidden = node._xhFaceCollapsed; } catch (e) {}
    }
    try { node.setDirtyCanvas?.(true, true); } catch (e) {}
}

// ---- 节点专属文案（只放本模块这几个节点的 中/EN 对照）----
const XH_I18N = {
    zh: {
        nodes: {
            XHMathExpression: "🔁XH-表达式求值",
            XHNumberConvert: "🔁XH-数值转换",
            XHSamplerSelect: "🔁XH-采样器选择",
            XHSolidMask: "🔁XH-实心遮罩",
            XHVAEDecodeTiled: "🔁XH-平铺VAE解码",
            XHSmartFaceMask: "🧩XH-智能遮脸",
        },
        widgets: {
            expression: "表达式",
            value: "数值",
            width: "宽",
            height: "高",
            sampler_name: "采样器",
            tile_size: "平铺尺寸",
            overlap: "重叠",
            temporal_size: "时间尺寸",
            temporal_overlap: "时间重叠",
        },
        slots: {
            "values.a": "变量 a",
            "values.b": "变量 b",
            "values.c": "变量 c",
            value: "数值",
            samples: "潜空间",
            vae: "VAE",
            FLOAT: "浮点",
            INT: "整数",
            BOOL: "布尔",
            STRING: "字符串",
            MASK: "遮罩",
            SAMPLER: "采样器",
            IMAGE: "图像",
        },
    },
    en: {
        nodes: {
            XHMathExpression: "XH Math Expression",
            XHNumberConvert: "XH Number Convert",
            XHSamplerSelect: "XH Sampler Select",
            XHSolidMask: "XH Solid Mask",
            XHVAEDecodeTiled: "XH Tiled VAE Decode",
            XHSmartFaceMask: "XH Smart Face Mask",
        },
        widgets: {
            expression: "expression",
            value: "value",
            width: "width",
            height: "height",
            sampler_name: "sampler_name",
            tile_size: "tile_size",
            overlap: "overlap",
            temporal_size: "temporal_size",
            temporal_overlap: "temporal_overlap",
        },
        slots: {
            "values.a": "a",
            "values.b": "b",
            "values.c": "c",
            value: "value",
            samples: "samples",
            vae: "vae",
            FLOAT: "FLOAT",
            INT: "INT",
            BOOL: "BOOL",
            STRING: "STRING",
            MASK: "MASK",
            SAMPLER: "SAMPLER",
            IMAGE: "IMAGE",
        },
    },
};

function t(lang, kind, key) {
    const pack = XH_I18N[lang] || XH_I18N.zh;
    return (pack[kind] && pack[kind][key]) || null;
}

// 🔴 三处覆盖（4B.1）：标题 + 参数标签 + 输入/输出端口名。只改 label/title，绝不动 name。
function applyLang(node, lang) {
    if (!node) return;
    lang = lang || currentLang();
    const key = node.type;
    try {
        // ① 标题：只在还是默认显示名时才重写，保留用户自定义标题
        const zhT = XH_I18N.zh.nodes[key];
        const enT = XH_I18N.en.nodes[key];
        const want = t(lang, "nodes", key);
        if (want && (node.title === zhT || node.title === enT || !node.title)) node.title = want;

        // ② 参数控件标签（只改 label）
        if (node.widgets) {
            for (const w of node.widgets) {
                if (!w || !w.name) continue;
                const lb = t(lang, "widgets", w.name);
                if (lb) w.label = lb;
            }
        }

        // ③ 输入 / 输出端口名（只改 label）
        const applySlots = (arr) => {
            if (!arr) return;
            for (const s of arr) {
                const lb = t(lang, "slots", s && s.name);
                if (lb) s.label = lb;
            }
        };
        applySlots(node.inputs);
        applySlots(node.outputs);

        // Nodes 2.0 端口标签走快照渲染，改完必须显式触发重建（官方 renameWidget 同机制）
        try {
            node.graph?.trigger?.("node:slot-label:changed", { nodeId: String(node.id), slotType: 1 });
            node.graph?.trigger?.("node:slot-label:changed", { nodeId: String(node.id), slotType: 2 });
        } catch (e) {}
        try { node.setDirtyCanvas?.(true, true); } catch (e) {}
    } catch (e) {
        console.warn("[XH Utils] 应用语言失败:", e);
    }
}

function nodesOfType() {
    try {
        return (app.graph?.nodes || app.graph?._nodes || []).filter((n) => NODE_TYPES.includes(n.type));
    } catch (e) { return []; }
}

app.registerExtension({
    name: "XH.Utils",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (!NODE_TYPES.includes(nodeData.name)) return;

        const origOnCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = origOnCreated?.apply(this, arguments);
            try {
                // ⚠️ 遮脸（XHSmartFaceMask）的前端归 xh_image_tools_lang.js 管（它已有色板工具条），
                //    这里绝不能再建工具条，否则会出现**两条工具条**（2026-10-21 实测踩到）。
                makeXHToolbar(this);            // ② 标准工具条（中/EN + 🎨，内部 addDOMWidget + pinTop）
                applyLang(this, currentLang()); // ③ 创建时即按当前语言刷三处
            } catch (e) {
                console.warn("[XH Utils] 工具栏/语言初始化失败:", e);
            }
            return r;
        };

        const origOnRemoved = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function () {
            releaseButtons(this);              // 清理按钮注册表，防内存泄漏
            return origOnRemoved?.apply(this, arguments);
        };
    },

    async setup() {
        // 语言一变（点本节点或别的家族节点）→ 重刷这 5 个节点的三处文案
        onLangChanged(() => {
            const lang = currentLang();
            for (const n of nodesOfType()) applyLang(n, lang);
        });
    },
});
