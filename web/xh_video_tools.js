// 🔁XH-视频工具 · 家族前端（一个 js 管两个节点：合成并保存视频 / 视频拼接）
// ① 中/EN 切换：节点标题 + 参数控件标签 + 输入/输出端口名
// ② 下拉框显示中文，但**存档值仍是英文**（走 options.getOptionLabel，函数不进 JSON）
// ③ 节点自身配色 🎨（XH 家族 12 色 + 自定义取色器）
//
// 铁律：只改 label / title，绝不改 name；绝不改 COMBO 的 values；DOM 工具栏 serialize:false 且只 append。
const { app } = window.comfyAPI.app;

import { ensureLangBridge, makeXHToolbar, onLangChanged, releaseButtons } from "./xh_ui_kit.js";

ensureLangBridge();
const NODE_TYPES = ["XHComposeVideo", "XHConcatVideo"];
const XH_I18N = {
    zh: {
        nodes: {
            XHComposeVideo: "🔁XH-合成并保存视频",
            XHConcatVideo: "🔁XH-视频拼接",
        },
        widgets: {
            images: "图像", fps: "帧率", filename_prefix: "文件名前缀", audio: "音频",
            video_paths: "视频路径列表", reencode: "重新编码",
            audio_path: "音频路径", audio_mode: "音频模式", audio_volume: "音频音量",
        },
        slots: {
            file_path: "文件路径", output_path: "输出路径",
            images: "图像", audio: "音频",
            audio_path: "音频路径", video_paths: "视频路径列表",
        },
        combo: {
            audio_mode: { replace: "替换原音频", mix: "混合进原音频" },
        },
    },
    en: {
        nodes: {
            XHComposeVideo: "XH Compose Video",
            XHConcatVideo: "XH Concat Video",
        },
        widgets: {
            images: "images", fps: "fps", filename_prefix: "filename prefix", audio: "audio",
            video_paths: "video paths", reencode: "reencode",
            audio_path: "audio path", audio_mode: "audio mode", audio_volume: "audio volume",
        },
        slots: {
            file_path: "file path", output_path: "output path",
            images: "images", audio: "audio",
            audio_path: "audio path", video_paths: "video paths",
        },
        combo: {},
    },
};

function t(lang, kind, key) {
    const pack = XH_I18N[lang] || XH_I18N.zh;
    return (pack[kind] && pack[kind][key]) || null;
}

function applyComboValueLabels(node, lang) {
    if (!node || !node.widgets) return;
    const zh = (lang || window.XH_LANG || "zh") === "zh";
    for (const w of node.widgets) {
        if (!w || w.type !== "combo" || !w.options) continue;
        const table = zh ? (XH_I18N.zh.combo || {})[w.name] : null;
        if (table) {
            w.options.getOptionLabel = (v) => (v == null ? "" : (table[String(v)] || String(v)));
        } else {
            delete w.options.getOptionLabel;
        }
    }
    try { node.setDirtyCanvas?.(true, true); } catch (e) {}
}

function applyLang(node, lang) {
    if (!node) return;
    lang = lang || window.XH_LANG || "zh";
    try {
        const want = t(lang, "nodes", node.type);
        const zhT = XH_I18N.zh.nodes[node.type];
        const enT = XH_I18N.en.nodes[node.type];
        if (want && (!node.title || node.title === zhT || node.title === enT)) node.title = want;

        if (node.widgets) {
            for (const w of node.widgets) {
                if (!w || !w.name) continue;
                const lb = t(lang, "widgets", w.name);
                if (lb) w.label = lb;
            }
        }
        applyComboValueLabels(node, lang);

        const applySlots = (arr) => {
            if (!arr) return;
            for (const s of arr) {
                const lb = t(lang, "slots", s && s.name);
                if (lb) s.label = lb;
            }
        };
        applySlots(node.inputs);
        applySlots(node.outputs);

        try {
            node.graph?.trigger?.("node:slot-label:changed", { nodeId: node.id, slotType: 1 });
            node.graph?.trigger?.("node:slot-label:changed", { nodeId: node.id, slotType: 2 });
        } catch (e) {}
        try { node.setDirtyCanvas?.(true, true); } catch (e) {}
    } catch (e) {
        console.warn("[XH VideoTools Lang] 应用语言失败:", e);
    }
}

function nodesOfType() {
    try {
        return (app.graph?.nodes || app.graph?._nodes || []).filter((n) => NODE_TYPES.includes(n.type));
    } catch (e) { return []; }
}
function applyLangToAll() {
    const lang = window.XH_LANG || "zh";
    for (const n of nodesOfType()) applyLang(n, lang);
    try { app.graph?.setDirtyCanvas?.(true, true); } catch (e) {}
}


app.registerExtension({
    name: "XH.VideoTools",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (!NODE_TYPES.includes(nodeData.name)) return;

        const origOnCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = origOnCreated?.apply(this, arguments);
            try {
                // 标准工具条（中/EN + 🎨）—— 家族唯一实现见 web/xh_ui_kit.js
                const { bar, langBtn, colorBtn } = makeXHToolbar(this, { widgetName: "xh_video_bar" });
                this._xhLangBtn = langBtn;

                applyLang(this);
            } catch (e) {
                console.warn("[XH VideoTools] 工具栏创建失败:", e);
            }
            return r;
        };

        const origOnRemoved = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function () {
            releaseButtons(this);
            return origOnRemoved?.apply(this, arguments);
        };
    },

    async setup() {
        // 语言变更 + 工作流载入重刷 —— 统一走 kit（等价实现，见 web/xh_ui_kit.js）
        onLangChanged(() => applyLangToAll());
    },
});
