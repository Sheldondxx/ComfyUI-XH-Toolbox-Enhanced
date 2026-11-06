// 🔒XH-LTX锁脸 · 家族前端（2026-10-01 升级到家族规范）
// ① 语言桥：window.XH_LANG accessor + xh:lang-changed 广播（全家族同步）
// ② 中/EN：节点标题 + 全部参数标签 + 全部输入/输出端口名
// ③ 🎨 家族 12 色 + 自定义取色器（本版新增，之前缺）
//
// 只改 label / title，绝不改 name —— 后端按 name 取参数，改了会坏。
// 工具条走 addDOMWidget({serialize:false}) 且只 append，禁止 unshift（会顶乱 widgets_values 下标）。
const { app } = window.comfyAPI.app;
import { ensureLangBridge, makeXHToolbar, onLangChanged, releaseButtons } from "./xh_ui_kit.js";

ensureLangBridge();

const XH_I18N = {
    zh: {
        nodes: {
            XHLTXIdentityOverlap: "🔒XH-LTX锁脸",
        },
        widgets: {
            model: "模型",
            positive: "正向条件",
            negative: "负向条件",
            vae: "VAE",
            latent: "潜空间",
            reference_image: "参考图",
            source_id: "参考图编号",
            phase_scale: "相位缩放",
            ref_resize_mode: "参考图缩放方式",
            debug_log: "调试日志",
            crop_anchor: "裁切位置",
            layout: "布局方式",
            reference_guidance_scale: "参考引导强度",
            reference_temporal_offset_latents: "参考时间偏移",
        },
        slots: {
            model: "模型",
            positive: "正向",
            negative: "负向",
            vae: "VAE",
            latent: "潜空间",
            reference_image: "参考图",
            debug: "调试",
            ref_preview: "参考图预览",
            crop_overlay: "裁切绿框",
        },
    },
    en: {
        nodes: {
            XHLTXIdentityOverlap: "🔒XH-LTX Identity",
        },
        widgets: {
            model: "model",
            positive: "positive",
            negative: "negative",
            vae: "vae",
            latent: "latent",
            reference_image: "reference_image",
            source_id: "source_id",
            phase_scale: "phase_scale",
            ref_resize_mode: "ref_resize_mode",
            debug_log: "debug_log",
            crop_anchor: "crop_anchor",
            layout: "layout",
            reference_guidance_scale: "reference_guidance_scale",
            reference_temporal_offset_latents: "reference_temporal_offset_latents",
        },
        slots: {
            model: "model",
            positive: "positive",
            negative: "negative",
            vae: "vae",
            latent: "latent",
            reference_image: "reference_image",
            debug: "debug",
            ref_preview: "ref_preview",
            crop_overlay: "crop_overlay",
        },
    },
};

function normalizeType(type) {
    return typeof type === "string" ? type.replace(/^[^\w]+/, "") : type;
}

function isXHNode(type) {
    if (typeof type !== "string") return false;
    return !!XH_I18N.zh.nodes[normalizeType(type)];
}

function applyLangToNode(node) {
    if (!node || !isXHNode(node.type)) return;
    const pack = XH_I18N[window.XH_LANG] || XH_I18N.zh;
    try {
        const t = normalizeType(node.type);
        const name = pack.nodes[t];
        const defaultZhName = XH_I18N.zh.nodes[t];
        const defaultEnName = XH_I18N.en.nodes[t];
        // 只有标题还是默认显示名时才重写，保留用户自定义的标题
        if (name && (node.title === defaultZhName || node.title === defaultEnName || !node.title)) {
            node.title = name;
        }

        // 参数控件标签（只改 label，绝不改 name）
        if (node.widgets) {
            for (const w of node.widgets) {
                if (w && w.name && pack.widgets[w.name]) {
                    w.label = pack.widgets[w.name];
                }
            }
        }

        // 输入 / 输出端口名
        const applySlots = (arr) => {
            for (const s of arr || []) {
                if (s && s.name && pack.slots[s.name]) s.label = pack.slots[s.name];
            }
        };
        applySlots(node.inputs);
        applySlots(node.outputs);

        // Nodes 2.0 的端口标签走「快照」渲染，改完必须显式触发一次重建才看得见
        try {
            node.graph?.trigger?.("node:slot-label:changed", { nodeId: node.id, slotType: 1 });
            node.graph?.trigger?.("node:slot-label:changed", { nodeId: node.id, slotType: 2 });
        } catch (e) {}
        try { node.setDirtyCanvas?.(true, true); } catch (e) {}
    } catch (e) {
        console.warn("[XH LTXIdentity] 应用语言失败:", e);
    }
}

function applyLangToAll() {
    try {
        const nodes = app.graph ? (app.graph.nodes || app.graph._nodes || []) : [];
        for (const n of nodes) applyLangToNode(n);
        app.graph?.setDirtyCanvas?.(true, true);
    } catch (e) {
        console.warn("[XH LTXIdentity] 全局应用语言失败:", e);
    }
}

app.registerExtension({
    name: "XH.LTXIdentity.FamilyUI",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (!isXHNode(nodeData.name)) return;

        const origOnCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = origOnCreated?.apply(this, arguments);
            try {
                applyLangToNode(this);
                makeXHToolbar(this);
            } catch (e) {
                console.warn("[XH LTXIdentity] 工具条创建失败:", e);
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
        onLangChanged(applyLangToAll);
    },
});
