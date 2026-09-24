"""Skill 扫描与装载。

目录约定 —— 与 WorkBuddy 的 skill 格式**同构**，整个目录复制进来即可用：

    skills/<id>/SKILL.md          frontmatter: name / description / ...
    skills/<id>/references/*.md   参考文件（可选）

两处都扫，**用户目录覆盖内置**：

    <插件目录>/skills/                          内置（随插件更新走）
    ComfyUI/user/default/WindWhisper/skills/    用户自己的（不会被插件更新覆盖）

适配层 `adapters/<id>.json` 声明「在 WindWhisper 里怎么用这个 skill」，
**绝不改动 skill 原文件**，所以同一个 skill 在 WorkBuddy 那边照旧：

    {
      "name":     "万能提示词生成",         显示名（覆盖 frontmatter.name）
      "desc":     "一句话简介",             列表里那句话（覆盖 frontmatter.description）
      "category": "通用",                  分类（UI 左栏）
      "icon":     "tag",                   图标 key（见面板 app.js 的 icons）
      "inject":   ["SKILL.md", "core/*.md"],   注入哪些文件，默认 ["SKILL.md"]
      "strip_sections": ["运行须知"]        按标题剥离的章节（标题**包含**该文字即命中）
      "strip_lines":    ["pip install"]     按关键词删整行（比剥章节更细的粒度）
      "_note":    "脚本章节已剥离"           UI 上展示的适配说明
    }

**两条写路径，别混**（2026-09-24 拆开）：

    save(sid, fields)               改**正文**（只允许用户目录里的 skill）+ 顺手写适配
    save_adapter_only(sid, fields)  只写适配层，**一行都不碰 SKILL.md**

第二条是**故意**对内置 skill 开放的：落点永远是用户目录的 `adapters/<id>.json`，
插件目录一个字节都不动，插件更新也冲不掉它。所以「给内置 skill 做适配」根本
不需要复制副本 —— 复制会把正文冻在复制那一天，而适配层本来就是"原文不动、只加一层"。
面板上对应的入口叫「写适配（不改 skill 原文）」。这个区别对面板那侧有个直接后果：
**改正文和改适配是两件事，保存按钮与回读内容都不同**，别做成一个按钮。

适配层也是**两层**（2026-09-22 加）：`<插件>/adapters/` 是内置的（随插件更新走，只读），
`user/default/WindWhisper/adapters/` 是你在面板里改出来的，**按 key 覆盖内置**。
这样"只改分类"不会把内置那套剥离规则一起抹掉。

面板里"改**正文**"有一条硬规则：**只有用户目录里的 skill 能改能删**。内置的正文只读，
真要改就先复制一份（否则插件一更新就白改）。
但**适配**不受这条限制 —— 它落在用户目录的 `adapters/` 里、按 id 覆盖内置，任何 skill
都能写。所以"给内置 skill 做适配"用面板上的「写适配」就行，**不需要副本**。

为什么需要 strip_sections：WorkBuddy 里的 skill 是给「能执行命令的 AI」写的，
SKILL.md 里常有 venv 路径、pip install 之类的操作说明。WindWhisper 的模型
没有工具可调，读到这些会开始说「我来运行一下脚本」并编造结果。
"""

import glob
import json
import logging
import os
import re
import shutil

logger = logging.getLogger("WindWhisper")

PLUGIN_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUILTIN_DIR = os.path.join(PLUGIN_ROOT, "skills")
ADAPTER_DIR = os.path.join(PLUGIN_ROOT, "adapters")

# 列表接口只需要 frontmatter，别把几 MB 的 SKILL.md 整个读进来
FRONTMATTER_PROBE = 8192


# ------------------------------------------------------------------ 目录定位


def user_dir():
    """ComfyUI/user/default/WindWhisper/skills —— 取不到就返回 None。

    路径统一从 store.user_root() 派生，跟 config.json / chats/ 同一个根。
    **不要在这里另写一套 os.path.join** —— 一旦两处不一致，就会出现
    "配置写在 A、skill 扫的是 B" 这种极难查的问题。
    """
    try:
        from . import store

        return store.user_skills_dir()
    except Exception:  # noqa: BLE001
        pass

    try:
        import folder_paths

        base = folder_paths.get_user_directory()
    except Exception:
        return None
    if not base:
        return None
    return os.path.join(base, "default", "WindWhisper", "skills")


def search_dirs():
    """返回 [(路径, 来源标签)]，顺序 = 优先级从低到高（后面的覆盖前面的）。

    含历史路径 `user/WindWhisper/skills`（早期版本用的是这个），
    一起扫是为了让你按老说明放进去的文件不会"莫名扫不到"。
    """
    out = [("builtin", BUILTIN_DIR)]
    try:
        from . import store

        for d in store.legacy_skill_dirs():
            out.append(("user", d))
    except Exception:  # noqa: BLE001
        pass
    u = user_dir()
    if u:
        out.append(("user", u))
    return out


# ------------------------------------------------------------------ frontmatter

_KEY_RE = re.compile(r"^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$")


def parse_frontmatter(text):
    """手写极简 YAML 解析，只处理 skill 里实际会出现的写法。

    支持：`key: value`、`key: "quoted"`、`key: >` 折叠块、`key:` + `- item` 列表。
    不支持嵌套／锚点 —— 那些 skill 里没人用，没必要为它拉一个 pyyaml 依赖进来。

    返回 (dict, body)：body 是去掉 frontmatter 之后的正文。
    """
    if not text.lstrip().startswith("---"):
        return {}, text

    start = text.index("---") + 3
    end = text.find("\n---", start)
    if end < 0:
        return {}, text

    head = text[start:end]
    body = text[end + 4:].lstrip("\n")

    data = {}
    cur = None
    mode = None  # None | "fold" | "list"

    for raw in head.split("\n"):
        if not raw.strip():
            continue
        indented = raw[0] in (" ", "\t")
        line = raw.strip()

        if indented and cur:
            if mode == "list" and line.startswith("- "):
                data[cur].append(line[2:].strip().strip("\"'"))
            elif mode == "fold":
                data[cur] = (data[cur] + " " + line).strip()
            continue

        m = _KEY_RE.match(line)
        if not m:
            continue
        key, val = m.group(1), m.group(2).strip()
        cur = key
        if val in (">", "|", ">-", "|-", ">+", "|+"):
            data[key] = ""
            mode = "fold"
        elif val == "":
            data[key] = []
            mode = "list"
        else:
            data[key] = val.strip("\"'")
            mode = None

    return data, body


# ------------------------------------------------------------------ 适配层


def user_adapter_dir():
    """`user/default/WindWhisper/adapters/` —— 用户在面板里改出来的适配信息。

    为什么要分两处：插件目录里的 `adapters/` 是**随插件更新走的**，往里写东西
    下次更新就没了。所以内置 skill 的适配留在插件里（只读），用户在面板里
    编辑/新建的写这里，**用户覆盖内置**。

    取不到就返回 None（脱离 ComfyUI 单测时），调用方按"没有用户适配"处理。
    """
    try:
        from . import store

        d = os.path.join(store.user_root(), "adapters")
        os.makedirs(d, exist_ok=True)
        return d
    except Exception:  # noqa: BLE001
        return None


def _read_adapter_file(path):
    if not path or not os.path.isfile(path):
        return {}
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except Exception as exc:  # noqa: BLE001
        logger.warning("[WindWhisper] 适配文件读不了 %s: %s", path, exc)
        return {}


def load_adapter(sid):
    """读适配层。**两层叠加：插件内置 → 用户覆盖**。

    用户那份只写自己改过的键就行，没写的继续用内置的 —— 这样
    「只改了分类」不会把内置的 strip_sections 一起抹掉。
    """
    data = dict(_read_adapter_file(os.path.join(ADAPTER_DIR, sid + ".json")))
    u = user_adapter_dir()
    if u:
        data.update(_read_adapter_file(os.path.join(u, sid + ".json")))
    return data


def save_adapter(sid, patch):
    """把适配信息写进**用户目录**（不碰插件目录里的内置适配）。

    patch 里值为 None / "" 的键会被删掉，表示"这条不留覆盖、跟内置走"。
    """
    u = user_adapter_dir()
    if not u:
        return None
    path = os.path.join(u, sid + ".json")
    cur = _read_adapter_file(path)
    for k, v in (patch or {}).items():
        if v in (None, "", [], {}):
            cur.pop(k, None)
        else:
            cur[k] = v
    if not cur:
        # 一条覆盖都不留了 —— 把文件删掉，回到"纯内置"状态
        if os.path.isfile(path):
            try:
                os.remove(path)
            except OSError:
                pass
        return None
    with open(path, "w", encoding="utf-8") as f:
        json.dump(cur, f, ensure_ascii=False, indent=2)
    return path


# ------------------------------------------------------------------ 章节剥离


def strip_sections(text, titles):
    """按标题剥离章节：命中标题后，一直删到下一个同级或更高级标题。

    返回 (新文本, 被删掉的标题列表)。titles 为空则原样返回。

    ⚠️ 必须整块放行围栏代码块 —— 代码块里的 bash 注释（`# Windows（Git Bash 路径写法）`）
    长得跟一级标题一模一样，不排除掉的话会被当成"更高级标题"，
    导致跳过区间提前结束、整段该剥的内容反而留下来。
    """
    if not titles:
        return text, []

    out, removed = [], []
    skipping_at = 0  # 0 = 不在跳过区间；否则记录被跳过标题的层级
    in_fence = False
    fence_mark = ""

    for line in text.split("\n"):
        stripped = line.strip()

        if stripped.startswith("```") or stripped.startswith("~~~"):
            mark = stripped[:3]
            if not in_fence:
                in_fence, fence_mark = True, mark
            elif mark == fence_mark:
                in_fence, fence_mark = False, ""
            if not skipping_at:
                out.append(line)
            continue

        if in_fence:
            if not skipping_at:
                out.append(line)
            continue

        m = re.match(r"^(#{1,6})\s+(.*?)\s*$", line)
        if m:
            level, title = len(m.group(1)), m.group(2)
            if skipping_at and level <= skipping_at:
                skipping_at = 0  # 同级/更高级标题 → 跳过区间结束
            if not skipping_at:
                hit = next((t for t in titles if t and t in title), None)
                if hit:
                    skipping_at = level
                    removed.append(title)
                    continue  # 标题本身也不保留
                out.append(line)
            continue

        if not skipping_at:
            out.append(line)

    cleaned = re.sub(r"\n{3,}", "\n\n", "\n".join(out)).strip() + "\n"
    return cleaned, removed


def strip_lines(text, keywords):
    """按关键词删**整行**。返回 (新文本, 删掉的行数)。

    为什么需要比「剥章节」更细的粒度：skill 里常有一张表把两类东西混在一起——
    「Python 依赖缺失 → 用 venv 解释器」是纯操作说明，该删；
    「东亚人+蓝眼睛 → 自动修正为棕色眼睛」是语义规则，必须留。
    整节剥会连带删掉后者，所以只能细到行。
    """
    if not keywords:
        return text, 0
    kept, dropped = [], 0
    for line in text.split("\n"):
        if any(k and k in line for k in keywords):
            dropped += 1
            continue
        kept.append(line)
    return "\n".join(kept), dropped


# ------------------------------------------------------------------ 扫描


def _walk_stats(skill_path):
    files = nbytes = 0
    for root, dirs, names in os.walk(skill_path):
        dirs[:] = [d for d in dirs if d != "__pycache__"]
        for n in names:
            files += 1
            try:
                nbytes += os.path.getsize(os.path.join(root, n))
            except OSError:
                pass
    return files, nbytes


def _list_refs(skill_path):
    """references/ 下的文件清单，供 UI 展示「参考 N 个」。"""
    refs = []
    for rel_root in ("references", "reference", "assets"):
        base = os.path.join(skill_path, rel_root)
        if not os.path.isdir(base):
            continue
        for root, dirs, names in os.walk(base):
            dirs[:] = [d for d in dirs if d != "__pycache__"]
            for n in sorted(names):
                full = os.path.join(root, n)
                try:
                    size = os.path.getsize(full)
                except OSError:
                    size = 0
                refs.append(
                    {
                        "path": os.path.relpath(full, skill_path).replace("\\", "/"),
                        "bytes": size,
                    }
                )
    return refs


def _describe(skill_path, sid, source):
    skill_md = os.path.join(skill_path, "SKILL.md")
    try:
        with open(skill_md, encoding="utf-8", errors="replace") as f:
            probe = f.read(FRONTMATTER_PROBE)
    except OSError as exc:
        logger.warning("[WindWhisper] SKILL.md 读不了 %s: %s", skill_md, exc)
        return None

    fm, _ = parse_frontmatter(probe)
    adapter = load_adapter(sid)

    desc = str(adapter.get("desc") or fm.get("description") or "").strip()
    desc = re.sub(r"\s+", " ", desc)
    files, nbytes = _walk_stats(skill_path)

    # 目录本身就说明了一切：只有落在**用户目录**里的才能改/删。
    # 内置的（含历史遗留目录）一律只读 —— 改了下次更新插件就白改。
    ud = user_dir()
    editable = bool(ud) and os.path.abspath(skill_path).startswith(os.path.abspath(ud) + os.sep)

    return {
        "id": sid,
        "name": str(adapter.get("name") or fm.get("name") or sid),
        "desc": desc[:200],
        "hit": str(fm.get("description") or "").strip()[:400],
        # 分类 / 图标：适配层优先，其次 frontmatter（用户自建的 skill 没有适配层），最后兜底
        "category": str(adapter.get("category") or fm.get("category") or "未分类"),
        "icon": str(adapter.get("icon") or fm.get("icon") or "tag"),
        # 图片处理模式：ignore（默认，不吃图）/ reverse（反推）/ reference（交给 skill 参考）。
        # 决定前端拖图弹窗的默认预选；适配层覆盖优先于 frontmatter。
        "image_mode": str(adapter.get("image_mode") or fm.get("image_mode") or "ignore"),
        # 启用 / 禁用：默认启用；禁用后前端灰掉且不可选为人设 / 参考。
        "enabled": bool(adapter["enabled"]) if adapter.get("enabled") is not None else True,
        "files": files,
        "bytes": nbytes,
        "refs": _list_refs(skill_path),
        "adapted": bool(adapter),
        "source": source,
        "editable": editable,
        "path": skill_path,
    }


def scan():
    """扫出所有 skill，用户目录覆盖同名内置。返回按名称排序的列表。"""
    found = {}
    for source, base in search_dirs():
        if not base or not os.path.isdir(base):
            continue
        for name in sorted(os.listdir(base)):
            p = os.path.join(base, name)
            if not os.path.isdir(p) or not os.path.isfile(os.path.join(p, "SKILL.md")):
                continue
            info = _describe(p, name, source)
            if info:
                found[name] = info
    return [found[k] for k in sorted(found)]


def find(sid):
    """按 id 定位 skill 目录；用户目录优先。"""
    for source, base in reversed(search_dirs()):
        if not base:
            continue
        p = os.path.join(base, sid)
        if os.path.isdir(p) and os.path.isfile(os.path.join(p, "SKILL.md")):
            return p, source
    return None, None


# ------------------------------------------------------------------ 详情


def load(sid):
    """读单个 skill 的详情。

    content 是**适配后的实际注入文本**（已经过 strip_sections），
    所以 UI 上看到什么，模型收到的就是什么。
    """
    skill_path, source = find(sid)
    if not skill_path:
        return None

    base = _describe(skill_path, sid, source)
    if not base:
        return None

    adapter = load_adapter(sid)
    inject = adapter.get("inject") or ["SKILL.md"]
    strip = adapter.get("strip_sections") or []
    drop_lines = adapter.get("strip_lines") or []

    parts, used_files, removed = [], [], []
    dropped_lines = 0
    for pattern in inject:
        # 统一用正斜杠 + recursive，这样 "skill/core/*.md" / "routes/**/*.md" 都能用；
        # 纯 glob 不递归，而多层级 skill（如 female-portrait-director）内容都埋在子目录里。
        full_pattern = skill_path.replace("\\", "/") + "/" + pattern
        for full in sorted(glob.glob(full_pattern, recursive=True)):
            if not os.path.isfile(full):
                continue
            rel = os.path.relpath(full, skill_path).replace("\\", "/")
            try:
                with open(full, encoding="utf-8", errors="replace") as f:
                    raw = f.read()
            except OSError as exc:
                logger.warning("[WindWhisper] 注入文件读不了 %s: %s", full, exc)
                continue
            # frontmatter 是给机器读的元数据（name / description / agent_created…），
            # 注入时只取正文，否则白占几百 token 还容易干扰模型。
            body = parse_frontmatter(raw)[1]
            text, gone = strip_sections(body, strip)
            text, n_drop = strip_lines(text, drop_lines)
            removed.extend(gone)
            dropped_lines += n_drop
            used_files.append(rel)
            parts.append(text)

    content = "\n\n".join(parts).strip()
    raw_bytes = sum(len(p.encode("utf-8")) for p in parts)

    base.update(
        {
            "adapter_note": str(adapter.get("_note") or ""),
            "content": content,
            "inject": inject,
            "used_files": used_files,
            "stripped": sorted(set(removed)),
            "dropped_lines": dropped_lines,
            "chars": len(content),
            "lines": content.count("\n") + 1,
            "raw_bytes": raw_bytes,
            "inject_bytes": len(content.encode("utf-8")),
        }
    )
    return base


# ================================================================== 面板内增删改
#
# 一条铁律：**只有落在用户目录里的 skill 能改能删**（说的是**正文**）。
# 内置的（随插件更新走的）正文一律只读 —— 想改就先复制一份。
# 否则你辛苦改的东西会被下一次插件更新原样覆盖掉，而且极难反应过来是为什么。
#
# ⚠️ 但**适配层**是另一条边界：save_adapter_only() 对**任何** skill 开放，
# 因为它只写 user/default/WindWhisper/adapters/<id>.json，碰不到插件目录。
# 两条边界别混 —— 混成一个的结果必然是"要么不能适配、要么能悄悄改正文"。

# 面板里可选的图标 key（必须和 app.js 的 icons 表对上）
ICON_KEYS = ("tag", "brush", "camera", "film", "play", "box", "user")

# 单个 skill 的导入体积上限。挡住"手滑选了个盘符根目录"这种情况。
MAX_IMPORT_BYTES = 200 * 1024 * 1024

_IMPORT_IGNORE = ("__pycache__", ".git", "node_modules")


def _valid_new_id(sid):
    """新建/导入用的 id 校验：白名单字符 + 不是保留名。"""
    if not sid or len(sid) > 64:
        return False
    if ".." in sid or sid in (".", ".."):
        return False
    return bool(re.match(r"^[A-Za-z0-9_][A-Za-z0-9_.\-]*$", sid))


def suggest_id(name):
    """从名字猜一个 id。中文名猜不出来就返回空串，由调用方兜底。"""
    s = re.sub(r"[^A-Za-z0-9]+", "-", str(name or "")).strip("-").lower()
    s = re.sub(r"-{2,}", "-", s)
    return s[:48].strip("-")


def _unique_id(base):
    """base 被占了就 -2 / -3 往后排。"""
    base = base or "skill"
    if find(base)[0] is None:
        return base
    for i in range(2, 100):
        cand = "%s-%d" % (base, i)
        if find(cand)[0] is None:
            return cand
    return "%s-%s" % (base, os.urandom(3).hex())


def _yaml_scalar(v):
    """把值安全地塞进 `key: value`。

    含 `:` `#` 引号、或者首尾有空格时套双引号并转义。不转义的话
    `description: 人像: 半身` 会让解析器在冒号处截断 —— 手写 YAML 最常踩的坑。
    """
    s = str(v if v is not None else "").replace("\r\n", " ").replace("\n", " ")
    if s == "" or s != s.strip() or re.search(r"[:#\[\]{}&*!|>'\"%@`]", s):
        return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'
    return s


def _compose_md(name, desc, body, extra_fm=None):
    """拼出 SKILL.md：frontmatter + 正文。

    frontmatter 里同时写 name / description，是为了**跟 WorkBuddy 同构** ——
    在 WindWhisper 里建的 skill 直接拷回 `~/.workbuddy/skills/` 也能用。
    """
    keys = []
    if extra_fm:
        for k, v in extra_fm.items():
            if k not in ("name", "description") and v not in (None, ""):
                keys.append((k, v))
    head = ["---", "name: " + _yaml_scalar(name), "description: " + _yaml_scalar(desc)]
    head += ["%s: %s" % (k, _yaml_scalar(v)) for k, v in keys]
    head += ["---", ""]
    return "\n".join(head) + (str(body or "").rstrip() + "\n")


def _compose_inject(extra):
    """默认注入 SKILL.md，用户加的额外 glob 追加在后（去重、丢空）。"""
    out = ["SKILL.md"]
    for p in extra or []:
        p = str(p or "").strip().replace("\\", "/")
        if p and p not in out:
            out.append(p)
    return out


def _clean_list(value):
    """把面板传来的多行文本 / 数组统一成干净的去重列表。空 → []。

    textarea 是换行分隔、接口也可能直接给数组，两种都收；
    顺手做**大小写无关**的去重（"Pip Install" 和 "pip install" 是同一条规则）。
    """
    if isinstance(value, str):
        items = value.split("\n")
    elif isinstance(value, (list, tuple)):
        items = list(value)
    else:
        items = []
    out, seen = [], set()
    for it in items:
        s = str(it or "").strip()
        k = s.lower()
        if s and k not in seen:
            seen.add(k)
            out.append(s)
    return out


def _adapter_patch(fields, text_keys=False):
    """把面板传来的字段翻译成适配层 patch。没填的键不写，保持跟内置一致。

    ⚠️ 值为 None / "" / [] 的键在 `save_adapter` 里会被**删掉**，语义是
    "这条不留覆盖、跟正文或内置走"。所以**清空输入框再保存 = 撤掉那条覆盖**，
    不需要另做一个「删适配」按钮。

    text_keys：是否允许把**显示名 / 描述**写进适配层。默认 False —— 普通保存走
    `save()`，这两个值属于正文 frontmatter，让正文当唯一来源，免得出现
    "改了名字却没变"（适配层优先级更高）。只有"只写适配"那条路径
    （`save_adapter_only`）才打开它，因为那时正文是只读的。
    """
    patch = {}
    if text_keys:
        if "name" in fields:
            patch["name"] = str(fields.get("name") or "").strip()
        if "desc" in fields:
            patch["desc"] = str(fields.get("desc") or "").strip()
    if "category" in fields:
        patch["category"] = str(fields.get("category") or "").strip()
    if "icon" in fields:
        ic = str(fields.get("icon") or "").strip()
        patch["icon"] = ic if ic in ICON_KEYS else ""
    if "note" in fields:
        patch["_note"] = str(fields.get("note") or "").strip()
    if "inject_extra" in fields:
        inj = _compose_inject(fields.get("inject_extra"))
        patch["inject"] = inj if inj != ["SKILL.md"] else None
    if "strip_sections" in fields:
        patch["strip_sections"] = _clean_list(fields.get("strip_sections")) or None
    if "strip_lines" in fields:
        patch["strip_lines"] = _clean_list(fields.get("strip_lines")) or None
    # 启用/禁用开关：只写适配层的 enabled 字段，不碰 SKILL.md（零副本）。
    # 注意：空串 / None 表示「撤掉覆盖」（回到默认启用），不能写成 False 留脏键；
    # 只有真正的布尔值才写入（False = 禁用，True = 启用）。
    if "enabled" in fields:
        ev = fields.get("enabled")
        patch["enabled"] = None if ev in (None, "") else bool(ev)
    # 图片处理模式：ignore（默认不收图）/ reverse（反推成提示词）/ reference（交给 skill 多模态参考）。
    # 非法值一律变 None = 撤掉覆盖，回到默认 ignore，避免脏数据卡死。
    if "image_mode" in fields:
        m = str(fields.get("image_mode") or "").strip().lower()
        patch["image_mode"] = m if m in ("ignore", "reverse", "reference") else None
    return patch


def save_adapter_only(sid, fields):
    """**只写适配层**，一行都不碰 SKILL.md。返回 (结果, 错误)。

    与 `save()` 的权限边界不同，这里是**故意**对内置 skill 开放的：
    落点永远是 `user/default/WindWhisper/adapters/<id>.json`，而 `load_adapter`
    是「内置 → 用户覆盖」两层叠 —— 写一份以**内置 id** 命名的用户适配，不改
    插件目录的任何东西，插件更新也冲不掉它。

    这正是适配层的设计初衷（见模块顶部："绝不改动 skill 原文件"），也是
    "给内置 skill 做适配不用复制副本"的依据。复制副本会把正文冻在复制那天。

    ⚠️ 这里**不许**出现任何写 SKILL.md 的动作。静态检查里有一条断言专门钉它，
    因为这条路径一旦写正文，就等于给"内置只读"开了个后门。
    """
    if not _valid_new_id(sid):
        return None, "非法 id"
    src, _source = find(sid)
    if not src:
        return None, "找不到这个 skill"

    patch = _adapter_patch(fields, text_keys=True)
    if not patch:
        # 一个可改的键都没传 —— 什么都不写，直接回读现状（不做无意义的落盘）
        return load(sid), None

    save_adapter(sid, patch)
    return load(sid), None


def create(fields):
    """在用户目录里新建一个 skill。返回 (结果 dict, 错误字符串)。"""
    ud = user_dir()
    if not ud:
        return None, "拿不到用户目录，没法写入"

    name = str(fields.get("name") or "").strip()
    if not name:
        return None, "名字不能空"

    sid = str(fields.get("id") or "").strip() or suggest_id(name)
    if not _valid_new_id(sid):
        return None, "id 只能用字母数字和 _ . -，且不能以 . 或 - 开头"
    if find(sid)[0] is not None:
        return None, "已经有个叫 %s 的 skill 了，换个 id 或者直接改它" % sid

    body = str(fields.get("content") or "")
    desc = str(fields.get("desc") or "").strip()

    dest = os.path.join(ud, sid)
    try:
        os.makedirs(dest, exist_ok=True)
        with open(os.path.join(dest, "SKILL.md"), "w", encoding="utf-8") as f:
            f.write(_compose_md(name, desc, body))
    except OSError as exc:
        return None, "写文件失败：%s" % exc

    patch = _adapter_patch(fields)
    if patch:
        save_adapter(sid, patch)
    return load(sid), None


def save(sid, fields):
    """改一个**用户目录里的** skill。返回 (结果, 错误)。

    正文会被整体替换（那正是"编辑"的意思）；但 frontmatter 里我们不认识的键
    （version / license / 作者自己加的）会**原样保留** —— 不该因为改一次正文就丢元数据。
    """
    if not _valid_new_id(sid):
        return None, "非法 id"
    ud = user_dir()
    if not ud:
        return None, "拿不到用户目录"
    dest = os.path.join(ud, sid)
    if not os.path.isfile(os.path.join(dest, "SKILL.md")):
        return None, ("只能改「我的」skill 的正文。这个是插件内置的 —— 想改它在风语里怎么用，"
                      "请用「写适配」（不动原文）；真要改正文，先「复制一份来改正文」")

    md_path = os.path.join(dest, "SKILL.md")
    try:
        with open(md_path, encoding="utf-8", errors="replace") as f:
            raw = f.read()
    except OSError as exc:
        return None, "读原文件失败：%s" % exc

    old_fm, old_body = parse_frontmatter(raw)
    name = str(fields.get("name") or old_fm.get("name") or sid).strip()
    desc = fields.get("desc")
    if desc is None:
        desc = old_fm.get("description") or ""
    body = fields.get("content")
    if body is None:
        body = old_body

    try:
        with open(md_path, "w", encoding="utf-8") as f:
            f.write(_compose_md(name, desc, body, extra_fm=old_fm))
    except OSError as exc:
        return None, "写文件失败：%s" % exc

    # 正文刚被改写（包含 name / desc），而适配层那两个键**优先级更高** ——
    # 不清掉的话会出现"改了自己的 skill 名字、列表里还是老名字"这种要查半天的怪事。
    # 用户目录的 skill 一律以正文为准，所以这里显式撤掉适配层的 name / desc 覆盖。
    patch = _adapter_patch(fields)
    patch["name"] = None
    patch["desc"] = None
    if patch:
        save_adapter(sid, patch)
    return load(sid), None


def delete(sid):
    """删一个**用户目录里的** skill（连它的用户适配一起删）。返回 (成功, 说明)。"""
    if not _valid_new_id(sid):
        return False, "非法 id"
    ud = user_dir()
    if not ud:
        return False, "拿不到用户目录"
    dest = os.path.join(ud, sid)
    if not os.path.isdir(dest):
        return False, "只能删「我的」skill —— 内置的删不掉（删了插件更新会回来，没意义）"
    try:
        shutil.rmtree(dest)
    except OSError as exc:
        return False, "删除失败：%s" % exc

    ua = user_adapter_dir()
    if ua:
        ap = os.path.join(ua, sid + ".json")
        if os.path.isfile(ap):
            try:
                os.remove(ap)
            except OSError:
                pass
    return True, "已删除"


def duplicate(sid, new_id=None, new_name=None):
    """把任意 skill 复制一份到用户目录。返回 (结果, 错误)。

    这是改内置 skill **正文**的唯一路径（平时用不上 —— 只是想换个显示名 / 分类 /
    剥掉几节命令说明的话，用「写适配」就够了，那个不动原文、也跟得上插件更新）。
    注意副本的正文会**冻在复制那一天**，上游以后改了不会跟过来。
    复制时会把**已经解析好的适配**（分类 / 图标 / 剥离规则 / 注入清单）
    一并写到副本的用户适配里，否则副本会丢掉分类和剥离规则、行为跟原件不一样。
    """
    src, source = find(sid)
    if not src:
        return None, "找不到这个 skill"
    ud = user_dir()
    if not ud:
        return None, "拿不到用户目录"

    base = str(new_id or "").strip() or (sid + "-copy")
    if not _valid_new_id(base):
        return None, "id 只能用字母数字和 _ . -"
    dest_id = _unique_id(base)

    src_adapter = load_adapter(sid)
    display = str(new_name or "").strip()
    if not display:
        old = str(src_adapter.get("name") or sid)
        display = old + " 副本"

    dest = os.path.join(ud, dest_id)
    if os.path.exists(dest):
        return None, "目标目录已存在：%s" % dest_id
    try:
        shutil.copytree(src, dest, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    except OSError as exc:
        return None, "复制失败：%s" % exc

    # 让副本的 frontmatter 名字也跟着变，不然列表里两个一模一样的名字分不清
    md = os.path.join(dest, "SKILL.md")
    try:
        with open(md, encoding="utf-8", errors="replace") as f:
            raw = f.read()
        fm, body = parse_frontmatter(raw)
        with open(md, "w", encoding="utf-8") as f:
            f.write(_compose_md(display, fm.get("description") or "", body, extra_fm=fm))
    except OSError:
        pass

    patch = {"name": display}
    for k in ("category", "icon", "inject", "strip_sections", "strip_lines", "_note"):
        if src_adapter.get(k):
            patch[k] = src_adapter[k]
    save_adapter(dest_id, patch)

    return load(dest_id), None


def export_text(sid):
    """导出用：返回 SKILL.md 原文（未经过任何剥离，方便搬去 WorkBuddy）。"""
    src, _ = find(sid)
    if not src:
        return None, "找不到这个 skill"
    p = os.path.join(src, "SKILL.md")
    try:
        with open(p, encoding="utf-8", errors="replace") as f:
            return f.read(), None
    except OSError as exc:
        return None, "读文件失败：%s" % exc


def edit_payload(sid):
    """面板编辑器要的东西：**未经剥离的 SKILL.md 正文** + 现有适配信息。

    ⚠️ 这里必须给原文，不能复用 `load()` 的 content。`load()` 返回的是
    "剥离章节 + 删命令行"之后的**注入文本**。拿它回填编辑器，用户一保存，
    SKILL.md 就被写成了剥离版；而适配规则下次还会再剥一遍 ——
    **内容会每编辑一次少一截，且不可逆**。这是这套适配层最危险的一个坑，
    所以专门开这个函数，并且注释写死。

    面板两个入口都吃这一份 payload，靠前端决定正文框是否可写：

        「编辑」        → 保存走 save()（写正文 + 适配）
        「写适配」      → 保存走 save_adapter_only()（正文只读，只写适配层）
    """
    src, source = find(sid)
    if not src:
        return None, "找不到这个 skill"
    md = os.path.join(src, "SKILL.md")
    try:
        with open(md, encoding="utf-8", errors="replace") as f:
            raw = f.read()
    except OSError as exc:
        return None, "读文件失败：%s" % exc

    fm, body = parse_frontmatter(raw)
    adapter = load_adapter(sid)

    ud = user_dir()
    editable = bool(ud) and os.path.abspath(src).startswith(os.path.abspath(ud) + os.sep)
    inject = adapter.get("inject") or ["SKILL.md"]

    return {
        "id": sid,
        "name": str(adapter.get("name") or fm.get("name") or sid),
        # desc 必须**适配层优先**，跟 _describe() 一个口径。只读 frontmatter 的话，
        # 适配层改过描述时编辑器会回填出旧值，一保存就把"只写适配"改的那句话冲掉。
        "desc": re.sub(r"\s+", " ", str(adapter.get("desc") or fm.get("description") or "")).strip(),
        "category": str(adapter.get("category") or fm.get("category") or ""),
        "icon": str(adapter.get("icon") or fm.get("icon") or "tag"),
        "image_mode": str(adapter.get("image_mode") or fm.get("image_mode") or "ignore"),
        "enabled": bool(adapter.get("enabled")) if adapter.get("enabled") is not None else True,
        "note": str(adapter.get("_note") or ""),
        "inject_extra": [p for p in inject if p != "SKILL.md"],
        # 剥离规则要回填，否则编辑器里那两格永远是空的 —— 用户一保存就把
        # 手写的（或上一次填的）规则悄悄抹掉，而且看不出来。
        "strip_sections": list(adapter.get("strip_sections") or []),
        "strip_lines": list(adapter.get("strip_lines") or []),
        "adapted": bool(adapter),
        "body": body,
        "raw": raw,
        "editable": editable,
        "source": source,
    }, None


# ------------------------------------------------------------------ 目录导入


def _dir_stats(path):
    n = size = 0
    for root, dirs, names in os.walk(path):
        dirs[:] = [d for d in dirs if d not in _IMPORT_IGNORE]
        for name in names:
            n += 1
            try:
                size += os.path.getsize(os.path.join(root, name))
            except OSError:
                pass
    return n, size


def scan_dir(path):
    """扫一个目录，列出里面能导入的 skill 候选。返回 (结果 dict, 错误)。

    支持两种放法：
      - 传进来的目录**本身就是** skill（里面直接有 SKILL.md）
      - 传进来的是**父目录**，每个子目录是一个 skill（WorkBuddy 的 `skills/` 就是这样）

    ⚠️ 这个接口会读你机器上任意目录，但**只读**，而且只认带 SKILL.md 的目录。
    真正落盘要再调一次 `import_from_dir`，导入目标是固定的用户 skills 目录。
    """
    if not path or not str(path).strip():
        return None, "路径不能空"
    raw = str(path).strip().strip('"')
    if "\x00" in raw:
        return None, "路径里有非法字符"
    if not os.path.isabs(raw):
        return None, "要填绝对路径，比如 C:\\Users\\你\\.workbuddy\\skills"

    real = os.path.realpath(raw)
    if not os.path.isdir(real):
        return None, "这个目录不存在：%s" % raw

    # 情况 A：目录自己就是 skill
    if os.path.isfile(os.path.join(real, "SKILL.md")):
        candidates = [(os.path.basename(real), real)]
    else:
        candidates = []
        try:
            names = sorted(os.listdir(real))
        except OSError as exc:
            return None, "读不了这个目录：%s" % exc
        for n in names:
            p = os.path.join(real, n)
            if os.path.isdir(p) and os.path.isfile(os.path.join(p, "SKILL.md")):
                candidates.append((n, p))

    items = []
    for cid, cpath in candidates:
        try:
            with open(os.path.join(cpath, "SKILL.md"), encoding="utf-8", errors="replace") as f:
                probe = f.read(FRONTMATTER_PROBE)
        except OSError:
            continue
        fm, _ = parse_frontmatter(probe)
        n, size = _dir_stats(cpath)
        exist_path, exist_source = find(cid)
        items.append(
            {
                "id": cid,
                "name": str(fm.get("name") or cid),
                "desc": re.sub(r"\s+", " ", str(fm.get("description") or ""))[:160],
                "files": n,
                "bytes": size,
                # 已经存在的话，说清是"内置的（导入会变成你的覆盖版）"还是"我的（会覆盖）"
                "exists": bool(exist_path),
                "exists_source": exist_source,
            }
        )

    return {
        "path": real,
        "count": len(items),
        "items": items,
        "user_dir": user_dir(),
    }, None


def import_from_dir(path, ids, overwrite=False):
    """把 `path` 下的若干 skill 目录拷进用户 skills 目录。返回 (结果, 错误)。

    安全约束（这个接口能读写本机文件，必须自己守住）：
      1. 只拷**直接子目录**，且该子目录里必须有 SKILL.md
      2. 用 realpath 做前缀校验，`../` 之类穿不出去
      3. 目标固定是用户 skills 目录，不允许拷到别处
      4. 不允许把目录拷进它自己的子孙里（否则会无限递归）
      5. 不删任何源文件，永远是"拷一份出来"
    """
    ud = user_dir()
    if not ud:
        return None, "拿不到用户目录"

    real = os.path.realpath(str(path or "").strip().strip('"'))
    if not os.path.isdir(real):
        return None, "目录不存在：%s" % path
    if not isinstance(ids, list) or not ids:
        return None, "没有选任何 skill"

    real_ud = os.path.realpath(ud)
    results = []

    for cid in ids:
        cid = str(cid or "").strip()
        if not _valid_new_id(cid):
            results.append({"id": cid, "ok": False, "why": "非法 id"})
            continue

        src = os.path.realpath(os.path.join(real, cid))
        if src != real and not src.startswith(real + os.sep):
            results.append({"id": cid, "ok": False, "why": "越出了要扫描的目录"})
            continue
        if not os.path.isfile(os.path.join(src, "SKILL.md")):
            results.append({"id": cid, "ok": False, "why": "源目录里没有 SKILL.md"})
            continue

        dest = os.path.join(ud, cid)
        real_dest = os.path.realpath(dest)
        if real_dest == src or real_dest.startswith(src + os.sep):
            results.append({"id": cid, "ok": False, "why": "源和目标套在一起了，会递归"})
            continue

        n, size = _dir_stats(src)
        if size > MAX_IMPORT_BYTES:
            results.append(
                {"id": cid, "ok": False, "why": "体积 %.0f MB 超过上限 %.0f MB"
                 % (size / 1048576.0, MAX_IMPORT_BYTES / 1048576.0)}
            )
            continue

        exists = os.path.isdir(dest)
        if exists and not overwrite:
            results.append({"id": cid, "ok": False, "why": "已经存在（勾上覆盖才动它）", "skipped": True})
            continue

        try:
            if exists:
                shutil.rmtree(dest)
            shutil.copytree(src, dest, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        except OSError as exc:
            results.append({"id": cid, "ok": False, "why": "拷贝失败：%s" % exc})
            continue

        results.append(
            {
                "id": cid,
                "ok": True,
                "files": n,
                "bytes": size,
                "overwrote": exists,
                "dest": dest,
                "inside_user_dir": real_dest.startswith(real_ud + os.sep),
            }
        )

    return {
        "from": real,
        "to": ud,
        "imported": sum(1 for r in results if r.get("ok")),
        "results": results,
    }, None
