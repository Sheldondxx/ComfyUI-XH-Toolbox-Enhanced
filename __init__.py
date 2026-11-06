"""🔧 Comfyui-XH_Toolbox —— XH 节点合集（多包 → 1 个包，77 个节点）

合并历史：
  · 2026-09-22：首轮 9 原包 → 1 包
  · 2026-09-30：追加并入 AudioSep / LoraStack / Slider 三个 XH 小包
  · 2026-10-02：LoraStack 追加「🔁XH-纯LoRA堆栈」（只有 MODEL 口，不碰 CLIP），+1 节点
  · 2026-10-04：新增 `xh_utils` 模块（6 节点），替换 ComfyMath / easy-use / Apt_Preset 的
    工具节点（XHMathExpression / XHNumberConvert / XHSamplerSelect / XHSolidMask / XHVAEDecodeTiled）
    `Comfyui-XH_GroupExecutor`（17 节点）按用户要求保持独立，仍未并入。
  · 2026-10-05：新增 `soundboard` 模块（1 节点）：🔊XH-声音播放 —— 仿社区 pysssss 的 PlaySound，
    但「音效文件」下拉**实时扫描本地音效库** `web/sounds/<分类>/`（提示音 / 音效 / 音乐 / 人声），
    往目录丢音频 + F5 刷新即可选到，**不用重启**。音效库自带 27 个合成音效。
  · 2026-10-14：新增 `msr_relay` 模块（1 节点）：🔁XH-MSR精修编码 ——
    按「每段自带的时长」把多段提示词贴到视频的不同时间段上（LTX 2.5 二采精修防串味）。
    **算法自持**（不 import 上游 ComfyUI-PromptRelay，零第三方依赖），
    比上游多出：秒→帧自动换算 / 「硬度」六件套内置 / 段长结果用 info 输出可查。
    v1.9.35 面板精简：砍掉「每段秒数」独立框（时长并进分段稿段尾，写 `[3]` / `[3s]` / `[0-3]`）
    与 `h3_frame_snap` 开关（本节点只服务 LTX，H3 帧格与之无关），
    硬度六件套收进前端 ⚙（默认收起）⇒ 面板只剩 2 个文本框 + 1 条状态行。
  · 2026-10-16（v1.14.4）：🎵XH-加载音频 **加实时频谱律动条**（用户原话：「能不能添加一个，
    就是那个节奏动感的那种东西……能随着音频上下动的那个」= 音频频谱可视化）。
    播放器底部 40px 一排 32 根竖条，Web Audio API 的 AnalyserNode 对本节点自己的
    <audio> 实时 FFT，对数分组取峰值画条 + 条顶缓慢下落的峰值帽。
    AudioContext **全图共用一个**（浏览器限量约 6 个）、createMediaElementSource
    每元素只绑一次（二次绑定抛 InvalidStateError）、播放按钮里先 ctx.resume()
    （Chromium 自动播放策略：无手势不出声）、rAF 播放起 / 暂停·结束·错误·删节点停。
    零新增依赖（浏览器内置 API）。**纯前端改动，刷新即生效。**
    🔴 实测教训：canvas 写 height:100% 会被 flex 自动高度链解析到 HTML 默认属性高
    150px，把播放器撑到 163px、widget 锁高名存实亡 ⇒ canvas 高度必须定死 px。
  · 2026-10-20（v1.16.0）：**UI 家族统一 + 加载视频拖动轴 + 悬浮窗 + 关于徽章**——
      ① 家族 UI 单一真源 `web/xh_ui_kit.js`：按钮四档配色（中性/主色/危险红/幽灵）、
         齿轮折叠（方案 B 空心细线 Material 图标）、可读性反色计算，**全家族节点统一**。
      ② 📼XH-加载视频 **加拖动轴（剪映双手柄）**：轴上选哪段，预览播放器就只循环播哪段；
         按下手柄自动暂停、松手恢复；拖动参数端口被上游接管时整轴自动禁用（防白拖+假显示）。
      ③ 新增 `float_window` 模块：悬浮窗（任意窗口 / 多窗口并存 / 每窗独立控制 / 尺寸与不透明度可调）。
      ④ 设置面板新增「关于」徽章（官方 B 站链接 + 版本号走后端 `/xh/about`，版本单一真源 = 本文件 VERSION）。
      ⑤ 修 bug：提示词列表切回文本框后「调用顺序」残留、分组节点「全部颜色」下拉无色块（改自绘弹层）、
         提示词「清空」会误恢复旧内容。
  · 2026-10-24（v1.17.3）：`image_tools` 新增 **🎬XH-视频对比**（XHCompareVideos）——
       复刻 comfyui-easy-media 的 Compare Videos 并多路化：≤4 路视频网格同步播 / 单看 / 两两滑块；
       三路来源（source 口 + output 口 + 「📂 选择文件」三目录扫盘多选）汇成有序池去重保序；
       差值信息条列每路 fps/帧数/时长及相对第 1 路差值；⇄ 互换按钮纯前端换序。
       零新增依赖：VIDEO 元数据走官方 VideoInput getter（get_stream_source/get_duration/
       get_frame_rate/get_frame_count），不用 ffprobe；扫盘路由 /xh/videocompare/files。
  · 2026-10-24（v1.17.2）：**🔄XH-H3 latent接续 默认改“硬锁”接缝**（修段头动作节奏翻车）——
       对照导演台 TimelineDirector 源码（minimax_h3_finite_segments.py:613 gradient=False）：
       ① 新增 `hard_lock` 控件（BOOLEAN，默认开=硬锁，追加在 INPUT_TYPES required 最末尾，老存档按 positional 自动取新默认）；
       ② execute 的 `gradient=True` 改为 `gradient=not bool(hard_lock)`：硬锁时 overlap 区 noise_mask 全 0（整段 22 帧完全复现上段尾），节奏严格连续；
       ③ 修错误注释：原“gradient=True = 官方默认行为最流畅”是把函数签名默认值错当成 finite 分段行为（导演台 finite 实测用硬锁，演变是实验路径）——漂移根因：穿透区动作逐步重新演绎；
       ④ 对外行为变化：旧工作流加载后自动变硬锁（新默认），连接不用动；想要漂变手动切。
  · 2026-10-23（v1.17.1）：**🔁XH-H3 latent接续 去掉 GPL 依赖**（XHH3LatentContinuation 行为不变）——
      初版为图省事在运行期 `import` 了 ComfyUI-MiniMaxH3-TimelineDirector 的两个纯函数，
      而该插件及其上游 ethanfel/ComfyUI-MiniMaxH3-Contex-Loop 均为 **GPL-3.0**：
      ① 运行时 import 会把许可传染带进 XH 包的分发物；② 没装导演台的机器直接不可用。
      现按同一接口契约与数值语义**净室重写**（网格对齐 / 重叠搬运 / noise_mask /
      Drift-Control 调度全自研），只用 ComfyUI 官方公开 API：
      NestedTensor、FRAME_PER_TOKEN、set_model_denoise_mask_function、
      add_wrapper_with_key(WrappersMP.APPLY_MODEL)。
      节点类名/显示名/参数/默认值/返回值**一字未改** ⇒ 已存工作流零影响；
      与原版逐值等价验收 98 项全过（网格 27 / 搬运 3 形态 / 帧数边界 5 /
      调度函数 24 / 运行时 mask 15 / wrapper 2 / 错误路径 4 / 其他）。
      官方符号改延迟导入，没装 H3 支持的 ComfyUI 也不会拖垮整包加载。
  · 2026-10-23（v1.17.0）：`controls` 新增 **🔁XH-H3 动作校正**（XHH3TemporalCorrection）——
      TST（Temporal State Transport，arXiv:2609.08505，**MIT**）推理时注意力校正的
      H3 移植：按帧谱张力 T=H_row-H_vN 诊断「碎裂/过混」，用 gamma=exp(tau_eff·T)
      只缩放视频行 query，双向往中拉。治帧间闪烁、细节跳变、身份漂移、不符合物理的运动。
      MODEL→MODEL 补丁，可配任意采样器（不限于 SelfLift），运行时开销 1-2%。
      **算法按 MIT 论文自研重写**（comfyui-SelfLift 包内的 H3 移植没有 LICENSE，
      不复制其代码）；注入点全走官方 API（add_wrapper_with_key +
      optimized_attention_override，官方先例 nodes_sparse_attention.py:221-226），
      零第三方依赖。诊断日志前缀 [XH TST]；精确校准探针环境变量 XH_TST_EXACT=1。
  · 2026-10-16（v1.15.0）：🎵XH-加载音频 **加「📂 文件夹模式 + 循环轮次索引」**——
      用户原话：「之后我还会加入到我们 XH 家族的那个循环节点的循环当中……
      需不需要加个索引/序号，或者一个可以从文件夹里调整个文件夹的功能」。
    ① 循环体里死磕单文件 = 每轮读同一个文件，循环无意义 ⇒ 文件夹模式是刚需；
    ② 轮次**零接线**：XH-循环展开给所有 XH 节点注入隐藏输入 xh_loop_turn
       （for_loop.py 的 copy.set_input），节点在 hidden 里声明即可收到
       （不声明 = execution.py 静默丢弃，这是本次改动的根因认知）；
    ③ 索引三段论与 🔁XH-提示词表逐字同构：start_index 有接线以它为准 /
       否则循环体内段号=轮次 / 否则循环体外取第 1 个；loop 开关只管绕回；
    ④ 画布只存路径、execute 才读盘；口径 = filter_files_content_types(["audio","video"])
       （与下拉一致）、自然排序、上限 2000；**每轮只解码选中的那一个文件**；
    ⑤ 单文件模式一字未动，新控件全追加在老控件后（老存档零影响）；
    ⑥ 新增路由 /xh/audiolist/list（只读预览）+ /xh/audioload/file（FileResponse
       流式，带 Range，<audio> seek 可用）；probe 路由扩 path= 参数；
    ⑦ 🔴 修了一个真 bug：os.path.abspath("") = 服务器 cwd 而非空串 ⇒
       空路径会绕过校验去扫整个 ComfyUI 根目录，判空必须先判原串。
  · 2026-10-16（v1.15.1）：🎵XH-加载音频 **加「普通 / 循环模式折叠」**——
      用户原话：「这一个加载音频的节点变得特别太大了……搞一个选项按钮，
      一个普通模式一个循环模式，普通模式下节点比较小」。
    ① 工具栏加 🔁/🎵 模式切换钮：普通模式只剩 音频下拉+播放器+信息条
       （293px，折叠前 405px）；循环模式展开四件套（365px）；
    ② 模式状态不单独存：由 source 值推导（单文件=普通、📂文件夹=循环）⇒
       老存档读进来默认小节点，新档自动记住模式，零新增控件、零存档结构变动；
    ③ source 下拉两种模式都隐藏（模式钮取代它，值仍正常存档）；
    ④ 🔴🔴 实锤：Vue Nodes 模式下 computeSize=[0,0] 对原生控件**完全无效**
       （Vue 用自己的 DOM 布局，节点实测 405px 纹丝不动），隐藏原生控件行
       唯一有效开关 = **w.hidden**（仅对无输入端口的控件安全）——与 DOM widget
       的「视觉隐藏四件套」是两套机制，别混用；
    ⑤ 📂/🔁 按钮图标化：工具条 5 按钮总宽 282 > bar 246 会换行撑乱 ⇒
       图标 + tooltip 后一行放下；flash 反馈仍显示文字、2.5s 后复原图标；
    ⑥ 顺手修一个真 bug：只认 source 拉列表时「手动粘贴文件夹路径」不刷预览
       ⇒ audio_folder 一改也拉列表（与 📂 按钮同一条链路）。
  · 2026-10-16（v1.15.2）：🎵XH-加载音频 **加「📋 手动清单」+ 音频列表区**——
      用户原话：「循环模式不是分两种吗？一种是自己自主的添加音频……第二种就是
      选择的是同一个文件夹里的那些音频」（照 🖼️XH-图片列表抄交互）。
    ① source 三选一：单文件 / 📂 文件夹 / 📋 手动清单；循环模式下俩列表共用
       一块**音频列表区**（序号徽章 + 文件名 + ✕，限高 132px 内部滚动）；
    ② 手动清单：「⬆ 加音频」多选任意文件夹的文件 → 逐个**上传进 input 目录**
       并记文件名（原文件挪走也不丢）；拖着改顺序（HTML5 dnd + splice，与
       图片列表同款）、✕ 删单个、「清空」点两次才真清；
    ③ 序号徽章金/银/铜/蓝 = #e6b800/#9aa7b3/#cd7f32/#3a7bd5（图片列表逐字一致）；
    ④ 🔴 修一个真 bug（存档错位一格）：官方 LGraphNode.configure 遇到空串
       **会跳过一位** ⇒ ["a","","清单JSON",2,true] 被它填成 audio_folder=清单JSON、
       audio_list=2。前端 fixSavedValues 绝不能 filter 空值，必须连空槽一起按
       原下标对齐才能纠正官方填歪的那一轮；
    ⑤ 模式切换钮换琥珀 #EF9F27（旧紫 #7c5cbf 太闷，用户点名要对比更强）；
    ⑥ 工具条按模式只显示 5 颗（手动 = ⬆加音频+清空 换下 ⬆上传+📂），bar 246px 不换行。
  · 2026-10-16（v1.15.6）：📼XH-加载视频 **懒加载（只取音频不再爆内存）**——
    根因：ComfyUI 跑节点时会把整个 load_video 都执行、所有输出都算出来，即便下游
    只接 audio 口，IMAGE 批也会在音频之前堆出来 → 大视频必 OOM。修法：给节点注入
    `dynprompt`/`unique_id`（INPUT_TYPES 顶层 hidden={'dynprompt':'DYNPROMPT',
    'unique_id':'UNIQUE_ID'}，execution.py 经典路径 221-228 行会填），扫全图判断
    images 口（slot 0）有没有被下游接走；没人接就**跳过逐帧解码**，只吐音频（images
    返 1 帧零占位图，frame_count 走元数据估算）。探测失败一律保守照常解码，绝不误跳。
  · 2026-10-16（v1.15.5）：📼XH-加载视频 **内存保护**——用户加载 1080p/212s 长视频
    （586082402-1-208.mp4，全量 fp32 ≈158GB）直接 MemoryError 崩在 `_iter_frames`
    第 145 行的 np.array 分配。现把「逐帧循环」与「np.stack 拼批」都 try 住
    MemoryError，转成中文 ValueError 提示「视频太大，请把『帧数上限』设有限值（100~300）
    或在『自定义宽/高』缩小尺寸」，不再甩看不懂的 traceback。功能逻辑/输出不变。
  · 2026-10-16（v1.15.4）：📼XH-加载视频 补第 4 个输出口 **video（VIDEO）**——
    用户实测连不上官方「获取视频元素」（GetVideoComponents 输入是 VIDEO 类型，
    本节点原先只有 IMAGE/INT/AUDIO 三口）。机制与官方 LoadVideo 同源：
    `InputImpl.VideoFromFile(路径)` 原始文件直通，零转码零损失，位深/色彩空间真值；
    ⚠️ 该口不受抽帧/缩放/帧数上限影响（那些参数只管 images/audio）；函数内 import
    comfy_api，失败只打日志返回空，不拖垮图像/音频两口；追加在末位不串老档连线。
  · 2026-10-16（v1.15.3）：🎵XH-加载音频 **频谱贴底**——用户原话：「拖拽让节点变大的
    时候，只有下面的空白在变大……我希望那个波浪节奏跟着一起变化，贴合底部」。
    真机实锤（8199 无头三实验）：Vue 行高只在首帧读 computeSize（运行期换函数不理）；
    直接改 DOM 不被踩回；正解 = widgets 网格 flex:1 + 播放器行轨道 minmax(89px,1fr)。
    ① 频谱区改弹性主区（trackHit 0 0 auto / specWrap flex:1），节点拖高 ⇒ 波形区
       吃掉全部新增高度、信息条钉底，零空白；自然高度仍 89/40px 一字不变；
    ② 🔴 canvas 是替换元素：top/bottom 拉伸无效、auto 高落 HTML 默认 150 ⇒ 必须
       绝对定位 + calc(100%-18px)/(100%-6px) 显式尺寸，斩断「150px 撑胖播放器」循环；
    ③ applyStretch 底版模板按行数分档捕获（播放器行强制记 89，绝不照抄 computed 里
       自己拉伸过的残影），RO（拖大缩小）+ MO（Vue 重渲染踩掉内联）+ 250ms 限时重试
       三重兜底；onRemoved 全部 disconnect。
  · 2026-10-16：`controls` 新增 **🎵XH-加载音频**（XHLoadAudio），+1 节点（71）——
      用户原话：「官方的加载音频节点用着特别不方便，尤其是下面那条线（进度条）
      太细了，拖拽都不方便」。复刻官方 Load Audio：解码内核（f32_pcm + load）用脚本
      从 comfy_extras/nodes_audio.py 原文切出，**输出逐字一致可直接互换**；
      正主是前端自绘播放器：**粗时间线（10px 轨道 + 16px 圆形拖把手，按住拖动
      实时 seek、点击跳转）** + 播放/暂停 + 时间显示 + 音量静音切换与滑块 +
      信息条（时长/采样率/声道，走 /xh/audioload/probe 路由）+ 上传/拖拽。
      零新增依赖（av 为 ComfyUI 官方自带，函数内 import，缺了只废本节点）。
  · 2026-10-14（v1.9.36，**纯前端**）：修掉家族多个节点「工具条 / 状态条上下各留一大块空白、
    节点拖得越大空白越大」的老毛病（用户三轮反馈）。根因（comfyui_frontend 1.55.14 源码实证）：
    Vue Nodes（Nodes 2.0）把控件渲染成 CSS Grid，行高按 `shouldExpand(type) || hasLayoutSize`
    判 `auto`，而 `hasLayoutSize = typeof widget.computeLayoutSize === "function"`，
    DOM widget 的**基类自带** computeLayoutSize ⇒ 每个 DOM 控件行都是 `auto`，
    节点多余的竖向空间被平摊灌进去；**只写 computeSize 对 Vue 无效**（Vue 不看它）。
    新增 kit 的 `lockDomWidgetHeight(widget, px)`：定死 computeSize + 抹掉 computeLayoutSize
    ⇒ 行变 `min-content` 不再吃空间，多余空间只给文本框等真正的可生长控件（与官方节点一致）。
    已应用：工具条（全家族，kit 内）· MSR 状态行 · 提示词联结 工具条/状态行 · SetGet 通道行/工具条 ·
    分辨率预览条 · 种子按钮条/状态条 · 布尔开关轨 · 视频加载 播放器/信息条。
  · 2026-10-15（v1.9.39）：`setget` **标题 & 命名精简**（照 KJ 的 Set/Get 对齐）——
      · 单路标题改成 **`设置_<名字>`**（KJ 同款 `Set_66` 格式）：**去掉 🔁XH- 前缀、去掉 (类型) 后缀**；
        名称空 ⇒ 只显示「设置」；类型改由端口颜色 + 端口标签表达。
      · 节点显示名精简：🔁XH-设置→`设置`、🔁XH-获取→`获取`、🔁XH-多路设置→`多路设置`、🔁XH-多路获取→`多路获取`。
        旧节点标题用 LEGACY_TITLES 兜底自动迁移，重启即刷新。
      · 附带修复（用户截图报的）：
        ① 在名称框打字标题不跟着变 → 现在实时联动；
        ② 单路端口点是灰的 → 新前端(Vue Nodes)只按槽位 `type` 上色（不看 `slot.color`），
           改为把端口 `type/name` 设成真实类型（断开复位通配 `*`），端口点即跟随连线颜色。
  · 2026-10-15（v1.9.38）：`setget` **内核重写 + 补齐单路**（2 节点 → 4 节点）——
      · 旧内核是**结构性失效**的：XHMultiSet/XHMultiGet 是 isVirtualNode 虚拟节点，
        数据通路却写在 `onExecute()` 里写 `window.XH_SETGET` 全局表。而虚拟节点**永不执行**
        （官方 `graphToPrompt` 里 `if(isVirtualNode) continue`）⇒ onExecute 永不触发，表永远空。
      · 新内核改用**官方前端的虚拟节点解析钩子**（与 KJNodes 的 SetNode/GetNode 同源）：
        出图时官方对每个虚拟节点输出口依次问 `resolveVirtualOutput(slot)`（跨子图）
        → 否则 `getInputLink(slot)`（同图），把链路**直接接到真正的源节点**上。
        实证：`comfyui_frontend 1.55.14` 的 `ExecutableNodeDTO.resolveOutput` 原文即此顺序。
      · **补齐单路**：`XHSet`（显示名「设置」，1 进 + 1 透传出）/ `XHGet`（显示名「获取」，1 出）。
      · **与 KJ 互通**：XH 的获取端查找配对时同时认 KJNodes 的 `SetNode`（只在查找里比对
        type，**一行 KJ 源码都不改**）⇒「KJ 那边 Set，XH 这边 Get 也能取到」。
        反向（KJ 的 GetNode 取 XH 的 Set）必须改 KJ，按用户要求不做。
      · 保留原有 UI：动态通道行 + 点/框/线三同色 + 中英切换 + ➕➖ 工具条；
        新增连线自动命名（通道名还是默认名时借用上游口名，并自动去重 _2/_3）。
  · 2026-10-15（v1.9.37）：`image_tools` 新增 **2 节点（XH 原创）**，用于替代第三方包 ComfyUI-RMBG
    （该包在本机 import 失败：缺 hydra 等依赖 + 包自身 __init__ 报错 bug）——
      · 🖼️XH-去背景 (XHBackgroundRemove)：走 **ComfyUI 官方 BiRefNet 内核**
        （comfy.bg_removal_model），输出①透明背景 RGBA②前景遮罩；可选掩码羽化/偏移/反转。
        等价于官方「Remove Background → Invert Mask → Join Image with Alpha」串联链路。
        **端口对齐第三方 `RMBG`（image 进、IMAGE 出），工作流可零改线顶替。**
        权重放 models/background_removal/（birefnet.safetensors，官方 Comfy-Org/BiRefNet）。
      · 🖼️XH-图像对比拼图 (XHImageCompare)：最多 3 图横向并排 + 标题栏，**端口对齐
        第三方 `AILab_ImageCompare`**。纯 PIL，零新增依赖。

各子模块（数字 = 实际注册进 NODE_CLASS_MAPPINGS 的节点数，2026-10-14 实跑统计过，
不是估的）：

    memsaver/         ← Comfyui-XH_H3MemorySaver      3 节点  图像精度 / 落盘 / 读取
    image_tools/      ← Comfyui-XH_ImageTools        15 节点  按比例缩放 / 图像缩放v2 / 图像批量合并 / 取帧范围 /
                                                              图片列表 / 图像按序取 / 参考图拼接板 /
                                                              图像遮罩缩放 / 图像尺寸 / 合成并保存视频 / 视频拼接 /
                                                              加载视频（v1.9.33：复刻 VHS Load Video，
                                                              零新增依赖，带上传按钮+拖拽+信息条+内嵌播放器
                                                              +⚙一键折叠高级参数+▶预览总开关）
                                                              去背景（v1.9.37：官方 BiRefNet 内核，
                                                              输出透明 RGBA + 遮罩，端口对齐第三方 RMBG）
                                                              图像对比拼图（v1.9.37：最多 3 图并排+标题栏，
                                                              端口对齐第三方 AILab_ImageCompare）
    h3ltx_adapter/    ← XH-H3LTX-Adapter              2 节点  H3LTX-适配器加载 / 转换
    ltx_identity/     ← Comfyui-XH_LTXIdentity        1 节点  🔒XH-LTX锁脸
    seam_feather/     ← XH-SeamFeather                1 节点  🔁XH-衔接淡化
    seam_correct/     ← 🩹XH-接缝修正                 1 节点  算法照搬
                                                              ComfyUI_MinimaxH3_AutoContext（Apache-2.0）
    chain_prompt/     ← XH-ChainPrompt                2 节点  🔁XH-提示词表 / 🔁XH-提示词联结(动态)
    controls/         ← XH_GroupController 等         24 节点  循环开始/结束 / 分组控制 / 标签 / 计时器 /
                                                              LoopIteration·Progress·Result / 整数运算 /
                                                              浮点运算 / 数字计数器 / 分段表 / 色调补偿 /
                                                              分辨率选择器 / 种子 / 显示文本 / 音乐卡点表 /
                                                              加载音频（复刻官方 Load Audio，输出可互换，
                                                              前端粗时间线播放器：10px 轨道 + 16px 拖把手）/
                                                              H3 latent接续 / H3 动作校正（TST）
    audiosep/         ← ComfyUI-XH_AudioSep           4 节点  人声分离(加载/采样) / 音频取时长 / 简易数学
    lorastack/        ← Comfyui-XH_LoraStack          2 节点  🔁XH-LoRA堆栈 / 🔁XH-纯LoRA堆栈
    slider/           ← Comfyui-XH_Slider             1 节点  🔁XH-滑块
    setget/           ← XH Set/Get（v1.9.38 重写）       4 节点  设置 / 获取 /
                                                              多路设置 / 多路获取
                                                              （前端 registerCustomNodes 虚拟节点接管 +
                                                               Python noop 占位进 NODE_CLASS_MAPPINGS 供 object_info 搜索；
                                                               走官方 resolveVirtualOutput / getInputLink 钩子，
                                                               与 KJNodes Set/Get 同一套机制 ⇒ 互通，零改 KJ）
    xh_utils/         ← XH 工具扩展（2026-10-04）      8 节点  🔁XH-表达式求值 / 🔁XH-数值转换 /
                                                              🔁XH-采样器选择 / 🔁XH-实心遮罩 / 🔁XH-平铺VAE解码 / 🔁XH-形状遮罩覆盖 /
                                                              🧩XH-智能遮脸 / 🔁XH-区域限定框
                                                              （替换 ComfyMath / easy-use / Apt_Preset 的对应工具节点）
    soundboard/       ← 声音播放（2026-10-05）         1 节点  🔊XH-声音播放（跑完响一声；音效库 = web/sounds/）
    storyboard/       ← 宫格故事板（2026-10-09）       3 节点  🖼️XH-宫格底板 / 🖼️XH-图像对比度 / 🖼️XH-宫格切图
                                                                    （XH 复刻社区包 ComfyUI-Storyboard-Tools，
                                                                      核心算法一致，多出 cell_mask / info /
                                                                      brightness / strength / order / panel_count）
    camangle/          ← 机位描述（2026-10-11）          1 节点  📷XH-机位描述
                                                                    （角度→中英文镜头词，照 ComfyUI 官方 CameraAngle 逻辑，
                                                                       给 H3 / 文生图提示词当镜头语言；零依赖）
                                                                       v1.7.2：+官方同款可拖拽 3D 预览球（widgetType=
                                                                       CAMERA_ANGLE_VIEW 白嫖官方控件）+可选 image 贴图
                                                                       +下拉框中英双语（getOptionLabel，存值不动）
    caminfo/           ← 相机参数（2026-10-11）          1 节点  🎥XH-相机参数
                                                                    （造 camera_info 接官方 3D 节点；orbit/look_at 双模式、
                                                                       全中文、砍四元数、统一 zoom 语义；纯 Python 零依赖）
                                                                       v1.7.2：+官方同款可拖拽 3D 预览球（yaw/pitch 隐藏别名
                                                                       桥接同步）+下拉框中英双语
    controls/          ← 🔘XH-布尔开关 / 🔀XH-切换（2026-10-09）
                                                              2 节点  官方 Boolean + 「切换 BETA」的家族版：
                                                                      用官方 Boolean.Input 的 label_on/label_off
                                                                      把机翻的「为真实/为假实」改成「开/关」；
                                                                      界面＝**一行**：左右滑动的滑块，
                                                                      右=开（绿）/ 左=关（红）
    msr_relay/         ← MSR 精修编码（2026-10-14）      1 节点  🔁XH-MSR精修编码
                                                                    （分段稿每段末尾写时长，
                                                                      给 LTX 2.5 二采精修防串味。
                                                                      算法自持、零第三方依赖：
                                                                      不 import 上游 ComfyUI-PromptRelay；
                                                                      多出秒→帧换算、硬度六件套内置、
                                                                      段长 info 可查。面板只剩 2 个
                                                                      文本框 + 1 条状态行，其余 7 个
                                                                      参数收进 ⚙）
                                                                    ── 共 71 个

合并原则（重要，改这个包之前先读）：
  · **class_type 一个都没改** → 已存工作流全部照常识别，零迁移成本
  · 各子模块内部**保持原样**：它们原有的相对导入（如 `from .py.xxx import`、
    `from .nodes import`、`from .h3ltx import`）因为原来是「包根 → 子目录」、
    现在是「子包根 → 子目录」，层级完全没变，所以**一行都不用改**
  · 前端 js 全部汇到顶层 `web/`（全包唯一 `WEB_DIRECTORY`）。
    它们内部的 `import { app } from "../../scripts/app.js"` 依赖「js 位于
    /extensions/<包名>/ 下一层」这个基准 —— 包名换了但层数没变，同样不用改
  · 旧包整份留底在 桌面\\AI创作产出\\备份_20260922\\合并前_6原包\\，可随时回滚

🔴 容错加载（2026-10-05 改造，为「分发给别人、别人拿到就能用」）：
  · 18 个子模块**逐个 try 导入** → 缺依赖只少对应模块，不再整包阵亡；
    缺哪个包、装完要重启，启动日志末尾会直接写清楚（含可照抄的 pip 命令）。
  · 分发用依赖清单 = 包内 `requirements.txt`（硬依赖 3 个：
    opencv-python / scenedetect / rotary-embedding-torch），
    ComfyUI-Manager 启动时会自动读取并提示安装。
  · 「哪个子模块依赖哪个包」的实测对照表见 README §5。

⚠ 改这个文件时注意：新增子模块必须同样用 try 包住，否则等于把整包重新绑上炸药。
"""

# ---------------------------------------------------------------------------
# 📌 包版本号（统一来源：与 pyproject.toml 的 version 保持一致）
#    分发 / 压缩命名规范：Comfyui-XH_Toolbox_v{主}.{次}.{修}_{YYYYMMDD}.zip
#    改完节点包后升级对应位，再重新压缩，文件名版本号才对得上。
# ---------------------------------------------------------------------------
VERSION = "1.17.5"

# ---------------------------------------------------------------------------
# 🔴 子模块加载：逐个 try，缺谁只少谁（2026-10-05 改造，为「分发给别人」而做）
# ---------------------------------------------------------------------------
# 为什么不能继续裸 import：66 个节点分在 18 个子模块里，子模块各自要 import
# 第三方包（cv2 / scenedetect / rotary_embedding_torch / torchaudio …）。
# 裸 import 时，别人**少装任意一个包** → 整包 import 失败 → 界面上一个节点都没有，
# 日志里只有一行 "Cannot import ..."，用户完全不知道缺什么、怎么修。
# 逐个 try 之后：缺 cv2 就只少「🩹XH-接缝修正」那 1 个节点，其余 56 个照常可用；
# 日志里直接给出「缺哪个包 + 照抄就能用的 pip 命令」。
# 依赖清单同步写在包内 requirements.txt，ComfyUI-Manager 会自动读取并安装。
#
# 设计约束（改这里之前先读）：
#   · 只打日志、绝不 re-raise —— 单个子模块的问题不允许拖垮整包
#   · _PARTS 的顺序 = 节点注册顺序，加载失败的（空映射）自动跳过，不占位
#   · deps 写法 (import 名, pip 名)；pip 名写 None 表示 PyPI 上没有正式包，只给说明

import os as _os
import sys as _sys

_PY = _sys.executable or "python"          # 当前在跑的 python（ComfyUI 的 venv）
_HERE = _os.path.dirname(_os.path.abspath(__file__))
_LOAD_FAILED = []                          # [(子模块名, 用途, [pip 包], 异常摘要)]


# ComfyUI 官方 requirements.txt 里本来就有的包 —— 别人机器上必然存在。
# 它们要是也缺，那是 ComfyUI 本身坏了，不是本包的事；所以**不写进安装提示**，
# 免得提示里出现 torch 把用户吓到（以为要重装 torch）。
_CORE = {"torch", "numpy", "safetensors", "Pillow", "einops", "aiohttp"}


# ---------------------------------------------------------------------------
# 🚀 自动补依赖（2026-10-05，为「别人拿到就能用」而做）
# ---------------------------------------------------------------------------
# 白名单：只认下面这 3 个「本包独有、无害」的小包。**绝不碰** torch 系
# （torch / torchaudio / torchvision）与 numpy / Pillow 等 ComfyUI 核心包 ——
# 那些一旦被 pip 重装可能毁掉别人的 CUDA 环境，必须留给用户按官方指引装。
#
# 流程：启动时先看缺哪些 → 缺就 pip 装（默认走清华镜像，国内没魔法也能下）→
#      装完 invalidate_caches() 让**本次启动**立刻就能 import，不用手动重启。
# 关闭：设环境变量 XH_TOOLBOX_NO_AUTOINSTALL=1 即完全跳过，退回「只提示不装」。
#
# 为什么敢自动装（与 README「不偷偷装」并不矛盾）：
#   · 只装写死的这 3 个包，不读任何外部文件、不执行 requirements 里的任意内容
#   · 命令不带 --upgrade / -r，pip 只「补齐缺失」；已满足的包原封不动
#   · 全程 try/except + 超时，失败只打印提示，绝不让整包加载失败
_AUTO_DEPS = (
    ("cv2", "opencv-python", "接缝校正 / 锁脸"),
    ("scenedetect", "scenedetect", "接缝校正·场景切分"),
    ("rotary_embedding_torch", "rotary-embedding-torch", "人声分离"),
)
_MIRROR = "https://pypi.tuna.tsinghua.edu.cn/simple"


def _auto_install_deps():
    """启动自检：缺那 3 个白名单包就自动补装（失败不影响加载）。"""
    if _os.environ.get("XH_TOOLBOX_NO_AUTOINSTALL", "").strip().lower() in (
            "1", "true", "yes", "on"):
        print("[XH-Toolbox] 已按 XH_TOOLBOX_NO_AUTOINSTALL 跳过依赖自动安装。")
        return

    import importlib.util
    missing = []
    for imp, pip_name, usage in _AUTO_DEPS:
        try:
            if importlib.util.find_spec(imp) is None:
                missing.append((pip_name, usage))
        except Exception:
            missing.append((pip_name, usage))
    if not missing:
        return

    pkgs = [p for p, _ in missing]
    print(f"[XH-Toolbox] 📦 依赖自检：缺 {len(pkgs)} 个 → {', '.join(pkgs)}")
    for _p, _u in missing:
        print(f"[XH-Toolbox]      · {_p}（{_u}）")
    print("[XH-Toolbox]     正在自动安装（首次较慢，别关窗口）…")

    import subprocess
    _base = [_PY, "-m", "pip", "install", "--no-input",
             "--disable-pip-version-check", "--no-warn-script-location",
             "--prefer-binary"]
    # 依次尝试三个源，任一成功即止；全部失败/超时才放弃（单个源最多等 300s）：
    #   ① 清华镜像（国内秒下，无魔法也能用）② PyPI 官方源 ③ 完全按对方自己的 pip 配置
    _attempts = (
        ["-i", _MIRROR],
        ["-i", "https://pypi.org/simple"],
        [],
    )
    ok = False
    for _idx, _opt in enumerate(_attempts, 1):
        try:
            _r = subprocess.run([*_base, *_opt, *pkgs],
                                capture_output=True, text=True, timeout=300)
            if _r.returncode == 0:
                ok = True
                break
            _tail = ((_r.stderr or "") + (_r.stdout or "")).strip().splitlines()[-2:]
            print(f"[XH-Toolbox]     第 {_idx} 个源失败（code={_r.returncode}）：{' | '.join(_tail)}")
        except subprocess.TimeoutExpired:
            print(f"[XH-Toolbox]     第 {_idx} 个源超时（300s），换下一个源…")
        except Exception as _e2:
            print(f"[XH-Toolbox]     第 {_idx} 个源出错：{type(_e2).__name__}: {_e2}")

    if ok:
        try:
            import importlib
            importlib.invalidate_caches()      # 让本次启动就能 import 到新装的包
        except Exception:
            pass
        print("[XH-Toolbox]     ✅ 依赖已补齐，本次启动直接生效（不必重启）。")
    else:
        print("[XH-Toolbox]     ⚠ 三个源都没装上（可能真没网 / 被限制）。不影响使用："
              "相关节点会缺，其余照常。")
        print(f"[XH-Toolbox]       联网后手动补：\"{_PY}\" -m pip install {' '.join(pkgs)}")


_auto_install_deps()


def _fail(mod, usage, deps, err):
    """记录一个子模块的加载失败：只打日志，绝不外抛。"""
    top = (getattr(err, "name", "") or "").split(".")[0]
    if top:
        # 报错点名的那一个排最前（最可能的原因）；同模块的其余「非核心」依赖跟在后面 ——
        # 一次装全，别让用户装一个试一次（缺 cv2 和 scenedetect 都只影响同一模块）
        hit = ([(i, p) for i, p in deps if i == top]
               + [(i, p) for i, p in deps if i != top and i not in _CORE])
    else:
        hit = list(deps)
    pips = [p for _, p in hit if p]
    soft = [i for i, p in hit if not p]
    _LOAD_FAILED.append((mod, usage, pips, f"{type(err).__name__}: {err}"))
    print(f"[XH-Toolbox] ⚠ 子模块 {mod} 加载失败（{usage}）→ 只缺这部分节点，其余照常")
    print(f"[XH-Toolbox]     原因：{type(err).__name__}: {err}")
    if pips:
        print(f"[XH-Toolbox]     修复：\"{_PY}\" -m pip install {' '.join(pips)}")
        if "torchaudio" in pips:
            print("[XH-Toolbox]     注意：torchaudio 建议按 PyTorch 官网指引装与 torch 匹配的版本，"
                  "直接 pip install 可能连带重装 torch。")
    if soft:
        print(f"[XH-Toolbox]     可选：{', '.join(soft)} 在 PyPI 上没有正式包，需从官方渠道获取"
              "（不装则该模块的对应功能不可用）。")


try:
    from .memsaver import (
        NODE_CLASS_MAPPINGS as _M_MEM,
        NODE_DISPLAY_NAME_MAPPINGS as _D_MEM,
    )
except Exception as _e:
    _fail("memsaver", "图像精度 / 落盘 / 读取",
          [("torch", "torch"), ("safetensors", "safetensors")], _e)
    _M_MEM = _D_MEM = {}

try:
    from .image_tools import (
        NODE_CLASS_MAPPINGS as _M_IMG,
        NODE_DISPLAY_NAME_MAPPINGS as _D_IMG,
    )
except Exception as _e:
    _fail("image_tools", "图像缩放 / 批量合并 / 取帧 / 拼接板 / 遮罩缩放 / 图像尺寸",
          [("PIL", "Pillow"), ("nvvfx", None)], _e)
    _M_IMG = _D_IMG = {}

try:
    from .h3ltx_adapter import (
        NODE_CLASS_MAPPINGS as _M_ADP,
        NODE_DISPLAY_NAME_MAPPINGS as _D_ADP,
    )
except Exception as _e:
    _fail("h3ltx_adapter", "H3→LTX 适配器",
          [("torch", "torch"), ("safetensors", "safetensors")], _e)
    _M_ADP = _D_ADP = {}

try:
    from .ltx_identity import (
        NODE_CLASS_MAPPINGS as _M_ID,
        NODE_DISPLAY_NAME_MAPPINGS as _D_ID,
    )
except Exception as _e:
    _fail("ltx_identity", "LTX 锁脸",
          [("PIL", "Pillow"), ("cv2", "opencv-python"), ("insightface", "insightface")], _e)
    _M_ID = _D_ID = {}

try:
    from .seam_feather import (
        NODE_CLASS_MAPPINGS as _M_SEAM,
        NODE_DISPLAY_NAME_MAPPINGS as _D_SEAM,
    )
except Exception as _e:
    _fail("seam_feather", "衔接淡化", [("torch", "torch")], _e)
    _M_SEAM = _D_SEAM = {}

try:
    from .chain_prompt import (
        NODE_CLASS_MAPPINGS as _M_CHAIN,
        NODE_DISPLAY_NAME_MAPPINGS as _D_CHAIN,
    )
except Exception as _e:
    _fail("chain_prompt", "提示词表", [], _e)
    _M_CHAIN = _D_CHAIN = {}

try:
    from .controls import (
        NODE_CLASS_MAPPINGS as _M_CTRL,
        NODE_DISPLAY_NAME_MAPPINGS as _D_CTRL,
    )
except Exception as _e:
    _fail("controls", "循环 / 分组控制 / 标签 / 计时器 / 分段表 / 分辨率选择器 / 显示文本",
          [("aiohttp", "aiohttp"), ("torch", "torch")], _e)
    _M_CTRL = _D_CTRL = {}

try:
    from .audiosep import (
        NODE_CLASS_MAPPINGS as _M_AUD,
        NODE_DISPLAY_NAME_MAPPINGS as _D_AUD,
    )
except Exception as _e:
    _fail("audiosep", "人声分离",
          [("torch", "torch"), ("torchaudio", "torchaudio"), ("einops", "einops"),
           ("rotary_embedding_torch", "rotary-embedding-torch")], _e)
    _M_AUD = _D_AUD = {}

try:
    from .lorastack import (
        NODE_CLASS_MAPPINGS as _M_LRS,
        NODE_DISPLAY_NAME_MAPPINGS as _D_LRS,
    )
except Exception as _e:
    _fail("lorastack", "LoRA 堆栈", [("aiohttp", "aiohttp")], _e)
    _M_LRS = _D_LRS = {}

try:
    from .slider import (
        NODE_CLASS_MAPPINGS as _M_SLD,
        NODE_DISPLAY_NAME_MAPPINGS as _D_SLD,
    )
except Exception as _e:
    _fail("slider", "滑块", [], _e)
    _M_SLD = _D_SLD = {}

try:
    from .setget import (
        NODE_CLASS_MAPPINGS as _M_SG,
        NODE_DISPLAY_NAME_MAPPINGS as _D_SG,
    )
except Exception as _e:
    _fail("setget", "多路 Set/Get", [], _e)
    _M_SG = _D_SG = {}

try:
    from .xh_utils import (
        NODE_CLASS_MAPPINGS as _M_UTIL,
        NODE_DISPLAY_NAME_MAPPINGS as _D_UTIL,
    )
except Exception as _e:
    _fail("xh_utils", "表达式求值 / 数值转换 / 采样器选择 / 实心遮罩 / 平铺VAE解码",
          [("torch", "torch")], _e)
    _M_UTIL = _D_UTIL = {}

try:
    from .seam_correct import (
        NODE_CLASS_MAPPINGS as _M_SCOR,
        NODE_DISPLAY_NAME_MAPPINGS as _D_SCOR,
    )
except Exception as _e:
    _fail("seam_correct", "接缝修正",
          [("cv2", "opencv-python"), ("scenedetect", "scenedetect")], _e)
    _M_SCOR = _D_SCOR = {}

try:
    from .soundboard import (
        NODE_CLASS_MAPPINGS as _M_SND,
        NODE_DISPLAY_NAME_MAPPINGS as _D_SND,
    )
except Exception as _e:
    _fail("soundboard", "声音播放", [], _e)
    _M_SND = _D_SND = {}

try:
    from .storyboard import (
        NODE_CLASS_MAPPINGS as _M_SB,
        NODE_DISPLAY_NAME_MAPPINGS as _D_SB,
    )
except Exception as _e:
    _fail("storyboard", "宫格底板 / 图像对比度 / 宫格切图", [("torch", "torch")], _e)
    _M_SB = _D_SB = {}

try:
    from .camangle import (
        NODE_CLASS_MAPPINGS as _M_CAM,
        NODE_DISPLAY_NAME_MAPPINGS as _D_CAM,
    )
except Exception as _e:
    _fail("camangle", "机位描述 / 相机角度提示词", [], _e)
    _M_CAM = _D_CAM = {}

try:
    from .caminfo import (
        NODE_CLASS_MAPPINGS as _M_CAMINFO,
        NODE_DISPLAY_NAME_MAPPINGS as _D_CAMINFO,
    )
except Exception as _e:
    _fail("caminfo", "相机参数 / camera_info 生成", [], _e)
    _M_CAMINFO = _D_CAMINFO = {}

try:
    from .msr_relay import (
        NODE_CLASS_MAPPINGS as _M_MSR,
        NODE_DISPLAY_NAME_MAPPINGS as _D_MSR,
    )
except Exception as _e:
    _fail("msr_relay", "MSR 精修编码（按秒贴分段提示词）", [("torch", "torch")], _e)
    _M_MSR = _D_MSR = {}

# (子模块名, class 映射, 显示名映射) —— 顺序即注册顺序
# 加载失败的子模块在 except 里被填成 {}，这里直接过滤掉（不占位、不报重名）
_PARTS = tuple(
    _p for _p in (
        ("memsaver", _M_MEM, _D_MEM),
        ("image_tools", _M_IMG, _D_IMG),
        ("h3ltx_adapter", _M_ADP, _D_ADP),
        ("ltx_identity", _M_ID, _D_ID),
        ("seam_feather", _M_SEAM, _D_SEAM),
        ("seam_correct", _M_SCOR, _D_SCOR),
        ("chain_prompt", _M_CHAIN, _D_CHAIN),
        ("controls", _M_CTRL, _D_CTRL),
        ("audiosep", _M_AUD, _D_AUD),
        ("lorastack", _M_LRS, _D_LRS),
        ("slider", _M_SLD, _D_SLD),
        ("setget", _M_SG, _D_SG),
        ("xh_utils", _M_UTIL, _D_UTIL),
        ("soundboard", _M_SND, _D_SND),
        ("storyboard", _M_SB, _D_SB),
        ("camangle", _M_CAM, _D_CAM),
        ("caminfo", _M_CAMINFO, _D_CAMINFO),
        ("msr_relay", _M_MSR, _D_MSR),
    ) if _p[1]
)

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
_owner = {}          # class_type -> 来源子模块（重名时用来报清楚是谁撞了谁）

for _mod, _cm, _dm in _PARTS:
    for _key, _cls in _cm.items():
        if _key in NODE_CLASS_MAPPINGS:
            # 不 raise：单个重名不该让整包加载失败。但一定要吼出来，
            # 因为静默覆盖正是合并这类操作最阴的坑。
            print(
                f"[XH-Toolbox] ⚠ class_type 重名：{_key} "
                f"来自 {_owner[_key]} 与 {_mod}，后者已覆盖前者！"
            )
        NODE_CLASS_MAPPINGS[_key] = _cls
        _owner[_key] = _mod
    NODE_DISPLAY_NAME_MAPPINGS.update(_dm)

# 🔴 全包唯一的 WEB_DIRECTORY —— 28 个前端 js（中/EN 切换 + 参数标签本地化 +
#    controls 三件套的界面 + 声音播放的前端）全部放在这里。
#    子模块里也各有一句 WEB_DIRECTORY = "web"，但那是死变量：
#    ComfyUI 只认顶层自定义节点目录的声明，子目录里的不会被读取。
WEB_DIRECTORY = "web"

# ---------------------------------------------------------------------------
# 📋 设置面板「关于」徽章的数据源（2026-10-20 新增）
#    前端 web/xh_about.js 用它在设置面板顶部画「版本号 + B 站」两颗徽章。
#    为什么要走后端而不是前端硬写：VERSION 的唯一真源就是本文件这一行，
#    前端再抄一份必然漂移（改了版本号忘了改前端 ⇒ 徽章显示旧版本）。
# ---------------------------------------------------------------------------
def _register_about_route():
    """把 {version, name, bilibili, tagline} 暴露给前端。失败只打日志，不影响加载。"""
    try:
        from aiohttp import web
        from server import PromptServer

        if getattr(PromptServer.instance, "_xh_about_route_done", False):
            return
        routes = PromptServer.instance.routes

        @routes.get("/xh/about")
        async def _xh_about(request):        # noqa: ARG001
            from . import VERSION as _V
            return web.json_response({
                "name": "Comfyui-XH_Toolbox",
                "version": _V,
                "bilibili": "https://space.bilibili.com/96854764",
                "tagline": "8g显存小黑的折腾日记",
            })

        PromptServer.instance._xh_about_route_done = True
    except Exception as _e:                   # noqa: BLE001
        print(f"[XH-Toolbox] ⚠ /xh/about 路由注册失败（设置面板徽章降级）：{_e}")


_register_about_route()

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]

# 2026-10-16：「🔄 刷新框数 / 刷新段数」按钮（ChainPrompt / SegmentTable）已删除 ——
#   框数/段数早就是节点自身参数 + 纯前端折叠，改数字实时生效，按钮 100% 冗余；
#   后端 /xh_chainprompt/set_slots、/xh_segments/set_slots 两条路由同轮清掉
#   （chain_prompt 子模块的 register_routes 已成空函数，分段表的 register_routes 已删）。

# 加载自检：把注册结果打进日志，方便一眼看出包有没有被加载、节点数对不对
print(f"[XH-Toolbox] ✅ Comfyui-XH_Toolbox v{VERSION} 已加载 {len(NODE_CLASS_MAPPINGS)} 个节点，来自 {len(_PARTS)} 个模块")

# 有子模块没加载起来时，给一份**可以照着做**的汇总（对分发给别人的场景最要紧：
# 对方不会看逐条日志，但一定会看最后这几行）
if _LOAD_FAILED:
    _bar = "=" * 72
    print(f"[XH-Toolbox] {_bar}")
    print(f"[XH-Toolbox] ⚠ {len(_LOAD_FAILED)} 个子模块没加载起来，"
          f"对应节点会缺失（其余 {len(NODE_CLASS_MAPPINGS)} 个节点正常可用）：")
    for _mod, _usage, _pips, _err in _LOAD_FAILED:
        print(f"[XH-Toolbox]     · {_mod}（{_usage}）→ {_err}")
        if _pips:
            print(f"[XH-Toolbox]         \"{_PY}\" -m pip install {' '.join(_pips)}")
    print(f"[XH-Toolbox] 一键补齐全部依赖："
          f"\"{_PY}\" -m pip install -r \"{_HERE}\\requirements.txt\"")
    print("[XH-Toolbox] 装了 ComfyUI-Manager 的话，它会在启动时自动提示安装缺失依赖。")
    print("[XH-Toolbox] 装完**重启** ComfyUI 才会生效。")
    print(f"[XH-Toolbox] {_bar}")
