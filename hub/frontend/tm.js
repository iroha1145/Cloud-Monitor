/* Cloud Monitor · 云端用量面板
 * 对接后端：GET /api/v1/tm/overview（同源，Bearer ACCESS_TOKEN）
 *      ＋GET /api/v1/tm/subscriptions（同鉴权，失败/404 时按无数据处理）
 * overview 返回 { generated_at, totals: {today, month, allTime}, devices[], trend[],
 *        trend_models[], activity: { hourly[], daily[] },
 *        period_windows, limits[], sessions[], sessions_omitted, projects[], diagnostics[] }
 * 周期对象：{ totalTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
 *            unclassifiedTokens, timedTokens, timedOutputTokens, timedDurationMs,
 *            costUsd, clients{}, models{},
 *            clientCosts{}, clientCacheReads{}, clientCacheWrites{},
 *            clientOutputs{}, clientUnclassifiedTokens{},
 *            modelCosts{}, modelCacheReads{}, modelCacheWrites{},
 *            modelOutputs{}, modelUnclassifiedTokens{},
 *            clientModels{client:{model:tokens}}, clientModelCosts{client:{model:usd}} }
 * 非缓存输入 = totalTokens − output − cacheRead − cacheWrite − unclassified（钳到 0）
 * 设备离线判定：距 receivedAt 超过 15 分钟（协议 staleAfterMs）
 * trend_models[]：{day, total, models:{模型名: tokens}}，近 30 天升序
 * activity.hourly：今日（UTC）[{hour: 0-23, total}]；activity.daily：近 90 天 [{day, total}]
 * 模型/客户端分布：条内按 输出/缓存读/缓存写/非缓存输入/未分类 真实分段（语义色），
 *   行首圆点保留模型/客户端名配色；周期无拆分字段（老数据）时回退单段 + 按周期比例估算并注明。
 * 新增面板（无数据即整体隐藏）：工具×模型矩阵 / 项目 / 订阅配额 limits /
 *   订阅清单 / 会话明细；diagnostics 按 deviceId 并入设备卡。
 */
"use strict";

/* ---------- 工具 ---------- */
const $ = (sel, root = document) => root.querySelector(sel);

const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));

const nf = new Intl.NumberFormat("zh-Hans-CN");
const fmtInt = (v) => nf.format(Math.round(Number(v) || 0));

function fmtCompact(v) {
  v = Number(v) || 0;
  if (v >= 1e8) return (v / 1e8).toFixed(2).replace(/\.?0+$/, "") + "亿";
  if (v >= 1e4) return (v / 1e4).toFixed(1).replace(/\.0$/, "") + "万";
  return fmtInt(v);
}

function fmtUsd(v) {
  v = Number(v) || 0;
  if (v === 0) return "$0.00";
  if (v < 0.01) return "$" + v.toFixed(4);
  return "$" + v.toFixed(2);
}

const pad2 = (n) => String(n).padStart(2, "0");
const pct1 = (v, total) => (total > 0 ? ((v / total) * 100).toFixed(1) : "0.0") + "%";

function fmtDateTime(v) {
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v ?? "");
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function relTime(v) {
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v ?? "");
  const diff = Date.now() - d.getTime();
  if (diff < 45 * 1000) return "刚刚";
  if (diff < 3600 * 1000) return `${Math.max(1, Math.round(diff / 60000))} 分钟前`;
  if (diff < 24 * 3600 * 1000) return `${Math.round(diff / 3600000)} 小时前`;
  if (diff < 7 * 24 * 3600 * 1000) return `${Math.round(diff / 86400000)} 天前`;
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

/* 同步间隔：300000 → 每 5 分钟 */
function fmtInterval(ms) {
  ms = Number(ms) || 0;
  if (ms <= 0) return "";
  if (ms % 3600000 === 0) return `每 ${ms / 3600000} 小时`;
  if (ms % 60000 === 0) return `每 ${ms / 60000} 分钟`;
  if (ms >= 60000) return `每 ${(ms / 60000).toFixed(1)} 分钟`;
  if (ms >= 1000) return `每 ${Math.round(ms / 1000)} 秒`;
  return `每 ${ms} 毫秒`;
}

/* 会话时长等毫秒跨度人性化：「2 小时 15 分钟」「3 天 4 小时」 */
function fmtDuration(ms) {
  ms = Number(ms) || 0;
  if (ms <= 0) return "—";
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${Math.max(1, sec)} 秒`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟`;
  const h = Math.floor(min / 60);
  const parts = [];
  if (h >= 24) parts.push(`${Math.floor(h / 24)} 天`);
  if (h % 24) parts.push(`${h % 24} 小时`);
  if (h < 24 && min % 60) parts.push(`${min % 60} 分钟`);
  return parts.join(" ") || "—";
}

/* 周期卡「计时 X tokens / Y 小时」的时长段 */
function fmtTimedMs(ms) {
  ms = Number(ms) || 0;
  if (ms <= 0) return "";
  if (ms < 3600000) return `${Math.max(1, Math.round(ms / 60000))} 分钟`;
  const h = ms / 3600000;
  return `${(h >= 10 ? Math.round(h) : h.toFixed(1).replace(/\.0$/, ""))} 小时`;
}

/* 配额窗口 resetsAt 倒计时：「3 小时后重置」 */
function fmtReset(v) {
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return "";
  const diff = d.getTime() - Date.now();
  if (diff <= 0) return "即将重置";
  if (diff < 3600 * 1000) return `${Math.max(1, Math.round(diff / 60000))} 分钟后重置`;
  if (diff < 24 * 3600 * 1000) return `${Math.round(diff / 3600000)} 小时后重置`;
  return `${Math.round(diff / 86400000)} 天后重置`;
}

/* 订阅金额：amountMinor ÷ 100 + 币种符号 */
function fmtMoney(amountMinor, currency) {
  const v = (Number(amountMinor) || 0) / 100;
  const code = String(currency || "").toUpperCase();
  const sym = CCY_SYMBOLS[code] || (code ? code + " " : "");
  return sym + v.toFixed(2);
}

/* 分类调色板（按名称稳定 hash 分配，见 assignColors） */
const PALETTE = [
  "#3b59f2", "#f59e0b", "#0ea5e9", "#8b5cf6", "#10b981",
  "#ef4444", "#ec4899", "#14b8a6", "#f97316", "#64748b",
];
const OTHER_COLOR = "#96a0b5"; // 趋势「其他」合并段 · 中性灰

/* hex 调色板色 → 指定透明度 rgba（条形阴影 = 段色低透明度版本） */
function hexA(hex, a) {
  const n = parseInt(String(hex).slice(1), 16);
  if (Number.isNaN(n)) return `rgba(90, 103, 136, ${a})`;
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

const reducedMotion = () =>
  window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ---------- 常量与状态 ---------- */
const TOKEN_KEY = "cm_access_token";
const OVERVIEW_API = "/api/v1/tm/overview";
const SUBS_API = "/api/v1/tm/subscriptions";
const POLL_MS = 5 * 60 * 1000;   // 每 5 分钟自动刷新
const STALE_MS = 15 * 60 * 1000; // 协议 staleAfterMs：超过视为离线
const TREND_TOP_MODELS = 8;      // 趋势堆叠保留的模型数，超出合并为「其他」
const MATRIX_TOP = 8;            // 工具×模型矩阵行列各取前 8
const SESSIONS_INIT = 20;        // 会话表默认展示条数（可展开到后端截断的 100）

const PERIODS = [
  ["today", "今日", "TODAY"],
  ["month", "本月", "MONTH"],
  ["allTime", "累计", "ALL TIME"],
];

/* token 构成维度：key / 中文名 / 语义色 class（顺序即堆叠条顺序） */
const SEGS = [
  ["input", "非缓存输入", "input"],
  ["output", "输出", "output"],
  ["cacheRead", "缓存读", "cacher"],
  ["cacheWrite", "缓存写", "cachew"],
  ["unclassified", "未分类", "uncls"],
];

/* 订阅金额币种符号（amountMinor ÷ 100 后加此前缀） */
const CCY_SYMBOLS = {
  USD: "$", CNY: "¥", CNH: "¥", EUR: "€", GBP: "£", JPY: "JP¥",
  HKD: "HK$", TWD: "NT$", KRW: "₩", SGD: "S$", AUD: "A$", CAD: "C$",
};

const store = {
  get token() {
    try { return sessionStorage.getItem(TOKEN_KEY) || ""; } catch (e) { return ""; }
  },
  set token(v) {
    try {
      if (v) sessionStorage.setItem(TOKEN_KEY, v);
      else sessionStorage.removeItem(TOKEN_KEY);
    } catch (e) { /* 隐私模式下静默失败 */ }
  },
};

const state = {
  data: null,
  subs: null,                // /api/v1/tm/subscriptions 响应（失败为 null）
  modelPeriod: "today",
  clientPeriod: "today",
  actView: "month",          // 活动热力图：日 / 周 / 月，默认月
  mxMetric: "tokens",        // 矩阵指标：tokens / cost
  mxPeriod: "today",         // 矩阵周期
  sessExpanded: false,       // 会话表「显示全部」
  modelColors: {},           // 模型名 → 颜色（全局面板间一致）
  clientColors: {},          // 客户端名 → 颜色
  alive: false,
  loading: false,
  pollTimer: null,
  booted: false,
};

/* ---------- API ---------- */
class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function api(path) {
  const headers = { Accept: "application/json" };
  if (store.token) headers.Authorization = "Bearer " + store.token;
  let res;
  try {
    res = await fetch(path, { headers });
  } catch (e) {
    throw new ApiError(0, "无法连接服务器");
  }
  let data = {};
  try { data = await res.json(); } catch (e) { /* 保留默认 */ }
  if (!res.ok) {
    throw new ApiError(res.status, (data && data.error) || "请求失败 " + res.status);
  }
  return data;
}

/* ---------- 连接状态 / 提示 ---------- */
function setConn(stateName, text) {
  const el = $("#conn");
  el.dataset.state = stateName;
  $("#conn-text").textContent = text;
}

function toast(msg, isErr) {
  const root = $("#toast-root");
  const el = document.createElement("div");
  el.className = "toast" + (isErr ? " err" : "");
  el.innerHTML =
    `<svg class="ic" aria-hidden="true"><use href="/static/icons.svg#i-${isErr ? "alert-triangle" : "activity"}"/></svg>` +
    `<span>${esc(msg)}</span>`;
  root.appendChild(el);
  setTimeout(() => {
    el.classList.add("out");
    setTimeout(() => el.remove(), 360); // 与 --duration-medium（toast 关闭 350ms）对齐
  }, 4200);
}

/* ---------- 全局悬浮 tooltip（复用 chart-tip 毛玻璃风格） ---------- */
const floatTip = {
  el: null,
  ensure() {
    if (!this.el) {
      this.el = document.createElement("div");
      this.el.className = "chart-tip float-tip";
      document.body.appendChild(this.el);
    }
    return this.el;
  },
  show(html, x, y) {
    const el = this.ensure();
    el.innerHTML = html;
    el.classList.add("is-shown");
    this.place(x, y);
  },
  place(x, y) {
    const el = this.el;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    // 水平居中于指针并钳进视口；上方放不下时翻到指针下方
    let lx = x - w / 2;
    lx = Math.max(8, Math.min(lx, window.innerWidth - w - 8));
    let ly = y - h - 12;
    if (ly < 8) ly = y + 16;
    el.style.left = lx + "px";
    el.style.top = ly + "px";
  },
  hide() {
    if (this.el) this.el.classList.remove("is-shown");
  },
};

function tipHtml(title, rows) {
  return (
    `<div class="tip-title">${esc(title)}</div>` +
    rows.map(([k, v]) => `<div class="tip-row"><span>${esc(k)}</span><b>${v}</b></div>`).join("")
  );
}

/* 横条 hover：tooltip 跟随 + 其余段降透明度（hotRoot 加 has-hot，自身 is-hot） */
function bindHover(el, hotRoot, htmlFn) {
  el.addEventListener("mouseenter", (e) => {
    if (hotRoot) {
      hotRoot.classList.add("has-hot");
      el.classList.add("is-hot");
    }
    floatTip.show(htmlFn(), e.clientX, e.clientY);
  });
  el.addEventListener("mousemove", (e) => floatTip.place(e.clientX, e.clientY));
  el.addEventListener("mouseleave", () => {
    if (hotRoot) {
      hotRoot.classList.remove("has-hot");
      el.classList.remove("is-hot");
    }
    floatTip.hide();
  });
}

/* ---------- 密钥门 ---------- */
function showGate(message) {
  state.alive = false;
  stopPolling();
  $("#shell").hidden = true;
  $("#gate").hidden = false;
  const err = $("#gate-error");
  if (message) {
    err.textContent = message;
    err.hidden = false;
  } else {
    err.hidden = true;
  }
  setTimeout(() => $("#gate-token").focus(), 60);
}

function hideGate() {
  $("#gate").hidden = true;
  $("#shell").hidden = false;
  state.alive = true;
}

function handleApiError(err) {
  if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
    setConn("err", "未授权");
    showGate(err.status === 401 ? "密钥不正确，请重新输入。" : "没有访问权限。");
    return;
  }
  if (err instanceof ApiError && err.status === 500 && /密钥|API_KEY/.test(err.message)) {
    setConn("err", "未配置");
    showGate("服务器未配置访问密钥，请先在后端设置 API_KEY。");
    return;
  }
  setConn("err", "连接失败");
  toast(err.message || "加载失败", true);
}

/* ---------- 骨架屏 ---------- */
function skeletonAll() {
  $("#periods").innerHTML = PERIODS.map(
    () => `<div class="period-card">
      <div class="sk" style="height:12px;width:56px"></div>
      <div class="sk" style="height:28px;width:96px;margin-top:12px"></div>
      <div class="sk" style="height:11px;width:70px;margin-top:10px"></div>
      <div class="sk" style="height:10px;width:100%;margin-top:16px;border-radius:999px"></div>
      <div style="display:flex;gap:7px;margin-top:13px">
        <div class="sk" style="height:24px;width:88px;border-radius:999px"></div>
        <div class="sk" style="height:24px;width:76px;border-radius:999px"></div>
        <div class="sk" style="height:24px;width:96px;border-radius:999px"></div>
      </div>
    </div>`
  ).join("");
  $("#trend-chart").innerHTML = "";
  $("#trend-legend").hidden = true;
  $("#trend-empty").hidden = true;
  for (const id of ["#model-dist", "#client-dist"]) {
    $(id).innerHTML = skRows(5);
    $(id).style.display = "block";
  }
  $("#model-empty").hidden = true;
  $("#client-empty").hidden = true;
  $("#hm").innerHTML = `<div class="sk" style="height:118px;width:100%"></div>`;
  $("#dev-grid").innerHTML = Array.from({ length: 3 })
    .map(() => `<article class="dev-card">
      <div class="sk" style="height:12px;width:40%"></div>
      <div class="sk" style="height:16px;width:62%"></div>
      <div class="sk" style="height:11px;width:80%"></div>
      <div class="sk" style="height:11px;width:55%"></div>
      <div class="sk" style="height:34px;width:100%;margin-top:6px"></div>
    </article>`)
    .join("");
}

function skRows(n) {
  return Array.from({ length: n })
    .map((_, i) => `<div style="padding:11px 0"><div class="sk" style="height:14px;width:${50 + ((i * 29) % 45)}%"></div></div>`)
    .join("");
}

/* ---------- 名称 → 颜色（djb2 稳定 hash；同屏异名异色） ---------- */
/* 同一列表内撞槽时按名称序顺移到下一个空槽，保证同屏不同名不同色（同名恒同色） */
function assignColors(names) {
  const base = (name) => {
    let h = 5381;
    for (let i = 0; i < name.length; i++) h = ((h << 5) + h + name.charCodeAt(i)) >>> 0;
    return h % PALETTE.length;
  };
  const used = new Set();
  const out = {};
  for (const name of [...names].sort()) {
    let idx = base(name);
    if (used.size < PALETTE.length) {
      // 调色板未占满时才顺移避撞；名字多于色槽时允许复用（hash 兜底）
      while (used.has(idx)) idx = (idx + 1) % PALETTE.length;
      used.add(idx);
    }
    out[name] = PALETTE[idx];
  }
  return out;
}

/* 汇总全响应里出现过的模型名 / 客户端名，生成全局一致的颜色映射，
   供模型分布、趋势堆叠、客户端分布、矩阵、项目分段、会话 chip、设备 AI 工具 chip 共用 */
function rebuildColorMaps(data) {
  const models = new Set();
  const clients = new Set();
  const addSplit = (per) => {
    if (!per) return;
    Object.keys(per.models || {}).forEach((m) => models.add(m));
    Object.keys(per.clients || {}).forEach((c) => clients.add(c));
    Object.keys(per.clientModels || {}).forEach((c) => {
      clients.add(c);
      const mm = per.clientModels[c];
      if (mm && typeof mm === "object") Object.keys(mm).forEach((m) => models.add(m));
    });
    Object.keys(per.clientModelCosts || {}).forEach((c) => {
      clients.add(c);
      const mm = per.clientModelCosts[c];
      if (mm && typeof mm === "object") Object.keys(mm).forEach((m) => models.add(m));
    });
  };
  for (const p of PERIODS.map(([k]) => k)) addSplit((data.totals || {})[p]);
  (data.trend_models || []).forEach((r) =>
    Object.keys((r && r.models) || {}).forEach((m) => models.add(m))
  );
  (data.devices || []).forEach((d) =>
    (d.trackedClients || []).forEach((c) => clients.add(c))
  );
  (data.sessions || []).forEach((s) => {
    if (s && s.client) clients.add(s.client);
    modelNamesOf(s && s.models).forEach((m) => models.add(m));
  });
  (data.projects || []).forEach((p) =>
    Object.keys((p && p.clients) || {}).forEach((c) => clients.add(c))
  );
  (data.diagnostics || []).forEach((dg) =>
    healthEntries(dg && dg.clientHealth).forEach(([name]) => clients.add(name))
  );
  state.modelColors = assignColors([...models]);
  state.clientColors = assignColors([...clients]);
}

/* models 字段宽容解析：数组 → 元素；对象 → 键；字符串 → 自身 */
function modelNamesOf(models) {
  if (Array.isArray(models)) return models.map(String).filter(Boolean);
  if (models && typeof models === "object") return Object.keys(models);
  if (typeof models === "string" && models) return [models];
  return [];
}

/* clientHealth 宽容解析为 [客户端名, 原始值] 列表 */
function healthEntries(ch) {
  if (!ch) return [];
  if (Array.isArray(ch)) {
    return ch
      .map((x) => [String((x && (x.client || x.name || x.id)) || ""), x])
      .filter(([name]) => name);
  }
  if (typeof ch === "object") return Object.entries(ch).map(([k, v]) => [String(k), v]);
  return [];
}

/* ---------- token 构成拆分 ---------- */
function compose(p) {
  p = p || {};
  const total = Number(p.totalTokens) || 0;
  const vals = {
    output: Number(p.outputTokens) || 0,
    cacheRead: Number(p.cacheReadTokens) || 0,
    cacheWrite: Number(p.cacheWriteTokens) || 0,
    unclassified: Number(p.unclassifiedTokens) || 0,
  };
  vals.input = Math.max(0, total - vals.output - vals.cacheRead - vals.cacheWrite - vals.unclassified);
  return SEGS.map(([key, label, cls]) => ({ key, label, cls, value: vals[key] }))
    .filter((s) => s.value > 0);
}

/* ---------- 周期卡片 ---------- */
/* periodWindows → 卡角落小字：「Asia/Tokyo · 今日窗口至 08:00」（宽容解析时区与 endsAt） */
function periodWindowNote(pw, key) {
  if (!pw || typeof pw !== "object") return "";
  const tz = pw.timeZone || pw.timezone || "";
  const wins = pw.windows && typeof pw.windows === "object" ? pw.windows : pw;
  const w = wins[key];
  let tail = "";
  if (w && typeof w === "object") {
    const ends = w.endsAt || w.endAt || w.end || "";
    const d = new Date(ends);
    if (ends && !Number.isNaN(d.getTime())) {
      const sameDay = d.toDateString() === new Date().toDateString();
      const when = sameDay
        ? `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
        : `${d.getMonth() + 1}月${d.getDate()}日`;
      tail = (key === "today" ? "今日窗口至 " : "本月窗口至 ") + when;
    }
  }
  return [tz, tail].filter(Boolean).join(" · ");
}

function renderPeriods(data) {
  const totals = (data && data.totals) || {};
  const pw = data && data.period_windows;
  $("#periods").innerHTML = PERIODS.map(([key, label, tag], ci) => {
    const p = totals[key] || {};
    const total = Number(p.totalTokens) || 0;
    const segs = compose(p);
    const sum = segs.reduce((a, s) => a + s.value, 0);
    const bar = segs.length
      ? segs.map((s, si) => {
          const pct = (s.value / sum) * 100;
          return `<i class="seg-${s.cls}" data-label="${esc(s.label)}" data-v="${s.value}" data-pct="${pct.toFixed(1)}" style="width:${pct.toFixed(2)}%;--i:${si}"></i>`;
        }).join("")
      : "";
    const legend = segs.length
      ? segs.map((s) =>
          `<span class="chip chip-${s.cls}"><i></i>${esc(s.label)} <b>${fmtCompact(s.value)}</b></span>`
        ).join("")
      : `<span class="pc-none">暂无构成数据</span>`;
    // 计时用量（timedTokens / timedDurationMs 任一非零才显示）
    const timedTokens = Number(p.timedTokens) || 0;
    const timedMs = Number(p.timedDurationMs) || 0;
    const timed = timedTokens > 0 || timedMs > 0
      ? `<div class="pc-timed">计时 ${fmtCompact(timedTokens)} tokens${timedMs > 0 ? " / " + esc(fmtTimedMs(timedMs)) : ""}</div>`
      : "";
    // 时区与窗口边界（今日 / 本月卡角落）
    const winNote = key === "allTime" ? "" : periodWindowNote(pw, key);
    const win = winNote ? `<div class="pc-win" title="${esc(winNote)}">${esc(winNote)}</div>` : "";
    return `<article class="period-card" data-period="${key}" style="--i:${ci}">
      <div class="pc-top"><span class="pc-label">${label}</span><span class="pc-tag">${tag}</span></div>
      <div class="pc-value pop" title="${fmtInt(total)} tokens">${fmtCompact(total)}</div>
      <div class="pc-cost">费用 <b>${fmtUsd(p.costUsd)}</b></div>${timed}
      <div class="pc-bar">${bar}</div>
      <div class="pc-legend">${legend}</div>${win}
    </article>`;
  }).join("");

  // 堆叠组成条 hover：tooltip（名称 + 紧凑 tokens + 百分比），其余段降透明度
  document.querySelectorAll("#periods .pc-bar").forEach((barEl) => {
    barEl.querySelectorAll("i").forEach((seg) => {
      bindHover(seg, barEl, () =>
        tipHtml(seg.dataset.label, [
          ["tokens", fmtCompact(seg.dataset.v)],
          ["占比", Number(seg.dataset.pct).toFixed(1) + "%"],
        ])
      );
    });
  });
}

/* ---------- 近 30 天趋势（按模型堆叠的彩色柱） ---------- */
function trendRows() {
  const d = state.data || {};
  const tm = Array.isArray(d.trend_models) ? d.trend_models.filter((r) => r && r.day) : [];
  if (tm.length) return tm;
  // 旧后端无 trend_models 时退化为单色总量柱
  const t = Array.isArray(d.trend) ? d.trend.filter((r) => r && r.day) : [];
  return t.map((r) => ({ day: r.day, total: r.total, models: {} }));
}

function renderTrend() {
  const svg = $("#trend-chart");
  const wrap = $("#trend-wrap");
  const tip = $("#trend-tip");
  const legend = $("#trend-legend");
  const rows = trendRows();
  svg.innerHTML = "";
  svg.classList.remove("has-hot");
  tip.classList.remove("is-shown");
  legend.hidden = true;
  legend.innerHTML = "";
  if (!rows.length) {
    $("#trend-empty").hidden = false;
    return;
  }
  $("#trend-empty").hidden = true;

  // 模型排名：按 30 天总量降序，前 TREND_TOP_MODELS 名保留，其余合并「其他」
  const sums = {};
  rows.forEach((r) => {
    for (const [m, v] of Object.entries(r.models || {})) {
      sums[m] = (sums[m] || 0) + (Number(v) || 0);
    }
  });
  const ranking = Object.entries(sums)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([m]) => m);
  const top = ranking.slice(0, TREND_TOP_MODELS);
  const topSet = new Set(top);
  const cats = [...top];
  if (ranking.length > TREND_TOP_MODELS) cats.push("其他");
  const colorOf = (m) => (m === "其他" ? OTHER_COLOR : state.modelColors[m] || OTHER_COLOR);

  // 每天的堆叠值：vals 与 cats 对齐；无模型明细时柱高退回 total
  const days = rows.map((r) => {
    const models = r.models || {};
    let other = 0;
    const vals = cats.map((m) => {
      if (m !== "其他") return Number(models[m]) || 0;
      return 0; // 占位，下面统一算
    });
    if (cats[cats.length - 1] === "其他") {
      for (const [k, v] of Object.entries(models)) {
        if (!topSet.has(k)) other += Number(v) || 0;
      }
      vals[vals.length - 1] = other;
    }
    const stackSum = vals.reduce((a, b) => a + b, 0);
    const total = Number(r.total) || 0;
    return { day: r.day, vals, total, v: stackSum > 0 ? stackSum : total };
  });

  const W = wrap.clientWidth || 800;
  const H = wrap.clientHeight || 300;
  const padL = 46, padR = 10, padT = 18, padB = 26;
  const iw = W - padL - padR;
  const ih = H - padT - padB;
  const max = Math.max(...days.map((d) => d.v), 1);
  const n = days.length;
  const step = iw / n;
  const bw = Math.max(3, Math.min(26, step * 0.62));

  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  const NS = "http://www.w3.org/2000/svg";
  const mk = (tag, attrs) => {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    return el;
  };

  // 横向网格线 + y 轴刻度
  for (let g = 0; g <= 4; g++) {
    const y = padT + (ih * g) / 4;
    svg.appendChild(mk("line", { x1: padL, y1: y, x2: W - padR, y2: y, class: "chart-grid" }));
    const val = max * (1 - g / 4);
    const label = mk("text", { x: padL - 8, y: y + 3, class: "chart-axis", "text-anchor": "end" });
    label.textContent = fmtCompact(val);
    svg.appendChild(label);
  }

  // x 轴日期标签（稀疏；窄屏进一步抽稀）
  const labelEvery = Math.max(1, Math.ceil(n / (W < 560 ? 5 : 9)));
  days.forEach((d, i) => {
    if (i % labelEvery !== 0) return;
    if (n - 1 - i < labelEvery / 2 && i !== n - 1) return;
    const cx = padL + step * i + step / 2;
    const t = mk("text", { x: cx, y: H - 8, class: "chart-axis", "text-anchor": "middle" });
    t.textContent = d.day.slice(5); // MM-DD
    svg.appendChild(t);
  });
  if ((n - 1) % labelEvery !== 0) {
    const cx = padL + step * (n - 1) + step / 2;
    const t = mk("text", { x: cx, y: H - 8, class: "chart-axis", "text-anchor": "end" });
    t.setAttribute("x", Math.min(cx + step / 2, W - padR));
    t.textContent = days[n - 1].day.slice(5);
    svg.appendChild(t);
  }

  const showSums = step >= 24; // 柱顶合计标签：空间够才画
  days.forEach((d, i) => {
    const x = padL + step * i + (step - bw) / 2;
    if (d.v <= 0) {
      // 0 值画 2px 灰条占位
      const bar = mk("rect", {
        x: x.toFixed(2), y: (padT + ih - 2).toFixed(2),
        width: bw.toFixed(2), height: "2",
        class: "trend-bar is-zero",
        style: `--i:${i}`,
      });
      bindHover(bar, svg, () => tipHtml(d.day, [["tokens", "0"]]));
      svg.appendChild(bar);
      return;
    }
    const bh = (d.v / max) * ih;
    if (cats.length) {
      // 按模型堆叠：排名靠前（量大）的在底部
      let yBase = padT + ih;
      cats.forEach((m, j) => {
        const val = d.vals[j];
        if (val <= 0) return;
        const h = (val / max) * ih;
        yBase -= h;
        const col = colorOf(m);
        const rect = mk("rect", {
          x: x.toFixed(2), y: yBase.toFixed(2),
          width: bw.toFixed(2), height: Math.max(0.6, h).toFixed(2),
          class: "tseg",
          fill: col,
          style: `--i:${i};--seg-sh:${hexA(col, 0.38)};--seg-sh-deep:${hexA(col, 0.58)}`,
        });
        bindHover(rect, svg, () =>
          tipHtml(d.day, [
            [m, fmtInt(val)],
            ["占当日", pct1(val, d.v)],
            ["当日合计", fmtCompact(d.total || d.v)],
          ])
        );
        svg.appendChild(rect);
      });
    } else {
      // 无模型明细：单色总量柱
      const bar = mk("rect", {
        x: x.toFixed(2), y: (padT + ih - bh).toFixed(2),
        width: bw.toFixed(2), height: bh.toFixed(2),
        rx: Math.min(5, bw / 2),
        class: "trend-bar",
        style: `--i:${i}`,
      });
      bindHover(bar, svg, () =>
        tipHtml(d.day, [["tokens", fmtInt(d.v)]])
      );
      svg.appendChild(bar);
    }
    if (showSums) {
      const t = mk("text", {
        x: (x + bw / 2).toFixed(2), y: (padT + ih - bh - 5).toFixed(2),
        class: "trend-sum", "text-anchor": "middle",
      });
      t.textContent = fmtCompact(d.total || d.v);
      svg.appendChild(t);
    }
  });

  // 图例：按排名列出模型色（与模型分布同一套按名 hash 配色）
  if (cats.length) {
    legend.innerHTML = cats
      .map((m) => `<span class="lg" title="${esc(m)}"><i style="background:${colorOf(m)}"></i>${esc(m)}</span>`)
      .join("");
    legend.hidden = false;
  }
}

/* ---------- 分布（模型 / 客户端） ----------
 * 条内按 输出/缓存读/缓存写/非缓存输入/未分类 真实分段（语义色 seg-*），
 * 行首圆点保留模型/客户端名配色（避免条色与语义色双编码打架），行尾显示费用。
 * 周期无拆分字段（老数据）时回退：单段实体色 + tooltip 按周期缓存比例估算并注明。 */
function renderDist(listSel, emptySel, subSel, per, kind) {
  const box = $(listSel);
  const isModel = kind === "model";
  const base = isModel ? "model" : "client";
  per = per || {};
  const tokensMap = per[isModel ? "models" : "clients"] || {};
  const costs = per[base + "Costs"] || {};
  const reads = per[base + "CacheReads"] || {};
  const writes = per[base + "CacheWrites"] || {};
  const outs = per[base + "Outputs"] || {};
  const uncls = per[base + "UnclassifiedTokens"] || {};
  const colorMap = isModel ? state.modelColors : state.clientColors;
  // 拆分字段（同名家族 dict）任一非空即视为真实拆分周期
  const hasSplit = [costs, reads, writes, outs, uncls].some(
    (d) => d && typeof d === "object" && Object.keys(d).length > 0
  );
  const sub = subSel ? $(subSel) : null;
  if (sub) {
    sub.textContent = hasSplit
      ? "按 token 占比 · 条内为真实构成分段"
      : "按 token 占比 · 缓存拆分按周期整体比例估算";
  }
  const entries = Object.entries(tokensMap)
    .map(([name, v]) => [name, Number(v) || 0])
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1]);
  if (!entries.length) {
    box.innerHTML = "";
    box.style.display = "none";
    $(emptySel).hidden = false;
    return;
  }
  $(emptySel).hidden = true;
  box.style.display = "grid";
  box.classList.remove("has-hot");
  const sumAll = entries.reduce((a, [, v]) => a + v, 0);
  const max = entries[0][1];
  // 回退估算用：周期整体缓存比例
  const perTotal = Number(per.totalTokens) || 0;
  const cacheRatio = perTotal > 0
    ? Math.max(0, Math.min(1, ((Number(per.cacheReadTokens) || 0) + (Number(per.cacheWriteTokens) || 0)) / perTotal))
    : 0;

  const tips = [];
  box.innerHTML = entries.map(([name, v], idx) => {
    const color = colorMap[name] || OTHER_COLOR;
    const w = ((v / max) * 100).toFixed(2);
    let barInner;
    let tip;
    let costHtml = "";
    if (hasSplit) {
      const out = Number(outs[name]) || 0;
      const cr = Number(reads[name]) || 0;
      const cw = Number(writes[name]) || 0;
      const un = Number(uncls[name]) || 0;
      const input = Math.max(0, v - out - cr - cw - un);
      // SEGS 顺序：[cls, label, value]；cls 对应 seg-* 语义色 class
      const parts = [
        ["input", "非缓存输入", input],
        ["output", "输出", out],
        ["cacher", "缓存读", cr],
        ["cachew", "缓存写", cw],
        ["uncls", "未分类", un],
      ].filter(([, , val]) => val > 0);
      const partsSum = parts.reduce((a, [, , val]) => a + val, 0);
      const denom = Math.max(v, partsSum); // 拆分总和异常超过总量时按比例压缩
      barInner = parts.length
        ? parts.map(([cls, , val]) =>
            `<i class="dist-part seg-${cls}" style="width:${((val / denom) * 100).toFixed(2)}%"></i>`
          ).join("")
        : `<i class="dist-part" style="width:100%;background:${color}"></i>`;
      const tipRows = parts.map(([, label, val]) => [label, `${fmtCompact(val)}（${pct1(val, v)}）`]);
      if (costs[name] != null) {
        tipRows.push(["费用", fmtUsd(costs[name])]);
        costHtml = `<i class="dist-cost">${fmtUsd(costs[name])}</i>`;
      }
      tipRows.push(["合计", fmtInt(v)]);
      tip = () => tipHtml(name, tipRows);
    } else {
      // 老数据：单段实体色 + 按周期缓存比例估算的 tooltip（注明估算）
      barInner = `<i class="dist-part" style="width:100%;background:${color}"></i>`;
      const nc = v * (1 - cacheRatio);
      const c = v * cacheRatio;
      tip = () => tipHtml(name + "（缓存拆分为估算）", [
        ["非缓存", `${fmtCompact(nc)}（${pct1(nc, v)}）`],
        ["缓存", `${fmtCompact(c)}（${pct1(c, v)}）`],
        ["合计", fmtInt(v)],
      ]);
    }
    tips.push(tip);
    return `<div class="dist-row" style="--ri:${idx}">
      <span class="dist-name" title="${esc(name)}"><i style="background:${color}"></i>${esc(name)}</span>
      <div class="dist-track"><div class="dist-bar" style="width:${w}%;--i:${idx};--bar-sh:${hexA(color, 0.38)};--bar-sh-deep:${hexA(color, 0.58)}">${barInner}</div></div>
      <span class="dist-val" title="${fmtInt(v)} tokens"><b>${fmtCompact(v)}</b>${pct1(v, sumAll)}${costHtml}</span>
    </div>`;
  }).join("");

  // hover 分布条：其余行降透明度 + tooltip（各构成段 tokens + 百分比 + 费用）
  box.querySelectorAll(".dist-row").forEach((row, i) => {
    bindHover(row.querySelector(".dist-track"), box, tips[i]);
  });
}

/* ---------- 设备卡片流 ---------- */
/* clientHealth 状态值 → 健康度彩点等级（绿/黄/红/灰） */
function healthLevel(raw) {
  const s = String(raw ?? "").toLowerCase();
  if (!s) return "mute";
  if (/(err|fail|unhealth|bad|stop|crash|down|critical)/.test(s)) return "crit";
  if (/(warn|degrad|stale|slow|partial)/.test(s)) return "warn";
  if (/(ok|health|good|run|ready|normal|up)/.test(s)) return "ok";
  return "mute";
}

/* clientStatus / wslStatus 宽容转简短文本 */
function shortStatusText(v) {
  if (v == null || v === "") return "";
  if (typeof v === "string") return v;
  if (typeof v === "object") {
    return Object.entries(v)
      .slice(0, 4)
      .map(([k, x]) => `${k}: ${typeof x === "object" && x ? JSON.stringify(x) : x}`)
      .join(" · ");
  }
  return String(v);
}

/* diagnostics[] 按 deviceId 匹配进设备卡：clientHealth 每工具一行 /
   clientStatus 一行 / wslStatus 仅 Windows 设备；载荷没有就不渲染对应行 */
function diagHtml(diag, platform) {
  if (!diag) return "";
  const parts = [];
  const tools = healthEntries(diag.clientHealth);
  if (tools.length) {
    parts.push(`<div class="diag-health">${tools.map(([name, v]) => {
      const color = state.clientColors[name] || OTHER_COLOR;
      const isObj = v && typeof v === "object";
      const ver = isObj ? (v.version || v.agentVersion || v.v || "") : "";
      const stRaw = isObj
        ? (v.status ?? v.health ?? v.state ?? (v.healthy === true ? "healthy" : v.healthy === false ? "error" : ""))
        : v;
      const lv = healthLevel(stRaw);
      const stText = shortStatusText(stRaw);
      const verText = String(ver || "").replace(/^v/, "");
      return `<span class="diag-tool"><i style="background:${color}"></i>${esc(name)}` +
        `${verText ? `<em>v${esc(verText)}</em>` : ""}` +
        `<b class="hdot hd-${lv}" title="${esc(stText || "状态未知")}"></b></span>`;
    }).join("")}</div>`);
  }
  const cs = shortStatusText(diag.clientStatus);
  if (cs) parts.push(`<div class="diag-line" title="${esc(cs)}">${esc(cs)}</div>`);
  if (/win/i.test(String(platform || ""))) {
    const ws = shortStatusText(diag.wslStatus);
    if (ws) parts.push(`<div class="diag-line" title="${esc(ws)}"><b>WSL</b> ${esc(ws)}</div>`);
  }
  return parts.length ? `<div class="dev-diag">${parts.join("")}</div>` : "";
}

function renderDevices(devices, diagnostics) {
  const list = devices || [];
  const diagMap = {};
  (diagnostics || []).forEach((dg) => {
    if (dg && dg.deviceId != null) diagMap[String(dg.deviceId)] = dg;
  });
  const online = list.filter((d) => Date.now() - new Date(d.receivedAt).getTime() < STALE_MS).length;
  $("#devices-sub").textContent = list.length
    ? `${online} 台在线 · 共 ${list.length} 台`
    : "";
  $("#dev-grid").innerHTML = list.map((d, idx) => {
    const ts = new Date(d.receivedAt).getTime();
    const on = !Number.isNaN(ts) && Date.now() - ts < STALE_MS;
    const devId = String(d.deviceId || "");
    const name = d.hostname || devId.slice(0, 8) || "未知设备";
    const shortId = devId.length > 12 ? devId.slice(0, 8) + "…" : devId;

    const meta = [];
    const plat = [d.platform, [d.osName, d.osVersion].filter(Boolean).join(" ")]
      .filter(Boolean).join(" · ");
    if (plat) meta.push(plat);
    const agent = [
      d.agentVersion ? `agent v${String(d.agentVersion).replace(/^v/, "")}` : "",
      d.agentRuntime || "",
    ].filter(Boolean).join(" · ");
    if (agent) meta.push(agent);
    const interval = fmtInterval(d.syncUploadIntervalMs);
    if (interval) meta.push("同步 " + interval);

    const chips = (d.trackedClients || []).map((c) => {
      const color = state.clientColors[c] || OTHER_COLOR;
      return `<span class="dev-chip" style="background:${color}1f"><i style="background:${color}"></i>${esc(c)}</span>`;
    }).join("");

    const badges = [
      d.projectsEnabled ? `<span class="dev-badge">项目统计</span>` : "",
      d.historyAvailable ? `<span class="dev-badge">历史数据</span>` : "",
    ].filter(Boolean).join("");

    const stat = (label, key) => {
      const v = Number(((d[key] || {}).totalTokens) || 0);
      return `<div class="dev-stat"><span>${label}</span><b title="${fmtInt(v)} tokens">${fmtCompact(v)}</b></div>`;
    };
    const cost = `<div class="dev-stat"><span>累计费用</span><b>${fmtUsd((d.allTime || {}).costUsd)}</b></div>`;

    return `<article class="dev-card" style="--i:${idx}">
      <div class="dev-top">
        <span class="status ${on ? "on" : "off"}"><span class="status-dot"></span>${on ? "在线" : "离线"}</span>
        <span class="dev-seen" title="${esc(fmtDateTime(d.receivedAt))}">最近上报 ${esc(relTime(d.receivedAt))}</span>
      </div>
      <div class="dev-title">
        <h3 class="dev-host" title="${esc(d.hostname || devId)}">${esc(name)}</h3>
        ${shortId ? `<span class="dev-id mono" title="${esc(devId)}">${esc(shortId)}</span>` : ""}
      </div>
      ${meta.length ? `<div class="dev-meta">${meta.map((m) => `<span>${esc(m)}</span>`).join("")}</div>` : ""}
      ${chips ? `<div class="dev-clients" title="AI 工具">${chips}</div>` : ""}
      ${badges ? `<div class="dev-badges">${badges}</div>` : ""}
      ${diagHtml(diagMap[devId], d.platform)}
      <div class="dev-stats">${stat("今日", "today")}${stat("本月", "month")}${stat("累计", "allTime")}${cost}</div>
    </article>`;
  }).join("");
}

/* ---------- 活动热力图（日 / 周 / 月） ---------- */
const hmLevel = (v, max) => (v > 0 ? Math.min(5, Math.max(1, Math.ceil((v / max) * 5))) : 0);

function bindHmCells(root, titleFn) {
  root.querySelectorAll(".hm-cell[data-v]").forEach((cell) => {
    bindHover(cell, null, () => {
      const v = Number(cell.dataset.v) || 0;
      return tipHtml(titleFn(cell), [["tokens", fmtInt(v)]]);
    });
  });
}

/* 日：今日 24 小时格子（桌面一行 24 格，窄屏两行 12 格） */
function renderHmDay(hm, hourly) {
  const byHour = new Array(24).fill(0);
  (hourly || []).forEach((h) => {
    const i = Number(h && h.hour);
    if (i >= 0 && i < 24) byHour[i] = Number(h.total) || 0;
  });
  const max = Math.max(...byHour, 1);
  $("#act-sub").textContent = "今日 24 小时活动（按 UTC 日期）";
  hm.innerHTML = `<div class="hm-day">` + byHour
    .map((v, i) => `<span class="hm-cell hm-d hm-${hmLevel(v, max)}" data-h="${i}" data-v="${v}">${i}</span>`)
    .join("") + `</div>`;
  bindHmCells(hm, (cell) => {
    const h = Number(cell.dataset.h);
    return `今日 ${pad2(h)}:00–${pad2((h + 1) % 24)}:00`;
  });
}

/* 周：GitHub 风格，最近 12 周 × 7 天（列=周、行=周一~周日） */
function renderHmWeek(hm, daily) {
  const map = new Map((daily || []).map((r) => [r.day, Number(r.total) || 0]));
  const todayStr = new Date().toISOString().slice(0, 10);
  const today = new Date(todayStr + "T00:00:00Z");
  const dow = (today.getUTCDay() + 6) % 7; // 周一 = 0
  const monday = new Date(today);
  monday.setUTCDate(today.getUTCDate() - dow);
  const start = new Date(monday);
  start.setUTCDate(monday.getUTCDate() - 7 * 11);

  const grid = [];
  const months = [];
  let max = 1;
  for (let w = 0; w < 12; w++) {
    for (let d = 0; d < 7; d++) {
      const dt = new Date(start);
      dt.setUTCDate(start.getUTCDate() + w * 7 + d);
      const str = dt.toISOString().slice(0, 10);
      const future = str > todayStr;
      const v = future ? 0 : map.get(str) || 0;
      if (v > max) max = v;
      grid.push({ str, v, future });
    }
    // 月份标签：精确对齐到「包含该月 1 日」的周列左边缘；首列不含 1 日时标注首列所在月份
    const weekDays = grid.slice(w * 7, w * 7 + 7);
    const firstOfMonth = weekDays.find((c) => c.str.slice(8) === "01");
    if (firstOfMonth) months.push(`${Number(firstOfMonth.str.slice(5, 7))}月`);
    else if (w === 0) months.push(`${Number(weekDays[0].str.slice(5, 7))}月`);
    else months.push("");
  }
  $("#act-sub").textContent = "最近 12 周 · 每格一天（UTC）";
  hm.innerHTML = `<div class="hm-week">
    <div class="hm-wk-months">${months.map((m) => `<span>${m}</span>`).join("")}</div>
    <div class="hm-wk-main">
      <div class="hm-wk-gutter"><span style="grid-row:1">一</span><span style="grid-row:3">三</span><span style="grid-row:5">五</span></div>
      <div class="hm-wk-grid">${grid
        .map((c) =>
          c.future
            ? `<span class="hm-cell hm-w hm-skip"></span>`
            : `<span class="hm-cell hm-w hm-${hmLevel(c.v, max)}" data-day="${c.str}" data-v="${c.v}"></span>`
        )
        .join("")}</div>
    </div>
  </div>`;
  bindHmCells(hm, (cell) => cell.dataset.day);
}

/* 月：本月日历网格（周一开头，按星期对齐）+ 右侧本月摘要 */
function renderHmMonth(hm, daily) {
  const map = new Map((daily || []).map((r) => [r.day, Number(r.total) || 0]));
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const daysIn = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const lead = (new Date(Date.UTC(y, m, 1)).getUTCDay() + 6) % 7;
  let max = 1;
  const cells = [];
  for (let d = 1; d <= daysIn; d++) {
    const str = `${y}-${pad2(m + 1)}-${pad2(d)}`;
    const v = map.get(str) || 0;
    if (v > max) max = v;
    cells.push({ d, v });
  }
  // 摘要统计：仅对本月格子做展示层聚合，数据口径不变
  let total = 0;
  let activeDays = 0;
  let best = null;
  cells.forEach((c) => {
    total += c.v;
    if (c.v > 0) {
      activeDays += 1;
      if (!best || c.v > best.v) best = c;
    }
  });
  // 日均 tokens：活跃天数口径
  const avg = activeDays ? Math.round(total / activeDays) : 0;
  // 近 7 天（UTC，含今天）迷你趋势
  const dayMs = 86400000;
  const t0 = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z").getTime();
  const last7 = [];
  for (let i = 6; i >= 0; i--) {
    const str = new Date(t0 - i * dayMs).toISOString().slice(0, 10);
    last7.push({ str, v: map.get(str) || 0 });
  }
  const sum7 = last7.reduce((a, x) => a + x.v, 0);
  const max7 = Math.max(...last7.map((x) => x.v), 1);
  // 本周（周一至今）vs 上周同期（同跨度对比）；上周同期无数据则隐藏
  const dow = (new Date(t0).getUTCDay() + 6) % 7; // 周一 = 0
  let wkThis = 0;
  let wkPrev = 0;
  for (let i = 0; i <= dow; i++) {
    wkThis += map.get(new Date(t0 - (dow - i) * dayMs).toISOString().slice(0, 10)) || 0;
    wkPrev += map.get(new Date(t0 - (dow + 7 - i) * dayMs).toISOString().slice(0, 10)) || 0;
  }
  const wowPct = wkPrev > 0 ? ((wkThis - wkPrev) / wkPrev) * 100 : null;
  const wowAbs = wowPct == null ? 0 : Math.abs(wowPct);
  const wow = wowPct == null
    ? ""
    : `<span class="hm-wow ${wowPct >= 0 ? "up" : "down"}" title="本周至今 ${fmtInt(wkThis)} · 上周同期 ${fmtInt(wkPrev)} tokens">` +
      `${wowPct >= 0 ? "↑" : "↓"} ${wowAbs >= 100 ? Math.round(wowAbs) : wowAbs.toFixed(1)}%<em>周环比</em></span>`;
  const sparkBars = last7.map((x, i) =>
    `<i${x.v > 0 ? "" : ' class="is-zero"'} data-day="${x.str}" data-v="${x.v}" ` +
    `style="height:${((x.v / max7) * 100).toFixed(1)}%;--i:${i}"></i>`
  ).join("");
  $("#act-sub").textContent = `${y} 年 ${m + 1} 月逐日活动（UTC）`;
  hm.innerHTML = `<div class="hm-mon-wrap">
    <div class="hm-mon">
      <div class="hm-mon-head">${["一", "二", "三", "四", "五", "六", "日"].map((d) => `<span>${d}</span>`).join("")}</div>
      <div class="hm-mon-grid">` +
      Array.from({ length: lead }).map(() => `<span class="hm-cell hm-m hm-skip"></span>`).join("") +
      cells.map((c) => `<span class="hm-cell hm-m hm-${hmLevel(c.v, max)}" data-v="${c.v}" data-d="${c.d}">${c.d}</span>`).join("") +
      `</div>
    </div>
    <div class="hm-mon-sum">
      <p class="hm-mon-sum-title">${m + 1} 月摘要</p>
      <div class="hm-sum-grid">
        <div class="hm-sum"><span>本月总量</span><b title="${fmtInt(total)} tokens">${fmtCompact(total)}</b></div>
        <div class="hm-sum"><span>活跃天数</span><b>${activeDays} 天</b></div>
        <div class="hm-sum"><span>最高单日</span>${best
          ? `<b title="${fmtInt(best.v)} tokens">${fmtCompact(best.v)} · ${m + 1}月${best.d}日</b>`
          : `<b>—</b>`}</div>
      </div>
      <div class="hm-sum-mid">
        <div class="hm-avg"><span>日均 tokens</span><b title="${fmtInt(avg)} tokens">${fmtCompact(avg)}</b><em>按活跃天</em></div>
        ${wow}
      </div>
      <div class="hm-spark">
        <div class="hm-spark-head"><span>近 7 天趋势</span><b title="${fmtInt(sum7)} tokens">合计 ${fmtCompact(sum7)}</b></div>
        <div class="hm-spark-bars">${sparkBars}</div>
      </div>
    </div>
  </div>`;
  bindHmCells(hm, (cell) => `${m + 1}月${cell.dataset.d}日`);
  // sparkline 柱 tooltip（复用全局 float-tip）
  hm.querySelectorAll(".hm-spark-bars i").forEach((bar) => {
    bindHover(bar, null, () => tipHtml(bar.dataset.day, [["tokens", fmtInt(bar.dataset.v)]]));
  });
}

function renderActivity() {
  const act = (state.data && state.data.activity) || {};
  floatTip.hide();
  const hm = $("#hm");
  if (state.actView === "day") renderHmDay(hm, act.hourly || []);
  else if (state.actView === "week") renderHmWeek(hm, act.daily || []);
  else renderHmMonth(hm, act.daily || []);
}

/* ---------- 工具 × 模型矩阵 ---------- */
function renderMatrix() {
  const panel = $("#matrix-panel");
  const box = $("#mx");
  const data = state.data || {};
  const per = (data.totals || {})[state.mxPeriod] || {};
  const isCost = state.mxMetric === "cost";
  const cm = per[isCost ? "clientModelCosts" : "clientModels"];
  const rowSum = {};
  const colSum = {};
  if (cm && typeof cm === "object") {
    for (const [client, models] of Object.entries(cm)) {
      if (!models || typeof models !== "object") continue;
      for (const [model, val] of Object.entries(models)) {
        const v = Number(val) || 0;
        if (v <= 0) continue;
        rowSum[client] = (rowSum[client] || 0) + v;
        colSum[model] = (colSum[model] || 0) + v;
      }
    }
  }
  const clients = Object.entries(rowSum).sort((a, b) => b[1] - a[1]).slice(0, MATRIX_TOP).map(([k]) => k);
  const models = Object.entries(colSum).sort((a, b) => b[1] - a[1]).slice(0, MATRIX_TOP).map(([k]) => k);
  if (!clients.length || !models.length) {
    panel.hidden = true;
    box.innerHTML = "";
    return;
  }
  const wasHidden = panel.hidden;
  panel.hidden = false;
  box.classList.remove("has-hot");
  const cellOf = (c, m) => Number(((cm[c] || {})[m]) || 0);
  let maxV = 0;
  clients.forEach((c) => models.forEach((m) => { maxV = Math.max(maxV, cellOf(c, m)); }));
  const fmtV = isCost ? fmtUsd : fmtCompact;

  const head = [`<span class="mx-corner"></span>`]
    .concat(models.map((m) => {
      const color = state.modelColors[m] || OTHER_COLOR;
      return `<span class="mx-col" title="${esc(m)}"><i style="background:${color}"></i><span>${esc(m)}</span></span>`;
    })).join("");
  const rowsHtml = clients.map((c) => {
    const color = state.clientColors[c] || OTHER_COLOR;
    const cells = models.map((m) => {
      const v = cellOf(c, m);
      if (v <= 0) return `<span class="mx-cell is-zero"></span>`;
      const t = maxV > 0 ? v / maxV : 0;
      const alpha = (0.08 + 0.92 * Math.sqrt(t)).toFixed(3);
      return `<span class="mx-cell${t >= 0.45 ? " is-deep" : ""}" data-c="${esc(c)}" data-m="${esc(m)}" data-v="${v}" ` +
        `style="background:rgba(59, 89, 242, ${alpha})">${esc(fmtV(v))}</span>`;
    }).join("");
    return `<span class="mx-row" title="${esc(c)}"><i style="background:${color}"></i><span>${esc(c)}</span></span>${cells}`;
  }).join("");
  box.innerHTML = `<div class="mx-grid" style="grid-template-columns:minmax(110px, 1.3fr) repeat(${models.length}, minmax(56px, 1fr))">${head}${rowsHtml}</div>`;

  const grid = box.querySelector(".mx-grid");
  grid.querySelectorAll(".mx-cell[data-v]").forEach((cell) => {
    bindHover(cell, grid, () => {
      const c = cell.dataset.c;
      const m = cell.dataset.m;
      const v = Number(cell.dataset.v) || 0;
      return tipHtml(`${c} × ${m}`, [
        [isCost ? "费用" : "tokens", isCost ? fmtUsd(v) : fmtInt(v)],
        ["占该行", pct1(v, rowSum[c] || 0)],
      ]);
    });
  });
  if (wasHidden) requestAnimationFrame(positionAllPills); // 面板刚显示，定位 seg 胶囊
}

/* ---------- 项目（按 label 跨设备合并，条内按客户端分布分段） ---------- */
function renderProjects(projects) {
  const panel = $("#projects-panel");
  const box = $("#proj-dist");
  const list = (Array.isArray(projects) ? projects : [])
    .map((p) => ({
      label: String((p && p.label) || ""),
      tokens: Number(p && p.tokens) || 0,
      costUsd: Number(p && p.costUsd) || 0,
      clients: (p && typeof p.clients === "object" && p.clients) || {},
      devices: Array.isArray(p && p.devices) ? p.devices : [],
    }))
    .filter((p) => p.label && p.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens);
  if (!list.length) {
    panel.hidden = true;
    box.innerHTML = "";
    return;
  }
  panel.hidden = false;
  box.classList.remove("has-hot");
  const max = list[0].tokens;
  const tips = [];
  box.innerHTML = list.map((p, idx) => {
    const clientEntries = Object.entries(p.clients)
      .map(([k, v]) => [k, Number(v) || 0])
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1]);
    const segsSum = clientEntries.reduce((a, [, v]) => a + v, 0);
    const denom = Math.max(p.tokens, segsSum);
    const barInner = clientEntries.length
      ? clientEntries.map(([c, v]) =>
          `<i class="dist-part" style="width:${((v / denom) * 100).toFixed(2)}%;background:${state.clientColors[c] || OTHER_COLOR}"></i>`
        ).join("")
      : `<i class="dist-part" style="width:100%;background:${OTHER_COLOR}"></i>`;
    const tipRows = clientEntries.map(([c, v]) => [c, `${fmtCompact(v)}（${pct1(v, p.tokens)}）`]);
    tipRows.push(["费用", fmtUsd(p.costUsd)]);
    if (p.devices.length) tipRows.push(["设备", p.devices.join("、")]);
    tipRows.push(["合计", fmtInt(p.tokens)]);
    tips.push(() => tipHtml(p.label, tipRows));
    const devs = p.devices.length ? `<i class="proj-devs">${p.devices.length} 设备</i>` : "";
    // 条内按客户端分段：阴影取占比最高客户端的配色（低透明度版本）
    const barColor = clientEntries.length ? (state.clientColors[clientEntries[0][0]] || OTHER_COLOR) : OTHER_COLOR;
    return `<div class="dist-row" style="--ri:${idx}">
      <span class="dist-name" title="${esc(p.label)}">${esc(p.label)}</span>
      <div class="dist-track"><div class="dist-bar" style="width:${((p.tokens / max) * 100).toFixed(2)}%;--i:${idx};--bar-sh:${hexA(barColor, 0.38)};--bar-sh-deep:${hexA(barColor, 0.58)}">${barInner}</div></div>
      <span class="dist-val" title="${fmtInt(p.tokens)} tokens"><b>${fmtCompact(p.tokens)}</b><i class="dist-cost">${fmtUsd(p.costUsd)}</i>${devs}</span>
    </div>`;
  }).join("");
  box.querySelectorAll(".dist-row").forEach((row, i) => {
    bindHover(row.querySelector(".dist-track"), box, tips[i]);
  });
}

/* ---------- 订阅配额 limits（provider 卡片） ---------- */
function renderLimits(limits) {
  const panel = $("#limits-panel");
  const grid = $("#lim-grid");
  const list = (Array.isArray(limits) ? limits : []).filter((l) => l && typeof l === "object");
  if (!list.length) {
    panel.hidden = true;
    grid.innerHTML = "";
    return;
  }
  panel.hidden = false;
  grid.innerHTML = list.map((l) => {
    const provider = String(l.provider || "unknown");
    const plan = l.planLabel ? `<span class="lim-plan">${esc(String(l.planLabel))}</span>` : "";
    // 余额：balanceUsd 优先；balance 兜底（数字或常见字段）
    let bal = "";
    if (l.balanceUsd != null && l.balanceUsd !== "" && !Number.isNaN(Number(l.balanceUsd))) {
      bal = fmtUsd(l.balanceUsd);
    } else if (typeof l.balance === "number") {
      bal = fmtCompact(l.balance);
    } else if (l.balance && typeof l.balance === "object") {
      const cand = l.balance.remaining ?? l.balance.total ?? l.balance.value ?? l.balance.amount;
      if (cand != null && !Number.isNaN(Number(cand))) bal = fmtCompact(cand);
    }
    const account = [l.accountLabel, l.accountName, l.accountEmail]
      .filter(Boolean).map(String).join(" · ");
    const wins = (Array.isArray(l.windows) ? l.windows : []).map((w) => {
      if (!w || typeof w !== "object") return "";
      const pct = Math.max(0, Math.min(100, Number(w.usedPercent) || 0));
      const lv = pct < 60 ? "ok" : pct < 85 ? "warn" : "crit";
      const label = w.label || w.name || w.window || "窗口";
      const reset = fmtReset(w.resetsAt);
      return `<div class="lim-win">
        <span class="lim-win-label">${esc(String(label))}</span>
        <div class="lim-bar"><i class="lv-${lv}" style="width:${pct.toFixed(1)}%"></i></div>
        <span class="lim-win-meta"><b>${pct.toFixed(0)}%</b>${reset ? " · " + esc(reset) : ""}</span>
      </div>`;
    }).filter(Boolean).join("");
    return `<article class="lim-card">
      <div class="lim-top">
        <div class="lim-provider"><strong>${esc(provider)}</strong>${plan}</div>
        ${bal ? `<div class="lim-balance"><span>余额</span><b>${esc(bal)}</b></div>` : ""}
      </div>
      ${account ? `<div class="lim-account" title="${esc(account)}">${esc(account)}</div>` : ""}
      ${wins ? `<div class="lim-wins">${wins}</div>` : ""}
      ${l.device ? `<div class="lim-dev">来源 · ${esc(String(l.device))}</div>` : ""}
    </article>`;
  }).join("");
}

/* ---------- 订阅清单（独立接口数据） ---------- */
function renderSubs() {
  const panel = $("#subs-panel");
  const body = $("#subs-body");
  const s = state.subs;
  const list = s && Array.isArray(s.subscriptions) ? s.subscriptions : [];
  if (!list.length) {
    panel.hidden = true;
    body.innerHTML = "";
    return;
  }
  panel.hidden = false;
  $("#subs-sub").textContent = s.updated_at ? "更新于 " + fmtDateTime(s.updated_at) : "";
  const INTERVALS = {
    day: "每天", week: "每周", month: "每月", year: "每年",
    daily: "每天", weekly: "每周", monthly: "每月", yearly: "每年", annual: "每年",
  };
  body.innerHTML = list.map((it) => {
    it = it && typeof it === "object" ? it : {};
    const topUps = Array.isArray(it.topUps) ? it.topUps : [];
    const topTotal = topUps.reduce((a, t) => a + (Number(t && t.amountMinor) || 0), 0);
    const topText = topUps.length ? `${topUps.length} 次 · ${fmtMoney(topTotal, it.currency)}` : "—";
    const interval = INTERVALS[String(it.interval || "").toLowerCase()] || it.interval || "—";
    const start = it.startDate ? String(it.startDate).slice(0, 10) : "—";
    // 官方 normalized binding 为对象 {profileName, accountKey, accountEmail}；宽容兼容字符串
    const binding = it.binding && typeof it.binding === "object"
      ? [it.binding.profileName, it.binding.accountEmail, it.binding.accountKey]
          .filter(Boolean).join(" · ")
      : it.binding;
    return `<tr>
      <td>${esc(it.provider || "—")}</td>
      <td>${esc(it.planName || "—")}</td>
      <td>${esc(binding || "—")}</td>
      <td class="num">${esc(fmtMoney(it.amountMinor, it.currency))}</td>
      <td>${esc(String(interval))}</td>
      <td class="num">${esc(start)}</td>
      <td>${it.autoRenew ? `<span class="badge-renew">自动续费</span>` : `<span class="mute">—</span>`}</td>
      <td class="num">${esc(topText)}</td>
    </tr>`;
  }).join("");
}

/* ---------- 会话明细（默认前 20 条，可展开到 100） ---------- */
function renderSessions() {
  const panel = $("#sessions-panel");
  const body = $("#sess-body");
  const data = state.data || {};
  const list = (Array.isArray(data.sessions) ? data.sessions : []).filter((s) => s && typeof s === "object");
  if (!list.length) {
    panel.hidden = true;
    body.innerHTML = "";
    return;
  }
  panel.hidden = false;
  $("#sess-sub").textContent = `按 tokens 降序 · 共 ${list.length} 条`;
  const showAll = state.sessExpanded;
  const rows = showAll ? list : list.slice(0, SESSIONS_INIT);
  body.innerHTML = rows.map((s) => {
    const client = String(s.client || "");
    const color = state.clientColors[client] || OTHER_COLOR;
    const sid = String(s.sessionId || "");
    const models = modelNamesOf(s.models);
    const modelsText = models.length > 2
      ? models.slice(0, 2).join("、") + ` +${models.length - 2}`
      : models.join("、");
    const tokens = Number(s.tokens) || 0;
    const start = new Date(s.startedAt).getTime();
    const end = new Date(s.lastUsedAt).getTime();
    const dur = !Number.isNaN(start) && !Number.isNaN(end) && end >= start
      ? fmtDuration(end - start)
      : "—";
    return `<tr>
      <td><span class="dev-chip" style="background:${color}1f"><i style="background:${color}"></i>${esc(client || "—")}</span></td>
      <td><span class="sess-id" title="${esc(sid)}">${esc(sid.slice(0, 8))}</span></td>
      <td><span class="sess-models" title="${esc(models.join("、"))}">${esc(modelsText || "—")}</span></td>
      <td class="num" title="${fmtInt(tokens)} tokens">${fmtCompact(tokens)}</td>
      <td class="num">${fmtUsd(s.costUsd)}</td>
      <td>${esc(s.project || "—")}</td>
      <td>${esc(dur)}</td>
      <td class="mute" title="${esc(fmtDateTime(s.lastUsedAt))}">${esc(relTime(s.lastUsedAt))}</td>
      <td class="mute">${esc(String(s.device || "—"))}</td>
    </tr>`;
  }).join("");
  const needMore = list.length > SESSIONS_INIT && !showAll;
  const more = $("#sess-more");
  more.hidden = !needMore;
  if (needMore) more.textContent = `显示全部（共 ${list.length} 条）`;
  $("#sess-omitted").hidden = !data.sessions_omitted;
  $("#sess-foot").hidden = !needMore && !data.sessions_omitted;
}

/* ---------- 渲染总入口 ---------- */
function renderAll(firstLoad) {
  const data = state.data;
  if (!data) return;
  $("#generated-at").textContent = data.generated_at ? "数据生成于 " + fmtDateTime(data.generated_at) : "";
  const devices = data.devices || [];
  const empty = devices.length === 0;
  $("#empty-hero").hidden = !empty;
  $("#view-main").hidden = empty;
  if (empty) return;
  if (firstLoad && !reducedMotion()) {
    // 首屏：子面板错峰浮现（--i 控制错峰延迟）
    const main = $("#view-main");
    main.classList.add("boot");
    Array.from(main.children).forEach((el, i) => el.style.setProperty("--i", i));
  }

  rebuildColorMaps(data);
  renderPeriods(data);
  renderTrend();
  renderDist("#model-dist", "#model-empty", "#model-dist-sub", (data.totals || {})[state.modelPeriod], "model");
  renderDist("#client-dist", "#client-empty", "#client-dist-sub", (data.totals || {})[state.clientPeriod], "client");
  renderMatrix();
  renderActivity();
  renderProjects(data.projects);
  renderLimits(data.limits);
  renderSubs();
  renderSessions();
  renderDevices(devices, data.diagnostics);
}

/* ---------- 分段控件（滑动胶囊） ---------- */
function positionPill(seg) {
  const active = seg.querySelector("button.is-active");
  const pill = seg.querySelector(".seg-pill");
  if (!active || !pill) return;
  const w = active.offsetWidth;
  if (!w) return; // 容器仍 hidden（密钥门阶段）：等可见后由 positionAllPills 定位
  pill.style.width = w + "px";
  pill.style.transform = `translateX(${active.offsetLeft}px)`;
}

function positionAllPills() {
  document.querySelectorAll(".seg").forEach(positionPill);
}

function initSeg(sel, onChange, attr = "data-p") {
  const seg = $(sel);
  seg.addEventListener("click", (e) => {
    const btn = e.target.closest(`button[${attr}]`);
    if (!btn || btn.classList.contains("is-active")) return;
    seg.querySelectorAll("button").forEach((b) => b.classList.remove("is-active"));
    btn.classList.add("is-active");
    positionPill(seg);
    onChange(btn.getAttribute(attr));
  });
  // 初始定位（等布局完成后；不可见时跳过，首次数据渲染后由 positionAllPills 兜底）
  requestAnimationFrame(() => positionPill(seg));
}

/* ---------- 加载与轮询 ---------- */
function stopPolling() {
  if (state.pollTimer) {
    clearTimeout(state.pollTimer);
    state.pollTimer = null;
  }
}

function schedulePoll() {
  stopPolling();
  if (!state.alive) return;
  state.pollTimer = setTimeout(() => load(false), POLL_MS);
}

async function load(manual) {
  if (state.loading) return;
  state.loading = true;
  const refreshBtn = $("#refresh");
  if (manual) refreshBtn.classList.add("is-spinning");
  if (!state.booted) skeletonAll();
  try {
    // 订阅清单为独立接口；老后端无此路由或鉴权失败时按无数据处理（面板隐藏）
    const [data, subs] = await Promise.all([
      api(OVERVIEW_API),
      api(SUBS_API).catch(() => null),
    ]);
    const firstLoad = !state.booted;
    state.data = data;
    state.subs = subs;
    state.booted = true;
    hideGate();
    renderAll(firstLoad);
    // 首渲染后 shell 可见，此时再定位 seg 胶囊（修复首屏激活项文字不可见）
    requestAnimationFrame(positionAllPills);
    setConn("ok", "已连接");
    $("#updated").textContent = "更新于 " + fmtDateTime(new Date().toISOString()).slice(11);
    if (manual) toast("已刷新");
    schedulePoll();
  } catch (err) {
    handleApiError(err);
    if (state.alive) schedulePoll(); // 非鉴权错误也继续轮询
  } finally {
    state.loading = false;
    refreshBtn.classList.remove("is-spinning");
  }
}

/* ---------- 事件 ---------- */
$("#gate-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const token = $("#gate-token").value.trim();
  if (!token) {
    const err = $("#gate-error");
    err.textContent = "请输入访问密钥。";
    err.hidden = false;
    return;
  }
  store.token = token;
  $("#gate-token").value = "";
  load(true);
});

$("#logout").addEventListener("click", () => {
  store.token = "";
  state.data = null;
  state.booted = false;
  showGate();
});

$("#refresh").addEventListener("click", () => load(true));

initSeg("#model-seg", (p) => {
  state.modelPeriod = p;
  if (!state.data) return;
  renderDist("#model-dist", "#model-empty", "#model-dist-sub", (state.data.totals || {})[p], "model");
});
initSeg("#client-seg", (p) => {
  state.clientPeriod = p;
  if (state.data) renderDist("#client-dist", "#client-empty", "#client-dist-sub", (state.data.totals || {})[p], "client");
});
initSeg("#act-seg", (v) => {
  state.actView = v;
  if (state.data) renderActivity();
}, "data-v");
initSeg("#mx-metric-seg", (m) => {
  state.mxMetric = m;
  if (state.data) renderMatrix();
}, "data-m");
initSeg("#mx-period-seg", (p) => {
  state.mxPeriod = p;
  if (state.data) renderMatrix();
});

$("#sess-more").addEventListener("click", () => {
  state.sessExpanded = true;
  renderSessions();
});

window.addEventListener("resize", () => {
  positionAllPills();
  if (state.data && (state.data.trend || state.data.trend_models)) renderTrend();
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && state.alive) load(false);
});

/* ---------- 启动 ---------- */
if (store.token) {
  load(false);
} else {
  showGate();
}
