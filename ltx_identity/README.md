# 🔒XH-LTX锁脸 · Comfyui-XH_LTXIdentity

`bfsnodes` 的 **LTXIdentityOverlapConditioning**（显示名 `LTX Identity Transfer`）的 XH 复刻版。

**算法与原版逐字节一致**，只把界面做成了能看懂的中文。

---

## 一、为什么要复刻

原节点 UI 全英文，8 个参数（`ref_resize_mode` / `crop_anchor` / `layout` / `source_id` …）看名字根本猜不出作用，
而其中 **`ref_resize_mode` 的裁切行为正是「参考图残影 / 幽灵」的根因** —— 看不懂就必然踩坑。

## 二、改了什么（全部在显示层）

| 改动 | 原版 | 本版 |
|---|---|---|
| 显示名 | `LTX Identity Transfer` | `🔒XH-LTX锁脸`（EN 态 `🔒XH-LTX Identity`） |
| 分类 | `LTX/identity` | `🔁XH/Identity` |
| 下拉选项 | `match_target` | `① 按视频比例裁切 (match_target)` |
| tooltip | 纯英文 | 中文优先 + 英文对照 |
| 参数标签 / 端口名 | 英文 | 节点底部「中 / EN」按钮一键切换 |
| `class_type` 键 | `LTXIdentityOverlapConditioning` | `XHLTXIdentityOverlap` |

**没改**：任何张量运算、RoPE 相位、TASS 布局、模型 patch 注入、ArcFace 身份投影。
（用 `diff` 对比原文件：214 行差异，全部落在 docstring / tooltip / 选项文字 / 分类 / 映射表上。）

## 三、兼容性

**旧工作流存的纯英文选项值照样工作。** 后端加了 `_xh_norm()`，把
「中文 (english)」和纯 `english` 两种写法统一收敛回英文原值：

```python
ref_resize_mode = _xh_norm(ref_resize_mode, _XH_REF_RESIZE_MODES)  # 长词在前！
```

⚠️ 唯一需要手动做一次的：`class_type` 键和原版不同，所以引用旧键的存档会把本节点显示成**缺失**，
需要手动替换一次（参数值会按顺序自动就位，不用重填）。

## 四、参数速查（中文）

| 参数 | 中文 | 说明 |
|---|---|---|
| `source_id` | 参考图编号 | 训练用 2，保持 2。图批第 2 张自动 +1 |
| `phase_scale` | 相位缩放 | 保持 1.0 |
| `ref_resize_mode` | **参考图缩放方式** | ① 按视频比例裁切 ② 整图塞入不裁切 ③ 按原图尺寸（会卡死，禁用） |
| `debug_log` | 调试日志 | 排查时才开 |
| `crop_anchor` | **裁切位置** | 仅模式①生效。保头冠选「顶部」，但会丢下巴 |
| `layout` | **布局方式** | 必须与 LoRA 训练时一致。Best_FaceID 用「叠置布局 overlap」 |
| `reference_guidance_scale` | 参考引导强度 | 1.0 = 关。串脸时试 2~4 |
| `reference_temporal_offset_latents` | 参考时间偏移 | 0 = 标准。残影漏时可试 -1 |

## 五、目录结构

```
Comfyui-XH_LTXIdentity/
├── __init__.py                      # 映射表 + WEB_DIRECTORY
├── pyproject.toml
├── py/
│   ├── __init__.py
│   ├── ltx_identity_overlap.py      # 主逻辑（复刻自 bfsnodes）
│   └── reference_temporal_offset.py # 时间偏移工具（唯一同包依赖）
└── web/
    └── xh_ltx_identity_lang.js      # 中/EN 切换 + 参数标签本地化
```

## 六、回滚

原包 `bfsnodes` **一个字都没动**。不想要了就把本目录改名加 `.disabled` 后缀（ComfyUI 会跳过），
或直接删掉本目录，原节点照常可用。

## 七、部署要点

- **Python 改动必须重启后端**；JS 改动按 Ctrl+Shift+R 刷新前端即可。
- 页面语言状态存 `localStorage["xh_node_lang"]`，与 XH 家族其他包共用。

## 八、来源与致谢

算法来自 `bfsnodes`（作者 bf / LTX Identity Transfer 原作者），本包仅做界面中文化与 XH 风格包装。
