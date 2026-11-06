# 🔁XH-LoRA堆栈（Comfyui-XH_LoraStack）

Nodes 2.0 原生渲染的多 LoRA 加载器，用来替代 `rgthree-comfy` 的 Power Lora Loader
（那个是老版 canvas 手绘 widget，Nodes 2.0 下渲染不出来）。

本包提供**两个**节点，界面完全一样，只有接线口不同：

| 节点 | 输入 | 输出 | 什么时候用 |
|---|---|---|---|
| `🔁XH-LoRA堆栈` | model + **clip** | MODEL + CLIP | 通用。LoRA 里 text encoder 的权重也会一起应用 |
| `🔁XH-纯LoRA堆栈` | **只有 model** | 只有 MODEL | 只要 UNet 权重时用。**完全不碰 CLIP**，LoRA 里的 `lora_te*` 权重被静默忽略 |

两个节点共用同一套界面、同一份配置格式、同一个语言状态，可以随时互换。

## 安装

把整个 `Comfyui-XH_LoraStack` 文件夹放进你的 `ComfyUI\custom_nodes\` 目录，然后**完全退出并重启 ComfyUI**。

- 无需下载任何模型、无需安装 Python 依赖。
- LoRA 文件放 `ComfyUI\models\loras\`（含子目录），下拉里会自动列出。
- 搜索节点：双击画布 → 搜「XH」→ `🔁XH-LoRA堆栈`，分类 `🔁XH/Model`。

## 怎么用

- **➕ 添加 LoRA**：加一行
- 每行：启用开关 + LoRA 下拉 + 强度（-4 ~ 4）+ 🗑 删除
- **👁 / 🚫**：全部启用 / 全部停用
- **中 / EN**：中英文切换（与 XH 家族其他包共用同一语言状态）

接线：
- `🔁XH-LoRA堆栈`：`model` / `clip` 接进去，`MODEL` / `CLIP` 接出来（和官方 LoRA 加载器一样）。
- `🔁XH-纯LoRA堆栈`：只有 `model` 进、`MODEL` 出 —— 只有一个口，接不错。

「强度」的作用范围：
- 完整版里，强度同时喂 model 和 clip。
- 纯版里，强度只作用 model，clip 侧固定不参与。

没接的输入会自动跳过；填了但文件找不到的行会跳过并在控制台提示，不会中断整条流程。

## 说明

- 配置存在折叠的 `loras_json` 参数里，你看不见也不用管它。
- 行的增删只在自己的界面内部完成，不动 ComfyUI 的 widget 数组 —— 存档不会串位。
