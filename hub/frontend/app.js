/* OpenWebUI 监控台 · 前端逻辑
 * 对接后端只读 API（同源，Bearer 鉴权）：
 *   GET /api/v1/usage    -> { totals, by_user, by_model, time_range }
 *   GET /api/v1/users    -> { users, total }
 *   GET /api/v1/records  -> { records, total, page, page_size }
 * 时间：输入按浏览器本地时区，查询参数转 UTC ISO；记录时间按本地时区显示。
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

const pad2 = (n) => String(n).padStart(2, "0");

function fmtDateTime(v) {
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v ?? "");
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function fmtShort(v) {
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v ?? "");
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
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

const reducedMotion = () =>
  window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ---------- 状态 ---------- */
const TOKEN_KEY = "monitor_token";

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
  view: "overview",
  range: { kind: "7d" },
  custom: { start: "", end: "" },
  records: { page: 1, pageSize: 20, userId: "", model: "" },
  filterOptionsLoaded: false,
  alive: false,
  pollTimer: null,
  chartSeries: [],
  chartMode: "day",
  loading: false,
};

const VIEW_META = {
  overview: { title: "概览", lede: "调用、Token 与活跃用户的全景。" },
  records: { title: "调用记录", lede: "每一次模型调用的明细流水。" },
  users: { title: "用户", lede: "用户画像与用量分布。" },
};

/* ---------- API ---------- */
class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function api(path, params) {
  const clean = {};
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== "") clean[k] = v;
    }
  }
  const qs = new URLSearchParams(clean).toString();
  const headers = { Accept: "application/json" };
  if (store.token) headers.Authorization = "Bearer " + store.token;
  let res;
  try {
    res = await fetch(qs ? path + "?" + qs : path, { headers });
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

/* ---------- 时间范围 ---------- */
function resolveRange() {
  const now = new Date();
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  switch (state.range.kind) {
    case "today":
      return { start: startOfDay(now), end: now };
    case "7d":
      return { start: startOfDay(new Date(now.getTime() - 6 * 864e5)), end: now };
    case "30d":
      return { start: startOfDay(new Date(now.getTime() - 29 * 864e5)), end: now };
    case "custom": {
      const s = state.custom.start ? new Date(state.custom.start) : null;
      const e = state.custom.end ? new Date(state.custom.end) : null;
      if (e && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(state.custom.end)) e.setSeconds(59);
      return { start: s, end: e };
    }
    case "all":
    default:
      return { start: null, end: null };
  }
}

function rangeParams() {
  const { start, end } = resolveRange();
  const p = {};
  if (start && !Number.isNaN(start.getTime())) p.start_time = start.toISOString();
  if (end && !Number.isNaN(end.getTime())) p.end_time = end.toISOString();
  return p;
}

function prevRangeParams() {
  const kind = state.range.kind;
  if (kind !== "today" && kind !== "7d" && kind !== "30d") return null;
  const { start, end } = resolveRange();
  const span = end.getTime() - start.getTime();
  return {
    start_time: new Date(start.getTime() - span).toISOString(),
    end_time: start.toISOString(),
  };
}

function rangeLabel() {
  const kind = state.range.kind;
  if (kind === "all") return "全部时间";
  const { start, end } = resolveRange();
  if (!start || !end) return "";
  const f = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  return `${f(start)} 至 ${f(end)}`;
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
    setTimeout(() => el.remove(), 260);
  }, 4200);
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
function skeletonOverview() {
  $("#kpis").innerHTML = Array.from({ length: 6 })
    .map(() => `<div class="kpi"><div class="sk" style="height:12px;width:56px"></div><div class="sk" style="height:26px;width:84px;margin-top:8px"></div><div class="sk" style="height:10px;width:64px;margin-top:8px"></div></div>`)
    .join("");
  $("#chart").innerHTML = "";
  $("#chart-empty").hidden = true;
  $("#top-users").innerHTML = skRows(5);
  $("#donut-legend").innerHTML = skRows(5);
  $("#donut").innerHTML = "";
  $("#recent").innerHTML = skRows(6);
}

function skRows(n) {
  return Array.from({ length: n })
    .map(() => `<div class="sk-row" style="padding:8px 0"><div class="sk" style="height:14px;width:${55 + ((n * 37) % 40)}%"></div></div>`)
    .join("");
}

function skeletonRecords() {
  $("#records-body").innerHTML = Array.from({ length: 8 })
    .map(() => `<tr><td colspan="6"><div class="sk" style="height:15px;width:${60 + (Math.random() * 30) | 0}%"></div></td></tr>`)
    .join("");
}

function skeletonUsers() {
  $("#users-list").innerHTML = skRows(6);
}

/* 骨架 → 内容揭示：重放 CSS reveal 动画（仅首次/手动加载调用，轮询不触发） */
function revealIn(selectors) {
  for (const sel of selectors) {
    const el = $(sel);
    if (!el) continue;
    el.classList.remove("reveal");
    void el.offsetWidth;
    el.classList.add("reveal");
  }
}

/* ---------- KPI ---------- */
function countUp(el, target, format) {
  if (reducedMotion()) {
    el.textContent = format(target);
    return;
  }
  /* 强调时刻刻度：--duration-very-slow (500ms) */
  const dur = 500;
  const t0 = performance.now();
  const step = (t) => {
    const p = Math.min(1, (t - t0) / dur);
    const eased = 1 - Math.pow(1 - p, 3);
    el.textContent = format(target * eased);
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function renderKpis(totals, prevTotals, animate = true) {
  const defs = [
    { key: "calls", label: "调用次数", compact: false, featured: true },
    { key: "total_tokens", label: "合计 Token", compact: true, featured: true },
    { key: "input_tokens", label: "输入 Token", compact: true },
    { key: "output_tokens", label: "输出 Token", compact: true },
    { key: "distinct_users", label: "活跃用户", compact: false },
    { key: "distinct_models", label: "使用模型", compact: false },
  ];
  const deltaLabel = { today: "较昨天同期", "7d": "较前 7 天", "30d": "较前 30 天" }[state.range.kind];

  $("#kpis").innerHTML = defs
    .map((d) => {
      const v = Number(totals[d.key]) || 0;
      let foot = "";
      if (prevTotals && deltaLabel) {
        const pv = Number(prevTotals[d.key]) || 0;
        if (pv > 0) {
          const pct = ((v - pv) / pv) * 100;
          if (Math.abs(pct) >= 0.05) {
            const dir = pct > 0 ? "up" : "down";
            const arrow = pct > 0 ? "↗" : "↘";
            const sign = pct > 0 ? "+" : "";
            foot += `<span class="delta ${dir}" title="${deltaLabel}">${arrow} ${sign}${pct.toFixed(1)}%</span>`;
          }
        }
      }
      return `<div class="kpi${d.featured ? " featured" : ""}">
        <div class="kpi-label">${esc(d.label)}</div>
        <div class="kpi-value${animate ? " pop" : ""}" data-v="${v}" data-fmt="${d.compact ? "c" : "i"}" title="${fmtInt(v)}">0</div>
        <div class="kpi-foot">${foot}</div>
      </div>`;
    })
    .join("");

  $("#kpis").querySelectorAll(".kpi-value").forEach((el) => {
    const target = Number(el.dataset.v) || 0;
    const format = el.dataset.fmt === "c" ? fmtCompact : fmtInt;
    if (animate) countUp(el, target, format);
    else el.textContent = format(target);
  });
}

/* ---------- 趋势图 ---------- */
function bucketize(records, bounds) {
  const span = bounds.end - bounds.start;
  const hourly = span <= 36 * 3600 * 1000;
  const buckets = new Map();
  const cursor = new Date(bounds.start);
  if (hourly) cursor.setMinutes(0, 0, 0);
  else cursor.setHours(0, 0, 0, 0);
  while (cursor <= bounds.end) {
    const key = hourly
      ? `${cursor.getFullYear()}-${pad2(cursor.getMonth() + 1)}-${pad2(cursor.getDate())}T${pad2(cursor.getHours())}`
      : `${cursor.getFullYear()}-${pad2(cursor.getMonth() + 1)}-${pad2(cursor.getDate())}`;
    buckets.set(key, { in: 0, out: 0, calls: 0, label: hourly ? `${pad2(cursor.getHours())}:00` : `${cursor.getMonth() + 1}/${cursor.getDate()}` });
    cursor.setTime(cursor.getTime() + (hourly ? 3600e3 : 86400e3));
  }
  for (const r of records) {
    const d = new Date(r.created_at);
    if (Number.isNaN(d.getTime())) continue;
    const key = hourly
      ? `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}`
      : `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    const b = buckets.get(key);
    if (!b) continue;
    b.in += Number(r.input_tokens) || 0;
    b.out += Number(r.output_tokens) || 0;
    b.calls += 1;
  }
  return { series: Array.from(buckets.values()), hourly };
}

function niceCeil(v) {
  if (v <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / pow;
  const steps = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
  for (const s of steps) if (n <= s) return s * pow;
  return 10 * pow;
}

/* 单调三次贝塞尔（Fritsch–Carlson，同 d3 curveMonotoneX）：
   曲线穿过每个数据点，且相邻点间不 overshoot（不会跌出基线或冲过峰值） */
function smoothPath(pts) {
  const n = pts.length;
  if (n === 0) return "";
  if (n < 3) {
    return pts.map((p, i) => `${i === 0 ? "M" : "L"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join("");
  }
  const dx = [], dy = [], slope = [];
  for (let i = 0; i < n - 1; i++) {
    dx.push(pts[i + 1][0] - pts[i][0]);
    dy.push(pts[i + 1][1] - pts[i][1]);
    slope.push(dy[i] / dx[i]);
  }
  const t = [slope[0]];
  for (let i = 1; i < n - 1; i++) {
    const s0 = slope[i - 1], s1 = slope[i];
    if (s0 * s1 <= 0) {
      t.push(0);
    } else {
      const w0 = 2 * dx[i] + dx[i - 1];
      const w1 = dx[i] + 2 * dx[i - 1];
      t.push((w0 + w1) / (w0 / s0 + w1 / s1));
    }
  }
  t.push(slope[n - 2]);
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) {
    const c1x = pts[i][0] + dx[i] / 3;
    const c1y = pts[i][1] + (t[i] * dx[i]) / 3;
    const c2x = pts[i + 1][0] - dx[i] / 3;
    const c2y = pts[i + 1][1] - (t[i + 1] * dx[i]) / 3;
    d += `C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${pts[i + 1][0].toFixed(1)},${pts[i + 1][1].toFixed(1)}`;
  }
  return d;
}

function renderChart(series, hourly, animate) {
  const svg = $("#chart");
  const wrap = $("#chart-wrap");
  const tip = $("#chart-tip");
  const empty = $("#chart-empty");
  tip.classList.remove("is-shown");

  const hasData = series.some((b) => b.calls > 0);
  empty.hidden = hasData;
  if (!hasData) {
    svg.innerHTML = "";
    return;
  }
  empty.hidden = true;

  const W = Math.max(320, wrap.clientWidth);
  const H = wrap.clientHeight || 300;
  const padL = 46, padR = 14, padT = 12, padB = 24;
  const iw = W - padL - padR;
  const ih = H - padT - padB;
  const n = series.length;
  const yMax = niceCeil(Math.max(...series.map((b) => b.in + b.out)) * 1.08);

  const x = (i) => padL + (n === 1 ? iw / 2 : (i / (n - 1)) * iw);
  const y = (v) => padT + ih - (v / yMax) * ih;

  let parts = [];
  // 发丝网格与 Y 轴刻度（ink-400 mono，无轴线）
  const gridN = 4;
  for (let g = 0; g <= gridN; g++) {
    const gv = (yMax / gridN) * g;
    const gy = y(gv);
    parts.push(`<line class="chart-grid" x1="${padL}" y1="${gy}" x2="${W - padR}" y2="${gy}"/>`);
    parts.push(`<text class="chart-axis" x="${padL - 8}" y="${gy + 3}" text-anchor="end">${esc(fmtCompact(gv))}</text>`);
  }
  // X 轴刻度（最多 7 个）
  const tickEvery = Math.max(1, Math.ceil(n / 7));
  series.forEach((b, i) => {
    if (i % tickEvery !== 0 && i !== n - 1) return;
    parts.push(`<text class="chart-axis" x="${x(i)}" y="${H - 6}" text-anchor="middle">${esc(b.label)}</text>`);
  });

  const totalLine = smoothPath(series.map((b, i) => [x(i), y(b.in + b.out)]));
  const area = totalLine +
    `L${x(n - 1).toFixed(1)},${y(0).toFixed(1)}L${x(0).toFixed(1)},${y(0).toFixed(1)}Z`;

  // 点阵面积（option-pro §6-2 stipple：6px 网格，r=1.1 圆点，brand 20%）
  parts.push(`<defs>
    <pattern id="stip" width="6" height="6" patternUnits="userSpaceOnUse">
      <circle cx="3" cy="3" r="1.1" fill="rgba(46,70,224,.20)"/>
    </pattern>
  </defs>`);
  parts.push(`<path d="${area}" fill="url(#stip)" stroke="none"/>`);
  parts.push(`<path class="chart-line-total" id="chart-line" d="${totalLine}"/>`);

  // hover 参考线与触点（初始隐藏）
  parts.push(`<line class="chart-guide" id="chart-guide" x1="0" y1="${padT}" x2="0" y2="${padT + ih}" visibility="hidden"/>`);
  parts.push(`<circle class="chart-dot" id="chart-dot" r="3.5" visibility="hidden"/>`);
  // 捕获层
  parts.push(`<rect id="chart-hit" x="${padL}" y="${padT}" width="${iw}" height="${ih}" fill="transparent"/>`);

  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.innerHTML = parts.join("");

  // 折线描绘动画（spark-draw 工艺）
  const line = $("#chart-line");
  if (line && animate && !reducedMotion()) {
    const len = line.getTotalLength();
    line.style.strokeDasharray = String(len);
    line.style.strokeDashoffset = String(len);
    line.getBoundingClientRect();
    line.style.transition = "stroke-dashoffset 0.5s cubic-bezier(0.22,1,0.36,1)";
    line.style.strokeDashoffset = "0";
    line.addEventListener("transitionend", () => {
      line.style.strokeDasharray = "none";
      line.style.transition = "";
    }, { once: true });
  }

  // hover 交互（pointer 事件，不用 scroll 监听）
  const hit = $("#chart-hit");
  const guide = $("#chart-guide");
  const dot = $("#chart-dot");
  const onMove = (ev) => {
    const rect = svg.getBoundingClientRect();
    const mx = ((ev.clientX - rect.left) / rect.width) * W;
    const i = Math.max(0, Math.min(n - 1, Math.round(((mx - padL) / iw) * (n - 1))));
    const b = series[i];
    const cx = x(i);
    guide.setAttribute("x1", cx);
    guide.setAttribute("x2", cx);
    guide.setAttribute("visibility", "visible");
    dot.setAttribute("cx", cx);
    dot.setAttribute("cy", y(b.in + b.out));
    dot.setAttribute("visibility", "visible");
    tip.innerHTML =
      `<div class="tip-title">${esc(b.label)} · ${fmtInt(b.calls)} 次调用</div>` +
      `<div class="tip-row"><span><i style="background:var(--brand-400)"></i>输入</span><b>${fmtInt(b.in)}</b></div>` +
      `<div class="tip-row"><span><i style="background:var(--brand-700)"></i>输出</span><b>${fmtInt(b.out)}</b></div>` +
      `<div class="tip-row"><span><i style="background:var(--ink-300)"></i>合计</span><b>${fmtInt(b.in + b.out)}</b></div>`;
    tip.classList.add("is-shown");
    const tw = tip.offsetWidth;
    const px = (cx / W) * rect.width;
    tip.style.left = Math.max(0, Math.min(rect.width - tw - 4, px - tw / 2)) + "px";
    tip.style.top = "8px";
  };
  const onLeave = () => {
    guide.setAttribute("visibility", "hidden");
    dot.setAttribute("visibility", "hidden");
    tip.classList.remove("is-shown");
  };
  hit.addEventListener("pointermove", onMove);
  hit.addEventListener("pointerleave", onLeave);

  $("#chart-sub").textContent = hourly
    ? "按小时聚合（本地时区）"
    : "按天聚合（本地时区）";
}

/* ---------- 排行 / 分布 / 最近 ---------- */
function renderTopUsers(byUser) {
  const rows = (byUser || []).slice(0, 6);
  if (!rows.length) {
    $("#top-users").innerHTML = `<div class="empty"><p>暂无用户数据</p></div>`;
    return;
  }
  const max = Math.max(...rows.map((r) => r.total_tokens || 0), 1);
  $("#top-users").innerHTML = rows
    .map((r, i) => {
      const w = Math.max(1.5, ((r.total_tokens || 0) / max) * 100);
      return `<div class="rank-row">
        <span class="rank-no ${i < 3 ? "is-top" : ""}">${pad2(i + 1)}</span>
        <span class="rank-name" title="${esc(r.user_id)}">${esc(r.nickname || r.user_id || "未知用户")}</span>
        <span class="rank-bar" style="width:${w.toFixed(1)}%"></span>
        <span class="rank-val"><b>${fmtCompact(r.total_tokens)}</b> · ${fmtInt(r.calls)} 次</span>
      </div>`;
    })
    .join("");
}

function renderDonut(byModel, totals) {
  const rows = (byModel || []).filter((r) => (r.total_tokens || 0) > 0);
  const svg = $("#donut");
  const legend = $("#donut-legend");
  if (!rows.length) {
    svg.innerHTML = "";
    legend.innerHTML = `<div class="empty"><p>暂无模型数据</p></div>`;
    return;
  }
  const top = rows.slice(0, 5);
  const rest = rows.slice(5);
  const restTotal = rest.reduce((s, r) => s + (r.total_tokens || 0), 0);
  const restCalls = rest.reduce((s, r) => s + (r.calls || 0), 0);
  const items = top.map((r) => ({ name: r.model_name || "未知模型", tokens: r.total_tokens, calls: r.calls }));
  if (restTotal > 0) items.push({ name: "其他", tokens: restTotal, calls: restCalls, rest: true });

  const sum = items.reduce((s, r) => s + r.tokens, 0) || 1;
  // option-pro 色阶：brand → ink 递进，其他用最浅线色
  const SWATCHES = ["#2e46e0", "#3b59f2", "#6b82ff", "#8a94b0", "#b7bfd3"];
  const REST = "#dbe0e8";
  const R = 70, C = 2 * Math.PI * R;
  const gap = items.length > 1 ? 2.2 : 0;
  let offset = 0;
  let parts = [`<g class="donut-rings">`];
  items.forEach((it, i) => {
    const frac = it.tokens / sum;
    const len = Math.max(0.4, frac * C - gap);
    const color = it.rest ? REST : SWATCHES[i] ?? SWATCHES[SWATCHES.length - 1];
    parts.push(
      `<circle cx="90" cy="90" r="${R}" fill="none" stroke="${color}" stroke-width="20" stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 90 90)"/>`
    );
    offset += frac * C;
  });
  parts.push(`</g>`);
  parts.push(`<text class="donut-center-num" x="90" y="88">${esc(fmtCompact(totals.calls || 0))}</text>`);
  parts.push(`<text class="donut-center-label" x="90" y="106">次调用</text>`);
  svg.innerHTML = parts.join("");

  legend.innerHTML = items
    .map((it, i) => {
      const color = it.rest ? REST : SWATCHES[i] ?? SWATCHES[SWATCHES.length - 1];
      const pct = ((it.tokens / sum) * 100).toFixed(1);
      return `<div class="dl-row">
        <span class="dl-sw" style="background:${color}"></span>
        <span class="dl-name" title="${esc(it.name)}">${esc(it.name)}</span>
        <span class="dl-val">${pct}%</span>
      </div>`;
    })
    .join("");
}

function renderRecent(records) {
  const rows = (records || []).slice(0, 8);
  if (!rows.length) {
    $("#recent").innerHTML = `<div class="empty"><p>所选范围内暂无记录</p></div>`;
    return;
  }
  $("#recent").innerHTML = rows
    .map((r) => {
      const total = (Number(r.input_tokens) || 0) + (Number(r.output_tokens) || 0);
      return `<div class="recent-row">
        <span class="recent-time" title="${esc(fmtDateTime(r.created_at))}">${esc(relTime(r.created_at))}</span>
        <span class="recent-user">${esc(r.nickname || r.user_id || "未知用户")}</span>
        <span class="recent-model">${esc(r.model_name || "未知模型")}</span>
        <span class="recent-tokens"><b>${fmtInt(total)}</b> = ${fmtInt(r.input_tokens)} + ${fmtInt(r.output_tokens)}</span>
      </div>`;
    })
    .join("");
}

/* ---------- 概览加载 ---------- */
async function fetchAllRecords(params, maxPages = 25) {
  let page = 1;
  let total = Infinity;
  const out = [];
  while (out.length < total && page <= maxPages) {
    const d = await api("/api/v1/records", { ...params, page, page_size: 200 });
    total = d.total || 0;
    out.push(...(d.records || []));
    if (!d.records || !d.records.length) break;
    page += 1;
  }
  return out;
}

async function loadOverview(silent) {
  if (!silent) skeletonOverview();
  const params = rangeParams();
  const prev = prevRangeParams();

  const usage = await api("/api/v1/usage", params);

  // “全部”范围：用 time_range 决定图表边界
  let chartBounds = resolveRange();
  if (!chartBounds.start || !chartBounds.end) {
    const min = usage.time_range && usage.time_range.min ? new Date(usage.time_range.min) : null;
    if (min && !Number.isNaN(min.getTime())) {
      chartBounds = { start: min, end: new Date() };
    } else {
      chartBounds = { start: new Date(), end: new Date() };
    }
  }

  const [records, prevUsage] = await Promise.all([
    fetchAllRecords(params),
    prev ? api("/api/v1/usage", prev).catch(() => null) : Promise.resolve(null),
  ]);

  const t = usage.totals || {};
  renderKpis(t, prevUsage ? prevUsage.totals : null, !silent);

  const { series, hourly } = bucketize(records, chartBounds);
  state.chartSeries = series;
  state.chartMode = hourly ? "hour" : "day";
  renderChart(series, hourly, !silent);

  renderTopUsers(usage.by_user || []);
  renderDonut(usage.by_model || [], t);
  renderRecent(records);

  if (!silent) revealIn(["#kpis", "#chart-wrap", "#top-users", "#donut-legend", "#recent"]);
}

/* ---------- 记录视图 ---------- */
async function ensureFilterOptions() {
  if (state.filterOptionsLoaded) return;
  try {
    const [users, usage] = await Promise.all([
      api("/api/v1/users"),
      api("/api/v1/usage"),
    ]);
    const fu = $("#f-user");
    fu.innerHTML =
      `<option value="">全部用户</option>` +
      (users.users || [])
        .map((u) => `<option value="${esc(u.id)}">${esc(u.name || u.id)}</option>`)
        .join("");
    const fm = $("#f-model");
    fm.innerHTML =
      `<option value="">全部模型</option>` +
      (usage.by_model || [])
        .filter((m) => m.model_name)
        .map((m) => `<option value="${esc(m.model_name)}">${esc(m.model_name)}</option>`)
        .join("");
    state.filterOptionsLoaded = true;
  } catch (e) {
    /* 下拉加载失败不阻塞主表 */
  }
}

async function loadRecords(silent) {
  if (!silent) skeletonRecords();
  const r = state.records;
  const data = await api("/api/v1/records", {
    ...rangeParams(),
    user_id: r.userId,
    model_name: r.model,
    page: r.page,
    page_size: r.pageSize,
  });
  const rows = data.records || [];
  const body = $("#records-body");
  if (!rows.length) {
    body.innerHTML = "";
    $("#records-empty").hidden = false;
  } else {
    $("#records-empty").hidden = true;
    body.innerHTML = rows
      .map((row) => {
        const total = (Number(row.input_tokens) || 0) + (Number(row.output_tokens) || 0);
        return `<tr>
          <td class="cell-time">${esc(fmtShort(row.created_at))}</td>
          <td class="cell-user">${esc(row.nickname || row.user_id || "未知")}<small>${esc(row.user_id)}</small></td>
          <td><span class="chip" title="${esc(row.model_name)}">${esc(row.model_name || "未知模型")}</span></td>
          <td class="num">${fmtInt(row.input_tokens)}</td>
          <td class="num">${fmtInt(row.output_tokens)}</td>
          <td class="num total">${fmtInt(total)}</td>
        </tr>`;
      })
      .join("");
  }
  const totalPages = Math.max(1, Math.ceil((data.total || 0) / r.pageSize));
  $("#records-count").textContent = `共 ${fmtInt(data.total || 0)} 条`;
  $("#page-info").textContent = `${data.page || 1} / ${totalPages}`;
  $("#page-prev").disabled = (data.page || 1) <= 1;
  $("#page-next").disabled = (data.page || 1) >= totalPages;
  if (!silent) revealIn(["#records-body"]);
  updateTableFade();
}

/* 手机端表格可滑提示：右侧渐隐仅在还能继续滑时出现 */
function updateTableFade() {
  const tw = $(".table-wrap");
  if (!tw) return;
  const remaining = tw.scrollWidth - tw.clientWidth - tw.scrollLeft;
  tw.classList.toggle("can-scroll", remaining > 4);
}

/* ---------- 用户视图 ---------- */
async function loadUsers(silent) {
  if (!silent) skeletonUsers();
  const data = await api("/api/v1/users", rangeParams());
  const users = (data.users || []).slice().sort((a, b) => (b.total_tokens || 0) - (a.total_tokens || 0));
  $("#users-count").textContent = users.length ? `共 ${fmtInt(users.length)} 人` : "";
  if (!users.length) {
    $("#users-list").innerHTML = "";
    $("#users-empty").hidden = false;
    return;
  }
  $("#users-empty").hidden = true;
  const max = Math.max(...users.map((u) => u.total_tokens || 0), 1);
  const roleLabel = { admin: "管理员", user: "成员", pending: "待激活" };
  $("#users-list").innerHTML = users
    .map((u) => {      const isAdmin = u.role === "admin";
      const initial = (u.name || u.email || "?").trim().charAt(0) || "?";
      const w = Math.max(1.5, ((u.total_tokens || 0) / max) * 100);
      return `<div class="u-row">
        <span class="u-avatar ${isAdmin ? "admin" : ""}">${esc(initial)}</span>
        <div class="u-id">
          <div class="u-name">${esc(u.name || "未命名")}<span class="u-role ${isAdmin ? "admin" : ""}">${esc(roleLabel[u.role] || u.role || "成员")}</span></div>
          <div class="u-mail" title="${esc(u.id)}">${esc(u.email || u.id)}</div>
        </div>
        <div class="u-bar-wrap"><span class="u-bar" style="width:${w.toFixed(1)}%"></span></div>
        <div class="u-stats">
          <div class="u-tokens">${fmtInt(u.total_tokens)}</div>
          <div class="u-sub">调用 ${fmtInt(u.calls)} 次<span class="u-active">，活跃于 ${esc(relTime(u.updated_at))}</span></div>
        </div>
      </div>`;
    })
    .join("");
  if (!silent) revealIn(["#users-list"]);
}

/* ---------- 调度 ---------- */
function applyViewUI(view) {
  state.view = view;
  document.querySelectorAll(".nav-item").forEach((b) => {
    b.classList.toggle("is-active", b.dataset.view === view);
  });
  for (const key of Object.keys(VIEW_META)) {
    $("#view-" + key).hidden = key !== view;
  }
  $("#view-title").textContent = VIEW_META[view].title;
  $("#view-lede").textContent = VIEW_META[view].lede;
  document.querySelectorAll(".content > section > *").forEach((el, i) => {
    el.style.setProperty("--i", i + 1);
  });
}

async function loadCurrentView(opts = {}) {
  if (!state.alive || state.loading) return;
  state.loading = true;
  $("#refresh").classList.add("is-spinning");
  try {
    if (state.view === "overview") await loadOverview(opts.silent);
    else if (state.view === "records") await loadRecords(opts.silent);
    else if (state.view === "users") await loadUsers(opts.silent);
    setConn("ok", "已连接");
    $("#updated").textContent = "更新于 " + new Date().toLocaleTimeString("zh-CN", { hour12: false });
    $("#view-sub").textContent = rangeLabel();
  } catch (err) {
    handleApiError(err);
  } finally {
    state.loading = false;
    $("#refresh").classList.remove("is-spinning");
  }
}

function startPolling() {
  stopPolling();
  state.pollTimer = setInterval(() => {
    if (document.visibilityState === "visible") loadCurrentView({ silent: true });
  }, 30000);
}

function stopPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = null;
}

function switchView(view) {
  if (state.view === view) return;
  // 切换先回顶：避免页面变矮时 scrollTop 被钳位造成的跳变
  window.scrollTo({ top: 0, behavior: "instant" });
  applyViewUI(view);
  // 整页单次滑入（page-slide 刻度），替代子面板逐个重播
  const section = $("#view-" + view);
  section.classList.remove("view-swap");
  void section.offsetWidth;
  section.classList.add("view-swap");
  section.addEventListener("animationend", () => section.classList.remove("view-swap"), { once: true });
  history.replaceState(null, "", "#" + view);
  if (view === "records") ensureFilterOptions();
  loadCurrentView();
}

/* ---------- 事件绑定 ---------- */
function bindEvents() {
  document.querySelectorAll(".nav-item").forEach((b) => {
    b.addEventListener("click", () => switchView(b.dataset.view));
  });

  $("#range-seg").addEventListener("click", (ev) => {
    const btn = ev.target.closest("button[data-range]");
    if (!btn) return;
    const kind = btn.dataset.range;
    if (kind === "custom") {
      toggleCustomPop();
      return;
    }
    closeCustomPop();
    state.range = { kind };
    updateSegActive();
    state.records.page = 1;
    loadCurrentView();
  });

  $("#custom-apply").addEventListener("click", () => {
    const s = $("#custom-start").value;
    const e = $("#custom-end").value;
    const err = $("#custom-error");
    if (!s || !e) {
      err.textContent = "请选择开始和结束时间。";
      err.hidden = false;
      return;
    }
    if (new Date(s) > new Date(e)) {
      err.textContent = "开始时间不能晚于结束时间。";
      err.hidden = false;
      return;
    }
    err.hidden = true;
    state.custom = { start: s, end: e };
    state.range = { kind: "custom" };
    updateSegActive();
    closeCustomPop();
    state.records.page = 1;
    loadCurrentView();
  });
  $("#custom-cancel").addEventListener("click", closeCustomPop);
  document.addEventListener("click", (ev) => {
    const pop = $("#custom-pop");
    if (pop.hidden) return;
    if (ev.target.closest("#custom-pop") || ev.target.closest("#range-custom-btn")) return;
    closeCustomPop();
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") closeCustomPop();
  });

  $("#refresh").addEventListener("click", () => loadCurrentView());
  $("#goto-records").addEventListener("click", () => switchView("records"));

  $("#f-user").addEventListener("change", (e) => {
    state.records.userId = e.target.value;
    state.records.page = 1;
    loadCurrentView();
  });
  $("#f-model").addEventListener("change", (e) => {
    state.records.model = e.target.value;
    state.records.page = 1;
    loadCurrentView();
  });
  $("#f-clear").addEventListener("click", () => {
    state.records.userId = "";
    state.records.model = "";
    state.records.page = 1;
    $("#f-user").value = "";
    $("#f-model").value = "";
    loadCurrentView();
  });
  $("#page-size").addEventListener("change", (e) => {
    state.records.pageSize = Number(e.target.value) || 20;
    state.records.page = 1;
    loadCurrentView();
  });
  $("#page-prev").addEventListener("click", () => {
    if (state.records.page > 1) {
      state.records.page -= 1;
      loadCurrentView();
    }
  });
  $("#page-next").addEventListener("click", () => {
    state.records.page += 1;
    loadCurrentView();
  });

  $("#logout").addEventListener("click", () => {
    store.token = "";
    showGate();
  });

  $("#gate-form").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const token = $("#gate-token").value.trim();
    if (!token) {
      const err = $("#gate-error");
      err.textContent = "请输入访问密钥。";
      err.hidden = false;
      return;
    }
    store.token = token;
    hideGate();
    loadCurrentView().then(() => {
      if (state.alive) startPolling();
    });
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && state.alive) {
      loadCurrentView({ silent: true });
    }
  });

  // 图表随容器尺寸重绘（去抖）
  let resizeTimer = null;
  const ro = new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (state.view === "overview" && state.chartSeries.length) {
        renderChart(state.chartSeries, state.chartMode === "hour", false);
      }
      updateTableFade();
    }, 140);
  });
  ro.observe($("#chart-wrap"));

  // 表格横向滑动时更新渐隐提示
  const tw = $(".table-wrap");
  if (tw) tw.addEventListener("scroll", updateTableFade, { passive: true });
}

function updateSegActive() {
  document.querySelectorAll("#range-seg button[data-range]").forEach((b) => {
    b.classList.toggle("is-active", b.dataset.range === state.range.kind);
  });
  positionSegPill(true);
}

/* tabs-sliding 编排（transitions.dev #16）：把激活按钮的
   offsetLeft / offsetWidth 写到胶囊上，CSS 负责补间；
   首帧与 resize 时挂起过渡直接落位 */
function positionSegPill(animate) {
  const pill = $("#range-seg .seg-pill");
  const btn = $("#range-seg button.is-active");
  if (!pill || !btn) return;
  if (!animate) {
    const prev = pill.style.transition;
    pill.style.transition = "none";
    pill.style.transform = `translateX(${btn.offsetLeft}px)`;
    pill.style.width = `${btn.offsetWidth}px`;
    void pill.offsetWidth;
    pill.style.transition = prev;
  } else {
    pill.style.transform = `translateX(${btn.offsetLeft}px)`;
    pill.style.width = `${btn.offsetWidth}px`;
  }
}

/* menu-dropdown 编排（transitions.dev #05）：.is-open / .is-closing
   状态机，关闭时长从 --dropdown-close-dur 读取，与 CSS 保持同步 */
const DROPDOWN_CLOSE_MS = (() => {
  const v = parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue("--dropdown-close-dur")
  );
  return Number.isFinite(v) ? v : 150;
})();

function openCustomPop() {
  const pop = $("#custom-pop");
  if (!pop.hidden && pop.classList.contains("is-open")) return;
  pop.hidden = false;
  requestAnimationFrame(() => {
    pop.classList.remove("is-closing");
    pop.classList.add("is-open");
  });
  $("#range-custom-btn").setAttribute("aria-expanded", "true");
}

function closeCustomPop() {
  const pop = $("#custom-pop");
  if (pop.hidden) return;
  pop.classList.remove("is-open");
  pop.classList.add("is-closing");
  setTimeout(() => {
    pop.classList.remove("is-closing");
    pop.hidden = true;
  }, DROPDOWN_CLOSE_MS + 20);
  $("#range-custom-btn").setAttribute("aria-expanded", "false");
}

function toggleCustomPop() {
  const pop = $("#custom-pop");
  if (pop.hidden || !pop.classList.contains("is-open")) openCustomPop();
  else closeCustomPop();
}

/* ---------- 启动 ---------- */
function boot() {
  bindEvents();
  updateSegActive();
  requestAnimationFrame(() => positionSegPill(false));
  window.addEventListener("resize", () => positionSegPill(false));
  window.addEventListener("load", () => positionSegPill(false));
  document.querySelectorAll(".content > section > *").forEach((el, i) => {
    el.style.setProperty("--i", i);
  });
  // 首屏错峰入场只播一次：结束后摘掉 .boot，之后切换走整页滑入
  const bootSection = $(".content > section:not([hidden])");
  if (bootSection) {
    bootSection.classList.add("boot");
    setTimeout(() => bootSection.classList.remove("boot"), 1600);
  }
  // 演示与分享便利参数：?token=xxx 带入密钥（用后从地址栏抹掉），
  // #records / #users 直接定位视图。
  const qs = new URLSearchParams(location.search);
  const urlToken = qs.get("token");
  if (urlToken) {
    store.token = urlToken;
    history.replaceState(null, "", location.pathname + location.hash);
  }
  const hashView = location.hash.replace("#", "");
  if (VIEW_META[hashView] && hashView !== state.view) applyViewUI(hashView);
  if (state.view === "records") ensureFilterOptions();
  if (!store.token) {
    showGate();
    return;
  }
  hideGate();
  loadCurrentView().then(() => {
    if (state.alive) startPolling();
  });
}

boot();
