"""提示词库。

存 `user/default/WindWhisper/library.json`，**一个文件装全部条目**。

为什么不像会话那样一条一个文件：会话是"越写越多、单条很大（几 MB 历史）"，
拆开才合理；词库是"条目多但每条就几百字"，拆成几百个小文件反而让列表接口
要开几百次文件。**整库读、整库写、走原子替换**更简单也更快。

代价是：库大到几十 MB 时每次保存都要整体重写。所以下面给了 `MAX_ITEMS` 和
`MAX_TEXT` 两个上限兜着 —— 正常用撞不到，撞到了说明该分库了，而不是让它慢慢变卡。

条目字段：

    id        自动生成（l + 时间戳 + 随机），前端只当不透明字符串
    name      名称
    cat       分类（单个，UI 左栏的 chips 就是所有条目的 cat 去重）
    tags      标签数组（逗号分隔输入，多维度筛）
    text      提示词正文
    skillId   从哪个 skill 产出的（可空）
    model     用的哪个模型（可空）
    fav       收藏标记
    created / updated  毫秒时间戳
"""

import logging
import re
import time
import uuid

logger = logging.getLogger("WindWhisper")

MAX_ITEMS = 5000
MAX_TEXT = 40000
MAX_NAME = 120
MAX_CAT = 40
MAX_TAGS = 24

# 允许前端改的键。别的键一律丢弃 —— 不让前端往文件里塞任意字段
WRITABLE = ("name", "cat", "tags", "text", "skillId", "model", "fav")


def _store():
    """延迟导入 store，避免包内循环导入。

    store 不 import library，所以其实可以直接 import；但延迟导入还有个好处：
    单测里可以换掉 store 的 user_root 再调本模块。
    """
    from . import store

    return store


# ------------------------------------------------------------------ 读写


def _blank_db():
    return {"version": 1, "items": []}


def load_db():
    store = _store()
    raw = store.read_json(store.library_path(), None)
    if not isinstance(raw, dict):
        return _blank_db()
    items = raw.get("items")
    if not isinstance(items, list):
        items = []
    # 只留长得像条目的，坏数据不该让整个库打不开
    clean = [it for it in items if isinstance(it, dict) and it.get("id")]
    return {"version": 1, "items": clean}


def _save_db(db):
    store = _store()
    store.write_json(store.library_path(), db)
    return db


def new_id():
    return "l%s%s" % (time.strftime("%Y%m%d%H%M%S"), uuid.uuid4().hex[:4])


# ------------------------------------------------------------------ 规范化


def norm_tags(value):
    """标签可以传数组，也可以传 'a, b, c' 这种逗号串。统一成去重后的数组。"""
    if value is None:
        return []
    if isinstance(value, str):
        parts = re.split(r"[,，;；\s]+", value)
    elif isinstance(value, (list, tuple)):
        parts = []
        for v in value:
            parts.extend(re.split(r"[,，;；]+", str(v)))
    else:
        return []

    out = []
    for p in parts:
        p = str(p).strip()
        if p and p not in out:
            out.append(p)
        if len(out) >= MAX_TAGS:
            break
    return out


def auto_name(text, fallback="未命名提示词"):
    """拿正文第一行的前 N 个字当名字。"""
    line = ""
    for raw in str(text or "").split("\n"):
        if raw.strip():
            line = raw.strip()
            break
    line = re.sub(r"\s+", " ", line)
    if not line:
        return fallback
    return (line[:24] + "…") if len(line) > 24 else line


def _apply(it, fields):
    """白名单字段写进条目。

    ⚠️ **顺序有讲究**：text 必须先落，name 才可以拿它兜底。
    反过来写的话，"只填正文不填名字"会拿到**上一次**的正文去取名字。
    """
    if "text" in fields:
        it["text"] = str(fields.get("text") or "")[:MAX_TEXT]
    if "name" in fields:
        name = re.sub(r"\s+", " ", str(fields.get("name") or "")).strip()
        it["name"] = name[:MAX_NAME] or auto_name(it.get("text"))
    if "cat" in fields:
        it["cat"] = str(fields.get("cat") or "").strip()[:MAX_CAT]
    if "tags" in fields:
        it["tags"] = norm_tags(fields.get("tags"))
    for k in ("skillId", "model"):
        if k in fields:
            v = str(fields.get(k) or "").strip()[:160]
            it[k] = v or None
    if "fav" in fields:
        it["fav"] = bool(fields.get("fav"))
    return it


def _blank_item(fields):
    now = _store().now_ms()
    it = {
        "id": new_id(),
        "name": "",
        "cat": "",
        "tags": [],
        "text": "",
        "skillId": None,
        "model": None,
        "fav": False,
        "created": now,
        "updated": now,
    }
    it = _apply(it, fields)
    if not it.get("name"):
        it["name"] = auto_name(it.get("text"))
    return it


# ------------------------------------------------------------------ 对外


def cats():
    """分类清单 —— 按"最近用过的排在前面"排，省得每次都从头翻。"""
    db = load_db()
    seen = []
    for it in sorted(db["items"], key=lambda x: x.get("updated") or 0, reverse=True):
        c = it.get("cat") or ""
        if c and c not in seen:
            seen.append(c)
    return seen


def list_items(kw="", cat="", fav_only=False):
    """列表。默认按最近更新倒序。**返回完整正文** —— 词库条目小，不值得为省几百字节再做一套详情接口。"""
    db = load_db()
    items = db["items"]

    if cat:
        items = [it for it in items if (it.get("cat") or "") == cat]
    if fav_only:
        items = [it for it in items if it.get("fav")]

    kw = str(kw or "").strip().lower()
    if kw:
        def hit(it):
            hay = " ".join(
                [
                    str(it.get("name") or ""),
                    str(it.get("cat") or ""),
                    " ".join(it.get("tags") or []),
                    str(it.get("text") or ""),
                    str(it.get("skillId") or ""),
                ]
            ).lower()
            return kw in hay

        items = [it for it in items if hit(it)]

    items = sorted(items, key=lambda x: x.get("updated") or 0, reverse=True)
    return items, cats()


def get(lid):
    for it in load_db()["items"]:
        if it.get("id") == lid:
            return it
    return None


def save(fields):
    """有 id 且找得到 → 改；否则 → 建。返回 (条目, 错误)。"""
    store = _store()
    db = load_db()
    lid = str(fields.get("id") or "").strip()

    if lid and not store.safe_id(lid):
        return None, "非法条目 id"

    if lid:
        for it in db["items"]:
            if it.get("id") == lid:
                _apply(it, fields)
                if not it.get("name"):
                    it["name"] = auto_name(it.get("text"))
                it["updated"] = store.now_ms()
                _save_db(db)
                return it, None
        # 带了 id 却找不到 —— 当成新建，沿用这个 id（前端"新建后立即保存"就是这个路径）
        if not store.safe_id(lid):
            return None, "非法条目 id"
        it = _blank_item(fields)
        it["id"] = lid
        db["items"].append(it)
        _save_db(db)
        return it, None

    if len(db["items"]) >= MAX_ITEMS:
        return None, "词库到 %d 条上限了，先清理一些" % MAX_ITEMS
    it = _blank_item(fields)
    db["items"].append(it)
    _save_db(db)
    return it, None


def delete(lid):
    """删一条。**同时把它的"收藏"一起带走** —— 没有回收站。"""
    store = _store()
    if not store.safe_id(lid):
        return False, "非法条目 id"
    db = load_db()
    before = len(db["items"])
    db["items"] = [it for it in db["items"] if it.get("id") != lid]
    if len(db["items"]) == before:
        return False, "找不到这条"
    _save_db(db)
    return True, "已删除"


def export_text(items=None):
    """导出成纯文本 —— 每段带名字和标签，方便你看也方便再导入回来。

    格式故意做得简单（名字 + 标签 + 空行 + 正文 + 分隔线），
    这样存成 txt 丢进任何地方都能读，也不会被某个工具的格式绑架。
    """
    if items is None:
        items, _ = list_items()
    blocks = []
    for it in items:
        tags = "、".join(it.get("tags") or [])
        head = it.get("name") or "未命名"
        meta = [x for x in [it.get("cat") or "", tags] if x]
        lines = ["# " + head]
        if meta:
            lines.append("标签：" + " · ".join(meta))
        lines.append("")
        lines.append(str(it.get("text") or ""))
        blocks.append("\n".join(lines))
    if not blocks:
        return ""
    stamp = time.strftime("%Y-%m-%d %H:%M")
    return "WindWhisper 提示词库 · 导出于 %s · 共 %d 条\n\n%s\n%s\n" % (
        stamp,
        len(blocks),
        ("\n" + "-" * 60 + "\n\n").join(blocks),
        "",
    )


def path():
    return _store().library_path()
