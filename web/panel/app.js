/* WindWhisper 面板逻辑（🍃 风语）
 *
 * 阶段进度（每次改动都同步这里，别让它过期）：
 *   阶段 1 ✅ 推送链路（主页面侧 windwhisper.js 负责实际写节点）
 *   阶段 2 ✅ 真对话 / SSE 流式 / 会话持久化 / 后端设置 / 显存协调
 *   阶段 3 ✅ skill 系统：扫描 · 适配注入 · 详情 · 主 skill 单选 + 参考多选
 *              · 目录导入 · 面板内新建 / 编辑 / 复制 / 删除 / 导出
 *   阶段 4 ✅ 词库：真实存储 · 分类 + 标签 + 搜索 · 存库 / 载入 / 推节点 / 导出 / 删除
 *   阶段 5 ✅ 打磨健壮性：错误提示（阶段 2 已做）· 窄屏降级 · 主题**手动切换**并可记住
 *              —— 主题规则：用户点过按钮就锁定、不再跟随 ComfyUI；没点过才跟随。
 *                 存 localStorage["windwhisper_theme_v1"]。
 *   阶段 6 ✅ 形态改造：面板从「居中大弹窗」改成**可调宽的右侧悬浮边栏**（默认 420px），
 *              画布上多一个可拖动、记位置的悬浮按钮。子改动：
 *              · 删掉窄屏「非激活芯片 display:none」的降级 —— 那是"一次只能用一个 skill"的根
 *              · 芯片条改单行横滑（滚轮 + 拖动），长名字出省略号
 *              · <520px 时弹层铺满面板；>520px 回到卡片式
 *              · 修 `.chips/.chip` 类名撞车：设置页快捷开关的「+ / ✓」前缀曾被画到 skill 芯片上
 *
 * ⚠️ 这里是 iframe 内部，**绝对不能用 <script type="module">**
 *    （会破坏 ComfyUI 的 combo 初始化），所以全部用普通函数 + 全局。
 *
 * ⚠️ 协议名与 web/windwhisper.js 双侧同改，漏改一边会静默失效。
 * ⚠️ 面板里所有"能改能删"的对象都有边界：skill 只有**用户目录**里的能动，
 *    内置的只读，想改先复制。这不是偷懒，是防止插件更新把你的改动冲掉。
 */

var TARGET_ORIGIN = (location.protocol === "http:" || location.protocol === "https:")
  ? location.origin
  : "*";

var state = {
  cfg: null,             // 后端配置（来自 /windwhisper/config）
  backendOk: null,       // null=没测过 false=刚失败 true=刚成功
  chats: [],             // 会话列表（轻量元数据）
  chat: null,            // 当前会话全文（含 msgs）
  showArchived: false,
  masterId: null,        // 当前人设 skill id
  refIds: [],            // 附加参考 skill id（多选）
  skCat: "全部",
  lastMeta: null,        // 最近一次 /chat 的 meta（系统提示体积/上下文条数/显存释放）
  streaming: false,
  abort: null,
  pendingImage: null,    // 已附加、还没发出去的那张图 {data,name,w,h}（压过的 data URL）
  libCat: "全部",
  libItems: [],          // 词库条目（来自 /windwhisper/library）
  libCats: [],           // 词库分类（后端算的，按最近用过的排前）
  libSelId: null,        // 当前选中的词条 id（不是下标 —— 删一条之后下标会错位）
  libMode: "loading",    // loading | live | demo
  libFav: false,         // 只显示收藏
  libFile: "",           // library.json 的落盘路径（界面里显示，省得你去找）
  skEditId: null,        // 正在编辑的 skill id；新建时为 null
  skEditNew: false,
  skImportDir: "",       // 最近一次扫描的目录
  skImportItems: [],     // 扫描结果
  skImportSel: {},       // {id: true} 勾选状态
  conv: 0
};

var pending = null;        // 正在等待回执的推送请求
var pendingTimer = null;
var pushedCardId = null;   // 当前被标记为"已推到节点"的卡片 id
var canvasNodes = [];      // 父页面告知的画布上的风语节点

/* ---------------------------------------------------------------- 与主页面 */

function sendToParent(type, payload) {
  try {
    parent.postMessage(Object.assign({ type: type }, payload || {}), TARGET_ORIGIN);
  } catch (err) {
    console.warn("[风语] 发消息给主页面失败", err);
  }
}

function closePanel() {
  sendToParent("windwhisper/close", {});
}

/* ------------------------------------------------------ 形态（侧边栏 / 居中） */

/* 面板有两种形态，但**尺子握在主页面手里** —— 面板只做两件事：表达意图、呈现状态。
 *   ① 用户点顶栏那个放大按钮 → 发 windwhisper/mode 请求切到目标形态
 *   ② 主页面切完后用**同名消息**把权威形态广播回来 → applyPanelMode 落 class
 * 两条消息同名是有意的：语义就是"形态"，谁发都读同一个 mode 字段，不用记两套名字。
 *
 * 状态只落在 body 的两个 class 上；图标露哪个交给 CSS 管（见 style.css），
 * JS 不碰 display —— 跟主题按钮同一套路，省得两边各记一份状态、对不上。 */
var panelMode = "dock";

function applyPanelMode(m) {
  panelMode = (m === "modal") ? "modal" : "dock";
  document.body.classList.toggle("mode-dock", panelMode === "dock");
  document.body.classList.toggle("mode-modal", panelMode === "modal");
  var btn = $("modeBtn");
  if (btn) {
    btn.title = panelMode === "modal"
      ? "收成侧边栏（也能双击画布上的叶子按钮）"
      : "居中放大（也能双击画布上的叶子按钮）";
  }
}

function togglePanelMode() {
  sendToParent("windwhisper/mode", { mode: panelMode === "dock" ? "modal" : "dock" });
}

/* ---------------------------------------------------------- 主题（手动优先） */

/* 三层规则，别搞混：
 *   ① 用户在面板里点过切换按钮 → **以他的选择为准**，之后 ComfyUI 怎么变都不跟随
 *   ② 没点过 → 跟随 ComfyUI 当前主题（父页面用 windwhisper/init + windwhisper/theme 告知）
 *   ③ 面板被单独打开（没有父页面）→ 默认浅色
 * 选择存 localStorage，刷新不丢。KEY 带版本号，以后改结构不至于读到脏值。
 */
var THEME_KEY = "windwhisper_theme_v1";
var themeLocked = false;   // true = 用户手动选过，父页面再报主题也不覆盖

function readThemePref() {
  try {
    var v = localStorage.getItem(THEME_KEY);
    return (v === "dark" || v === "light") ? v : "";
  } catch (err) { return ""; }
}

function saveThemePref(v) {
  try { localStorage.setItem(THEME_KEY, v); } catch (err) { /* 隐私模式写不了，不影响用 */ }
}

function applyTheme(dark) {
  var isDark = !!dark;
  document.body.classList.toggle("dark", isDark);
  // 图标是 CSS 切的（浅色露月亮 / 深色露太阳），这里只改 tooltip
  var btn = $("themeBtn");
  if (btn) {
    btn.title = isDark
      ? "当前深色 · 点一下切到浅色（记住你的选择，不再跟随 ComfyUI）"
      : "当前浅色 · 点一下切到深色（记住你的选择，不再跟随 ComfyUI）";
  }
}

/* 父页面报主题走这里 —— 用户手动选过就一律不覆盖 */
function applyParentTheme(dark) {
  if (themeLocked) return;
  applyTheme(dark);
}

function initTheme() {
  var pref = readThemePref();
  if (pref) {
    themeLocked = true;        // 手动选过 → 后面的 init / theme 都不理
    applyTheme(pref === "dark");
  } else {
    applyTheme(false);         // 先按浅色出，等父页面 init 告知真实主题
  }
}

function toggleTheme() {
  var nextDark = !document.body.classList.contains("dark");
  themeLocked = true;
  applyTheme(nextDark);
  saveThemePref(nextDark ? "dark" : "light");
  toast(nextDark ? "已切到深色，以后都按这个来（不再跟随 ComfyUI 主题）"
                 : "已切到浅色，以后都按这个来（不再跟随 ComfyUI 主题）");
}

function onParentMessage(ev) {
  // 面板被独立打开时 origin 是 "null"，那种情况下不做拦截
  if (ev.origin && ev.origin !== "null" && location.origin !== "null" && ev.origin !== location.origin) return;
  var msg = ev.data;
  if (!msg || typeof msg.type !== "string") return;
  if (msg.type.indexOf("windwhisper/") !== 0) return;

  if (msg.type === "windwhisper/init") {
    applyParentTheme(msg.dark);
    applyPanelMode(msg.mode);
    canvasNodes = msg.nodes || [];
  } else if (msg.type === "windwhisper/pushed") {
    onPushed(msg);
  } else if (msg.type === "windwhisper/theme") {
    applyParentTheme(msg.dark);
  } else if (msg.type === "windwhisper/mode") {
    applyPanelMode(msg.mode);
  }
}

window.addEventListener("message", onParentMessage);

/* ------------------------------------------------------------------ 小工具 */

function $(id) { return document.getElementById(id); }

function svg(p) { return '<svg class="ic sm" viewBox="0 0 24 24">' + p + '</svg>'; }

/* skill 名 / 描述 / 会话标题都来自磁盘上的文件或后端，插进 HTML 前一律转义 */
function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function fmtKB(bytes) {
  var b = bytes || 0;
  if (b < 1024) return b + " B";
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + " KB";
  return (b / 1048576).toFixed(2) + " MB";
}

/* 把 id 塞进拼出来的 onclick 字符串里用的。
 *
 * 为什么要单独一个函数：id 来自磁盘上的目录名或后端，直接拼进
 * 事件属性时，只要名字里有反斜杠或引号就会把整段 JS 拆烂。
 * 后端已经用白名单校验过，这里再收敛一次 —— **谁拼字符串谁负责转义**，
 * 别指望上游永远干净。
 *
 * ⚠️ 注释里别写出真实的事件属性写法（连等号带引号那种）。
 *    静态校验是**扫源码文本**的，注释里的示例一样会被当成真代码抓出来 ——
 *    这条注释的第一版就这么坑了我一次（报了个不存在的未定义函数）。 */
function jsid(s) {
  return String(s == null ? "" : s).replace(/[^A-Za-z0-9_.\-]/g, "");
}

function fmtWhen(ms) {
  if (!ms) return "";
  var d = Date.now() - ms;
  if (d < 60000) return "刚刚";
  if (d < 3600000) return Math.round(d / 60000) + " 分钟前";
  if (d < 86400000) return Math.round(d / 3600000) + " 小时前";
  if (d < 172800000) return "昨天";
  var t = new Date(ms);
  return (t.getMonth() + 1) + "-" + t.getDate();
}

function shortModel(m) {
  var s = String(m || "");
  return s.length > 26 ? s.slice(0, 24) + "…" : s;
}

var icons = {
  camera: '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>',
  brush: '<path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/><path d="M2 2l7.586 7.586"/><circle cx="11" cy="11" r="2"/>',
  box: '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>',
  user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  film: '<rect x="2" y="2" width="20" height="20" rx="2.18"/><line x1="7" y1="2" x2="7" y2="22"/><line x1="17" y1="2" x2="17" y2="22"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="2" y1="7" x2="7" y2="7"/><line x1="2" y1="17" x2="7" y2="17"/><line x1="17" y1="17" x2="22" y2="17"/><line x1="17" y1="7" x2="22" y2="7"/>',
  play: '<polygon points="5 3 19 12 5 21 5 3"/>',
  tag: '<path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/>'
};

/* ------------------------------------------------------------ skill 列表 */

var skills = [];
var skillMode = "loading";   // loading | live | demo

/* 拿不到接口时退回演示数据，这样把 index.html 单独打开预览时界面依然完整；
 * 那时 ul 上会挂「演示数据」标记，免得你以为扫到的是真的。
 *
 * ⚠️ 这里只放**当前真的内置了**的 skill。2026-09-22 删掉了
 *    veonib-ugc-vidoe-skill__skillhub（整个是云端 API 操作手册，面板里跑不了），
 *    演示数据里也得跟着删，否则单独预览时会看到一个根本不存在的 skill。 */
var demoSkills = [
  { id: "anima-prompt-artist",          name: "Anima · 插画提示词", desc: "30+ 艺术家风格库，二次元插画向，严格输出格式", category: "插画", icon: "brush",  files: 3,  bytes: 10600, adapted: true, source: "builtin", editable: false },
  { id: "roger-deakins-cinematography", name: "迪金斯 · 电影摄影",   desc: "自然主义打光 / 阴影叙事 / 建筑框架等十大技法", category: "摄影", icon: "camera", files: 3,  bytes: 48600, adapted: true, source: "builtin", editable: false },
  { id: "MOKEAIGC-V9",                  name: "电影感世界观",       desc: "把灵感变成可信世界，输出 9 张电影感静帧提示词", category: "风格", icon: "film",   files: 1,  bytes: 28100, adapted: true, source: "builtin", editable: false },
  { id: "seedance-tvc-director",        name: "TVC 导演",           desc: "15 / 30 秒广告分镜与视频提示词",              category: "视频", icon: "play",   files: 19, bytes: 19800, adapted: true, source: "builtin", editable: false },
  { id: "prompt-generator",             name: "万能提示词生成",       desc: "6 大领域路由 + 1246 元素库（脚本章节已剥离）", category: "通用", icon: "tag",    files: 61, bytes: 22200, adapted: true, source: "builtin", editable: false },
  { id: "female-portrait-director",     name: "女性人像导演",         desc: "生活方式 / 时尚 / 国风 / 棚拍人像提示词",      category: "人像", icon: "user",   files: 67, bytes: 18300, adapted: true, source: "builtin", editable: false }
];

function findSkill(id) {
  return skills.filter(function (s) { return s.id === id; })[0] || null;
}

function loadSkills() {
  skills = demoSkills;
  skillMode = "demo";
  refreshSkillUI();

  return WW.listSkills().then(function (d) {
    skills = d.skills || [];
    skillMode = "live";
    if (!skills.length) {
      toast("扫到 0 个 skill —— 看看 ComfyUI 控制台，或确认 skills/ 目录里有 SKILL.md", true);
    }
    if (!findSkill(state.masterId)) state.masterId = skills.length ? skills[0].id : null;
    refreshSkillUI();
  }).catch(function (err) {
    console.warn("[风语] skill 接口不可达，改用演示数据：", err.message);
    refreshSkillUI();
  });
}

function refreshSkillUI() {
  if (state.masterId == null && skills.length) state.masterId = skills[0].id;
  // 人设被删掉 / 换过之后，参考列表里可能留了已经不存在的 id
  state.refIds = state.refIds.filter(function (id) { return !!findSkill(id) && id !== state.masterId; });
  renderChips();
  renderCats();
  renderSkills();
  renderSyscap();
}

/* --------------------------------------------------------- 后端配置 / 设置 */

function loadConfig() {
  return WW.getConfig().then(function (cfg) {
    state.cfg = cfg;
    renderBackend();
    renderSyscap();
  }).catch(function (err) {
    console.warn("[风语] 读不到配置：", err.message);
    state.cfg = null;
    renderBackend();
    renderSyscap();
  });
}

function renderBackend() {
  var c = state.cfg;
  var pill = $("backendPill");
  var label = $("backendLabel");
  if (!c) {
    label.textContent = "后端不可用";
    pill.classList.remove("ok"); pill.classList.add("bad");
    return;
  }
  var bits = [];
  bits.push(c.model ? shortModel(c.model) : "未选模型");
  bits.push(c.api_key ? "Key" : "无 Key");
  label.textContent = bits.join(" · ");
  pill.classList.toggle("ok", state.backendOk === true);
  pill.classList.toggle("bad", state.backendOk === false);
}

function openSettings() {
  fillSettings();
  openSheet("cfg");
}

function fillSettings() {
  var c = state.cfg || {};
  $("cfgBase").value = c.base_url || "";
  $("cfgKey").value = c.api_key || "";
  $("cfgModel").value = c.model || "";
  $("cfgTemp").value = c.temperature != null ? c.temperature : 0.8;
  $("cfgMaxTokens").value = c.max_tokens != null ? c.max_tokens : 8192;
  $("cfgRounds").value = c.history_rounds != null ? c.history_rounds : 6;
  $("cfgVram").value = c.vram_mode || "soft";
  $("cfgThinking").checked = !!c.thinking;
  $("cfgExtra").value = c.system_extra || "";
  renderExtraChips();
  $("cfgPath").textContent = c.config_file || "user/default/WindWhisper/config.json";
  if (c.config_file) $("cfgPath").title = c.config_file;
  renderBasePresets();   // 自己加的地址存在本地，每次打开设置都按最新的画一遍
  toggleAddPreset(false);
  setCfgStatus(state.cfg ? "读到了当前配置，改完记得点保存" : "没读到配置，先把地址填上", "");
}

function collectSettings() {
  return {
    base_url: $("cfgBase").value.trim(),
    api_key: $("cfgKey").value,
    model: $("cfgModel").value.trim(),
    temperature: parseFloat($("cfgTemp").value),
    max_tokens: parseInt($("cfgMaxTokens").value, 10),
    history_rounds: parseInt($("cfgRounds").value, 10),
    vram_mode: $("cfgVram").value,
    thinking: $("cfgThinking").checked,
    system_extra: $("cfgExtra").value
  };
}

/* ------------------------------------------------------------ 全局提示词开关 */

/* 快捷开关：点一下把这段话追加进「全局提示词」框，再点一下移除。
 * 内容是写进 textarea 的**可见文本** —— 用户看得见、改得动，
 * 不是藏在代码里的暗规则。所以这里只负责"起个草稿"，具体措辞你可以随便改。 */
var EXTRA_PRESETS = {
  note: "在 ```prompt 块之前用一句中文说明这一轮改了什么（20 字内），除此以外不要别的文字。",
  alt: "每次给出 3 个风格明显不同的备选，每个单独一个 ```prompt 块，块前用一句话标明差异。",
  neg: "最后另起一行给出 Negative prompt:（英文逗号分隔），放在 ```prompt 块之外。",
  short: "提示词尽量精简，删掉可有可无的修饰词，不要重复同义描述。"
};

function toggleExtra(key) {
  var add = EXTRA_PRESETS[key];
  if (!add) return;
  var el = $("cfgExtra");
  var cur = el.value;
  if (cur.indexOf(add) >= 0) {
    // 已经有了 → 移除，顺手把多出来的空行收掉
    el.value = cur.replace(add, "").replace(/\n{3,}/g, "\n\n").trim();
  } else {
    el.value = cur.trim() ? cur.replace(/\s+$/, "") + "\n" + add : add;
  }
  renderExtraChips();
  el.focus();
}

function renderExtraChips() {
  var v = $("cfgExtra").value || "";
  var chips = document.querySelectorAll("#extraChips .chip");
  for (var i = 0; i < chips.length; i++) {
    var add = EXTRA_PRESETS[chips[i].getAttribute("data-k")];
    chips[i].classList.toggle("on", !!add && v.indexOf(add) >= 0);
  }
}

function setCfgStatus(html, kind) {
  var el = $("cfgStatus");
  el.className = "cfg-status" + (kind ? " " + kind : "");
  el.innerHTML = html;
}

function presetBase(url) {
  $("cfgBase").value = url;
  setCfgStatus("地址填好了，点「测试连接」试试", "");
}

/* ------------------------------------------------- 快速填地址（默认 + 自己加的）
 *
 * 默认几条写成代码常量，用户自己加的存 localStorage —— 分开存是有意的：
 * 默认项该跟着插件版本走（升级就更新），用户加的属于个人配置，绝不能被升级冲掉。
 * 纯前端的事，后端不掺和：它只是往输入框里填个字。 */
var BASE_PRESETS = [
  { name: "llama.cpp :8080", url: "http://127.0.0.1:8080/v1" },
  { name: "Ollama :11434", url: "http://127.0.0.1:11434/v1" },
  { name: "OpenAI", url: "https://api.openai.com/v1" }
];
var PRESET_KEY = "windwhisper_presets_v1";

function readBasePresets() {
  try {
    var raw = JSON.parse(localStorage.getItem(PRESET_KEY) || "[]");
    if (!Array.isArray(raw)) return [];
    return raw.filter(function (p) {
      return p && typeof p.url === "string" && p.url;
    }).map(function (p) {
      return { name: String(p.name || ""), url: String(p.url) };
    });
  } catch (e) {
    return [];   // 存脏了就当没有，别因此打不开设置面板
  }
}

function writeBasePresets(list) {
  try { localStorage.setItem(PRESET_KEY, JSON.stringify(list)); }
  catch (e) { toast("浏览器不让写本地存储，这次能用，刷新就没了", true); }
}

/** 画「快速填地址」那一排。默认的在前面且不能删，自己加的后面跟一个小 ×。 */
function renderBasePresets() {
  var box = $("basePresets");
  if (!box) return;
  var mine = readBasePresets();
  box.innerHTML = BASE_PRESETS.concat(mine).map(function (p, i) {
    var custom = i >= BASE_PRESETS.length;
    return '<span class="pwrap' + (custom ? " custom" : "") + '">'
      + '<button class="tbtn" onclick="presetBase(\'' + safeUrl(p.url) + '\')" title="' + esc(p.url) + '">'
      + esc(p.name || hostOf(p.url)) + "</button>"
      + (custom
        ? '<button class="px" onclick="delBasePreset(' + (i - BASE_PRESETS.length) + ')" title="删掉这条">'
          + svg('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>')
          + "</button>"
        : "")
      + "</span>";
  }).join("");
}

/** 要塞进事件属性里的地址，只放行 URL 里该出现的字符。
 *  ⚠️ 别拿 jsid() 来干这事 —— 它只留字母数字和 _.-，会把
 *  "http://127.0.0.1:8080/v1" 削成 "http127.0.0.18080v1"，地址就废了。 */
function safeUrl(u) {
  return String(u == null ? "" : u).replace(/[^A-Za-z0-9:/._\-?&=%~#@+\[\]]/g, "");
}

/** 从地址里抠出域名当默认名：https://api.deepseek.com/v1 → api.deepseek.com */
function hostOf(u) {
  return String(u == null ? "" : u).replace(/^https?:\/\//i, "").replace(/\/.*$/, "") || "自定义";
}

function toggleAddPreset(force) {
  var box = $("addPreset");
  var btn = $("presetAddBtn");
  if (!box) return;
  var show = force === undefined ? box.hidden : !!force;
  box.hidden = !show;
  if (btn) btn.classList.toggle("on", show);
  if (show) {
    $("apName").value = "";
    $("apUrl").value = "";
    $("apName").focus();
  }
}

function addBasePreset() {
  var name = $("apName").value.trim();
  var raw = $("apUrl").value.trim();
  if (!raw) { toast("地址得填一个", true); $("apUrl").focus(); return; }

  // 没带协议头就补一个：本机/内网补 http，其余补 https（云服务清一色 https）。
  // 不补的话用户很容易只填 api.deepseek.com/v1，那后台会当成相对路径直接失败。
  var url = raw;
  if (!/^https?:\/\//i.test(url)) {
    var isLan = /^(localhost|0\.0\.0\.0|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(url);
    url = (isLan ? "http://" : "https://") + url;
  }

  var clean = safeUrl(url);
  var dirty = clean !== url;
  url = clean;
  if (!url) { toast("这个地址填得不对，检查一下", true); return; }

  var same = function (a, b) { return a.replace(/\/+$/, "").toLowerCase() === b.replace(/\/+$/, "").toLowerCase(); };
  if (BASE_PRESETS.concat(readBasePresets()).some(function (p) { return same(p.url, url); })) {
    toast("这个地址上面已经有了", true);
    return;
  }

  var list = readBasePresets();
  list.push({ name: name || hostOf(url), url: url });
  writeBasePresets(list);
  renderBasePresets();
  toggleAddPreset(false);
  presetBase(url);
  toast("加好了，以后就一直在「快速填地址」里" + (dirty ? "（地址里有不支持的字符，已去掉）" : ""));
}

function delBasePreset(i) {
  var list = readBasePresets();
  if (i < 0 || i >= list.length) return;
  var gone = list.splice(i, 1)[0];
  writeBasePresets(list);
  renderBasePresets();
  toast("删掉了「" + (gone.name || gone.url) + "」");
}

function fillModels(list) {
  var dl = $("cfgModels");
  dl.innerHTML = (list || []).map(function (m) {
    return '<option value="' + esc(m) + '"></option>';
  }).join("");
}

function pullModels() {
  setCfgStatus("正在拉模型列表…", "busy");
  // 用 config/test 而不是 /models —— 这样**没保存的新地址也能测**
  WW.testConfig(collectSettings()).then(function (r) {
    if (r.ok) {
      fillModels(r.models);
      setCfgStatus("✓ " + r.base + " · " + r.ms + " ms · 拿到 " + (r.count || 0) + " 个模型"
        + (r.count ? "，点模型框就能选" : "") + (r.note ? "<br>" + r.note : ""), "ok");
    } else {
      setCfgStatus("✗ " + (r.error || "连不上"), "err");
    }
  }).catch(function (e) {
    setCfgStatus("✗ " + esc(e.message), "err");
  });
}

function testBackend() {
  setCfgStatus("正在测试连接…", "busy");
  WW.testConfig(collectSettings()).then(function (r) {
    if (r.ok) {
      fillModels(r.models);
      state.backendOk = true;
      renderBackend();
      setCfgStatus("✓ 连上了 <b>" + esc(r.base) + "</b> · " + r.ms + " ms · " + (r.count || 0) + " 个模型"
        + "<br>" + (r.used_key
          ? "带了 Authorization 头（你填了 Key）"
          : "**没发** Authorization 头 —— 本地模式的正常状态")
        + (r.note ? "<br>" + esc(r.note) : ""), "ok");
    } else {
      state.backendOk = false;
      renderBackend();
      setCfgStatus("✗ 连不上<br>" + (r.error || "未知原因"), "err");
    }
  }).catch(function (e) {
    state.backendOk = false;
    renderBackend();
    setCfgStatus("✗ " + esc(e.message), "err");
  });
}

function saveSettings() {
  var patch = collectSettings();
  WW.saveConfig(patch).then(function (d) {
    state.cfg = d.config;
    state.backendOk = state.backendOk;
    renderBackend();
    renderSyscap();
    toast("配置已保存到 " + d.config.config_file, true);
    setCfgStatus("✓ 已保存", "ok");
  }).catch(function (e) {
    setCfgStatus("✗ 保存失败：" + esc(e.message), "err");
  });
}

/** 把拼好的 system prompt 摊开给你看 —— 出问题时不用靠猜。 */
function previewSystem() {
  $("skvName").textContent = "System Prompt（实际发给模型的第一条）";
  $("skvCat").textContent = "实时拼装";
  $("skvStats").innerHTML = "";
  $("skvNote").classList.remove("show");
  $("skvNote").textContent = "";
  $("skvBody").textContent = "拼装中…";
  $("skvHint").textContent = "";
  openSheet("skview");

  WW.systemPrompt(state.masterId, state.refIds).then(function (d) {
    var meta = d.meta || {};
    var stats = [
      '<span class="st">总长度 <b>' + fmtKB(meta.bytes) + '</b></span>',
      '<span class="st">字符 <b>' + (meta.chars || 0).toLocaleString() + '</b></span>',
      '<span class="st">人设 <b>' + esc((meta.master && meta.master.name) || "无") + '</b></span>',
      '<span class="st">参考 <b>' + ((meta.refs || []).length) + ' 项</b></span>',
      '<span class="st">上下文上限 <b>' + ((state.cfg && state.cfg.history_rounds) || 6) + ' 轮</b></span>'
    ];
    $("skvStats").innerHTML = stats.join("");
    if (meta.missing && meta.missing.length) {
      $("skvNote").textContent = "这些 id 没找到对应 skill，已跳过：" + meta.missing.join("、");
      $("skvNote").classList.add("show");
    }
    $("skvBody").textContent = d.system;
    $("skvHint").textContent = "注入文件：" + ((meta.used_files || []).join("、") || "无");
  }).catch(function (e) {
    $("skvBody").textContent = "拼不出来：" + e.message;
  });
}

/* -------------------------------------------------------------- 会话管理 */

function loadChats() {
  return WW.listChats(state.showArchived).then(function (items) {
    state.chats = items;
    renderDrawer();
    return items;
  }).catch(function (err) {
    console.warn("[风语] 读不到会话列表：", err.message);
    state.chats = [];
    renderDrawer();
    return [];
  });
}

function renderDrawer() {
  var el = $("convList");
  var kw = ($("convSearch") ? $("convSearch").value : "").trim().toLowerCase();

  var list = state.chats.filter(function (c) {
    if (!kw) return true;
    var sk = findSkill(c.skillId);
    return ((c.title || "") + " " + (sk ? sk.name : "") + " " + (c.skillId || "") + " " + (c.preview || ""))
      .toLowerCase().indexOf(kw) >= 0;
  });

  if (!list.length) {
    el.innerHTML = '<div class="conv-empty">'
      + (state.chats.length ? "没有匹配的会话" : "还没有会话，点上面的 + 建一个")
      + "</div>";
    return;
  }

  el.innerHTML = list.map(function (c) {
    var on = state.chat && state.chat.id === c.id;
    var sk = findSkill(c.skillId);
    return '<div class="conv' + (on ? " active" : "") + (c.archived ? " archived" : "") + '" onclick="pickConv(\'' + c.id + '\')">'
      + '<div class="acts">'
      + '<button class="cbtn" onclick="event.stopPropagation();renameChat(\'' + c.id + '\')" title="重命名">'
      + '<svg class="ic sm" viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/></svg></button>'
      + '<button class="cbtn" onclick="event.stopPropagation();archiveChat(\'' + c.id + '\',' + (c.archived ? "false" : "true") + ')" title="' + (c.archived ? "取消归档" : "归档") + '">'
      + '<svg class="ic sm" viewBox="0 0 24 24"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg></button>'
      + '<button class="cbtn" onclick="event.stopPropagation();delChat(\'' + c.id + '\')" title="删除">'
      + '<svg class="ic sm" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>'
      + "</div>"
      + '<div class="name">' + esc(c.title) + "</div>"
      + '<div class="meta"><span class="cbadge">' + esc(sk ? sk.name : "无 skill") + "</span>"
      + "<span>" + fmtWhen(c.updated) + "</span><span>" + c.count + " 条</span></div>"
      + "</div>";
  }).join("");
}

function pickConv(id) {
  if (state.chat && state.chat.id === id) {
    if ($("drawer").classList.contains("open")) toggleDrawer();
    return;
  }
  openChat(id, false);
}

/** 切会话 = 上下文**整体替换**，不是叠加。
 *  写成"上一个会话的末尾接下一个"就会串台 —— 在充气泵会话里问一句，
 *  它拿蒸汽眼罩的上下文回你。 */
function openChat(id, silent) {
  return WW.getChat(id).then(function (chat) {
    state.chat = chat;
    if (chat.skillId && findSkill(chat.skillId)) state.masterId = chat.skillId;
    state.refIds = (chat.refIds || []).filter(function (r) { return !!findSkill(r); });
    state.lastMeta = null;
    pushedCardId = null;
    hidePushedBar();
    renderDrawer();
    renderChips();
    renderSkills();
    renderSyscap();
    renderMessages();
    if ($("drawer").classList.contains("open")) toggleDrawer();
    if (!silent) toast("已切到「" + chat.title + "」· 上下文整体替换，跟其它会话互不干扰", true);
    scrollToBottom(true);
  }).catch(function (e) {
    toast("打不开这个会话：" + e.message, true);
  });
}

function newChat() {
  if (state.streaming) { toast("正在生成中，先点停止"); return; }
  WW.createChat(state.masterId).then(function (chat) {
    state.chats.unshift({ id: chat.id, title: chat.title, skillId: chat.skillId, archived: false,
      created: chat.created, updated: chat.updated, count: 0, preview: "" });
    state.chat = chat;
    state.refIds = [];
    state.lastMeta = null;
    pushedCardId = null;
    hidePushedBar();
    renderDrawer();
    renderMessages();
    renderSyscap();
    if ($("drawer").classList.contains("open")) toggleDrawer();
    toast("新会话开好了 · 人设「" + ((findSkill(state.masterId) || {}).name || "无") + "」", true);
    $("composerInput").focus();
  }).catch(function (e) {
    toast("建不了会话：" + e.message, true);
  });
}

function renameChat(id) {
  var c = state.chats.filter(function (x) { return x.id === id; })[0];
  var cur = c ? c.title : "";
  // iframe 里可以用原生 prompt（没有 sandbox 限制），先用着，比重做一套弹层划算
  var name = window.prompt("会话名称", cur);
  if (name === null) return;
  name = name.trim();
  if (!name) return;
  WW.saveChat(id, { title: name }).then(function () {
    if (c) c.title = name;
    if (state.chat && state.chat.id === id) state.chat.title = name;
    renderDrawer();
    toast("改好了");
  }).catch(function (e) { toast("改名失败：" + e.message, true); });
}

function archiveChat(id, val) {
  WW.saveChat(id, { archived: val }).then(function () {
    toast(val ? "已归档（点底部按钮可以翻出来）" : "已取消归档");
    return loadChats();
  }).catch(function (e) { toast("归档失败：" + e.message, true); });
}

function delChat(id) {
  var c = state.chats.filter(function (x) { return x.id === id; })[0];
  if (!window.confirm("删除会话「" + (c ? c.title : id) + "」？消息历史会一起没掉，没法恢复。")) return;
  WW.deleteChat(id).then(function () {
    state.chats = state.chats.filter(function (x) { return x.id !== id; });
    if (state.chat && state.chat.id === id) {
      state.chat = null;
      renderMessages();
      if (state.chats.length) openChat(state.chats[0].id, true);
      else newChat();
    } else {
      renderDrawer();
    }
    toast("删掉了");
  }).catch(function (e) { toast("删除失败：" + e.message, true); });
}

function toggleArchived() {
  state.showArchived = !state.showArchived;
  $("archBtn").innerHTML = '<svg class="ic sm" viewBox="0 0 24 24"><polyline points="21 8 21 21 3 21 3 8"/>'
    + '<rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>'
    + (state.showArchived ? "只看未归档" : "看归档的会话");
  loadChats();
}

function toggleDrawer() { $("drawer").classList.toggle("open"); }

/* ---------------------------------------------------------------- 消息渲染 */

/* ==== WW_PARSE_BEGIN ==== */
/* 一整段**纯函数**（不碰 DOM），所以能被静态桩整段抠出来跑断言：
 *     node .workbuddy/tools/windwhisper_split_test.cjs
 * 改之前先读那段测试。这里出问题**不会报错**，只会表现成"卡片和推送/存库按钮
 * 凭空消失"，用户完全不知道为什么 —— 真机已经栽过两次。
 *
 * 它比"找一个 ```prompt 围栏"复杂得多，是因为**不能指望模型**：
 * 真机实测（女性人像导演 skill）模型吐的是
 *     ```text 一、参数锁定结果 …  ```text 三、最终提示词 …  ```  …  ```text 四、负面约束 …  ```
 * —— 三个 text 围栏、而且漏了一个收尾。按"成对匹配"去切，B 的正文会掉进普通文字里，
 * 整条回复连一张卡片都剩不下（就是用户报的"按钮不见了"）。
 *
 * 所以这里是三层：
 *   ① 围栏当"切换"处理 —— 漏收尾 / 多块 / 错配都能各归各位
 *   ② 语言名放宽 —— prompt / text / 裸围栏 / markdown 都算提示词候选
 *   ③ 通用后处理把「过程 / 提示词 / 负面词」拆开：认小标题，也认单块大杂烩
 * 最后兜一层：实在认不出来就把整条当提示词，**按钮不允许消失**。
 *
 * 这一段的输出是 parts 数组，元素形态：
 *     {kind:"text",    text}            普通文字（进气泡）
 *     {kind:"card",    text, auto}      提示词卡片（auto: "fence"/"whole" = 是认出来的，不是模型标的）
 *     {kind:"negative",text}            负面词（挂到最近的卡片上）
 *     {kind:"process", text, pending}   过程说明（渲染时折起来，内容一个字不删）
 *     {kind:"code",    text, lang}      真代码块（python / bash 这种，或有语言名的围栏）
 */

/** 这些语言名等于"没写语言名"，可以当提示词候选。 */
var PLAIN_LANGS = { "": 1, prompt: 1, text: 1, txt: 1, plain: 1, plaintext: 1, markdown: 1, md: 1 };

/** 明确是负面词的围栏。 */
var NEG_LANGS = { negative: 1, neg: 1, negativeprompt: 1, negative_prompt: 1, bad: 1 };

/** 「最终提示词」的标题特征 —— 命中就是卡片。 */
var CARD_RE = /最终提示词|最终版本|提示词正文|可复制提示词|优化后提示词|final\s*prompt|optimized\s*prompt/i;
/** 「负面约束」的标题特征。 */
var NEG_RE = /负面约束|负面提示词|负向约束|negative\s*prompt|^negative$/i;
/** 过程性小节的标题特征（这些块不配当卡片）。 */
var PROC_RE = /参数锁定|模块解析|画面主目标|路由|自检|诊断|分析|优化原则|改写原则|推荐理由|问题清单|输出模式|输出格式|适用场景|输出规则|使用说明|工作流程|字段清单|组合规则/;

/** 把一行收拾干净：去掉 # > * - 和【】《》[]（）包裹，便于当标题判断。 */
function cleanHeading(line) {
  var t = String(line == null ? "" : line).trim();
  if (!t || t.length > 30) return "";
  t = t.replace(/^[#>*\-\u2022\s]+/, "").replace(/[\s*#]+$/, "").trim();
  t = t.replace(/^[【\[（(《]+/, "").replace(/[】\]）)》]+$/, "").trim();
  return t.length > 26 ? "" : t;
}

/** 这一行是什么小标题？**只看短行** —— 免得把正文里提到"最终提示词"的句子当标题。 */
function labelKind(line) {
  var c = cleanHeading(line);
  if (!c) return "";
  if (CARD_RE.test(c)) return "prompt";
  if (NEG_RE.test(c)) return "neg";
  if (PROC_RE.test(c) && /^[一二三四五六七八九十\d]/.test(c)) return "proc";
  return "";
}

function nonEmptyLines(t) {
  return String(t == null ? "" : t).split("\n").filter(function (x) { return x.trim(); });
}
function tailLine(t) { var l = nonEmptyLines(t); return l.length ? l[l.length - 1].trim() : ""; }
function soleLine(t) { var l = nonEmptyLines(t); return l.length === 1 ? l[0].trim() : ""; }

/** 去掉围栏行本身 —— 标题劈块时会把开头那个 ```text 带进过程里，很难看。 */
function stripFenceLines(t) {
  return String(t == null ? "" : t).split("\n").filter(function (ln) {
    return !/^\s*```/.test(ln);
  }).join("\n");
}

/** 单块大杂烩：整段里自带「最终提示词」小标题 → 就地劈成 过程 / 提示词 / 负面。
 *
 * 这是最后一道防线：模型完全不听话、把所有东西塞进同一个 ```text 里时还能救回来。
 * 返回 null = 没有可劈的标记（那就交给下面的小标题 / 语言名规则）。
 * 过程段的章节标题（"一、参数锁定结果"）**保留**，一个字都不删。
 */
function splitMonolith(text) {
  var lines = String(text == null ? "" : text).split("\n");
  var bucket = { proc: [], prompt: [], neg: [] };
  var sec = "proc";
  var hitPrompt = false;
  for (var i = 0; i < lines.length; i++) {
    var ln = lines[i].replace(/\r$/, "");
    var k = labelKind(ln);
    if (k === "prompt") { sec = "prompt"; hitPrompt = true; continue; }
    if (k === "neg") { sec = "neg"; continue; }
    bucket[sec].push(ln);
  }
  if (!hitPrompt) return null;

  var out = [];
  var proc = stripFenceLines(bucket.proc.join("\n")).trim();
  var prompt = stripFenceLines(bucket.prompt.join("\n")).trim();
  var neg = stripFenceLines(bucket.neg.join("\n")).trim();
  if (proc) out.push({ kind: "process", text: proc });
  if (prompt) out.push({ kind: "card", text: prompt, auto: "fence" });
  if (neg) out.push({ kind: "negative", text: neg });
  return out.length ? out : null;
}

/** 一个围栏块是什么？`tail` = 紧跟在它前面的那行小标题（没有就传空串）。
 *
 * 顺序是**故意**的：卡片判定必须在过程判定**之前**，否则"三、最终提示词"
 * 会被 PROC_RE 里的"分析/输出格式"这类词先抢走。
 */
function classifyBlock(lang, body, tail) {
  body = String(body == null ? "" : body).replace(/\s+$/, "");
  if (!body.trim()) return [];

  // ① 单块大杂烩（整段自带「最终提示词」小标题）→ 就地劈开
  var mono = splitMonolith(body);
  if (mono) {
    // 劈完只剩一段过程、而过程末尾那句正是「三、最终提示词」——
    // 说明提示词其实在**下一块**里。把这个标题留给下一块，
    // 否则那张卡片会丢掉身份、退化成"自动识别"。
    if (mono.length === 1 && mono[0].kind === "process") {
      var last = tailLine(body);
      if (labelKind(last) === "prompt") mono[0].pending = last;
    }
    return mono;
  }

  var hk = labelKind(tail);
  if (hk === "prompt") return [{ kind: "card", text: body }];
  if (hk === "neg") return [{ kind: "negative", text: body }];
  if (NEG_LANGS[lang]) return [{ kind: "negative", text: body }];
  if (lang === "prompt") return [{ kind: "card", text: body }];
  if (hk === "proc") return [{ kind: "process", text: body }];

  // 没有小标题时看正文开头 —— 只取前 80 字，免得误伤提示词正文
  var head = body.slice(0, 80);
  if (PROC_RE.test(head) && !CARD_RE.test(head)) return [{ kind: "process", text: body }];

  if (PLAIN_LANGS[lang]) return [{ kind: "cand", text: body }];
  return [{ kind: "code", lang: lang, text: body }];
}

/** 给"没写明是提示词"的块打分，挑最像的那个当卡片。
 *  最可靠的判别信号是**英文占比**：提示词正文基本是英文，过程说明基本是中文。 */
function scoreCand(t) {
  var s = String(t || "");
  if (!s.trim()) return -1e9;
  var letters = (s.match(/[A-Za-z]/g) || []).length;
  var sc = (letters / s.length) * 100;
  if (PROC_RE.test(s.slice(0, 120))) sc -= 50;
  if (/(^|\n)\s*[一二三四五六七八九十][、.．]/.test(s)) sc -= 25;
  return sc + Math.min(s.length / 200, 10);
}

/** "整条当提示词"的闸门：够长 + 以英文为主。挡掉纯中文的闲聊问答。 */
function blobLooksLikePrompt(t) {
  var s = String(t == null ? "" : t).trim();
  if (s.length < 60) return false;
  var letters = (s.match(/[A-Za-z]/g) || []).length;
  return letters / s.length >= 0.35;
}

function splitMessage(text) {
  var s = String(text == null ? "" : text);
  var parts = [];
  var buf = [];
  var fenceLang = null;
  var fenceBody = [];
  var lines = s.split("\n");
  var i, j;

  function flushText() {
    var t = buf.join("\n");
    buf = [];
    if (t.replace(/\s+/g, "")) parts.push({ kind: "text", text: t });
  }

  function flushFence() {
    var body = fenceBody.join("\n");
    var lang = fenceLang;
    fenceLang = null;
    fenceBody = [];
    if (!body.trim()) return;   // 空块丢掉 —— 不造一张没内容的卡片

    var prev = parts.length ? parts[parts.length - 1] : null;
    var tail = "";
    if (prev && prev.kind === "text") {
      tail = soleLine(prev.text) || tailLine(prev.text);
    } else if (prev && prev.kind === "process" && prev.pending) {
      tail = prev.pending;
      delete prev.pending;
    }

    // 小标题单独占了一段（"三、最终提示词"这种）→ 并进块里，
    // 别让它孤零零挂在气泡上、跟卡片对不上号
    var hk = labelKind(tail);
    if (prev && prev.kind === "text" && soleLine(prev.text) && hk) parts.pop();

    var made = classifyBlock(lang, body, tail);
    for (j = 0; j < made.length; j++) parts.push(made[j]);
  }

  for (i = 0; i < lines.length; i++) {
    var raw = lines[i].replace(/\r$/, "");
    var m = /^\s*`{3,}\s*([A-Za-z0-9_+.\-]*)\s*$/.exec(raw);
    if (!m) {
      if (fenceLang === null) buf.push(raw); else fenceBody.push(raw);
      continue;
    }

    var flang = (m[1] || "").toLowerCase();

    /* 围栏行 —— **统一当"切换"处理，不当"成对匹配"**。
     * ⚠️ 这是整段代码里最反直觉、也最关键的一处。真机实测模型会写成
     *      ```text A…   ```text B…   ```  四、负面约束   ```text C…   ```
     *    忘了收 A 就直接开 B。按成对切，B（真正的提示词）会掉进普通文字里，
     *    整条回复一张卡片都不剩；当切换切，A/B/C 三块各归各位、一个不丢。 */
    if (fenceLang !== null) {
      flushFence();                 // 关掉上一块
      if (flang === "") continue;   // 裸围栏只负责关，不负责开（开了就是空块）
    } else {
      // 孤零零一个 ``` 而且后面什么都没有（收尾漏了开头）→ 当文字，别开空块
      if (flang === "" && !lines.slice(i + 1).join("").replace(/\s+/g, "")) { buf.push(raw); continue; }
      flushText();
    }
    fenceLang = flang;
    fenceBody = [];
  }
  flushFence();
  flushText();

  /* ---------------- 后处理：保证"按钮不允许消失" ---------------- */
  var hasCard = false;
  for (i = 0; i < parts.length; i++) if (parts[i].kind === "card") hasCard = true;

  // ②-1 一张卡片都没有 → 试试正文里带【最终提示词】小标题的写法（模型不套围栏那种）
  if (!hasCard) {
    var monoAll = splitMonolith(s);
    if (monoAll) { parts = monoAll; hasCard = true; }
  }

  // ②-2 只有 ```text / 裸围栏 这类"没写明是提示词"的块 → 挑一个最像的当卡片
  if (!hasCard) {
    var cands = [];
    for (i = 0; i < parts.length; i++) if (parts[i].kind === "cand") cands.push(i);
    var best = -1, bestScore = -1e9;
    for (i = 0; i < cands.length; i++) {
      var sc = scoreCand(parts[cands[i]].text);
      if (sc > bestScore) { bestScore = sc; best = cands[i]; }
    }
    if (best >= 0 && bestScore > 0) {
      parts[best].kind = "card";
      parts[best].auto = "fence";
      hasCard = true;
    }
  }

  // 没被选中的候选退回普通代码块 —— **不隐藏**，它也可能是另一版提示词
  for (i = 0; i < parts.length; i++) {
    if (parts[i].kind === "cand") { parts[i].kind = "code"; parts[i].lang = parts[i].lang || ""; }
  }

  // ②-3 最后一道：整条当提示词。用"够长 + 以英文为主"挡掉闲聊
  if (!hasCard) {
    var blob = stripFenceLines(s).trim();
    if (blobLooksLikePrompt(blob)) parts = [{ kind: "card", text: blob, auto: "whole" }];
  }

  return parts;
}
/* ==== WW_PARSE_END ==== */

/** 提示词卡片。
 *
 * `card.auto` 是"这一段是**认**出来的、不是模型自己标的"：
 *   "fence" = 模型没用 ```prompt，是从 ```text 里认出来的
 *   "whole" = 整条回复连围栏都没有，直接按整条处理
 * 标出来是为了别让人以为模型乖乖听话了 —— 排查问题时要能一眼看出真相。
 *
 * `neg` 是这个 skill 顺带给的负面词（```negative 围栏或"四、负面约束"小节）。
 * 它**不参与**复制 / 存库（那两个只取正向正文），推送时可以单独开关带上。 */
function cardHtml(card, msgIdx, cardIdx, neg) {
  var text = (card && card.text) || "";
  var id = "card-" + msgIdx + "-" + cardIdx;

  var chip = "";
  if (card && card.auto === "fence") {
    chip = '<span class="autochip" title="模型没按 prompt 契约写，这一段是从 text 围栏里认出来的">自动识别</span>';
  } else if (card && card.auto === "whole") {
    chip = '<span class="autochip" title="整条回复里没找到提示词围栏，已按整条处理">整条</span>';
  }

  var negHtml = "";
  var nt = String(neg || "").trim();
  if (nt) {
    var nid = id + "-neg";
    negHtml = '<div class="negsec" id="' + nid + '">'
      + '<div class="negrow">'
      + '<svg class="ic sm" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="5" y1="5" x2="19" y2="19"/></svg>'
      + "<span>负面词</span><span class=\"dim\">" + nt.length + " 字</span>"
      + '<span style="flex:1"></span>'
      + '<button class="mini" onclick="copyNeg(\'' + nid + '\',this)" title="只复制负面词">复制</button>'
      + '<button class="mini negsw" onclick="toggleNeg(\'' + id + '\',this)" title="打开后推到节点时会和正向提示词一起写进去（空行分隔）">推送时带上</button>'
      + "</div>"
      + '<div class="negbody">' + esc(nt) + "</div>"
      + "</div>";
  }

  return '<div class="card-note" id="' + id + '">'
    + '<div class="head">'
    + '<svg class="ic sm" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>'
    + "<span>提示词</span>" + chip + '<span class="grow"></span>'
    + '<span class="pushed-badge"><svg viewBox="0 0 24 24" style="width:11px;height:11px;stroke:currentColor;fill:none;stroke-width:3;stroke-linecap:round;stroke-linejoin:round"><polyline points="20 6 9 17 4 12"/></svg>已推到节点</span>'
    + "<span>" + text.length + " 字</span>"
    + "</div>"
    + '<div class="body">' + esc(text) + "</div>"
    + negHtml
    + '<div class="foot"><span class="grow" style="flex:1"></span>'
    + '<button class="mini" onclick="copyCard(' + msgIdx + "," + cardIdx + ',this)" title="只复制提示词正文，不带围栏标记">'
    + '<svg class="ic sm" viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>复制</button>'
    + '<button class="mini" onclick="saveToLib(\'' + id + '\')">'
    + '<svg class="ic sm" viewBox="0 0 24 24"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>存库</button>'
    + '<button class="mini primary" onclick="pushNode(\'' + id + '\')">'
    + '<svg class="ic sm" viewBox="0 0 24 24"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg>推到节点</button>'
    + "</div></div>";
}

/** 助手这一条：文字进气泡，提示词卡片挂在气泡**下面**（不放进气泡里）。
 *
 * 卡片单独一层是有原因的：被推到节点时整块要变渐变底色，塞在气泡里会被
 * 气泡自己的底色压住，状态就看不出来了。
 *
 * ⚠️ 这里要分两趟走，不能边遍历边拼 HTML：负面词常常**排在卡片后面**
 * （"四、负面约束"天然在"三、最终提示词"之后），一趟走的话卡片早就拼成
 * 字符串了，没法再把负面词塞进去。所以先归拢成结构，再统一渲染。
 *
 * 过程说明（参数锁定结果 / 模块解析 那一大坨）收进一个**折叠区**：
 * 用户要的是"过程别占正文"，但**内容一个字都不删** —— 折起来，想看随时点开。
 */
function assistantHtml(m, msgIdx) {
  var text = (m && m.text) || "";
  var parts = splitMessage(text);
  var cards = [];       // [{part, neg}]
  var segs = [];        // 渲染顺序：[{kind:"card",at}] | {kind:"text"|"code"|"proc",...}
  var pendingNeg = [];  // 还没找到卡片认领的负面词
  var i;

  parts.forEach(function (p) {
    if (p.kind === "card") {
      cards.push({ part: p, neg: pendingNeg.shift() || "" });
      segs.push({ kind: "card", at: cards.length - 1 });
    } else if (p.kind === "negative") {
      var at = null;
      for (i = segs.length - 1; i >= 0; i--) { if (segs[i].kind === "card") { at = segs[i].at; break; } }
      if (at === null) pendingNeg.push(p.text);
      else cards[at].neg = cards[at].neg ? (cards[at].neg + "\n" + p.text) : p.text;
    } else if (p.kind === "process") {
      segs.push({ kind: "proc", text: p.text });
    } else if (p.kind === "code") {
      segs.push({ kind: "code", text: p.text, lang: p.lang || "" });
    } else if (p.text && p.text.trim()) {
      segs.push({ kind: "text", text: p.text });
    }
  });

  var flow = [];
  segs.forEach(function (s) {
    if (s.kind === "code") {
      flow.push('<pre class="codeblock" data-lang="' + esc(s.lang || "text") + '">' + esc(s.text) + "</pre>");
    } else if (s.kind === "text") {
      flow.push("<div>" + esc(s.text.trim()) + "</div>");
    }
  });

  // 没人认领的负面词 → 当普通代码块显示，**不隐藏**
  pendingNeg.forEach(function (t) {
    flow.push('<pre class="codeblock" data-lang="negative">' + esc(t) + "</pre>");
  });

  var procs = segs.filter(function (s) { return s.kind === "proc"; });
  if (procs.length) {
    flow.push('<details class="procbox"><summary>过程说明 · ' + procs.length + " 段"
      + "（模型附带的分析，已折叠 · 点开看）</summary>"
      + procs.map(function (s) { return '<pre class="codeblock">' + esc(s.text) + "</pre>"; }).join("")
      + "</details>");
  }

  var out = "";
  if (flow.length) out += '<div class="bubble">' + flow.join("") + "</div>";
  if (!flow.length && !cards.length) out += emptyBubbleHtml(m);
  return out + cards.map(function (c, idx) { return cardHtml(c.part, msgIdx, idx, c.neg); }).join("");
}

/* 正文一个字都没有时，别只丢一句"（空回答）"—— 那等于什么都没说。
 * 最常见的原因是**思考跟正文抢同一个 max_tokens**（真机踩过）：
 * 思考写满 2048，正文一个字都没轮上。所以把原因直接写进气泡里。 */
function emptyBubbleHtml(m) {
  var n = ((m && m.think) || "").length;
  if (!n) return '<div class="bubble dim">（空回答）</div>';
  return '<div class="bubble warn">'
    + "<div>⚠️ 输出额度被思考吃光了 —— 模型写了 " + n + " 字思考，正文一个字都没轮到"
    + (m.finish === "length" ? "，是被上限截断的。" : "。")
    + "</div>"
    + '<button class="tbtn sm" onclick="retryNoThinking()">关掉思考重来</button>'
    + "</div>";
}

function errHtml(msg) {
  var hint = msg.error ? ("<div class=\"eh\">" + esc(msg.error) + "</div>") : "";
  return '<div class="errbox">' + svg('<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>')
    + "<div>" + hint + "<div>" + (msg.hint || "未知原因") + "</div></div></div>";
}

function renderMessages() {
  var el = $("msgs");
  if (!state.chat || !(state.chat.msgs || []).length) {
    el.innerHTML = '<div class="empty-state">'
      + '<div class="es-title">开始聊吧</div>'
      + '<div class="es-body">在下面描述你想要什么画面就行 —— 当前人设是「'
      + esc((findSkill(state.masterId) || {}).name || "无 skill")
      + "」。<br>聊出满意的提示词，点卡片上的「推到节点」，再回画布点 Queue Prompt 出图。</div>"
      + "</div>";
    return;
  }

  el.innerHTML = state.chat.msgs.map(function (m, i) {
    var isUser = m.role === "user";
    var head = "";
    if (!isUser && (m.model || m.ms)) {
      head = '<span class="mhead">' + esc(shortModel(m.model || ""))
        + (m.ms ? " · " + (m.ms / 1000).toFixed(1) + "s" : "") + "</span>";
    }
    var think = m.think
      ? '<details class="thinkbox"><summary>思考过程（' + m.think.length + " 字）</summary><pre>"
        + esc(m.think) + "</pre></details>"
      : "";
    // 用户这条可能带图（反推来的）：图挂在气泡上方。
    // m.image 有两种形态，都得能显示（见 imageSrc）：
    //   ① 本轮刚贴的 —— 压缩后的 data URL，还在内存里
    //   ② 刷新/切会话读回来的 —— **素材文件名**（会话 json 里不再存 base64）
    var ubimg = (isUser && m.image)
      ? '<div class="ubimg"><img src="' + esc(imageSrc(m.image, state.chat && state.chat.id))
        + '" alt="附带的图片"></div>'
      : "";
    var body = isUser
      ? ubimg + '<div class="bubble">' + esc(m.text) + "</div>"
      : assistantHtml(m, i) + (m.error ? errHtml({ hint: m.error }) : "");

    // 每条消息下面都挂一条操作带：复制图标 + （助手的）模型·耗时。
    // 以前 mhead 是单独一行贴在气泡下面，现在并进这一行，少占一行高度。
    var acts = '<div class="mactions">'
      + copyBtn(i, isUser ? "复制这条" : "复制整条回复（含围栏标记）")
      + head + "</div>";

    return '<div class="msg ' + (isUser ? "me" : "ai") + '">' + think + body + acts + "</div>";
  }).join("");

  // 重新渲染后把"已推到节点"的渐变标记补回去
  if (pushedCardId) {
    var c = $(pushedCardId);
    if (c) c.classList.add("pushed");
  }
}

function scrollToBottom(force) {
  var chat = $("chat");
  if (!chat) return;
  var near = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 160;
  if (force || near) chat.scrollTop = chat.scrollHeight;
}

/* ------------------------------------------------------------ 发消息 / 流式 */

function sendMessage() {
  if (state.streaming) { stopStream(); return; }

  var el = $("composerInput");
  var text = (el.value || "").trim();
  var img = state.pendingImage;
  // 只贴了图、一个字没打也允许发 —— 反推本来就不需要你写什么，自动补一句指令
  if (!text && !img) return;
  if (!canSend()) return;      // 校验没过就别清输入框，你还能改

  el.value = "";
  autoGrow(el);
  if (!text) text = IMG_TIP;
  doSend(text, img);
}

/* 发消息前的三道门。抽出来是因为「关掉思考重来」也得走同一套校验。 */
function canSend() {
  if (!state.cfg) { toast("还没读到后端配置，点右上角先配一下", true); return false; }
  if (!state.cfg.model) { toast("还没选模型 —— 点右上角「后端设置」拉一下列表", true); openSettings(); return false; }
  if (!state.chat) { newChat(); toast("刚建了个新会话，再点一次发送", true); return false; }
  return true;
}

/* img 有两种：{data} = 刚从文件读进来压过的图，{ref} = 历史里那条消息上的素材名。
 * 内存副本里两种情况都存原样 —— 渲染时由 imageSrc() 分辨（见那边的注释）。 */
function doSend(text, img) {
  state.chat.msgs.push({ role: "user", text: text, image: img ? (img.data || img.ref) : null, ts: Date.now() });
  renderMessages();
  scrollToBottom(true);

  // 图已经跟着这条消息走了，输入区那条预览撤掉（失败也撤 —— 这条消息本身就在，
  // 实在要重发，点卡片/重新附加都比"取消勾选"直观）
  state.pendingImage = null;
  renderImgStrip();

  var holder = startBubble();
  state.streaming = true;
  updateSendBtn();

  var ctrl = new AbortController();
  state.abort = ctrl;
  var acc = "", think = "";

  WW.streamChat(
    {
      chatId: state.chat.id, text: text,
      // 只发其中一条：新贴的给 data URL，重发历史那条给素材名（后端读文件补回 data URL）
      image: img && img.data ? img.data : null,
      imageRef: img && img.ref ? img.ref : null,
      masterId: state.masterId, refIds: state.refIds
    },
    function (ev) {
      if (ev.type === "meta") {
        onMeta(ev);
      } else if (ev.type === "delta") {
        acc += ev.text || "";
        holder.bubble.textContent = acc;
        scrollToBottom(false);
      } else if (ev.type === "think") {
        think += ev.text || "";
        if (!holder.think.dataset.on) {
          holder.think.dataset.on = "1";
          holder.think.style.display = "block";
          holder.think.textContent = "思考中…";
        }
        holder.think.textContent = "思考中… " + think.length + " 字";
      } else if (ev.type === "error") {
        holder.wrap.classList.remove("streaming");
        holder.bubble.innerHTML = errHtml(ev);
        holder.errored = true;
        state.backendOk = false;
        renderBackend();
      } else if (ev.type === "done") {
        // 流结束时的收尾信息。finish === "length" 就是"被输出上限截断了"，
        // 这是"思考把额度吃光"唯一的硬证据 —— 以前整条链路都把它丢掉，
        // 于是界面只剩一个没有任何解释的空气泡。
        holder.finish = ev.finish || null;
      } else if (ev.type === "saved") {
        holder.saved = ev;
      }
    },
    ctrl.signal
  ).catch(function (err) {
    if (err && err.name === "AbortError") return;   // 你自己按了停止，不是错误
    holder.bubble.innerHTML = errHtml({ hint: err.message });
    holder.errored = true;
  }).then(function () {
    state.streaming = false;
    state.abort = null;
    updateSendBtn();
    finishBubble(holder, acc, think);
  });
}

function stopStream() {
  if (state.abort) state.abort.abort();
  toast("已停止 —— 已经吐出来的内容照样存进会话了");
}

/* 「关掉思考重来」：正文为空时的救命按钮。
 * 三件事都得做干净，少一件就留脏东西：
 *   ① 关掉「让模型先思考」并**等它落盘**（后端是每次请求现读配置的，
 *      不等就重发，很可能还是用旧值跑一遍 —— 白等）
 *   ② 把尾部那条空正文的助手消息从会话里剪掉（否则历史里永远躺着一个空气泡）
 *   ③ 用同一条用户消息重发
 */
function retryNoThinking() {
  if (state.streaming) return;
  var msgs = (state.chat && state.chat.msgs) || [];
  var lastUser = null;
  for (var i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === "user") { lastUser = msgs[i]; break; }
  }
  if (!lastUser) { toast("找不到上一条你说的话，直接重发一次吧", true); return; }

  // ② 剪掉尾部"空正文的助手消息"
  var cut = 0;
  while (msgs.length && msgs[msgs.length - 1].role === "assistant"
         && !String(msgs[msgs.length - 1].text || "").trim()) {
    msgs.pop();
    cut++;
  }
  if (cut) {
    renderMessages();
    WW.saveChat(state.chat.id, { msgs: msgs }).catch(function () {
      toast("剪掉空气泡时没存上，不影响这次重试", true);
    });
  }

  function go() {
    if (!canSend()) return;
    toast("思考已关掉，重来一次");
    // 上一轮如果带了图，重发也得带上 —— 不然模型只能对着文字猜那张图长什么样。
    // ⚠️ 这里拿到的 image 通常是**素材名**（切过会话 / 刷过页面之后就是），所以
    // 不能用 `{data: …}` 硬包装，交给 imgArg 分辨。
    doSend(lastUser.text, imgArg(lastUser.image));
  }

  // ① 关思考 → 等落盘 → 再重发
  if (state.cfg && state.cfg.thinking) {
    state.cfg.thinking = false;
    var cb = $("cfgThinking");
    if (cb) cb.checked = false;
    WW.saveConfig({ thinking: false }).then(function (d) {
      if (d && d.config) state.cfg = d.config;
    }).catch(function () {
      toast("「关掉思考」没存上 —— 这次仍按关闭发送，但下次记得去设置里改", true);
    }).then(go);
  } else {
    go();
  }
}

function startBubble() {
  var wrap = document.createElement("div");
  wrap.className = "msg ai streaming";
  wrap.innerHTML = '<div class="thinkline" style="display:none"></div><div class="bubble"></div>';
  $("msgs").appendChild(wrap);
  return {
    wrap: wrap,
    bubble: wrap.querySelector(".bubble"),
    think: wrap.querySelector(".thinkline"),
    errored: false,
    finish: null,
    saved: null
  };
}

function finishBubble(holder, acc, think) {
  // 服务端已经把这条落盘了（包括中途停止的半截），这里同步到内存副本
  if (acc || think) {
    var meta = state.lastMeta || {};
    state.chat.msgs.push({
      role: "assistant",
      text: acc,
      think: think || null,
      model: meta.model || (state.cfg && state.cfg.model),
      finish: holder.finish || null,
      ms: holder.saved ? holder.saved.ms : null,
      error: holder.errored ? "（这一条出错了）" : null,
      ts: Date.now()
    });
  } else if (!holder.errored) {
    toast("模型一个字都没吐 —— 看下面「后端设置 → 测试连接」能不能通", true);
  }
  renderMessages();
  scrollToBottom(true);
  renderSyscap();

  // 服务端可能自动改了标题 / 新增了会话，拉到最新的列表
  loadChats();
}

function onMeta(ev) {
  state.lastMeta = ev;
  state.backendOk = true;
  renderBackend();
  renderSyscap();

  /* ⚠️ 这里**只在出问题时才弹**（2026-09-23 收敛）。
   * 原来是无条件弹一条"释放了 N MB 显存 · 显存已清(…) · …"—— 每发一条消息弹一次，
   * 用户嫌太频繁。可这些**正常信息本就已经在顶部 syscap 状态栏里**（显存 +NMB /
   * 上下文条数 / 模型名），再弹一遍纯属重复。会弹的只剩真正需要你知道的：
   *   · 人设/参考里有的 skill 没找到（静默少注入内容 = 必须知道）
   *   · 显存协调真的出岔子（拿不到 / 失败 / 异常），别的 note 都是正常跳过
   * 其余 note 不弹，但挂到 syscap 的 title 上，鼠标停一下照样能看到，信息没丢。 */
  var vr = ev.vram || {};
  var bits = [];
  if (ev.missing && ev.missing.length) bits.push("这些 skill 没找到：" + ev.missing.join("、"));
  if (/失败|拿不到|异常/.test(vr.note || "")) bits.push(vr.note);
  if (bits.length) toast(bits.join(" · "), true);

  if (ev.title && state.chat && ev.title !== state.chat.title) {
    state.chat.title = ev.title;
    renderDrawer();
  }
}

function updateSendBtn() {
  var b = $("sendBtn");
  if (state.streaming) {
    b.classList.add("stopping");
    b.title = "停止生成";
    b.innerHTML = '<svg class="ic" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" stroke="none"/></svg>';
  } else {
    b.classList.remove("stopping");
    b.title = "发送";
    b.innerHTML = '<svg class="ic" viewBox="0 0 24 24"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>';
  }
}

/* ------------------------------------------------------------ 图片（反推用）
 *
 * 2026-09-23 加：之前这里是"图片输入第一版不做"的一句提示。现在真做了 ——
 * 用户手上有 API 和 llama 两边都能看图的模型，反推是这插件最该有的功能之一。
 *
 * 三个设计决定（改动前先读，别把好的地方改坏）：
 *   ① **在前端压缩**，最长边 1280、JPEG 0.82 起步，压完还超上限就继续降档。
 *      不压的话手机照片 4~8MB → base64 再涨 1/3，本地 llama.cpp 光收请求就要好几秒。
 *   ② **图进会话历史，但绝不是 base64**（2026-09-23 用户反馈"多来几次历史不得爆炸"后
 *      改的）：图落地成 `images/<会话id>/img_<内容哈希>.jpg`，会话 json 里只留一个
 *      二十来字符的文件名。多轮照样能引用同一张图，历史文件却还是纯文字大小。
 *      于是界面上 `m.image` 有两种形态 —— 统一走 imageSrc() 转成 <img src>。
 *   ③ 发送时只把**最近的总量控制在预算内**（见 IMG_KEEP_BYTES，后端那侧裁），
 *      免得聊十轮之后每次请求都拖着十张图。
 */
var IMG_MAX_SIDE = 1280;              // 压缩后最长边（px）
var IMG_MAX_CHARS = 900 * 1024;       // data URL 字符串的硬上限（base64 长度）
var IMG_TIP = "参考这张图，把它反推成一份可直接出图的提示词。";

/** 会话里那条消息的 m.image → 能给 <img src> 用的地址。
 *    · `data:…`      本轮刚贴的，字还在内存里 → 直接用
 *    · `img_xxx.jpg` 刷新 / 切会话读回来的 → 走后端读取路由按需取文件
 *  返回的串外面都会过 esc()（query 里有 &），插进属性安全。 */
function imageSrc(ref, cid) {
  if (!ref) return "";
  return /^data:/.test(ref) ? ref : WW.imgUrl(cid, ref);
}

/** m.image → doSend 的第二个参数。新贴的给 {data}，历史里的给 {ref} ——
 *  重发上一条时两种都可能遇到，别只认其中一种。 */
function imgArg(ref) {
  if (!ref) return null;
  return /^data:/.test(ref) ? { data: ref } : { ref: ref };
}

function attachImage() { $("imgFile").click(); }

function clearImage() {
  state.pendingImage = null;
  renderImgStrip();
}

/** 文件 → Image → 压缩 → state.pendingImage。三步都失败得有话说，不能静默。 */
function readImageFile(file) {
  if (!file) return;
  if (!/^image\//.test(file.type || "")) { toast("这个不是图片文件，换一张", true); return; }
  var fr = new FileReader();
  fr.onload = function () {
    var img = new Image();
    img.onload = function () { encodeImage(img, file.name); };
    img.onerror = function () { toast("这张图读不出来，换 jpg / png / webp 试试", true); };
    img.src = fr.result;
  };
  fr.onerror = function () { toast("读文件失败，可能是权限或文件被占用", true); };
  fr.readAsDataURL(file);
}

/** 画进 canvas 再导出 JPEG。逐档降：先保画质，实在压不下去才动尺寸。 */
function encodeImage(img, name) {
  var plans = [
    { side: IMG_MAX_SIDE, q: 0.82 },
    { side: 1024, q: 0.72 },
    { side: 800, q: 0.62 },
    { side: 640, q: 0.52 }
  ];
  for (var i = 0; i < plans.length; i++) {
    var p = plans[i];
    var scale = Math.min(1, p.side / Math.max(img.width || 1, img.height || 1));
    var w = Math.max(1, Math.round((img.width || 1) * scale));
    var h = Math.max(1, Math.round((img.height || 1) * scale));
    var cv = document.createElement("canvas");
    cv.width = w;
    cv.height = h;
    cv.getContext("2d").drawImage(img, 0, 0, w, h);
    var data = cv.toDataURL("image/jpeg", p.q);
    if (data.length <= IMG_MAX_CHARS) {
      state.pendingImage = { data: data, name: name || "图片", w: w, h: h };
      renderImgStrip();
      return;
    }
  }
  // 四档都超上限：图本身太大了（比如 8000px 的长截图），别硬发
  toast("这张图压不到能发的尺寸，换一张小点的（建议最长边 2000 以内）", true);
}

function renderImgStrip() {
  var el = $("imgStrip");
  var im = state.pendingImage;
  if (!el) return;
  if (!im) { el.hidden = true; el.innerHTML = ""; return; }
  el.hidden = false;
  // data URL 只含 [A-Za-z0-9+/=:] 和前缀，塞进属性里是安全的
  el.innerHTML = '<img class="ithumb" src="' + im.data + '" alt="待发送的图片">'
    + '<div class="imeta"><b>' + esc(im.name) + "</b>"
    + "<span>" + im.w + "×" + im.h + " · " + fmtKB(im.data.length) + "（已压缩）</span></div>"
    + '<button class="ibtn" onclick="clearImage()" title="撤掉这张图">'
    + '<svg class="ic" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>'
    + "</button>";
}

function autoGrow(el) {
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 300) + "px";
}

/* ------------------------------------------------------------ skill 渲染 */

function renderChips() {
  var el = $("chips");
  if (!skills.length) {
    el.innerHTML = '<span class="chip-empty">没有 skill</span>';
    return;
  }
  el.innerHTML = skills.map(function (s) {
    var on = state.masterId === s.id;
    var short = s.name.split(" · ")[0];
    // 名字套一层 .nm —— 窄边栏里芯片限宽 176px，靠它出省略号，不然长名字会把整条撑爆
    return '<button class="chip' + (on ? " active" : "") + '" onclick="setMaster(\'' + s.id + '\')" title="' + esc(s.name) + '">'
      + '<svg class="ic sm tick" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>'
      + '<span class="nm">' + esc(short) + '</span></button>';
  }).join("")
    + (skillMode === "demo" ? '<span class="chip-demo">演示数据</span>' : "");
}

/* 芯片条的横滑。窄边栏里一屏放不下全部 skill，得让它滑得动：
 *   ① 竖向滚轮 → 横向滚动（鼠标用户不会去按 shift 才是常态）
 *   ② 按住左右拖 → 横向滚动（拖动超过 4px 就不算点击了，否则一滑就误切人设）
 * 触控板 / 触摸屏走浏览器原生横向滚动，这里不用管。 */
function bindChipsScroll() {
  var el = $("chips");
  if (!el || el.__wwBound) return;
  el.__wwBound = true;

  el.addEventListener("wheel", function (ev) {
    if (Math.abs(ev.deltaY) <= Math.abs(ev.deltaX)) return;  // 本来就是横向，交给浏览器
    var before = el.scrollLeft;
    el.scrollLeft = before + ev.deltaY;
    if (el.scrollLeft !== before) ev.preventDefault();
  }, { passive: false });

  var drag = null;
  /* ⚠️ 必须**立刻把 drag 置空**，别退回成"只把 moved 重置"（2026-09-23 修的 bug）。
   * 老写法是 setTimeout(function(){ drag.moved = false }) —— drag 对象永远不清，而
   * **鼠标的 pointerId 恒为 1**，于是第一次拖动之后，之后每一次**没按键的鼠标移动**
   * 都能通过 `ev.pointerId === drag.id` 这层校验、moved 又刚被重置成 false，
   * 再挪过 4px 就重新开始横滑 —— 表现就是"手没按，芯片条自己跟着鼠标左右跑"，
   * skill 一多（芯片条溢出）就彻底点不中目标了。大窗/小窗都是同一个组件，一起中招。
   * 现在 drag 照常清空，"松手后那次 click 要不要吞掉"单独用 swallowClick 记。 */
  var swallowClick = false;

  el.addEventListener("pointerdown", function (ev) {
    if (ev.button !== 0) return;
    swallowClick = false;   // 新一次交互开始，先解掉上次可能残留的吞点击
    drag = { id: ev.pointerId, x: ev.clientX, left: el.scrollLeft, moved: false };
  });

  el.addEventListener("pointermove", function (ev) {
    if (!drag || ev.pointerId !== drag.id) return;
    var dx = ev.clientX - drag.x;
    if (!drag.moved && Math.abs(dx) > 4) {
      drag.moved = true;
      el.classList.add("grabbing");
    }
    if (!drag.moved) return;
    el.scrollLeft = drag.left - dx;
    ev.preventDefault();
  });

  // 松手即清 drag；"滑过之后的那次 click"照旧要拦，否则一滑就顺手切了人设。
  var clear = function () {
    if (!drag) return;
    if (drag.moved) swallowClick = true;
    drag = null;
    el.classList.remove("grabbing");
  };
  el.addEventListener("pointerup", clear);
  el.addEventListener("pointercancel", clear);
  el.addEventListener("pointerleave", clear);

  el.addEventListener("click", function (ev) {
    if (swallowClick) {
      swallowClick = false;
      ev.stopPropagation();
      ev.preventDefault();
    }
  }, true);
}

/* ------------------------------------------------------------ 拖标题栏挪窗 */

/* 居中大窗形态下，拖**标题栏**挪整个面板（用户要"挪开窗户看下面的节点"）。
 *
 * 为什么是 postMessage 而不是自己挪：面板在自己的 iframe 里，动不了外面的位置；
 * 而且"别拖出屏幕"这个边界只有外壳算得出来（它知道视口和窗尺寸）。
 * 所以这里只上报"这一拖走了多少像素"，夹取 + 记忆 + 落 transform 全在外壳的
 * onPanelDrag（web/windwhisper.js）里。协议：
 *   { type:"windwhisper/modal-drag", phase:"start" | "move" | "end" | "reset", dx, dy }
 *
 * 为什么不再用外壳那条浅紫拖动条：用户嫌"平白多一栏"，标准做法就是拖标题栏。
 *
 * 五条硬约束（都是踩出来的）：
 *   · **只在居中态起拖** —— 边栏贴着右边缘不参与挪动，也不该白白吞掉点击
 *   · 输入框 / 搜索框这类"拖了有别的含义"的地方不起拖（见 onControl）；
 *     按钮**可以**起拖 —— 标题栏上按钮密，从按钮上抓才顺手
 *   · 真拖过之后那一下 click 要吞掉，否则松手会顺手触发标题栏上的按钮
 *   · 松手 / 取消 / 丢捕获三条路都要收尾，少一条就卡在 grabbing
 *   · ★ 位移必须用 screenX/screenY —— clientX 会被"自己正在挪 iframe"这件事污染，
 *     拖一格只走半步（见下面 pointermove 里的推导）
 */
function bindTitleDrag(root) {
  if (!root) return;
  var st = null;
  var swallow = false;

  var isModal = function () { return document.body.classList.contains("mode-modal"); };
  /* 哪些东西上"拖"有别的含义，不能拿来挪窗：
   *   输入框 / 文本域里拖是选文字，select 是拖选项，链接是拖动链接，.search 里是选搜索词，
   *   .chip / .chk 是横向滑动手势。
   * **button 不在排除列表里** —— 标题栏上按钮多，从按钮上起拖照样挪窗，
   * 而"没移动就松手"的那次 click 会正常触发按钮（只有真拖过才吞掉，见下面的 swallow）。 */
  var onControl = function (t) {
    return !!(t && t.closest && t.closest("input,textarea,select,a,.search,.chip,.chk"));
  };

  root.addEventListener("pointerdown", function (ev) {
    if (ev.button !== 0 || !isModal() || onControl(ev.target)) return;
    swallow = false;
    st = { id: ev.pointerId, x: ev.screenX, y: ev.screenY, dx: 0, dy: 0, moved: false };
    try { root.setPointerCapture(ev.pointerId); } catch (e) { /* 不支持的浏览器就算了 */ }
  });

  root.addEventListener("pointermove", function (ev) {
    if (!st || ev.pointerId !== st.id) return;
    // ★ 必须用 screenX/screenY，不能用 clientX/clientY。
    //    clientX 是"相对 iframe 视口"的读数，而我们这一拖**正在把 iframe 本身挪走** ——
    //    窗挪了 X，同一物理位置读出来的 clientX 就少 X，于是形成负反馈：
    //      X = 目标位移 - X  →  X = 目标位移 / 2
    //    表现是"拖一格只走半步"（实测拖 187px 只挪 93.5px，正好一半）。
    //    screenX 是屏幕坐标，不受 CSS transform 影响，读数就是真实位移。
    var dx = ev.screenX - st.x;
    var dy = ev.screenY - st.y;
    if (!st.moved) {
      if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return;   // 手抖不算拖
      st.moved = true;
      document.body.classList.add("dragging");
      document.body.style.userSelect = "none";
      sendToParent("windwhisper/modal-drag", { phase: "start" });
    }
    st.dx = dx;
    st.dy = dy;
    ev.preventDefault();
    sendToParent("windwhisper/modal-drag", { phase: "move", dx: dx, dy: dy });
  });

  // 收尾统一走这里。注意用 st.dx/st.dy 而不是现读 ev.screenX —
  // lostpointercapture / pointerup 这些收尾事件坐标不可靠，现读会把窗瞬移到奇怪的地方。
  var finish = function () {
    if (!st) return;
    var s = st;
    st = null;
    document.body.classList.remove("dragging");
    document.body.style.userSelect = "";
    if (!s.moved) return;
    swallow = true;
    sendToParent("windwhisper/modal-drag", { phase: "end", dx: s.dx, dy: s.dy });
  };
  root.addEventListener("pointerup", finish);
  root.addEventListener("pointercancel", finish);
  root.addEventListener("lostpointercapture", finish);

  root.addEventListener("click", function (ev) {
    if (!swallow) return;
    swallow = false;
    ev.stopPropagation();
    ev.preventDefault();
  }, true);

  // 双击标题栏 = 回屏幕正中（这条原先在外壳的拖动条上，条没了挪到这儿，不影响拖动）
  root.addEventListener("dblclick", function (ev) {
    if (!isModal() || onControl(ev.target)) return;
    sendToParent("windwhisper/modal-drag", { phase: "reset" });
  });
}

function setMaster(id) {
  var s = findSkill(id);
  if (!s || state.masterId === id) return;
  state.masterId = id;
  // 参考里如果有同一个 skill，得踢掉 —— 同一个内容注入两遍纯属浪费上下文
  state.refIds = state.refIds.filter(function (r) { return r !== id; });
  state.lastMeta = null;
  renderChips();
  renderSkills();
  renderSyscap();
  persistChatSettings();
  /* 这里原来会弹一条 toast（"已换人设 → … · 对话历史保留，不会被清空"）—— 已去掉。
   * 原因：toast 容器是 fixed 在底部中间（style.css 的 .toasts），正好压在输入框上，
   * 每换一次人设就挡一次。换人设的反馈也没丢：上面 syscap 那行会立刻变成
   * 「已启用「xxx」」，芯片也同步高亮，看一眼就知道换没换成。 */
}

function toggleRef(id) {
  if (id === state.masterId) { toast("这个已经是当前人设了，不用再加参考"); return; }
  var i = state.refIds.indexOf(id);
  if (i >= 0) state.refIds.splice(i, 1); else state.refIds.push(id);
  state.lastMeta = null;
  renderSkills();
  renderSyscap();
  persistChatSettings();
}

/** 人设 / 参考是挂在会话上的属性，换完顺手存一下，切走再回来不变。 */
function persistChatSettings() {
  if (!state.chat) return;
  state.chat.skillId = state.masterId;
  state.chat.refIds = state.refIds.slice();
  WW.saveChat(state.chat.id, { skillId: state.masterId, refIds: state.refIds }).catch(function () { /* 静默：下次发消息也会带上 */ });
}

function renderSyscap() {
  var s = findSkill(state.masterId);
  var bits = ["已启用「" + (s ? s.name.split(" · ")[0] : "无") + "」"];
  var m = state.lastMeta;
  if (m) {
    bits.push("上下文 " + m.context_msgs + " 条 / 上限 " + m.rounds + " 轮");
    bits.push("system " + fmtKB(m.system_bytes));
    if (m.model) bits.push("模型 " + shortModel(m.model));
    if (m.vram && m.vram.freed_mb) bits.push("显存 +" + m.vram.freed_mb + "MB");
  } else if (state.cfg) {
    bits.push("上下文上限 " + state.cfg.history_rounds + " 轮");
    if (state.cfg.model) bits.push("模型 " + shortModel(state.cfg.model));
  }
  if (state.refIds.length) bits.push("附加参考 " + state.refIds.length + " 项");
  if (skillMode === "demo") bits.push("skill 列表 = 演示数据");
  var line = $("syscapTxt");
  line.textContent = bits.join(" · ");
  /* 显存协调的 note 不再弹 toast（太频繁），挂这儿 —— 鼠标停一下能看全文。
     正常跳过（"正在跑图"）和真异常（"拿不到 / 失败"）都在里面，不丢信息。 */
  line.title = (m && m.vram && m.vram.note) ? m.vram.note : "";
}

function renderCats() {
  var cats = ["全部"];
  skills.forEach(function (s) {
    if (s.category && cats.indexOf(s.category) < 0) cats.push(s.category);
  });
  if (state.skCat !== "全部" && cats.indexOf(state.skCat) < 0) state.skCat = "全部";

  $("cats").innerHTML = cats.map(function (c) {
    return '<button class="cat' + (c === state.skCat ? " active" : "") + '" title="' + esc(c) + '"'
      + ' onclick="pickCat(\'' + esc(c) + '\')">' + esc(c) + "</button>";
  }).join("");
}

function pickCat(c) {
  state.skCat = c;
  renderCats();
  renderSkills();
}

function renderSkills() {
  var kw = ($("skSearch") ? $("skSearch").value : "").trim().toLowerCase();

  var list = skills.filter(function (s) {
    if (state.skCat !== "全部" && s.category !== state.skCat) return false;
    if (!kw) return true;
    return (s.name + " " + s.desc + " " + s.id + " " + s.category).toLowerCase().indexOf(kw) >= 0;
  });

  var html = "";

  if (skillMode === "demo") {
    html += '<div class="skdemo">下面是<b>演示数据</b>——没连上 /windwhisper/skills。'
      + "在 ComfyUI 里打开面板才会读到真实 skill。</div>";
  }

  html += list.map(function (s) {
    var isMaster = state.masterId === s.id;
    return '<div class="skcard' + (isMaster ? " master" : "") + '" onclick="setMaster(\'' + jsid(s.id) + '\')">'
      + '<div class="row"><span class="ico">' + svg(icons[s.icon] || icons.tag) + "</span>"
      + '<span class="name">' + esc(s.name) + "</span></div>"
      + '<div class="desc">' + esc(s.desc || s.hit || "（这个 skill 没写 description）") + "</div>"
      + '<div class="skfoot">'
      + '<span class="files">' + s.files + " 个文件"
      + (s.editable ? " · 我的" : (s.source === "user" ? " · 用户" : "")) + "</span>"
      + '<span class="grow"></span>'
      + (s.adapted ? "" : '<span class="badge-ai">无适配</span>')
      + '<button class="see" onclick="event.stopPropagation();openSkillView(\'' + jsid(s.id) + '\')">看</button>'
      + '<button class="see more" title="更多操作（编辑 / 复制 / 导出 / 删除）"'
      + ' onclick="event.stopPropagation();openSkMenu(event,\'' + jsid(s.id) + '\')">···</button>'
      + "</div>"
      + (isMaster ? '<span class="flag">' + svg('<polyline points="20 6 9 17 4 12"/>') + "人设</span>" : "")
      + "</div>";
  }).join("");

  if (!list.length) {
    html += '<div class="skempty">' + (skills.length
      ? "没有匹配的 skill，换个词试试"
      : "没扫到 skill。点右上「导入」从 WorkBuddy 的 skill 目录拉一个进来，"
        + "或直接把含 SKILL.md 的目录放进 <code>ComfyUI/user/default/WindWhisper/skills/</code>。")
      + "</div>";
  }

  // 附加参考：真实多选（阶段 3 会加权重/优先级，第一版就是勾了全量注入）
  var candidates = skills.filter(function (s) { return s.id !== state.masterId; });
  html += '<div class="refwrap">'
    + '<div class="reftitle">附加参考（多选 · 只加内容，不改输出格式）</div>'
    + (candidates.length
      ? '<div class="refchips">' + candidates.map(function (s) {
          var on = state.refIds.indexOf(s.id) >= 0;
          return '<button class="refchip' + (on ? " on" : "") + '" onclick="toggleRef(\'' + s.id + '\')" title="' + esc(s.desc || "") + '">'
            + (on ? "✓ " : "") + esc(s.name) + "</button>";
        }).join("") + "</div>"
      : '<div class="refempty">没有可用的参考项</div>')
    + '<div class="refnote">参考内容是原样追加进 system prompt 的，体积会一起算进上下文 —— 别一次勾太多，'
    + '本地小模型装不下（每个 skill 的实际体积可以点卡片右下「看」）。</div>'
    + "</div>";

  $("skGrid").innerHTML = html;
}

/* ---------------------------------------- skill 详情：看实际注入的正文 */

function openSkillView(id) {
  var s = findSkill(id);
  $("skvName").textContent = s ? s.name : id;
  $("skvCat").textContent = s ? (s.category || "未分类") : "";
  $("skvStats").innerHTML = "";
  $("skvNote").classList.remove("show");
  $("skvNote").textContent = "";
  $("skvBody").textContent = "读取中…";
  $("skvHint").textContent = "";
  openSheet("skview");

  WW.getSkill(id).then(function (d) {
    renderSkillView(d);
  }).catch(function (err) {
    $("skvBody").textContent = "读不到正文：" + err.message
      + "\n\n如果这个面板是单独打开预览的，这个接口本来就不通 —— 它需要 ComfyUI 后端。"
      + "\n在 ComfyUI 里打开面板即可。";
    $("skvHint").textContent = "接口不可达";
  });
}

function skStat(label, value, warn) {
  return '<span class="st' + (warn ? " warn" : "") + '">' + esc(label) + " <b>" + esc(value) + "</b></span>";
}

function renderSkillView(d) {
  $("skvName").textContent = d.name;
  $("skvCat").textContent = d.category || "未分类";

  var stats = [
    skStat("实际注入", fmtKB(d.inject_bytes)),
    skStat("字符", d.chars.toLocaleString()),
    skStat("行数", d.lines),
    skStat("源文件", d.used_files.length + " / " + d.files),
    skStat("来源", d.source === "user" ? "用户目录" : "插件内置")
  ];
  if (!d.adapted) stats.push(skStat("适配", "无", true));
  $("skvStats").innerHTML = stats.join("");

  // 剥离动作必须显式说出来 —— 否则「内容少了」看起来像 bug
  var notes = [];
  if (d.stripped && d.stripped.length) notes.push("已剥掉章节：" + d.stripped.join("、"));
  if (d.dropped_lines) notes.push("已剥掉 " + d.dropped_lines + " 行命令类内容");
  if (d.adapter_note) notes.push("适配说明：" + d.adapter_note);
  if (notes.length) {
    $("skvNote").textContent = notes.join("\n\n");
    $("skvNote").classList.add("show");
  }

  $("skvBody").textContent = d.content || "（这个 skill 按适配规则不注入任何内容）";
  $("skvHint").textContent = "注入文件：" + (d.used_files.join("、") || "无")
    + " · 这就是实际会发给模型的那段文本";
}

/* ==================================================== skill 管理（阶段 3）
 *
 * 三条能力边界，下面所有分支都由它们决定：
 *   1. **只有用户目录里的 skill 能改能删**，内置的只读
 *   2. 想改内置的 → 先「复制到我的」，在副本上改（否则插件一更新就白改）
 *   3. 编辑器拿的是 **SKILL.md 原文**（未剥离），不是注入文本
 *      —— 拿注入文本回填再保存，会让内容每编辑一次少一截
 */

var skMenuEl = null;

function closeSkMenu() {
  if (skMenuEl && skMenuEl.parentNode) skMenuEl.parentNode.removeChild(skMenuEl);
  skMenuEl = null;
}

function openSkMenu(ev, id) {
  closeSkMenu();
  var s = findSkill(id);
  if (!s) return;

  var acts = [{ t: "查看注入正文（实际发给模型的那段）", f: "openSkillView('" + jsid(id) + "')" }];
  if (s.editable) acts.push({ t: "编辑", f: "openSkillEditor('" + jsid(id) + "')" });
  acts.push({
    t: s.editable ? "复制一份" : "复制到我的（内置只读，改要先复制）",
    f: "dupSkill('" + jsid(id) + "')"
  });
  acts.push({ t: "导出 SKILL.md 原文", f: "exportSkill('" + jsid(id) + "')" });
  if (s.editable) acts.push({ t: "删除", f: "delSkill('" + jsid(id) + "')", danger: true });

  var el = document.createElement("div");
  el.className = "skmenu";
  el.innerHTML = acts.map(function (a) {
    return '<button class="skmi' + (a.danger ? " danger" : "") + '" onclick="closeSkMenu();'
      + a.f + '">' + esc(a.t) + "</button>";
  }).join("");
  document.body.appendChild(el);

  var r = el.getBoundingClientRect();
  el.style.left = Math.max(8, Math.min(ev.clientX, window.innerWidth - r.width - 10)) + "px";
  el.style.top = Math.max(8, Math.min(ev.clientY, window.innerHeight - r.height - 10)) + "px";
  skMenuEl = el;

  // 下一次点击（不管点哪）就关掉。用 setTimeout 挂，免得被当前这次点击立刻触发。
  setTimeout(function () {
    document.addEventListener("click", closeSkMenu, { once: true });
  }, 0);
}

/* ------------------------------------------------------------ 编辑 / 新建 */

function openSkillEditor(id) {
  var s = id ? findSkill(id) : null;
  state.skEditId = s ? s.id : null;
  state.skEditNew = !s;

  $("skeTitle").textContent = s ? ("编辑 · " + s.name) : "新建 skill";
  $("skeId").value = s ? s.id : "";
  $("skeId").disabled = !!s;
  $("skeName").value = s ? s.name : "";
  $("skeCat").value = s && s.category !== "未分类" ? s.category : "";
  $("skeIcon").value = (s && s.icon) || "tag";
  $("skeDesc").value = (s && s.desc) || "";
  $("skeNote").value = "";
  $("skeInject").value = "";
  $("skeBody").value = "";
  $("skeIdHint").textContent = s
    ? "id 建好就不能改了（它就是目录名）"
    : "留空会自动按名字生成；只能字母数字和 _ . -";
  setSkeStatus(s ? "正在读 SKILL.md 原文…" : "填完点保存，会写进 user/default/WindWhisper/skills/", s ? "busy" : "");
  openSheet("skedit");

  if (!s) { $("skeBody").focus(); return; }

  WW.exportSkill(s.id).then(function (d) {
    $("skeName").value = d.name || s.name;
    $("skeDesc").value = d.desc || "";
    $("skeCat").value = d.category || "";
    $("skeIcon").value = d.icon || "tag";
    $("skeNote").value = d.note || "";
    $("skeInject").value = (d.inject_extra || []).join("\n");
    $("skeBody").value = d.body || "";
    setSkeStatus("原文 " + (d.body || "").length.toLocaleString() + " 字"
      + (d.editable ? "" : "（只读副本，保存会失败 —— 先「复制到我的」）"), d.editable ? "" : "err");
    if (!d.editable) {
      $("skeSave").disabled = true;
      $("skeSave").textContent = "内置只读";
    } else {
      $("skeSave").disabled = false;
      $("skeSave").textContent = "保存";
    }
  }).catch(function (e) {
    setSkeStatus("读不到原文：" + e.message, "err");
  });
}

function setSkeStatus(msg, kind) {
  var el = $("skeStatus");
  el.className = "cfg-status" + (kind ? " " + kind : "");
  el.textContent = msg;
}

function saveSkillEdit() {
  var fields = {
    name: $("skeName").value.trim(),
    category: $("skeCat").value.trim(),
    icon: $("skeIcon").value,
    desc: $("skeDesc").value.trim(),
    note: $("skeNote").value.trim(),
    inject_extra: $("skeInject").value.split("\n").map(function (x) { return x.trim(); })
      .filter(function (x) { return !!x; }),
    content: $("skeBody").value
  };
  if (!fields.name) { setSkeStatus("名字不能空", "err"); return; }
  if (!fields.content.trim()) { setSkeStatus("正文不能空 —— 那才是发给模型的东西", "err"); return; }

  var p;
  if (state.skEditNew) {
    fields.id = $("skeId").value.trim();
    p = WW.createSkill(fields);
  } else {
    p = WW.saveSkill(state.skEditId, fields);
  }

  p.then(function (sk) {
    setSkeStatus("✓ 已保存到 " + sk.path, "ok");
    toast("「" + sk.name + "」保存好了");
    state.skEditId = sk.id;
    state.skEditNew = false;
    $("skeId").value = sk.id;
    $("skeId").disabled = true;
    return loadSkills();
  }).catch(function (e) {
    setSkeStatus("✗ " + e.message, "err");
  });
}

function delSkill(id) {
  var s = findSkill(id);
  if (s && !s.editable) {
    toast("内置 skill 删不掉 —— 它是插件的一部分，删了下次更新还会回来。想不用它就换个 skill。", true);
    return;
  }
  if (!window.confirm("删除 skill「" + (s ? s.name : id) + "」？\n\n"
    + "整个目录会被删掉（含 references），没法恢复。\n位置：" + (s ? s.path : "?"))) return;

  WW.deleteSkill(id).then(function () {
    toast("删掉了");
    if (state.masterId === id) state.masterId = null;
    state.refIds = state.refIds.filter(function (r) { return r !== id; });
    if (state.skEditId === id) closeSheet();
    return loadSkills();
  }).catch(function (e) {
    toast("删除失败：" + e.message, true);
  });
}

function dupSkill(id) {
  WW.duplicateSkill(id, {}).then(function (sk) {
    toast("已复制成「" + sk.name + "」—— 现在它是你的了，随便改", true);
    return loadSkills().then(function () { openSkillEditor(sk.id); });
  }).catch(function (e) {
    toast("复制失败：" + e.message, true);
  });
}

function exportSkill(id) {
  WW.exportSkill(id).then(function (d) {
    downloadText(d.filename || (id + ".SKILL.md"), d.text || "");
    toast("导出了 SKILL.md 原文（未剥离、未适配），可以直接搬去 WorkBuddy 的 skills/");
  }).catch(function (e) {
    toast("导出失败：" + e.message, true);
  });
}

/** 存成文件下载。iframe 没加 sandbox，同源，所以 download 属性是生效的。 */
function downloadText(filename, text) {
  try {
    var blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename || "download.txt";
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      URL.revokeObjectURL(url);
      if (a.parentNode) a.parentNode.removeChild(a);
    }, 800);
    return true;
  } catch (e) {
    toast("这个环境不让下载，正文已经复制到剪贴板了", true);
    copyText(text);
    return false;
  }
}

/** 复制到剪贴板，返回 Promise<boolean>（true = 真的复制成功了）。
 *
 * ⚠️ 别只信 navigator.clipboard：面板跑在同源 iframe 里，http 页面 + 权限策略
 * 都可能让它直接 reject，而 reject 是静默的 —— 表现就是"按钮点了完全没反应"。
 * 所以必须留一条 execCommand 的老路兜底，它在同源 iframe 里一直好使。 */
function copyText(t) {
  var text = String(t == null ? "" : t);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text).then(
      function () { return true; },
      function () { return legacyCopy(text); }
    );
  }
  return Promise.resolve(legacyCopy(text));
}

function legacyCopy(text) {
  try {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;top:-1000px;left:0;opacity:0";
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    var ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return !!ok;
  } catch (e) {
    return false;
  }
}

/* ------------------------------------------------- 消息上的复制（气泡下方那枚小图标） */

/** 复制图标按钮。
 *
 * 两个图标（复制 / 对勾）都渲染出来，露哪个由 CSS 决定 —— JS 只负责加一个 class，
 * 不去改 display。跟顶栏那个主题按钮同一套路，省得状态两边记、对不上。
 *
 * 这里只传下标，不把正文塞进事件属性：一条提示词动辄上千字，
 * 拼进属性要一路转义，长度还爆表；下标最稳。 */
function copyBtn(idx, title) {
  return '<button class="mcopy" onclick="copyMsg(' + idx + ',this)" title="' + esc(title) + '">'
    + '<svg class="ic sm ic-copy" viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"/>'
    + '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>'
    + '<svg class="ic sm ic-done" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>'
    + "</button>";
}

/** 复制整条消息。助手那条是按原文复制的（```prompt 围栏一并带上）——
 *  气泡上的图标给的是"这条回复的全部内容"，只想拿纯提示词的话用卡片上那个「复制」。 */
function copyMsg(idx, btn) {
  var m = ((state.chat && state.chat.msgs) || [])[idx];
  var t = (m && m.text) || "";
  if (!t.trim()) { toast("这条没内容可复制", true); return; }
  doCopy(t, btn);
}

/** 卡片上的「复制」：只复制提示词正文，不带 ```prompt 围栏 ——
 *  粘进 ComfyUI 的正向框就能直接用。
 *
 *  正文从 msgs 现算一份，而不是读 DOM：重新 split 一遍跟卡片的生成规则永远一致，
 *  不会因为剥空格、转义之类的小差异跟眼前看到的对不上。 */
function copyCard(idx, cardIdx, btn) {
  var m = ((state.chat && state.chat.msgs) || [])[idx];
  if (!m) { toast("这条消息已经不在了", true); return; }
  var cards = splitMessage(m.text).filter(function (p) { return p.kind === "card"; });
  var c = cards[cardIdx];
  if (!c) { toast("这张卡片已经不在了", true); return; }
  doCopy(c.text, btn);
}

/** 复制 + 按钮反馈。
 *  成功不出 toast（对勾就在手边，再弹一条反而吵），**失败必须出声** ——
 *  静默失败最气人：点了没反应，你也不知道为什么。 */
function doCopy(text, btn) {
  copyText(text).then(function (ok) {
    if (!ok) { toast("复制失败，手动选中再 Ctrl+C 吧", true); return; }
    if (!btn) return;
    btn.classList.add("done");
    clearTimeout(btn._doneT);
    btn._doneT = setTimeout(function () { btn.classList.remove("done"); }, 1200);
  });
}

/* ---------------------------------------------------------------- 目录导入 */

function openImport(dir) {
  state.skImportItems = [];
  state.skImportSel = {};
  $("impDir").value = dir || $("impDir").value || "";
  $("impList").innerHTML = '<div class="skempty">'
    + "填上面那个目录的**绝对路径**，点「扫描」。<br>"
    + "支持两种放法：目录本身就是 skill（里面有 SKILL.md），"
    + "或者目录下每个子目录是一个 skill —— WorkBuddy 的 <code>~/.workbuddy/skills</code> 就是后一种。"
    + "</div>";
  $("impStatus").className = "cfg-status";
  $("impStatus").textContent = "还没扫描";
  $("impOverwrite").checked = false;
  openSheet("skimport");
}

function scanImport() {
  var dir = $("impDir").value.trim();
  if (!dir) { setImpStatus("先填目录路径", "err"); return; }
  setImpStatus("正在扫描…", "busy");
  $("impList").innerHTML = '<div class="skempty">扫描中…</div>';

  WW.scanImportDir(dir).then(function (d) {
    state.skImportDir = d.path;
    state.skImportItems = d.items || [];
    state.skImportSel = {};
    (d.items || []).forEach(function (it) { state.skImportSel[it.id] = !it.exists; });
    renderImportList();
    setImpStatus("扫到 " + d.count + " 个 skill · 目录 " + d.path
      + (d.count ? "" : "（这个目录里没有带 SKILL.md 的子目录）"), d.count ? "ok" : "");
  }).catch(function (e) {
    state.skImportItems = [];
    $("impList").innerHTML = "";
    setImpStatus("✗ " + e.message, "err");
  });
}

function setImpStatus(msg, kind) {
  var el = $("impStatus");
  el.className = "cfg-status" + (kind ? " " + kind : "");
  el.textContent = msg;
}

function renderImportList() {
  var el = $("impList");
  var items = state.skImportItems;
  if (!items.length) {
    el.innerHTML = '<div class="skempty">这个目录里没扫到带 SKILL.md 的 skill</div>';
    return;
  }
  el.innerHTML = items.map(function (it) {
    var on = !!state.skImportSel[it.id];
    return '<div class="improw' + (on ? " on" : "") + '" onclick="toggleImportId(\'' + jsid(it.id) + '\')">'
      + '<span class="impbox">' + (on ? "✓" : "") + "</span>"
      + '<span class="imp-main"><span class="imp-name">' + esc(it.name)
      + (it.exists ? '<span class="imp-exists" title="'
        + esc(it.exists_source === "user" ? "你自己目录里已经有了" : "插件内置已有同名") + '">'
        + (it.exists_source === "user" ? "已存在" : "覆盖内置") + "</span>" : "")
      + "</span>"
      + '<span class="imp-desc">' + esc(it.desc || it.id) + "</span></span>"
      + '<span class="imp-meta">' + it.files + " 文件 · " + fmtKB(it.bytes) + "</span>"
      + "</div>";
  }).join("");
}

function toggleImportId(id) {
  state.skImportSel[id] = !state.skImportSel[id];
  renderImportList();
  updateImportBtn();
}

function toggleImportAll(on) {
  state.skImportItems.forEach(function (it) { state.skImportSel[it.id] = on; });
  renderImportList();
  updateImportBtn();
}

function updateImportBtn() {
  var n = Object.keys(state.skImportSel).filter(function (k) { return state.skImportSel[k]; }).length;
  $("impRun").textContent = n ? ("导入选中的 " + n + " 个") : "导入选中";
  $("impRun").disabled = !n;
}

function runImportNow() {
  var ids = state.skImportItems.map(function (it) { return it.id; })
    .filter(function (id) { return state.skImportSel[id]; });
  if (!ids.length) { setImpStatus("先在上面勾几个", "err"); return; }

  var ow = $("impOverwrite").checked;
  setImpStatus("正在拷贝…", "busy");
  $("impRun").disabled = true;

  WW.runImport(state.skImportDir, ids, ow).then(function (d) {
    var okN = d.imported || 0;
    var fails = (d.results || []).filter(function (r) { return !r.ok; });
    var msg = "✓ 导入了 " + okN + " 个 → " + d.to;
    if (fails.length) {
      msg += "\n没导入的：" + fails.map(function (r) { return r.id + "（" + r.why + "）"; }).join("；");
    }
    setImpStatus(msg, fails.length ? "warn" : "ok");
    toast("导入了 " + okN + " 个 skill" + (fails.length ? "，" + fails.length + " 个跳过" : ""), true);
    if (okN) loadSkills();
    // 重扫一遍，把"已存在"标记刷新成最新状态
    return WW.scanImportDir(state.skImportDir).then(function (d2) {
      state.skImportItems = d2.items || [];
      state.skImportSel = {};
      (d2.items || []).forEach(function (it) { state.skImportSel[it.id] = false; });
      renderImportList();
      updateImportBtn();
    });
  }).catch(function (e) {
    setImpStatus("✗ " + e.message, "err");
  }).then(function () {
    $("impRun").disabled = false;
    updateImportBtn();
  });
}

function useImportPreset(which) {
  var dirs = {
    wb: "%USERPROFILE%\\.workbuddy\\skills",
    mine: "user/default/WindWhisper/skills"
  };
  if (which === "wb") {
    toast("把路径换成你自己的（把 %USERPROFILE% 展开成 C:\\Users\\你的用户名）再扫描");
  }
  $("impDir").value = dirs[which] || "";
}

/* ==================================================== 词库（阶段 4）
 *
 * 存 `user/default/WindWhisper/library.json`，一个文件装全部条目。
 * 条目小、条数多 → 整库读写 + 原子替换，比"一条一个文件"省事也更快。
 */

function loadLib() {
  return WW.listLibrary({ kw: "", cat: "", fav: false }).then(function (d) {
    state.libItems = d.items || [];
    state.libCats = d.cats || [];
    state.libFile = d.file || "";
    state.libMode = "live";
    if (!findLib(state.libSelId)) state.libSelId = state.libItems.length ? state.libItems[0].id : null;
    renderLibCats();
    renderLibItems();
    renderLibDetail();
    return d;
  }).catch(function (err) {
    console.warn("[风语] 读不到词库：", err.message);
    state.libItems = [];
    state.libCats = [];
    state.libMode = "demo";
    renderLibCats();
    renderLibItems();
    renderLibDetail();
    return null;
  });
}

function findLib(id) {
  return state.libItems.filter(function (it) { return it.id === id; })[0] || null;
}

/** 当前筛选条件下的条目（分类 + 收藏 + 搜索都在前端做，一次拉全库，切筛选零延迟）。 */
function libView() {
  var kw = ($("libSearch") ? $("libSearch").value : "").trim().toLowerCase();
  return state.libItems.filter(function (it) {
    if (state.libFav && !it.fav) return false;
    if (state.libCat !== "全部" && (it.cat || "") !== state.libCat) return false;
    if (!kw) return true;
    var hay = [it.name || "", it.cat || "", (it.tags || []).join(" "), it.text || "", it.skillId || ""]
      .join(" ").toLowerCase();
    return hay.indexOf(kw) >= 0;
  });
}

function renderLibCats() {
  var cats = ["全部"].concat(state.libCats);
  var html = cats.map(function (c) {
    return '<button class="lcat' + (c === state.libCat ? " active" : "") + '"'
      + ' onclick="pickLibCat(\'' + esc(c) + '\')">' + esc(c) + "</button>";
  }).join("");
  html += '<button class="lcat' + (state.libFav ? " active" : "") + '" onclick="toggleLibFav()">'
    + (state.libFav ? "★ 只看收藏" : "☆ 只看收藏") + "</button>";
  $("libCats").innerHTML = html;
}

function pickLibCat(c) {
  state.libCat = c;
  renderLibCats();
  renderLibItems();
}

function toggleLibFav() {
  state.libFav = !state.libFav;
  renderLibCats();
  renderLibItems();
}

function renderLibItems() {
  var list = libView();
  var el = $("libItems");
  if (!list.length) {
    el.innerHTML = '<div class="lib-empty">' + (state.libItems.length
      ? "这个筛选下没有条目"
      : (state.libMode === "demo"
        ? "读不到词库接口（面板单独预览时会这样）"
        : "词库还是空的。聊出满意的提示词，点卡片上的「存库」就进来了。"))
      + "</div>";
    return;
  }
  el.innerHTML = list.map(function (it) {
    var on = it.id === state.libSelId;
    var tags = (it.tags || []).join(" · ");
    return '<div class="lrow' + (on ? " active" : "") + '" onclick="pickLib(\'' + jsid(it.id) + '\')">'
      + '<div class="n">' + (it.fav ? '<span class="fav">★</span>' : "")
      + (it.skillId ? '<span class="mode">' + esc(it.skillId) + "</span>" : "")
      + esc(it.name || "未命名") + "</div>"
      + '<div class="m">' + esc(fmtWhen(it.updated || it.created))
      + (it.cat ? " · " + esc(it.cat) : "") + (tags ? " · " + esc(tags) : "") + "</div>"
      + '<div class="p">' + esc(it.text || "") + "</div>"
      + "</div>";
  }).join("");
}

function pickLib(id) {
  var it = findLib(id);
  if (!it) return;
  state.libSelId = id;
  $("libName").value = it.name || "";
  $("libCat").value = it.cat || "";
  $("libTags").value = (it.tags || []).join(", ");
  $("libText").value = it.text || "";
  renderLibItems();
  renderLibDetail();
}

function renderLibDetail() {
  var it = findLib(state.libSelId);
  $("libFavBtn").textContent = it && it.fav ? "★ 已收藏" : "☆ 收藏";
  $("libMeta").textContent = it
    ? "来源 " + (it.skillId || "—") + " · 模型 " + (it.model || "—")
      + " · 更新 " + fmtWhen(it.updated || it.created)
      + " · " + (it.text || "").length.toLocaleString() + " 字"
    : (state.libMode === "demo" ? "词库接口不可达" : "左侧还没有条目");
  $("libFile").textContent = state.libFile || "user/default/WindWhisper/library.json";
  if (state.libFile) $("libFile").title = state.libFile;
}

function newLibItem() {
  state.libSelId = null;
  $("libName").value = "";
  $("libCat").value = state.libCat === "全部" ? "" : state.libCat;
  $("libTags").value = "";
  $("libText").value = "";
  renderLibItems();
  renderLibDetail();
  $("libText").focus();
  toast("填内容后点「保存」—— 名字留空会自动取正文第一句");
}

function saveLibItem() {
  var fields = {
    id: state.libSelId || undefined,
    name: $("libName").value.trim(),
    cat: $("libCat").value.trim(),
    tags: $("libTags").value,
    text: $("libText").value
  };
  if (!fields.text.trim()) { toast("正文是空的，先写点什么", true); return; }

  WW.saveLibItem(fields).then(function (d) {
    var saved = d.item;
    var i = -1;
    state.libItems.forEach(function (it, idx) { if (it.id === saved.id) i = idx; });
    if (i >= 0) state.libItems[i] = saved; else state.libItems.unshift(saved);
    state.libSelId = saved.id;
    state.libCats = d.cats || state.libCats;
    renderLibCats();
    renderLibItems();
    renderLibDetail();
    toast("已保存「" + saved.name + "」");
  }).catch(function (e) {
    toast("保存失败：" + e.message, true);
  });
}

function delLibItem() {
  var it = findLib(state.libSelId);
  if (!it) { toast("左边先选一条", true); return; }
  if (!window.confirm("删除词条「" + (it.name || "未命名") + "」？没法恢复。")) return;
  WW.deleteLibItem(it.id).then(function (d) {
    state.libItems = state.libItems.filter(function (x) { return x.id !== it.id; });
    state.libCats = d.cats || state.libCats;
    state.libSelId = state.libItems.length ? state.libItems[0].id : null;
    renderLibCats();
    renderLibItems();
    pickLib(state.libSelId);
    toast("删掉了");
  }).catch(function (e) {
    toast("删除失败：" + e.message, true);
  });
}

function toggleLibFavItem() {
  var it = findLib(state.libSelId);
  if (!it) { toast("左边先选一条", true); return; }
  WW.saveLibItem({ id: it.id, fav: !it.fav }).then(function (d) {
    it.fav = d.item.fav;
    renderLibItems();
    renderLibDetail();
  }).catch(function (e) { toast("操作失败：" + e.message, true); });
}

function exportLib() {
  WW.exportLibrary().then(function (d) {
    if (!d.chars) { toast("词库是空的，没什么可导", true); return; }
    downloadText(d.filename || "windwhisper-library.txt", d.text || "");
    toast("导出了 " + d.chars.toLocaleString() + " 字的纯文本");
  }).catch(function (e) {
    toast("导出失败：" + e.message, true);
  });
}

/* ------------------------------------------------------------ 推送到节点 */

/** 卡片上的「推到节点」。
 *
 * 负面词默认**不带** —— 它只挂在那张卡片里等你决定。点了「推送时带上」才拼进去
 * （用空行分隔，因为风语节点只有一个 text 控件，没地方单独放负面词）。 */
function pushNode(cardId) {
  var card = $(cardId);
  if (!card) return;
  var body = card.querySelector(".body");
  var text = body ? body.textContent.trim() : "";

  var sec = $(cardId + "-neg");
  if (sec && sec.classList.contains("on")) {
    var nb = sec.querySelector(".negbody");
    var nt = nb ? nb.textContent.trim() : "";
    if (nt) text = text + "\n\n" + nt;
  }
  requestPush(text, "chat", cardId);
}

/** 负面词区的「推送时带上」开关。 */
function toggleNeg(cardId, btn) {
  var sec = $(cardId + "-neg");
  if (!sec) return;
  var on = sec.classList.toggle("on");
  if (btn) {
    btn.classList.toggle("on", on);
    btn.textContent = on ? "不带负面词" : "推送时带上";
  }
}

/** 负面词区的「复制」：只取负面词那段，不动正向正文。 */
function copyNeg(negId, btn) {
  var sec = $(negId);
  var nb = sec ? sec.querySelector(".negbody") : null;
  var t = nb ? nb.textContent.trim() : "";
  if (!t) { toast("这段没有负面词", true); return; }
  doCopy(t, btn);
}

function pushFromLib() {
  requestPush($("libText").value.trim(), "library", null);
}

/** 发请求给主页面，等回执。没回执说明面板不是从 ComfyUI 里打开的。 */
function requestPush(text, source, cardId) {
  if (!text) { toast("这条是空的，没什么可推"); return; }

  pending = { cardId: cardId || null, text: text, source: source };
  sendToParent("windwhisper/push", { target: "selected", text: text, source: source });

  clearTimeout(pendingTimer);
  pendingTimer = setTimeout(function () {
    if (pending) {
      pending = null;
      toast("没收到主页面回执 —— 面板可能不是从 ComfyUI 里打开的？", true);
    }
  }, 8000);
}

function onPushed(msg) {
  clearTimeout(pendingTimer);
  var req = pending;
  pending = null;

  if (!msg.ok) {
    toast("推送失败：" + (msg.error || "未知原因"), true);
    return;
  }

  // 渐变标记唯一化：推 B 时自动清掉 A，保证「渐变 = 此刻节点里就是这条」
  var all = document.querySelectorAll(".card-note.pushed");
  for (var i = 0; i < all.length; i++) all[i].classList.remove("pushed");

  pushedCardId = (req && req.cardId) ? req.cardId : null;
  if (pushedCardId) {
    var card = $(pushedCardId);
    if (card) card.classList.add("pushed");
  }

  showPushedBar(req ? req.text : "", msg.nodeId);
  closeSheet();
  toast("已推到 节点 #" + msg.nodeId + " · 还要点一次 Queue Prompt 才会出图", true);
}

function showPushedBar(text, nodeId) {
  var t = (text || "").replace(/\s+/g, " ").trim();
  $("pushedTxt").textContent = t;
  $("pushedBadgeTxt").textContent = nodeId != null ? ("已推到 #" + nodeId) : "已推到节点";
  $("pushedBar").classList.add("show");
}

function hidePushedBar() {
  $("pushedBar").classList.remove("show");
}

function jumpToPushed() {
  if (!pushedCardId) {
    toast("这条来自词库，不在对话历史里，没法定位");
    return;
  }
  var card = $(pushedCardId);
  if (!card) {
    toast("那条卡片不在当前会话里（可能你切过会话了）");
    return;
  }
  card.scrollIntoView({ behavior: "smooth", block: "center" });
  card.classList.remove("flash");
  void card.offsetWidth;
  card.classList.add("flash");
  setTimeout(function () { card.classList.remove("flash"); }, 1400);
}

/* -------------------------------------------------------------- 弹层开关 */

function openSheet(which) {
  $("mask").classList.add("open");
  $("sheetSkills").classList.toggle("open", which === "skills");
  $("sheetSkEdit").classList.toggle("open", which === "skedit");
  $("sheetSkImport").classList.toggle("open", which === "skimport");
  $("sheetLib").classList.toggle("open", which === "lib");
  $("sheetSkView").classList.toggle("open", which === "skview");
  $("sheetCfg").classList.toggle("open", which === "cfg");
  if (which === "lib") renderLibDetail();
}

function closeSheet() {
  $("mask").classList.remove("open");
  closeSkMenu();
}

/** 关掉所有弹层 —— 从编辑器/导入层「返回」到 skill 列表用。 */
function backToSkills() { openSheet("skills"); }

/* ------------------------------------------------------------------ 杂项 */

/** 对话卡片上的「存库」。存完立刻出现在词库弹层里，名字自动取正文第一句。 */
function saveToLib(cardId) {
  var card = $(cardId);
  var body = card ? card.querySelector(".body") : null;
  var t = body ? body.textContent.trim() : "";
  if (!t) { toast("这张卡片是空的", true); return; }

  WW.saveLibItem({
    name: "",
    cat: "",
    tags: state.masterId ? [state.masterId] : [],
    text: t,
    skillId: state.masterId || null,
    model: (state.cfg && state.cfg.model) || null
  }).then(function (d) {
    var saved = d.item;
    state.libItems.unshift(saved);
    state.libCats = d.cats || state.libCats;
    renderLibCats();
    renderLibItems();
    toast("已存进词库：「" + saved.name + "」—— 顶栏书本图标里能改名和分类", true);
  }).catch(function (e) {
    copyText(t);
    toast("存库失败（" + e.message + "），已经先帮你复制到剪贴板了", true);
  });
}

function copyLibText() {
  var t = $("libText");
  if (!t || !t.value) { toast("没什么可复制的", true); return; }
  copyText(t.value).then(function (ok) {
    if (ok) { toast("已复制到剪贴板"); return; }
    t.select();   // 兜底都没成 → 至少帮你选中，Ctrl+C 一下就走
    toast("自动复制失败，已经帮你选中了，Ctrl+C 吧", true);
  });
}

function loadLibToComposer() {
  var t = $("libText");
  if (!t || !t.value.trim()) { toast("左边先选一条", true); return; }
  var box = $("composerInput");
  box.value = t.value;
  closeSheet();
  box.focus();
  autoGrow(box);
  toast("已载入到输入框，可以在这条基础上继续改");
}

function toast(msg, keep) {
  var el = document.createElement("div");
  el.className = "toast";
  el.innerHTML = svg('<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>')
    + "<span>" + msg + "</span>";
  $("toasts").appendChild(el);
  setTimeout(function () {
    el.style.opacity = "0";
    el.style.transition = "opacity .3s";
    setTimeout(function () { el.remove(); }, 300);
  }, keep ? 4200 : 2600);
}

document.addEventListener("keydown", function (ev) {
  if (ev.key !== "Escape") return;
  if (skMenuEl) { closeSkMenu(); return; }          // 小菜单优先关，别一把关掉整层
  if ($("mask").classList.contains("open")) { closeSheet(); return; }
  if ($("drawer").classList.contains("open")) { toggleDrawer(); return; }
  closePanel();
});

/* ------------------------------------------------------------------ 启动 */

var composer = $("composerInput");

composer.addEventListener("input", function () { autoGrow(this); });

/* Enter 发送 / Shift+Enter 换行。
 * isComposing 必须判 —— 中文输入法敲回车选字的时候也会触发 keydown，
 * 不判就会"选个字就把半句话发出去了"。 */
composer.addEventListener("keydown", function (ev) {
  if (ev.key !== "Enter" || ev.shiftKey || ev.isComposing || ev.keyCode === 229) return;
  ev.preventDefault();
  sendMessage();
});

/* 图片的四个入口，全走 readImageFile → encodeImage 这一条路：
 *   ① 附件按钮（HTML onclick → attachImage）
 *   ② 选文件（下面这个 change）
 *   ③ Ctrl+V 粘贴 —— 平时"复制一张图来反推"最顺手的就是它
 *   ④ 把图拖进面板
 * 注意 change 之后必须把 input.value 清空 —— 否则再选**同一张**图不会触发 change。 */
$("imgFile").addEventListener("change", function () {
  var f = this.files && this.files[0];
  this.value = "";
  readImageFile(f);
});

document.addEventListener("paste", function (ev) {
  var items = (ev.clipboardData && ev.clipboardData.items) || [];
  for (var i = 0; i < items.length; i++) {
    if (items[i].type && items[i].type.indexOf("image/") === 0 && items[i].kind === "file") {
      readImageFile(items[i].getAsFile());
      ev.preventDefault();     // 别让浏览器把图当富文本再塞进输入框
      return;
    }
  }
});

/* 拖进来。dragover 必须 preventDefault，否则浏览器默认行为是"不允许放置"，drop 根本不触发。 */
["dragover", "drop"].forEach(function (type) {
  document.addEventListener(type, function (ev) {
    var dt = ev.dataTransfer;
    if (!dt || !dt.types || Array.prototype.indexOf.call(dt.types, "Files") < 0) return;
    ev.preventDefault();
    if (type !== "drop") return;
    var files = dt.files || [];
    for (var i = 0; i < files.length; i++) {
      if (/^image\//.test(files[i].type || "")) { readImageFile(files[i]); return; }
    }
    toast("拖进来的东西里没有图片", true);
  });
});

// 主题要先定下来再渲染 —— 否则会先闪一下浅色再跳深色
initTheme();

// 形态先按侧边栏落定，真实的形态等父页面 init 时告知（单独打开面板时没有父页面，就是侧边栏语义）
applyPanelMode("dock");

// 芯片条的横滑（窄边栏里一屏放不下全部 skill）
bindChipsScroll();

// 拖标题栏挪大窗：主顶栏 + 每个弹层的标题栏（后端设置那个也是用户指定的把手）
bindTitleDrag(document.querySelector(".topbar"));
Array.prototype.forEach.call(document.querySelectorAll(".sheet-head"), bindTitleDrag);

// 快速填地址那一排（含你自己加的）
renderBasePresets();

updateSendBtn();
renderBackend();
updateImportBtn();
renderLibCats();
renderLibItems();

// skill 列表（内部会渲染芯片 / 分类 / 卡片）
loadSkills();
loadConfig();
// 词库（独立拉，接口不通时退回空态并标记）
loadLib();

// 会话：有就打开最近一个，没有就现建一个
loadChats().then(function (items) {
  if (items.length) openChat(items[0].id, true);
  else newChat();
});

// 面板加载完，向主页面要初始状态（主题 + 画布上的风语节点列表）
sendToParent("windwhisper/ready", {});
