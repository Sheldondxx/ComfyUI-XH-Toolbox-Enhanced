from .nodes import (
    MelBandRoFormerModelLoader,
    MelBandRoFormerSampler,
    XHAudioDuration,
    XHMathExpr,
)

WEB_DIRECTORY = "web"

# XH 家族独立节点：type 名一律以 XH 开头，不与任何第三方包
# （ComfyUI-essentials / ComfyUI-MelBandRoFormer / SoundFlow）冲突。
# 因此分享出去可放心装，粉丝即便装了原版包也不会抢 type 名。
NODE_CLASS_MAPPINGS = {
    "XHVoiceSeparatorLoader": MelBandRoFormerModelLoader,
    "XHVoiceSeparatorSampler": MelBandRoFormerSampler,
    "XHAudioDuration": XHAudioDuration,
    "XHSimpleMath": XHMathExpr,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "XHVoiceSeparatorLoader": "🔁XH-人声分离(模型加载)",
    "XHVoiceSeparatorSampler": "🔁XH-人声分离(采样)",
    "XHAudioDuration": "🔁XH-音频取时长",
    "XHSimpleMath": "🔁XH-简易数学",
}

__all__ = [
    "NODE_CLASS_MAPPINGS",
    "NODE_DISPLAY_NAME_MAPPINGS",
    "WEB_DIRECTORY",
]
