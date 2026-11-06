# 🔁XH H3 Memory Saver

给 **Herrgotts H3 Infinite Continuation Suite** 长链省内存的三个节点。

## 为什么需要它（源码级结论，2026-09-02）

ComfyUI 的 `VAEDecode` 输出的 IMAGE 落在 **CPU**：

- `comfy/sd.py:1078` → `output_device = intermediate_device()`
- `comfy/model_management.py:1239` → 未开 `--gpu-only` 时返回 **CPU**
- `seamless_stitch.py` 里 Join 的 `.to(previous_images.device)` + `torch.cat` → 拼接全程 CPU

所以 03 多段同跑吃的是**系统内存**，不是显存。显存里只有模型 + 单段采样，**不随段数增长**。
本包就是在"像素常驻"这件事上做文章。

> ⛔ **永远不要加 `--gpu-only`** —— 它会把整条像素链搬回显存，8GB 卡立刻必爆。
> ⚠️ `--fp16-vae` 省不了内存（只改 VAE 计算精度），本包改的是 IMAGE 本身的 dtype。

## 三个节点

| class_type | 显示名 | 作用 |
|---|---|---|
| `XHImagePrecision` | 🔁XH图像精度 | IMAGE 转 fp16/bf16/fp32，让整条链按低精度常驻，**内存砍半** |
| `XHImageCacheWrite` | 🔁XH图像落盘 | 把 IMAGE 写盘，**只向下传缓存键**（不传 IMAGE）→ 上游像素得以释放 |
| `XHImageCacheRead` | 🔁XH图像读取 | 按缓存键把像素读回，重新接回 Join 链 |

分类：`🔁XH/Video`　每个节点顶部带「中 / EN」切换按钮（XH 风格硬性要求，状态与 XH_GroupExecutor 共用）。

---

## 画质会变差吗（2026-09-02 实测）

**不会。结论：8bit 输出下逐像素最大差 1/255 级，且误差不随段数累积。**

### 精度层级：fp16 比最终输出细 8 倍

同一段像素值（0.500 – 0.530）三种精度能分辨的层级数：

| 精度 | 每格大小 | 能分辨 | 角色 |
|---|---|---|---|
| fp32 | 0.00000012 | 约 25 万层 | VAE 解码输出，**未改动** |
| **fp16** | **0.00049** | **61 层** | **本包改动的中间存储** |
| 8bit | 0.0039 | 7 层 | 编码器最终输出，**未改动** |

fp16 的刻度比最终输出细 **8 倍**，所以最后取整成 8bit 时绝大多数像素落回同一个值。

### 实测数据（torch 2.12.1+cu130，本机真实环境）

模拟 SeamlessJoin 的 crossfade，`prev` 与 `next` 各 40 帧 @960×544：

| 测试项 | 结果 |
|---|---|
| 单次 crossfade，逐像素最大差 | **1 / 255 级** |
| 有差异的像素占比 | 2.78 % |
| 差 ≥ 2 级的像素占比 | **0.0000 %** |
| 10 段链累积后最大差 | **仍是 1 / 255 级**（2.97 % 像素有 1 级差） |

**误差不累积**：crossfade 是凸组合（权重和为 1），只会传递误差不会放大。10 段之后上限仍是 1 级。

### 对照：编码器噪声远大于它

H.264 在 crf≈19 下的 DCT 量化误差通常是 **2~5 个 8bit 级**，fp16 引入的误差 **≤ 1 级**，完全淹没在编码噪声之下。

### 分析器判定会不会偏（这是真正的隐患，已排除）

`AnalyzeHandover` 也吃 VAEDecode 的那份 IMAGE，它内部有阈值判断（最严的是
`transition_mean_diff_threshold = 0.0020`）。若判定翻转，接缝位置就会偏帧。

两条源码事实 + 一次实测：

- `motion_analysis.py:47` → `x = images[..., :3].detach().float()`，**分析器第一步就强制升回 fp32**
- fp16 单像素舍入误差约 0.0001，只有最严阈值的 **5 %**
- 实测：构造 120 帧帧间差**恰好跨越阈值**（0.0010~0.0030）的最坏情况，fp32 与 fp16 判定**完全一致，0 帧翻转**

### 边界：什么情况下不能用

- ⛔ **不要接在 LATENT 上**。本节点只收 `IMAGE`，接不上 latent，设计上就堵死了这条路。
- ⛔ **不要在需要继续做数值运算的链路上留 fp16**，例如把 Join 输出再送去算光流、做像素级差值分析——输出前先转回 fp32。
- ⚠️ 若你用了自定义节点去做**逐帧精确比较**或**极低阈值判定**（阈值 < 0.0005），请在那一路单独保留 fp32。作者套件内已核查无此类路径。

---

## 方案 A：fp16 链（最简单，内存砍半）

在每个 `VAEDecode` 之后插一个精度节点，输出前转回 fp32。

```
Clip1 VAEDecode ─→ 🔁XH图像精度(fp16) ─┐
                                        ├─→ SeamlessJoin#1.previous_images
Clip2 VAEDecode ─→ 🔁XH图像精度(fp16) ─┘        │
                                                │ (输出已是 fp16，直接接)
Clip3 VAEDecode ─→ 🔁XH图像精度(fp16) ──→ Join#2.next_images
                                                │
                          Join#2.images ─→ 🔁XH图像精度(fp32) ─→ VHS VideoCombine
```

**要点**
- SeamlessJoin 内部会 `.to(previous_images.dtype)`，所以只要 `previous_images` 是 fp16，整条链自动统一 fp16。
- 输出前务必转回 fp32，下游 SaveVideo / VHS 更稳。
- `precision` 已是目标精度时不拷贝，直接返回原对象。

---

## 方案 B：落盘打断（段数多时用）

`🔁XH图像落盘` **不输出 IMAGE**，所以 ComfyUI 认为没有下游像素消费者，上游像素写盘后即可释放。

```
Join#K.images ─→ 🔁XH图像落盘(key=xh_chain)
                       │
                       │ cache_key (STRING，不是 IMAGE)
                       ▼
                 🔁XH图像读取(fp16) ─→ Join#(K+1).previous_images
```

**要点**
- 落盘节点与读取节点的 `cache_key` 必须一致。
- 读取节点的 `delete_after=True` 可在读完后删掉缓存文件（一条链跑完自动清理）。
- 开销很小：实测 120 帧 @960×544 fp16 存盘 523 ms / 读回 21 ms。

---

## 方案 C：A + B 叠加（最省）

两个一起用，内存峰值可压到原版的约 1/3。

---

## 效果估算（3 clip @960×544，5s/段）

| 方案 | 像素内存峰值 | 相对原版 |
|---|---|---|
| 原版（fp32） | ≈ 6.7 GB | 1.00× |
| A：fp16 链 | ≈ 3.4 GB | **0.50×** |
| B：落盘打断 | ≈ 4.5 GB | 0.67× |
| C：A + B | ≈ 2.3 GB | **0.34×** |

> 上表为按「峰值帧数 ≈ 1069 帧 × W × H × 每帧字节」的估算，实测请以任务管理器为准。

## 代价（实测，别被吓到）

CPU 上 **fp16 拼接比 fp32 慢**：`torch.cat` 120+60 帧 @960×544 实测 fp32 755 ms → fp16 1328 ms。
原因是 CPU half 走的是不同 kernel。但相对**每段采样约 213 秒**，多出来的 0.6 秒可以忽略。
换来的是内存砍半，非常划算。

## 缓存位置与清理

默认落在 ComfyUI 的 temp 目录：

```
C:\Users\61769\ComfyUI-Installs\ComfyUI\ComfyUI\temp\xh_image_cache\
```

文件名 = `<cache_key>.safetensors`。直接删这个目录即可全部清空。
缓存键只保留字母数字与 `-_`。

## 兼容性

- 实测环境：ComfyUI 0.34.0 / torch 2.12.1+cu130 / Windows
- CPU fp16 的 `cat / mul / add / lerp / mean / clamp` 均已实测可用，无算子缺失
- 与传统 `NODE_CLASS_MAPPINGS` 注册方式（与 Herrgotts 套件一致）
- 前端仅做语言切换，不碰 PackedLayout，与 SolAttn / Spectrum / SeedScout 无冲突
