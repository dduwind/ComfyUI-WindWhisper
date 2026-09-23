"""WindWhisper 的数据存储层。

所有用户数据都写在 ComfyUI 的 `user/default/WindWhisper/` 下 —— **故意不放插件目录**，
这样以后更新插件不会把你的配置、会话和 skill 覆盖掉（这个坑在别的插件上踩过太多次）。

    user/default/WindWhisper/
    ├── config.json       后端配置（地址 / Key / 模型 / 参数 / 显存策略）
    ├── chats/<id>.json   会话（消息历史 + 人设 + 参考）
    ├── library.json      提示词库（阶段 4）
    └── skills/<id>/      你自己的 skill（优先于插件内置的）

**所有写入都是原子写**（先写 `.tmp` 再 `os.replace`）。直接覆写原始文件的话，
一旦在写入中途崩了（或断电），留下的是半个 JSON —— 下次读取直接炸，
而且你的会话就永久丢了。
"""

import json
import logging
import os
import re
import threading
import time
import uuid

logger = logging.getLogger("WindWhisper")

# 脱离 ComfyUI 环境（例如单测）时 folder_paths 可能不存在，所以做兜底
try:
    import folder_paths
except Exception:  # noqa: BLE001
    folder_paths = None

_PLUGIN_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 进程内写锁：aiohttp 是多协程的，同一文件的读改写必须串行
_LOCK = threading.RLock()

# 会话 id 只允许这些字符（防目录穿越，与 routes.py 里 skill id 同一套规则）
_ID_RE = re.compile(r"^[A-Za-z0-9_.\-]+$")


# ------------------------------------------------------------------ 目录定位


def user_root():
    """用户数据根目录，顺便保证它存在。

    ComfyUI 的 `get_user_directory()` 返回 `<ComfyUI>/user`，同一份设置文件在
    `user/default/comfy.settings.json` —— 我们跟着这个约定走，用自己的子目录，
    不去动 default 下别人的东西。
    """
    if folder_paths is not None:
        try:
            base = folder_paths.get_user_directory()
            if base:
                root = os.path.join(base, "default", "WindWhisper")
                os.makedirs(root, exist_ok=True)
                return root
        except Exception as exc:  # noqa: BLE001
            logger.warning("[WindWhisper] 取 user_directory 失败，退回插件目录：%s", exc)

    # 兜底：插件目录下的 userdata/（正常情况不会走到这）
    root = os.path.join(_PLUGIN_ROOT, "userdata")
    os.makedirs(root, exist_ok=True)
    return root


def legacy_skill_dirs():
    """历史路径：早期版本把用户 skill 放在 `user/WindWhisper/skills`。

    留着一起扫，免得你按老说明放进去的文件"扫不到"却查不出原因。
    """
    out = []
    if folder_paths is None:
        return out
    try:
        base = folder_paths.get_user_directory()
    except Exception:  # noqa: BLE001
        return out
    if not base:
        return out
    old = os.path.join(base, "WindWhisper", "skills")
    if os.path.isdir(old):
        out.append(old)
    return out


def config_path():
    return os.path.join(user_root(), "config.json")


def chats_dir():
    d = os.path.join(user_root(), "chats")
    os.makedirs(d, exist_ok=True)
    return d


def chat_path(cid):
    return os.path.join(chats_dir(), "%s.json" % cid)


def library_path():
    return os.path.join(user_root(), "library.json")


def user_skills_dir():
    d = os.path.join(user_root(), "skills")
    os.makedirs(d, exist_ok=True)
    return d


def safe_id(value):
    """会话 id 白名单校验。aiohttp 会把 `%2e%2e` 解码成 `..`，所以不能只靠正则。"""
    if not value:
        return False
    if ".." in value:
        return False
    return bool(_ID_RE.match(value))


# ------------------------------------------------------------------ 原子读写


def read_json(path, default=None):
    """读 JSON。文件不存在 / 内容坏了都返回 default，并把坏文件改名留证。

    读坏文件时**不静默吞掉** —— 把 `.bad` 副本留在旁边，你可以去看看里面是不是
    还有能救的内容。
    """
    if not os.path.isfile(path):
        return default
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception as exc:  # noqa: BLE001
        logger.warning("[WindWhisper] %s 读不了（%s），已备份为 .bad", path, exc)
        try:
            os.replace(path, path + ".bad")
        except OSError:
            pass
        return default


def write_json(path, data):
    """原子写：写临时文件 → fsync → os.replace 换过去。

    同一目录下的 replace 在 Windows / POSIX 上都是原子的，
    所以读者要么看到旧内容、要么看到新内容，不会看到半个文件。
    """
    tmp = path + ".tmp"
    with _LOCK:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
            f.flush()
            try:
                os.fsync(f.fileno())
            except OSError:
                pass
        os.replace(tmp, path)
    return path


def now_ms():
    return int(time.time() * 1000)


# ------------------------------------------------------------------ 后端配置


DEFAULT_CONFIG = {
    # 服务地址。填到 /v1 为止，不要带 /chat/completions（带了我们也会帮你削掉）
    "base_url": "http://127.0.0.1:8080/v1",
    # 本地服务通常不校验 Key，留空即可 —— 留空时客户端**不发** Authorization 头
    "api_key": "",
    "model": "",
    "temperature": 0.8,
    "top_p": 0.95,
    # ⚠️ 这是**思考 + 正文共享**的总预算（llama.cpp / OpenAI 系都这么算）。
    # 推理模型开着思考时，思考先写、正文后写，思考一长就一个字正文都轮不到 ——
    # 表现是"空回答"。另外提示词类任务是**输出密集型**的（MOKEAIGC-V9 要一次给
    # 9 张图的提示词，实测正文 15025 字符 ≈ 4000+ token），给小了会被从中间截断。
    # 8192 在 32768 的上下文里留得下，别往回改小。
    "max_tokens": 8192,
    # 送多少轮上下文（一轮 = 一问一答）。本地小模型上下文有限，别开太大
    "history_rounds": 6,
    # 让不让模型先"思考"（reasoning / 思维链）。
    # **默认关**：提示词改写扩写不需要思维链，开着只是白等几十秒，
    # 而且思考会跟正文抢上面那个 max_tokens。想看得开。
    "thinking": False,
    # 发消息前怎么处理 ComfyUI 占着的显存：off / soft / full
    "vram_mode": "soft",
    # 请求超时（秒）。本地模型首 token 慢，给宽一点
    "timeout": 300,
    # 附加在环境说明之后的额外要求（你自己写的）
    "system_extra": "",
    # 输出契约开关：要求模型用 ```prompt 代码块包住最终提示词（面板靠它识别卡片）
    "card_contract": True,
}


def as_flag(value, default=False):
    """把"像真假的各种东西"整成真布尔。

    ⚠️ 不能图省事写 `bool(value)` —— 非空字符串 `"false"` / `"0"` / `"no"` 全都是 True。
    手改 `config.json` 写了个 `"thinking": "false"` 反而会**打开**思考，
    这种错还特别难查（配置看着是对的）。
    """
    if value is None:
        return default
    if isinstance(value, str):
        s = value.strip().lower()
        if s in ("", "0", "false", "no", "off", "none", "null"):
            return False
        if s in ("1", "true", "yes", "on"):
            return True
        return default          # 认不出来的字符串别瞎猜，走默认
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    return default


def load_config():
    """读配置并与默认值合并。

    合并而不是直接返回：以后新增配置项时，老 config.json 里没有的键会自动补上默认值，
    不用你手动删文件重来。
    """
    cfg = dict(DEFAULT_CONFIG)
    raw = read_json(config_path(), {})
    if isinstance(raw, dict):
        for k, v in raw.items():
            cfg[k] = v
    cfg["base_url"] = str(cfg.get("base_url") or "").strip()
    try:
        cfg["temperature"] = float(cfg.get("temperature"))
    except (TypeError, ValueError):
        cfg["temperature"] = DEFAULT_CONFIG["temperature"]
    try:
        cfg["top_p"] = float(cfg.get("top_p"))
    except (TypeError, ValueError):
        cfg["top_p"] = DEFAULT_CONFIG["top_p"]
    for k in ("max_tokens", "history_rounds", "timeout"):
        try:
            cfg[k] = int(cfg.get(k))
        except (TypeError, ValueError):
            cfg[k] = DEFAULT_CONFIG[k]
    cfg["history_rounds"] = max(0, min(40, cfg["history_rounds"]))
    cfg["max_tokens"] = max(64, min(32768, cfg["max_tokens"]))
    # 布尔项统一成真布尔：前端/手改的 "false" / 0 / "" 都得当假用
    cfg["thinking"] = as_flag(cfg.get("thinking"), DEFAULT_CONFIG["thinking"])
    if cfg.get("vram_mode") not in ("off", "soft", "full"):
        cfg["vram_mode"] = "soft"
    return cfg


def save_config(patch):
    """部分更新配置（只覆盖传进来的键），返回合并后的完整配置。"""
    cfg = load_config()
    if isinstance(patch, dict):
        for k, v in patch.items():
            if k in DEFAULT_CONFIG:
                cfg[k] = v
    # 布尔项归一化后再落盘，否则 config.json 里会留个 "false" 字符串（看着像对的，其实是坑）
    cfg["thinking"] = as_flag(cfg.get("thinking"), DEFAULT_CONFIG["thinking"])
    cfg = {k: cfg[k] for k in DEFAULT_CONFIG}
    write_json(config_path(), cfg)
    return load_config()


def public_config(cfg=None):
    """给前端用的配置。Key 原样返回 —— 本地插件，UI 用密码框遮一下就行。"""
    cfg = cfg or load_config()
    out = dict(cfg)
    out["has_key"] = bool(str(cfg.get("api_key") or "").strip())
    out["config_file"] = config_path()
    return out


# ------------------------------------------------------------------ 会话


MAX_TITLE = 40


def new_chat_id():
    return "c%s%s" % (time.strftime("%Y%m%d%H%M%S"), uuid.uuid4().hex[:4])


def blank_chat(skill_id=None):
    ts = now_ms()
    return {
        "id": new_chat_id(),
        "title": "新会话",
        "skillId": skill_id,
        "refIds": [],
        "archived": False,
        "created": ts,
        "updated": ts,
        "msgs": [],
    }


def _meta(chat):
    """列表用的轻量元数据 —— 不含 msgs，否则几十个会话要把几 MB 塞进列表接口。"""
    msgs = chat.get("msgs") or []
    last = ""
    for m in reversed(msgs):
        if m.get("role") == "assistant" and m.get("text"):
            last = m["text"]
            break
    return {
        "id": chat.get("id"),
        "title": chat.get("title") or "未命名会话",
        "skillId": chat.get("skillId"),
        "archived": bool(chat.get("archived")),
        "created": chat.get("created"),
        "updated": chat.get("updated") or chat.get("created") or 0,
        "count": len(msgs),
        "preview": re.sub(r"\s+", " ", last)[:80],
    }


def list_chats(include_archived=False):
    """会话列表，按最近更新倒序。读的是各自的小文件，单文件坏掉不影响其它。"""
    out = []
    d = chats_dir()
    try:
        names = os.listdir(d)
    except OSError:
        return out
    for name in names:
        if not name.endswith(".json"):
            continue
        cid = name[:-5]
        if not safe_id(cid):
            continue
        chat = read_json(os.path.join(d, name), None)
        if not isinstance(chat, dict):
            continue
        if chat.get("archived") and not include_archived:
            continue
        out.append(_meta(chat))
    out.sort(key=lambda m: m.get("updated") or 0, reverse=True)
    return out


def load_chat(cid):
    if not safe_id(cid):
        return None
    chat = read_json(chat_path(cid), None)
    if not isinstance(chat, dict):
        return None
    chat.setdefault("msgs", [])
    chat["id"] = cid
    return chat


def save_chat(cid, chat):
    if not safe_id(cid):
        raise ValueError("非法会话 id")
    chat = dict(chat or {})
    chat["id"] = cid
    chat["updated"] = now_ms()
    chat.setdefault("created", chat["updated"])
    msgs = chat.get("msgs")
    if not isinstance(msgs, list):
        chat["msgs"] = []
    write_json(chat_path(cid), chat)
    return chat


def delete_chat(cid):
    if not safe_id(cid):
        return False
    p = chat_path(cid)
    if not os.path.isfile(p):
        return False
    try:
        os.remove(p)
        return True
    except OSError as exc:
        logger.warning("[WindWhisper] 删会话失败 %s: %s", cid, exc)
        return False


def auto_title(text):
    """拿第一条用户消息的前 20 个字当标题。"""
    t = re.sub(r"\s+", " ", str(text or "")).strip()
    return (t[:20] + "…") if len(t) > 20 else (t or "新会话")
