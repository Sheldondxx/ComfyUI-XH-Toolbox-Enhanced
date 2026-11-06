# 🔁XH-循环开始 / 🔁XH-循环结束 —— XH 家族 For 循环（2026-09-30 / 多路回传 2026-10-01）
#
# 技术路线：**站在 ComfyUI 官方循环引擎肩膀上**（对应官方 comfy_extras/nodes_loop.py）
#   · 循环体由**引擎**在校验阶段算好：schema 里写 loop_boundary="start"/"end"，
#     comfy_execution/validation.py 会把 body 写进 prompt[start]["_loop_body"] / ["_loop_end"]。
#     ⇒ 不需要 easy-use 那套「生成链末端必须回接 initial_value」的土办法，也不用自己收集循环体。
#   · 展开逻辑（把循环体复制 N 份）照官方 _expand_loop 移植，但**用 XH 自己的三个内部节点**
#     （XHLoopIteration / XHLoopProgress / XHLoopResult），不依赖官方那三个节点的存在，
#     对外分发更稳（粉丝装什么版本都不怕）。
#   · 白拿官方能力：is_first / is_last / 传入值回传 / 每轮执行端口 / 进度提示。
#
# ⚠ 依赖底线：ComfyUI 需支持 loop_boundary + enable_expand + EXECUTION_LIST（≥ 0.3.6x，本机 0.37 已验证）。
#
# 🔴 和 easy-use 循环最大的使用差别（务必写进说明）：
#   · 官方引擎要求**循环体封闭**：循环体内不能有「谁也不接」的输出节点（保存/预览），
#     否则直接报 "Loop body is not closed"。解决办法：把保存/预览的输出挂到「结束」的
#     **每轮执行（termination）**端口上 —— 这一条官方是靠端口名前缀 termination 识别的。
#   · 反过来，循环体内的常量分支（模型/VAE 加载、空 latent）**不需要**每轮重算，引擎会缓存。
#
# 🔁 多路回传（2026-10-01 新增，参考 Apt_Preset 的 initial_value_N 思路，但只用官方引擎）：
#   · 一共 4 条独立回传通道（路径 0..3），每条完全平行，互不干扰。
#   · 路径 0 = 原来的 initial_value / current_value / next_value / output_value / outputs（向后兼容，**逻辑零改动**）。
#   · 路径 1..3 = 新增的 *_1 / *_2 / *_3，命名规则完全一致，方便一次传「种子 + 末帧 + 音频块 + 风格向量」之类。
#   · 名字映射（p=路径号，0 用无后缀原名，1..3 用 _p 后缀）：
#       Start 输入  : initial_value[_p]        →  迭代信息节点输入 current_iteration_value[_p]
#       Start 输出  : current_value[_p]         →  循环体里取「本轮传入值」
#       End   输入  : next_value[_p]            →  回传给下一轮；output_value[_p] → 本轮产物
#       End   输出  : outputs[_p]               →  最后一轮（或累计每轮）的产物
#   · 每条通道独立：第 2 轮拿第 1 轮回传的 next_value_2，不会和第 1 通道串。
#
# 家族规范：class_type 与 web/xh_forloop.js 里的 NODE_TYPES 必须逐字一致。

from comfy_api.latest import io
from comfy_execution.graph_utils import GraphBuilder, is_link
from server import PromptServer


def _first(value, default=None):
    """is_input_list=True 时输入是列表，取第一个元素；兼容非列表。"""
    return value[0] if isinstance(value, list) else value


def _is_tensor(value):
    """鸭子类型判断张量（不想为了一个 isinstance 把 torch 引进这个文件）。"""
    return hasattr(value, "shape") and hasattr(value, "unsqueeze") and callable(value.unsqueeze)


def _to_list_items(raw):
    """把 list 端口收到的东西统一拆成「逐项列表」（2026-10-10 修 List 模式的关键）。

    ComfyUI 的 list-as-batch 语义下，list 端口可能收到三种东西：
      · python list      → 上游是 OUTPUT_IS_LIST（如「图片列表」的逐张输出），每项已是独立项
      · 单个张量 [N,...] → 上游是整批（如这里的 IMAGE 批次），要按第 0 维拆开
      · 其它标量 / dict  → 当成只有一项
    🔴 以前这里用 `_first(raw)`，对 python list 只取第 0 项 ⇒ 逐张列表只能跑 1 轮（已修）。
    """
    if raw is None:
        return None
    if isinstance(raw, (list, tuple)):
        return list(raw)
    if _is_tensor(raw) and raw.dim() > 0:
        return [raw[i] for i in range(raw.shape[0])]
    return [raw]


def _as_batch_item(item):
    """把拆出来的单项还原成「带 batch 维」的形态。

    🔴 以前这里直接传 `batch[position]`（3D [H,W,3]），下游 IMAGE 少一维就把**图宽当批次**
       ⇒ 一张 64px 宽的图被切成 64 张 1px 高的碎条（实测 3 轮出 192 个文件，已修）。
    只补 3D 张量的那一维；4D 张量、AUDIO 这类 dict、标量都原样放过。
    """
    if _is_tensor(item) and item.dim() == 3:
        return item.unsqueeze(0)
    return item


# ------------------------------------------------------------------------------
# 多路回传：通道 0..3，路径 0 用无后缀原名（向后兼容），1..3 用 _p 后缀
# ------------------------------------------------------------------------------
_CARRY_PATHS = [0, 1, 2, 3]

# List 模式：最多 3 个并行列表（list / list_2 / list_3），各自独立逐元素喂循环体
_LIST_PATHS = [0, 1, 2]
def _list_item_out_name(li):
    return "list_item" if li == 0 else f"list_item_{li + 1}"


def _start_in_name(p):
    return "initial_value" if p == 0 else f"initial_value_{p}"


def _iter_in_name(p):
    return "current_iteration_value" if p == 0 else f"current_iteration_value_{p}"


def _iter_out_name(p):
    return "current_value" if p == 0 else f"current_value_{p}"


def _end_next_name(p):
    return "next_value" if p == 0 else f"next_value_{p}"


def _end_out_name(p):
    return "output_value" if p == 0 else f"output_value_{p}"


def _end_result_name(p):
    return "outputs" if p == 0 else f"outputs_{p}"


# ------------------------------------------------------------------------------
# 展开：把循环体复制 N 份，每份接上本轮的「迭代信息节点」
# ------------------------------------------------------------------------------
def _xh_expand_loop(dynprompt, opener_id, body, close_id, values, initial_values, reuse_cache, list_batches=None):
    graph = GraphBuilder()
    loop_metadata = {}
    close_inputs = dynprompt.get_node(close_id)["inputs"]
    terminations = [value for name, value in close_inputs.items() if name.startswith("termination") and is_link(value)]
    accumulate = bool(_first(close_inputs.get("accumulate", False), False))
    # 每条通道独立的「上一轮回传值」，初值 = 各通道的 initial_value
    previous_carries = list(initial_values)
    previous_dependencies = []
    previous_progress = None
    result_inputs = {"close_id": close_id}

    for position, value in enumerate(values):
        iter_kwargs = {
            "iteration_index": value,
            "is_first": position == 0,
            "is_last": position == len(values) - 1,
            "reuse_cache": reuse_cache,
        }
        # 每一项都补回 batch 维：3D [H,W,3] → [1,H,W,3]（见 _as_batch_item 的坑说明）
        for li in _LIST_PATHS:
            items = list_batches[li] if (list_batches and len(list_batches) > li) else None
            iter_kwargs[_list_item_out_name(li)] = _as_batch_item(items[position]) if items else None
        for p in _CARRY_PATHS:
            iter_kwargs[_iter_in_name(p)] = previous_carries[p]
        iter_kwargs.update(
            {f"dependency{index}": dependency for index, dependency in enumerate(previous_dependencies)}
        )
        iteration = graph.node("XHLoopIteration", f"iteration_{position}", **iter_kwargs)
        iteration.set_override_display_id(opener_id)

        copies = {}
        for node_id in body:
            original = dynprompt.get_node(node_id)
            copy = graph.node(original["class_type"], f"{position}_{node_id}")
            copy.set_override_display_id(node_id)
            copies[node_id] = copy

        def copied_link(source, _iteration=iteration, _copies=copies):
            if not is_link(source):
                return source
            if source[0] == opener_id:
                return _iteration.out(source[1])
            if source[0] in _copies:
                return _copies[source[0]].out(source[1])
            return source

        for node_id, copy in copies.items():
            original = dynprompt.get_node(node_id)
            for name, input_value in original.get("inputs", {}).items():
                copy.set_input(name, copied_link(input_value))
            # 🔴 XH 家族节点：把真实轮次（position，0 起）注入隐藏输入 xh_loop_turn，
            #    让它们零接线就知道第几轮，不再依赖 unique_id 字符串前缀解析
            #    （前缀格式随 ComfyUI 的 GraphBuilder 内部计数器变化，第二次运行会错位）。
            if original.get("class_type", "").startswith("XH"):
                copy.set_input("xh_loop_turn", position)
            if "_loop_end" in original:
                loop_metadata[copy.id] = {
                    "_loop_body": [copies[body_id].id for body_id in original["_loop_body"]],
                    "_loop_end": copies[original["_loop_end"]].id,
                }

        # 每条通道：收本轮产物（output_value[_p]）+ 取回传值（next_value[_p] → 下一轮）
        dependencies = []
        for p in _CARRY_PATHS:
            out_src = close_inputs.get(_end_out_name(p))
            if is_link(out_src):
                copied_output = copied_link(out_src)
                if accumulate:
                    result_inputs[f"output{p}_{position}"] = copied_output
                elif position == len(values) - 1:
                    result_inputs[f"output{p}"] = copied_output
                dependencies.append(copied_output)
            next_src = close_inputs.get(_end_next_name(p))
            if is_link(next_src):
                carried = copied_link(next_src)
                previous_carries[p] = carried
                dependencies.append(carried)
        dependencies.extend(copied_link(source) for source in terminations)
        previous_dependencies = dependencies

        progress_inputs = {
            "start_id": opener_id,
            "position": position + 1,
            "total": len(values),
            **{f"dependency{index}": dependency for index, dependency in enumerate(dependencies)},
        }
        if previous_progress is not None:
            progress_inputs["previous_progress"] = previous_progress
        progress = graph.node("XHLoopProgress", f"progress_{position}", **progress_inputs)
        previous_progress = progress.out(0)

    if previous_progress is not None:
        result_inputs["progress"] = previous_progress
    result_inputs.update({f"dependency{index}": dependency for index, dependency in enumerate(previous_dependencies)})
    graph.node("XHLoopResult", "result", **result_inputs)
    expanded = graph.finalize()
    for node_id, metadata in loop_metadata.items():
        expanded[node_id].update(metadata)
    return expanded


# ------------------------------------------------------------------------------
# 内部节点（dev-only，菜单里搜不到；只由上面的展开逻辑生成）
# ------------------------------------------------------------------------------
class XHLoopIteration(io.ComfyNode):
    """每一轮的「迭代信息」节点：把本轮的索引/首末轮标志/传入值喂给循环体副本。"""

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="XHLoopIteration",
            display_name="🔁XH-循环迭代",
            category="🔁XH/循环",
            description=(
                "【干什么】XH 循环的内部消息节点：把本轮的轮数、首/末轮标志、"
                "以及每条回传通道传进来的值喂给这一轮的循环体。\n"
                "【怎么配】全部由「🔁XH-循环开始」在运行时自动生成并接好，**不用手动摆**。\n"
                "【怎么用】看见它就说明这条链走在官方循环引擎上；想知道本轮是第几轮、"
                "是不是第一轮 / 最后一轮，正是它在提供数据。\n"
                "【输出】index、is_first、is_last，以及每条通道的当前值。\n"
                "⚠️ dev_only 节点：默认在菜单里搜不到（需要开 DevMode 才显示）。"
            ),
            is_input_list=True,
            inputs=[
                io.Int.Input("iteration_index",
                    tooltip="本轮是第几轮（0 起）。直接拿去做「第 N 段」的判断最稳。"),
                io.Boolean.Input("is_first",
                    tooltip="是不是第一轮。常见用法：只在第一轮初始化参考帧 / 空 latent。"),
                io.Boolean.Input("is_last",
                    tooltip="是不是最后一轮。常见用法：最后一轮才做收尾保存，避免每轮都写盘。"),
                io.AnyType.Input("current_iteration_value", optional=True,
                    tooltip="回传通道 0 本轮的值（第一轮时来自「循环开始」的 initial_value）。"),
                io.AnyType.Input("current_iteration_value_1", optional=True,
                    tooltip="回传通道 1 本轮的值。没接这条通道就是 None。"),
                io.AnyType.Input("current_iteration_value_2", optional=True,
                    tooltip="回传通道 2 本轮的值。没接这条通道就是 None。"),
                io.AnyType.Input("current_iteration_value_3", optional=True,
                    tooltip="回传通道 3 本轮的值。没接这条通道就是 None。"),
                io.AnyType.Input("list_item", optional=True,
                    tooltip="List 模式下本轮回传的当前项（如第 N 张图）；次数模式下为 None。"),
                io.AnyType.Input("list_item_2", optional=True,
                    tooltip="List 模式下列表2本轮回传的当前项；次数模式/未接列表2时为 None。"),
                io.AnyType.Input("list_item_3", optional=True,
                    tooltip="List 模式下列表3本轮回传的当前项；次数模式/未接列表3时为 None。"),
                io.Boolean.Input("reuse_cache",
                    tooltip="是否允许复用上一轮的缓存结果。关掉（False）会让每轮都真算一遍 —— 推荐保持关。"),
            ],
            outputs=[
                io.Int.Output("index"),
                io.Boolean.Output("is_first"),
                io.Boolean.Output("is_last"),
                io.AnyType.Output("current_value", is_output_list=True),
                io.AnyType.Output("current_value_1", is_output_list=True),
                io.AnyType.Output("current_value_2", is_output_list=True),
                io.AnyType.Output("current_value_3", is_output_list=True),
                io.AnyType.Output("list_item",
                    tooltip="List 模式下本轮回传的当前项（如第 N 张图）；次数模式下为 None。"),
                io.AnyType.Output("list_item_2",
                    tooltip="List 模式下列表2本轮回传的当前项；次数模式/未接列表2时为 None。"),
                io.AnyType.Output("list_item_3",
                    tooltip="List 模式下列表3本轮回传的当前项；次数模式/未接列表3时为 None。"),
            ],
            is_dev_only=True,
            accept_all_inputs=True,
        )

    @classmethod
    def execute(cls, iteration_index, is_first, is_last, reuse_cache,
                current_iteration_value=None,
                current_iteration_value_1=None,
                current_iteration_value_2=None,
                current_iteration_value_3=None,
                list_item=None, list_item_2=None, list_item_3=None, **kwargs):
        return io.NodeOutput(
            iteration_index[0],
            is_first[0],
            is_last[0],
            current_iteration_value,
            current_iteration_value_1,
            current_iteration_value_2,
            current_iteration_value_3,
            list_item[0] if list_item is not None else None,
            list_item_2[0] if list_item_2 is not None else None,
            list_item_3[0] if list_item_3 is not None else None,
        )

    @classmethod
    def fingerprint_inputs(cls, reuse_cache, **kwargs):
        # 关掉缓存时返回 NaN ⇒ 每轮都真正重算（不复用上一轮结果）
        return None if _first(reuse_cache, False) else float("NaN")


class XHLoopProgress(io.ComfyNode):
    """进度提示：把「第 n / N 轮」发到前端节点上。"""

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="XHLoopProgress",
            display_name="🔁XH-循环进度",
            category="🔁XH/循环",
            description=(
                "【干什么】把「第 n / N 轮」的进度文字发到前端界面上，让你知道循环跑到哪儿了。\n"
                "【怎么配】全部由「🔁XH-循环开始」自动生成，不用手动摆。\n"
                "【怎么用】跑长循环时用来判断还剩多久；它是内部节点，通常感知不到它的存在。\n"
                "【输出】progress：当前轮号。\n"
                "⚠️ dev_only 节点：默认在菜单里搜不到（需要开 DevMode 才显示）。"
            ),
            is_input_list=True,
            inputs=[
                io.String.Input("start_id",
                    tooltip="「循环开始」那个节点的 id，进度文字发给它去显示。"),
                io.Int.Input("position",
                    tooltip="当前是第几轮（0 起），直接决定界面上显示的数字。"),
                io.Int.Input("total",
                    tooltip="一共多少轮。显示成「第 position / total 轮」。"),
            ],
            outputs=[io.Int.Output("progress")],
            is_output_node=True,
            is_dev_only=True,
            accept_all_inputs=True,
        )

    @classmethod
    def execute(cls, start_id, position, total, **kwargs):
        PromptServer.instance.send_progress_text(f"第 {position[0]} / {total[0]} 轮", start_id[0])
        return io.NodeOutput(position[0])

    @classmethod
    def fingerprint_inputs(cls, **kwargs):
        return float("NaN")


class XHLoopResult(io.ComfyNode):
    """收尾：把最后一轮（或累计的每轮）产物交还给「循环结束」节点。"""

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="XHLoopResult",
            display_name="🔁XH-循环收尾",
            category="🔁XH/循环",
            description=(
                "【干什么】循环的收尾内部节点：把最后一轮的产物（或累计的每轮产物）"
                "交还给「🔁XH-循环结束」往下输出。\n"
                "【怎么配】全部由循环引擎自动生成，不用手动摆。\n"
                "【怎么用】它是流水线最后一环；每一条回传通道的产物都从这里汇总出去。\n"
                "【输出】无直接输出，产物流向「循环结束」的 outputs 口。\n"
                "⚠️ dev_only 节点：默认在菜单里搜不到（需要开 DevMode 才显示）。"
            ),
            is_input_list=True,
            inputs=[io.String.Input("close_id",
                tooltip="「循环结束」那个节点的 id，用来匹配的产物从哪儿出去。")],
            outputs=[],
            is_output_node=True,
            is_dev_only=True,
            accept_all_inputs=True,
            hidden=[io.Hidden.execution_list],
        )

    @classmethod
    def execute(cls, close_id, **kwargs):
        # 按通道收集：每通道 either 累计的 output{p}_{i} 列表，or 末轮的 output{p}
        outputs_by_path = {}
        for p in _CARRY_PATHS:
            per_iter = []
            i = 0
            while f"output{p}_{i}" in kwargs:
                per_iter.append(kwargs[f"output{p}_{i}"])
                i += 1
            if f"output{p}" in kwargs:
                per_iter = [kwargs[f"output{p}"]]
            outputs_by_path[p] = per_iter
        cls.hidden.execution_list.release_external_block(close_id[0], outputs_by_path)
        return io.NodeOutput()

    @classmethod
    def fingerprint_inputs(cls, **kwargs):
        return float("NaN")


# ------------------------------------------------------------------------------
# 对外两个节点
# ------------------------------------------------------------------------------
class XHForLoopStart(io.ComfyNode):
    """🔁XH-循环开始：按「次数」重复执行循环体。"""

    @classmethod
    def define_schema(cls):
        list_item_type = io.MatchType.Template("list_item")
        list_item_type_2 = io.MatchType.Template("list_item_2")
        list_item_type_3 = io.MatchType.Template("list_item_3")
        return io.Schema(
            node_id="XHForLoopStart",
            display_name="🔁XH-循环开始",
            category="🔁XH/循环",
            description="循环开始：按「次数」重复执行循环体，输出本轮索引 / 是否首轮 / 是否末轮 / 传入值。传入值有 4 路独立通道(0..3)，可同时传「种子+末帧+音频块+风格向量」等互不干扰。",
            loop_boundary="start",
            is_input_list=True,
            inputs=[
                io.Int.Input(
                    "num_iterations", default=2, min=0, max=100000, step=1,
                    tooltip="循环体执行几次。0 = 不执行循环体。",
                ),
                io.Int.Input(
                    "start_index", default=0, min=-1000000, max=1000000, step=1,
                    tooltip="第 1 轮的索引值（一般就用 0）。",
                ),
                io.Int.Input(
                    "step", default=1, min=1, max=100000, step=1,
                    tooltip="每轮索引增加多少（默认 1）。",
                ),
                io.Boolean.Input(
                    "cache_iterations", default=False, advanced=True,
                    tooltip="复用上一轮没变化的结果。默认关 ⇒ 每轮都真的重算。",
                ),
                io.MatchType.Input(
                    "list", list_item_type, optional=True,
                    tooltip="列表1(主)：接 IMAGE / 音频 / 视频 / 任意 batch。接了就进「List 模式」——循环体按最短列表长度逐元素执行，每轮拿到 list_item（当前项）。没接则走「次数」模式（下方次数/起始索引/步长生效）。多个列表可并行（图+音频+提示词锁步）。",
                ),
                io.MatchType.Input(
                    "list_2", list_item_type_2, optional=True,
                    tooltip="列表2：与列表1并行独立的第二个列表（如第 2 张/第 2 段）。各自 list_item_2 进循环体，互不干扰。",
                ),
                io.MatchType.Input(
                    "list_3", list_item_type_3, optional=True,
                    tooltip="列表3：与列表1/2并行独立的第三个列表。各自 list_item_3 进循环体，互不干扰。",
                ),
                io.AnyType.Input(
                    "initial_value", optional=True,
                    tooltip="第 1 轮的「传入值」（通道 0）。从第 2 轮起由「循环结束」的「回传值」接手。",
                ),
                io.AnyType.Input(
                    "initial_value_1", optional=True,
                    tooltip="通道 1 的第 1 轮传入值。与通道 0 完全独立，互不干扰。",
                ),
                io.AnyType.Input(
                    "initial_value_2", optional=True,
                    tooltip="通道 2 的第 1 轮传入值。与通道 0 完全独立，互不干扰。",
                ),
                io.AnyType.Input(
                    "initial_value_3", optional=True,
                    tooltip="通道 3 的第 1 轮传入值。与通道 0 完全独立，互不干扰。",
                ),
            ],
            outputs=[
                io.Int.Output("index", tooltip="本轮索引：起始索引 + 轮次 × 步长"),
                io.Boolean.Output("is_first", tooltip="本轮是不是第 1 轮"),
                io.Boolean.Output("is_last", tooltip="本轮是不是最后一轮"),
                io.AnyType.Output("current_value", tooltip="通道 0 本轮传入值"),
                io.AnyType.Output("current_value_1", tooltip="通道 1 本轮传入值"),
                io.AnyType.Output("current_value_2", tooltip="通道 2 本轮传入值"),
                io.AnyType.Output("current_value_3", tooltip="通道 3 本轮传入值"),
                io.MatchType.Output(
                    list_item_type, id="list_item",
                    tooltip="当前项：List 模式下每轮拿到列表1里的对应元素（如第 N 张图）；次数模式下恒为 None。",
                ),
                io.MatchType.Output(
                    list_item_type_2, id="list_item_2",
                    tooltip="当前项2：List 模式下列表2每轮对应元素；次数模式/未接列表2时恒为 None。",
                ),
                io.MatchType.Output(
                    list_item_type_3, id="list_item_3",
                    tooltip="当前项3：List 模式下列表3每轮对应元素；次数模式/未接列表3时恒为 None。",
                ),
            ],
            hidden=[io.Hidden.dynprompt, io.Hidden.execution_list, io.Hidden.unique_id],
            enable_expand=True,
        )

    @classmethod
    def execute(cls, num_iterations, start_index=0, step=1, cache_iterations=False,
                initial_value=None,
                # 🔴🔴 2026-10-10 修复（休眠 bug）：schema 里声明了 4 路回传通道
                #    initial_value / initial_value_1 / _2 / _3，但这里以前只写到 initial_value
                #    ⇒ 工作流一旦用了通道 1 以上，提交即崩：
                #       TypeError: execute() got an unexpected keyword argument 'initial_value_1'
                #    来源：2026-10-01 加多路回传时只改了 schema，忘了对齐 execute 签名；
                #    2026-10-10 用户第一次用通道 1（initial_value_1 ← XH-H3·交接分析）才踩响。
                #    各通道的值本来就在下面 `initial_values = [... loop["inputs"] ...]` 里读，
                #    所以这里补参数**只是签名对齐声明，逻辑一行没动**。
                initial_value_1=None, initial_value_2=None, initial_value_3=None,
                list=None, list_2=None, list_3=None,
                # 家族兜底：以后再加通道（或者别人 fork 后加输入）也不会因此崩。
                **kwargs):
        # List 模式：任一 list 端口接了东西 ⇒ 按「最短列表长度」逐元素循环。
        # 🔴 2026-10-10：这里曾经是 `[_first(raw) ...]` —— python list 被取走第 0 项后
        #    len 恒为 1（逐张列表只跑 1 轮），且整批张量还会被 `batch[position]` 拆成 3D。
        #    现在统一用 _to_list_items 拆成真正的「逐项列表」。
        list_batches = [_to_list_items(raw) for raw in (list, list_2, list_3)]
        connected = [b for b in list_batches if b]
        if connected:
            values = [*range(min(len(b) for b in connected))]
        else:
            count = int(_first(num_iterations, 2) if _first(num_iterations, 2) is not None else 0)
            start = int(_first(start_index, 0) if _first(start_index, 0) is not None else 0)
            step_v = int(_first(step, 1) if _first(step, 1) is not None else 1)
            if step_v == 0:
                raise ValueError("步长不能为 0")
            values = [start + i * step_v for i in range(max(0, count))]

        dynprompt = cls.hidden.dynprompt
        execution_list = cls.hidden.execution_list
        unique_id = cls.hidden.unique_id
        loop = dynprompt.get_node(unique_id)
        body = set(loop["_loop_body"])
        close_id = loop["_loop_end"]

        initial_values = [loop["inputs"].get(_start_in_name(p)) for p in _CARRY_PATHS]
        graph = _xh_expand_loop(
            dynprompt,
            unique_id,
            body,
            close_id,
            values,
            initial_values,
            _first(cache_iterations, False),
            list_batches=list_batches,
        )

        # 把「结束」节点从循环体里摘出来：它只在全部迭代跑完后执行一次
        close = dynprompt.get_node(close_id)
        close_inputs = close["inputs"].copy()
        _carry_names = set()
        for p in _CARRY_PATHS:
            _carry_names.add(_end_out_name(p))
            _carry_names.add(_end_next_name(p))
        for name in tuple(close_inputs):
            if name in _carry_names or name.startswith("termination"):
                del close_inputs[name]
        execution_list.add_node(close_id)
        execution_list.add_external_block(close_id)
        execution_list.inhibit_nodes(body)
        dynprompt.override_node(close_id, {"class_type": close["class_type"], "inputs": close_inputs})

        PromptServer.instance.send_progress_text(f"第 0 / {len(values)} 轮", unique_id)
        return io.NodeOutput(
            None,        # index
            False,       # is_first
            not values,  # is_last
            None,        # current_value
            None,        # current_value_1
            None,        # current_value_2
            None,        # current_value_3
            None,        # list_item（List 模式下由循环体迭代节点提供实际当前项）
            None,        # list_item_2
            None,        # list_item_3
            expand=graph,
        )

    @classmethod
    def fingerprint_inputs(cls, **kwargs):
        # 永远重新展开循环（不然第二次跑同样的 prompt 会直接吃缓存）
        return float("NaN")


class XHForLoopEnd(io.ComfyNode):
    """🔁XH-循环结束：收本轮产物、回传下一轮、挂每轮必跑的节点。"""

    @classmethod
    def define_schema(cls):
        terminations = io.Autogrow.TemplatePrefix(
            io.AnyType.Input(
                "termination",
                tooltip="循环体内的「保存 / 预览」必须挂到这里，每轮都会执行；不挂会报「循环体不封闭」。",
            ),
            prefix="termination",
            min=0,
            max=50,
        )
        return io.Schema(
            node_id="XHForLoopEnd",
            display_name="🔁XH-循环结束",
            category="🔁XH/循环",
            description="循环结束：收本轮产物、把值回传给下一轮；循环体内的保存/预览挂到「每轮执行」端口。回传值有 4 路独立通道(0..3)，与开始节点的 4 路传入值一一对应。",
            loop_boundary="end",
            is_input_list=True,
            inputs=[
                io.AnyType.Input(
                    "output_value", optional=True,
                    tooltip="通道 0 本轮产物。循环跑完后从这里输出（开「累计」则输出每一轮）。",
                ),
                io.AnyType.Input(
                    "next_value", optional=True,
                    tooltip="通道 0 回传给下一轮「传入值」的东西（例如累加的序号 / 上一段的末帧）。",
                ),
                io.AnyType.Input(
                    "output_value_1", optional=True,
                    tooltip="通道 1 本轮产物，与通道 0 完全独立。",
                ),
                io.AnyType.Input(
                    "next_value_1", optional=True,
                    tooltip="通道 1 回传给下一轮的传入值。",
                ),
                io.AnyType.Input(
                    "output_value_2", optional=True,
                    tooltip="通道 2 本轮产物，与通道 0 完全独立。",
                ),
                io.AnyType.Input(
                    "next_value_2", optional=True,
                    tooltip="通道 2 回传给下一轮的传入值。",
                ),
                io.AnyType.Input(
                    "output_value_3", optional=True,
                    tooltip="通道 3 本轮产物，与通道 0 完全独立。",
                ),
                io.AnyType.Input(
                    "next_value_3", optional=True,
                    tooltip="通道 3 回传给下一轮的传入值。",
                ),
                io.Boolean.Input(
                    "accumulate", default=False,
                    tooltip="开 = 输出每一轮的产物；关 = 只输出最后一轮的产物。对所有通道同时生效。",
                ),
                io.Autogrow.Input(
                    "terminations", template=terminations, optional=True,
                    tooltip="每轮都要执行的节点（保存 / 预览）。它们的值不会输出，只保证被执行。",
                ),
            ],
            outputs=[
                io.AnyType.Output(
                    "outputs", is_output_list=True,
                    tooltip="通道 0 最后一轮的产物；开启「累计」时是每一轮的产物列表。",
                ),
                io.AnyType.Output(
                    "outputs_1", is_output_list=True,
                    tooltip="通道 1 最后一轮的产物；开启「累计」时是每一轮的产物列表。",
                ),
                io.AnyType.Output(
                    "outputs_2", is_output_list=True,
                    tooltip="通道 2 最后一轮的产物；开启「累计」时是每一轮的产物列表。",
                ),
                io.AnyType.Output(
                    "outputs_3", is_output_list=True,
                    tooltip="通道 3 最后一轮的产物；开启「累计」时是每一轮的产物列表。",
                ),
            ],
            hidden=[io.Hidden.execution_list, io.Hidden.unique_id],
        )

    @classmethod
    def execute(cls, accumulate, **kwargs):
        result = cls.hidden.execution_list.get_external_block_result(cls.hidden.unique_id) or {}
        # result 是 {0: [...], 1: [...], 2: [...], 3: [...]}；每条通道展开成扁平列表
        return io.NodeOutput(
            *[[v for out in result.get(p, []) for v in out] for p in _CARRY_PATHS]
        )


NODE_CLASS_MAPPINGS = {
    "XHForLoopStart": XHForLoopStart,
    "XHForLoopEnd": XHForLoopEnd,
    # 下面三个是内部节点（dev-only），只由展开逻辑生成，菜单里搜不到
    "XHLoopIteration": XHLoopIteration,
    "XHLoopProgress": XHLoopProgress,
    "XHLoopResult": XHLoopResult,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "XHForLoopStart": "🔁XH-循环开始",
    "XHForLoopEnd": "🔁XH-循环结束",
    # 三个内部节点（dev-only）：菜单里搜不到，但仍给家族显示名，
    # 万一用户开了 DevMode 也不会露出英文 class_type。
    "XHLoopIteration": "🔁XH-循环迭代",
    "XHLoopProgress": "🔁XH-循环进度",
    "XHLoopResult": "🔁XH-循环收尾",
}
