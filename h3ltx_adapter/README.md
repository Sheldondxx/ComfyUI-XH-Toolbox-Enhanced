# 🔀XH-H3LTX-Adapter

把 **MiniMax-H3 的 latent** 翻译成 **LTX-2.5 的 latent** 的 ComfyUI 节点。

> **包名**：`XH-H3LTX-Adapter`（2026-09-11 由 `ComfyUI-H3LTXAdapter` 改名而来）
> **分类**：`🔁XH/Video` ｜ **显示名**：`🔀XH-H3LTX-适配器加载` / `🔀XH-H3LTX-转换`
> **中/EN 切换**：由 `web/xh_h3ltx_lang.js` 注入（语言键 `xh_node_lang`，与 XH_H3MemorySaver 共享）
> ⚠️ `class_type` 键仍是 `H3LTXAdapterLoader` / `H3LTXAdapterConvert`（**刻意不改**，已存工作流不受影响）

这是 NVIDIA `Sol-H3-Spark` 里那个 194.8M 参数的 Conv3D 适配器（模型卡：`Efficient-Large-Model/H3-to-LTX-Latent-Adapter`）。
它**不生成视频**，只做一件事：让 LTX-2.5 能接手 H3 已经采好的 latent，从而省掉「H3 VAE 解码 → LTX VAE 编码」这一整趟像素域往返。

---

## 安装

代码已经在这个目录里，**重启 ComfyUI** 即可生效。

模型只要**一个文件**（389,541,112 字节 ≈ 390 MB）：

```
https://hf-mirror.com/Efficient-Large-Model/H3-to-LTX-Latent-Adapter/resolve/main/model.safetensors
```

放到：

```
C:\Users\61769\ComfyUI-Shared\models\h3_ltx_adapter\
```

> `config.json` **不用下**。那份冻结契约已经内嵌在 `h3ltx/adapter.py` 的 `FROZEN_CONFIG` 里，
> 如果检测到同目录有 `config.json`，节点会自动优先用它并校验 geometry。

放好后在 ComfyUI 里刷新节点定义（或重启），`🔀XH-H3LTX-适配器加载` 的下拉框就会出现文件名。

---

## 节点

| 节点（显示名） | class_type 键 | 输入 | 输出 |
|---|---|---|---|
| **🔀XH-H3LTX-适配器加载** | `H3LTXAdapterLoader` | 模型文件 / 设备 / 精度 / 强制重载 | `H3LTX_ADAPTER` |
| **🔀XH-H3LTX-转换** | `H3LTXAdapterConvert` | adapter + LATENT + 像素参数 | `LATENT`(LTX) + `STRING`(报告) |


### 必须按这个顺序接

```
H3 采样  ─────────────► LATENT  (B, 24, T, H/16, W/16)   ← ComfyUI 的 H3 VAE 输出的已经是 normalized
   │
   ├─ MinimaxH3LatentUpscaler3D   scale = 2.0
   │        ↓
   │  LATENT  (B, 24, T, H/8, W/8)
   │
   ├─ H3 → LTX Adapter Convert     ← 本节点
   │        ↓
   │  LATENT  (B, 128, T_ltx, H/32, W/32)
   │
   └─ LTX-2.5 精修采样  →  LTX Conv VAE 解码  →  视频
```

**为什么 upscaler 必须在前面**：适配器内部做的是 `2× pixel_unshuffle`，硬性要求「进来的 latent 空间尺寸
正好是要输出的 2 倍」。所以 `pixel_height/pixel_width` 声明的是**放大之后**的像素尺寸，
也就是 H3 原生像素的 **2 倍**。跳过 upscaler 也能跑，但 LTX 侧分辨率会少一半，等于白转。

### 形状对照（官方实测值，124 帧）

| 阶段 | 形状 |
|---|---|
| H3 latent 进 | `(1, 24, 37, 24, 42)` |
| ×2 放大后 | `(1, 24, 37, 48, 84)` |
| aligned（喂给网络） | `(1, 384, 17, 48, 84)` |
| LTX latent 出 | `(1, 128, 17, 24, 42)` |

工作流里 `pixel_height=768, pixel_width=1344` 对应的就是这个例子。

### Convert 参数

| 参数 | 说明 |
|---|---|
| `pixel_frames` | H3 原始像素帧数（官方 **124**）。**填 0 = 自动反推**，取最接近 124 的候选 |
| `pixel_height` / `pixel_width` | 填 0 = 用 `latent 尺寸 ×16` 自动推断。手填错会被形状校验拦下并给出修正提示 |
| `input_is_raw` | **保持关闭**。ComfyUI 的 H3 VAE 输出已是 normalized，开了会二次归一化 |
| `drop_last_frame` | 丢掉 LTX latent 最后一帧。Spark 官方精修前会把 17 帧裁成 16 帧 |
| `unload_after` | 用完把模型移回 CPU |

> ⚠️ `pixel_frames` 有个坑：latent 的 T=37 对应的像素帧数**不是唯一值**，而是 120–136 整个区间
> （H3 按 17 帧一组、每组吐 5 个 token、最后丢 3 个，所以 T 只取决于组数）。
> 选不同的值会改变 LTX 输出帧数（16 / 17 / 18 帧）。自动模式取最接近官方 124 的那个。

### 下游精修配方（Sol-H3-Spark Stage2 原样）

- 3 步，sigmas `[0.909375, 0.725, 0.421875, 0]`（这是 latent-to-latent，不是从纯噪声开始）
- distilled LoRA 强度 **0.8**
- Stage2 提示词写死：`4K, refined, high quality, cinematic detail, clean textures, natural motion.`
- Stage2 的文本编码在官方实现里是**离线缓存**的

---

## 实测开销（本机 RTX 4060 Laptop 8GB）

本节点在 8GB 上**完全不是瓶颈**：

| 项目 | 实测 |
|---|---|
| 权重（bf16） | 389 MB |
| 完整前向峰值显存 | **676 MB** |
| 单次前向耗时 | **0.93 s** |

真正的显存杀手在下游——LTX-2.5 22B 精修 + 768×1344 的 Conv VAE 解码。

---

## 已知限制

- 只在 `pixel_height % 32 == 0` 且 `pixel_width % 32 == 0` 时可用（冻结契约要求）。
- H3 latent 必须是 24 通道的 5D 视频 latent；单帧图像 latent 的 T 无法反推，会直接报错。
- 官方 `Sol-H3-Spark` 整条流水线锁死 Linux aarch64 + GB10/SM121（Blackwell），**照抄跑不通**。
  本节点只取了其中干净的那部分：`adapter.py` / `geometry.py` / `model.py` 三个文件
  只依赖 `torch` + `safetensors` + `F.pixel_unshuffle`，没有任何 Blackwell 特性。

---

## 来源

- 权重：`Efficient-Large-Model/H3-to-LTX-Latent-Adapter`
- 源码：`NVlabs/Sana` @ `144085566a866f9784f3798d4c8d1603f3adbccf`
  → `models/minimax_h3/Sol-H3-Spark/runtime/stage2_ops/h3_ltx_adapter/`

`h3ltx/constants.py`、`geometry.py`、`model.py` 为**原样移植**（仅加来源注释），
`adapter.py` 唯一改动是把 `from_pretrained()` 拆成 `load()`，以便只靠一个 safetensors 文件运行。
这些是训练时冻结的契约，**不要改**。
