// 🎞 XH 连线流动（纯前端扩展，不是节点）
//
// 作用：让画布上的连线动起来（虚线位移 / 光点 / 呼吸 / 小球 / 箭头），纯视觉，不影响执行。
// 入口：ComfyUI 设置面板 → 「XH 工具箱 → 连线」。
//
// 🔴 2026-10-19 重要改版：从「叠加层」改成「**接管绘制**」
//   老做法是官方画完我再盖一层 ⇒ 线宽设了没用、呼吸被官方线盖住、球飘在线旁边。
//   现在：开关打开时**完全不调官方绘制**，线 + 动画由本文件一起画
//   ⇒ 线宽真实生效、呼吸可见、球/箭头就长在线上。关掉则恢复官方原样。
//
// 🔴 扩展口子：往 XH_LINK_STYLES 加一个对象就能加新风格，绘制代码不用动。
const { app } = window.comfyAPI.app;

const NS = "XH.Links";

// ★ 2026-10-20 用户纠正：ComfyUI **有**原生取色器（前端自带 ColorPicker 组件）。
//   本扩展的「图案颜色」直接用 type:"color"，交给官方渲染，不再自己注入。
const XH_USE_NATIVE_PICKER = true;

const CFG = {
    enabled: false,
    style: "虚线流动",
    speed: 40,
    width: 2,
    alpha: 0.95,
    reverse: false,
    marker: "跟随官方",   // 连线中点标记：跟随官方 / 无 / 圆 / 箭头
    debugHit: false,      // 🔧 调试：画出「可点击热区」+ 屏幕状态条，一眼定位卡在哪一环
    patternColor: "#22d3ee",  // ★ 统一图案颜色（蛇 + 文字 + 吃豆人 全用这一个；空/非法 = 跟随连线色）
    flowText: "关注小黑不迷路",  // ★ 文字流动的内容（用户自定义）
};

/**
 * 🎨 风格注册表（加风格只加对象）：
 *   name    : 设置下拉里显示的中文名
 *   dash    : 虚线 [实线, 间隔]；[] = 实线
 *   speed   : 虚线位移速度（px/秒）
 *   width   : 线宽倍率
 *   alpha   : 不透明度
 *   breathe : true = 呼吸（粗细+透明度波动）
 *   mode    : "particle" = 走粒子分支（球/箭头）
 *   shape   : "ball" | "arrow"
 *   size    : 粒子半径
 *   pcount  : 每条线几个粒子
 *   pspeed  : 粒子速度（每秒走完曲线的比例）
 *   glow    : 粒子发光
 */
const XH_LINK_STYLES = {
    dash:  { name: "虚线流动", dash: [12, 10], speed: 40, width: 1.0, alpha: 0.95, breathe: false },
    dot:   { name: "光点巡游", dash: [2, 18],  speed: 90, width: 1.6, alpha: 1.0,  breathe: false },
    pulse: { name: "呼吸脉冲", dash: [],       speed: 0,  width: 1.4, alpha: 0.75, breathe: true  },
    ball:  { name: "小球巡游", mode: "particle", shape: "ball",  size: 5, pcount: 2, pspeed: 0.35, glow: true, dash: [], width: 1.0, alpha: 0.9 },
    arrow: { name: "箭头巡游", mode: "particle", shape: "arrow", size: 7, pcount: 2, pspeed: 0.30, glow: true, dash: [], width: 1.0, alpha: 0.9 },
    // ★ 2026-10-19 新增：蛇身（长条连续沿连线爬）/ 吃豆人（黄圆张嘴+前方豆子）
    snake:  { name: "贪吃蛇", mode: "particle", shape: "snake",  size: 7, pcount: 1, pspeed: 0.18, glow: false, dash: [], width: 1.0, alpha: 0.9, segs: 46, slen: 0.26, shead: 13 },
    pacman: { name: "吃豆人", mode: "particle", shape: "pacman", size: 5, pcount: 1, pspeed: 0.24, glow: false, dash: [], width: 1.0, alpha: 0.9, beans: 0.055, prad: 14 },
    // ★ 2026-10-19 文字流动：自定义文字沿连线流动（字符按**弧长**等距排布，不因线长而挤压/稀疏）
    text:   { name: "文字流动", mode: "particle", shape: "text", size: 8, pcount: 1, pspeed: 0.16, glow: false, dash: [], width: 1.0, alpha: 0.9 },
};

// ---- 运行时 ----
let _raf = null;
let _lastFrame = 0;
let _dbgOnce = false;
let _hookTries = 0;
let _executingNodeId = null;      // 当前正在执行的节点（用于高亮）
const FRAME_MS = 33;              // ≈30fps

// ---------------- ★ 2026-10-20 性能护栏 ----------------
// 背景：用户用「文字流动」+ 彩色 emoji（小狗图案）时整个界面卡到几乎不动。
// 🔴 先说清楚：这**不是吃显存** —— Canvas 2D 是 CPU 光栅化，跟 torch / ComfyUI 的
//    VRAM 完全不搭界（模型推理的显存不会被它多占 1MB）。
//    真正在被吃掉的是**浏览器主线程（CPU 单核）+ 少量内存**：
//      · 每帧要把每个字符 fillText 一次（彩色 emoji 还要 strokeText 描边，慢 5~20 倍）
//      · 连线数 × 字符数 = 每帧的绘制次数，工作流一大就指数级上涨
//    主线程被占满 ⇒ 拖节点、点菜单全都跟着卡。
// 护栏 1：**每帧字形预算**，画满就跳过（先保证界面能动，再保证好看）
let _frameBudget = 0;
const XH_GLYPH_BUDGET = 240;   // 每帧最多画多少个字（emoji 按 6 个算，因为它贵得多）
function _resetFrameBudget() { _frameBudget = XH_GLYPH_BUDGET; }
function _takeGlyphBudget(ch) {
    const cost = _isEmoji(ch) ? 6 : 1;
    if (_frameBudget < cost) return false;
    _frameBudget -= cost;
    return true;
}

// ---------------- 工具 ----------------

function _styleLabels() {
    return Object.keys(XH_LINK_STYLES).map((k) => XH_LINK_STYLES[k].name);
}

function _resolveStyle(v) {
    if (XH_LINK_STYLES[v]) return XH_LINK_STYLES[v];
    for (const k in XH_LINK_STYLES) if (XH_LINK_STYLES[k].name === v) return XH_LINK_STYLES[k];
    return XH_LINK_STYLES.dash;
}

function _token(u) {
    return u; // 占位：后续如需高亮色可用
}

/**
 * 找官方那个「布局存储单例」（源码里叫 `X`）—— 它持有线段空间索引，
 * 官方在 `pathRenderer.drawLink()` 里调 `X.updateLinkSegmentLayout(linkId, rerouteId, {...})`。
 * 🔴 接管绘制后官方不画 ⇒ 索引为空 ⇒ `queryRenderedLinkSegmentsAtPoint` 命中不了。
 *
 * 这个单例**没有挂到全局**，只能从 canvas 一路反射找。
 */
let _layoutStoreCache = null;
function _findLayoutStore(canvas) {
    if (_layoutStoreCache) return _layoutStoreCache;
    const seen = new Set();
    const test = (o) => {
        if (!o || seen.has(o) || (typeof o !== "object" && typeof o !== "function")) return false;
        seen.add(o);
        try {
            return typeof o.updateLinkSegmentLayout === "function"
                && typeof o.queryLinkSegmentAtPoint === "function";
        } catch (e) { return false; }
    };
    // 三层：canvas 自身 → 它的 renderer → 其余直接挂载属性
    try { if (test(canvas)) return (_layoutStoreCache = canvas); } catch (e) {}
    try {
        const lr = canvas?.linkRenderer;
        if (test(lr)) return (_layoutStoreCache = lr);
        if (test(lr?.layoutStore)) return (_layoutStoreCache = lr.layoutStore);
        if (test(lr?.pathRenderer?.layoutStore)) return (_layoutStoreCache = lr.pathRenderer.layoutStore);
    } catch (e) {}
    try {
        for (const k of Object.keys(canvas || {})) {
            if (test(canvas[k])) return (_layoutStoreCache = canvas[k]);
        }
    } catch (e) {}
    return null;
}

/** 生成这条线的 Path2D。
 *  🔴🔴 2026-10-19 用户报「有的线能右键、有的不行」—— 根因：**漏了官方那15px 外推**。
 *     官方 `CanvasPathRenderer.buildLinearPath` 会把两端沿「出/入方向」各外推 15px：
 *        起点 RIGHT → x += 15   终点 LEFT → x -= 15
 *     我原来只是直线连两个点 ⇒ 命中区域比官方**少了一圈**，
 *     靠节点近的那一小段正好落在缺失的 15px 里 ⇒ 那几条点不中。
 */
function _path2dOf(seg, canvas) {
    try {
        if (typeof Path2D !== "function") return null;
        const p = new Path2D();
        const [x1, y1, x2, y2] = seg.pos;
        const mode = canvas.links_render_mode;

        // 起点朝终点方向外推，终点朝起点方向外推（官方 buildLinearPath 的 ±15）
        const dx = x2 - x1, dy = y2 - y1;
        const len = Math.hypot(dx, dy) || 1;
        const EXT = 15;   // 官方硬编码值
        const ax = x1 + (dx / len) * EXT, ay = y1 + (dy / len) * EXT;
        const bx = x2 - (dx / len) * EXT, by = y2 - (dy / len) * EXT;

        if (mode === 0) {                       // 直线
            p.moveTo(ax, ay);
            p.lineTo(bx, by);
        } else if (mode === 1) {                // 直角
            const mx = ax + (bx - ax) * 0.5;
            p.moveTo(ax, ay); p.lineTo(mx, ay); p.lineTo(mx, by); p.lineTo(bx, by);
        } else {                                // 贝塞尔（官方 offset = min(80, dist*0.25)）
            const off = Math.min(80, len * 0.25);
            const ux = dx / len, uy = dy / len;
            p.moveTo(ax, ay);
            p.bezierCurveTo(ax + ux * off, ay + uy * off,
                            bx - ux * off, by - uy * off,
                            bx, by);
        }
        return p;
    } catch (e) { return null; }
}

/** 🔴🔴 把一条线采样成折线点列。
 *
 *🔴 2026-12:37修正 —— **热区几何必须与实际绘制（_pathOf）完全一致**，
 *    之前这里另写了一套「官方 buildLinearPath 风格」的几何（±15px 外推 +
 *    min(80,len*0.25) 方向偏移），而我们自己的绘制用的是
 *    `dx = max(|Δx|*0.25, 40)` 且**没有外推** ⇒ 热区整体偏移、拐角处明显空一块。
 *  ⇒ 现在直接复用 `_pointOf`（绘制与粒子用的同一个函数），从根上杜绝再次分叉。
 *
 *    纯数学判定，与 ctx 变换无关（见 _hitLink 注释）。
 */
function _samplesOf(seg, canvas, n) {
    try {
        const N = Math.max(8, n || 32);
        const pts = [];
        for (let i = 0; i <= N; i++) {
            const p = _pointOf(seg, i / N, canvas);
            if (p && p.length >= 2) pts.push([p[0], p[1]]);
        }
        return pts;
    } catch (e) { return []; }
}

/** 线段包围盒（官方 calculateLinkBounds：留20px 余量，含贝塞尔控制点）。 */
function _boundsOf(seg, canvas) {
    const [x1, y1, x2, y2] = seg.pos;
    let minX = Math.min(x1, x2), maxX = Math.max(x1, x2);
    let minY = Math.min(y1, y2), maxY = Math.max(y1, y2);
    if (canvas.links_render_mode !== 0) {   // 贝塞尔/直角要把控制点算进去
        const dx = Math.max(Math.abs(x2 - x1) * 0.25, 40);
        minX = Math.min(minX, x1 + dx, x2 - dx);
        maxX = Math.max(maxX, x1 + dx, x2 - dx);
    }
    return { x: minX - 20, y: minY - 20, width: maxX - minX + 40, height: maxY - minY + 40 };
}

/**
 * 取端口坐标 —— **必须和官方 drawConnections 走同一个入口**。
 *
 * 🔴🔴 官方有两套槽位坐标算法，`drawConnections` 用的是 `getSlotPosition()`：
 *      if (vueNodesMode) → getVueSlotPosition → calculateVueOutputSlotPos
 *      else               → calculateOutputSlotPos
 *   Vue 模式的 y = 内容区顶部 + (slot+.7)*SLOT_H（NO_TITLE 还要再减标题栏高度），
 *   和 `node.getConnectionPos()`（经典老算法，用 node.size + slot_start_y）**不是同一个数**。
 *   ⛔ 之前用 getConnectionPos ⇒ Vue 模式下线端点偏移、没对准端口正中间。
 *
 * 优先用官方入口；万一取不到再退回 getConnectionPos 兜底。
 */
function _slotPos(canvas, node, slot, isInput) {
    // ① 官方同一入口（canvas 上有静态方法；某些版本挂在节点上）
    try {
        const Ctor = canvas && canvas.constructor;
        if (typeof Ctor?.getSlotPosition === "function") {
            const p = Ctor.getSlotPosition(node, slot, !!isInput);
            if (p && (p[0] !== undefined || p.x !== undefined)) {
                return p[0] !== undefined ? [p[0], p[1]] : [p.x, p.y];
            }
        }
        if (typeof node?.getSlotPosition === "function") {
            const p = node.getSlotPosition(slot, !!isInput);
            if (p && p[0] !== undefined) return [p[0], p[1]];
        }
    } catch (e) {}
    // ② 兜底：老接口（Vue 模式下会有偏移，只在①不可用时用）
    try {
        if (typeof node?.getConnectionPos === "function") {
            const p = node.getConnectionPos(!!isInput, slot);
            if (p) return [p[0], p[1]];
        }
    } catch (e) {}
    // ③ 🔴🔴 Reroute 专用：它没有实体端口、没有 widgets，官方槽位算法对它多半返回空
    //    ⇒ 之前含 Reroute 的连线整条被 `if (p1 && p2)` 丢掉 = **建了路由点却看不见**
    //    正解：直接取节点中心（Reroute 的连线就是从中心点出入的）。
    try {
        const isReroute = node?.type === "Reroute" || node?.comfyClass === "Reroute"
            || /reroute/i.test(String(node?.type || node?.comfyClass || ""));
        if (isReroute && Array.isArray(node.pos)) {
            const sx = (Array.isArray(node.size) && node.size[0]) ? node.size[0] : 0;
            const sy = (Array.isArray(node.size) && node.size[1]) ? node.size[1] : 0;
            return [node.pos[0] + sx / 2, node.pos[1] + sy / 2];
        }
    } catch (e) {}
    return null;
}

/** 🔴 从 link 自身携带的 reroute 信息里取锚点中心坐标。
 *
 *  官方 link 对象上有 `fromReroute` / `toReroute` 字段（源码里能见到
 *  `t.fromReroute?.id` 这种用法），里面带 reroute 节点 id 或对象。
 *  Reroute 的连线是从**中心点**出入的（没有实体端口），所以这里直接算中心。
 *  取不到就返回 null，交给调用方决定怎么办。
 */
function _rerouteAnchor(canvas, linkObj, which) {
    try {
        if (!linkObj || typeof linkObj !== "object") return null;
        const key = (which === "origin") ? "fromReroute" : "toReroute";
        let rr = linkObj[key];
        if (!rr && which === "target") rr = linkObj["toReroute"] ?? linkObj["targetReroute"];
        if (!rr && which === "origin") rr = linkObj["fromReroute"] ?? linkObj["originReroute"];
        // 可能是 id，也可能是节点对象
        let node = rr;
        if (rr && typeof rr === "object") node = (typeof rr.getNode === "function") ? rr.getNode() : rr;
        let id = null;
        if (typeof rr === "string" || typeof rr === "number") id = rr;
        else if (rr && typeof rr === "object" && rr.id !== undefined) id = rr.id;
        if (!node && id != null) {
            const _ag = _activeGraph(canvas);                      // 🔴 子图安全
            node = _ag && _ag.getNodeById ? _ag.getNodeById(id) : null;
        }
        if (!node) return null;
        if (Array.isArray(node.pos)) {
            const sx = (Array.isArray(node.size) ? node.size[0] : 0) || 0;
            const sy = (Array.isArray(node.size) ? node.size[1] : 0) || 0;
            return [node.pos[0] + sx / 2, node.pos[1] + sy / 2];
        }
        return null;
    } catch (e) { return null; }
}

/** 🔴🔴 官方 Linear（"直角"）模式的三点折线坐标 —— 严格照抄官方源码。
 *
 *  官方 `CanvasPathRenderer`：
 *  ```
 *  buildLinearPath(e,t,n,r,i){
 *      let a={x:t.x,y:t.y}, o={x:n.x,y:n.y};
 *      switch(r){ case 'right': a.x+=15; break; case 'left': a.x-=15; break; case 'up': a.y-=15; break; case 'down': a.y+=15; }
 *      switch(i){ case 'right': o.x+=15; break; case 'left': o.x-=15; break; case 'up': o.y-=15; break; case 'down': o.y+=15; }
 *      e.moveTo(t.x,t.y); e.lineTo(a.x,a.y); e.lineTo(o.x,o.y); e.lineTo(n.x,n.y)
 *  }
 *  ```
 *  ⚠️ 注意：**方向是「反着」的**（起点按 startDirection 偏移，终点按 endDirection 偏移），
 *  而且这是**斜线折线**，不是我原来写的垂直中点折线（那才是真"直角"）。
 *  🔴 2026-10-19 12:53 用户报「直线与直角跟官方反了」—— 根因就在这：
 *     我 mode=1 画垂直折线、mode=0 画直线，而官方 mode=0 才是直线(Straight)、
 *     mode=1 画的是带 15px 外推的斜线折线(Linear)。几何不同 ⇒ 观感像"反了"。
 *
 *  @param x1,y1,x2,y2 端点坐标
 *  @param startOff 输出端外推偏移 [dx,dy]
 *  @param endOff   输入端外推偏移 [dx,dy]
 */
function _linearPts(x1, y1, x2, y2, startOff, endOff) {
    const ax = x1 + (startOff ? startOff[0] : 0);
    const ay = y1 + (startOff ? startOff[1] : 0);
    const bx = x2 + (endOff ? endOff[0] : 0);
    const by = y2 + (endOff ? endOff[1] : 0);
    return [
        [x1, y1],
        [ax, ay],
        [bx, by],
        [x2, y2],
    ];
}

/** 🔴 推断某端的「出/入方向」（官方 convertDirection 的简化版）。
 *  节点在右侧（x2 > x1）时输出往右、输入往左；反之亦然；同列则按 y 差。
 */
function _dirOffsets(x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    if (Math.abs(dx) >= Math.abs(dy)) {
        return dx >= 0 ? [[15, 0], [-15, 0]] : [[-15, 0], [15, 0]];
    }
    return dy >= 0 ? [[0, 15], [0, -15]] : [[0, -15], [0, 15]];
}

/** 画一条连线的路径（跟随官方「连线渲染模式」）。
 *  🔴 枚举对照（官方 rl 枚举，settingStore-CUTKo1HX.js）：
 *     -1 HIDDEN_LINK / 0 STRAIGHT_LINK / 1 LINEAR_LINK / 2 SPLINE_LINK
 */
/** 🔴🔴 补画 Reroute（路由点）+ 填充 canvas._visibleReroutes。
 *
 *  官方源码（settingStore-CUTKo1HX.js，drawConnections 末尾）：
 *  ```js
 *  let p = this._visibleReroutes; p.clear();
 *  a.sort((e,t) => e.linkIds.size - t.linkIds.size);
 *  for (let t of a) p.add(t), ..., t.draw(e, this._pattern),
 *                            this.pointer.isDown || t.drawSlots(e);
 *  ```
 *  我们接管 drawConnections 后这段不执行 ⇒ Reroute 圆点 / 隐藏接口 / 命中 / 拖拽全废。
 *
 *  ✅ 做法：从 `graph.reroutes`（Map）取全部对象 → 塞进 `_visibleReroutes`
 *     → 调它们自己的 draw / drawSlots。**一个像素都不自己画**，外观天然与官方一致。
 * 官方 graph 结构（源码实证）：
 *      reroutesInternal = new Map;  get reroutes(){ return this.reroutesInternal }
 *      getReroute(e){ return e == null ? void 0 : this.reroutes.get(e) }
 *      *positionableItems(){ yield 各节点; yield 各组; yield this.reroutes.values() }
 */
function _renderReroutes(ctx, canvas) {
    const graph = _activeGraph(canvas);        // 🔴 子图安全：进子图就用子图的图对象
    if (!graph) return;

    // ① 收集全部 Reroute 对象
    let list = null;
    try {
        const m = graph.reroutes;
        if (m && typeof m.values === "function") list = Array.from(m.values());
    } catch (e) {}
    if (!list || !list.length) {
        // 兜底：某些版本可能挂在别处
        try {
            if (Array.isArray(graph._reroutes)) list = graph._reroutes;
        } catch (e) {}
    }
    if (!list || !list.length) {
        // 🔴 关键：即使没有 Reroute，也必须把 _visibleReroutes 置成空 Set，
        //    否则官方残留的旧引用会让命中判定错乱。
        try { if (canvas._visibleReroutes && canvas._visibleReroutes.clear) canvas._visibleReroutes.clear(); } catch (e) {}
        return;
    }

    // ② 过滤掉不可见的（不在视口内），并按 linkIds 数量升序（官方 a.sort 的等价处理）
    const vis = [];
    for (const r of list) {
        try {
            if (!r) continue;
            const p = r.pos;
            if (!p || p[0] === undefined) continue;
            const va = canvas.visible_area;
            if (va && (p[0] < va[0] - 40 || p[0] > va[2] + 40 || p[1] < va[1] - 40 || p[1] > va[3] + 40)) continue;
            vis.push(r);
        } catch (e) {}
    }
    vis.sort((a, b) => {
        const la = (a && a.linkIds && a.linkIds.size) || 0;
        const lb = (b && b.linkIds && b.linkIds.size) || 0;
        return la - lb;
    });

    // ③ 填充 _visibleReroutes —— 这一步直接决定官方的命中 / 拖拽 / 悬停能否工作
    try {
        if (canvas._visibleReroutes && typeof canvas._visibleReroutes.clear === "function") {
            canvas._visibleReroutes.clear();
            for (const r of vis) canvas._visibleReroutes.add(r);
        }
    } catch (e) {}

    // ④ 让每个 Reroute 自己更新接口显隐（鼠标靠近才显示左右小接口）
    const gm = canvas.graph_mouse;
    for (const r of vis) {
        try {
            if (typeof r.updateVisibility === "function" && Array.isArray(gm)) r.updateVisibility(gm);
        } catch (e) {}
    }

    // ⑤ 补画：拖拽时显示吸附参考圈（官方同款）
    try {
        if (canvas.isDragging && canvas._snapToGrid && typeof canvas.drawSnapGuide === "function") {
            for (const r of vis) {
                if (canvas.selectedItems && canvas.selectedItems.has(r)) {
                    try { canvas.drawSnapGuide(ctx, r, 3, { offsetToSlot: true }); } catch (e) {}
                }
            }
        }
    } catch (e) {}

    // ⑥ 🔴 核心：调官方自己的绘制 —— 圆点 + 左右隐藏接口
    for (const r of vis) {
        try {
            if (typeof r.draw === "function") r.draw(ctx, canvas._pattern);
        } catch (e) {}
    }
    if (!(canvas.pointer && canvas.pointer.isDown)) {
        for (const r of vis) {
            try {
                if (typeof r.drawSlots === "function") r.drawSlots(ctx);
            } catch (e) {}
        }
    }
}

function _pathOf(ctx, seg, canvas) {
    const [x1, y1, x2, y2] = seg.pos;
    const mode = canvas.links_render_mode;
    ctx.beginPath();
    if (mode === 0) {                       // STRAIGHT：真·直线
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
    } else if (mode === 1) {// LINEAR：官方三点折线（带 15 外推的斜线）
        const [so, eo] = _dirOffsets(x1, y1, x2, y2);
        const pts = _linearPts(x1, y1, x2, y2, so, eo);
        ctx.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    } else {                                // SPLINE：贝塞尔（默认）
        const dx = Math.max(Math.abs(x2 - x1) * 0.25, 40);
        ctx.moveTo(x1, y1);
        ctx.bezierCurveTo(x1 + dx, y1, x2 - dx, y2, x2, y2);
    }
}

/** 曲线上 t∈[0,1] 处的点（跟随渲染模式，保证粒子落在线上）。 */
function _pointOf(seg, t, canvas) {
    const [x1, y1, x2, y2] = seg.pos;
    const mode = canvas.links_render_mode;
    if (mode === 0) {
        return [x1 + (x2 - x1) * t, y1 + (y2 - y1) * t];
    }
    if (mode === 1) {
        // 🔴 官方 Linear 是三点折线：起点 → 起点外推 → 终点外推 → 终点
        //    按**弧长近似**分段取点，保证粒子/热区与绘制几何一致。
        const [so, eo] = _dirOffsets(x1, y1, x2, y2);
        const pts = _linearPts(x1, y1, x2, y2, so, eo);
        const segs = [
            [pts[0], pts[1]], [pts[1], pts[2]], [pts[2], pts[3]],
        ].filter(([a, b]) =>
            (Math.abs(a[0] - b[0]) > 1e-6) || (Math.abs(a[1] - b[1]) > 1e-6));
        if (!segs.length) return [x1, y1];
        const lens = segs.map(([a, b]) => Math.hypot(b[0] - a[0], b[1] - a[1]));
        const total = lens.reduce((s, v) => s + v, 0) || 1;
        let want = t * total;
        for (let i = 0; i < segs.length; i++) {
            if (want <= lens[i] || i === segs.length - 1) {
                const k = lens[i] > 0 ? Math.min(1, want / lens[i]) : 0;
                const [a, b] = segs[i];
                return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
            }
            want -= lens[i];
        }
        return [x2, y2];
    }
    const dx = Math.max(Math.abs(x2 - x1) * 0.25, 40);
    const mt = 1 - t;
    return [
        mt * mt * mt * x1 + 3 * mt * mt * t * (x1 + dx) + 3 * mt * t * t * (x2 - dx) + t * t * t * x2,
        mt * mt * mt * y1 + 3 * mt * mt * t * y1 + 3 * mt * t * t * y2 + t * t * t * y2,
    ];
}

/**
 * 🔴 取「当前画布实际在显示的那个图」——2026-10-21 修「子图里的线检测不到」。
 *
 * 背景：ComfyUI 的 **Subgraph（子图）** 内部有自己的一套 links（子图对象挂在
 *   `graph.subgraphs`（Map）上，这一点同包 `xh_group.js` / `xh_setget.js` 已验证）。
 *   以前本文件一律读 `canvas.graph.links` ⇒ 那永远是**主图**的连线：
 *     ① 进入子图编辑时，画布显示的是子图内容，但读到的还是主图 links ⇒ 子图内一条都画不出；
 *     ② 子图内的线也因此进不了命中表 ⇒ 右键菜单 / 悬停 / 断线全部失效。
 *
 * 修法：优先取「当前打开的子图」（canvas 上指向子图的字段），取不到才回退主图。
 *   · 若前端是把 app.graph 直接切成子图，那 canvas.graph 本身就是子图 ⇒ 本函数原样返回，无害。
 *   · 若前端是把子图挂在 canvas.subgraph（或同类字段）上 ⇒ 这里能正确命中子图。
 * ⚠️ 全程防御：任何一个候选拿不到 / 不是图对象，就静默跳过，绝不破坏原有主图逻辑。
 */
function _activeGraph(canvas) {
    if (!canvas) return null;
    const g = canvas.graph || null;
    const cands = [canvas.subgraph, canvas.currentSubgraph, canvas._subgraph, canvas.openSubgraph];
    for (const c of cands) {
        if (!c || c === g) continue;
        if (!c.links) continue;                 // 不是图对象（没连线表）就别认
        return c;
    }
    return g;
}

/**
 * 收集所有连线（坐标 + 类型 + 两端节点/槽位 id）。
 *🔴 坐标**每帧实时算**，且走官方同一入口 `getSlotPosition`（Vue/经典两套算法，见 _slotPos 注释）。
 * 兜底：graph.links 一条都取不到时，才退回 visible_links 的缓存坐标（可能是旧值）。
 */
function _collectLinkSegments(canvas) {
    const graph = _activeGraph(canvas);        // 🔴 子图安全：进子图就用子图的图对象
    if (!graph) return [];
    const out = [];

    const links = graph.links || {};
    const getNode = typeof graph.getNodeById === "function"
        ? (id) => graph.getNodeById(id) : () => null;

    for (const id in links) {
        const l = links[id];
        if (!l) continue;
        const oid = Array.isArray(l) ? l[0] : l.origin_id;
        const osl = Array.isArray(l) ? l[1] : l.origin_slot;
        const tid = Array.isArray(l) ? l[2] : l.target_id;
        const tsl = Array.isArray(l) ? l[3] : l.target_slot;
        const typ = Array.isArray(l) ? l[4] : l.type;
        const o = getNode(oid);
        const t = getNode(tid);
        // 🔴 被隐藏的线直接跳过（Hide Link 由我们自己实现：置 link.hidden）
        //    官方是 hideLink(app,wid,id)→ store.patch，走闭包反射不到 ⇒ 我们自己来，
        //    反正绘制是我们接管的，绘制时跳过 = 视觉上立刻消失。
        const _hid = (Array.isArray(l) ? null : l.hidden);
        if (_hid === true) continue;
        // 🔴 坐标每帧实时算，且走官方同一入口（见 _slotPos 注释：Vue 模式有独立算法）
        // 🔴🔴 Reroute（路由点）**不是节点**，不在 getNodeById 里，但**它的 link 确实在 graph.links 中**
        //    （createReroute 会把原 link 拆成两段真实 link）。所以这一段也能处理到它们，
        //    只要把「哪一端是 Reroute」判断出来，该端坐标直接用圆心 rr.pos。
        const oIsRr = _isRerouteEnd(canvas, oid);
        const tIsRr = _isRerouteEnd(canvas, tid);
        const rrCenter = (() => {
            if (!oIsRr && !tIsRr) return null;
            try {
                const _agR = _activeGraph(canvas);                 // 🔴 子图安全
                const rr = _agR && _agR.getReroute ? _agR.getReroute(oIsRr ? oid : tid) : null;
                return (rr && rr.pos) ? rr.pos : null;
            } catch (e) { return null; }
        })();
        let p1 = oIsRr && rrCenter ? [rrCenter[0], rrCenter[1]]
            : (o ? _slotPos(canvas, o, osl, false) : null);
        let p2 = tIsRr && rrCenter ? [rrCenter[0], rrCenter[1]]
            : (t ? _slotPos(canvas, t, tsl, true) : null);
        if (!p1) p1 = _rerouteAnchor(canvas, Array.isArray(l) ? null : l, "origin");
        if (!p2) p2 = _rerouteAnchor(canvas, Array.isArray(l) ? null : l, "target");
        if (!p1 || !p2) continue;
        {
            out.push({
                id, pos: [p1[0], p1[1], p2[0], p2[1]],
                type: typ, originId: oid, targetId: tid,
                noMarker: oIsRr || tIsRr,
                originSlot: osl, targetSlot: tsl,
            });
        }
    }

    /** 🔴 判断某个「节点 id」其实是不是一个 Reroute。
 *  Reroute 不在 `graph.nodes` / `getNodeById` 里，只在 `graph.reroutes` 里，
 *  而且它的 id 与普通节点 id 是同一套命名空间（源码：`getReroute(e){ return this.reroutes.get(e) }`）。
 */
function _isRerouteEnd(canvas, nodeId) {
    try {
        if (nodeId == null) return false;
        const g = _activeGraph(canvas);          // 🔴 子图安全
        if (!g) return false;
        if (typeof g.getReroute === "function") return !!g.getReroute(nodeId);
        const m = g.reroutes;
        return !!(m && typeof m.has === "function" && m.has(nodeId));
    } catch (e) { return false; }
}

/** 🔴🔴 兜底：补 Reroute 相关连线段（**仅当 graph.links 那轮没画到时才跑**）。
  *
  *  ⚠️ 为什么需要兜底：`createReroute` 通常会把原 link 拆成两段**真实 link**
  *    放进 `graph.links`，所以上面主循环已经能画到。
  *    但部分版本/场景（floating link、拖拽中的临时线）只会出现在
  *    `rr.linkIds` 里，`graph.links` 中查不到 ⇒ 会「加完路由点线就断」。
  *  ⇒ 所以这里**按 lid 去重**：`graph.links` 已经画过的 link id 绝不重复画。
  *  ⚠️ 别在这里重复绘制已存在的 link —— 会出现重影 + 标记翻倍。
  */
function _appendRerouteSegments(out, canvas) {
    try {
        const done = new Set(out.map(x => String(x.id)));
        const rmap = (_activeGraph(canvas) || {}).reroutes;   // 🔴 子图安全
        if (!rmap || typeof rmap.values !== "function") return;
        for (const rr of rmap.values()) {
            if (!rr) continue;
            const rpos = rr.pos;
            if (!rpos || rpos[0] === undefined) continue;
            const lset = rr.linkIds;
            if (!lset) continue;
            const ids = (typeof lset.values === "function") ? Array.from(lset.values()) : Array.from(lset);
            for (const lid of ids) {
                const key = String(lid);
                if (done.has(key)) continue;          // 🔴 去重：graph.links 里已有就跳过
                const _ag = _activeGraph(canvas);     // 🔴 子图安全
                const lk = _ag && _ag.getLink ? _ag.getLink(lid) : null;
                if (!lk || typeof lk !== "object") continue;
                if (lk.hidden === true) continue;
                const oN = _ag && _ag.getNodeById ? _ag.getNodeById(lk.origin_id) : null;
                const tN = _ag && _ag.getNodeById ? _ag.getNodeById(lk.target_id) : null;
                const oIsRr = _isRerouteEnd(canvas, lk.origin_id);
                const tIsRr = _isRerouteEnd(canvas, lk.target_id);
                const a = oIsRr ? [rpos[0], rpos[1]] : (oN ? _slotPos(canvas, oN, lk.origin_slot, false) : null);
                const b = tIsRr ? [rpos[0], rpos[1]] : (tN ? _slotPos(canvas, tN, lk.target_slot, true) : null);
                if (!a || !b) continue;
                done.add(key);
                out.push({
                    id: key, pos: [a[0], a[1], b[0], b[1]],
                    type: lk.type, originId: lk.origin_id, targetId: lk.target_id,
                    originSlot: lk.origin_slot, targetSlot: lk.target_slot,
                    noMarker: oIsRr || tIsRr,
                });
            }
        }
    } catch (e) {}
}

    // 🔴 兜底补 Reroute 线段（内部按 link id 去重，不会与上面重复）
    _appendRerouteSegments(out, canvas);

    // 兜底：graph.links 里一条都取不到（极少数异常节点）时，才退回 visible_links 的缓存坐标。
    // ⚠️ 这只是保底，坐标可能是旧的 —— 但至少线不会整条消失。
    if (out.length) return out;
    for (const l of (canvas.visible_links || [])) {
        if (l && l._pos) {
            out.push({
                id: l.id, pos: l._pos, type: l.type,
                originId: l.origin_id, targetId: l.target_id,
                originSlot: l.origin_slot, targetSlot: l.target_slot,
            });
        }
    }
    return out;
}

/**
 * 读官方「连线中点标记」设置：`Comfy.Graph.LinkMarkers`（None / Circle / Arrow，默认 Circle）。
 * 🔴 接管绘制后官方不再画它 ⇒ 必须自己补，否则用户平时看到的那个中点就消失了。
 */
let _markerModeCache = null;
let _markerModeAt = 0;
function _markerMode() {
    const now = performance.now();
    if (_markerModeCache !== null && now - _markerModeAt < 1000) return _markerModeCache;  // 1 秒缓存

    let v = null;
    // ① 我们自己的设置优先（只要不是「跟随官方」）
    if (CFG.marker && CFG.marker !== "跟随官方") {
        v = CFG.marker;
    } else {
        // ② 跟随官方设置 Comfy.Graph.LinkMarkers
        try {
            const raw = app.ui?.settings?.getSettingValue?.("Comfy.Graph.LinkMarkers");
            if (raw !== undefined && raw !== null) v = String(raw);
        } catch (e) {}
        if (!v) v = "圆";
    }

    _markerModeCache = v;
    _markerModeAt = now;
    return v;
}

/** 在曲线正中间画官方的那个标记（圆点 / 箭头）。 */
function _drawMarker(ctx, seg, canvas, mode) {
    // 🔴 用**白名单**判断：只有明确是「圆 / 箭头」才画，其余（无 / none / 0 / 空）一律不画。
    //   之前用 `/none/i` 黑名单，中文界面的「无」和枚举数字 0 都匹配不到 ⇒ 设了"无"还在画白点。
    const m = String(mode).toLowerCase();
    const isArrow = m.includes("arrow") || m.includes("箭头") || m === "2";
    const isCircle = m.includes("circle") || m.includes("圆") || m === "1";
    if (!isArrow && !isCircle) return;

    const [x, y] = _pointOf(seg, 0.5, canvas);

    ctx.save();
    ctx.setLineDash([]);
    ctx.shadowBlur = 0;
    if (isArrow) {
        const [x2, y2] = _pointOf(seg, Math.min(1, 0.52), canvas);
        const ang = Math.atan2(y2 - y, x2 - x);
        ctx.translate(x, y);
        ctx.rotate(ang);
        ctx.beginPath();
        ctx.moveTo(5, 0);
        ctx.lineTo(-5, 4);
        ctx.lineTo(-5, -4);
        ctx.closePath();
        ctx.fillStyle = "#FFFFFF";
        ctx.fill();
    } else {
        ctx.beginPath();
        ctx.arc(x, y, 3, 0, Math.PI * 2);
        ctx.fillStyle = "#FFFFFF";
        ctx.fill();
    }
    ctx.restore();
}

// ★ 2026-10-19 新增风格：贪吃蛇 / 吃豆人 两个专用绘制
//   复用 _pointOf(seg,t)：t 递增 = 起点→终点（数据流方向）。

// ★ 2026-10-19 统一配色：只留**一个**颜色（用户明确要求别越整越多），
//   蛇 / 文字流动 / 吃豆人 全部用它；留空或填非法值 = 跟随连线自身颜色。
function _normHex(v, fallback) {
    try {
        let s = String(v == null ? "" : v).trim();
        if (!s) return fallback || null;
        if (!s.startsWith("#")) s = "#" + s;
        if (/^#[0-9a-fA-F]{6}$/.test(s)) return s.toLowerCase();
        if (/^#[0-9a-fA-F]{3}$/.test(s)) return ("#" + s[1] + s[1] + s[2] + s[2] + s[3] + s[3]).toLowerCase();
        return fallback || null;
    } catch (e) { return fallback || null; }
}
function _patternColor(base) {
    return _normHex(CFG.patternColor, null) || base || "#22d3ee";
}

// ★ 2026-10-20 HSV ⇄ HEX（内嵌取色板用：不再调系统取色对话框，见 _installColorPicker）
function _hexToHsv(hex) {
    const h = _normHex(hex, "#22d3ee").slice(1);
    const r = parseInt(h.slice(0, 2), 16) / 255, g = parseInt(h.slice(2, 4), 16) / 255, b = parseInt(h.slice(4, 6), 16) / 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    let hh = 0;
    if (d !== 0) {
        if (mx === r) hh = ((g - b) / d) % 6;
        else if (mx === g) hh = (b - r) / d + 2;
        else hh = (r - g) / d + 4;
        hh *= 60; if (hh < 0) hh += 360;
    }
    return [hh, mx === 0 ? 0 : d / mx, mx];
}
function _hsvToHex(hh, s, v) {
    const c = v * s, x = c * (1 - Math.abs(((hh / 60) % 2) - 1)), m = v - c;
    let r = 0, g = 0, b = 0;
    if (hh < 60) { r = c; g = x; } else if (hh < 120) { r = x; g = c; } else if (hh < 180) { g = c; b = x; }
    else if (hh < 240) { g = x; b = c; } else if (hh < 300) { r = x; b = c; } else { r = c; b = x; }
    const to = (n) => ("0" + Math.round(Math.min(1, Math.max(0, n + m)) * 255).toString(16)).slice(-2);
    return "#" + to(r) + to(g) + to(b);
}

// ★ 预设色板：**照搬 ComfyUI 节点自带的颜色**（canvas.node_colors 的 groupcolor 值），
//   这样设置里的色板跟画布上右键节点选颜色看到的是同一套，观感统一。
//   red / brown / green / blue / pale_blue / cyan / purple / yellow / black
const XH_PRESET_COLORS = [
    "#aa8888", "#b06634", "#88aa88", "#8888aa", "#3f789e",
    "#88aaaa", "#a1309b", "#b58b2a", "#444444",
];
/** 颜色明暗微调（amt<0 变暗 / >0 变亮），用于蛇头描边、下颌。 */
function _shade(hex, amt) {
    try {
        const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
        if (!m) return "rgba(0,0,0,.3)";
        const n = parseInt(m[1], 16);
        const f = (c) => Math.max(0, Math.min(255, Math.round(c + 255 * amt)));
        return `rgb(${f((n >> 16) & 255)},${f((n >> 8) & 255)},${f(n & 255)})`;
    } catch (e) { return "rgba(0,0,0,.3)"; }
}
function _drawSnake(ctx, seg, canvas, col, size, spd, dir, now) {
    try {
        // ★ 2026-10-19 第二版（用户选的方案③ + 两处返工）：
        //   ① 蜿蜒：蛇身沿路径做 S 形横向摆动（蛇爬行的动势），不再是笔直一根。
        //   ② 粗细收敛：头尾半径比 15% → 58%（原 `1 - f*0.82` 尾巴只剩一点，头还 ×1.12 放大
        //      ⇒ 头重尾轻像棒槌）；整体基准 HEAD 也从 13 收到 ~7，不再那么粗。
        //   ③ 颜色：走统一图案色 _patternColor()（默认青蓝 #22d3ee；留空/非法 = 跟随连线色）。
        const N = 46, LEN = 0.32;
        // ★ 2026-10-20 用户："贪吃蛇还是太粗了，变细一半"
        //   ⇒ 基准 HEAD 从 max(5.5, size*1.05) 砍到 **max(3.0, size*0.55)**（正好约一半）。
        //   🔴 眼睛/信子/描边原来是**写死的像素值**，头一细就会戳到脑袋外面去
        //      ⇒ 全部改成按 HEAD 的比例缩放（下面眼睛那几行）。
        const HEAD = Math.max(3.0, (size || 7) * 0.55);
        const AMP = Math.max(3.2, HEAD * 0.95), FREQ = 0.55;   // 摆幅也跟着收，免得细身子甩成波浪线
        const body = _patternColor(col);
        const dark = _shade(body, -0.35);
        const pt = (tt) => _pointOf(seg, tt < 0 ? tt + 1 : tt > 1 ? tt - 1 : tt, canvas);
        let ht = ((now / 1000) * spd * dir) % 1; if (ht < 0) ht += 1;
        const tanAt = (tt) => {
            const p1 = pt(tt - 0.004), p2 = pt(tt + 0.004);
            const dx = p2[0] - p1[0], dy = p2[1] - p1[1], l = Math.hypot(dx, dy) || 1;
            return [dx / l, dy / l];
        };
        const nrmAt = (tt) => { const [tx, ty] = tanAt(tt); return [-ty, tx]; };
        const pw = now / 240;

        // ---- 蛇身：沿路径 S 形摆动，头粗尾细（收敛后）----
        for (let k = N; k >= 1; k--) {
            const tt = ht - LEN * k / N;
            const [x, y] = pt(tt);
            const [nx, ny] = nrmAt(tt);
            const f = k / N;
            const w = Math.sin(k * FREQ - pw) * AMP * (1 - f * 0.45);   // 尾部摆幅渐弱
            const r = HEAD * (1 - f * 0.42);                            // ★ 尾巴保留 58%
            ctx.fillStyle = body;
            ctx.beginPath(); ctx.arc(x + nx * w, y + ny * w, r, 0, 7); ctx.fill();
            if (k % 6 === 0) {                                          // 高光（鳞片感）
                ctx.fillStyle = "rgba(255,255,255,.15)";
                ctx.beginPath(); ctx.arc(x + nx * w - r * 0.3, y + ny * w - r * 0.35, r * 0.38, 0, 7); ctx.fill();
            }
        }

        // ---- 蛇头：尖形（带下颌），跟着摆动 ----
        const [hx, hy] = pt(ht);
        const [tx, ty] = tanAt(ht), [nx, ny] = nrmAt(ht);
        const hw = Math.sin(-pw) * AMP;
        const HX = hx + nx * hw, HY = hy + ny * hw;
        const ang = Math.atan2(ty, tx);
        ctx.save();
        ctx.translate(HX, HY);
        ctx.rotate(ang);
        ctx.fillStyle = body;
        ctx.beginPath();
        ctx.moveTo(HEAD * 1.5, 0);
        ctx.quadraticCurveTo(HEAD * 0.4, -HEAD * 0.95, -HEAD * 0.75, -HEAD * 0.55);
        ctx.quadraticCurveTo(-HEAD * 1.1, 0, -HEAD * 0.75, HEAD * 0.55);
        ctx.quadraticCurveTo(HEAD * 0.4, HEAD * 0.95, HEAD * 1.5, 0);
        ctx.closePath(); ctx.fill();
        ctx.strokeStyle = dark; ctx.lineWidth = Math.max(0.6, HEAD * 0.16); ctx.stroke();
        // 眼睛（左右对称，俯视视角；白眼球 + 黑瞳 + 高光）
        // ★ 全部按 HEAD 比例：原来写死 3.5/5/3.6，头细一半后眼睛会整个戳出来
        const ey = HEAD * 0.68, er = HEAD * 0.49;
        for (const s of [-1, 1]) {
            ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.arc(HEAD * 0.48, s * ey, er, 0, 7); ctx.fill();
            ctx.fillStyle = "#111"; ctx.beginPath(); ctx.arc(HEAD * 0.63, s * ey, er * 0.53, 0, 7); ctx.fill();
            ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.arc(HEAD * 0.72, s * ey - er * 0.15, er * 0.22, 0, 7); ctx.fill();
        }
        // 分叉红信（一伸一缩）
        const flick = (Math.sin(now / 150) + 1) / 2;
        if (flick > 0.5) {
            ctx.strokeStyle = "#ff5252"; ctx.lineWidth = Math.max(0.8, HEAD * 0.24);
            ctx.beginPath();
            ctx.moveTo(HEAD * 1.5, 0); ctx.lineTo(HEAD * 1.5 + HEAD * 1.2, -HEAD * 0.48);
            ctx.moveTo(HEAD * 1.5, 0); ctx.lineTo(HEAD * 1.5 + HEAD * 1.2, HEAD * 0.48);
            ctx.stroke();
        }
        ctx.restore();
    } catch (e) {}
}

/** 采样累积弧长（用于把"字符间距"按**像素**算，而不是按 t 比例——
 *  否则长连线上的字会被拉稀、短连线上会挤成一坨）。 */
const _arcCache = new WeakMap();
function _arcLengths(seg, canvas, samples) {
    const M = samples || 48;
    // 性能：原来每帧每条线都采样 48 次（48 次贝塞尔求值）。改成按 seg 缓存，
    // 每帧只花 3 次求值算"几何指纹"，线没被拖动就直接用缓存。
    let key = "";
    try {
        const a = _pointOf(seg, 0, canvas), m = _pointOf(seg, 0.5, canvas), b = _pointOf(seg, 1, canvas);
        key = (a[0] | 0) + "," + (a[1] | 0) + "," + (m[0] | 0) + "," + (m[1] | 0) + "," + (b[0] | 0) + "," + (b[1] | 0);
    } catch (e) {}
    const hit = (seg && typeof seg === "object") ? _arcCache.get(seg) : null;
    if (hit && hit.key === key && hit.M === M) return hit.cum;
    const cum = [0];
    let prev = _pointOf(seg, 0, canvas);
    for (let i = 1; i <= M; i++) {
        const p = _pointOf(seg, i / M, canvas);
        cum.push(cum[i - 1] + Math.hypot(p[0] - prev[0], p[1] - prev[1]));
        prev = p;
    }
    if (seg && typeof seg === "object") _arcCache.set(seg, { key: key, M: M, cum: cum });
    return cum;
}
/** 弧长 → t（在累积数组里线性插值）。 */
function _tAtLength(cum, s) {
    const M = cum.length - 1, total = cum[M];
    if (!(total > 0)) return 0;
    if (s <= 0) return 0;
    if (s >= total) return 1;
    for (let i = 1; i <= M; i++) {
        if (cum[i] >= s) {
            const d = cum[i] - cum[i - 1];
            return (i - 1 + (d > 0 ? (s - cum[i - 1]) / d : 0)) / M;
        }
    }
    return 1;
}

// ★ 2026-10-19 文字流动：自定义文字沿连线流动。
//   字符按**等弧距**排布并逐个旋转贴合路径切线 ⇒ 整串字会跟着连线一起弯曲。
// ★ 2026-10-20 性能重写（用户「文字流动 + 彩色 emoji（小狗）」把界面卡到几乎不动）：
//   ① **字形位图缓存**：每个「字符 + 字号 + 颜色」只栅格化一次，之后每帧只 drawImage。
//      原来是每帧每字符 fillText + strokeText 重画一遍 —— 彩色 emoji 是多层位图字形，
//      栅格化极慢（比普通汉字慢 5~20 倍），这是卡死的头号元凶。
//   ② **emoji 自动免描边**：彩色 emoji 自带颜色，黑描边既没用又最慢（strokeText 要
//      先生成轮廓再描边）。普通文字仍保留深色描边，保证任何底上都看得清。
//   ③ 切线用**相邻字符的连线**算 ⇒ 每字符从 3 次 _pointOf 降到 1 次。
//   ④ 每帧字形预算，画满就停（先保界面能拖得动）。
const _glyphCache = new Map();
const XH_EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2190}-\u{21FF}\u{FE0F}\u{200D}\u{20E3}\u{1F1E6}-\u{1F1FF}]/u;
function _isEmoji(ch) { return XH_EMOJI_RE.test(ch); }

/** 把一个字符渲染成小位图并缓存（只做一次，之后每帧复用）。 */
function _glyph(ch, fs, fill, strokeOn) {
    const key = ch + "|" + Math.round(fs) + "|" + fill + "|" + (strokeOn ? 1 : 0);
    const hit = _glyphCache.get(key);
    if (hit) return hit;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const pad = Math.ceil(fs * 0.5);
    const box = Math.ceil(fs * 1.5) + pad * 2;
    const cv = document.createElement("canvas");
    cv.width = Math.max(2, Math.ceil(box * dpr));
    cv.height = Math.max(2, Math.ceil(box * dpr));
    const c = cv.getContext("2d");
    c.scale(dpr, dpr);
    c.font = `bold ${fs}px "Microsoft YaHei","PingFang SC","Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`;
    c.textAlign = "center";
    c.textBaseline = "middle";
    c.lineJoin = "round";
    if (strokeOn) {
        c.strokeStyle = "rgba(0,0,0,.55)";
        c.lineWidth = Math.max(2, fs * 0.18);
        c.strokeText(ch, box / 2, box / 2);
    }
    c.fillStyle = fill;
    c.fillText(ch, box / 2, box / 2);
    const g = { cv: cv, box: box };
    if (_glyphCache.size > 300) _glyphCache.clear();   // 防止缓存无限涨
    _glyphCache.set(key, g);
    return g;
}

function _drawText(ctx, seg, canvas, col, size, spd, dir, now) {
    try {
        const str = String(CFG.flowText == null ? "" : CFG.flowText).trim();
        if (!str) return;
        const chars = Array.from(str);
        const n = chars.length;
        const fs = Math.max(10, (size || 8) * 2.0);
        const stepPx = fs * 1.08;                       // 字距（像素，恒定）
        const cum = _arcLengths(seg, canvas, 48);
        const total = cum[cum.length - 1];
        if (!(total > 1)) return;
        let ht = ((now / 1000) * spd * dir) % 1; if (ht < 0) ht += 1;
        const s0 = ht * total;
        const fill = _patternColor(col);                // ★ 统一图案颜色

        // ① 一次性算出所有字符的位置（每字符 1 次 _pointOf）
        const pos = new Array(n), keep = new Array(n);
        let wanted = 0;
        for (let i = 0; i < n; i++) {
            const s = s0 + i * stepPx;
            keep[i] = false;
            if (s < -stepPx || s > total + stepPx) continue;   // 还没进场 / 已出场
            if (!_takeGlyphBudget(chars[i])) continue;          // ④ 帧预算用完
            keep[i] = true;
            wanted++;
            pos[i] = _pointOf(seg, _tAtLength(cum, Math.max(0, Math.min(total, s))), canvas);
        }
        if (!wanted) return;

        ctx.save();
        for (let i = 0; i < n; i++) {
            if (!keep[i] || !pos[i]) continue;
            // ③ 切线：优先用「下一个字符 - 当前字符」，最后一个用「当前 - 前一个」
            let ang;
            if (n === 1) {
                const t0 = _tAtLength(cum, Math.max(0, Math.min(total, s0)));
                const p1 = _pointOf(seg, Math.max(0, t0 - 0.004), canvas);
                const p2 = _pointOf(seg, Math.min(1, t0 + 0.004), canvas);
                ang = Math.atan2(p2[1] - p1[1], p2[0] - p1[0]);
            } else if (i < n - 1 && pos[i + 1]) {
                ang = Math.atan2(pos[i + 1][1] - pos[i][1], pos[i + 1][0] - pos[i][0]);
            } else if (i > 0 && pos[i - 1]) {
                ang = Math.atan2(pos[i][1] - pos[i - 1][1], pos[i][0] - pos[i - 1][0]);
            } else continue;
            // 保持文字"头朝上"可读：切线朝左时整体翻转 180°，否则字会倒着写
            if (ang > Math.PI / 2 || ang < -Math.PI / 2) ang += Math.PI;
            const g = _glyph(chars[i], fs, fill, !_isEmoji(chars[i]));   // ② emoji 免描边
            ctx.save();
            ctx.translate(pos[i][0], pos[i][1]);
            ctx.rotate(ang);
            ctx.drawImage(g.cv, -g.box / 2, -g.box / 2, g.box, g.box);
            ctx.restore();
        }
        ctx.restore();
    } catch (e) {}
}

function _drawPacman(ctx, seg, canvas, col, size, spd, dir, now, st) {
    try {
        const pt = (tt) => _pointOf(seg, tt < 0 ? tt + 1 : tt > 1 ? tt - 1 : tt, canvas);
        let ht = ((now / 1000) * spd * dir) % 1; if (ht < 0) ht += 1;
        const a = pt(ht), b = pt(Math.min(1, ht + 0.005));
        const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
        const R = (st && st.prad) || 14;
        const body = _patternColor(col);                // ★ 统一图案颜色（吃豆人主体）
        const beanCol = _shade(body, 0.38);             // 豆子 = 主体色提亮，保留层次
        const ex = Math.cos(ang + Math.PI / 2), ey = Math.sin(ang + Math.PI / 2);
        // ★ 2026-10-19 豆子**固定在连线上**（世界位置不随 pacman 移动），
        //   pacman 往前走经过一颗就吃掉一颗 ⇒ 走过的路变空，吃完一轮再重新出现。
        //   判断"被吃"：前进(dir=+1)时 tb <= ht 即已走过；反向(dir=-1)时 tb >= ht。
        const gap = Math.max(0.02, (st && st.beans) || 0.055);
        const NB = Math.max(4, Math.round(1 / gap));
        for (let i = 0; i < NB; i++) {
            const tb = (i + 0.5) / NB;
            const eaten = dir >= 0 ? (tb <= ht) : (tb >= ht);
            if (eaten) continue;                       // 已被吃掉 ⇒ 不再画
            const [x, y] = pt(tb);
            // 快到嘴边时缩小（被"吸入"的观感）
            const d = dir >= 0 ? (tb - ht) : (ht - tb);
            const shrink = d < 0.012 ? Math.max(0, d / 0.012) : 1;
            ctx.fillStyle = beanCol;
            ctx.beginPath(); ctx.arc(x, y, 4 * shrink, 0, 7); ctx.fill();
        }
        // 嘴张合（★ 2026-10-19 用户要求：闭嘴要**完全闭上**，张嘴保持原来的最大幅度 0.42）
        //   原来是 `0.22 + 0.20*|sin|` ⇒ 最小也有 0.22rad 张着，永远闭不上。
        //   改成 `0.42 * |sin|` ⇒ 区间变成 0 ~ 0.42：|sin|=0 时缺口完全消失（整圆），峰值仍是 0.42。
        const mouth = 0.42 * Math.abs(Math.sin(now / 160));
        ctx.fillStyle = body;
        ctx.beginPath();
        ctx.moveTo(a[0], a[1]);
        ctx.arc(a[0], a[1], R, ang + mouth, ang - mouth + Math.PI * 2);
        ctx.closePath(); ctx.fill();
        // 眼睛（朝上 = 垂直方向取负）
        ctx.fillStyle = "#222";
        ctx.beginPath(); ctx.arc(a[0] + Math.cos(ang) * 2 - ex * 6, a[1] + Math.sin(ang) * 2 - ey * 6, 2.2, 0, 7); ctx.fill();
    } catch (e) {}
}

/**
 * 线颜色 —— 严格照抄官方 `_renderAllLinkSegments` 里的三层优先级：
 *   `t.color`（自定义/reroute 染色） → `LGraphCanvas.link_type_colors[slotTypeKey(t.type)]` → `default_link_color`
 *
 * 🔴🔴 之前的 bug（2026-10-19 用户报「有的端口是灰的，线却是彩色而且随机」）：
 *   我写的是 `default_connection_color_byType[type] || default_connection_color`
 *   —— **`default_connection_color` 是个对象** `{input_on,input_off,output_on,output_off}`，
 *   **不是字符串**！塞进 `ctx.strokeStyle` 浏览器解析失败 ⇒ **保留上一个有效值**
 *   ⇒ 颜色"随机"（其实是在继承上一条线画剩的颜色）。
 *   而且 `default_connection_color_byType` 默认是**空对象 {}**，永远取不到值。
 *
 * 官方真实默认值（从 settingStore 源码读出）：
 *   link_type_colors = { "-1": "#A86"（事件）, number: "#AAA", node: "#DCA" }
 *   其余类型（INT/FLOAT/LATENT/STRING…）⇒ 一律兜底 `LINK_COLOR = #AFA`（淡绿灰）
 *   这正是「端口灰、线也该灰」的官方行为。
 */
/** 只放行合法 CSS 颜色；非法值直接退回官方兜底色。
 *  🔴 起因：曾把 `default_connection_color`（对象）塞进 strokeStyle，
 *    浏览器静默保留旧值 ⇒ 表现为「颜色随机」。这里做硬校验，杜绝同类事故。 */
function _safeColor(c, fallback = "#AFA") {
    if (typeof c !== "string") return fallback;
    const s = c.trim();
    if (!s) return fallback;
    if (/^#[0-9a-fA-F]{3,8}$/.test(s)) return s;
    if (/^(rgb|rgba|hsl|hsla)\(/i.test(s)) return s;
    // 具名颜色白名单（够用即可，避免任意字符串混进来）
    if (/^(black|white|red|green|blue|gray|grey|silver|yellow|orange|purple|pink|cyan|magenta)$/i.test(s)) return s;
    return fallback;
}

function _colorOf(canvas, seg) {
    const Ctor = canvas && canvas.constructor;

    // 官方 slotTypeKey：数组类型用逗号连接（["INT","FLOAT"] → "INT,FLOAT"）
    const typeKey = Array.isArray(seg.type) ? seg.type.join(",") : seg.type;

    // ① link 自己的颜色（reroute / 用户自定义染色）
    if (seg.color) return seg.color;

    // ② 官方类型色表
    try {
        const table = Ctor?.link_type_colors || window.LiteGraph?.Canvas?.link_type_colors;
        const c = table && (table[typeKey] ?? table[seg.type]);
        if (c) return c;
    } catch (e) {}

    // ③ 官方兜底 default_link_color（默认 LINK_COLOR = CONNECTING_LINK_COLOR = #AFA）
    try {
        const c2 = canvas?.default_link_color;
        if (typeof c2 === "string" && c2) return c2;
    } catch (e) {}

    return "#AFA";   // 官方 CONNECTING_LINK_COLOR 同值
}

// ---------------- 绘制（接管） ----------------

function _drawAll(ctx, canvas) {
    _resetFrameBudget();          // ★ 每帧重置字形预算（文字流动专用护栏）
    const segs = _collectLinkSegments(canvas);
    // 🔴 空画布是正常状态（刚启动 / 工作流还没加载），**不要弹提示**，只在控制台记一笔。
    if (!segs.length) {
        if (!_dbgOnce) {
            _dbgOnce = true;
            console.log("[XH.Links] 当前没有连线，跳过绘制（正常）");
        }
        return;
    }
    if (!_dbgOnce) {
        _dbgOnce = true;
        console.log(`[XH.Links] 开始绘制 ${segs.length} 条连线`);
    }

    // =========================================================================
    // 🔴🔴 接管模式下**必须自己维护 `canvas.renderedPaths`** —— 官方的
    //    「右键点线 → 弹链接菜单（隐藏连线/Add Node/Add Reroute/Delete/Convert to Set/Get）」
    //    完全靠它。官方源码链路（2026-10-19 从 settingStore 实测挖出）：
    //
    //      // drawConnections 每帧开头：this.renderedPaths.clear()
    //      // 鼠标按下时（processMouseDown）：
    //      let c = queryRenderedLinkSegmentsAtPoint(this, o, s);
    //      for (let t of this.renderedPaths) {
    //          let a = t._pos;                 // ← ① _pos 必须是【线的中点】
    //          let l = c.has(t);                // ← ② 必须在这个 Set 里
    //          if (l) n.onClick = () => this.showLinkMenu(t, e);   // ← ③ 传真 link 对象
    //      }
    //
    //    ⛔⛔ 两个致命误判（都害我白折腾了好几轮）：
    //      ❶ 我一直在往 `canvas.visible_links` 里塞东西 —— **那个字段官方压根不读**。
    //      ❷ `_pos` 我塞的是 `[x1,y1,x2,y2]`（两端坐标），官方要的是**线的中点 [x,y]**。
    //
    //    ⚠️ 还要**一并写官方的线段空间索引**（`updateLinkSegmentLayout`）：
    //       它在官方 `pathRenderer.drawLink()` 里维护，接管绘制后也是空的；
    //       `queryRenderedLinkSegmentsAtPoint` 先查空间索引，没有它照样命中不了。
    // =========================================================================
    try {
        const store = _findLayoutStore(canvas);
        if (canvas.renderedPaths instanceof Set) {
            canvas.renderedPaths.clear();
            const gl = ((_activeGraph(canvas) || {}).links) || {};   // 🔴 子图安全
            for (const s of segs) {
                // 🔴🔴 **必须传真 link 对象，伪造的不行**（2026-10-19 用户实测：
                //「菜单能出来但点了没反应，只有 Add Set/Get 有效」）。
                //   官方 `showLinkMenu` 里：
                //     let l = e instanceof Link && graph.getLink(e.id) === e ? e : n;
                //   Hide Link / Show Link / Delete 全部走 `l`，伪造对象 ⇒ `l` 为空 ⇒ 静默哑掉；
                //   而 Add Set/Get 走 `onMenuAdd`（只要 origin_id / origin_slot）⇒ 恰好能用。
                //   所以取不到真link 时宁可**跳过这一条**，也绝不能塞伪造对象。
                const real = gl[s.id];
                if (!real || typeof real !== "object") continue;

                const mid = _pointOf(s, 0.5, canvas);
                try { real._pos = mid; } catch (e) {}   // _pos 必须是中点

                // 画自己的 Path2D 登记进官方空间索引（命中检测靠它）
                const p2d = _path2dOf(s, canvas);
                if (p2d && store && typeof store.updateLinkSegmentLayout === "function") {
                    try {
                        store.updateLinkSegmentLayout(s.id, null, {
                            path: p2d,
                            bounds: _boundsOf(s, canvas),
                            centerPos: { x: mid[0], y: mid[1] },
                        });
                    } catch (e) {}
                }
                canvas.renderedPaths.add(real);
            }
        }
    } catch (e) {}

    const st = _resolveStyle(CFG.style);
    const markerMode = _markerMode();      // 官方中点标记：接管后要自己补画

    // 🔴 重建我们自己的命中表（自足右键菜单用，不依赖官方内部索引）
    _rebuildHitPaths(segs, canvas);

    // 🔴 兜底重试右键入口绑定（canvas 元素 / _mousedown_callback 可能晚于 _hookCanvas 才就绪）
    _bindMenuEntry(canvas);

    // ============================================================================
    // 🔴🔴🔴 补画 Reroute（路由点）—— 本项目最隐蔽的一个坑
    //
    //  官方 drawConnections 的**末尾**有这一段：
    //      let p = this._visibleReroutes;   p.clear();
    //      a.sort((e,t)=>e.linkIds.size - t.linkIds.size);
    //      for (let t of a) p.add(t), ..., t.draw(e, this._pattern),
    //                                 this.pointer.isDown || t.drawSlots(e);
    //  ⇒ **Reroute 的圆点、左右隐藏接口、命中、悬停、拖拽，全部挂在这段上**。
    //  ⇒ 我们接管 drawConnections 之后这段永不执行 ⇒ _visibleReroutes 永远是空 Set
    //     ⇒ 表现为「路由点建成功了却完全看不见、不能拖、没有小接口」。
    //
    //  ✅ 正解（不重画任何像素，借官方的力）：
    //     从 graph.reroutes（一个 Map）里取出全部 Reroute 对象，
    //     填进 canvas._visibleReroutes，再调它们自己的 draw / drawSlots。
    //     画出来的外观、接口显隐逻辑、命中数据**全部是官方的**，天然一致。
    // ============================================================================
    try { _renderReroutes(ctx, canvas); } catch (e) {}

    if (CFG.debugHit) _debugBanner();

    // 拖拽连线的状态（官方接管后也要自己处理）
    // ⚠️ 不同版本字段名不一，这里做兼容；全读不到就跳过（不影响正常绘制）
    const cNode = canvas.connecting_node || canvas.connectingNode || null;
    const cPos = canvas.connecting_pos || canvas.connectingPos || null;
    const cOut = canvas.connecting_output || canvas.connectingOutput || null;
    const cIn = canvas.connecting_input || canvas.connectingInput || null;
    const dragNodeId = cNode ? String(cNode.id) : null;
    const slotOf = (o) => (o ? (o.slot ?? o.index ?? 0) : 0);
    const now = performance.now();
    // 🔴 方向定义统一：**+1 = 起点→终点**（数据流方向）。
    //    注意虚线和粒子的底层语义是反的：
    //      · 粒子：t 递增 ⇒ 往终点走
    //      · 虚线：lineDashOffset **递减**（取负）才往终点走
    //    所以下面 dashed 用 -phase，粒子直接用 dir。
    const dir = CFG.reverse ? -1 : 1;
    const phase = (now / 1000) * (CFG.speed || st.speed || 0) * dir;
    const breath = st.breathe ? 0.55 + 0.45 * Math.abs(Math.sin(now / 700)) : 1;

    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    for (let si = 0; si < segs.length; si++) {
        const seg = segs[si];
        const baseColor = _safeColor(_colorOf(canvas, seg));
        const hot = _executingNodeId !== null
            && (String(seg.originId) === String(_executingNodeId) || String(seg.targetId) === String(_executingNodeId));

        // 这条线是不是正被拖着（准备断开）⇒ 变虚变淡
        const dragging = dragNodeId !== null && (
            (cOut && String(seg.originId) === dragNodeId) ||
            (cIn && String(seg.targetId) === dragNodeId)
        );

        // ---- 线 ----
        // 拖拽中的线：透明度打到 30%，配合下面强制虚线 = "正在被拖走"的观感
        ctx.globalAlpha = Math.min(1, (st.alpha || 1) * CFG.alpha * breath) * (dragging ? 0.3 : 1);
        ctx.strokeStyle = hot ? "#FFFFFF" : baseColor;
        ctx.lineWidth = Math.max(1, (CFG.width || 2) * (st.width || 1) * (st.breathe ? (0.7 + 0.5 * breath) : 1) * (hot ? 1.5 : 1));
        if (hot) { ctx.shadowBlur = 14; ctx.shadowColor = baseColor; } else { ctx.shadowBlur = 0; }
        if (dragging) {
            ctx.setLineDash([5, 5]);       // 被拖的线统一变虚
            ctx.lineDashOffset = 0;
        } else if (st.dash && st.dash.length) {
            ctx.setLineDash(st.dash);
            ctx.lineDashOffset = -phase;   // 取负 ⇒ 虚线沿「起点→终点」流动
        } else {
            ctx.setLineDash([]);
        }
        _pathOf(ctx, seg, canvas);
        ctx.stroke();
        ctx.setLineDash([]);

        // ---- 官方中点标记（接管后官方不画了，这里补上）----
        // 🔴 Reroute 相邻的两段线**不画中点标记**：
        //    那个大圆点本身就是路由点（官方 rr.draw 画的），再叠两个中点标记会
        //    变成用户截图里的「一个变成两个、还错开挂在旁边」。
        if (!seg.noMarker) _drawMarker(ctx, seg, canvas, markerMode);

        // ---- 粒子（球 / 箭头）----
        if (st.mode === "particle") {
            const col = baseColor;
            const mult = (CFG.speed || 40) / 40;
            const spd = (st.pspeed || 0.3) * mult;
            const count = Math.max(1, Math.min(6, st.pcount || 1));
            const size = (st.size || 5) * ((CFG.width || 2) / 2);
            const seed = si * 0.137;

    ctx.globalAlpha = CFG.alpha;
    ctx.fillStyle = hot ? "#FFFFFF" : col;
    if (st.glow || hot) { ctx.shadowBlur = hot ? 16 : 10; ctx.shadowColor = col; } else { ctx.shadowBlur = 0; }

    if (st.shape === "snake") {
        _drawSnake(ctx, seg, canvas, hot ? "#FFFFFF" : col, size, spd, dir, now);
    } else if (st.shape === "pacman") {
        _drawPacman(ctx, seg, canvas, hot ? "#FFFFFF" : col, size, spd, dir, now, st);
    } else if (st.shape === "text") {
        _drawText(ctx, seg, canvas, hot ? "#FFFFFF" : col, size, spd, dir, now);
    } else {
        for (let k = 0; k < count; k++) {
            let t = (seed + k / count + (now / 1000) * spd * dir) % 1;
            if (t < 0) t += 1;
            const [px, py] = _pointOf(seg, t, canvas);

            if (st.shape === "arrow") {
                const [qx, qy] = _pointOf(seg, Math.min(1, t + 0.01), canvas);
                const ang = Math.atan2(qy - py, qx - px);
                ctx.save();
                ctx.translate(px, py);
                ctx.rotate(ang);
                ctx.beginPath();
                ctx.moveTo(size, 0);
                ctx.lineTo(-size * 0.75, size * 0.7);
                ctx.lineTo(-size * 0.75, -size * 0.7);
                ctx.closePath();
                ctx.fill();
                ctx.restore();
            } else {
                ctx.beginPath();
                ctx.arc(px, py, size, 0, Math.PI * 2);
                ctx.fill();
            }
        }
    }
        }
    }

    // ---- 🔧 调试：把「可点击热区」画出来 ----
    //   半透明粗线 = 我们的命中判定范围（Path2D + tol）。
    //   鼠标右键时命中的那条会变成实心亮黄。
    //   ⇒ 一眼看出「热区位置对不对」「有没有命中」。
    if (CFG.debugHit) {
        ctx.save();
        ctx.lineCap = "round";
        for (const it of _linkHit.paths) {
            ctx.strokeStyle = (it.id === _lastHitId) ? "rgba(255,235,59,0.95)" : "rgba(0,229,255,0.45)";
            ctx.lineWidth = _linkHit.tol * 2;
            ctx.setLineDash([]);
            if (it.path) { try { ctx.stroke(it.path); } catch (e) {} }
            else if (it.pts && it.pts.length > 1) {
                // 🔧 兜底：Path2D 不可用时直接画折线（此时热区几何 = 命中几何，所见即所判）
                ctx.beginPath();
                ctx.moveTo(it.pts[0][0], it.pts[0][1]);
                for (let i = 1; i < it.pts.length; i++) ctx.lineTo(it.pts[i][0], it.pts[i][1]);
                ctx.stroke();
            }
        }
        // 鼠标位置小十字（对照用）
        if (_lastMouse && _lastMouse.length >= 2) {
            ctx.strokeStyle = "rgba(255,64,64,0.9)";
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(_lastMouse[0] - 14, _lastMouse[1]); ctx.lineTo(_lastMouse[0] + 14, _lastMouse[1]);
            ctx.moveTo(_lastMouse[0], _lastMouse[1] - 14); ctx.lineTo(_lastMouse[0], _lastMouse[1] + 14);
            ctx.stroke();
        }
        ctx.restore();
    }

    // ---- 拖拽预览线：鼠标拉出来的那条临时虚线（官方接管后也得自己画）----
    if (cNode && cPos) {
        try {
            let from = null;
            if (cOut) {
                from = _slotPos(canvas, cNode, slotOf(cOut), false);
            } else if (cIn) {
                from = _slotPos(canvas, cNode, slotOf(cIn), true);
            }
            const arrLike = cPos && cPos.length !== undefined;
            const mx = arrLike ? cPos[0] : cPos.x;
            const my = arrLike ? cPos[1] : cPos.y;
            if (from && mx !== undefined && my !== undefined) {
                ctx.globalAlpha = 0.9;
                ctx.strokeStyle = "#FFFFFF";
                ctx.lineWidth = Math.max(1, CFG.width || 2);
                ctx.setLineDash([6, 6]);
                ctx.lineDashOffset = 0;
                ctx.shadowBlur = 0;
                ctx.beginPath();
                ctx.moveTo(from[0], from[1]);
                ctx.lineTo(mx, my);
                ctx.stroke();
            }
        } catch (e) {}
    }

    ctx.shadowBlur = 0;
    ctx.setLineDash([]);
    ctx.restore();
}

// ---------------- 动画循环 ----------------

function _tick() {
    if (!CFG.enabled) { _raf = null; return; }
    _raf = requestAnimationFrame(_tick);
    const now = performance.now();
    if (now - _lastFrame < FRAME_MS) return;
    _lastFrame = now;
    try { app.canvas?.setDirty(true, true); } catch (e) {}
}

function _start() {
    if (_raf) return;
    _raf = requestAnimationFrame(_tick);
}

function _stop() {
    if (_raf) { cancelAnimationFrame(_raf); _raf = null; }
    try { app.canvas?.setDirty(true, true); } catch (e) {}
}

// ---------------- 挂载（接管） ----------------

function _toast(msg, ok) {
    try {
        const d = document.createElement("div");
        d.textContent = msg;
        d.style.cssText =
            "position:fixed;top:14px;right:14px;z-index:99999;background:" + (ok ? "#1d9e75" : "#E53935") +
            ";color:#fff;padding:8px 12px;border-radius:6px;font-size:13px;font-weight:600;" +
            "box-shadow:0 6px 20px rgba(0,0,0,.45);pointer-events:none;";
        document.body.appendChild(d);
        setTimeout(() => { try { d.remove(); } catch (e) {} }, 3000);
    } catch (e) {}
}

// ============================================================================
// 🔴🔴🔴 自足连线命中检测 + 右键菜单（不再依赖官方那套内部空间索引）
//
//背景（2026-10-19 用户实测）：接管绘制后，官方 `queryRenderedLinkSegmentsAtPoint`
//      依赖 `renderedPaths` + 一个**没挂在全局的布局存储单例**（源码里叫 `X`），
//      反射十有八九找不到 ⇒ 表现为「菜单时有时无」——
//      能点到的线全是**之前官方模式画过、索引里还留着残渣**的那几条。
//
//      用户原话：「在我们模式下其实把官方线的功能已经遮盖住了，
//               要么我们自己做跟官方一模一样的功能，要么就把遮住的放出来。」
//      ⇒ 选**自己做**：不碰官方任何内部缓存，命中检测完全由我们控制，稳定可预期。
//
//    做法：
//      ① 接管 processMouseDown，右键（button===2）时先用**我们自己画的 Path2D**
//         做 isPointInStroke 命中检测（Path2D 浏览器原生命中，比自己算距离准得多）。
//      ② 命中就自己弹菜单，功能项照抄官方 `showLinkMenu` 的 switch。
//      ③ 没命中就放行给官方（空白处右键仍是官方画布菜单，两套共存互不干扰）。
// ============================================================================

const _linkHit = { paths: [], tol: 10 };   // tol：命中容差，比线宽稍大（官方用 lineWidth+7）
let _lastHitId = null;       // 🔧 调试：最近命中的线 id
let _lastMouse = null;       // 🔧 调试：鼠标画布坐标
let _dbgState = { entered: 0, coordOk: 0, hit: 0, menu: 0, err: 0, minDist: -1 };  // 🔧 各环节计数

/** 🔧 屏幕状态条：把每一环的成败直接显示在屏幕上，不用开控制台。 */
function _debugBanner() {
    if (!CFG.debugHit) return;
    try {
        let el = document.getElementById("__xh_link_dbg");
        if (!el) {
            el = document.createElement("div");
            el.id = "__xh_link_dbg";
            el.style.cssText =
                "position:fixed;left:12px;bottom:12px;z-index:99999;background:rgba(20,20,20,.92);" +
                "color:#9CFF9C;padding:8px 12px;border-radius:6px;font:12px/1.6 monospace;" +
                "white-space:pre;pointer-events:none;border:1px solid #444;";
            document.body.appendChild(el);
        }
        const s = _dbgState;
        el.textContent =
            `XH 连线右键调试\n` +
            `  动画开关 : ${CFG.enabled ? "开" : "关"}\n` +
            `  热区条数 : ${_linkHit.paths.length}\n` +
            `  右键入口 : entered=${s.entered}坐标OK=${s.coordOk}命中=${s.hit}出菜单=${s.menu}异常=${s.err}\n` +
            `  最近距离 : ${s.minDist} (需 ≤ ${_linkHit.tol})\n` +
            `  视口     : ${s.viewport ?? "—"}\n` +
            `  鼠标坐标 : ${_lastMouse ? `(${Math.round(_lastMouse[0])}, ${Math.round(_lastMouse[1])})` : "—"}\n` +
            `  最近命中 : ${_lastHitId ?? "—"}`;
    } catch (e) {}
}

/** 距离点 (px,py) 到线段最近点的平方距离（用于容差兜底）。 */
function _distToSeg2(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    const L2 = dx * dx + dy * dy;
    let t = L2 > 0 ? ((px - x1) * dx + (py - y1) * dy) / L2 : 0;
    t = Math.max(0, Math.min(1, t));
    const qx = x1 + t * dx, qy = y1 + t * dy;
    return (px - qx) * (px - qx) + (py - qy) * (py - qy);
}

/** 从当前 segs 重建命中用的折线点列（每帧在 _drawAll 里调）。 */
function _rebuildHitPaths(segs, canvas) {
    _linkHit.paths.length = 0;
    for (const s of segs) {
        const pts = _samplesOf(s, canvas, 64);   // 64 段：拐角处也要足够密
        if (!pts || pts.length < 2) continue;
        _linkHit.paths.push({ id: s.id, path: null, pts, seg: s });
    }
}

/** 点 (px,py) 到折线点列的最短距离平方。 */
function _distToPoly2(px, py, pts) {
    let best = Infinity;
    for (let i = 0; i < pts.length - 1; i++) {
        const d = _distToSeg2(px, py, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]);
        if (d < best) best = d;
    }
    return best;
}

/** 命中检测：**纯数学**——点到折线最短距离 ≤ 容差。
 *
 *  🔴 不再用 ctx.isPointInStroke：在带 dpr/zoom 的 ctx 上它恒返回 false（实测 11 次右键 0 命中）。
 *  坐标完全活在自己的图坐标空间里，与 ctx 变换无关。
 */
function _hitLink(canvas, ctx, px, py) {
    const tol = _linkHit.tol;
    let best = null, bestD = Infinity;
    for (const item of _linkHit.paths) {
        const d = _distToPoly2(px, py, item.pts);
        if (d < bestD) { bestD = d; best = item; }
    }
    _dbgState.minDist = Math.round(Math.sqrt(bestD) * 10) / 10;
    return (best && bestD <= tol * tol) ? best : null;
}

/** 造一个菜单（优先用官方 ContextMenu，保证样式/行为与官方一致）。
 *
 *  🔴 官方 `ContextMenu`（源码里 `Qc=class ContextMenu`）**没挂全局也没export**，
 *    反射也拿不到（它在闭包里）。所以这里的策略是**借官方的力**：
 *    直接调 `canvas.showLinkMenu(link, event, link)` ——
 *    第三个参数正是官方 `showLinkMenu(e,t,n)` 里的 `n`（= 兜底 link），
 *    官方内部会自己 `new ContextMenu(...)`，样式/定位/i18n 全部天然一致。
 *
 *  前提：`e instanceof Link && graph.getLink(e.id) === e` 必须成立 ⇒ **必须传真 link**。
 *    取不到真link 就放弃（宁可不出菜单，也不用伪造对象制造假功能）。
 */
function _ctxMenu(canvas, items, event, onPick, title) {
    // 优先用能拿到的 ContextMenu 构造器
    const CM = _findContextMenuCtor(canvas);
    if (typeof CM === "function") {
        try {
            new CM(items, { event, title, callback: onPick });
            return true;
        } catch (e) { /* 落到下面借官方 */ }
    }
    // 借官方 showLinkMenu（它内部会 new ContextMenu）
    if (typeof canvas?.showLinkMenu === "function" && onPick.__xhRealLink) {
        try {
            canvas.showLinkMenu(onPick.__xhRealLink, event, onPick.__xhRealLink);
            return true;
        } catch (e) { console.warn("[XH.Links] showLinkMenu 调用失败", e); }
    }
    return false;
}

/** 反射找 ContextMenu 构造器（找得到就用，找不到走借官方那条路）。 */
let _cmCtorCache = { fn: null, tried: false };
function _findContextMenuCtor(canvas) {
    if (_cmCtorCache.tried) return _cmCtorCache.fn;
    _cmCtorCache.tried = true;
    try {
        if (window.Comfy?.ContextMenu) { _cmCtorCache.fn = window.Comfy.ContextMenu; return _cmCtorCache.fn; }
        if (window.LiteGraph?.ContextMenu) { _cmCtorCache.fn = window.LiteGraph.ContextMenu; return _cmCtorCache.fn; }
    } catch (e) {}
    return _cmCtorCache.fn;
}

/** 菜单项。
 *  🔴 全部自己实现，**不依赖官方闭包**（官方 hideLink/showLink 走
 *     `Tl().patch(...)`，Tl 在闭包里反射不到 ⇒ 那一项必然哑掉）。
 *  - 隐藏连线：我们置 link.hidden，绘制时跳过（_collectLinkSegments 已过滤）
 *  - Add Reroute：官方原生是**Alt+左键**建路由点，这里菜单同效
 *  - Add Node / Delete：走官方 graph API
 */
function _linkMenuItems() {
    return [
        { content: "隐藏连线", value: "Hide Link" },
        null,
        "Add Node", "Add Reroute",
        null,
        "Delete",
        null,
    ];
}

/** 🔴 把「鼠标所在画布坐标」补进 event。
 *  官方 onMenuAdd / createReroute 都读 `event.canvasX/canvasY`，
 *  而原生 DOM 事件上这两个字段是**空的** ⇒ 官方按 (0,0) 落点
 *  ⇒ 这就是「节点加到了画布最左侧」的真正原因。
 */
function _stampEvent(event, px, py) {
    try {
        if (!event) return event;
        event.canvasX = px;
        event.canvasY = py;
        event.graph_mouse = [px, py];
        if (Array.isArray(event.clientX) || event.clientX === undefined) { /* noop */ }
        return event;
    } catch (e) { return event; }
}

/** 执行菜单动作（全部自己实现）。 */
function _runLinkAction(canvas, action, link, event, hitPt) {
    const graph = _activeGraph(canvas);          // 🔴 子图安全
    if (!graph || !link) return;
    const oid = link.origin_id, osl = link.origin_slot;
    const originNode = graph.getNodeById ? graph.getNodeById(oid) : null;
    const slotType = originNode?.outputs?.[osl]?.type;
    // 🔴 落点：优先「用户右键那一���」，退化到线中点
    const pt = Array.isArray(hitPt) ? hitPt : (link._pos || [0, 0]);

    try {
        switch (action) {
            case "Hide Link": {
                link.hidden = true;
                try { link._hidden = true; } catch (e) {}
                break;
            }
            case "Show Link": {
                link.hidden = false;
                try { link._hidden = false; } catch (e) {}
                break;
            }
            case "Add Node": {
                const Ctor = canvas.constructor;
                if (typeof Ctor.onMenuAdd !== "function") { console.warn("[XH.Links] 无 onMenuAdd"); break; }
                // 🔴 关键：先把真实画布坐标写进 event，否则官方落在 (0,0)
                _stampEvent(event, pt[0], pt[1]);
                try { if (typeof canvas.adjustMouseEvent === "function") canvas.adjustMouseEvent(event); } catch (e) {}
                Ctor.onMenuAdd(null, null, event, canvas, (newNode) => {
                    if (!newNode?.inputs?.length || !newNode?.outputs?.length || osl == null) return;
                    const ok = originNode?.connectByType(osl, newNode, slotType ?? "*", {});
                    if (ok && typeof newNode.setPos === "function") {
                        newNode.setPos(newNode.pos[0] - newNode.size[0] * 0.5, newNode.pos[1]);
                    }
                });
                break;
            }
            case "Add Reroute": {
                // 官方原生方式是 Alt+左键：graph.createReroute([x,y], link)
                if (typeof graph.createReroute !== "function") {
                    console.warn("[XH.Links] graph.createReroute 不存在");
                    break;
                }
                _stampEvent(event, pt[0], pt[1]);
                const rr = graph.createReroute([pt[0], pt[1]], link);
                if (!rr) { console.warn("[XH.Links] createReroute 返回空"); break; }
                // 建完立刻允许拖拽（官方是这么接的：onDragStart 挂 _startDraggingItems）
                try {
                    if (typeof canvas._startDraggingItems === "function") {
                        canvas._lastDrawnNode = rr;
                        rr.pos = [pt[0], pt[1]];
                    }
                } catch (e) {}
                try { graph.beforeChange?.(); } catch (e) {}
                break;
            }
            case "Delete": {
                graph.removeLink(link.id);
                break;
            }
            default:
                console.warn("[XH.Links] 未知动作", action);
        }
    } catch (e) {
        console.error("[XH.Links] 执行菜单动作出错", action, e);
    }
    try { canvas.setDirty?.(false, true); } catch (e) {}
}

/** 找官方的 hideLink/showLink（没挂全局，从实例反射）。 */
function _findLinkVisibilityFn() {
    try {
        const cv = app?.canvas;
        if (!cv) return null;
        const seen = new Set();
        const walk = (o, d) => {
            if (!o || seen.has(o) || d > 3) return null;
            if (typeof o !== "object" && typeof o !== "function") return null;
            seen.add(o);
            // 官方 hideLink(canvas, graphScope, linkId) / showLink(...)
            for (const k of Object.keys(o)) {
                let v; try { v = o[k]; } catch (e) { continue; }
                if (typeof v === "function" && /^(hide|show)Link$/.test(v.name)) return v;
            }
            for (const k of Object.keys(o)) {
                let v; try { v = o[k]; } catch (e) { continue; }
                if (v && typeof v === "object") { const r = walk(v, d + 1); if (r) return r; }
            }
            return null;
        };
        return walk(cv, 0);
    } catch (e) { return null; }
}
let _visFnCache = { fn: null, tried: false };
function _callHideLink(canvas, graph, linkId, hide) {
    if (!_visFnCache.tried) { _visFnCache.fn = _findLinkVisibilityFn(); _visFnCache.tried = true; }
    const fn = _visFnCache.fn;
    if (typeof fn !== "function") return false;
    try {
        // 官方签名 hideLink(canvas, graphScope, linkId) —— graphScope 用 graph 顶替
        fn(canvas, graph, linkId);
        return true;
    } catch (e) { console.warn("[XH.Links] hide/show 调用失败", e); return false; }
}

/** 诊断：菜单是怎么弹出来的。 */
function _linkMenuRoute() {
    const CM = _findContextMenuCtor(app?.canvas);
    return typeof CM === "function" ? "自建 ContextMenu" : "借官方 showLinkMenu";
}

/**
 * 右键点到线 → 自己弹菜单。返回 true 表示"已处理，官方别再管"。
 * 🔴 坐标换算必须**三层兜底**，任一环拿不到就返回 false（放行官方），绝不乱弹。
 */
function _tryLinkContextMenu(canvas, event) {
    try {
        if (!CFG.enabled) return false;
        if (!event || !(event.button === 2 || event.buttons === 2 || event.type === "contextmenu")) return false;
        _dbgState.entered++;

        const ctx = canvas.ctx || canvas._ctx || null;

        // —— 画布坐标：🔴 严格照官方 DragAndScale 的公式 ——
        //    官方源码（settingStore-CUTKo1HX.js）：
        //      convertOffsetToCanvas(e){ return [ (e[0]+this.offset[0])*this.scale, ... ] }  // 屏幕→画布
        //      convertCanvasToOffset(e){ t[0] = e[0]/this.scale - this.offset[0]; ... }       // 画布→屏幕
        //    反推屏幕→画布 ⇒ **graph = offset / scale - ds.offset**（offset 是被"减"掉的！）
        //  ⚠️ 千万别写成 (offset - ds.offset)/scale —— 括号位置不同能差几百像素（实测最近距离 2383）。
        //    之所以不用现成接口：event.canvasX 在原生 DOM contextmenu 事件上不会被官方赋值（脏值），
        //    ds.convertOffsetToCanvas 在捕获阶段调用时 offsetX 基准也不可靠（实测给出 y=-25823）。
        let px = null, py = null;
        try {
            const el = canvas.canvas;
            const ds = canvas.ds;
            const scale = (ds && typeof ds.scale === "number" && ds.scale > 0) ? ds.scale : 1;
            const ox = (ds && ds.offset && typeof ds.offset[0] === "number") ? ds.offset[0] : 0;
            const oy = (ds && ds.offset && typeof ds.offset[1] === "number") ? ds.offset[1] : 0;
            if (el && typeof el.getBoundingClientRect === "function") {
                const r = el.getBoundingClientRect();
                const cx = event.clientX - r.left;
                const cy = event.clientY - r.top;
                px = cx / scale - ox;
                py = cy / scale - oy;
            }
        } catch (e) {}
        // 兜底①：官方维护的 graph_mouse（鼠标在画布内就是对的）
        if ((px === null || py === null || Number.isNaN(px) || Number.isNaN(py))
            && Array.isArray(canvas.graph_mouse) && canvas.graph_mouse[0] !== -1) {
            px = canvas.graph_mouse[0]; py = canvas.graph_mouse[1];
        }
        // 兜底②：官方转换接口
        if ((px === null || py === null || Number.isNaN(px) || Number.isNaN(py)) && typeof canvas.ds?.convertOffsetToCanvas === "function") {
            try {
                const p = canvas.ds.convertOffsetToCanvas([event.offsetX ?? event.clientX, event.offsetY ?? event.clientY]);
                if (p) { px = p[0]; py = p[1]; }
            } catch (e) {}
        }
        if (px == null || py == null || Number.isNaN(px) || Number.isNaN(py)) return false;
        _lastMouse = [px, py];
        _dbgState.coordOk++;
        _dbgState.viewport = `scale=${(canvas.ds?.scale ?? 1).toFixed(2)} offset=${Math.round(canvas.ds?.offset?.[0] ?? 0)},${Math.round(canvas.ds?.offset?.[1] ?? 0)}`;
        if (!_linkHit.paths.length) return false;
        if (!ctx) return false;

        const hit = _hitLink(canvas, ctx, px, py);
        if (!hit) { _lastHitId = null; _debugBanner(); return false; }
        _lastHitId = hit.id;
        _dbgState.hit++;

        const gl = ((_activeGraph(canvas) || {}).links) || {};   // 🔴 子图安全
        const link = gl[hit.id];
        if (!link || typeof link !== "object") return false;   // ⛔ 绝不伪造

        const mid = _pointOf(hit.seg, 0.5, canvas);
        try { link._pos = mid; } catch (e) {}

        const hitPt = [px, py];          // 🔴 用户右键那一���，Add Node / Reroute 的落点

        // ——— 🔴 Alt + 左键：官方原生建 Reroute 的手势，直接复刻 ———
        //  官方源码：`if(e.altKey && !e.shiftKey){ let e=r.createReroute([o,s],t); ... }`
        if (event.altKey && !event.shiftKey) {
            try {
                const _agC = _activeGraph(canvas);      // 🔴 子图安全
                const rr = _agC.createReroute([px, py], link);
                if (rr) {
                    try { _agC.beforeChange?.(); } catch (e) {}
                    canvas.setDirty?.(false, true);
                    try { event.stopPropagation?.(); event.preventDefault?.(); } catch (e) {}
                    _dbgState.menu++;
                    return true;
                }
            } catch (e) { console.warn("[XH.Links] Alt建Reroute 失败", e); }
        }

        const onPick = (a) => {
            const act = (a && typeof a === "object") ? a.value : a;
            _runLinkAction(canvas, act, link, event, hitPt);
        };
        onPick.__xhRealLink = link;
        if (!_ctxMenu(canvas, _linkMenuItems(), event, onPick)) {
            console.warn("[XH.Links] 命中了线但菜单弹不出（ContextMenu 拿不到）");
            _debugBanner();
            return false;
        }
        _dbgState.menu++;
        console.log(`[XH.Links] 右键命中线 ${hit.id} @(${Math.round(px)},${Math.round(py)}) · ${_linkMenuRoute()}`);
        _debugBanner();
        return true;
    } catch (e) {
        _dbgState.err++;
        console.warn("[XH.Links] 右键处理异常，放行官方", e);
        _debugBanner();
        return false;
    }
}

function _hookCanvas() {
    // 从实例反拿原型（不依赖 window.LiteGraph）
    const cv = app.canvas;
    if (!cv) return false;
    const proto = cv.constructor && cv.constructor.prototype;
    if (!proto || typeof proto.drawConnections !== "function") return false;
    if (proto.__xhLinkFlowHooked) return true;

    const orig = proto.drawConnections;
    proto.drawConnections = function (ctx) {
        // 🔴 接管：开着就**不调官方绘制**，线 + 动画都由 _drawAll 画
        if (CFG.enabled) {
            try { _drawAll(ctx, this); return; } catch (e) {}
        }
        return orig.apply(this, arguments);
    };

    // =========================================================================
    // 🔴🔴🔴 右键菜单入口：**改prototype 没用**，必须动这两个（2026-10-19 实测）
    //
    //  🔴 踩坑根因：官方 bindEvents() 里写的是
    //        this._mousedown_callback = this.processMouseDown.bind(this);
    //        canvas.addEventListener('pointerdown', this._mousedown_callback, true);
    //    **事件绑定那一刻就已经把原方法capture 成bound 函数了**，
    //    我之后再改 proto.processMouseDown，DOM 里挂的还是**旧函数** ⇒ hook 根本没被调用
    //    ⇒ 表现为「右键完全无效」。
    //
    //  ✅ 正确入口（两个都挂，互为双保险）：
    //    ① 直接在 canvas 元素上绑 **捕获阶段** contextmenu 监听
    //       （官方那个 contextmenu 绑的是 _doNothing，只preventDefault，不会和我们打架）
    //    ② 替换 canvas._mousedown_callback **并同步换掉已绑定的监听器**
    // =========================================================================
    try {
        const cvEl = cv.canvas;
        if (cvEl && !cvEl.__xhLinkMenuBound) {
            cvEl.__xhLinkMenuBound = true;
            cvEl.addEventListener("contextmenu", (ev) => {
                // 命中线就自己弹；没命中一律 return，官方 _doNothing 继续preventDefault（画布菜单照旧）
                _tryLinkContextMenu(cv, ev);
            }, true);
            console.log("[XH.Links] ✅ 已绑定 contextmenu 捕获监听（右键连线菜单入口）");
        }
    } catch (e) { console.warn("[XH.Links] contextmenu 绑定失败", e); }

    // ② 替换 _mousedown_callback（官方 bindEvents 捕获的引用）
    try {
        const inst = cv;
        if (inst && inst._mousedown_callback && !inst.__xhDownPatched) {
            const oldCb = inst._mousedown_callback;
            inst.__xhDownPatched = true;
            const newCb = function (event) {
                if (_tryLinkContextMenu(inst, event)) {
                    try { event.stopPropagation?.(); event.preventDefault?.(); } catch (e) {}
                    return;                       // 命中并弹了 ⇒ 不再走官方
                }
                return oldCb.call(inst, event);
            };
            inst._mousedown_callback = newCb;
            // 把已挂到 DOM 上的那个换掉
            const el = inst.canvas;
            if (el) {
                try { el.removeEventListener("pointerdown", oldCb, true); } catch (e) {}
                try { el.addEventListener("pointerdown", newCb, true); } catch (e) {}
            }
            console.log("[XH.Links] ✅ 已替换 _mousedown_callback（pointerdown 捕获）");
        }
    } catch (e) { console.warn("[XH.Links] _mousedown_callback 替换失败", e); }

    proto.__xhLinkFlowHooked = true;
    console.log("[XH.Links] ✅ 已接管 drawConnections（勾开关即生效）");
    _bindMenuEntry(cv);      // 🔴 每帧兜底重试：canvas 元素/_mousedown_callback 可能晚于本函数才就绪
    return true;
}

/** 绑定右键菜单入口（幂等，可反复调）。
 *  🔴 必须做成"可重入"：_hookCanvas 跑的时候，canvas 元素 / _mousedown_callback
 *    可能还没创建好（Vue 渲染异步），一次绑定不上就永远失效。
 *    ⇒ 每次 _drawAll 都调一次，成功后打标记自动跳过。 */
function _bindMenuEntry(cv) {
    try {
        if (!cv) return false;
        // ① contextmenu 捕获监听
        const el = cv.canvas;
        if (el && !el.__xhLinkMenuBound) {
            el.__xhLinkMenuBound = true;
            el.addEventListener("contextmenu", (ev) => {
                _tryLinkContextMenu(cv, ev);
            }, true);
            console.log("[XH.Links] ✅ 已绑定 contextmenu 捕获监听（右键连线菜单入口）");
        }
        // ② _mousedown_callback 替换
        if (cv._mousedown_callback && !cv.__xhDownPatched) {
            const oldCb = cv._mousedown_callback;
            cv.__xhDownPatched = true;
            const newCb = function (event) {
                if (_tryLinkContextMenu(cv, event)) {
                    try { event.stopPropagation?.(); event.preventDefault?.(); } catch (e) {}
                    return;                       // 命中并弹了 ⇒ 不再走官方
                }
                return oldCb.call(cv, event);
            };
            cv._mousedown_callback = newCb;
            if (el) {
                try { el.removeEventListener("pointerdown", oldCb, true); } catch (e) {}
                try { el.addEventListener("pointerdown", newCb, true); } catch (e) {}
            }
            console.log("[XH.Links] ✅ 已替换 _mousedown_callback（pointerdown 捕获）");
        }
        return !!(el && el.__xhLinkMenuBound);
    } catch (e) {
        return false;
    }
}

function _ensureHook() {
    if (_hookCanvas()) return;
    if (++_hookTries > 60) {
        console.error("[XH.Links] ❌ 拿不到 app.canvas.drawConnections");
        _toast("❌ 连线动画：找不到画布绘制函数", false);
        return;
    }
    setTimeout(_ensureHook, 200);
}

// ---------------- 设置面板 ----------------

// ⚠️ 2026-10-19 实测（无头浏览器打开设置面板读 DOM）：新前端「其他」分组内的条目
// 按「注册数组的倒序」显示——所以主开关「连线流动」必须写在数组最后，才能显示在最顶。
// （数组按用户期望的显示顺序的倒序排列：连线流动 → 风格 → 速度 → 线宽 → 不透明度 → 调试 → 中点标记 → 反向流动）
const SETTING_DEFS = [
    {
        id: `${NS}.reverse`, name: "反向流动", type: "boolean", defaultValue: false,
        onChange: (v) => { CFG.reverse = !!v; },
    },
    {
        id: `${NS}.marker`, name: "连线中点标记", type: "combo",
        options: ["跟随官方", "无", "圆", "箭头"], defaultValue: "跟随官方",
        onChange: (v) => { CFG.marker = v || "跟随官方"; _markerModeCache = null; },
    },
    {
        id: `${NS}.debugHit`, name: "🔧 调试：显示热区", type: "boolean", defaultValue: false,
        onChange: (v) => {
            CFG.debugHit = !!v;
            if (!CFG.debugHit) { try { document.getElementById("__xh_link_dbg")?.remove(); } catch (e) {} }
            try { app.canvas?.setDirty(true, true); } catch (e) {}
        },
    },
    {
        id: `${NS}.alpha`, name: "不透明度", type: "slider",
        attrs: { min: 0.1, max: 1, step: 0.05 }, defaultValue: 0.95,
        onChange: (v) => { CFG.alpha = Number(v) || 0.95; },
    },
    {
        // ★ 2026-10-20：8 不是技术极限（Canvas 线宽想多粗都行，只是滑块上限），
        //   用户问能不能再往上 ⇒ 拉到 **16**。图案大小也跟着线宽走，所以粗线 + 大蛇头都够用。
        id: `${NS}.width`, name: "线宽（像素）", type: "slider",
        attrs: { min: 1, max: 16, step: 0.5 }, defaultValue: 2,
        tooltip: "连线的粗细（像素）。图案（蛇/吃豆人/文字）的大小也跟着它一起放大缩小。",
        onChange: (v) => { CFG.width = Number(v) || 2; },
    },
    {
        // ★ 2026-10-20：原来是 0~400 / step 5 ⇒ 数字没单位、滑块又短，
        //   想拖个"稍微慢一点"根本拖不准（step 5 一跳就 5 个单位）。
        //   改成 **0~200 / step 1**：鼠标拖 1 格 = 1 像素/秒，慢速区（10~40）占滑块 1/5，好瞄得多。
        //   名字直接把**单位写出来**，一眼就知道这数字是什么意思。
        id: `${NS}.speed`, name: "速度（像素/秒）", type: "slider",
        attrs: { min: 0, max: 200, step: 1 }, defaultValue: 40,
        tooltip: "流动速度 = 每秒在连线上前进多少像素。0 = 静止不动；40 = 正常；10~30 = 慢速；120+ = 飞快。",
        onChange: (v) => { CFG.speed = Number(v) || 0; },
    },
    {
        id: `${NS}.style`, name: "风格", type: "combo",
        options: _styleLabels(), defaultValue: "虚线流动",
        onChange: (v) => { CFG.style = v || "虚线流动"; },
    },
    {
        // ★ 文字流动的内容（自定义输入）。
        //   位置：排在 enabled 之前 ⇒ 倒序显示后「连线流动」仍在最顶、本项紧随其后。
        id: `${NS}.flowText`, name: "流动文字", type: "text",
        defaultValue: "关注小黑不迷路",
        onChange: (v) => {
            const s = (v === undefined || v === null) ? "" : String(v);
            CFG.flowText = s.trim() ? s : "关注小黑不迷路";
        },
    },
    {
        // ★ 统一的图案颜色：蛇 / 文字流动 / 吃豆人 全部用这一个（用户要求别再分两个）。
        //   🔴 ComfyUI **没有原生取色器**：实测 type:"color" 会被渲染成普通文本框
        //      （页面里 input[type=color] 数量为 0）。所以这里用 text 存 hex，
        //      再由 _installColorPicker() 在它旁边注入原生取色板，双向联动。
        //   位置：仍在 enabled 之前 ⇒ 倒序显示后「连线流动」在最顶、本项紧随其后。
        // type 用 text：官方渲染出来的就是普通文本框，**不会**冒出原生取色器
        // ⇒ 面板里只会有我们注入的那一套色板，不会两套并存。
        id: `${NS}.patternColor`, name: "图案颜色", type: "text",
        defaultValue: "#22d3ee",
        onChange: (v) => { CFG.patternColor = _normHex(v, "") || ""; },
    },
    {
        id: `${NS}.enabled`, name: "连线流动", type: "boolean", defaultValue: false,
        onChange: (v) => {
            CFG.enabled = !!v;
            if (CFG.enabled) { _ensureHook(); _start(); } else { _stop(); }
        },
    },
];

// category 必须三级：[扩展名, 分组, 这一项的名字]（抄 comfyui-kjnodes 的写法）
// 2026-10-19 加 🔁 家族图标（与节点标题 🔁XH-xxx 统一）；纯装饰，不影响排序。
const _cat = (itemName) => ["🔁 XH 工具箱", "连线", itemName];

function _registerSettings() {
    if (_registerSettings._done) return; // ★ 已注册过就跳过（顶层成功后 init 的兜底调用直接返回）
    const S = app.ui && app.ui.settings;
    if (!S || typeof S.addSetting !== "function") {
        console.error("[XH.Links] app.ui.settings.addSetting 不可用");
        return;
    }
    _registerSettings._done = true;
    for (const def of SETTING_DEFS) {
        try {
            S.addSetting({ ...def, category: _cat(def.name) });
        } catch (e) {
            console.error("[XH.Links] ❌ 设置注册失败:", def.id, def.type, e);
        }
    }
}

// ★ 2026-10-19 排序优化：设置面板「其他」栏按“注册先后”排序（前端 buildTree 不排序、
//   与名字/首字母无关）。其他竞品（mtb/EasyUse/KJNodes 等）都在 setup() 钩子才注册，
//   rgthree 虽是顶层注册但脚本位置在本文件之后——所以这里在脚本求值时（顶层）立刻注册，
//   即为全页第一个，设置面板「其他」栏稳排第一。init() 里保留兜底调用（幂等）。
try {
    _registerSettings();
} catch (e) {
    console.error("[XH.Links] 顶层注册设置异常:", e);
}

function _loadSettings() {
    try {
        const g = (k, d) => {
            const v = app.ui?.settings?.getSettingValue?.(`${NS}.${k}`);
            return (v === undefined || v === null || v === "") ? d : v;
        };
        CFG.enabled = !!g("enabled", false);
        CFG.style = g("style", "虚线流动");
        CFG.speed = Number(g("speed", 40)) || 0;
        CFG.width = Number(g("width", 2)) || 2;
        CFG.alpha = Number(g("alpha", 0.95)) || 0.95;
        CFG.reverse = !!g("reverse", false);
        CFG.marker = g("marker", "跟随官方");
        CFG.debugHit = !!g("debugHit", false);
        CFG.patternColor = _normHex(g("patternColor", "#22d3ee"), "#22d3ee");
        CFG.flowText = g("flowText", "关注小黑不迷路");
    } catch (e) {}
}

/** 执行高亮：记录当前正在跑的节点，绘制时把它的连线点亮。 */

// 🔴🔴 2026-10-23 修复「执行高亮连点亮从来没生效过」（同 xh_segment_table.js 那个坑）：
//   `window.comfyAPI.api` **不是** ComfyApi 实例，只是个命名空间壳（没有 addEventListener）。
//   原来写成 `const api = window.comfyAPI && window.comfyAPI.api; if (!api || !api.addEventListener) return;`
//   ⇒ 壳上没有 addEventListener ⇒ 直接 return ⇒ executing 事件一次都没订阅 ⇒ 跑起来连线永远不亮。
//   真实例藏在 comfyAPI.api.api 里（本文件第 12 行 `const { app } = window.comfyAPI.app;` 是同一套解构规律）。
let _xhExecApiBound = null;

/** 取真正的 ComfyApi 实例（有 addEventListener 的那个）。 */
function _xhApi() {
    const cands = [
        (typeof window !== "undefined" && window.app) ? window.app.api : null,
        window.comfyAPI && window.comfyAPI.api && window.comfyAPI.api.api,
        window.comfyAPI && window.comfyAPI.app && window.comfyAPI.app.app && window.comfyAPI.app.app.api,
        (typeof app !== "undefined" && app) ? app.api : null,
    ];
    for (const c of cands) {
        if (c && typeof c.addEventListener === "function") return c;
    }
    return null;
}

function _bindExecEvents() {
    const api = _xhApi();
    if (!api) {
        console.warn("[XH-流光连线] 拿不到 api 实例，执行高亮监听暂未挂载");
        return false;
    }
    if (_xhExecApiBound === api) return true;   // 已挂过，别重复绑
    const onExec = (e) => {
        let d = e && e.detail;
        // 兼容两种载荷：直接是节点 id 字符串，或 { node: id } 这类对象
        if (d && typeof d === "object" && !Array.isArray(d)) d = d.node !== undefined ? d.node : null;
        _executingNodeId = (d === undefined || d === null || d === "") ? null : d;
    };
    try {
        api.addEventListener("executing", onExec);
        for (const ev of ["execution_start", "execution_success", "execution_error", "execution_interrupted"]) {
            api.addEventListener(ev, () => { _executingNodeId = null; });
        }
        _xhExecApiBound = api;
        console.log("[XH-流光连线] 执行高亮监听已挂上");
        return true;
    } catch (e) {
        console.warn("[XH-流光连线] 执行高亮监听挂载失败:", e);
        return false;
    }
}

app.registerExtension({
    name: "XH.AnimatedLinks",

    init() {
        _registerSettings();
    },

    async setup() {
        _ensureHook();
        _loadSettings();
        // 🔴 2026-10-23：兜底重试（setup 时 api 实例可能还没就绪，挂不上就每 500ms 再试）
        if (!_bindExecEvents()) {
            let _tries = 0;
            const _iv = setInterval(() => {
                _tries += 1;
                if (_bindExecEvents() || _tries > 40) clearInterval(_iv);
            }, 500);
        }
        _installColorPicker();   // 内部会自检：官方若已渲染出原生取色器就不再注入
        if (CFG.enabled) _start();
    },
});

/**
 * ★ 给「图案颜色」那个文本框配一个**原生取色板**。
 *
 * 🔴 为什么要自己注入（2026-10-20 修正说法）：
 *    ComfyUI **有**原生取色器（前端自带 ColorPicker 组件，节点颜色控件 / 节点工具栏在用），
 *    但**设置面板没有把 `type:"color"` 接上去** —— 实测注册 type:"color" 后，
 *    面板里渲染出来的仍是 `<input type="text">`（整页原生取色器数量为 0）。
 *    ⇒ 颜色值仍按 text 存 hex，这里在它旁边补一个原生 `<input type="color">`，双向联动：
 *      取色板改 → 写回文本框 + 派发 input 事件（让 Vue/设置存值）
 *      文本框改 → 同步回取色板
 *    不修改官方控件本身，只加"伙伴节点"，Vue 重渲染把我们的冲掉也能自动补回来。
 */
function _installColorPicker() {
    if (_installColorPicker._on) return;
    _installColorPicker._on = true;

    let panel = null;
    const closePanel = () => { if (panel) { try { panel.remove(); } catch (e) {} panel = null; } };
    document.addEventListener("pointerdown", (e) => {
        if (!panel) return;
        if (panel.contains(e.target)) return;
        // 点色块本身 = 开/合（openPanel 自己会 toggle），别在这里先把它关掉
        if (e.target && e.target.closest && e.target.closest("[data-xh-swatch]")) return;
        closePanel();
    }, true);

    const applyColor = (inp, hex) => {
        try {
            inp.value = hex;
            // 🔴 2026-10-20：改成**不冒泡**。原来 bubbles:true 会把 input/change 一路冒到
            //    document，设置弹窗的全局监听收到后会把面板整个关掉（用户："一选色就退回画布"）。
            //    不冒泡照样能触发该 input 元素上 Vue 自己的 v-model 监听（它就在目标元素上）。
            inp.dispatchEvent(new Event("input", { bubbles: false }));
            inp.dispatchEvent(new Event("change", { bubbles: false }));
            CFG.patternColor = hex;
            try { app.canvas?.setDirty?.(true, true); } catch (e) {}
        } catch (e) {}
    };

    /**
     * ★ 2026-10-20 重做取色板（用户原话："选完一个准备好的图案就直接弹出设置界面回到画布，
     *   非常不好；自定义选色也一样会带着取色板退到画布，乱糟糟的"）。
     *
     * 🔴 两个真因：
     *   ① 旧色板是挂在 `document.body` 上的**浮层** ⇒ 对 ComfyUI 的设置弹窗来说，
     *      这属于"点到了弹窗外面" ⇒ 一点击就把整个设置面板关掉。
     *   ② 「自定义…」调的是原生 `input[type=color]` ⇒ 弹出的是**Windows 系统**取色对话框，
     *      它会抢走窗口焦点 ⇒ 设置弹窗失焦关闭（用户看到"带着取色板退到画布"）。
     *
     * ✅ 改法：
     *   ① 色板改成**内联展开**在「图案颜色」那一行的正下方 —— 它就在设置弹窗的 DOM 里，
     *      怎么点都是面板内部点击，物理上不可能被判成"点外面" ⇒ **设置面板再也不会被关掉**。
     *   ② 自定义改成**内嵌 HSV 取色板**（色域方块 + 色相条 + hex 输入），
     *      全程不调系统对话框 ⇒ 不会失焦、不会弹回画布。
     */
    const openPanel = (anchor, inp, swatch) => {
        if (panel && panel.isConnected) { closePanel(); return; }   // 再点色块 = 收起
        const cur = _normHex(CFG.patternColor, "#22d3ee");
        let hsv = _hexToHsv(cur);

        const p = document.createElement("div");
        p.dataset.xhColorPanel = "1";
        p.style.cssText =
            "margin:6px 0 10px;padding:8px;background:#191919;border:1px solid #3a3a3a;" +
            "border-radius:6px;width:100%;max-width:260px;box-sizing:border-box;";
        // 双保险：面板内的点击不往外冒（省得别的监听误判）
        p.addEventListener("pointerdown", (e) => e.stopPropagation());
        p.addEventListener("click", (e) => e.stopPropagation());

        // ---- ① 预设色（跟节点色板同一套）----
        const grid = document.createElement("div");
        grid.style.cssText = "display:grid;grid-template-columns:repeat(5,22px);gap:4px;";
        for (const hex of XH_PRESET_COLORS) {
            const b = document.createElement("div");
            b.title = hex;
            b.style.cssText =
                `width:22px;height:22px;border-radius:4px;background:${hex};cursor:pointer;` +
                `border:1px solid rgba(255,255,255,.18);`;
            b.addEventListener("click", () => {
                applyColor(inp, hex);                        // 应用 + 存值
                if (swatch) swatch.style.background = hex;
                sync(hex);                                   // 面板**保持打开**，方便继续调
            });
            grid.appendChild(b);
        }
        p.appendChild(grid);

        // ---- ② 内嵌 HSV 取色板 ----
        const W = 232, H = 110, HB = 12;
        const sv = document.createElement("canvas");
        sv.width = W; sv.height = H;
        sv.style.cssText = "display:block;margin-top:8px;border-radius:4px;cursor:crosshair;touch-action:none;";
        const hue = document.createElement("canvas");
        hue.width = W; hue.height = HB;
        hue.style.cssText = "display:block;margin-top:6px;border-radius:3px;cursor:pointer;touch-action:none;";
        p.appendChild(sv); p.appendChild(hue);

        const rowHex = document.createElement("div");
        rowHex.style.cssText = "display:flex;align-items:center;gap:6px;margin-top:8px;";
        const prev = document.createElement("div");
        prev.style.cssText = "width:24px;height:24px;border-radius:4px;border:1px solid rgba(255,255,255,.25);flex:0 0 auto;";
        const hexIn = document.createElement("input");
        hexIn.type = "text"; hexIn.spellcheck = false;
        hexIn.style.cssText =
            "flex:1 1 auto;min-width:0;background:#111;color:#ddd;border:1px solid #444;" +
            "border-radius:4px;font-size:11px;padding:3px 5px;";
        rowHex.appendChild(prev); rowHex.appendChild(hexIn);
        p.appendChild(rowHex);
        const tip = document.createElement("div");
        tip.textContent = "拖色域调深浅 · 拖色相条换颜色";
        tip.style.cssText = "margin-top:6px;font-size:10px;color:#888;";
        p.appendChild(tip);

        const drawSV = () => {
            const c = sv.getContext("2d");
            c.fillStyle = _hsvToHex(hsv[0], 1, 1); c.fillRect(0, 0, W, H);
            const g1 = c.createLinearGradient(0, 0, W, 0);
            g1.addColorStop(0, "rgba(255,255,255,1)"); g1.addColorStop(1, "rgba(255,255,255,0)");
            c.fillStyle = g1; c.fillRect(0, 0, W, H);
            const g2 = c.createLinearGradient(0, 0, 0, H);
            g2.addColorStop(0, "rgba(0,0,0,0)"); g2.addColorStop(1, "rgba(0,0,0,1)");
            c.fillStyle = g2; c.fillRect(0, 0, W, H);
            const x = hsv[1] * W, y = (1 - hsv[2]) * H;
            c.beginPath(); c.arc(x, y, 5, 0, 7);
            c.strokeStyle = "rgba(0,0,0,.7)"; c.lineWidth = 3; c.stroke();
            c.strokeStyle = "#fff"; c.lineWidth = 1.5; c.stroke();
        };
        const drawHue = () => {
            const c = hue.getContext("2d");
            const g = c.createLinearGradient(0, 0, W, 0);
            for (let i = 0; i <= 6; i++) g.addColorStop(i / 6, _hsvToHex(i * 60, 1, 1));
            c.fillStyle = g; c.fillRect(0, 0, W, HB);
            const x = (hsv[0] / 360) * W;
            c.fillStyle = "#fff"; c.fillRect(x - 2, -1, 4, HB + 2);
            c.strokeStyle = "rgba(0,0,0,.7)"; c.lineWidth = 1; c.strokeRect(x - 2, -1, 4, HB + 2);
        };
        /** 外部给定 hex ⇒ 刷新面板显示（不回写设置值） */
        const sync = (hex) => {
            hsv = _hexToHsv(hex);
            drawSV(); drawHue();
            prev.style.background = hex;
            if (document.activeElement !== hexIn) hexIn.value = hex;
        };
        /** 面板内改色 ⇒ 立即应用到连线（设置面板不会动） */
        const commit = () => {
            const hex = _hsvToHex(hsv[0], hsv[1], hsv[2]);
            drawSV(); drawHue();
            prev.style.background = hex;
            if (document.activeElement !== hexIn) hexIn.value = hex;
            applyColor(inp, hex);
            if (swatch) swatch.style.background = hex;
        };
        const drag = (el, fn) => {
            const at = (ev) => {
                const r = el.getBoundingClientRect();
                fn(Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)),
                   Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height)));
            };
            el.addEventListener("pointerdown", (ev) => {
                ev.preventDefault(); ev.stopPropagation();
                try { el.setPointerCapture(ev.pointerId); } catch (e) {}
                at(ev);
                const mv = (e2) => { e2.stopPropagation(); at(e2); };
                const up = () => {
                    el.removeEventListener("pointermove", mv);
                    el.removeEventListener("pointerup", up);
                    el.removeEventListener("pointercancel", up);
                };
                el.addEventListener("pointermove", mv);
                el.addEventListener("pointerup", up);
                el.addEventListener("pointercancel", up);
            });
        };
        drag(sv, (x, y) => { hsv[1] = x; hsv[2] = 1 - y; commit(); });
        drag(hue, (x) => { hsv[0] = x * 360; commit(); });
        hexIn.addEventListener("keydown", (ev) => {
            ev.stopPropagation();                     // 别让设置面板的快捷键截走
            if (ev.key === "Enter") ev.currentTarget.blur();
        });
        hexIn.addEventListener("change", () => {
            const h = _normHex(hexIn.value, null);
            if (h) { sync(h); applyColor(inp, h); if (swatch) swatch.style.background = h; }
            else hexIn.value = _hsvToHex(hsv[0], hsv[1], hsv[2]);
        });

        // ---- ③ 内联插到「图案颜色」那一行的下面（在设置弹窗 DOM 内！）----
        const host = anchor && anchor.parentNode ? anchor.parentNode : document.body;
        host.insertBefore(p, anchor.nextSibling);
        sync(cur);
        panel = p;
    };

    let pending = false, lastFull = 0, activeUntil = 0;
    const bind = () => {
        try {
            if (document.querySelector("[data-xh-picker]")) return;   // 已挂上 ⇒ 零成本退出
            // 🔴 精确定位（2026-10-20 修 bug）：旧写法用"祖先链文本包含『图案颜色』"来判断，
            //    但设置面板容器的 textContent 里含有**所有**设置项的名字 ⇒ 命中泛滥，
            //    实测给 6 个不相干的输入框都挂了取色器。
            //    改成：先精确定位 label「图案颜色」，再从它往上找**同一行**里的那个 input。
            const lbl = [...document.querySelectorAll("*")].find(
                (e) => e.children.length === 0 && (e.textContent || "").trim() === "图案颜色"
            );
            if (!lbl) return;
            let row = lbl;
            for (let i = 0; i < 5 && row; i++) {
                if (row.querySelector && row.querySelector("input")) break;
                row = row.parentElement;
            }
            if (!row) return;
            const inp = row.querySelector("input");
            if (!inp || inp.dataset.xhPicker) return;
            // 保险：万一官方渲染出了原生取色器，就不再加我们自己的（面板里只保留一套）
            if (row.querySelector('input[type="color"]')) { inp.dataset.xhPicker = "native"; return; }
            inp.dataset.xhPicker = "1";

            // 一个安静的小色块按钮（点它才弹出色板）—— 面板里不会再出现裸的原生取色框
            const swatch = document.createElement("div");
            swatch.title = "点这里选颜色";
            swatch.dataset.xhSwatch = "1";
            swatch.style.cssText =
                "width:20px;height:20px;border-radius:4px;margin-left:6px;vertical-align:middle;" +
                "cursor:pointer;border:1px solid rgba(255,255,255,.25);display:inline-block;flex:0 0 auto;" +
                "background:" + _normHex(CFG.patternColor, "#22d3ee") + ";";
            // ★ 插入点用 row（设置项整行）⇒ 取色面板展开在这一行下面、在设置弹窗 DOM 内
            swatch.addEventListener("click", (ev) => { ev.stopPropagation(); openPanel(row, inp, swatch); });
            inp.addEventListener("input", () => {
                const h = _normHex(inp.value, null);
                if (h) swatch.style.background = h;
            });
            if (inp.parentNode) inp.parentNode.insertBefore(swatch, inp.nextSibling);
        } catch (e) {}
    };
    // 🔴 性能（2026-10-20）：旧写法 = 「每次 DOM 变动」+「每 1.5 秒」都跑一次
    //    `[...document.querySelectorAll("*")].find(...)` —— 全 DOM 遍历（ComfyUI 常态几千个节点），
    //    而我们的动画本来就在每帧抢主线程，两者叠加就是白送的卡顿。
    //    改成三档：① 已挂上 ⇒ 一次 querySelector 就退出（几乎零成本）
    //              ② 刚点过「设置」按钮的 8 秒内 ⇒ 允许完整扫描（面板刚渲染）
    //              ③ 其余情况 ⇒ 最多 10 秒完整扫一次（兜底补漏）
    const schedule = (force) => {
        if (pending) return;
        pending = true;
        requestAnimationFrame(() => {
            pending = false;
            if (!force) {
                try { if (document.querySelector("[data-xh-picker]")) return; } catch (e) {}
                const t = performance.now();
                if (t < activeUntil) { /* 刚点过设置 ⇒ 放行 */ }
                else if (t - lastFull < 10000) return;
                lastFull = t;
            }
            bind();
        });
    };
    // 点「设置」按钮 ⇒ 打开 8 秒扫描窗口（用户真要看面板的时候才花这份钱）
    document.addEventListener("click", (e) => {
        try {
            const el = (e.target && e.target.closest)
                ? e.target.closest('[aria-label*="设置"],[aria-label*="Settings"],[title*="设置"]')
                : null;
            if (el) { activeUntil = performance.now() + 8000; schedule(true); }
        } catch (e) {}
    }, true);
    try {
        const mo = new MutationObserver(() => schedule(false));
        mo.observe(document.body, { childList: true, subtree: true });
    } catch (e) {}
    setInterval(() => schedule(false), 3000);   // 兜底：面板延迟渲染 / 被 Vue 冲掉都能补回来
    schedule(true);
}
