# 🔁XH-视频工具（XH 家族）
#
# 从 `Comfyui-XH_GroupExecutor/py/batch_video.py` **原样移植**（2026-09-30）。
#   · 🔁XH-合成并保存视频   ←  LG_CreateAndSaveVideo（原显示名「XH创建并保存视频」）
#   · 🔁XH-视频拼接         ←  LG_ConcatVideoFiles（原显示名「🔁XH-ConcatVideoFiles」）
#
# 为什么要移植：用户不想让工作流依赖 GroupExecutor 那一整包。
# 移植方式：**代码原样搬运**，只改了三处 ——
#   ① 类名（见下）；② 分类统一成 🔁XH/Video；③ 注册字典。
#   ⇒ 参数顺序、默认值、内部行为与原版**逐字一致**。
#
# 🔴 类型名必须改：原包里同名节点还在，两个包同时注册同一个 class_type 会互相覆盖
#    （ComfyUI 按加载顺序决定谁生效，不可靠）。换工作流时把 class_type 改掉即可：
#      XHCreateAndSaveVideo  →  XHComposeVideo
#      XHConcatVideoFiles    →  XHConcatVideo
#
# 依赖：ffmpeg（拼接需要，且要在 PATH 里）、folder_paths、comfy_api 的视频接口。

from __future__ import annotations

import os
import subprocess
import tempfile
from fractions import Fraction

import folder_paths
from comfy.cli_args import args

CATEGORY_TYPE = "🔁XH/Video"


class XHComposeVideo:
    """
    从图片创建视频并保存到文件，返回文件路径
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE", {
                    "tooltip": (
                        "要合成视频的图像批，顺序即播放顺序。\n"
                        "分辨率取第 1 帧的宽高，所以整批必须是同一尺寸 —— "
                        "尺寸不一先拉同一个缩放节点。\n"
                        "⚠️ 只接 1 帧也能出片（就是一张静帧），不会报错。"
                    ),
                }),
                "fps": ("FLOAT", {
                    "default": 30.0, "min": 1.0, "max": 120.0, "step": 1.0,
                    "tooltip": (
                        "帧率（每秒几帧）。默认 30。\n"
                        "· 接 H3 / LTX 出片：跟生成时那个帧率保持一致，别混用\n"
                        "· 想做慢动作就调低（如 12），想丝滑就调高（如 60）\n"
                        "⚠️ 它只决定播放速度，不增不减你传入的帧数。"
                    ),
                }),
                "filename_prefix": ("STRING", {
                    "default": "video/segment",
                    "tooltip": (
                        "输出文件的前缀，写到 ComfyUI 的 output 目录。\n"
                        "例：video/segment → output/video/segment_00001_.mp4\n"
                        "前缀里带 `\u002f` 就是子目录；重名会自动加序号，不会覆盖旧文件。"
                    ),
                }),
            },
            "optional": {
                "audio": ("AUDIO", {
                    "tooltip": (
                        "可选音频轨，合成后一起封进 mp4。不接就是无声视频。\n"
                        "⚠️ 音频比视频短时会按视频长度静音补齐，比视频长会被截到视频长度。"
                    ),
                }),
            },
            "hidden": {
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO"
            }
        }
    
    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("file_path",)
    FUNCTION = "create_and_save"
    CATEGORY = CATEGORY_TYPE
    DESCRIPTION = (
        "【干什么】把一串图像帧合成 mp4 并写进 output 目录，把文件路径交给你。\n"
        "【怎么配】· images：图像批（顺序即播放顺序，必须同尺寸）\n"
        "· fps：帧率，默认 30，应与生成时一致\n"
        "· filename_prefix：输出前缀，默认 video/segment（写进 output/video/segment_00001_.mp4）\n"
        "· audio（可选）：一条音轨，一起封进 mp4\n"
        "【怎么用】接在 VAEDecode / 帧处理之后、拼接之前。H.264 + MP4，绝大多数剪辑软件直接吃得下。\n"
        "【输出】file_path（STRING）：成品视频的完整路径，可以直接喂给 🔁XH-视频拼接。\n"
        "⚠️ 它是**输出节点**（OUTPUT_NODE），跑了才写盘；"
        "没保存元数据时会安静跳过元数据写入，不影响出片。"
    )

    def create_and_save(self, images, fps, filename_prefix, audio=None, prompt=None, extra_pnginfo=None):
        try:
            from comfy_api.latest._input_impl.video_types import VideoFromComponents
            from comfy_api.latest._util.video_types import VideoComponents, VideoContainer, VideoCodec
        except ImportError:
            from comfy_api.input_impl import VideoFromComponents
            from comfy_api._util.video_types import VideoComponents, VideoContainer, VideoCodec
        
        # 创建视频
        components = VideoComponents(images=images, audio=audio, frame_rate=Fraction(fps))
        video = VideoFromComponents(components)
        
        # 保存
        width, height = images.shape[2], images.shape[1]
        output_dir = folder_paths.get_output_directory()
        
        full_output_folder, filename, counter, subfolder, _ = folder_paths.get_save_image_path(
            filename_prefix, output_dir, width, height
        )
        
        saved_metadata = None
        if not args.disable_metadata:
            metadata = {}
            if extra_pnginfo is not None:
                metadata.update(extra_pnginfo)
            if prompt is not None:
                metadata["prompt"] = prompt
            if len(metadata) > 0:
                saved_metadata = metadata
        
        file = f"{filename}_{counter:05}_.mp4"
        file_path = os.path.join(full_output_folder, file)
        
        video.save_to(
            file_path,
            format=VideoContainer.MP4,
            codec=VideoCodec.H264,
            metadata=saved_metadata
        )
        
        return (file_path,)


class XHConcatVideo:
    """
    使用 FFmpeg 合并多个视频文件
    支持字符串列表输入或多行文本输入
    可选添加音频轨道
    """
    
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "video_paths": ("STRING", {
                    "forceInput": True,
                    "tooltip": (
                        "要拼接的视频路径（forceInput，只能接线上来的值）。\n"
                        "三种都吃：① 路径组成的列表 ② 单个路径字符串 ③ 多行文本（换行分隔）\n"
                        "⚠️ 空行会自动跳过；一条有效路径都没有会直接报「没有输入任何视频路径」。\n"
                        "⚠️ 任一路径在磁盘上找不到就报错停止，不会强行跳过。"
                    ),
                }),
                "filename_prefix": ("STRING", {
                    "default": "video/merged",
                    "tooltip": (
                        "合并后文件的输出前缀，写到 ComfyUI 的 output 目录。\n"
                        "例：video/merged → output/video/merged_00001_.mp4\n"
                        "重名自动加序号，不会覆盖。"
                    ),
                }),
            },
            "optional": {
                "reencode": ("BOOLEAN", {"default": False, 
                    "tooltip": (
                        "拼接方式：\n"
                        "· 关（默认）= 流拷贝直拼，几秒完成、画质零损失\n"
                        "· 开 = 重新编码，慢很多但能吞下不同分辨率/编码的片段\n"
                        "⚠️ 关的时候要求各段参数一致，否则 ffmpeg 会报错或直接出花屏 —— 报拼接失败就打开它。"
                    )}),
                "audio_path": ("STRING", {"forceInput": True,
                    "tooltip": (
                        "给成片配的音轨文件路径（forceInput，只能接线）。\n"
                        "⚠️ 文件不存在只会在控制台警告并跳过音频，**不会**中断拼接。"
                    )}),
                "audio_mode": (["replace", "mix"], {"default": "replace",
                    "tooltip": (
                        "音轨怎么合：\n"
                        "· replace（默认）= 用新音轨替换原视频的声音\n"
                        "· mix = 原声与新音轨混合\n"
                        "⚠️ 原片段本来就没音轨时，两个选项效果一样。"
                    )}),
                "audio_volume": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 2.0, "step": 0.1,
                    "tooltip": (
                        "新音轨的音量倍数。\n"
                        "· 1.0 = 原始音量（默认）\n"
                        "· 0.0 = 完全静音\n"
                        "· >1.0 = 放大，超过约 1.5 容易破音\n"
                        "⚠️ 只有在 audio_path 接了东西时才生效。"
                    )}),
            }
        }
    
    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("output_path",)
    OUTPUT_NODE = True
    FUNCTION = "concat_files"
    CATEGORY = CATEGORY_TYPE
    INPUT_IS_LIST = True
    # 2026-10-05：DESCRIPTION 补全四小节（行为零改动）
    DESCRIPTION = (
        "【干什么】用 ffmpeg 把多个视频首尾相接，合成一个 mp4。\n"
        "【怎么配】· video_paths：路径列表 / 单行路径 / 多行文本都行（换行、嵌套列表都会自动展开）\n"
        "· filename_prefix：输出前缀，默认 video/merged\n"
        "· reencode：关（默认）= 流拷贝直拼，快且无损；开 = 重新编码，兼容性好但慢\n"
        "· audio_path / audio_mode / audio_volume：给成片配一条音轨（replace 替换、mix 混音）\n"
        "【怎么用】把 🔁XH-合成并保存视频 输出的那些 file_path 汇总过来一次性拼完。\n"
        "【输出】output_path（STRING）：合并后视频的完整路径。\n"
        "⚠️ 需要 **ffmpeg 在 PATH 里**，否则直接失败。\n"
        "⚠️ 直拼模式要求各段分辨率/编码参数一致，不一致就打开 reencode。\n"
        "⚠️ 音频文件找不到时只警告、跳过音频，不会让整个拼接失败。"
    )

    def concat_files(self, video_paths, filename_prefix, reencode=None, audio_path=None, audio_mode=None, audio_volume=None):
        # 处理其他参数（因为 INPUT_IS_LIST=True，所有参数都是列表）
        filename_prefix = filename_prefix[0] if isinstance(filename_prefix, list) else filename_prefix
        reencode = reencode[0] if isinstance(reencode, list) and reencode else False
        audio_path = audio_path[0] if isinstance(audio_path, list) and audio_path else None
        audio_mode = audio_mode[0] if isinstance(audio_mode, list) and audio_mode else "replace"
        audio_volume = audio_volume[0] if isinstance(audio_volume, list) and audio_volume else 1.0
        
        # 展平并处理路径列表
        paths = []
        for item in video_paths:
            if isinstance(item, list):
                # 嵌套列表
                for p in item:
                    if isinstance(p, str) and p.strip():
                        paths.append(p.strip())
            elif isinstance(item, str):
                # 可能是多行文本或单个路径
                if '\n' in item:
                    paths.extend([p.strip() for p in item.split('\n') if p.strip()])
                elif item.strip():
                    paths.append(item.strip())
        
        if len(paths) == 0:
            raise ValueError("没有输入任何视频路径")
        
        # 验证文件存在
        for p in paths:
            if not os.path.exists(p):
                raise FileNotFoundError(f"视频文件不存在: {p}")
        
        # 验证音频文件存在，不存在则跳过音频处理（不报错）
        if audio_path and not os.path.exists(audio_path):
            print(f"[ConcatVideoFiles] 警告：音频文件不存在，跳过音频合并: {audio_path}")
            audio_path = None
        
        output_dir = folder_paths.get_output_directory()
        full_output_folder, filename, counter, subfolder, _ = folder_paths.get_save_image_path(
            filename_prefix, output_dir, 0, 0
        )
        output_file = os.path.join(full_output_folder, f"{filename}_{counter:05}_.mp4")
        
        # 创建 FFmpeg concat 列表
        with tempfile.NamedTemporaryFile(mode='w', suffix='.txt', delete=False) as f:
            for p in paths:
                escaped_path = p.replace("'", "'\\''")
                f.write(f"file '{escaped_path}'\n")
            concat_file = f.name
        
        try:
            if audio_path:
                # 有音频输入时，需要两步处理：先合并视频，再添加音频
                # 创建临时文件用于中间结果
                temp_video = tempfile.NamedTemporaryFile(suffix='.mp4', delete=False).name
                
                # 第一步：合并视频片段
                if reencode:
                    cmd1 = [
                        'ffmpeg', '-y', '-f', 'concat', '-safe', '0', '-i', concat_file,
                        '-c:v', 'libx264', '-preset', 'medium', '-crf', '23',
                        '-an',  # 不包含音频
                        '-movflags', '+faststart',
                        temp_video
                    ]
                else:
                    cmd1 = [
                        'ffmpeg', '-y', '-f', 'concat', '-safe', '0', '-i', concat_file,
                        '-c:v', 'copy', '-an',
                        '-movflags', '+faststart',
                        temp_video
                    ]
                
                result = subprocess.run(cmd1, capture_output=True, text=True)
                if result.returncode != 0:
                    raise RuntimeError(f"FFmpeg 合并视频错误:\n{result.stderr}")
                
                # 第二步：添加音频
                if audio_mode == "mix":
                    # 混合模式：先合并带原音频的视频，再混合新音频
                    # 重新合并带音频的视频
                    temp_video_with_audio = tempfile.NamedTemporaryFile(suffix='.mp4', delete=False).name
                    if reencode:
                        cmd_audio = [
                            'ffmpeg', '-y', '-f', 'concat', '-safe', '0', '-i', concat_file,
                            '-c:v', 'libx264', '-preset', 'medium', '-crf', '23',
                            '-c:a', 'aac', '-b:a', '128k',
                            '-movflags', '+faststart',
                            temp_video_with_audio
                        ]
                    else:
                        cmd_audio = [
                            'ffmpeg', '-y', '-f', 'concat', '-safe', '0', '-i', concat_file,
                            '-c', 'copy',
                            '-movflags', '+faststart',
                            temp_video_with_audio
                        ]
                    result = subprocess.run(cmd_audio, capture_output=True, text=True)
                    if result.returncode != 0:
                        raise RuntimeError(f"FFmpeg 合并音频错误:\n{result.stderr}")
                    
                    # 混合两个音频
                    cmd2 = [
                        'ffmpeg', '-y',
                        '-i', temp_video_with_audio,
                        '-i', audio_path,
                        '-filter_complex', f'[0:a][1:a]amix=inputs=2:duration=first:dropout_transition=2,volume={audio_volume}[a]',
                        '-map', '0:v', '-map', '[a]',
                        '-c:v', 'copy',
                        '-c:a', 'aac', '-b:a', '128k',
                        '-movflags', '+faststart',
                        '-shortest',
                        output_file
                    ]
                    try:
                        result = subprocess.run(cmd2, capture_output=True, text=True)
                        if result.returncode != 0:
                            raise RuntimeError(f"FFmpeg 混合音频错误:\n{result.stderr}")
                    finally:
                        if os.path.exists(temp_video_with_audio):
                            os.unlink(temp_video_with_audio)
                else:
                    # 替换模式：直接用新音频替换
                    volume_filter = f'volume={audio_volume}' if audio_volume != 1.0 else None
                    cmd2 = [
                        'ffmpeg', '-y',
                        '-i', temp_video,
                        '-i', audio_path,
                        '-map', '0:v', '-map', '1:a',
                        '-c:v', 'copy',
                    ]
                    if volume_filter:
                        cmd2.extend(['-af', volume_filter])
                    cmd2.extend([
                        '-c:a', 'aac', '-b:a', '128k',
                        '-movflags', '+faststart',
                        '-shortest',
                        output_file
                    ])
                    result = subprocess.run(cmd2, capture_output=True, text=True)
                    if result.returncode != 0:
                        raise RuntimeError(f"FFmpeg 添加音频错误:\n{result.stderr}")
                
                # 清理临时文件
                if os.path.exists(temp_video):
                    os.unlink(temp_video)
            else:
                # 无音频输入，原有逻辑
                if reencode:
                    cmd = [
                        'ffmpeg', '-y', '-f', 'concat', '-safe', '0', '-i', concat_file,
                        '-c:v', 'libx264', '-preset', 'medium', '-crf', '23',
                        '-c:a', 'aac', '-b:a', '128k',
                        '-movflags', '+faststart',
                        output_file
                    ]
                else:
                    cmd = [
                        'ffmpeg', '-y', '-f', 'concat', '-safe', '0', '-i', concat_file,
                        '-c', 'copy',
                        '-movflags', '+faststart',
                        output_file
                    ]
                
                result = subprocess.run(cmd, capture_output=True, text=True)
                if result.returncode != 0:
                    raise RuntimeError(f"FFmpeg 错误:\n{result.stderr}")
        finally:
            if os.path.exists(concat_file):
                os.unlink(concat_file)
        
        return {"ui": {"images": [{"filename": os.path.basename(output_file), "subfolder": subfolder, "type": "output"}], "animated": (True,)}, 
                "result": (output_file,)}


NODE_CLASS_MAPPINGS = {
    "XHComposeVideo": XHComposeVideo,
    "XHConcatVideo": XHConcatVideo,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "XHComposeVideo": "🔁XH-合成并保存视频",
    "XHConcatVideo": "🔁XH-视频拼接",
}
