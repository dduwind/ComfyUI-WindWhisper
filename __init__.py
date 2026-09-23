"""ComfyUI-WindWhisper —— 🍃 风语 · 提示词搭子

把「聊出来的提示词」直接推进工作流。

阶段 1：节点注册 + 前端面板 + 推送链路。
"""

from .windwhisper.nodes import WindWhisperPrompt

# 导入即注册 /windwhisper/* 路由
# （阶段 1 只有一条健康检查，用来验证前缀没跟其它插件撞车）
from .windwhisper import routes as _routes  # noqa: F401

WEB_DIRECTORY = "./web"

NODE_CLASS_MAPPINGS = {
    "WindWhisper_Prompt": WindWhisperPrompt,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "WindWhisper_Prompt": "🍃 风语 · 提示词",
}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
