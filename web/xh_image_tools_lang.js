// 🖼️XH-图像工具 · 家族前端（2026-10-01 升级到家族规范）
// ① 语言桥：window.XH_LANG accessor + xh:lang-changed 广播（全家族同步）
// ② 中/EN：节点标题 + 参数标签 + 输入/输出端口名（含动态端口 image_1..image_N）
// ③ 🎨 家族 12 色 + 自定义取色器（本版新增，之前缺）
// ④ 动态输入槽：给 XHImageBatchMulti 加「🔄 更新输入口」按钮
//    （逻辑移植自 comfyui-kjnodes/web/js/jsnodes.js 的 setupDynamicInputs，行为一致）
//
// 只改 label / title，绝不改 name —— 后端按 name 取参数，改了会坏。
// 工具条走 addDOMWidget({serialize:false}) 且只 append，禁止 unshift（会顶乱 widgets_values 下标）。
const { app } = window.comfyAPI.app;
import { ensureLangBridge, makeXHToolbar, onLangChanged, releaseButtons, applyComboLabels, showXHPicker, fixWidgetValuesFromSaved , paintBarBtn, makeGearBtn} from "./xh_ui_kit.js";

ensureLangBridge();

const XH_I18N = {
    zh: {
        nodes: {
            XHImageResizeV2: "🖼️XH-图像缩放v2",
            XHImageBatchMulti: "🖼️XH-图像批量合并",
            XHRefSheetBuilder: "🧩XH-参考图拼接板",
            XHImageMaskScale: "🖼️XH-图像遮罩缩放",
            XHImageSize: "🖼️XH-图像尺寸",
            // 宫格故事板三件套（2026-10-09）
            XHStoryboardGrid: "🖼️XH-宫格底板",
            XHImageContrast: "🖼️XH-图像对比度",
            XHStoryboardPanelCrop: "🖼️XH-宫格切图",
            // 形状遮罩覆盖（2026-10-09）
            XHShapeMaskOverlay: "🔁XH-形状遮罩覆盖",
            // 区域限定框（2026-10-10，喂 SAM3_Detect.bboxes）
            XHBBoxRegion: "🔁XH-区域限定框",
            // 智能遮脸（2026-10-12，SAM3 一体化）
            XHSmartFaceMask: "🧩XH-智能遮脸",
            // 🎵 音乐卡点表（2026-10-14，纯 numpy 节拍分析，零第三方依赖）
            XHBeatCueTable: "🎵XH-音乐卡点表",
            // 去背景（2026-10-18 登记，补家族语言机制）
            XHBackgroundRemove: "🖼️XH-去背景",
            // 🔁XH-H3 latent接续（2026-10-23 家族模式化：从 widgets 挪进 nodes）
            XHH3LatentContinuation: "🔁XH-H3 latent接续",
            // 🔁XH-H3 动作校正（2026-10-23，TST 推理时校正，零第三方依赖）
            XHH3TemporalCorrection: "🔁XH-H3 动作校正",
        },
        widgets: {
            // 🎵 音乐卡点表
            audio: "音频(整首曲子)",
            // 🔁XH-H3 latent接续
            overlap_frames: "重叠帧数",
            is_first: "是否首轮",
            drift_control: "漂移控制",
            // 🔁XH-H3 动作校正（TST）
            tau: "校正强度",
            log_diagnostics: "诊断日志",
            target_sec: "参考段长(秒·仅①用)",
            batch_count: "列表一次给几段(0=到尾)",
            fps: "帧率",
            frame_mod: "帧格模数",
            frame_offset: "帧格偏移",
            bars_per_seg: "每段几小节",
            bar_offset_beats: "起拍位置(0-3)",
            max_segments: "最多几段",
            start_offset: "整体平移(秒)",
            // 🎵 音乐卡点表 v1.9.27：不齐分 + 单段直出
            mode: "切点来源",
            min_seg_sec: "最短一段(秒)",
            max_seg_sec: "最长一段(秒,0=自动)",
            snap_to_bar: "吸附到乐句",
            index: "取第几段(0起)",
            // 图像缩放 v2
            width: "目标宽度",
            height: "目标高度",
            upscale_method: "缩放算法",
            keep_proportion: "保持比例方式",
            pad_color: "补边颜色",
            crop_position: "裁切位置",
            divisible_by: "整除对齐",
            device: "计算设备",
            // 图像遮罩缩放
            resize_mode: "调整类型",
            size: "目标尺寸",
            interpolation: "缩放方法",
            // 图像批量合并
            inputcount: "输入口数量",
            xh_update_inputs: "🔄 更新输入口",
            // 参考图拼接板
            preset: "📐 目标画幅",
            layout: "🧩 版式",
            gap: "📏 格间距",
            crop_fill: "✂️ 裁切填满",
            // 宫格故事板
            layout_mode: "🧩 排版方式",
            num_panels: "🔢 格数",
            columns: "🔢 列数",
            rows: "🔢 行数",
            border_thickness: "▮ 边框粗细",
            background_gray_value: "🌑 格子灰度",
            invert_colors: "🔄 反色",
            cell_alpha: "◻ 格内透明",
            contrast: "◑ 对比度",
            brightness: "☀ 亮度",
            strength: "🎚 作用强度",
            shave_edges_pixels: "✂ 内缩像素",
            offset_y: "↕ 纵向偏移",
            offset_x: "↔ 横向偏移",
            target_aspect_ratio: "📐 目标比例",
            padding_mode: "🖼 填充方式",
            order: "🔢 输出顺序",
            // 形状遮罩覆盖（二合一 / 2026-10-12）
            shape: "形状",
            coord_center: "坐标中心",
            location_x: "偏移 X",
            location_y: "偏移 Y",
            shape_width: "形状基准宽",
            shape_height: "形状基准高",
            scale: "缩放",
            rotation: "旋转",
            opacity: "不透明度",
            blur_radius: "模糊半径",
            background_color: "背景颜色",
            shape_color: "形状颜色",
            frame_width: "画布宽(0=跟随原图)",
            frame_height: "画布高(0=跟随原图)",
            color: "填充色",
            feather: "边缘羽化",
            invert: "反转填充",
            mask_locate: "用mask定位画形状",
            mask_margin: "定位外扩%",
            // 区域限定框（2026-10-10）
            center_x: "中心X占比",
            center_y: "中心Y占比",
            box_w: "区域宽占比",
            box_h: "区域高占比",
            // 智能遮脸（2026-10-12）
            search_mode: "搜索范围",
            exclude_cx: "排除区中心X(占比)",
            exclude_cy: "排除区中心Y(占比)",
            exclude_w: "排除区宽(占比)",
            exclude_h: "排除区高(占比)",
            exclude_enable: "启用排除区",
            exclude_color: "排除块颜色",
            mask_margin: "定位外扩%",
            pick_mode: "选哪个脸",
            face_ratio: "脸高占比(裁上部)",
            shape_scale: "形状缩放",
            region_x: "区域中心X",
            region_y: "区域中心Y",
            region_w: "区域宽",
            region_h: "区域高",
            fallback_draw: "找不到脸兜底画形状",
            threshold: "检测阈值",
            refine_iterations: "细化次数",
            shape_color: "遮挡色",
            // ★ v1.9.5：head（小脸以上）的「四向外扩」——单位：左/右=脸宽，上/下=脸高
            expand_left: "左扩(脸宽倍)",
            expand_right: "右扩(脸宽倍)",
            expand_top: "上扩(脸高倍)",
            expand_bottom: "下扩(脸高倍)",
            // ★ v1.9.7：auto 取色的基准脸
            color_pick_ref: "取色基准脸",
            // ★ v1.9.8：内置提示词（把 CLIP 线接到本节点，就能直接在这儿写 face / face:2）
            prompt: "提示词(内置)",
            opacity: "不透明度",
            blur_radius: "模糊半径",
            feather: "羽化",
            rotation: "旋转",
            invert: "反转",
            face_box: "人脸框",
            // 去背景（2026-10-18）
            image: "输入图像",
            model: "模型",
            mask_feather: "掩码羽化",
            mask_offset: "掩码偏移",
            invert: "反转",
        },
        slots: {
            // 🎵 音乐卡点表
            durations: "每段秒数(给分段表)",
            // 🔁XH-H3 latent接续
            target_latent: "目标latent",
            previous_latent: "上段latent",
            masked_target: "掩码latent",
            patched_model: "打补丁模型",
            positive: "条件",
            model: "模型",
            sigmas: "采样调度",
            frames: "每段帧数(清单)",
            count: "总段数",
            start_sec: "本段起始秒",
            duration_sec: "本段时长",
            frames_now: "本段帧数",
            start_sec_list: "起始秒[全N段]",
            duration_sec_list: "时长[全N段]",
            frames_now_list: "帧数[全N段]",
            // 图像缩放 v2
            image: "图像",
            mask: "蒙版",
            IMAGE: "图像",
            MASK: "蒙版",
            width: "宽度",
            height: "高度",
            batch_size: "批次大小",
            info: "信息",
            // 图像遮罩缩放（MatchType 端口：接 IMAGE 就是图像，接 MASK 就是蒙版）
            input: "图像/蒙版",
            resized: "缩放结果",
            // 图像批量合并
            images: "图像批次",
            // 宫格故事板
            cell_mask: "格子蒙版",
            grid_preview: "网格预览",
            panel_count: "面板数",
            // 参考图拼接板（image_1..3 由 slotLabel() 的正则统一处理，
            // 不写在这里，避免与 ^image_(\d+)$ 抢命中）
            ref_sheet: "参考表",
            // BBox Region (2026-10-10)
            BBOX: "区域框",
            BOX2: "边界框2",
            // ★ v1.9.8：内置提示词要用到的 CLIP 输入端口
            clip: "CLIP(提示词)",
            // ★ v1.9.11：输出口人脸框（之前中英都漏映射 → 中文态挂英文）
            face_box: "人脸框",
            // 🎵 音乐卡点表
            audio: "音频",
            durations: "每段秒数表",
            frames: "每段帧数表",
            count: "总段数",
        },
    },
        en: {
            nodes: {
                XHImageResizeV2: "🖼️XH-Resize Image v2",
                XHImageBatchMulti: "🖼️XH-Image Batch Multi",
                XHRefSheetBuilder: "🧩XH-Ref Sheet Builder",
                XHImageMaskScale: "🖼️XH-Image Mask Scale",
                XHImageSize: "🖼️XH-Image Size",
                // Storyboard kit (2026-10-09)
                XHStoryboardGrid: "🖼️XH-Storyboard Grid",
                XHImageContrast: "🖼️XH-Image Contrast",
                XHStoryboardPanelCrop: "🖼️XH-Panel Crop",
                XHShapeMaskOverlay: "🔁XH-Shape Mask Overlay",
                XHBBoxRegion: "🔁XH-BBox Region",
                XHSmartFaceMask: "🧩XH-Smart Face Mask",
                XHBeatCueTable: "🎵XH-Beat Cue Table",
                XHBackgroundRemove: "🖼️XH-Background Remove",
                XHH3LatentContinuation: "🔁XH-H3 latent continuation",
                // XH-H3 action correction (TST, 2026-10-23)
                XHH3TemporalCorrection: "🔁XH-H3 action correction",
            },
        widgets: {
            audio: "audio (whole track)",
            // XH-H3 latent continuation
            overlap_frames: "Overlap frames",
            is_first: "Is first",
            drift_control: "Drift-Control",
            // XH-H3 action correction (TST)
            tau: "correction strength (tau)",
            log_diagnostics: "diagnostics log",
            target_sec: "ref. length (sec, mode ①)",
            batch_count: "batch size (0=all)",
            fps: "fps",
            frame_mod: "frame modulus",
            frame_offset: "frame offset",
            bars_per_seg: "bars per segment",
            bar_offset_beats: "bar start (beat)",
            max_segments: "max segments",
            start_offset: "shift all (sec)",
            // 🎵 Beat cue table v1.9.27: uneven cuts + single-segment outputs
            mode: "cut source",
            min_seg_sec: "min segment (sec)",
            max_seg_sec: "max segment (0=auto)",
            snap_to_bar: "snap to phrase",
            index: "which segment (0-based)",
            width: "width",
            height: "height",
            upscale_method: "upscale_method",
            keep_proportion: "keep_proportion",
            pad_color: "pad_color",
            crop_position: "crop_position",
            divisible_by: "divisible_by",
            device: "device",
            // Image Mask Scale
            resize_mode: "resize_mode",
            size: "size",
            interpolation: "interpolation",
            divisible_by: "divisible_by",
            inputcount: "inputcount",
            xh_update_inputs: "🔄 Update inputs",
            preset: "📐 Target canvas",
            layout: "🧩 Layout",
            gap: "📏 Gap",
            crop_fill: "✂️ Crop to fill",
            // Storyboard kit
            layout_mode: "layout mode",
            num_panels: "panels",
            columns: "columns",
            rows: "rows",
            border_thickness: "border thickness",
            background_gray_value: "cell gray",
            invert_colors: "invert colors",
            cell_alpha: "transparent cells",
            contrast: "contrast",
            brightness: "brightness",
            strength: "strength",
            shave_edges_pixels: "shave edges",
            offset_y: "offset Y",
            offset_x: "offset X",
            target_aspect_ratio: "target ratio",
            padding_mode: "padding mode",
            order: "output order",
            // Shape Mask Overlay (merged 2026-10-12)
            shape: "shape",
            coord_center: "anchor",
            location_x: "offset X",
            location_y: "offset Y",
            shape_width: "base width",
            shape_height: "base height",
            scale: "scale",
            rotation: "rotation",
            opacity: "opacity",
            blur_radius: "blur radius",
            background_color: "background color",
            shape_color: "shape color",
            frame_width: "canvas width (0=image)",
            frame_height: "canvas height (0=image)",
            color: "fill color",
            feather: "edge feather",
            invert: "invert fill",
            mask_locate: "locate+shape by mask",
            mask_margin: "locate margin %",
            // BBox Region (2026-10-10)
            center_x: "center X ratio",
            center_y: "center Y ratio",
            box_w: "region W ratio",
            box_h: "region H ratio",
            // Smart Face Mask (2026-10-12)
            search_mode: "search area",
            exclude_cx: "exclude center X ratio",
            exclude_cy: "exclude center Y ratio",
            exclude_w: "exclude W ratio",
            exclude_h: "exclude H ratio",
            exclude_enable: "enable exclude",
            exclude_color: "exclude block color",
            mask_margin: "locate margin %",
            pick_mode: "which face",
            face_ratio: "face height ratio (top crop)",
            shape_scale: "shape scale",
            region_x: "region center X",
            region_y: "region center Y",
            region_w: "region width",
            region_h: "region height",
            fallback_draw: "draw shape if no face",
            threshold: "threshold",
            refine_iterations: "refine passes",
            shape_color: "overlay color",
            expand_left: "expand L (x face W)",
            expand_right: "expand R (x face W)",
            expand_top: "expand top (x face H)",
            expand_bottom: "expand bottom (x face H)",
            color_pick_ref: "color-pick face",
            prompt: "prompt (built-in)",
            opacity: "opacity",
            blur_radius: "blur radius",
            feather: "feather",
            rotation: "rotation",
            invert: "invert",
            face_box: "face box",
            // Background Remove (2026-10-18)
            image: "input image",
            model: "model",
            mask_feather: "mask feather",
            mask_offset: "mask offset",
            invert: "invert",
        },
        slots: {
            // 🎵 Beat cue table
            durations: "durations",
            // XH-H3 latent continuation
            target_latent: "Target latent",
            previous_latent: "Previous latent",
            masked_target: "Masked target",
            patched_model: "Patched model",
            positive: "positive",
            model: "model",
            sigmas: "sigmas",
            frames: "frames",
            count: "count",
            start_sec: "start sec",
            duration_sec: "duration",
            frames_now: "frames",
            start_sec_list: "start sec [all N]",
            duration_sec_list: "duration [all N]",
            frames_now_list: "frames [all N]",
            image: "image",
            mask: "mask",
            IMAGE: "IMAGE",
            MASK: "MASK",
            width: "width",
            height: "height",
            batch_size: "batch_size",
            info: "info",
            // Image Mask Scale (MatchType port)
            input: "input",
            resized: "resized",
            images: "images",
            ref_sheet: "ref_sheet",
            // Storyboard kit
            cell_mask: "cell_mask",
            grid_preview: "grid_preview",
            panel_count: "panel_count",
            // BBox Region
            BBOX: "BBOX",
            BOX2: "BOX2",
            // ★ v1.9.11：CLIP 输入端口必须有 en 映射 —— slotLabel() 命中不到时会「保留上一次的
            //   label」，切到英文就会挂着一串中文（原 bug：永远显示 "CLIP(提示词)"）。
            clip: "CLIP (prompt)",
            // ★ v1.9.11：输出口人脸框（必须两边都给 —— 缺一边就会「挂上一次的语言」）
            face_box: "face box",
            audio: "audio",
            durations: "durations",
            frames: "frames",
            count: "count",
        },
    },
};

// 下拉框「中文态纯中文、英文态回落原值」（走官方 getOptionLabel 钩子；key 是英文存值，不动）
// upscale_method / keep_proportion / crop_position / preset / device 的**值本身就是中文**，无需映射
const COMBO_LABELS = {
    // ★ v1.9.7：智能遮脸 auto 取色的「基准脸」——多脸时以哪张脸为中心往外扩去取色
    color_pick_ref: {
        center: "最靠中间的脸",
        largest: "最大的脸",
        union: "全部脸(并集)",
    },
    layout: {
        horizontal: "横向排列",
        vertical: "纵向排列",
        grid: "网格",
    },
    resize_mode: {
        shorter_dimension: "按短边缩放",
        longer_dimension: "按长边缩放",
        width: "按宽度",
        height: "按高度",
    },
    interpolation: {
        lanczos: "兰索斯",
        "nearest-exact": "最近邻",
        bilinear: "双线性",
        bicubic: "双三次",
        area: "区域平均",
    },
    // 宫格故事板
    layout_mode: {
        auto: "按格数自动",
        manual: "手动列×行",
    },
    order: {
        row_major: "行优先（左→右）",
        column_major: "列优先（上→下）",
    },
    padding_mode: {
        center_crop_zoom: "居中裁切放大",
        letterbox_black: "缩放补黑边",
    },
    target_aspect_ratio: {
        original_proportions: "保持原比例",
        "1:1 (Square)": "1:1 方图",
        "16:9 (Widescreen)": "16:9 横屏",
        "9:16 (Vertical)": "9:16 竖屏",
        "21:9 (Ultrawide)": "21:9 超宽",
    },
    // 形状遮罩覆盖（二合一 / 2026-10-12：11 种形状）
    // 智能遮脸额外有 sam_mask（SAM 原始遮罩）+ head（脖子以上整块融合）；老节点没有该选项，加了也不影响它
    shape: {
        sam_mask: "SAM原始遮罩(只遮脸)",
        head: "小脸以上(四向外扩)",
        manual_box: "手动框(不用模型)",
        circle: "圆",
        square: "正方",
        rectangle: "矩形",
        semicircle: "半圆",
        quarter_circle: "1/4圆",
        ellipse: "椭圆(扁)",
        triangle: "三角",
        cross: "十字",
        star: "星形",
        radial: "放射扇形",
    },
    coord_center: {
        image_center: "画布中心",
        left_top: "左上角",
    },
    // 智能遮脸搜索范围（2026-10-12）
    search_mode: {
        whole_image: "全图找",
        center_region: "只在中心区域找",
        custom_box: "自定义框内找",
    },
    // 🎵 音乐卡点表「切点来源」+「吸附开关」（2026-10-14）
    mode: {
        grid: "① 按小节线均分(卡拍)",
        structure: "② 按内容换段(长短不一)",
        gap: "③ 按气口(能量空档)",
    },
    snap_to_bar: {
        on: "开 · 拽到最近小节线",
        off: "关 · 保持原位置",
    },
};

function normalizeType(type) {
    return typeof type === "string" ? type.replace(/^[^\w]+/, "") : type;
}

function isXHNode(type) {
    if (typeof type !== "string") return false;
    return !!XH_I18N.zh.nodes[normalizeType(type)];
}

// 动态端口（image_1 / image_2 / …）单独处理
function slotLabel(name, lang) {
    if (!name) return null;
    const m = /^image_(\d+)$/.exec(name);
    if (m) return lang === "zh" ? `图像 ${m[1]}` : `image_${m[1]}`;
    const pack = XH_I18N[lang];
    return (pack && pack.slots[name]) || null;
}

// 形状遮罩覆盖：把 color 文本框换成「填充色」色块 + 家族取色器（showXHPicker）
// 返回要并进工具条的 DOM 元素；原生 color 文本框只做视觉隐藏（不动 name、不删 widgets）
// 工具条右侧的两个取色块（2026-10-12 二合一升级）：形状色 + 背景色。
// 绑定到后端 shape_color / background_color 两个 STRING(hex) 控件；把原生输入框视觉隐藏。
// 通用件：把一个后端 STRING(hex) 控件换成「小标签 + 色块」。
// 点色块弹家族取色器（XH 12 色 + 自定义）；原生文本框只做视觉隐藏（不删 widget、不改 name）。
// 返回 { box, refresh }；refresh() 用于切语言时重刷标签文案。tip 传了才加 hover 提示（老节点不传 ⇒ 行为零变化）。
function mkColorSwatch(node, wName, zhLabel, enLabel, fallback, resetZh, resetEn, tip) {
    const cw = (node.widgets || []).find((w) => w && w.name === wName);
    const box = document.createElement("div");
    // ★ v1.9.15：flex:0 0 auto —— 色板本身**永不被压缩**（工具条空间不够时，
    //   该缩的是后面那句可省略的长提示，绝不能把色板挤没）
    box.style.cssText = "display:flex;align-items:center;gap:3px;flex:0 0 auto;";
    const label = document.createElement("span");
    label.style.cssText = "font-size:11px;color:#e8e8e8;white-space:nowrap;flex:0 0 auto;";
    const swatch = document.createElement("button");
    swatch.type = "button";
    swatch.style.cssText = "width:40px;height:20px;border:1px solid rgba(255,255,255,.35);border-radius:4px;cursor:pointer;flex:0 0 auto;";
    if (tip) swatch.title = tip;
    const refresh = () => {
        const lang = window.XH_LANG || "zh";
        label.textContent = lang === "zh" ? zhLabel : enLabel;
        const v = cw && cw.value;
        // ★ v1.9.2：值 = "auto" 时显示斜纹（表示「自动跟背景」，不是某个具体色）
        if (String(v || "").trim().toLowerCase() === "auto") {
            swatch.style.background = "repeating-linear-gradient(45deg,#5a5a5a 0 4px,#9d9d9d 4px 8px)";
            swatch.title = (tip ? tip + " · " : "") + (lang === "zh" ? "当前=自动(跟背景)" : "current = auto (match background)");
        } else {
            swatch.style.background = v || fallback;
            if (tip) swatch.title = tip;
        }
    };
    swatch.onclick = (e) => {
        e.stopPropagation();
        if (!cw) return;
        showXHPicker(swatch, {
            id: "xh_shape_" + wName + "_pop",
            current: cw.value || fallback,
            resetLabel: (window.XH_LANG === "zh" ? resetZh : resetEn),
            resetValue: fallback,
            onPick: (hex) => { if (hex && cw) { cw.value = hex; refresh(); } },
        });
    };
    box.appendChild(label); box.appendChild(swatch);
    // 视觉隐藏原生文本框（不删、不改 hidden）
    if (cw) {
        cw.computeSize = () => [0, 0];
        cw.getMinHeight = () => 0;
        cw.draw = () => {};
        cw.mouse = () => false;
        const el = cw.element || cw.el;
        if (el && el.style) { el.style.display = "none"; el.style.height = "0px"; el.style.overflow = "hidden"; }
    }
    refresh();
    return { box, refresh };
}

function buildFillColorControl(node) {
    const wrap = document.createElement("div");
    wrap.style.cssText = "display:flex;align-items:center;gap:6px;flex:0 0 auto;";

    const a = mkColorSwatch(node, "shape_color", "形状色", "Shape", "#C8C8C8", "默认灰", "Default Gray");
    const b = mkColorSwatch(node, "background_color", "背景色", "BG", "#000000", "默认黑", "Default Black");
    wrap.appendChild(a.box);
    wrap.appendChild(b.box);
    node._xhFillRefresh = () => { a.refresh(); b.refresh(); };   // 语言切换时重刷文案
    return wrap;
}

// 🧩XH-智能遮脸：工具条右侧两个色板 —— 遮挡色（最终盖在脸上的色）+ 排除块色（只喂 SAM3 看）。
// 2026-10-12 v1.9.1：原来这俩是手敲 hex 的文本框，用户看不懂 ⇒ 全部换成可视化色板。
function buildSMFColorControl(node) {
    const wrap = document.createElement("div");
    // ★ v1.9.15：由 flex:0 0 auto 改为 **flex:1 1 0**（基准 0 + 可伸可缩）。
    //   关键坑：flex-wrap 的**换行判定按 flex-basis（内容宽度）**算，光加 flex-shrink/min-width:0
    //   没用 —— 内容 441 > 剩余 272 依然换行，而插槽定高 ⇒ 第二行被裁（用户报的「功能键消失」）。
    //   把 basis 设 0：换行判定里它只占 0，永远排得下 ⇒ 不换行；宽度由剩余空间分配。
    wrap.style.cssText = "display:flex;align-items:center;gap:8px;flex:1 1 0;min-width:0;";
    // ★ v1.9.2：遮挡色默认灰白 #C8C8C8；右侧多一个「自动」按钮 → 让遮挡色跟着脸周围的背景色走
    const a = mkColorSwatch(node, "shape_color", "遮挡色", "Overlay", "#C8C8C8", "默认灰白", "Default Gray",
        (window.XH_LANG === "zh" ? "最终盖在脸上的颜色；点右侧「自动」可让它跟背景色走" : "final overlay color on the face; click Auto to match the surrounding background"));
    const acw = (node.widgets || []).find((w) => w && w.name === "shape_color");
    const autoBtn = document.createElement("button");
    autoBtn.type = "button";
    paintBarBtn(autoBtn, "neutral");
    autoBtn.style.cssText = autoBtn.style.cssText
        + "height:20px;padding:0 6px;font:11px sans-serif;";   // 保留它 20px 的小尺寸;
    const refreshAuto = () => {
        const zh = (window.XH_LANG || "zh") === "zh";
        const on = acw && String(acw.value || "").trim().toLowerCase() === "auto";
        autoBtn.textContent = zh ? "自动" : "Auto";
        autoBtn.style.background = on ? "#3ad17a" : "#2b2b2b";
        autoBtn.style.color = on ? "#111" : "#e8e8e8";
        autoBtn.title = zh
            ? (on ? "当前=自动跟背景（点一下改回灰白）" : "点一下：遮挡色自动探测背景色（取小脸左/右/上外扩那一圈里最多的颜色，用「左扩/右扩/上扩」调远近）")
            : (on ? "current = auto (match background); click to set back to gray" : "click: auto-sample the median color around the face");
    };
    autoBtn.onclick = (e) => {
        e.stopPropagation();
        if (!acw) return;
        const on = String(acw.value || "").trim().toLowerCase() === "auto";
        acw.value = on ? "#C8C8C8" : "auto";
        a.refresh(); refreshAuto();
        refreshHead();          // ★ v1.9.5：head 提示里会显示「色=auto」与否，跟着刷
    };
    a.box.appendChild(autoBtn);
    refreshAuto();
    const b = mkColorSwatch(node, "exclude_color", "排除块色", "Exclude", "#000000", "默认黑", "Default Black",
        (window.XH_LANG === "zh"
            ? "盖住排除区的颜色（只喂 SAM3 看，不出现在最终输出里；默认纯黑）"
            : "color painted over the excluded area (fed to SAM3 only, not in the output; default black)"));
    wrap.appendChild(a.box);
    wrap.appendChild(b.box);
    // ★ v1.9.5：shape=head（小脸以上）时，范围由 expand_left/right/top/bottom 四个参数决定 ⇒ 给个可见提示
    // ★ v1.9.15：这句**必须可收缩**（flex:0 1 auto + min-width:0 + 省略号）。
    //   它是工具条里唯一的长文本，也是唯一该让位的东西；不然它一出现就把
    //   中/EN、🎨、色板挤到第二行，而插槽定高 ⇒ 那一行直接被裁掉（用户报的「功能键消失」）。
    const headHint = document.createElement("span");
    headHint.style.cssText =
        "font-size:10px;color:#7fd1a0;white-space:nowrap;" +
        "flex:0 1 auto;min-width:0;max-width:100%;overflow:hidden;text-overflow:ellipsis;";
    const refreshHead = () => {
        const sw = (node.widgets || []).find((w) => w && w.name === "shape");
        const on = sw && String(sw.value || "").trim().toLowerCase() === "head";
        const zh = (window.XH_LANG || "zh") === "zh";
        const auto = acw && String(acw.value || "").trim().toLowerCase() === "auto";
        if (!on) { headHint.textContent = ""; return; }
        headHint.textContent = zh
            ? (auto ? "小脸以上：范围看「左/右/上/下扩」· 色=auto(跟背景)" : "小脸以上：范围看「左/右/上/下扩」· 点「自动」可跟背景融合")
            : (auto ? "face-up rect: see expand L/R/top/bottom · color = auto" : "face-up rect: see expand L/R/top/bottom · click Auto to blend into background");
    };
    wrap.appendChild(headHint);
    node._xhFillRefresh = () => { a.refresh(); b.refresh(); refreshAuto(); refreshHead(); };
    node._xhSMFHeadRefresh = refreshHead;
    refreshHead();
    // shape 下拉切到/离开 head 时，实时刷新那句提示（包一层 widget.callback，不动原逻辑）
    const swShape = (node.widgets || []).find((w) => w && w.name === "shape");
    if (swShape && !swShape._xhSMFHeadHooked) {
        swShape._xhSMFHeadHooked = true;
        const ocb = swShape.callback;
        swShape.callback = function (v) {
            const r = ocb ? ocb.apply(this, arguments) : undefined;
            try { node._xhSMFHeadRefresh && node._xhSMFHeadRefresh(); } catch (e) {}
            return r;
        };
    }
    return wrap;
}

// BOOLEAN(toggle) 的 on/off 显示文本（后端 label_on/label_off 只在创建时读一次，切语言必须重写 options）
const TOGGLE_ONOFF = {
    zh: { invert: { on: "反转(形状外填充)", off: "正常(形状内填充)" }, mask_locate: { on: "开(用mask定位)", off: "关(直接填mask)" },
          exclude_enable: { on: "开(先盖排除区再找脸)", off: "关(全图找脸)" },
          is_first: { on: "首轮(不续接)", off: "续接段" },
          drift_control: { on: "开", off: "关" } },
    en: { invert: { on: "Invert (fill outside)", off: "Normal (fill inside)" }, mask_locate: { on: "On (locate+shape)", off: "Off (fill mask)" },
          exclude_enable: { on: "On (block area first)", off: "Off (search whole image)" },
          is_first: { on: "First (no cont.)", off: "Continuation" },
          drift_control: { on: "On", off: "Off" } },
};

function applyLangToNode(node) {
    if (!node || !isXHNode(node.type)) return;
    const lang = window.XH_LANG || "zh";
    const pack = XH_I18N[lang] || XH_I18N.zh;
    try {
        const t = normalizeType(node.type);
        const name = pack.nodes[t];
        const defaultZhName = XH_I18N.zh.nodes[t];
        const defaultEnName = XH_I18N.en.nodes[t];
        // 只有标题还是默认显示名时才重写，保留用户自定义的标题
        if (name && (node.title === defaultZhName || node.title === defaultEnName || !node.title)) {
            node.title = name;
        }

        // 参数控件标签（只改 label，绝不改 name）；toggle 额外重写 on/off 显示文本
        if (node.widgets) {
            for (const w of node.widgets) {
                if (w && w.name && pack.widgets[w.name]) {
                    w.label = pack.widgets[w.name];
                }
                const tg = w && w.name && TOGGLE_ONOFF[lang] && TOGGLE_ONOFF[lang][w.name];
                if (tg && w.options) {
                    if (tg.on) w.options.on = tg.on;
                    if (tg.off) w.options.off = tg.off;
                }
            }
        }

        // 输入 / 输出端口名
        const applySlots = (arr) => {
            for (const s of arr || []) {
                const lb = slotLabel(s && s.name, lang);
                if (lb) s.label = lb;
            }
        };
        applySlots(node.inputs);
        applySlots(node.outputs);
        // 下拉框显示中文（值不变）
        applyComboLabels(node, lang, COMBO_LABELS);

        // Nodes 2.0 的端口标签走「快照」渲染，改完必须显式触发一次重建才看得见
        try {
            node.graph?.trigger?.("node:slot-label:changed", { nodeId: node.id, slotType: 1 });
            node.graph?.trigger?.("node:slot-label:changed", { nodeId: node.id, slotType: 2 });
        } catch (e) {}
        try { node.setDirtyCanvas?.(true, true); } catch (e) {}
    } catch (e) {
        console.warn("[XH ImageTools] 应用语言失败:", e);
    }
}

function applyLangToAll() {
    try {
        const nodes = app.graph ? (app.graph.nodes || app.graph._nodes || []) : [];
        for (const n of nodes) {
            applyLangToNode(n);
            if (n._xhFillRefresh) n._xhFillRefresh();   // 色板标签（形状遮罩覆盖 / 智能遮脸）跟着语言重刷
        }
        app.graph?.setDirtyCanvas?.(true, true);
    } catch (e) {
        console.warn("[XH ImageTools] 全局应用语言失败:", e);
    }
}

// ─── 动态输入槽：移植自 comfyui-kjnodes web/js/jsnodes.js 的 setupDynamicInputs ───
// 按前缀重建槽位，使槽数 = 计数控件的值。计数控件的回调在「API 重载」时也会触发
// （此时带 canvas 参数的是交互操作，跳过重建，避免拖数字时节点乱跳）。
function setupDynamicInputs(node, { type, prefix, countWidget = "inputcount", slotOptions } = {}) {
    const rebuild = () => {
        if (!node.inputs) node.inputs = [];
        const countW = node.widgets?.find((w) => w.name === countWidget);
        if (!countW) return;
        const target = countW.value;
        const current = node.inputs.filter((i) => i.name?.startsWith(prefix)).length;
        if (target === current) return;
        if (target < current) {
            for (let i = 0; i < current - target; i++) node.removeInput(node.inputs.length - 1);
        } else {
            for (let i = current + 1; i <= target; i++) node.addInput(`${prefix}${i}`, type, slotOptions);
        }
        // 新槽也要跟着语言走
        applyLangToNode(node);
        try {
            node.graph?.setDirtyCanvas(true, true);
        } catch (e) {}
    };

    // name 用英文键（不进 widgets_values），显示文字交给 label → 可随语言切换
    node.addWidget("button", "xh_update_inputs", null, rebuild);

    const countW = node.widgets?.find((w) => w.name === countWidget);
    if (countW) {
        const origCb = countW.callback; // guard: may be nullish
        countW.callback = function (value, canvas) {
            const r = origCb ? origCb.apply(this, arguments) : undefined;
            if (!canvas) rebuild(); // bare = API 重载；跳过交互式拖拽
            return r;
        };
    }
    return rebuild;
}

// ─── 形状遮罩覆盖：内嵌可视化拖拽编辑器（网格 + 可拖拽/缩放的形状） ───
// 纯前端：在节点 body 上画出「带网格的源图 + 半透明形状叠加 + 四角缩放句柄」。
// 拖形状=移动，拖角=缩放，坐标自动写回 location_x/y/shape_width/height。
// 形状从上游 LoadImage 的 images 直接取预览 URL，不依赖任何外部文件。
// ==== XHShapeMaskOverlay：节点内嵌可视化编辑器（DOM canvas 版，2026-10-10）====
// 旧版用 onDrawForeground canvas 钩子画编辑器 —— 在新版 DOM 节点渲染（Vue 节点）下根本不执行，
// 编辑器永远看不见。现改为 DOM widget 内嵌 <canvas>：与渲染模式无关、必定可见，拖拽走 DOM 事件。
function xhSM_getW(node, name) { return (node.widgets || []).find((w) => w && w.name === name); }
function xhSM_setW(w, v) { if (!w) return; w.value = v; try { w.callback && w.callback(v, null); } catch (e) {} }

// 坐标中心桥（2026-10-12）：编辑器内部一律用「绝对像素中心 (ax,ay)」，
// 而 widget 的 location_x/y 是「相对 coord_center 锚点的偏移」——通过这两个函数互转。
// 圆心模型（Apt 同款）：left_top 锚点时，对称形状 cx = offset + min(sw,sh)/2。
// 为让编辑器所见即所得，这里用「形状中心绝对坐标」为中介，只在 left_top 下做半径补偿。
function xhSM_refWH(node) {
    const wF = xhSM_getW(node, "frame_width"), wH = xhSM_getW(node, "frame_height");
    const fw = wF ? Number(wF.value) : 0, fh = wH ? Number(wH.value) : 0;
    if (fw > 0 && fh > 0) return { w: fw, h: fh };
    if (node._xhEd && node._xhEd.imgW && node._xhEd.imgH) return { w: node._xhEd.imgW, h: node._xhEd.imgH };
    return { w: 1536, h: 1024 };
}
function xhSM_shapeName(node) {
    const w = xhSM_getW(node, "shape"); return (w && w.value) || "circle";
}
// 由 widget 值算出「形状中心的绝对像素坐标」
function xhSM_getCenter(node) {
    const R = xhSM_refWH(node);
    const wCX = xhSM_getW(node, "location_x"), wCY = xhSM_getW(node, "location_y");
    const wCC = xhSM_getW(node, "coord_center");
    const lx = Number(wCX && wCX.value) || 0, ly = Number(wCY && wCY.value) || 0;
    const cc = (wCC && wCC.value) || "image_center";
    const sw = Number((xhSM_getW(node, "shape_width") || {}).value) || 0;
    const sh = Number((xhSM_getW(node, "shape_height") || {}).value) || 0;
    const shape = xhSM_shapeName(node);
    if (cc === "image_center") return { x: R.w / 2 + lx, y: R.h / 2 + ly };
    // left_top：还原后端语义下的中心
    const radius = Math.max(1, Math.floor(Math.min(sw, sh) / 2));
    if (shape === "rectangle") return { x: lx + Math.floor(sw / 2), y: ly + Math.floor(sh / 2) };
    if (shape === "ellipse") return { x: lx + radius, y: ly + Math.floor(radius * 0.7) };
    if (shape === "semicircle") return { x: lx + radius, y: ly };
    if (shape === "quarter_circle") return { x: lx, y: ly };
    return { x: lx + radius, y: ly + radius };
}
// 由「形状中心绝对像素坐标」反写 widget 偏移
function xhSM_setCenter(node, ax, ay) {
    const R = xhSM_refWH(node);
    const wCC = xhSM_getW(node, "coord_center");
    const cc = (wCC && wCC.value) || "image_center";
    const sw = Number((xhSM_getW(node, "shape_width") || {}).value) || 0;
    const sh = Number((xhSM_getW(node, "shape_height") || {}).value) || 0;
    const shape = xhSM_shapeName(node);
    let lx, ly;
    if (cc === "image_center") { lx = ax - R.w / 2; ly = ay - R.h / 2; }
    else {
        const radius = Math.max(1, Math.floor(Math.min(sw, sh) / 2));
        if (shape === "rectangle") { lx = ax - Math.floor(sw / 2); ly = ay - Math.floor(sh / 2); }
        else if (shape === "ellipse") { lx = ax - radius; ly = ay - Math.floor(radius * 0.7); }
        else if (shape === "semicircle") { lx = ax - radius; ly = ay; }
        else if (shape === "quarter_circle") { lx = ax; ly = ay; }
        else { lx = ax - radius; ly = ay - radius; }
    }
    xhSM_setW(xhSM_getW(node, "location_x"), Math.round(lx));
    xhSM_setW(xhSM_getW(node, "location_y"), Math.round(ly));
}

function xhSM_srcURL(node) {
    // 上游图像：优先读 LoadImage 的 image widget 值（type=input），回退执行预览 images
    try {
        const inp = node.inputs && node.inputs.find((i) => i.name === "image");
        if (!inp || inp.link == null) return null;
        const link = node.graph.links[inp.link];
        if (!link) return null;
        const src = node.graph.getNodeById(link.origin_id);
        if (!src) return null;
        const apiObj = (app && app.api) || (window.comfyAPI && window.comfyAPI.api);
        const mk = (q) => (apiObj && apiObj.apiURL ? apiObj.apiURL("/view?" + q) : "/view?" + q);
        const wImg = (src.widgets || []).find((w) => w && w.name === "image");
        if (wImg && typeof wImg.value === "string" && wImg.value) {
            return mk(`filename=${encodeURIComponent(wImg.value)}&type=input`);
        }
        const imgs = src.images;
        if (imgs && imgs.length) {
            const im = imgs[0];
            return mk(`filename=${encodeURIComponent(im.filename)}&subfolder=${encodeURIComponent(im.subfolder || "")}&type=${encodeURIComponent(im.type || "input")}`);
        }
    } catch (e) {}
    return null;
}

function xhSM_setup(node) {
    if (node._xhEd) return;                         // 幂等
    // ── DOM 结构：wrap > [stage > (canvas 背景/网格 + overlay 形状/句柄), tip]
    const wrap = document.createElement("div");
    wrap.style.cssText = "width:100%;padding:6px 8px;box-sizing:border-box;background:#141414;border-radius:8px;";
    const stage = document.createElement("div");
    stage.style.cssText = "position:relative;width:100%;min-height:140px;background:#202020;border-radius:6px;overflow:hidden;line-height:0;";
    const cv = document.createElement("canvas");
    cv.width = 320; cv.height = 213;                 // 初始内部分辨率，之后 fit() 按参考宽高比调整
    cv.style.cssText = "width:100%;height:auto;display:block;background:#202020;border-radius:6px;";
    const ov = document.createElement("div");
    ov.style.cssText = "position:absolute;left:0;top:0;width:100%;height:100%;touch-action:none;cursor:crosshair;";
    const shapeEl = document.createElement("div");
    shapeEl.style.cssText = "position:absolute;box-sizing:border-box;background:rgba(255,80,80,.30);border:2px dashed #ff5050;";
    ov.appendChild(shapeEl);
    const mkH = () => {
        const d = document.createElement("div");
        d.style.cssText = "position:absolute;width:11px;height:11px;margin:-6px 0 0 -6px;background:#fff;border:1px solid #ff5050;box-sizing:border-box;cursor:nwse-resize;";
        return d;
    };
    const hEl = { tl: mkH(), tr: mkH(), bl: mkH(), br: mkH() };
    for (const k in hEl) ov.appendChild(hEl[k]);
    const tip = document.createElement("div");
    tip.style.cssText = "color:#8a93a6;font:11px sans-serif;padding:4px 2px 0;text-align:center;line-height:1.4;";
    stage.appendChild(cv); stage.appendChild(ov);
    wrap.appendChild(stage); wrap.appendChild(tip);

    const ed = node._xhEd = { img: null, url: null, imgW: 0, imgH: 0, box: null, mode: null, ax: null, ay: null, last: [0, 0], cv, dead: false, miss: 0 };

    try {
        node.addDOMWidget("xh_shape_editor", "custom", wrap, {
            serialize: false, hideOnZoom: false,
            getMinHeight: () => Math.round((cv.height || 200) + 34),
        });
    } catch (e) { console.warn("[XH] 编辑器 DOM widget 挂载失败:", e); }

    // 节点移除 → 停掉动画循环（实例级包装，原型上的 releaseButtons 仍会被调到）
    const orm = node.onRemoved;
    node.onRemoved = function () { ed.dead = true; return orm ? orm.apply(this, arguments) : undefined; };

    function refWH() {
        // 坐标系：优先「画布宽/画布高」控件（填目标图尺寸）；否则用已加载图的尺寸；否则 1536×1024
        const wF = xhSM_getW(node, "frame_width"), wH = xhSM_getW(node, "frame_height");
        const fw = wF ? Number(wF.value) : 0, fh = wH ? Number(wH.value) : 0;
        if (fw > 0 && fh > 0) return { w: fw, h: fh };
        if (ed.imgW && ed.imgH) return { w: ed.imgW, h: ed.imgH };
        return { w: 1536, h: 1024 };
    }
    function fit() {
        const W = Math.max(160, Math.round(wrap.clientWidth) - 16);
        const r = refWH();
        const H = Math.max(90, Math.round(W * r.h / r.w));
        if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    }

    function draw() {
        const W = cv.width || 320, H = cv.height || 213;
        const ctx = cv.getContext("2d");
        if (!ctx) return;
        ctx.fillStyle = "#202020"; ctx.fillRect(0, 0, W, H);
        ed.L = { x: 0, y: 0, w: W, h: H };
        if (ed.img && ed.imgW) { try { ctx.drawImage(ed.img, 0, 0, W, H); } catch (e) {} }
        // 网格
        ctx.strokeStyle = "rgba(255,255,255,.25)"; ctx.lineWidth = 1;
        const cols = 8, rows = Math.max(4, Math.round(cols * (H / W)));
        for (let i = 0; i <= cols; i++) { const x = W * i / cols; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
        for (let j = 0; j <= rows; j++) { const y = H * j / rows; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
        // 状态行：参考尺寸 + 当前形状参数（永远画，肉眼可确认编辑器活着）
        const R = refWH();
        const wSW = xhSM_getW(node, "shape_width"), wSH = xhSM_getW(node, "shape_height");
        const c0 = xhSM_getCenter(node);
        ctx.fillStyle = "rgba(0,0,0,.55)"; ctx.fillRect(0, H - 18, W, 18);
        ctx.fillStyle = "#c9d1e0"; ctx.font = "11px sans-serif"; ctx.textAlign = "left";
        const zh = (window.XH_LANG || "zh") === "zh";
        const cxT = Math.round(c0.x), cyT = Math.round(c0.y);
        const swT = Math.round(Number(wSW && wSW.value) || 0), shT = Math.round(Number(wSH && wSH.value) || 0);
        ctx.fillText(zh
            ? `参考 ${R.w}×${R.h} · 中心 ${cxT},${cyT} · 尺寸 ${swT}×${shT}`
            : `Ref ${R.w}×${R.h} · Center ${cxT},${cyT} · Size ${swT}×${shT}`, 6, H - 5);
    }

    // 形状用真实 DOM 绘制（canvas 挂了也照样看得见、拖得动）
    function syncShape() {
        const W = cv.width || 320, H = cv.height || 213, R = refWH();
        const wShape = xhSM_getW(node, "shape");
        const wSW = xhSM_getW(node, "shape_width"), wSH = xhSM_getW(node, "shape_height");
        const wScale = xhSM_getW(node, "scale"), wRot = xhSM_getW(node, "rotation");
        const scaleV = Math.max(0.01, Number(wScale && wScale.value) || 1);
        const rotV = Math.round(Number(wRot && wRot.value) || 0);
        const swRaw = Number(wSW && wSW.value) || 0, shRaw = Number(wSH && wSH.value) || 0;
        const sw = swRaw * scaleV, sh = shRaw * scaleV;
        if (!(sw > 0 && sh > 0)) { shapeEl.style.display = "none"; for (const k in hEl) hEl[k].style.display = "none"; ed.box = null; return; }
        const c0 = xhSM_getCenter(node);
        const st = (wShape && wShape.value) || "circle";
        // 对称形状取 min(w,h) 当直径（与后端一致）；矩形用独立宽高
        let bw = sw, bh = sh;
        if (st !== "rectangle") { const d = Math.min(sw, sh); bw = d; bh = d; }
        if (st === "ellipse") bh = Math.max(1, d * 0.7);
        const b = { x: (c0.x / R.w) * W - (bw / R.w) * W / 2, y: (c0.y / R.h) * H - (bh / R.h) * H / 2, w: (bw / R.w) * W, h: (bh / R.h) * H };
        ed.box = b;
        const zh2 = (window.XH_LANG || "zh") === "zh";
        tip.textContent = zh2
            ? "拖红框【边缘】缩放 · 拖【中心】移动 · 点空白定位中心"
            : "Drag box EDGE to resize · Drag CENTER to move · Click empty to center";
        shapeEl.style.display = "block";
        shapeEl.style.left = (b.x / W * 100) + "%";
        shapeEl.style.top = (b.y / H * 100) + "%";
        shapeEl.style.width = (b.w / W * 100) + "%";
        shapeEl.style.height = (b.h / H * 100) + "%";
        shapeEl.style.transform = rotV ? `rotate(${rotV}deg)` : "none";
        shapeEl.style.transformOrigin = "50% 50%";
        shapeEl.style.borderRadius = (st === "circle" || st === "ellipse" || st === "radial") ? "50%" : "0";
        let clip = "none", border = "2px dashed #ff5050";
        if (st === "triangle") { clip = "polygon(50% 0%,100% 100%,0% 100%)"; border = "0"; }
        else if (st === "semicircle") { clip = "none"; shapeEl.style.borderRadius = "50% 50% 0 0 / 100% 100% 0 0"; }
        else if (st === "quarter_circle") { shapeEl.style.borderRadius = "100% 0 0 0"; }
        else if (st === "star") { clip = "polygon(50% 0%,61% 35%,98% 35%,68% 57%,79% 91%,50% 70%,21% 91%,32% 57%,2% 35%,39% 35%)"; border = "0"; }
        else if (st === "cross") { clip = "polygon(35% 0,65% 0,65% 35%,100% 35%,100% 65%,65% 65%,65% 100%,35% 100%,35% 65%,0 65%,0 35%,35% 35%)"; border = "0"; }
        else if (st === "square" || st === "rectangle") { shapeEl.style.borderRadius = "0"; }
        shapeEl.style.clipPath = clip;
        shapeEl.style.border = border;
        const hp = { tl: [0, 0], tr: [100, 0], bl: [0, 100], br: [100, 100] };
        for (const k in hEl) {
            hEl[k].style.display = "block";
            hEl[k].style.left = hp[k][0] + "%";
            hEl[k].style.top = hp[k][1] + "%";
            hEl[k].style.margin = k === "tl" ? "-6px 0 0 -6px" : k === "tr" ? "-6px 0 0 -5px" : k === "bl" ? "-5px 0 0 -6px" : "-5px 0 0 -5px";
        }
    }

    function ensureImg() {
        const url = xhSM_srcURL(node);
        if (!url || url === ed.url) return;
        ed.url = url;
        const im = new Image();
        im.crossOrigin = "anonymous";
        im.onload = () => { ed.img = im; ed.imgW = im.naturalWidth; ed.imgH = im.naturalHeight; fit(); };
        im.onerror = () => { ed.img = null; };     // 图加载失败也不能影响编辑器
        im.src = url;
    }

    if (typeof ResizeObserver !== "undefined") { try { new ResizeObserver(() => fit()).observe(wrap); } catch (e) {} }
    // 🔴 循环永不停：DOM widget 是异步挂载的，早期 isConnected=false 时绝不能 return 掉循环
    fit(); draw(); syncShape();
    (function loop() {
        if (ed.dead) return;
        try {
            if (wrap.isConnected) { ed.miss = 0; ensureImg(); fit(); draw(); syncShape(); }
            else if (++ed.miss > 3600) { ed.dead = true; return; }   // ~60s 仍未挂载（节点已废弃）→ 收工
        } catch (e) {}
        requestAnimationFrame(loop);
    })();

    function pos(e) {
        const r = ov.getBoundingClientRect();
        return [(e.clientX - r.left) / (r.width || 1) * (cv.width || 320), (e.clientY - r.top) / (r.height || 1) * (cv.height || 213)];
    }
    function toImg(mx, my) { const W = cv.width || 320, H = cv.height || 213, R = refWH(); return { x: mx / W * R.w, y: my / H * R.h }; }

    ov.addEventListener("pointerdown", (e) => {
        const [mx, my] = pos(e);
        if (!ed.box) {                                   // 还没有形状 → 先按默认尺寸落一个
            const R = refWH();
            xhSM_setW(xhSM_getW(node, "shape_width"), Math.round(R.w * 0.12));
            xhSM_setW(xhSM_getW(node, "shape_height"), Math.round(R.h * 0.16));
            const p = toImg(mx, my);
            xhSM_setCenter(node, p.x, p.y);
            syncShape(); e.preventDefault(); return;
        }
        const p = toImg(mx, my);
        xhSM_setCenter(node, p.x, p.y);
        ed.mode = "move"; ed.last = [mx, my];
        try { ov.setPointerCapture(e.pointerId); } catch (er) {}
        e.preventDefault();
    });
    shapeEl.addEventListener("pointerdown", (e) => {
        const b = ed.box;
        if (!b) return;
        const [mx, my] = pos(e);
        const fx = (mx - b.x) / (b.w || 1), fy = (my - b.y) / (b.h || 1);
        // 边缘带（画布 px）：距任一边 < max(10px, 短边30%) → 缩放（对边锚定）；中心区 → 移动
        const edge = Math.max(10, Math.min(b.w, b.h) * 0.3);
        const nearL = Math.abs(mx - b.x) < edge, nearR = Math.abs(mx - (b.x + b.w)) < edge;
        const nearT = Math.abs(my - b.y) < edge, nearB = Math.abs(my - (b.y + b.h)) < edge;
        const doX = nearL || nearR, doY = nearT || nearB;
        if (doX || doY) {
            ed.mode = "resize";
            ed.ax = doX ? (nearL ? b.x + b.w : b.x) : null;    // 锚点 = 对边；null = 该轴不动
            ed.ay = doY ? (nearT ? b.y + b.h : b.y) : null;
        } else {
            ed.mode = "move";
        }
        ed.last = [mx, my];
        try { ov.setPointerCapture(e.pointerId); } catch (er) {}
        e.stopPropagation(); e.preventDefault();
    });
    // 悬停光标反馈：边缘=缩放、中心=移动
    shapeEl.addEventListener("pointermove", (e) => {
        if (ed.mode) return;
        const b = ed.box;
        if (!b) return;
        const [mx, my] = pos(e);
        const edge = Math.max(10, Math.min(b.w, b.h) * 0.3);
        const nearL = Math.abs(mx - b.x) < edge, nearR = Math.abs(mx - (b.x + b.w)) < edge;
        const nearT = Math.abs(my - b.y) < edge, nearB = Math.abs(my - (b.y + b.h)) < edge;
        const doX = nearL || nearR, doY = nearT || nearB;
        shapeEl.style.cursor = (doX && doY) ? ((nearL === nearT) ? "nwse-resize" : "nesw-resize")
                             : doX ? "ew-resize" : doY ? "ns-resize" : "move";
    });
    for (const k in hEl) {
        hEl[k].addEventListener("pointerdown", (e) => {
            const [mx, my] = pos(e);
            const b = ed.box;
            if (!b) return;
            const opp = { tl: [b.x + b.w, b.y + b.h], tr: [b.x, b.y + b.h], bl: [b.x + b.w, b.y], br: [b.x, b.y] }[k];
            ed.mode = "resize";
            ed.ax = opp[0]; ed.ay = opp[1];
            ed.last = [mx, my];
            try { ov.setPointerCapture(e.pointerId); } catch (er) {}
            e.stopPropagation(); e.preventDefault();
        });
    }
    ov.addEventListener("pointermove", (e) => {
        if (!ed.mode) return;
        const [mx, my] = pos(e);
        const p = toImg(mx, my), lp = toImg(ed.last[0], ed.last[1]);
        if (ed.mode === "move") {
            // 增量移动：把中心绝对坐标整体平移
            const c0 = xhSM_getCenter(node);
            xhSM_setCenter(node, c0.x + (p.x - lp.x), c0.y + (p.y - lp.y));
        } else {
            const wSW = xhSM_getW(node, "shape_width"), wSH = xhSM_getW(node, "shape_height");
            const wScale = xhSM_getW(node, "scale");
            const scaleV = Math.max(0.01, Number(wScale && wScale.value) || 1);
            if (ed.ax !== null && ed.ax !== undefined) {       // X 轴缩放（对边锚定）
                const ai = toImg(ed.ax, 0);
                const ncx = (p.x + ai.x) / 2;                  // 新中心绝对 X
                const nsw = Math.max(8, Math.round(Math.abs(p.x - ai.x) / scaleV));
                xhSM_setW(wSW, nsw);
                const cur = xhSM_getCenter(node);
                xhSM_setCenter(node, ncx, cur.y);
            }
            if (ed.ay !== null && ed.ay !== undefined) {       // Y 轴缩放（对边锚定）
                const ai = toImg(0, ed.ay);
                const ncy = (p.y + ai.y) / 2;
                const nsh = Math.max(8, Math.round(Math.abs(p.y - ai.y) / scaleV));
                xhSM_setW(wSH, nsh);
                const cur = xhSM_getCenter(node);
                xhSM_setCenter(node, cur.x, ncy);
            }
        }
        ed.last = [mx, my];
        syncShape();
        e.preventDefault();
    });
    const end = () => { ed.mode = null; ed.ax = null; ed.ay = null; };
    ov.addEventListener("pointerup", end);
    ov.addEventListener("pointercancel", end);
    ov.addEventListener("pointerleave", end);
}

function xhSM_attach(nodeType) {
    const t = nodeType.prototype;
    const oc = t.onNodeCreated;
    t.onNodeCreated = function () {
        const r = oc ? oc.apply(this, arguments) : undefined;
        if (normalizeType(this.type) === "XHShapeMaskOverlay") { try { xhSM_setup(this); } catch (e) {} }
        if (normalizeType(this.type) === "XHBBoxRegion") { try { xhBBox_setup(this); } catch (e) {} }
        if (normalizeType(this.type) === "XHSmartFaceMask") { try { xhSMF_setup(this); } catch (e) {} }
        return r;
    };
}

// 🔁XH-区域限定框 / 🧩XH-智能遮脸 共用的可视化拖拽编辑器（§7 DOM canvas，比例模型 0~1）
// 复用 xhSM_getW/setW/srcURL。四个 widget 都是「占真实图的比例」，
// 因此所有几何都在 [0,1] 区间，canvas 按真实图比例显示，拖拽即真实像素比例，永不错位。
// 2026-10-12 v1.9.0：参数化 widget 名 → 智能遮脸的排除区（exclude_cx/cy/w/h）复用同一套编辑器。
function xhBBox_setup(node) {
    return xhBox_setup(node, {
        cx: "center_x", cy: "center_y", w: "box_w", h: "box_h",
        refW: "width", refH: "height", dom: "xh_bbox_editor",
        bg: "rgba(58,209,122,.28)", border: "#3ad17a",
        tipZh: "拖绿框【边缘】缩放 · 拖【中心】移动 · 点空白定位中心",
        tipEn: "Drag box EDGE to resize · Drag CENTER to move · Click empty to set center",
    });
}
// 🧩XH-智能遮脸：排除区拖拽编辑器（红框 = 这块不找脸）
// ── ⚙ 齿轮：🧩XH-智能遮脸 的「高级参数」（很少动，收起来让面板干净）──
//    用官方受支持的 legacy facade `widget.hidden`（与 🔁XH-加载视频 同机制）：
//    不绘制、不参与布局算高、与序列化无关（不会挪动 widgets_values 下标）。
const SMF_ADV_KEYS = [
    "threshold", "refine_iterations", "fallback_draw", "color_pick_ref",
    "mask_margin", "blur_radius", "rotation",
    "expand_left", "expand_right", "expand_top", "expand_bottom",
    "exclude_cx", "exclude_cy", "exclude_w", "exclude_h", "exclude_color",
];
function setSMFCollapsed(node, collapsed) {
    if (!node) return;
    node._xhSMFCollapsed = !!collapsed;
    for (const k of SMF_ADV_KEYS) {
        const w = (node.widgets || []).find((x) => x && x.name === k);
        if (!w) continue;
        try { w.hidden = node._xhSMFCollapsed; } catch (e) {}
    }
    try { node.setDirtyCanvas?.(true, true); } catch (e) {}
}

function xhSMF_setup(node) {
    return xhBox_setup(node, {
        cx: "exclude_cx", cy: "exclude_cy", w: "exclude_w", h: "exclude_h",
        refW: null, refH: null, dom: "xh_exclude_editor",
        bg: "rgba(214,69,65,.30)", border: "#e0554f",
        tipZh: "红框：接了模型 = 排除区(这块不找脸)；不接模型 = 直接手遮框 · 拖【边缘】缩放 · 拖【中心】移动",
        tipEn: "Red box: with model = exclusion zone; without model = manual overlay · Drag EDGE / CENTER",
    });
}
function xhBox_setup(node, N) {
    if (node._xhBBox) return;                         // 幂等
    const wrap = document.createElement("div");
    wrap.style.cssText = "width:100%;padding:6px 8px;box-sizing:border-box;background:#141414;border-radius:8px;";
    const stage = document.createElement("div");
    stage.style.cssText = "position:relative;width:100%;min-height:140px;background:#202020;border-radius:6px;overflow:hidden;line-height:0;";
    const cv = document.createElement("canvas");
    cv.width = 320; cv.height = 213;
    cv.style.cssText = "width:100%;height:auto;display:block;background:#202020;border-radius:6px;";
    const ov = document.createElement("div");
    ov.style.cssText = "position:absolute;left:0;top:0;width:100%;height:100%;touch-action:none;cursor:crosshair;";
    const boxEl = document.createElement("div");
    boxEl.style.cssText = "position:absolute;box-sizing:border-box;background:" + N.bg + ";border:2px solid " + N.border + ";";
    ov.appendChild(boxEl);
    const mkH = () => {
        const d = document.createElement("div");
        d.style.cssText = "position:absolute;width:11px;height:11px;margin:-6px 0 0 -6px;background:#fff;border:1px solid " + N.border + ";box-sizing:border-box;cursor:nwse-resize;";
        return d;
    };
    const hEl = { tl: mkH(), tr: mkH(), bl: mkH(), br: mkH() };
    for (const k in hEl) ov.appendChild(hEl[k]);
    const tip = document.createElement("div");
    tip.style.cssText = "color:#8a93a6;font:11px sans-serif;padding:4px 2px 0;text-align:center;line-height:1.4;";
    stage.appendChild(cv); stage.appendChild(ov);
    wrap.appendChild(stage); wrap.appendChild(tip);

    const ed = node._xhBBox = { img: null, url: null, imgW: 0, imgH: 0, box: null, mode: null, ax: null, ay: null, last: null, cv, dead: false, miss: 0 };

    try {
        node.addDOMWidget(N.dom, "custom", wrap, {
            serialize: false, hideOnZoom: false,
            getMinHeight: () => Math.round((cv.height || 200) + 34),
        });
    } catch (e) { console.warn("[XH] 区域限定框编辑器挂载失败:", e); }

    const orm = node.onRemoved;
    node.onRemoved = function () { ed.dead = true; return orm ? orm.apply(this, arguments) : undefined; };

    function refWH() {
        // 坐标系：优先已加载预览图真实尺寸；否则手动宽高；否则 1536×1024 默认
        if (ed.imgW && ed.imgH) return { w: ed.imgW, h: ed.imgH };
        const wW = N.refW ? xhSM_getW(node, N.refW) : null;
        const wH = N.refH ? xhSM_getW(node, N.refH) : null;
        const mw = wW ? Number(wW.value) : 0, mh = wH ? Number(wH.value) : 0;
        if (mw > 0 && mh > 0) return { w: mw, h: mh };
        return { w: 1536, h: 1024 };
    }
    function fit() {
        const W = Math.max(160, Math.round(wrap.clientWidth) - 16);
        const r = refWH();
        const H = Math.max(90, Math.round(W * r.h / r.w));
        if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    }
    function clampF(v) { return Math.max(0, Math.min(1, v)); }

    function draw() {
        const W = cv.width || 320, H = cv.height || 213;
        const ctx = cv.getContext("2d");
        if (!ctx) return;
        ctx.fillStyle = "#202020"; ctx.fillRect(0, 0, W, H);
        if (ed.img && ed.imgW) { try { ctx.drawImage(ed.img, 0, 0, W, H); } catch (e) {} }
        // 网格
        ctx.strokeStyle = "rgba(255,255,255,.22)"; ctx.lineWidth = 1;
        const cols = 8, rows = Math.max(4, Math.round(cols * (H / W)));
        for (let i = 0; i <= cols; i++) { const x = W * i / cols; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
        for (let j = 0; j <= rows; j++) { const y = H * j / rows; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
        // 中心十字参考
        ctx.strokeStyle = "rgba(58,209,122,.45)"; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(W / 2, 0); ctx.lineTo(W / 2, H); ctx.moveTo(0, H / 2); ctx.lineTo(W, H / 2); ctx.stroke();
        // 状态行（每帧重绘，切 EN 也跟着翻）
        const R = refWH();
        const wCX = xhSM_getW(node, N.cx), wCY = xhSM_getW(node, N.cy);
        const wBW = xhSM_getW(node, N.w), wBH = xhSM_getW(node, N.h);
        const cxT = Math.round((Number(wCX && wCX.value) || 0) * 100);
        const cyT = Math.round((Number(wCY && wCY.value) || 0) * 100);
        const bwT = Math.round((Number(wBW && wBW.value) || 0) * 100);
        const bhT = Math.round((Number(wBH && wBH.value) || 0) * 100);
        ctx.fillStyle = "rgba(0,0,0,.55)"; ctx.fillRect(0, H - 18, W, 18);
        ctx.fillStyle = "#c9d1e0"; ctx.font = "11px sans-serif"; ctx.textAlign = "left";
        const zh = (window.XH_LANG || "zh") === "zh";
        ctx.fillText(zh
            ? `参考 ${R.w}×${R.h} · 中心 ${cxT}%,${cyT}% · 区域 ${bwT}%×${bhT}%`
            : `Ref ${R.w}×${R.h} · Center ${cxT}%,${cyT}% · Region ${bwT}%×${bhT}%`, 6, H - 5);
    }

    function syncShape() {
        const W = cv.width || 320, H = cv.height || 213;
        const wCX = xhSM_getW(node, N.cx), wCY = xhSM_getW(node, N.cy);
        const wBW = xhSM_getW(node, N.w), wBH = xhSM_getW(node, N.h);
        const cx = Number(wCX && wCX.value) || 0, cy = Number(wCY && wCY.value) || 0;
        const bw = Number(wBW && wBW.value) || 0, bh = Number(wBH && wBH.value) || 0;
        if (!(bw > 0 && bh > 0)) { boxEl.style.display = "none"; for (const k in hEl) hEl[k].style.display = "none"; ed.box = null; return; }
        const b = { x: cx * W - bw * W / 2, y: cy * H - bh * H / 2, w: bw * W, h: bh * H };
        ed.box = b;
        const zh2 = (window.XH_LANG || "zh") === "zh";
        tip.textContent = zh2 ? N.tipZh : N.tipEn;
        boxEl.style.display = "block";
        boxEl.style.left = (b.x / W * 100) + "%";
        boxEl.style.top = (b.y / H * 100) + "%";
        boxEl.style.width = (b.w / W * 100) + "%";
        boxEl.style.height = (b.h / H * 100) + "%";
        const hp = { tl: [0, 0], tr: [100, 0], bl: [0, 100], br: [100, 100] };
        for (const k in hEl) {
            hEl[k].style.display = "block";
            hEl[k].style.left = hp[k][0] + "%";
            hEl[k].style.top = hp[k][1] + "%";
        }
    }

    function ensureImg() {
        const url = xhSM_srcURL(node);
        if (!url || url === ed.url) return;
        ed.url = url;
        const im = new Image();
        im.crossOrigin = "anonymous";
        im.onload = () => { ed.img = im; ed.imgW = im.naturalWidth; ed.imgH = im.naturalHeight; fit(); };
        im.onerror = () => { ed.img = null; };
        im.src = url;
    }

    if (typeof ResizeObserver !== "undefined") { try { new ResizeObserver(() => fit()).observe(wrap); } catch (e) {} }
    // 🔴 循环永不停：DOM widget 异步挂载，早期 isConnected=false 绝不能 return 掉循环
    fit(); draw(); syncShape();
    (function loop() {
        if (ed.dead) return;
        try {
            if (wrap.isConnected) { ed.miss = 0; ensureImg(); fit(); draw(); syncShape(); }
            else if (++ed.miss > 3600) { ed.dead = true; return; }
        } catch (e) {}
        requestAnimationFrame(loop);
    })();

    function pos(e) {
        const r = ov.getBoundingClientRect();
        return [(e.clientX - r.left) / (r.width || 1) * (cv.width || 320), (e.clientY - r.top) / (r.height || 1) * (cv.height || 213)];
    }
    function toFrac(mx, my) { const W = cv.width || 320, H = cv.height || 213; return { x: mx / W, y: my / H }; }

    // 画布 pointerdown：点空白/框外 → 中心移到点，进入移动模式
    ov.addEventListener("pointerdown", (e) => {
        const [mx, my] = pos(e);
        const p = toFrac(mx, my);
        const wCX = xhSM_getW(node, N.cx), wCY = xhSM_getW(node, N.cy);
        xhSM_setW(wCX, clampF(p.x));
        xhSM_setW(wCY, clampF(p.y));
        ed.mode = "move"; ed.last = [mx, my];
        try { ov.setPointerCapture(e.pointerId); } catch (er) {}
        syncShape(); e.preventDefault();
    });
    // 框内 pointerdown：边缘→缩放(对边锚定)，中心区→移动
    boxEl.addEventListener("pointerdown", (e) => {
        const b = ed.box; if (!b) return;
        const [mx, my] = pos(e);
        const fx = (mx - b.x) / (b.w || 1), fy = (my - b.y) / (b.h || 1);
        const edge = Math.max(10, Math.min(b.w, b.h) * 0.3);
        const nearL = Math.abs(mx - b.x) < edge, nearR = Math.abs(mx - (b.x + b.w)) < edge;
        const nearT = Math.abs(my - b.y) < edge, nearB = Math.abs(my - (b.y + b.h)) < edge;
        const doX = nearL || nearR, doY = nearT || nearB;
        if (doX || doY) {
            ed.mode = "resize";
            ed.ax = doX ? (nearL ? b.x + b.w : b.x) : null;     // 锚点 = 对边(px)，move 时转比例
            ed.ay = doY ? (nearT ? b.y + b.h : b.y) : null;
        } else {
            ed.mode = "move";
        }
        ed.last = [mx, my];
        try { ov.setPointerCapture(e.pointerId); } catch (er) {}
        e.stopPropagation(); e.preventDefault();
    });
    // 悬停光标反馈
    boxEl.addEventListener("pointermove", (e) => {
        if (ed.mode) return;
        const b = ed.box; if (!b) return;
        const [mx, my] = pos(e);
        const edge = Math.max(10, Math.min(b.w, b.h) * 0.3);
        const nearL = Math.abs(mx - b.x) < edge, nearR = Math.abs(mx - (b.x + b.w)) < edge;
        const nearT = Math.abs(my - b.y) < edge, nearB = Math.abs(my - (b.y + b.h)) < edge;
        const doX = nearL || nearR, doY = nearT || nearB;
        boxEl.style.cursor = (doX && doY) ? ((nearL === nearT) ? "nwse-resize" : "nesw-resize")
                             : doX ? "ew-resize" : doY ? "ns-resize" : "move";
    });
    for (const k in hEl) {
        hEl[k].addEventListener("pointerdown", (e) => {
            const b = ed.box; if (!b) return;
            const [mx, my] = pos(e);
            const opp = { tl: [b.x + b.w, b.y + b.h], tr: [b.x, b.y + b.h], bl: [b.x + b.w, b.y], br: [b.x, b.y] }[k];
            ed.mode = "resize";
            ed.ax = opp[0]; ed.ay = opp[1];
            ed.last = [mx, my];
            try { ov.setPointerCapture(e.pointerId); } catch (er) {}
            e.stopPropagation(); e.preventDefault();
        });
    }
    ov.addEventListener("pointermove", (e) => {
        if (!ed.mode) return;
        const [mx, my] = pos(e);
        const p = toFrac(mx, my), lp = toFrac(ed.last[0], ed.last[1]);
        const wCX = xhSM_getW(node, N.cx), wCY = xhSM_getW(node, N.cy);
        const wBW = xhSM_getW(node, N.w), wBH = xhSM_getW(node, N.h);
        if (ed.mode === "move") {
            xhSM_setW(wCX, clampF((Number(wCX.value) || 0) + (p.x - lp.x)));
            xhSM_setW(wCY, clampF((Number(wCY.value) || 0) + (p.y - lp.y)));
        } else {
            const W = cv.width || 320, H = cv.height || 213;
            if (ed.ax !== null && ed.ax !== undefined) {
                const axf = ed.ax / W;
                xhSM_setW(wCX, clampF((p.x + axf) / 2));
                xhSM_setW(wBW, Math.max(0.01, Math.min(1, Math.abs(p.x - axf))));
            }
            if (ed.ay !== null && ed.ay !== undefined) {
                const ayf = ed.ay / H;
                xhSM_setW(wCY, clampF((p.y + ayf) / 2));
                xhSM_setW(wBH, Math.max(0.01, Math.min(1, Math.abs(p.y - ayf))));
            }
        }
        ed.last = [mx, my];
        syncShape(); e.preventDefault();
    });
    const end = () => { ed.mode = null; ed.ax = null; ed.ay = null; };
    ov.addEventListener("pointerup", end);
    ov.addEventListener("pointercancel", end);
    ov.addEventListener("pointerleave", end);
}

app.registerExtension({
    name: "XH.ImageTools.FamilyUI",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (!isXHNode(nodeData.name)) return;
        xhSM_attach(nodeType);  // 形状遮罩覆盖：挂可视化拖拽编辑器（非该节点自动早退）

        const origOnCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = origOnCreated?.apply(this, arguments);
            try {
                if (normalizeType(nodeData.name) === "XHImageBatchMulti") {
                    setupDynamicInputs(this, {
                        type: "IMAGE",
                        prefix: "image_",
                        slotOptions: { shape: 7 },
                    });
                }
                let appendNodes = [];
                let prependNodes = [];
                if (normalizeType(nodeData.name) === "XHShapeMaskOverlay") {
                    const ctl = buildFillColorControl(this);   // 工具条右侧加「填充色」色块
                    if (ctl) appendNodes.push(ctl);
                }
                if (normalizeType(nodeData.name) === "XHSmartFaceMask") {
                    const ctl = buildSMFColorControl(this);    // 工具条右侧加「遮挡色 / 排除块色」色板
                    if (ctl) appendNodes.push(ctl);
                    // ⚙ 齿轮（家族通用件 makeGearBtn）：排工具条最左，收起少动的高级参数
                    const gear = makeGearBtn({
                        collapsed: true,
                        titleFn: (col) => (col ? "⚙ 展开高级参数" : "⚙ 收起高级参数"),
                        onToggle: (col) => setSMFCollapsed(this, col),
                    });
                    this._xhSMFGear = gear;
                    prependNodes.push(gear);
                }
                applyLangToNode(this);
                makeXHToolbar(this, { appendNodes, prependNodes });
                // 默认收起（只对遮脸）：面板只留形状/缩放/透明度/反转/提示词这些常用的
                if (normalizeType(nodeData.name) === "XHSmartFaceMask") setSMFCollapsed(this, true);
            } catch (e) {
                console.warn("[XH ImageTools] onNodeCreated 失败:", e);
            }
            return r;
        };

        const origOnRemoved = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function () {
            releaseButtons(this);
            return origOnRemoved?.apply(this, arguments);
        };

        // 🔴 自愈：工具条 xh_ui_bar 占格导致 widgets_values 错位 → 切换工作流后下拉变红/变数字
        const origOnConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (info) {
            const r = origOnConfigure?.apply(this, arguments);
            try { fixWidgetValuesFromSaved(this, info); } catch (e) {}
            return r;
        };
    },

    async setup() {
        onLangChanged(applyLangToAll);
    },
});
