/**
 * WindWhisper · 主页面侧扩展（🍃 风语）
 *
 * 职责只有五件：
 *   1. 画布上挂一个**可拖动的悬浮按钮**（位置记住）：单击开关面板、双击切换形态
 *   2. 面板有**两种形态**，共用同一套 DOM，只切 class：
 *        ① 右侧停靠边栏（默认，左边缘可拖宽）
 *        ② 居中大窗（右下角可拖大小、顶部拖动条可挪位置 + 双击回正中，带一层淡遮罩，点遮罩收起）
 *      两种形态各自记住自己的尺寸，顶栏那个放大按钮和双击都能切
 *   3. 提供入口打开面板（顶栏菜单 + 节点上的按钮）
 *   4. 处理面板发来的 postMessage —— 核心是「推到节点」
 *   5. 把 ComfyUI 当前主题告诉面板（iframe 里读不到主题变量）
 *
 * 边栏态**没有遮罩**：面板浮在画布右侧，画布照常能点、能拖节点，
 * 这才是"提示词搭子"该有的样子 —— 边看图边调词。居中态才加遮罩。
 *
 * ⚠️ 协议名（windwhisper/*）与 web/panel/app.js 双侧同改，漏改一边会静默失效。
 */

import { app } from "../../scripts/app.js";

/* ★ 面板资源版本：改 web/ 下任何文件都要 +1，和 index.html 里那两处 ?v= 以及
 * 底部印的那行小字**同一个值**（静态检查盯着一致性，别改漏）。
 * 为什么要它：用户报"改了看不见"，十有八九是缓存。这个值一变，iframe 的 URL 就变，
 * 浏览器必然重新拉 index.html、连带里面带 ?v= 的 css/js —— 普通 F5 也就够了，
 * 不必非得 Ctrl+Shift+R 硬刷。 */
const PANEL_VER = "20260924j";
const PANEL_URL = "/extensions/ComfyUI-WindWhisper/panel/index.html?v=" + PANEL_VER;
const NODE_TYPE = "WindWhisper_Prompt";
const OVERLAY_ID = "windwhisper-overlay";
const FAB_ID = "windwhisper-fab";
const STYLE_ID = "windwhisper-style";

/* 面板宽度：默认窄边栏，左边缘拖动可调。存 localStorage，下次打开还是这个宽度。 */
const W_KEY = "windwhisper_panel_w_v1";
const W_DEFAULT = 420;
const W_MIN = 320;
const W_MAX = 1040;

/* 形态：dock = 右侧停靠边栏（默认），modal = 居中大窗。两种形态各记各的尺寸。 */
const MODE_KEY = "windwhisper_panel_mode_v1";
const M_KEY = "windwhisper_panel_modal_v1";
/* 居中大窗的**位置偏移**（相对屏幕正中，单位 px）。存偏移而不是存绝对坐标 ——
 * 换个窗口大小再打开，相对正中的偏移仍然成立，绝对坐标会跑到屏幕外。
 * 拖面板标题栏改的就是它（协议见 onPanelDrag），双击回正 = 归零。 */
const MP_KEY = "windwhisper_panel_modal_pos_v1";
const M_DEFAULT = { w: 980, h: 780 };
const M_MIN = { w: 460, h: 380 };
const M_MAX_W = 1400;
const M_MAX_H = 1100;

/* 悬浮按钮：位置也记住。默认贴右下角，并往上抬一点避开 ComfyUI 自带的底部控件。 */
const FAB_KEY = "windwhisper_fab_pos_v1";
const FAB_SIZE = 46;
const FAB_GAP = 8;      // 与视口边缘的最小间距
const FAB_LIFT = 74;    // 默认位置距底部的高度（让开 ComfyUI 底部那排按钮）

let overlay = null;
let frame = null;
let frameWrap = null;
let fab = null;
let lastTargetId = null;
let panelOpen = false;
let mode = "dock";      // 当前形态；openPanel 时按记忆值校正
let fabSaved = null;    // 用户拖动后记住的位置（意图位置，不受临时避让影响）

/* ------------------------------------------------------------------ 样式 */

function injectStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
/* ---- 面板：两种形态共用同一套 DOM，只切 class（二选一） ----
   ① .ww-dock  右侧停靠边栏（无遮罩，画布照常能点）
   ② .ww-modal 居中大窗（带一层淡遮罩，点遮罩即收起）
   ⚠️ 千万别做成两套 DOM —— 聊天记录、滚动位置、DOM 引用全在 iframe 里，
      两份界面必然对不上，那种 bug 查起来要命。 */
#${OVERLAY_ID}{position:fixed;z-index:10000;display:flex;pointer-events:none}
#${OVERLAY_ID}.ww-hidden{display:none}
#${OVERLAY_ID}.ww-dock{top:10px;left:0;right:10px;bottom:10px;justify-content:flex-end}
#${OVERLAY_ID}.ww-modal{top:0;left:0;right:0;bottom:0;align-items:center;justify-content:center}
/* 居中态的遮罩：很淡，只为"点外面能收起"，不抢画布的辨识度 */
#${OVERLAY_ID} .ww-mask{
  position:absolute;top:0;left:0;right:0;bottom:0;display:none;
  background:rgba(14,12,28,.34);pointer-events:auto;
}
#${OVERLAY_ID}.ww-modal .ww-mask{display:block}

#${OVERLAY_ID} .ww-frame-wrap{
  position:relative;border-radius:12px;overflow:hidden;pointer-events:auto;
  border:1px solid rgba(128,118,190,.28);
  box-shadow:0 26px 70px -22px rgba(0,0,0,.62),0 2px 10px rgba(0,0,0,.26);
  /* 纵向排版：iframe 撑满整个壳（原来上面还有一条拖动条，2026-09-23 去掉了） */
  display:flex;flex-direction:column;
}
#${OVERLAY_ID}.ww-dock .ww-frame-wrap{height:100%;width:${W_DEFAULT}px;max-width:calc(100vw - 20px)}
#${OVERLAY_ID}.ww-modal .ww-frame-wrap{
  width:${M_DEFAULT.w}px;height:${M_DEFAULT.h}px;
  max-width:calc(100vw - 48px);max-height:calc(100vh - 48px);
}
/* 居中态挪窗：把手改成**面板自己的标题栏**（2026-09-23 改）。
   原来在外壳这层加了一条浅紫拖动条，用户嫌"平白多一栏"。
   但面板在自己 iframe 里，外壳收不到它的指针事件 —— 所以改由面板 postMessage
   把位移报出来，外壳只负责夹取 + 记忆 + 落 transform（协议见 onPanelDrag）。
   ⚠️ 拖动期间**不要**给 iframe 加 pointer-events:none。drag 是从 iframe 里发起的，
   关掉它的指针事件等于把拖动本身掐断（老拖动条长在外壳上，才敢那么写）。 */
/* 拖动大窗时把遮罩压到几乎没有 —— 用户挪窗就是为了看底下的节点，
   这会儿还糊着一层就没意义了；松手再恢复。 */
#${OVERLAY_ID}.ww-moving .ww-mask{background:rgba(14,12,28,.06)}
/* ⚠️ iframe 不能写 height:100% —— 外壳是纵向 flex，100% 算的是**整个**壳高，
   会被 overflow:hidden 切掉一截。用 flex:1 1 0 精确吃掉"剩下的高度"，两种形态都对。 */
#${OVERLAY_ID} iframe{width:100%;flex:1 1 0;min-height:0;border:0;display:block;background:#fff}

/* 边栏态：左边缘的拖宽把手 —— 平时隐形，鼠标移上去才露出一条细杠 */
#${OVERLAY_ID} .ww-resize{position:absolute;left:0;top:0;bottom:0;width:7px;cursor:col-resize;z-index:5;display:none}
#${OVERLAY_ID}.ww-dock .ww-resize{display:block}
#${OVERLAY_ID} .ww-resize::after{
  content:'';position:absolute;left:2px;top:50%;transform:translateY(-50%);
  width:3px;height:46px;border-radius:2px;background:rgba(139,124,246,.85);opacity:0;transition:opacity .15s;
}
#${OVERLAY_ID} .ww-resize:hover::after{opacity:1}
#${OVERLAY_ID}.ww-resizing .ww-resize::after{opacity:1}

/* 居中态：右下角拖大小（两条直角边，就是通用的 resize 图标画法） */
#${OVERLAY_ID} .ww-resize-se{position:absolute;right:0;bottom:0;width:15px;height:15px;cursor:nwse-resize;z-index:6;display:none}
#${OVERLAY_ID}.ww-modal .ww-resize-se{display:block}
#${OVERLAY_ID} .ww-resize-se::after{
  content:'';position:absolute;right:3px;bottom:3px;width:9px;height:9px;
  border-right:2px solid rgba(139,124,246,.9);border-bottom:2px solid rgba(139,124,246,.9);
  border-bottom-right-radius:2px;opacity:.55;transition:opacity .15s;
}
#${OVERLAY_ID} .ww-resize-se:hover::after{opacity:1}
#${OVERLAY_ID}.ww-resizing .ww-resize-se::after{opacity:1}
#${OVERLAY_ID}.ww-resizing iframe{pointer-events:none}

/* ---- 悬浮按钮 ---- */
#${FAB_ID}{
  position:fixed;z-index:10001;width:${FAB_SIZE}px;height:${FAB_SIZE}px;border-radius:50%;
  display:grid;place-items:center;padding:0;cursor:grab;touch-action:none;
  border:1px solid rgba(167,139,250,.45);
  background:linear-gradient(135deg,#6E60E8 0%,#534AB7 100%);
  color:#fff;box-shadow:0 10px 26px -10px rgba(83,74,183,.9),0 2px 8px rgba(0,0,0,.3);
  transition:box-shadow .18s,transform .18s,opacity .18s;
}
#${FAB_ID} svg{width:22px;height:22px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;pointer-events:none}
#${FAB_ID}:hover{transform:translateY(-1px) scale(1.05);box-shadow:0 14px 30px -10px rgba(83,74,183,.95),0 3px 10px rgba(0,0,0,.32)}
#${FAB_ID}.ww-dragging{cursor:grabbing;transform:scale(1.06);transition:none}
/* 面板开着时按钮变"收起"语义：降一点对比度，但仍然可点（免得伸手去够面板角落的 ✕） */
#${FAB_ID}.ww-on{background:linear-gradient(135deg,#3A3570 0%,#272350 100%);border-color:rgba(167,139,250,.3)}
`;
  document.head.appendChild(style);
}

/* ------------------------------------------------- 悬浮按钮（可拖动 + 记忆） */

function readJSON(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch (err) { return null; }
}

function writeJSON(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch (err) { /* 隐私模式写不了，不影响用 */ }
}

function clampNum(v, lo, hi) { return Math.min(Math.max(v, lo), hi); }

/** 面板宽度：读记忆值 → 夹到 [320, min(1040, 视口-30)] */
function panelWidth() {
  const saved = parseFloat(readJSON(W_KEY));
  const max = Math.min(W_MAX, Math.max(W_MIN, window.innerWidth - 40));
  return clampNum(isFinite(saved) ? saved : W_DEFAULT, W_MIN, max);
}

function savePanelWidth(w) { writeJSON(W_KEY, Math.round(w)); }

/** 上次用的形态。读不出来、或值不认识，都当侧边栏。 */
function savedMode() {
  return readJSON(MODE_KEY) === "modal" ? "modal" : "dock";
}

/** 居中大窗尺寸：读记忆值 → 夹到 [下限, min(上限, 视口-48)]。 */
function modalSize() {
  const s = readJSON(M_KEY);
  // 先用 clampNum 保证上限不低于下限，否则 clampNum 会把下限也压掉
  const maxW = clampNum(window.innerWidth - 48, M_MIN.w, M_MAX_W);
  const maxH = clampNum(window.innerHeight - 48, M_MIN.h, M_MAX_H);
  const w = clampNum(s && isFinite(s.w) ? +s.w : M_DEFAULT.w, M_MIN.w, maxW);
  const h = clampNum(s && isFinite(s.h) ? +s.h : M_DEFAULT.h, M_MIN.h, maxH);
  return { w: w, h: h };
}

function saveModalSize(w, h) { writeJSON(M_KEY, { w: Math.round(w), h: Math.round(h) }); }

/**
 * 居中大窗允许的最大偏移。窗口是 `justify-content:center` 摆的，
 * 所以偏移 o 时左边距 = (视口宽 - 窗宽)/2 + o；要保证左右各留 8px 边距，
 * 上下限就是对称的 `(视口 - 窗尺寸)/2 - 8`。
 * 窗比视口还大时直接给 0（不给负值，否则会算出"必须反着挪"的怪结果）。
 */
function modalPosBounds() {
  const w = frameWrap ? frameWrap.offsetWidth : M_DEFAULT.w;
  const h = frameWrap ? frameWrap.offsetHeight : M_DEFAULT.h;
  return {
    x: Math.max(0, (window.innerWidth - w) / 2 - 8),
    y: Math.max(0, (window.innerHeight - h) / 2 - 8),
  };
}

function clampModalPos(ox, oy) {
  const b = modalPosBounds();
  return { x: clampNum(ox, -b.x, b.x), y: clampNum(oy, -b.y, b.y) };
}

/** 记住的位置偏移：读出来是个数就用，否则归零（居中）。 */
function modalPos() {
  const p = readJSON(MP_KEY);
  if (!p || !isFinite(p.x) || !isFinite(p.y)) return { x: 0, y: 0 };
  return clampModalPos(+p.x, +p.y);
}

function saveModalPos(x, y) { writeJSON(MP_KEY, { x: Math.round(x), y: Math.round(y) }); }

/** 把大窗当前的位置偏移写进 transform（dock 态要清掉，不然切过去还偏着）。 */
function applyModalPos() {
  if (!frameWrap) return;
  if (mode !== "modal") { frameWrap.style.transform = ""; return; }
  const p = modalPos();
  frameWrap.style.transform = "translate(" + p.x + "px," + p.y + "px)";
}

/**
 * 落形态：切 class → 按形态设尺寸 → 通知面板 → 让悬浮按钮重新避让。
 *
 * 尺寸写在内联样式上，所以切过去时必须把对侧那条**清掉**（边栏只认 width、
 * 居中认 width+height），否则上一次形态留下的值会继续压着新形态。
 */
function applyMode(next) {
  mode = (next === "modal") ? "modal" : "dock";
  writeJSON(MODE_KEY, mode);
  if (!overlay) return;

  overlay.classList.toggle("ww-dock", mode === "dock");
  overlay.classList.toggle("ww-modal", mode === "modal");

  // 万一上一次拖动没收尾（面板中途刷新 / 消息丢了），这把脏状态得清掉，
  // 否则 .ww-moving 会一直挂着，遮罩永远是透的
  dragFrom = null;
  overlay.classList.remove("ww-moving");

  if (mode === "dock") {
    frameWrap.style.height = "";
    frameWrap.style.width = panelWidth() + "px";
  } else {
    const s = modalSize();
    frameWrap.style.width = s.w + "px";
    frameWrap.style.height = s.h + "px";
  }
  // 位置必须在尺寸之后算 —— 允许的偏移范围是从窗口尺寸推出来的
  applyModalPos();

  postToPanel("windwhisper/mode", { mode: mode });
  layoutFab();
}

/**
 * 双击的语义：**面板关着就直接开成居中大窗**（"我要大窗"），
 * 开着才在两种形态之间来回切。这样"双击 = 要大窗"这件事任何时候都成立，
 * 不会出现"上次停在居中，这次双击却缩成边栏"这种绕人的情况。
 */
function switchMode() {
  if (!panelOpen) { openPanel("modal"); return; }
  applyMode(mode === "dock" ? "modal" : "dock");
}

/** 把按钮摆到 (x,y)，并夹在视口内；返回夹完的真实位置。 */
function placeFab(x, y) {
  if (!fab) return { x: x, y: y };
  const pad = FAB_GAP;
  const maxX = Math.max(pad, window.innerWidth - FAB_SIZE - pad);
  const maxY = Math.max(pad, window.innerHeight - FAB_SIZE - pad);
  const cx = clampNum(x, pad, maxX);
  const cy = clampNum(y, pad, maxY);
  fab.style.left = cx + "px";
  fab.style.top = cy + "px";
  return { x: cx, y: cy };
}

function defaultFabPos() {
  return {
    x: window.innerWidth - FAB_SIZE - 18,
    y: window.innerHeight - FAB_SIZE - FAB_LIFT,
  };
}

/**
 * 摆放悬浮按钮。**只在边栏态**避让 —— 边栏从右边压过来时，
 * 按钮要是落在它底下就成了一个点不到的按钮。
 * 居中态不避让：面板在正中间，按钮本来就在角落的遮罩上，
 * 硬让它位反而会在切形态的一瞬间把它甩到别处，很怪。
 */
function layoutFab() {
  if (!fab) return;
  const base = fabSaved || defaultFabPos();
  let x = base.x;
  const y = base.y;

  if (panelOpen && mode === "dock" && frameWrap) {
    const rect = frameWrap.getBoundingClientRect();
    if (x + FAB_SIZE > rect.left - 4) {
      x = Math.max(FAB_GAP, rect.left - FAB_SIZE - FAB_GAP);
    }
  }
  placeFab(x, y);
}

/* 单击 = 开关面板，双击 = 在两种形态之间切。
 *
 * 单击必须等一下才知道是不是双击，所以有个 190ms 的延迟。这个值是有讲究的：
 * 太短会把"慢一点的双击"判成两次单击（面板开了又关），太长单击会明显发钝。
 * 190ms 是这两者的平衡点，别随手往上加。
 * 双击命中时会**撤掉**排队中的那一击，所以不会出现"先开边栏再跳居中"的闪动。 */
let fabClickTimer = null;
let fabFirstAt = 0;
const FAB_DBL_MS = 340;    // 双判定窗口：从第一击算起多久内的第二击算双击

function onFabActivate() {
  const now = Date.now();
  if (fabClickTimer && now - fabFirstAt <= FAB_DBL_MS) {
    clearTimeout(fabClickTimer);
    fabClickTimer = null;
    fabFirstAt = 0;
    switchMode();
    return;
  }
  fabFirstAt = now;
  fabClickTimer = setTimeout(() => {
    fabClickTimer = null;
    fabFirstAt = 0;
    togglePanel();
  }, 190);
}

function mountFab() {
  if (document.getElementById(FAB_ID)) return;

  fab = document.createElement("button");
  fab.id = FAB_ID;
  fab.type = "button";
  fab.title = "🍃 风语 · 提示词搭子 —— 点一下开关面板 · 双击切成居中大窗 · 按住可拖到顺手的位置";
  // 叶子图标（lucide leaf 的标准画法，不是手绘近似图形）
  fab.innerHTML =
    '<svg viewBox="0 0 24 24">'
    + '<path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z"/>'
    + '<path d="M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12"/>'
    + '</svg>';

  const saved = readJSON(FAB_KEY);
  fabSaved = (saved && typeof saved.x === "number" && typeof saved.y === "number")
    ? { x: saved.x, y: saved.y }
    : defaultFabPos();

  document.body.appendChild(fab);
  layoutFab();

  let drag = null;

  fab.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return;
    const rect = fab.getBoundingClientRect();
    drag = { id: ev.pointerId, sx: ev.clientX, sy: ev.clientY, ox: rect.left, oy: rect.top, moved: false };
    try { fab.setPointerCapture(ev.pointerId); } catch (err) { /* 忽略 */ }
    fab.classList.add("ww-dragging");
    ev.preventDefault();
  });

  fab.addEventListener("pointermove", (ev) => {
    if (!drag || ev.pointerId !== drag.id) return;
    const dx = ev.clientX - drag.sx;
    const dy = ev.clientY - drag.sy;
    // 超过 4px 才算拖动 —— 否则手抖一下就被判成拖动，按钮永远点不亮
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
    if (!drag.moved) return;
    placeFab(drag.ox + dx, drag.oy + dy);
  });

  const endDrag = (ev) => {
    if (!drag || (ev && ev.pointerId !== undefined && ev.pointerId !== drag.id)) return;
    const moved = drag.moved;
    drag = null;
    if (fab) fab.classList.remove("ww-dragging");

    if (moved) {
      // 记住位置（存夹完之后的真实坐标，下次打开才在同一个地方）
      const r = fab.getBoundingClientRect();
      fabSaved = { x: r.left, y: r.top };
      writeJSON(FAB_KEY, fabSaved);
    } else {
      onFabActivate();
    }
  };

  fab.addEventListener("pointerup", endDrag);
  fab.addEventListener("pointercancel", endDrag);
}

/* -------------------------------------------------------------- iframe 壳 */

function ensureOverlay() {
  if (overlay) return overlay;

  overlay = document.createElement("div");
  overlay.id = OVERLAY_ID;
  // 先把 class 摆上再插进文档 —— 否则第一帧会以"没有形态"的样子闪一下
  overlay.className = "ww-hidden ww-dock";
  overlay.innerHTML =
    '<div class="ww-mask" title="点一下收起面板"></div>'
    + '<div class="ww-frame-wrap">'
    + '<div class="ww-resize" title="左右拖动调整边栏宽度"></div>'
    // 这里**故意没有**拖动条：居中态的把手是面板自己的标题栏（见 onPanelDrag）。
    + '<iframe id="windwhisper-frame" src="' + PANEL_URL + '"></iframe>'
    + '<div class="ww-resize-se" title="拖动调整大窗大小"></div>'
    + '</div>';
  document.body.appendChild(overlay);

  frame = overlay.querySelector("#windwhisper-frame");
  frameWrap = overlay.querySelector(".ww-frame-wrap");
  overlay.querySelector(".ww-resize").addEventListener("pointerdown", onResizeDock);
  overlay.querySelector(".ww-resize-se").addEventListener("pointerdown", onResizeModal);
  overlay.querySelector(".ww-mask").addEventListener("click", () => closePanel());
  return overlay;
}

/**
 * 拖动期间的公共外壳：加类、锁光标、按 pointerId 挂监听、结束收干净。
 * 两个把手（边栏宽度 / 大窗大小）共用这一套，区别只在 onMove 里算什么。
 */
function startResize(ev, cursor, onMove, onDone) {
  if (ev.button !== 0) return;
  const handle = ev.currentTarget;

  overlay.classList.add("ww-resizing");
  document.body.style.cursor = cursor;
  document.body.style.userSelect = "none";

  const move = (e) => onMove(e);
  const up = () => {
    handle.removeEventListener("pointermove", move);
    handle.removeEventListener("pointerup", up);
    handle.removeEventListener("pointercancel", up);
    overlay.classList.remove("ww-resizing");
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    if (onDone) onDone();
    layoutFab();
  };

  try { handle.setPointerCapture(ev.pointerId); } catch (err) { /* 忽略 */ }
  handle.addEventListener("pointermove", move);
  handle.addEventListener("pointerup", up);
  handle.addEventListener("pointercancel", up);
}

/** 边栏：拖左边缘改宽度。往左拖 = 变宽，方向跟"右侧贴边"的直觉一致。 */
function onResizeDock(ev) {
  ev.preventDefault();
  const startX = ev.clientX;
  const startW = frameWrap.getBoundingClientRect().width;
  const maxW = Math.min(W_MAX, Math.max(W_MIN, window.innerWidth - 40));

  startResize(ev, "col-resize",
    (e) => {
      const w = clampNum(startW + (startX - e.clientX), W_MIN, maxW);
      frameWrap.style.width = w + "px";
      layoutFab();
    },
    () => savePanelWidth(frameWrap.getBoundingClientRect().width));
}

/** 居中大窗：拖右下角同时改宽高。 */
function onResizeModal(ev) {
  ev.preventDefault();
  const startX = ev.clientX;
  const startY = ev.clientY;
  const rect = frameWrap.getBoundingClientRect();
  const startW = rect.width;
  const startH = rect.height;
  const maxW = clampNum(window.innerWidth - 48, M_MIN.w, M_MAX_W);
  const maxH = clampNum(window.innerHeight - 48, M_MIN.h, M_MAX_H);

  startResize(ev, "nwse-resize",
    (e) => {
      const w = clampNum(startW + (e.clientX - startX), M_MIN.w, maxW);
      const h = clampNum(startH + (e.clientY - startY), M_MIN.h, maxH);
      frameWrap.style.width = w + "px";
      frameWrap.style.height = h + "px";
    },
    () => {
      const r2 = frameWrap.getBoundingClientRect();
      saveModalSize(r2.width, r2.height);
    });
}

/**
 * 居中大窗挪位置（用户要"挪开窗户看下面的节点"）。
 *
 * 把手在**面板自己的标题栏**里，不由这里监听指针 —— 面板在自己的 iframe 里，
 * 外壳拿不到它的 pointermove，所以由面板上报"这一拖走了多少像素"：
 *   phase: "start"（按住）· "move"（拖动中）· "end"（松手）· "reset"（双击回正中）
 * 上报端在 web/panel/app.js 的 bindTitleDrag()。
 *
 * 三个要点：
 *   · 存的是**相对屏幕正中的偏移**，不是绝对坐标（见 MP_KEY 注释）
 *   · 拖动期间给 overlay 加 `.ww-moving` —— 遮罩压到几乎没有，不然挪了也看不清节点
 *   · 位移一律过一遍 clampModalPos，窗不会被拖出视口
 */
let dragFrom = null;

function onPanelDrag(msg) {
  // 边栏是贴着右边缘的，不参与挪动；此时连状态都不该留下
  if (mode !== "modal" || !frameWrap) return;

  if (msg.phase === "reset") {
    dragFrom = null;
    overlay.classList.remove("ww-moving");
    saveModalPos(0, 0);
    applyModalPos();
    return;
  }

  if (msg.phase === "start") {
    const p = modalPos();
    dragFrom = { x: p.x, y: p.y };
    overlay.classList.add("ww-moving");
    return;
  }

  const dx = +msg.dx || 0;
  const dy = +msg.dy || 0;

  if (msg.phase === "move") {
    if (!dragFrom) return;
    const p = clampModalPos(dragFrom.x + dx, dragFrom.y + dy);
    frameWrap.style.transform = "translate(" + p.x + "px," + p.y + "px)";
    return;
  }

  // end —— 松手才落盘
  if (!dragFrom) return;
  const p = clampModalPos(dragFrom.x + dx, dragFrom.y + dy);
  dragFrom = null;
  overlay.classList.remove("ww-moving");
  saveModalPos(p.x, p.y);
  applyModalPos();   // 走一遍"读记忆值 → 夹取"，免得手一抖存进越界的值
}

function openPanel(targetMode) {
  injectStyle();
  const alreadyLoaded = !!overlay;
  ensureOverlay();

  // 显式点名了形态就用它（顶栏菜单的「居中大窗」走这条），否则沿用上次用的
  if (targetMode === "dock" || targetMode === "modal") mode = targetMode;
  else mode = savedMode();
  applyMode(mode);

  overlay.classList.remove("ww-hidden");
  panelOpen = true;
  if (fab) fab.classList.add("ww-on");
  layoutFab();

  // 首次打开时面板加载完会自己发 ready；再次打开不会，所以这里主动补一次状态
  if (alreadyLoaded) {
    setTimeout(() => {
      postToPanel("windwhisper/init", { dark: isDark(), nodes: listNodes(), mode: mode });
    }, 60);
  }
}

function closePanel() {
  if (overlay) overlay.classList.add("ww-hidden");
  panelOpen = false;
  if (fab) fab.classList.remove("ww-on");
  layoutFab();
}

function togglePanel() {
  if (panelOpen) closePanel(); else openPanel();
}

function postToPanel(type, payload) {
  if (!frame || !frame.contentWindow) return;
  try {
    frame.contentWindow.postMessage(Object.assign({ type: type }, payload || {}), window.location.origin);
  } catch (err) {
    console.warn("[WindWhisper] 向面板发消息失败", err);
  }
}

/* ---------------------------------------------------------------- 主题 */

function isDark() {
  try {
    const v = app.ui && app.ui.settings && app.ui.settings.getSettingValue
      ? app.ui.settings.getSettingValue("Comfy.ColorPalette")
      : null;
    if (typeof v === "string" && v) return v.toLowerCase().indexOf("dark") === 0;
  } catch (err) { /* 读不到就走下面的兜底 */ }

  const root = document.documentElement;
  const body = document.body;
  if (root && root.classList.contains("dark-theme")) return true;
  if (body && body.classList.contains("dark-theme")) return true;

  try {
    const bg = getComputedStyle(body).backgroundColor;
    const m = bg && bg.match(/(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    if (m) {
      const lum = 0.299 * +m[1] + 0.587 * +m[2] + 0.114 * +m[3];
      return lum < 110;
    }
  } catch (err) { /* 忽略 */ }

  return false;
}

function watchTheme() {
  const notify = () => postToPanel("windwhisper/theme", { dark: isDark() });
  try {
    const mo = new MutationObserver(notify);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    if (document.body) mo.observe(document.body, { attributes: true, attributeFilter: ["class"] });
  } catch (err) { /* 忽略 */ }
}

/* ------------------------------------------------------------ 画布节点 */

function listNodes() {
  const graph = app.graph;
  if (!graph) return [];
  const all = graph._nodes || graph.nodes || [];
  const out = [];
  for (let i = 0; i < all.length; i++) {
    const n = all[i];
    if (n && n.type === NODE_TYPE && n.id != null) {
      out.push({ id: n.id, title: n.title || "风语节点", node: n });
    }
  }
  return out;
}

/**
 * 往节点的 text 控件写值。
 *
 * 多路兜底：传统 LiteGraph 渲染只认 ①②③，但把 ④⑤ 一起写上，
 * 万一以后开了 Nodes 2.0（Vue 渲染）也不用回来改这里。
 */
function writeWidget(node, name, text) {
  const widgets = node.widgets || [];
  let w = null;
  for (let i = 0; i < widgets.length; i++) {
    if (widgets[i] && widgets[i].name === name) { w = widgets[i]; break; }
  }
  if (!w) return false;

  // ① LiteGraph 的真源
  w.value = text;

  // ② Nodes 2.0 开启时的响应式状态
  if (w._state && typeof w._state === "object" && "value" in w._state) {
    w._state.value = text;
  }

  // ③ 传统渲染下那个真实存在的输入框
  if (w.inputEl) {
    w.inputEl.value = text;
    try {
      w.inputEl.dispatchEvent(new Event("input", { bubbles: true }));
    } catch (err) { /* 忽略 */ }
  }

  // ④ 老版序列化路径用的 widget 值数组
  try {
    if (Array.isArray(node.widgets_values)) {
      const idx = widgets.indexOf(w);
      if (idx >= 0) node.widgets_values[idx] = text;
    }
  } catch (err) { /* 忽略 */ }

  // ⑤ 通知重绘
  try {
    node.setDirtyCanvas(true, true);
    if (app.graph) app.graph.setDirtyCanvas(true, true);
  } catch (err) { /* 忽略 */ }

  return true;
}

/** 推成功后在画布上闪一下，让你知道写进哪个节点了。 */
function flashNode(node) {
  try {
    const prevColor = node.color;
    const prevBg = node.bgcolor;
    node.color = "#7C6BF0";
    node.bgcolor = "#EEEDFE";
    if (app.graph) app.graph.setDirtyCanvas(true, true);
    setTimeout(() => {
      node.color = prevColor;
      node.bgcolor = prevBg;
      try { node.setDirtyCanvas(true, true); } catch (err) { /* 忽略 */ }
    }, 720);
  } catch (err) { /* 忽略 */ }
}

/** 处理「推到节点」，结果一定回执给面板，否则面板不知道成败。 */
function handlePush(msg) {
  const text = msg.text == null ? "" : String(msg.text);
  const target = msg.target || "selected";

  const all = listNodes();
  if (!all.length) {
    postToPanel("windwhisper/pushed", {
      ok: false,
      error: "画布上还没有「🍃 风语 · 提示词」节点，先添加一个再来推",
    });
    return;
  }

  let picked = null;

  // ① 优先给画布上选中的那个
  if (target === "selected") {
    const sel = app.canvas && app.canvas.selected_nodes;
    if (sel) {
      for (let i = 0; i < all.length; i++) {
        if (sel[all[i].id]) { picked = all[i]; break; }
      }
    }
  } else {
    // ② 面板指定了具体节点
    for (let i = 0; i < all.length; i++) {
      if (String(all[i].id) === String(target)) { picked = all[i]; break; }
    }
  }

  // ③ 退到上次推过的那个
  if (!picked && lastTargetId != null) {
    for (let i = 0; i < all.length; i++) {
      if (String(all[i].id) === String(lastTargetId)) { picked = all[i]; break; }
    }
  }

  // ④ 画布上只有一个，那就是它
  if (!picked && all.length === 1) picked = all[0];

  // ⑤ 还是选不出，交回面板提示用户去选中
  if (!picked) {
    postToPanel("windwhisper/pushed", {
      ok: false,
      error: "画布上有 " + all.length + " 个风语节点，先在画布上选中要接收的那个",
    });
    return;
  }

  const ok = writeWidget(picked.node, "text", text);
  if (ok) {
    lastTargetId = picked.id;
    flashNode(picked.node);
  }

  postToPanel("windwhisper/pushed", {
    ok: ok,
    nodeId: picked.id,
    title: picked.title,
    error: ok ? null : "这个节点上找不到 text 控件",
  });
}

/* ---------------------------------------------------------- 面板消息入口 */

window.addEventListener("message", (ev) => {
  if (ev.origin !== window.location.origin) return;
  const msg = ev.data;
  if (!msg || typeof msg.type !== "string") return;
  if (msg.type.indexOf("windwhisper/") !== 0) return;

  if (msg.type === "windwhisper/ready") {
    postToPanel("windwhisper/init", { dark: isDark(), nodes: listNodes(), mode: mode });
  } else if (msg.type === "windwhisper/push") {
    handlePush(msg);
  } else if (msg.type === "windwhisper/close") {
    closePanel();
  } else if (msg.type === "windwhisper/mode") {
    // 面板顶栏那个放大/缩回按钮：它只表达意图，尺子在这边 —— 切完再由 applyMode 广播回去
    if (msg.mode === "dock" || msg.mode === "modal") {
      if (panelOpen) applyMode(msg.mode); else openPanel(msg.mode);
    }
  } else if (msg.type === "windwhisper/modal-drag") {
    // 面板里拖标题栏 → 挪整个大窗。位移是面板算的，夹取和记忆在这边
    onPanelDrag(msg);
  }
});

document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape" && overlay && !overlay.classList.contains("ww-hidden")) {
    closePanel();
  }
});

// 窗口尺寸变了要重新夹一遍悬浮按钮的位置，否则它会被留在视野外点不到
window.addEventListener("resize", () => {
  layoutFab();
  if (!panelOpen || !frameWrap) return;

  if (mode === "dock") {
    // 视口变窄时把边栏收进可用范围（记忆值本身不动，窗口回来还能恢复）
    const max = Math.min(W_MAX, Math.max(W_MIN, window.innerWidth - 40));
    frameWrap.style.width = clampNum(parseFloat(frameWrap.style.width) || W_DEFAULT, W_MIN, max) + "px";
  } else {
    // 居中态同理，modalSize() 会按新视口重新夹一遍
    const s = modalSize();
    frameWrap.style.width = s.w + "px";
    frameWrap.style.height = s.h + "px";
  }
  applyModalPos();   // 视口变了，原来那个偏移可能已经越界 → 重新夹一遍
  layoutFab();
});

/* --------------------------------------------------------------- 扩展注册 */

const extension = {
  name: "WindWhisper",

  commands: [
    {
      id: "WindWhisper.OpenPanel",
      label: "🍃 风语 · 提示词搭子",
      function: () => openPanel(),          // 沿用上次用的形态
    },
    {
      id: "WindWhisper.OpenModal",
      label: "🍃 风语 · 居中大窗",
      function: () => openPanel("modal"),   // 点名要居中
    },
  ],

  menuCommands: [
    {
      path: ["🍃 风语"],
      commands: ["WindWhisper.OpenPanel", "WindWhisper.OpenModal"],
    },
  ],

  async setup() {
    injectStyle();
    mountFab();
    watchTheme();
    console.log("[WindWhisper] 扩展已就绪：画布上的悬浮按钮（可拖动）、顶栏「🍃 风语」菜单、节点上的按钮");
  },

  /** 给风语节点加一个「打开面板」按钮 —— 比翻菜单直观。 */
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_TYPE) return;
    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const result = onCreated ? onCreated.apply(this, arguments) : undefined;
      try {
        this.addWidget("button", "🍃 打开风语面板", null, () => openPanel());
      } catch (err) {
        console.warn("[WindWhisper] 节点按钮添加失败", err);
      }
      return result;
    };
  },
};

try {
  app.registerExtension(extension);
} catch (err) {
  // 菜单 API 在个别版本上可能有出入，降级成只注册最小可用扩展，
  // 保证节点按钮这条入口一定活着。
  console.warn("[WindWhisper] 完整扩展注册失败，降级为最小扩展", err);
  app.registerExtension({
    name: "WindWhisper.Minimal",
    async setup() {
      injectStyle();
      mountFab();
      watchTheme();
    },
    async beforeRegisterNodeDef(nodeType, nodeData) {
      if (nodeData.name !== NODE_TYPE) return;
      const onCreated = nodeType.prototype.onNodeCreated;
      nodeType.prototype.onNodeCreated = function () {
        const result = onCreated ? onCreated.apply(this, arguments) : undefined;
        try {
          this.addWidget("button", "🍃 打开风语面板", null, () => openPanel());
        } catch (e) { /* 忽略 */ }
        return result;
      };
    },
  });
}
