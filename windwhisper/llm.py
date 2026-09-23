"""OpenAI 兼容的 LLM 客户端（流式）。

**一个适配器通吃**：llama-server、Ollama、LM Studio、vLLM、以及云端 OpenAI 兼容
服务全都实现 `/v1/chat/completions`，所以不需要为每家写一套。

⚠️ 这里有一处是**故意**的，别改回去：
    `_headers()` 只在 api_key 非空时才加 Authorization 头。
本地服务（llama-server / Ollama）默认不校验 Key —— 你要是把"必须有 Key"当成硬前提，
用户填了本地地址就会被自己拦在门外。H3-PromptWriter 就是栽在这，
`server_routes.py` 里一句 `if not cfg["api_key"]: raise` 直接让"接本地"变成不可能。
"""

import json
import logging
import re

import aiohttp

logger = logging.getLogger("WindWhisper")


def normalize_base(base_url):
    """把用户填的地址整成 `http://host:port/v1` 这种可直接拼端点的形式。

    容错三件事（都是实际会遇到的填法）：
      · 末尾多了斜杠
      · 把完整端点 `/chat/completions` 一起粘进来了 → 削掉
      · 没写版本段 → 补 `/v1`
    """
    base = str(base_url or "").strip().rstrip("/")
    if not base:
        base = "http://127.0.0.1:8080"
    if not re.match(r"^https?://", base, re.I):
        base = "http://" + base
    base = re.sub(r"/chat/completions$", "", base, flags=re.I)
    if re.search(r"/v\d+$", base):
        return base
    return base + "/v1"


def _headers(cfg):
    headers = {"Content-Type": "application/json"}
    key = str((cfg or {}).get("api_key") or "").strip()
    if key:  # ← 只有填了才加，空 Key 也能连本地服务
        headers["Authorization"] = "Bearer " + key
    return headers


def _hint_for_status(status, body, base):
    """把 HTTP 错误码翻译成"你该去改哪儿"，光报 400 没用。"""
    snippet = re.sub(r"\s+", " ", str(body or ""))[:220]
    if status in (401, 403):
        return "服务要鉴权：Key 不对或没权限（%s）" % snippet
    if status == 404:
        return (
            "路径不对：服务地址应该填到 <code>/v1</code> 为止，不要带 /chat/completions。"
            "当前用的是 <code>%s</code>。原始返回：%s" % (base, snippet)
        )
    if status == 400:
        return "服务说请求不合法（常见原因：模型名不对）%s" % snippet
    if status == 429:
        return "被限流了（429）%s" % snippet
    if status >= 500:
        return "服务端报错 %d：%s" % (status, snippet)
    return "HTTP %d：%s" % (status, snippet)


def _hint_for_exc(exc, base):
    """网络层异常 → 人话。"""
    name = type(exc).__name__
    if isinstance(exc, aiohttp.ClientConnectorError) or "Connector" in name:
        return (
            "连不上 <code>%s</code>。本地服务起了吗？<br>"
            "llama.cpp 的话是 <code>llama-server -m 模型.gguf --port 8080</code>；"
            "Ollama 是 <code>ollama serve</code>（默认端口 11434）。" % base
        )
    if "Timeout" in name or "timeout" in str(exc).lower():
        return "请求超时。本地模型首 token 慢，可以在设置里把超时调大；也可以换个更小的模型。"
    if isinstance(exc, aiohttp.ClientSSLError) or "SSL" in name:
        return "TLS 握手失败。如果是本地 http 服务，地址别写成 https。"
    return "%s：%s" % (name, exc)


# ------------------------------------------------------------------ 非流式


async def list_models(cfg, timeout=15):
    """拉模型列表。返回 (ids, raw_error)。有些服务不实现 /models，那不是错误。"""
    base = normalize_base(cfg.get("base_url"))
    url = base + "/models"
    try:
        to = aiohttp.ClientTimeout(total=timeout, sock_connect=8)
        async with aiohttp.ClientSession(timeout=to) as session:
            async with session.get(url, headers=_headers(cfg)) as resp:
                text = await resp.text()
                if resp.status >= 400:
                    return [], _hint_for_status(resp.status, text, base)
                data = json.loads(text or "{}")
    except Exception as exc:  # noqa: BLE001
        return [], _hint_for_exc(exc, base)

    items = []
    if isinstance(data, dict):
        items = data.get("data") or data.get("models") or []
    elif isinstance(data, list):
        items = data

    ids = []
    for it in items:
        if isinstance(it, dict):
            mid = it.get("id") or it.get("name") or it.get("model")
        else:
            mid = it
        if mid and str(mid) not in ids:
            ids.append(str(mid))
    return ids, None


async def test(cfg):
    """测试连接。返回一份可直接丢给界面的报告。"""
    import time

    base = normalize_base(cfg.get("base_url"))
    started = time.time()
    ids, err = await list_models(cfg, timeout=15)
    ms = int((time.time() - started) * 1000)

    if err:
        # /models 不通不代表聊天不通（少数服务只实现了 completions），所以再探一次
        return {
            "ok": False,
            "base": base,
            "ms": ms,
            "error": err,
            "models": [],
        }
    return {
        "ok": True,
        "base": base,
        "ms": ms,
        "models": ids,
        "count": len(ids),
        "note": "" if ids else "连上了，但这个服务没返回模型列表（可以在设置里手填模型名）",
    }


# ------------------------------------------------------------------ 流式对话


def _pick_delta(obj):
    """从一条流式分片里取 (正文增量, 思考增量)。

    兼容三种返回形态：
      · 正常的流式分片 delta.content
      · 有些服务在流里混进完整 message
      · 推理模型（qwen3 / deepseek-r1 这类）把思维链放在 reasoning_content，
        正文可能是空的 —— 不取它的话用户会看到"一直在转圈但不吐字"
    """
    choices = obj.get("choices") or []
    if not choices:
        return "", ""
    ch = choices[0] or {}
    d = ch.get("delta")
    if not isinstance(d, dict) or not d:
        d = ch.get("message") if isinstance(ch.get("message"), dict) else {}
    text = d.get("content") or ""
    think = d.get("reasoning_content") or d.get("reasoning") or ""
    return text, think


def _extract_plain(data):
    """非流式响应里取正文。"""
    choices = data.get("choices") or []
    if not choices:
        return ""
    ch = choices[0] or {}
    msg = ch.get("message") or {}
    return msg.get("content") or ch.get("text") or ""


def build_payload(cfg, messages):
    """构造 /chat/completions 的请求体。

    抽成纯函数是为了**能被单测直接断言** —— 下面那个关思考的字段写错一个字就会
    静默失效（服务照单全收，只是不关思考），光看代码根本发现不了。
    """
    payload = {
        "model": str(cfg.get("model") or "").strip(),
        "messages": messages,
        "temperature": cfg.get("temperature", 0.8),
        "top_p": cfg.get("top_p", 0.95),
        "max_tokens": cfg.get("max_tokens", 8192),
        "stream": True,
    }
    # 推理模型（qwen3 / deepseek-r1 这类）默认先写一大段思维链。
    # ⚠️ 思维链和正文**共用 max_tokens**（llama.cpp / OpenAI 都这么算）——
    # 思考一长，正文一个字都轮不到，用户看到的就是"空回答"。
    # 真机踩过：换了个要求模型先做模式判断的 skill，思考涨到 7811 字把 2048 吃光。
    # 这个字段不是所有 OpenAI 兼容服务都认，被 400 拒会自动摘掉重试（见 _run_once）。
    if not cfg.get("thinking"):
        payload["chat_template_kwargs"] = {"enable_thinking": False}
    return payload


async def _run_once(cfg, url, payload, timeout):
    """发一次请求并把流读干净，逐个 yield 事件。

    ⚠️ 会**就地摘掉** `payload["chat_template_kwargs"]` 后重试一次：
    本地 llama.cpp 认这个字段，OpenAI 官方不认（回 400 unknown field）。
    这个 pop 是安全的 —— payload 由 `build_payload()` 现造，不共用。

    内部事件 `_http_error` 只在"一个字都还没吐"时出现，所以调用方可以放心重试。
    """
    for attempt in (0, 1):
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(url, headers=_headers(cfg), json=payload) as resp:
                if resp.status >= 400:
                    body = await resp.text()
                    if (attempt == 0 and resp.status == 400
                            and "chat_template_kwargs" in payload):
                        logger.info("[WindWhisper] 服务不认识 chat_template_kwargs，摘掉重试")
                        payload.pop("chat_template_kwargs", None)
                        continue
                    yield {"type": "_http_error", "status": resp.status, "body": body}
                    return

                ctype = (resp.headers.get("Content-Type") or "").lower()

                # 有些服务忽略 stream 参数，直接回一坨 JSON —— 也得能正常显示
                if "event-stream" not in ctype:
                    raw = await resp.text()
                    try:
                        data = json.loads(raw)
                    except ValueError:
                        if raw.strip():
                            yield {"type": "delta", "text": raw}
                        yield {"type": "done"}
                        return
                    text = _extract_plain(data)
                    if text:
                        yield {"type": "delta", "text": text}
                    yield {"type": "done", "model": data.get("model")}
                    return

                buf = b""
                model_name = None
                finish = None
                got_any = False

                async for chunk in resp.content.iter_any():
                    buf += chunk
                    while True:
                        nl = buf.find(b"\n")
                        if nl < 0:
                            break
                        line = buf[:nl].strip()
                        buf = buf[nl + 1:]
                        if not line or not line.startswith(b"data:"):
                            continue  # 空行是事件分隔符；event:/注释行忽略
                        raw_payload = line[5:].strip()
                        if raw_payload == b"[DONE]":
                            continue
                        try:
                            obj = json.loads(raw_payload.decode("utf-8", "replace"))
                        except ValueError:
                            continue

                        if obj.get("model"):
                            model_name = obj["model"]
                        text, think = _pick_delta(obj)
                        if think:
                            yield {"type": "think", "text": think}
                        if text:
                            got_any = True
                            yield {"type": "delta", "text": text}
                        for ch in (obj.get("choices") or []):
                            if ch.get("finish_reason"):
                                finish = ch["finish_reason"]

                yield {"type": "done", "model": model_name, "finish": finish,
                       "empty": not got_any}
                return


async def stream_chat(cfg, messages):
    """异步生成器：逐个吐出事件字典。

    事件形态（前端直接按 type 处理）：
        {"type":"delta","text":"..."}     正文增量
        {"type":"think","text":"..."}     思考增量（界面用暗色显示）
        {"type":"done","model":...,"finish":...,"empty":...}
        {"type":"error","error":"...","hint":"..."}
    """
    base = normalize_base(cfg.get("base_url"))
    url = base + "/chat/completions"
    payload = build_payload(cfg, messages)
    if not payload["model"]:
        yield {
            "type": "error",
            "error": "还没填模型名",
            "hint": "打开右上角「后端设置」，点「拉取模型列表」选一个，或手填。",
        }
        return

    # total=None：本地大模型吐一长段可能要几分钟，不能用整体超时卡死；
    # 用 sock_read 卡"两个分片之间不该超过 N 秒"，这才是真正有意义的超时。
    timeout = aiohttp.ClientTimeout(
        total=None,
        sock_connect=15,
        sock_read=max(30.0, float(cfg.get("timeout") or 300)),
    )

    try:
        async for ev in _run_once(cfg, url, payload, timeout):
            if ev.get("type") == "_http_error":
                yield {
                    "type": "error",
                    "error": "HTTP %d" % ev["status"],
                    "hint": _hint_for_status(ev["status"], ev["body"], base),
                }
                return
            yield ev
    except Exception as exc:  # noqa: BLE001
        logger.warning("[WindWhisper] 对话请求失败：%s", exc)
        yield {"type": "error", "error": "%s" % type(exc).__name__,
               "hint": _hint_for_exc(exc, base)}
