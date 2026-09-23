"""WindWhisper 的数据存储层。

所有用户数据都写在 ComfyUI 的 `user/default/WindWhisper/` 下 —— **故意不放插件目录**，
这样以后更新插件不会把你的配置、会话和 skill 覆盖掉（这个坑在别的插件上踩过太多次）。

    user/default/WindWhisper/
    ├── config.json       后端配置（地址 / Key / 模型 / 参数 / 显存策略）
    ├── chats/<id>.json   会话（消息历史 + 人设 + 参考）—— **纯文字，不含图片数据**
    ├── images/<id>/      这个会话贴过的图（反推用）。会话里只存文件名
    ├── library.json      提示词库（阶段 4）
    └── skills/<id>/      你自己的 skill（优先于插件内置的）

**所有写入都是原子写**（先写 `.tmp` 再 `os.replace`）。直接覆写原始文件的话，
一旦在写入中途崩了（或断电），留下的是半个 JSON —— 下次读取直接炸，
而且你的会话就永久丢了。
"""

import base64
import hashlib
import json
import logging
import os
import re
import shutil
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


# ------------------------------------------------------------------ 图片素材
#
# 2026-09-23 改（用户反馈"反推的图存进历史，多来几次历史不得爆炸"）。
#
# 以前反推那张图是**按 base64 原样塞在会话 json 里**的。前端已经压到最长边 1280 的
# JPEG（~160KB），base64 之后还要再涨 1/3 —— 一条消息就是 215KB 的纯文本，聊十轮
# 会话文件 2MB 起步，而且**每次切会话、每次拼 prompt 都要把这个字符串整个解析一遍**。
#
# 现在图落地成文件，会话 json 里只留一个文件名（二十来个字符）：
#
#     chats/<id>.json   {"role":"user","text":"反推","image":"img_9f2c…a41.jpg"}
#     images/<id>/img_9f2c…a41.jpg      ← 真正的字节
#
# 于是：① 会话 json 回到"纯文字"大小，聊多久都不膨胀；
#      ② 面板照样能显示那张图（走 GET /windwhisper/image 读文件）；
#      ③ 多轮还能引用同一张图（**只在拼 prompt 那一刻**才把文件读回 data URL）。
#
# 文件名用**内容的 sha1**，所以同一张图重复保存只会有一份文件，"落盘两次变两份"
# 这种坑从根上没有了。

# 素材文件名白名单。这个值会被拼进路径，`..` / 绝对路径 / 目录分隔符进来就是任意文件读，
# 所以 **必须** 卡死（跟 safe_id 一个道理：aiohttp 会把 %2e%2e 解码成 ..）。
_IMG_NAME_RE = re.compile(r"^img_[0-9a-f]{16}\.(jpg|jpeg|png|webp|gif)$")
# data URL 的 mime ↔ 扩展名。两个方向都要：写盘按 mime 定扩展名，读回来按扩展名定 mime。
_IMG_EXT = {"image/jpeg": ".jpg", "image/png": ".png",
            "image/webp": ".webp", "image/gif": ".gif"}
_IMG_MIME = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
             ".webp": "image/webp", ".gif": "image/gif"}


def images_dir(cid, create=True):
    """某个会话的图片目录。跟 chats/ 平级而不是塞进去 —— chats/ 下的东西按 *.json 遍历，
    混进去一个目录以后容易踩到"以为它是会话文件"的坑。"""
    d = os.path.join(user_root(), "images", cid)
    if create:
        os.makedirs(d, exist_ok=True)
    return d


def image_path(cid, name):
    return os.path.join(images_dir(cid), name)


def safe_image_name(name):
    """素材文件名白名单。跟 safe_id 同一套思路：正则 + 单独拦 `..` 和目录分隔符。"""
    if not name or not isinstance(name, str):
        return False
    if ".." in name or "/" in name or "\\" in name:
        return False
    return bool(_IMG_NAME_RE.match(name))


def parse_data_url(raw):
    """`data:image/jpeg;base64,<...>` → (扩展名, 原始字节)；认不出来返回 None。

    **只认 base64 的光栅图**，跟 routes._clean_image 的白名单一致。不认的返回 None，
    由调用方决定是报错还是当作没图。
    """
    if not isinstance(raw, str) or not raw.startswith("data:"):
        return None
    head, _, b64 = raw.partition(",")
    if not b64 or ";base64" not in head:
        return None
    mime = head[5:].split(";")[0].strip().lower()
    ext = _IMG_EXT.get(mime)
    if not ext:
        return None
    try:
        data = base64.b64decode(b64)
    except Exception:  # noqa: BLE001
        return None
    if not data:
        return None
    return ext, data


def save_image(cid, data_url):
    """把 data URL 落成文件，返回**文件名**；输入不合法或写盘失败返回 None。

    写失败**不抛异常**（返回 None 即可）—— 图存不下顶多是历史里少一张缩略图，
    为这个把整条消息发不出去，那是拿小问题换大问题。
    """
    if not safe_id(cid):
        return None
    parsed = parse_data_url(data_url)
    if not parsed:
        return None
    ext, data = parsed
    # 内容哈希当名字：同一张图重复保存是幂等的，不会堆出多份
    name = "img_%s%s" % (hashlib.sha1(data).hexdigest()[:16], ext)
    path = image_path(cid, name)
    if os.path.isfile(path):          # 已经存过一模一样的，直接用
        return name
    try:
        with _LOCK:
            with open(path, "wb") as f:
                f.write(data)
                f.flush()
                try:
                    os.fsync(f.fileno())
                except OSError:
                    pass
    except OSError as exc:
        logger.warning("[WindWhisper] 图片写不进 %s：%s", path, exc)
        return None
    return name


def image_data_url(cid, name):
    """素材名 → data URL（拼 prompt 用）。读不到返回 None。

    **不抛异常**是刻意的：会话里可能留着一张已经被删掉的图，抛出去整轮对话就发不出去了，
    降级成"这一轮看不到图"才是对的。
    """
    if not safe_id(cid) or not safe_image_name(name):
        return None
    try:
        with open(image_path(cid, name), "rb") as f:
            data = f.read()
    except OSError:
        return None
    if not data:
        return None
    mime = _IMG_MIME.get(os.path.splitext(name)[1].lower(), "image/jpeg")
    return "data:%s;base64,%s" % (mime, base64.b64encode(data).decode("ascii"))


def slim_msgs(cid, msgs):
    """把消息里内嵌的 data URL 换成素材文件名，返回**新列表**（不动调用方那份）。

    这是整个插件唯一的"图片入口"：`save_chat` 一定会走它，所以哪怕前端哪天又把
    data URL 传回来（比如"重发上一条"时它内存里还是原串），落盘的也只会是文件名。
    单点收口，就不用挨个改调用方、也不会漏。
    """
    out = []
    for m in msgs or []:
        if not isinstance(m, dict):
            continue
        ref = m.get("image")
        if isinstance(ref, str) and ref.startswith("data:"):
            name = save_image(cid, ref)
            m = dict(m)
            if name:
                m["image"] = name
            else:
                # 存不下宁可丢掉这张图 —— 让 base64 回落到会话 json 里才是真的灾难
                m.pop("image", None)
        out.append(m)
    return out


# 删消息之后清孤儿图（2026-09-23 加，配合"右键删除消息 + 撤销"）。
#
# 为什么**不能立刻删**：用户点删除是"直接删 + 几秒内可撤销"，
# 撤销窗口里那条消息（和它引用的图）得能原样回来。立刻删文件的话
# 撤销回来就是一张破图 —— 而且文件名是内容哈希，重发也救不回同一个名字。
#
# 所以留宽限期：只清 mtime 超过 grace 秒的孤儿。
# 撤销窗口是秒级、宽限期是分钟级，差两个数量级，撤销必然安全。
# 代价只是孤儿图多躺一会儿 —— 反正下次保存这个会话时会再扫一遍。
#
# 引用计数**现算**（扫一遍 msgs 里还活着的名字），不落盘维护计数器：
# 落盘的计数一旦和实际消息不同步，就会出现"图还在、计数说没了"这类最难查的破图。
IMAGE_GC_GRACE_SEC = 600


def gc_images(cid, msgs, grace=IMAGE_GC_GRACE_SEC):
    """清掉这个会话里已经没人引用的图，返回删掉的**文件数**。

    两个刻意的设计：
      · **永远不抛异常** —— 调用点是 save_chat，一次清理失败绝不能把
        "保存会话"本身变成失败（跟 delete_images 同一个尺度）。
      · 只认白名单内的文件名 —— 目录里混进别的东西（比如编辑器留下的临时文件）
        时，宁可不动它，也不要替用户删文件。
    """
    if not safe_id(cid):
        return 0
    d = images_dir(cid, create=False)
    if not os.path.isdir(d):
        return 0

    alive = set()
    for m in msgs or []:
        if isinstance(m, dict):
            ref = m.get("image")
            if isinstance(ref, str) and safe_image_name(ref):
                alive.add(ref)

    cutoff = time.time() - max(0, int(grace or 0))
    try:
        names = os.listdir(d)
    except OSError:
        return 0

    gone = 0
    for name in names:
        if name in alive or not safe_image_name(name):
            continue
        p = os.path.join(d, name)
        try:
            if os.path.isfile(p) and os.path.getmtime(p) < cutoff:
                os.remove(p)
                gone += 1
        except OSError:
            continue          # 单个删不掉不影响其余 —— 下次保存还会再试
    return gone


def delete_images(cid):
    """删会话时连图一起删。删不掉也不报错 —— 别为了几张图把"删会话"变成失败。"""
    if not safe_id(cid):
        return False
    d = images_dir(cid, create=False)
    if not os.path.isdir(d):
        return False
    shutil.rmtree(d, ignore_errors=True)
    return True


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
    # 格式契约开关：要求模型用 ```prompt / ```negative 围栏输出，并声明"格式主权"
    # （压过第三方 skill 自带的 output-format）。面板靠它把回复切成卡片。
    # ⚠️ 这一节**拼在 system prompt 的最后一位**，不是可有可无 —— 位置错了，
    #    18KB 的人设 skill 会把它覆盖掉，卡片和按钮一起消失（真机踩过）。
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
    # ⚠️ had_msgs 这个判断是**护栏**，不是废话：下面 GC 是按"当前 msgs 里还引用着谁"
    #    来决定删什么的，所以**只有调用方真给了消息列表**时才敢跑。
    #    否则一条"保存空白会话"的调用（msgs 缺省 → 当成 []）就会把整个会话的图
    #    当成孤儿全清掉 —— 那是最典型的"看起来无害的一行代码在删用户数据"。
    had_msgs = isinstance(msgs, list)
    if not had_msgs:
        chat["msgs"] = []
    else:
        # ⚠️ 必经之路：内嵌的 base64 在这一步被换成素材文件名（见 slim_msgs）。
        # 少了这一句，任何一处调用方把原始 data URL 传回来就会写进会话 json。
        chat["msgs"] = slim_msgs(cid, msgs)
    write_json(chat_path(cid), chat)
    # 顺手清孤儿图（宽限期内不动，理由见 gc_images）。放在写盘**之后**：
    # 会话文件先落地，清理就算出岔子也不影响这次保存的结果。
    if had_msgs:
        try:
            gc_images(cid, chat["msgs"])
        except Exception as exc:                      # noqa: BLE001 —— 见 gc_images 的注释
            logger.warning("[WindWhisper] 清理孤儿图出错（不影响保存）：%s", exc)
    return chat


def delete_chat(cid):
    if not safe_id(cid):
        return False
    p = chat_path(cid)
    if not os.path.isfile(p):
        return False
    try:
        os.remove(p)
    except OSError as exc:
        logger.warning("[WindWhisper] 删会话失败 %s: %s", cid, exc)
        return False
    # 会话没了，它名下的图就是永远扫不到的垃圾，一起清掉
    delete_images(cid)
    return True


def auto_title(text):
    """拿第一条用户消息的前 20 个字当标题。"""
    t = re.sub(r"\s+", " ", str(text or "")).strip()
    return (t[:20] + "…") if len(t) > 20 else (t or "新会话")
