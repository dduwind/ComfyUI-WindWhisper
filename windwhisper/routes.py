"""WindWhisper 的 aiohttp 路由。

全部挂在 `/windwhisper/` 前缀下 —— 这个前缀是**自造词**，跟机器上另外 90 多个
custom_nodes 插件撞车的概率近乎为零（当年 WindMix 就是因为路由和原插件完全
同名才被迫回头加 `WM_` 前缀）。

    GET    /windwhisper/ping                  健康检查
    GET    /windwhisper/config                读后端配置
    POST   /windwhisper/config                改后端配置
    POST   /windwhisper/config/test           测试连接（本地服务无 Key 也要能通）
    GET    /windwhisper/models                拉模型列表
    GET    /windwhisper/prompt                预览拼好的 system prompt
    POST   /windwhisper/chat                  发消息（SSE 流式；带图时走 image / imageRef）
    GET    /windwhisper/image                 读会话里的图片素材（反推那张图）
    GET    /windwhisper/chats                 会话列表（轻量元数据）
    POST   /windwhisper/chats                 新建会话
    GET    /windwhisper/chats/{cid}           读单个会话
    POST   /windwhisper/chats/{cid}           存单个会话
    DELETE /windwhisper/chats/{cid}           删会话
    GET    /windwhisper/skills                skill 列表
    POST   /windwhisper/skills                新建 skill（写用户目录）
    GET    /windwhisper/skills/{sid}           skill 详情（含适配后的注入正文）
    POST   /windwhisper/skills/{sid}           改 skill（只允许用户目录里的）
    POST   /windwhisper/skills/{sid}/adapter   只写适配层（任何 skill 都行，不动正文）
    DELETE /windwhisper/skills/{sid}           删 skill（只允许用户目录里的）
    POST   /windwhisper/skills/{sid}/duplicate 复制一份到用户目录（改内置的正规路径）
    GET    /windwhisper/skills/{sid}/export    导出 SKILL.md 原文
    POST   /windwhisper/skills/import/scan     扫目录，列出能导入的 skill（只读）
    POST   /windwhisper/skills/import/run      执行导入（拷进用户目录，不删源）
    GET    /windwhisper/library               词库列表
    POST   /windwhisper/library               词库新建 / 保存
    DELETE /windwhisper/library/{lid}         删词库条目
    GET    /windwhisper/library/export        导出词库为纯文本

**面板页面本身不写路由** —— 走 ComfyUI 自带的
`/extensions/ComfyUI-WindWhisper/panel/index.html`，省一条。

⚠️ 路由注册顺序有讲究：`/skills/import/scan` 这种**多段路径**要放在
`/skills/{sid}` 前面吗？—— 不用。aiohttp 的 `{sid}` 只吃**一段**，
`/skills/import/scan` 有两段，压根不会命中 `{sid}` 那条。所以顺序无所谓。
但 `/skills/{sid}` 和 `/skills/{sid}/export` 同时存在时要注意：也是段数不同，安全。
真正有歧义的是**同段数**的（比如曾经想加 `GET /skills/dirs`，那会跟
`GET /skills/{sid}` 抢 "dirs" 这个名字）—— 这类一律塞进别的接口的返回里，别单开路由。
"""

import importlib
import json
import logging
import os
import time

from aiohttp import web

logger = logging.getLogger("WindWhisper")

try:
    # 绝对导入，指向 ComfyUI 顶层的 server 模块（不是本插件的包）
    from server import PromptServer

    _routes = PromptServer.instance.routes
except Exception as exc:  # 脱离 ComfyUI 环境时（例如单测）不炸
    _routes = None
    logger.warning("[WindWhisper] 拿不到 PromptServer.routes，路由未注册：%s", exc)

# 各模块单独兜底导入：任何一个挂了，/ping 都还得能用来诊断
#
# ⚠️ 必须用**相对导入**（`.` + `__package__`），绝不能用 `import windwhisper.xxx`。
# 原因：ComfyUI 是这么加载自定义节点的 ——
#     spec_from_file_location("<插件目录名>", <插件>/__init__.py)
# 它**不把插件目录塞进 sys.path**（别信"会塞进去"的老说法，实测 0.37.0 不塞）。
# 于是子包只以 `ComfyUI-WindWhisper.windwhisper` 的身份存在，
# **顶层名 `windwhisper` 压根不存在** → 绝对导入六个模块全挂，
# 表现是 /ping 里 modules 全 false、/skills 500、/library 404（踩过，2026-09-22）。
#
# `__package__` 在 ComfyUI 进程里是 `ComfyUI-WindWhisper.windwhisper`，
# 在单测里是 `windwhisper` —— 两种场景都对，所以测试不用特殊照顾。
_modules = {}
for _name in ("skills", "store", "llm", "prompt", "vram", "library"):
    try:
        _modules[_name] = importlib.import_module("." + _name, __package__)
    except Exception as exc:  # noqa: BLE001
        _modules[_name] = None
        logger.exception("[WindWhisper] %s 模块导入失败：%s", _name, exc)

skills_mod = _modules["skills"]
store = _modules["store"]
llm = _modules["llm"]
prompt_mod = _modules["prompt"]
vram_mod = _modules["vram"]
library_mod = _modules["library"]


PLUGIN_VERSION = "0.5.0"

# skill / 会话 id 只允许这些字符；`..` 单独再拦一次，防目录穿越。
# aiohttp 的 {sid} 会把 %2e%2e 解码成 ..，所以不能只靠 pattern 匹配。
_MISSING = {"ok": False, "error": "模块未加载，去看 ComfyUI 控制台日志"}


def _need(*names):
    """返回缺失模块名列表，空表示都齐了。"""
    return [n for n in names if _modules.get(n) is None]


def _bad_id(value):
    if store is not None:
        return not store.safe_id(value)
    return (not value) or (".." in value)


async def _body(request):
    """宽容地取 JSON body：坏了就返回空 dict，不抛 500。"""
    try:
        data = await request.json()
        return data if isinstance(data, dict) else {}
    except Exception:  # noqa: BLE001
        return {}


# ---------------------------------------------------------------- 图片（反推）
#
# 2026-09-23 加。前端已经把图压过了（最长边 1280 / JPEG），这里的长度上限只是**兜底**：
# 不设的话一个坏客户端能把 50MB 的 base64 塞进会话文件，从此每次读这条会话都要解析它。
#
# ⚠️ 当天晚些时候又改过一处：**图不再存进会话 json**（用户嫌历史膨胀），改由
# store.slim_msgs 落成 images/<id>/ 下的文件，会话里只留文件名。所以这里校验的是
# "进来的 data URL 合不合法"（它要原样发给模型），存哪儿是 store 的事。
_IMG_MAX_CHARS = 3 * 1024 * 1024
# 只收光栅图的 data URL。**故意不收 image/svg+xml** —— SVG 能装脚本，
# 虽然现在只当 <img src> 用（不执行），但少一个入口少一份风险，没必要图那个方便。
_IMG_TYPES = ("data:image/jpeg;base64,", "data:image/png;base64,",
              "data:image/webp;base64,", "data:image/gif;base64,")
# 只贴图不打字时的兜底指令 —— 让"纯图反推"一步就能发出去。标题也用它旁边那句。
DEFAULT_IMAGE_PROMPT = "把这张图反推成一份可直接出图的提示词。"
PURE_IMAGE_TITLE = "图片反推"


def _clean_image(raw):
    """校验前端传来的图片 data URL：合法就返回原串，否则 None。

    形状必须严格是 `data:image/<光栅类型>;base64,<...>`：外链、file://、相对路径
    一律不收（那些地址会被原样发给 LLM 服务，等于让服务去替我们请求内网）。
    """
    if not raw or not isinstance(raw, str):
        return None
    s = raw.strip()
    if len(s) < 64 or len(s) > _IMG_MAX_CHARS:
        return None
    for pre in _IMG_TYPES:
        if s.startswith(pre):
            return s
    return None


def _register(routes):
    # ------------------------------------------------------------ 健康检查

    @routes.get("/windwhisper/ping")
    async def windwhisper_ping(request):
        """浏览器直接访问 /windwhisper/ping 就能确认插件路由活着。"""
        missing = _need("skills", "store", "llm", "prompt", "vram", "library")
        return web.json_response(
            {
                "ok": True,
                "plugin": "ComfyUI-WindWhisper",
                "display": "🍃 风语",
                "version": PLUGIN_VERSION,
                "stage": 4,
                "modules": {k: _modules[k] is not None for k in _modules},
                "missing_modules": missing,
                "user_root": store.user_root() if store else None,
                "library_file": library_mod.path() if library_mod else None,
            }
        )

    # ------------------------------------------------------------ 后端配置

    @routes.get("/windwhisper/config")
    async def windwhisper_config_get(request):
        if _need("store"):
            return web.json_response(_MISSING, status=500)
        return web.json_response({"ok": True, "config": store.public_config()})

    @routes.post("/windwhisper/config")
    async def windwhisper_config_post(request):
        if _need("store"):
            return web.json_response(_MISSING, status=500)
        patch = await _body(request)
        try:
            cfg = store.save_config(patch)
        except Exception as exc:  # noqa: BLE001
            logger.exception("[WindWhisper] 保存配置失败")
            return web.json_response({"ok": False, "error": str(exc)}, status=500)
        return web.json_response({"ok": True, "config": store.public_config(cfg)})

    @routes.post("/windwhisper/config/test")
    async def windwhisper_config_test(request):
        """测试连接。**本地服务不填 Key 也必须能通** —— 这是本插件的硬要求。"""
        if _need("store", "llm"):
            return web.json_response(_MISSING, status=500)
        patch = await _body(request)
        cfg = store.load_config()
        if patch:
            for k in patch:
                if k in store.DEFAULT_CONFIG:
                    cfg[k] = patch[k]
        try:
            report = await llm.test(cfg)
        except Exception as exc:  # noqa: BLE001
            logger.exception("[WindWhisper] 测试连接失败")
            return web.json_response({"ok": False, "error": str(exc)}, status=500)
        report["used_key"] = bool(str(cfg.get("api_key") or "").strip())
        return web.json_response({"ok": report.get("ok", False), "result": report})

    @routes.get("/windwhisper/models")
    async def windwhisper_models(request):
        if _need("store", "llm"):
            return web.json_response(_MISSING, status=500)
        cfg = store.load_config()
        ids, err = await llm.list_models(cfg)
        base = llm.normalize_base(cfg.get("base_url"))
        return web.json_response({"ok": err is None, "base": base, "models": ids, "error": err})

    # ------------------------------------------- system prompt 预览（诊断用）

    @routes.get("/windwhisper/prompt")
    async def windwhisper_prompt_preview(request):
        """拼好的 system prompt —— 面板里能直接看"模型到底收到什么"。"""
        if _need("store", "prompt"):
            return web.json_response(_MISSING, status=500)
        cfg = store.load_config()
        master = request.query.get("master") or None
        refs = [r for r in (request.query.get("refs") or "").split(",") if r]
        text, meta = prompt_mod.build_system_prompt(cfg, master, refs, skills_mod=skills_mod)
        return web.json_response({"ok": True, "system": text, "meta": meta})

    # -------------------------------------------------------------- 对话

    @routes.post("/windwhisper/chat")
    async def windwhisper_chat(request):
        """发消息。SSE 流式返回。

        用 fetch + ReadableStream 收而不是 EventSource —— 因为 EventSource 只能发
        GET，塞不下消息体。用 SSE 的**格式**，不用它的 API。

        服务端负责把用户消息和助手回答都落盘，所以中途关掉浏览器也不会丢历史。
        """
        if _need("store", "llm", "prompt"):
            return web.json_response(_MISSING, status=500)

        body = await _body(request)
        text = str(body.get("text") or "").strip()
        # 图有两条路进来：
        #   · image     —— 本轮新贴的（前端压过的 data URL）
        #   · imageRef  —— 重发上一轮。「关掉思考重来」拿的是历史里那条消息，而会话里
        #     存的是**素材文件名**，所以把文件读回 data URL 再发。
        raw_img = body.get("image")
        image = _clean_image(raw_img) if raw_img else None
        if raw_img and not image:
            return web.json_response(
                {"ok": False, "error": "图片格式不认识 —— 只收 data:image/jpeg|png|webp|gif 的 base64"},
                status=400,
            )
        if not image:
            ref = body.get("imageRef")
            rid = body.get("chatId")
            if isinstance(ref, str) and ref and isinstance(rid, str) and not _bad_id(rid):
                image = store.image_data_url(rid, ref)
                if not image:
                    # 文件没了 / 名字不对 → 退化成"只有文字"照发。
                    # 为一张图让"重发"整个失败，那是拿小问题换大问题。
                    logger.warning("[WindWhisper] 找不到这张图，本轮按纯文字发：%s / %s", rid, ref)
        # 图怎么处理：前端拖图时弹「反推 / 交给当前 skill」二选一，把选择带进来。
        # 没带 intent（老前端 / 纯文字）一律按反推 —— 跟旧行为一致，零回退。
        image_intent = str(body.get("image_intent") or "").strip().lower()
        # 只贴了图、一个字没打：默认反推；只有显式选了"交给 skill"才把图丢给 skill 自己处理。
        pure_image = bool(image) and not text
        if pure_image and image_intent != "skill":
            text = DEFAULT_IMAGE_PROMPT
        # 既没有文字也没有图才真算空（reference 模式下"只有图没字"是合法的）
        if not text and not image:
            return web.json_response({"ok": False, "error": "消息是空的"}, status=400)

        cfg = store.load_config()

        # 1) 落盘用户这一条（会话不存在就现建）
        chat = None
        cid = body.get("chatId")
        if cid and not _bad_id(cid):
            chat = store.load_chat(cid)
        if chat is None:
            chat = store.blank_chat(body.get("masterId"))
            cid = chat["id"]

        if body.get("masterId") is not None:
            chat["skillId"] = body.get("masterId")
        if isinstance(body.get("refIds"), list):
            chat["refIds"] = body["refIds"]

        msgs = chat.get("msgs") or []
        # 图**存进历史**（多轮能一直引用同一张图），但**不是以 base64 形式**：
        # 这里先挂上 data URL（本轮拼 prompt 直接用它，省一次读盘），落盘时
        # store.save_chat → slim_msgs 会把它换成 images/<id>/ 下的素材文件名。
        # 所以会话 json 里看不到任何图片数据，历史怎么聊都不会膨胀。
        entry = {"role": "user", "text": text, "ts": store.now_ms()}
        if image:
            entry["image"] = image
        msgs.append(entry)
        chat["msgs"] = msgs
        if len(msgs) == 1 or not chat.get("title") or chat.get("title") == "新会话":
            if pure_image:
                # reference 模式（把图交给 skill 自己描述）不该叫"图片反推"
                chat["title"] = "图片分析" if image_intent == "skill" else PURE_IMAGE_TITLE
            else:
                chat["title"] = store.auto_title(text)
        try:
            store.save_chat(cid, chat)
        except Exception as exc:  # noqa: BLE001
            logger.warning("[WindWhisper] 会话落盘失败：%s", exc)

        # 2) 显存协调 —— 必须在发请求之前，否则本地 LLM 没地方站
        vram_report = {"mode": "off", "did": [], "note": ""}
        if vram_mod is not None:
            try:
                vram_report = vram_mod.free_vram(cfg.get("vram_mode") or "soft")
            except Exception as exc:  # noqa: BLE001
                vram_report = {"mode": cfg.get("vram_mode"), "did": [], "note": "显存协调异常：%s" % exc}

        # 3) 拼 prompt 与 messages
        system_text, pmeta = prompt_mod.build_system_prompt(
            cfg, chat.get("skillId"), chat.get("refIds"), skills_mod=skills_mod
        )
        # ⚠️ msgs 是"刚从磁盘读出来的老条目 + 本轮新加的"混合体：老条目上的 image 是
        # **素材文件名**，本轮那条还是 data URL。按需读文件这件事交给 prompt 层回调完成 ——
        # 它只为"真进了预算"的那几张读盘，不会为了裁预算先把所有图都读一遍。
        messages = prompt_mod.build_messages(
            cfg, system_text, msgs,
            image_loader=(lambda name: store.image_data_url(cid, name)),
        )

        # 4) 流式转发
        resp = web.StreamResponse(
            status=200,
            headers={
                "Content-Type": "text/event-stream; charset=utf-8",
                "Cache-Control": "no-cache, no-transform",
                "Connection": "keep-alive",
                # 万一以后挂在反代后面，别让它缓冲住流
                "X-Accel-Buffering": "no",
            },
        )
        await resp.prepare(request)

        sent = 0
        started = time.time()

        async def emit(obj):
            nonlocal sent
            await resp.write(("data: %s\n\n" % json.dumps(obj, ensure_ascii=False)).encode("utf-8"))
            sent += 1

        await emit(
            {
                "type": "meta",
                "chatId": cid,
                "title": chat.get("title"),
                "vram": vram_report,
                "system_chars": pmeta.get("chars"),
                "system_bytes": pmeta.get("bytes"),
                "master": pmeta.get("master"),
                "refs": pmeta.get("refs"),
                "missing": pmeta.get("missing"),
                "context_msgs": len(messages) - 1,
                "rounds": cfg.get("history_rounds"),
                "model": cfg.get("model"),
                "base": llm.normalize_base(cfg.get("base_url")),
            }
        )

        acc, think = [], []
        model_name = None
        finish = None
        err = None
        try:
            async for ev in llm.stream_chat(cfg, messages):
                if ev.get("type") == "delta":
                    acc.append(ev.get("text") or "")
                elif ev.get("type") == "think":
                    think.append(ev.get("text") or "")
                elif ev.get("type") == "done":
                    model_name = ev.get("model")
                    # ⚠️ finish_reason 必须留下来：'length' 就是"额度被吃光/被截断"的铁证。
                    # 以前这里只取 model，于是"正文空 + 思考满"在界面上变成一个**没有任何解释的
                    # 空气泡** —— 用户只能猜。别再把这一项丢掉。
                    finish = ev.get("finish")
                await emit(ev)
                if ev.get("type") == "error":
                    err = ev.get("hint") or ev.get("error")
        except ConnectionResetError:
            # 你按了「停止」或者关了面板 —— 把已经吐出来的部分照样存下来
            logger.info("[WindWhisper] 客户端断开，已保存部分回答")
        except Exception as exc:  # noqa: BLE001
            logger.exception("[WindWhisper] 流式转发异常")
            err = str(exc)
            try:
                await emit({"type": "error", "error": type(exc).__name__, "hint": str(exc)})
            except Exception:  # noqa: BLE001
                pass

        answer = "".join(acc)
        ms = int((time.time() - started) * 1000)

        # 5) 助手这条也落盘（包括"中途停掉"的半截回答）
        if answer or think:
            try:
                fresh = store.load_chat(cid) or chat
                fresh.setdefault("msgs", []).append(
                    {
                        "role": "assistant",
                        "text": answer,
                        "think": "".join(think) or None,
                        "model": model_name or cfg.get("model"),
                        "finish": finish,
                        "ms": ms,
                        "ts": store.now_ms(),
                        "error": err,
                    }
                )
                store.save_chat(cid, fresh)
            except Exception as exc:  # noqa: BLE001
                logger.warning("[WindWhisper] 保存回答失败：%s", exc)

        try:
            await emit({"type": "saved", "chatId": cid, "answer_chars": len(answer), "ms": ms, "events": sent})
            await resp.write_eof()
        except Exception:  # noqa: BLE001
            pass
        return resp

    # ------------------------------------------------------- 图片素材（读取）
    #
    # 会话 json 里只存素材名（images/<会话id>/img_<内容哈希>.jpg），图本身在这儿
    # 按需读出来给面板的 <img> 显示。**名字是内容哈希 → 同一个文件名永远是同一份字节**，
    # 所以可以放心让它长缓存（immutable），切会话不会反复传图。

    @routes.get("/windwhisper/image")
    async def windwhisper_image(request):
        if _need("store"):
            return web.json_response(_MISSING, status=500)
        cid = request.query.get("chat") or ""
        name = request.query.get("name") or ""
        # 两道白名单都要过：cid 防目录穿越，name 再防一次（它会被拼进路径）
        if _bad_id(cid) or not store.safe_image_name(name):
            return web.json_response({"ok": False, "error": "参数不对"}, status=400)
        p = store.image_path(cid, name)
        if not os.path.isfile(p):
            return web.json_response({"ok": False, "error": "这张图不在了"}, status=404)
        # Content-Type 由 web.FileResponse 按扩展名给（.jpg → image/jpeg）
        return web.FileResponse(
            p, headers={"Cache-Control": "public, max-age=31536000, immutable"}
        )

    # -------------------------------------------------------------- 会话

    @routes.get("/windwhisper/chats")
    async def windwhisper_chats_list(request):
        if _need("store"):
            return web.json_response(_MISSING, status=500)
        include_archived = request.query.get("archived") in ("1", "true", "yes")
        try:
            items = store.list_chats(include_archived=include_archived)
        except Exception as exc:  # noqa: BLE001
            logger.exception("[WindWhisper] 列会话失败")
            return web.json_response({"ok": False, "error": str(exc)}, status=500)
        return web.json_response({"ok": True, "chats": items, "dir": store.chats_dir()})

    @routes.post("/windwhisper/chats")
    async def windwhisper_chats_create(request):
        if _need("store"):
            return web.json_response(_MISSING, status=500)
        body = await _body(request)
        chat = store.blank_chat(body.get("skillId"))
        if body.get("title"):
            chat["title"] = str(body["title"])[:80]
        store.save_chat(chat["id"], chat)
        return web.json_response({"ok": True, "chat": chat})

    @routes.get("/windwhisper/chats/{cid}")
    async def windwhisper_chat_get(request):
        if _need("store"):
            return web.json_response(_MISSING, status=500)
        cid = request.match_info.get("cid", "")
        if _bad_id(cid):
            return web.json_response({"ok": False, "error": "非法的会话 id"}, status=400)
        chat = store.load_chat(cid)
        if chat is None:
            return web.json_response({"ok": False, "error": "找不到这个会话"}, status=404)
        return web.json_response({"ok": True, "chat": chat})

    @routes.post("/windwhisper/chats/{cid}")
    async def windwhisper_chat_save(request):
        if _need("store"):
            return web.json_response(_MISSING, status=500)
        cid = request.match_info.get("cid", "")
        if _bad_id(cid):
            return web.json_response({"ok": False, "error": "非法的会话 id"}, status=400)

        body = await _body(request)
        chat = store.load_chat(cid) or store.blank_chat()
        # 白名单合并 —— 不让前端随手往文件里塞任意字段
        for k in ("title", "skillId", "archived"):
            if k in body:
                chat[k] = body[k]
        if isinstance(body.get("refIds"), list):
            chat["refIds"] = body["refIds"]
        if isinstance(body.get("msgs"), list):
            chat["msgs"] = body["msgs"]
        saved = store.save_chat(cid, chat)
        return web.json_response({"ok": True, "chat": saved})

    @routes.delete("/windwhisper/chats/{cid}")
    async def windwhisper_chat_delete(request):
        if _need("store"):
            return web.json_response(_MISSING, status=500)
        cid = request.match_info.get("cid", "")
        if _bad_id(cid):
            return web.json_response({"ok": False, "error": "非法的会话 id"}, status=400)
        return web.json_response({"ok": store.delete_chat(cid)})

    # -------------------------------------------------------------- skill

    @routes.get("/windwhisper/skills")
    async def windwhisper_skills_list(request):
        """Skill 列表。只读 frontmatter + 目录统计，不读正文，所以很快。"""
        if skills_mod is None:
            return web.json_response(
                {"ok": False, "error": "skills 模块未加载，看 ComfyUI 控制台日志"},
                status=500,
            )
        try:
            items = skills_mod.scan()
        except Exception as exc:  # noqa: BLE001
            logger.exception("[WindWhisper] 扫描 skill 失败")
            return web.json_response({"ok": False, "error": str(exc)}, status=500)

        return web.json_response(
            {
                "ok": True,
                "count": len(items),
                "builtin_dir": skills_mod.BUILTIN_DIR,
                "user_dir": skills_mod.user_dir(),
                "adapters_dir": skills_mod.ADAPTER_DIR,
                "skills": items,
            }
        )

    @routes.get("/windwhisper/skills/{sid}")
    async def windwhisper_skill_detail(request):
        """单个 skill 详情。content 是**适配后实际注入的文本**，UI 上看到什么模型就收到什么。"""
        if skills_mod is None:
            return web.json_response({"ok": False, "error": "skills 模块未加载"}, status=500)

        sid = request.match_info.get("sid", "")
        if _bad_id(sid):
            return web.json_response({"ok": False, "error": "非法的 skill id"}, status=400)

        try:
            detail = skills_mod.load(sid)
        except Exception as exc:  # noqa: BLE001
            logger.exception("[WindWhisper] 读 skill 详情失败：%s", sid)
            return web.json_response({"ok": False, "error": str(exc)}, status=500)

        if detail is None:
            return web.json_response({"ok": False, "error": "找不到这个 skill"}, status=404)

        return web.json_response({"ok": True, "skill": detail})

    # ------------------------------------------- skill 增删改 / 目录导入
    #
    # ⚠️ 两条**不同**的边界，别混（2026-09-24 拆开）：
    #   · 改**正文**：只有用户目录里的 skill 能改能删（skills.py 的 save / delete 守的），
    #     内置的想改正文就先调 duplicate 复制到用户目录。
    #   · 写**适配**（下面的 `/adapter`）：**任何 skill 都允许**，内置也行 ——
    #     因为落点永远是 user/default/WindWhisper/adapters/<id>.json，插件目录一个
    #     字节都不动、插件更新也冲不掉。所以"给内置 skill 做适配"**不需要复制副本**
    #     （复制会把正文冻在复制那天，而适配层本来就是"原文不动、只加一层"）。

    @routes.post("/windwhisper/skills")
    async def windwhisper_skill_create(request):
        if skills_mod is None:
            return web.json_response({"ok": False, "error": "skills 模块未加载"}, status=500)
        fields = await _body(request)
        try:
            detail, err = skills_mod.create(fields)
        except Exception as exc:  # noqa: BLE001
            logger.exception("[WindWhisper] 新建 skill 失败")
            return web.json_response({"ok": False, "error": str(exc)}, status=500)
        if err:
            return web.json_response({"ok": False, "error": err}, status=400)
        return web.json_response({"ok": True, "skill": detail})

    @routes.post("/windwhisper/skills/{sid}")
    async def windwhisper_skill_save(request):
        if skills_mod is None:
            return web.json_response({"ok": False, "error": "skills 模块未加载"}, status=500)
        sid = request.match_info.get("sid", "")
        if _bad_id(sid):
            return web.json_response({"ok": False, "error": "非法的 skill id"}, status=400)
        fields = await _body(request)
        try:
            detail, err = skills_mod.save(sid, fields)
        except Exception as exc:  # noqa: BLE001
            logger.exception("[WindWhisper] 保存 skill 失败：%s", sid)
            return web.json_response({"ok": False, "error": str(exc)}, status=500)
        if err:
            return web.json_response({"ok": False, "error": err}, status=400)
        return web.json_response({"ok": True, "skill": detail})

    @routes.post("/windwhisper/skills/{sid}/adapter")
    async def windwhisper_skill_save_adapter(request):
        """只写适配层：**不碰 SKILL.md**。

        跟 `POST /skills/{sid}` 的分工 —— 那条改正文（限用户目录里的），
        这条只改"风语怎么用它"：分类 / 图标 / 显示名 / 描述 / 注入清单 / 剥离规则 / 说明。
        所以**内置 skill 也能走这条**，这正是它存在的理由。
        """
        if skills_mod is None:
            return web.json_response({"ok": False, "error": "skills 模块未加载"}, status=500)
        sid = request.match_info.get("sid", "")
        if _bad_id(sid):
            return web.json_response({"ok": False, "error": "非法的 skill id"}, status=400)
        fields = await _body(request)
        try:
            detail, err = skills_mod.save_adapter_only(sid, fields)
        except Exception as exc:  # noqa: BLE001
            logger.exception("[WindWhisper] 保存 skill 适配失败：%s", sid)
            return web.json_response({"ok": False, "error": str(exc)}, status=500)
        if err:
            return web.json_response({"ok": False, "error": err}, status=400)
        return web.json_response({"ok": True, "skill": detail})

    @routes.delete("/windwhisper/skills/{sid}")
    async def windwhisper_skill_delete(request):
        if skills_mod is None:
            return web.json_response({"ok": False, "error": "skills 模块未加载"}, status=500)
        sid = request.match_info.get("sid", "")
        if _bad_id(sid):
            return web.json_response({"ok": False, "error": "非法的 skill id"}, status=400)
        try:
            done, why = skills_mod.delete(sid)
        except Exception as exc:  # noqa: BLE001
            logger.exception("[WindWhisper] 删 skill 失败：%s", sid)
            return web.json_response({"ok": False, "error": str(exc)}, status=500)
        if not done:
            return web.json_response({"ok": False, "error": why}, status=400)
        return web.json_response({"ok": True, "note": why})

    @routes.post("/windwhisper/skills/{sid}/duplicate")
    async def windwhisper_skill_duplicate(request):
        if skills_mod is None:
            return web.json_response({"ok": False, "error": "skills 模块未加载"}, status=500)
        sid = request.match_info.get("sid", "")
        if _bad_id(sid):
            return web.json_response({"ok": False, "error": "非法的 skill id"}, status=400)
        body = await _body(request)
        try:
            detail, err = skills_mod.duplicate(sid, body.get("id"), body.get("name"))
        except Exception as exc:  # noqa: BLE001
            logger.exception("[WindWhisper] 复制 skill 失败：%s", sid)
            return web.json_response({"ok": False, "error": str(exc)}, status=500)
        if err:
            return web.json_response({"ok": False, "error": err}, status=400)
        return web.json_response({"ok": True, "skill": detail})

    @routes.get("/windwhisper/skills/{sid}/export")
    async def windwhisper_skill_export(request):
        """给两件事共用：

        1. 「导出」按钮 —— 拿 `text`（SKILL.md 原文，可直接搬去 WorkBuddy）
        2. 面板编辑器 —— 拿 `body`（**未剥离的正文**）+ 现有适配字段

        ⚠️ 编辑器必须用 `body`，不能用 `GET /skills/{sid}` 里的 `content`。
        后者是剥离+适配之后的注入文本，回填再保存 = 把 skill 原文改成剥离版，
        下次还会再剥一遍，内容会越编辑越少。见 skills.edit_payload 的注释。
        """
        if skills_mod is None:
            return web.json_response({"ok": False, "error": "skills 模块未加载"}, status=500)
        sid = request.match_info.get("sid", "")
        if _bad_id(sid):
            return web.json_response({"ok": False, "error": "非法的 skill id"}, status=400)
        try:
            payload, err = skills_mod.edit_payload(sid)
        except Exception as exc:  # noqa: BLE001
            logger.exception("[WindWhisper] 读 skill 原文失败：%s", sid)
            return web.json_response({"ok": False, "error": str(exc)}, status=500)
        if err:
            return web.json_response({"ok": False, "error": err}, status=404)
        payload["filename"] = sid + ".SKILL.md"
        payload["text"] = payload.get("raw") or ""
        payload["ok"] = True
        return web.json_response(payload)

    @routes.post("/windwhisper/skills/import/scan")
    async def windwhisper_skills_import_scan(request):
        """扫一个目录列出候选。**只读**，不写任何东西。"""
        if skills_mod is None:
            return web.json_response({"ok": False, "error": "skills 模块未加载"}, status=500)
        body = await _body(request)
        try:
            res, err = skills_mod.scan_dir(body.get("dir"))
        except Exception as exc:  # noqa: BLE001
            logger.exception("[WindWhisper] 扫导入目录失败")
            return web.json_response({"ok": False, "error": str(exc)}, status=500)
        if err:
            return web.json_response({"ok": False, "error": err}, status=400)
        out = {"ok": True}
        out.update(res)
        return web.json_response(out)

    @routes.post("/windwhisper/skills/import/run")
    async def windwhisper_skills_import_run(request):
        """执行导入：拷进用户 skills 目录。**永远不删源文件。**"""
        if skills_mod is None:
            return web.json_response({"ok": False, "error": "skills 模块未加载"}, status=500)
        body = await _body(request)
        try:
            res, err = skills_mod.import_from_dir(
                body.get("dir"), body.get("ids"), bool(body.get("overwrite"))
            )
        except Exception as exc:  # noqa: BLE001
            logger.exception("[WindWhisper] 导入 skill 失败")
            return web.json_response({"ok": False, "error": str(exc)}, status=500)
        if err:
            return web.json_response({"ok": False, "error": err}, status=400)
        out = {"ok": True}
        out.update(res)
        return web.json_response(out)

    # -------------------------------------------------------------- 词库

    @routes.get("/windwhisper/library")
    async def windwhisper_library_list(request):
        if _need("library"):
            return web.json_response(_MISSING, status=500)
        try:
            items, cats = library_mod.list_items(
                kw=request.query.get("kw") or "",
                cat=request.query.get("cat") or "",
                fav_only=request.query.get("fav") in ("1", "true", "yes"),
            )
        except Exception as exc:  # noqa: BLE001
            logger.exception("[WindWhisper] 读词库失败")
            return web.json_response({"ok": False, "error": str(exc)}, status=500)
        return web.json_response(
            {
                "ok": True,
                "count": len(items),
                "items": items,
                "cats": cats,
                "file": library_mod.path(),
            }
        )

    @routes.post("/windwhisper/library")
    async def windwhisper_library_save(request):
        if _need("library"):
            return web.json_response(_MISSING, status=500)
        body = await _body(request)
        try:
            item, err = library_mod.save(body)
        except Exception as exc:  # noqa: BLE001
            logger.exception("[WindWhisper] 存词库失败")
            return web.json_response({"ok": False, "error": str(exc)}, status=500)
        if err:
            return web.json_response({"ok": False, "error": err}, status=400)
        items, cats = library_mod.list_items()
        return web.json_response({"ok": True, "item": item, "cats": cats, "count": len(items)})

    @routes.delete("/windwhisper/library/{lid}")
    async def windwhisper_library_delete(request):
        if _need("library"):
            return web.json_response(_MISSING, status=500)
        lid = request.match_info.get("lid", "")
        if _bad_id(lid):
            return web.json_response({"ok": False, "error": "非法的条目 id"}, status=400)
        try:
            done, why = library_mod.delete(lid)
        except Exception as exc:  # noqa: BLE001
            logger.exception("[WindWhisper] 删词库条目失败：%s", lid)
            return web.json_response({"ok": False, "error": str(exc)}, status=500)
        if not done:
            return web.json_response({"ok": False, "error": why}, status=404)
        return web.json_response({"ok": True, "note": why, "cats": library_mod.cats()})

    @routes.get("/windwhisper/library/export")
    async def windwhisper_library_export(request):
        """导出纯文本。面板拿 Blob 落成 txt，不经手文件系统。"""
        if _need("library"):
            return web.json_response(_MISSING, status=500)
        text = library_mod.export_text()
        return web.json_response(
            {"ok": True, "filename": "windwhisper-library.txt", "text": text, "chars": len(text)}
        )


if _routes is not None:
    _register(_routes)
