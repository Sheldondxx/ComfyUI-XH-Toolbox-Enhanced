# 🖼️XH-图像工具（Comfyui-XH_ImageTools）

把 comfyui-kjnodes 里那两个**天天用、但全英文看不懂**的节点，复刻成 XH 自己的中文版。

| 新节点（本包） | 复刻自（KJNodes） | class_type 键 |
|---|---|---|
| 🖼️XH-图像缩放v2 | `Resize Image v2` / `ImageResizeKJv2` | `XHImageResizeV2` |
| 🖼️XH-图像批量合并 | `Image Batch Multi` / `ImageBatchMulti` | `XHImageBatchMulti` |

> 另含内部依赖 `XHImagePadKJ`（← `ImagePadKJ`），被「补边」模式调用，**不单独注册**。

---

## 一、改了什么（只有显示层）

| # | 改动 | 说明 |
|---|---|---|
| 1 | 类名加 XH 前缀 | 与 KJNodes 撞名？不会 —— 键不同，**两套可同时安装** |
| 2 | `CATEGORY` | `KJNodes/image` → `🔁XH/Image` |
| 3 | 全部参数补中文 tooltip | 每个都保留 `English: xxx` 原词，方便对照官方文档 |
| 4 | 4 个下拉 → 「① 中文 (english)」 | 后端 `_xh_norm()` 收敛回英文原值 → **旧工作流 / API 完全兼容** |
| 5 | `DESCRIPTION` 中文 | 鼠标悬停节点标题的 `?` 能看到 |
| 6 | 前端 js | 节点底部 **「中 / EN」** 按钮，一键切换标题 + 参数标签 + 端口名（含动态端口） |
| 7 | 动态输入口 | 「🔄 更新输入口」按钮（逻辑移植自 KJNodes `jsnodes.js` 的 `setupDynamicInputs`） |

**没有改**：任何计算逻辑、默认值、参数声明顺序、返回值顺序、`FUNCTION` 名。

### 怎么证明没改算法

```bash
# 与原版逐行 diff：差异只应落在注释 / tooltip / 下拉文字 / 分类 / 描述
# 计算逻辑关键词（torch. / common_upscale / .narrow / F.interpolate …）应 0 处命中
```

实测：三段合计差异 109 行，**计算逻辑改动 0 处**；反向校验原版计算语句**缺失 0 条**。

---

## 二、参数中文对照

### 🖼️XH-图像缩放v2

| 英文原名 | 中文标签 | 干什么 |
|---|---|---|
| `image` | 图像 | 输入图像（可批次） |
| `width` / `height` | 目标宽度 / 目标高度 | 填 0 = 按另一边自动等比推算 |
| `upscale_method` | 缩放算法 | `lanczos` 最锐（仅 CPU）；`area` 缩小最平滑 |
| `keep_proportion` | **保持比例方式** | ★ 这个节点最关键的一格，见下 |
| `pad_color` | 补边颜色 | 仅「补边·纯色」生效 |
| `crop_position` | 裁切位置 | 决定从哪边裁 / 内容贴哪边 |
| `divisible_by` | 整除对齐 | 输出宽高向下取整到它的倍数（喂视频模型填 32/64） |
| `device` | 计算设备 | CPU / GPU（lanczos 不支持 GPU） |
| `mask` | 蒙版 | 跟着一起缩放/裁切/补边 |

**`keep_proportion` 八种模式：**

| 显示 | 值 | 行为 | 输出尺寸 |
|---|---|---|---|
| ① 拉伸铺满 | `stretch` | 不管比例硬拉 | = 目标（会变形） |
| ② 等比缩放 | `resize` | 只缩不裁，缩到能塞进框 | **可能小于目标**（不改画幅！1:1 进 1:1 出） |
| ③ 补边·纯色 | `pad` | 缩放后空处补指定色 | = 目标 |
| ④ 补边·边缘均值 | `pad_edge` | 补边用边缘平均色（边缘延展） | = 目标 |
| ⑤ 补边·边缘像素 | `pad_edge_pixel` | 补边用边缘原像素外拉（会拉丝） | = 目标 |
| ⑥ **裁剪填满** | `crop` | **先按目标画幅裁一刀再缩满** | **= 目标（精确）** |
| ⑦ 补边·毛玻璃 | `pillarbox_blur` | 背景放大+模糊+压暗当底 | = 目标 |
| ⑧ 等总像素 | `total_pixels` | `width×height` 当总像素数分配 | 按原比例 |

> **要「改画幅比例」必须用 ⑥ `crop`** —— ② `resize` 只改尺寸不改比例。

### 🖼️XH-图像批量合并

| 英文原名 | 中文标签 | 干什么 |
|---|---|---|
| `inputcount` | 输入口数量 | 想合并几张就填几，**再点「🔄 更新输入口」**，输入槽才会增减 |
| `image_1` | 图像 1 | 必填，输出尺寸以它为基准 |
| `image_2…N` | 图像 2…N | 不接就以黑图占位（保持帧数） |
| `images`（输出） | 图像批次 | 合成后的 batch |

---

## 三、安装 / 启用

- **路径**：`ComfyUI\custom_nodes\Comfyui-XH_ImageTools\`
- **留底**：`桌面\XH节点\Comfyui-XH_ImageTools\`（逐文件 md5 一致）
- ⚠️ **新增 Python 文件必须重启 ComfyUI 后端**才会加载（桌面版请手动退出重开）。
  重启后在节点搜索框输 `XH` 或 `缩放` 或 `批量` 即可找到。

## 四、回滚

直接删掉 `Comfyui-XH_ImageTools` 整个目录。原版 KJNodes **毫发无损**，旧工作流照旧能跑。

## 五、旧工作流换节点

引用 KJ 原版键（`ImageResizeKJv2` / `ImageBatchMulti`）的存档，会显示成「节点缺失」。
解决办法二选一：

1. 手动删掉旧节点、拖一个新的进来重连；
2. **让 AI 帮你改 JSON 里的 `type` 字段** —— 参数声明顺序**完全一致**，
   `widgets_values` 会按数组顺序自动就位，8 个值不用重填，连线也不受影响。

---

## 六、来源与致谢

- 原作：[comfyui-kjnodes](https://github.com/kijai/ComfyUI-KJNodes)（Kosinkadink / kijai）
- 复刻范围：`nodes/image_nodes.py` 的 `ImageBatchMulti` / `ImageResizeKJv2` / `ImagePadKJ` +
  `utility/utility.py` 的 `string_to_color`
- 前端动态输入槽逻辑来源：`web/js/jsnodes.js` 的 `setupDynamicInputs`
