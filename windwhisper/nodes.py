"""🍃 风语 · 提示词 —— 唯一节点，只负责接住推过来的文本。"""


class WindWhisperPrompt:
    """接住面板推过来的提示词，直通输出。

    刻意保持极简：生成过程发生在面板里，这个节点**不调用任何模型接口**。
    所以每次 Queue Prompt 都只是纯字符串传递，不会重复烧 token，
    也不会覆盖你手动改过的内容（因为面板不推，它就不动）。
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "text": (
                    "STRING",
                    {
                        "multiline": True,
                        "default": "",
                        # 提示词里经常出现 { 和 }，关掉动态提示词解析，
                        # 免得被 ComfyUI 当成 {a|b} 语法吃掉。
                        "dynamicPrompts": False,
                    },
                ),
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("提示词",)
    FUNCTION = "run"
    CATEGORY = "🍃 风语"
    DESCRIPTION = (
        "🍃 风语 · 提示词：接住风语面板推送过来的提示词，直通输出给工作流。"
        "节点本身不调用任何模型接口，所以重复执行不会产生额外开销。"
    )

    def run(self, text):
        return (text if text is not None else "",)
