"""显存协调（WindWhisper ↔ ComfyUI）。

**为什么必须有这个模块**：本地 LLM 和扩散模型抢的是同一块显存。你这张卡 12GB，
一个 SDXL 级模型加载完就吃掉大半，再让 llama-server 把 7B 模型推进来必然打架 ——
表现是出图报 CUDA OOM，或者模型被挤到内存里慢到无法忍受。

ComfyUI 自己**不会**在闲置时主动把模型还回去（它假设你马上还要出图，模型留着更快），
所以得由我们来要这块显存。

三种模式：
  off   什么都不做（你自己管）
  soft  只清 CUDA 缓存（torch.empty_cache）。**任何时候都安全**，但只能要回
        已被释放的碎片，正在被模型占着的那部分要不动 —— 默认值
  full  额外卸载所有已加载模型。**这才能真腾出地方**，代价是下次出图要重新从
        磁盘加载（几秒到几十秒）。所以正在跑图时会被跳过，不然会打断你的任务。
"""

import logging

logger = logging.getLogger("WindWhisper")

MB = 1048576


def _queue_busy():
    """ComfyUI 当前是否正在执行/排队。拿不到就返回 None（当成"不知道"）。

    用 `PromptQueue.get_current_queue()`，它返回 (正在跑的, 等待的)。
    返回值结构在不同版本上可能是 1 元或 2 元组，所以做得宽松一点。
    """
    try:
        from server import PromptServer  # ComfyUI 顶层模块

        queue = getattr(PromptServer.instance, "prompt_queue", None)
        if queue is None:
            return None
        res = queue.get_current_queue()
        if isinstance(res, (tuple, list)) and res:
            running = res[0]
        else:
            running = res
        return bool(running)
    except Exception:  # noqa: BLE001
        return None


def vram_info():
    """(空闲 MB, 总 MB)，取不到就返回 (None, None)。

    ⚠️ **别写 `get_torch_device().mem_get_info()`** —— `get_torch_device()` 返回的是
    `torch.device` 对象，**它没有这个方法**（`mem_get_info` 挂在 `torch.cuda` 模块上）。
    这个错我实测踩过：写成 `device.mem_get_info()` 只会拿到一句
    `AttributeError: 'torch.device' object has no attribute 'mem_get_info'`，
    而它被我下面的 except 吞掉，表现成"显存数字一直是 None"，很难查。

    正确入口是 ComfyUI 自己的 `get_free_memory` / `get_total_memory` ——
    它们还会帮你正确处理 CPU / MPS / XPU / NPU 各种后端。
    """
    try:
        import comfy.model_management as mm
    except Exception:  # noqa: BLE001
        return None, None

    free = total = None
    try:
        free = mm.get_free_memory()
    except Exception:  # noqa: BLE001
        pass
    try:
        total = mm.get_total_memory()
    except Exception:  # noqa: BLE001
        pass

    def to_mb(v):
        # 某些后端（CPU / MPS 分支）返回的是 None 或非数值
        return int(v / MB) if isinstance(v, (int, float)) and v else None

    return to_mb(free), to_mb(total)


def free_vram(mode="soft"):
    """按模式释放显存，返回一份"我到底做了什么"的报告，交给界面显示。

    绝不抛异常 —— 显存协调失败不该让聊天功能整体挂掉，
    它只是一个优化项，失败时降级继续。
    """
    report = {
        "mode": mode,
        "did": [],
        "skipped": [],
        "note": "",
        "free_mb": None,
        "total_mb": None,
    }

    if mode == "off":
        report["note"] = "显存协调已关闭"
        report["free_mb"], report["total_mb"] = vram_info()
        return report

    try:
        import comfy.model_management as mm
    except Exception as exc:  # noqa: BLE001
        report["note"] = "拿不到 comfy.model_management，跳过：%s" % exc
        return report

    before, total = vram_info()

    if mode == "full":
        busy = _queue_busy()
        if busy:
            # 正在跑图还去卸模型 = 直接把你的任务打断
            report["skipped"].append("unload_all_models")
            report["note"] = "ComfyUI 正在跑图，本轮跳过卸载模型，只清了缓存"
        else:
            try:
                mm.unload_all_models()
                report["did"].append("unload_all_models")
            except Exception as exc:  # noqa: BLE001
                report["note"] = "卸载模型失败：%s" % exc

    try:
        mm.soft_empty_cache()
        report["did"].append("soft_empty_cache")
    except Exception as exc:  # noqa: BLE001
        report["note"] = (report["note"] + " / " if report["note"] else "") + "清缓存失败：%s" % exc

    after, total2 = vram_info()
    report["free_mb"] = after
    report["total_mb"] = total or total2
    if before is not None and after is not None and after > before:
        report["freed_mb"] = after - before
    return report
