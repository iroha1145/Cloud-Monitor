/* 云端用量面板 · 前端逻辑
 * 结构：工具 → 常量/状态 → API 层（真实 / 演示双通道）→ 密钥门 → 路由 →
 *       渲染层（概览 KPI/趋势/分布/矩阵/会话 · 设备 · 配额环/订阅卡 · 热力图/日归档）→
 *       分段控件 → 加载与轮询 → 事件 → 启动
 * 真实模式：GET /api/v1/tm/overview + GET /api/v1/tm/subscriptions（Bearer ACCESS_TOKEN，401 回到密钥门）
 * 演示模式：仅 demo.html（安装脚本 CM_DEMO=true 或 GitHub Pages）；生产 index 不加载 mock
 */
"use strict";

/* ================= 工具 ================= */
const $ = (sel, root = document) => root.querySelector(sel);

const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));

const nf = new Intl.NumberFormat("zh-Hans-CN");
const fmtInt = (v) => nf.format(Math.round(Number(v) || 0));

/* 压缩数字与中文单位拆开：等宽栈没有中文字形，「419万」混排会基线错位 */
function compactParts(v, tight) {
  v = Number(v) || 0;
  if (v >= 1e8) {
    const y = v / 1e8;
    // 只删小数部分尾零再删悬挂点：\.?0+$ 会把 toFixed(0) 整数自身的尾零
    // 也吞掉（120亿 → "12亿"）
    const n = (tight
      ? (y >= 100 ? y.toFixed(0) : y >= 10 ? y.toFixed(1) : y.toFixed(2))
      : y.toFixed(2)
    ).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
    return { n, u: "亿" };
  }
  if (v >= 1e4) {
    const w = v / 1e4;
    const n = (tight && w >= 1000 ? w.toFixed(0) : w.toFixed(1)).replace(/\.0$/, "");
    // 9995 万 round 成 10000 万时应滚到 1 亿，而不是显示「10000万」
    if (Number(n) >= 10000) return compactParts(1e8, tight);
    return { n, u: "万" };
  }
  return { n: fmtInt(v), u: "" };
}

function fmtCompact(v) {
  const p = compactParts(v, false);
  return p.n + p.u;
}

function fmtCompactHtml(v, tight) {
  const p = compactParts(v, !!tight);
  const inner = p.u
    ? `<span class="num-int">${esc(p.n)}</span><span class="num-unit">${p.u}</span>`
    : `<span class="num-int">${esc(p.n)}</span>`;
  return `<span class="num-compact">${inner}</span>`;
}

function fmtPctParts(ratio) {
  if (ratio == null || !Number.isFinite(Number(ratio))) return { n: "—", u: "" };
  const pct = Number(ratio) * 100;
  if (pct > 0 && pct < 0.1) return { n: "<0.1", u: "%" };
  const n = (Math.round(pct * 10) / 10).toFixed(1).replace(/\.0$/, "");
  return { n, u: "%" };
}

function fmtPct(ratio) {
  const p = fmtPctParts(ratio);
  return p.n + p.u;
}

function fmtPctHtml(ratio) {
  const p = fmtPctParts(ratio);
  const inner = p.u
    ? `<span class="num-int">${esc(p.n)}</span><span class="num-unit">${p.u}</span>`
    : `<span class="num-int">${esc(p.n)}</span>`;
  return `<span class="num-compact">${inner}</span>`;
}

function fmtUsd(v) {
  v = Number(v) || 0;
  if (v === 0) return "$0.00";
  const sign = v < 0 ? "-" : "";
  const abs = Math.abs(v);
  if (abs < 0.01) return sign + "$" + abs.toFixed(4);
  return sign + "$" + abs.toFixed(2);
}

const pad2 = (n) => String(n).padStart(2, "0");
const pct1 = (v, total) => (total > 0 ? ((v / total) * 100).toFixed(1) : "0.0") + "%";

function fmtDateTime(v, tz) {
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v ?? "");
  const zone = tz || dashTz();
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    const p = {};
    for (const part of fmt.formatToParts(d)) p[part.type] = part.value;
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
  } catch (e) {
    return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
  }
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

/* 毫秒跨度人性化：「2 小时 15 分钟」 */
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
const CCY_SYMBOLS = {
  USD: "$", CNY: "¥", CNH: "¥", EUR: "€", GBP: "£", JPY: "JP¥",
  HKD: "HK$", TWD: "NT$", KRW: "₩", SGD: "S$", AUD: "A$", CAD: "C$",
};
function fmtMoney(amountMinor, currency) {
  const v = (Number(amountMinor) || 0) / 100;
  const code = String(currency || "").toUpperCase();
  const sym = CCY_SYMBOLS[code] || (code ? code + " " : "");
  return sym + v.toFixed(2);
}

/* provider 显示名：官方小写标识 → 标准写法 */
const PROVIDER_NAMES = {
  anthropic: "Anthropic", openai: "OpenAI", cursor: "Cursor",
  google: "Google", gemini: "Gemini", github: "GitHub", copilot: "Copilot",
  zhipu: "智谱", moonshot: "Moonshot", kimi: "Kimi", deepseek: "DeepSeek",
  grok: "SpaceXAI", xai: "SpaceXAI", "grok-web": "SpaceXAI (Web)",
};
function fmtProvider(v) {
  const s = String(v ?? "");
  if (!s) return "—";
  return PROVIDER_NAMES[s.toLowerCase()] || s.charAt(0).toUpperCase() + s.slice(1);
}

/* 邮箱打码：dev@acme.com → de***@acme.com */
function maskEmail(v) {
  const s = String(v ?? "");
  const at = s.indexOf("@");
  if (at <= 0) return s;
  const local = s.slice(0, at);
  return local.slice(0, Math.min(2, local.length)) + "***" + s.slice(at);
}

/* 分类调色板：16 色，前 10 保持原序（存量截图/习惯连续性），后 6 为
   与前 10 拉开「色相 + 明度」双通道距离的补充档（真实部署模型数常 >10，
   10 色时 hash 溢出会随机撞色——趋势图堆叠段/图例同色不可分辨） */
const PALETTE = [
  "#533afd", "#f59e0b", "#0ea5e9", "#7f7dfc", "#00b261",
  "#d8351e", "#ec4899", "#14b8a6", "#f97316", "#64748d",
  "#84cc16", "#0e7490", "#a21caf", "#854d0e", "#4032c8", "#006f3a",
];
const OTHER_COLOR = "#95a4ba";

function hexA(hex, a) {
  const n = parseInt(String(hex).slice(1), 16);
  if (Number.isNaN(n)) return `rgba(90, 103, 136, ${a})`;
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

/* 跨色相族铺排序（PALETTE 下标）：相邻取色跳到不同色相族，
   保证「前 N 名」拿到的是族间最大化拉开的一组，而不是碰巧全落蓝绿族
   （旧 hash 锚点会随机聚族——3 个名字抽中 sky/teal/cyan 全青蓝不可辨）。 */
const PALETTE_SPREAD = [0, 1, 3, 4, 6, 2, 8, 12, 10, 9, 5, 13, 7, 14, 15, 11];

/* 取色 = 名次直取铺排序列：names 的先后即优先级（调用方按全局用量降序传入，
   趋势图 top-N / 图例头部这些「被看到最多」的名字必占族间拉开的唯一色）；
   同一映射表内同名恒同色；槽位耗尽后取「最少被复用」的槽（确定性：计数最小、
   并列按铺排序靠前优先），复用均匀摊在长尾而不是随机撞。
   稳定性依据：优先级取累计周期用量，名次在实际部署中几乎不漂移。 */
function assignColors(names) {
  const counts = new Array(PALETTE.length).fill(0);
  const out = {};
  let rank = 0;
  for (const name of names) {
    let idx;
    if (rank < PALETTE.length) {
      idx = PALETTE_SPREAD[rank];
    } else {
      idx = PALETTE_SPREAD[0];
      for (const s of PALETTE_SPREAD) if (counts[s] < counts[idx]) idx = s;
    }
    counts[idx]++;
    out[name] = PALETTE[idx];
    rank++;
  }
  return out;
}

/* models 字段宽容解析：数组 → 元素；对象 → 键；字符串 → 自身 */
function modelNamesOf(models) {
  if (Array.isArray(models)) return models.map(String).filter(Boolean);
  if (models && typeof models === "object") return Object.keys(models);
  if (typeof models === "string" && models) return [models];
  return [];
}

/* clientHealth 规范解析为 [客户端名, 原始值] 列表。
 * 官方结构为 {version, observedAt, clients:{...}}；兼容旧版直接 map/array，
 * 但绝不能把 version / observedAt / clients 本身误当成客户端。 */
function healthEntries(ch) {
  if (!ch) return [];
  if (Array.isArray(ch)) {
    return ch
      .map((x) => [String((x && (x.client || x.name || x.id)) || ""), x])
      .filter(([name]) => name);
  }
  if (typeof ch === "object") {
    const source = ch.clients && typeof ch.clients === "object" && !Array.isArray(ch.clients)
      ? ch.clients
      : ch;
    return Object.entries(source)
      .filter(([name]) => !["version", "observedAt", "clients"].includes(String(name)))
      .map(([name, value]) => [String(name), value]);
  }
  return [];
}

/* 官方诊断状态采用显式枚举映射。未知值保持灰色并显示原文，禁止关键词猜测；
 * 尤其 "not-running" 不能因为包含 run 而被误判为健康。 */
const HEALTH_STATE_LEVEL = Object.freeze({
  active: "ok",
  direct: "ok",
  detected: "ok",
  healthy: "ok",
  operational: "ok",
  ok: "ok",
  ready: "ok",
  normal: "ok",
  waiting: "warn",
  warning: "warn",
  stale: "warn",
  degraded: "warn",
  partial: "warn",
  "no-data": "warn",
  missing: "crit",
  error: "crit",
  failed: "crit",
  unhealthy: "crit",
  critical: "crit",
  "not-running": "crit",
  stopped: "crit",
  crashed: "crit",
  disabled: "mute",
  "not-installed": "mute",
  unknown: "mute",
});

function normalizeHealthState(raw) {
  const stateName = String(raw ?? "").trim().toLowerCase();
  return stateName || "unknown";
}

function healthLevel(raw) {
  return HEALTH_STATE_LEVEL[normalizeHealthState(raw)] || "mute";
}

function diagnosticState(name, value, diag) {
  const clientStatus = diag && diag.clientStatus && typeof diag.clientStatus === "object"
    ? diag.clientStatus[name]
    : null;
  if (typeof clientStatus === "string" && clientStatus) return clientStatus;
  if (!value || typeof value !== "object") return value;
  const candidates = [
    value.status,
    value.health,
    value.state,
    value.collection && value.collection.state,
    value.source && value.source.state,
    value.data && value.data.state,
  ];
  const found = candidates.find((candidate) => typeof candidate === "string" && candidate.trim());
  if (found) return found;
  if (value.healthy === true) return "healthy";
  if (value.healthy === false) return "unhealthy";
  return "unknown";
}

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

const reducedMotion = () =>
  window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ================= 常量与状态 ================= */
const TOKEN_KEY = "cm_access_token";
/* 安装到主屏（standalone）没有标签页会话，进程被系统回收后
 * sessionStorage 会丢失，导致每次打开都要重输密钥；这类场景改用 localStorage。
 * 浏览器标签页里仍用 sessionStorage，保持「关闭标签页即清除」的隐私语义。 */
const IS_STANDALONE = () =>
  window.matchMedia && window.matchMedia("(display-mode: standalone)").matches;
const tokenStore = () => (IS_STANDALONE() ? localStorage : sessionStorage);
const OVERVIEW_API = "/api/v1/tm/overview";
const SUBS_API = "/api/v1/tm/subscriptions";
const PROVIDER_STATUS_API = "/api/v1/tm/provider-status";
const HISTORY_DAILY_API = "/api/v1/tm/history/daily";
const UPDATE_API = "/api/v1/system/update";
/* §1：动态 SVG 图标路径唯一封装，禁止散落硬编码 */
const ICON_SVG = (() => {
  const el = document.querySelector("script[src*=\"tm.js\"]");
  try {
    return el ? new URL("icons.svg", el.src).href : "/static/icons.svg";
  } catch (e) {
    return "/static/icons.svg";
  }
})();
const iconHref = (id) => ICON_SVG + "#" + id;
/* token-monitor 官方客户端图标（assets/icons/*.svg）。别名对齐其 row-icon CSS。 */
const CLIENT_LOGO_DIR = (() => {
  const el = document.querySelector("script[src*=\"tm.js\"]");
  try {
    return el ? new URL("client-logos/", el.src).href : "/static/client-logos/";
  } catch (e) {
    return "/static/client-logos/";
  }
})();
const CLIENT_LOGO_ALIAS = {
  hermes: "hermes-agent",
  grok: "xai",
  xai: "grok",
  micode: "xiaomi",
  mimo: "xiaomi",
  zcode: "zai",
  zaiteam: "zai",
  thirdparty: "newapi",
  /* 提供商 / 厂商名落到同一套 token-monitor 图标 */
  anthropic: "claude",
  openai: "codex",
  chatgpt: "codex",
  google: "gemini",
  github: "copilot",
  zhipu: "zai",
  moonshot: "kimi",
  bytedance: "doubao",
  volc: "volcengine",
};
const CLIENT_LOGO_IDS = new Set([
  "antigravity", "cherrystudio", "claude", "cline", "codebuddy", "codex",
  "cohere", "commandcode", "copilot", "cursor", "deepseek", "doubao", "dsh",
  "gemini", "grok", "hermes-agent", "hunyuan", "kilocode", "kimi", "kiro",
  "meta", "minimax", "mistral", "moonshot", "newapi", "ollama", "openclaw",
  "opencode", "openrouter", "pi", "proma", "qoder", "qodercn", "qwen",
  "reasonix", "trae", "volcengine", "workbuddy", "xai", "xiaomi", "zai", "zed",
]);
/* 模型名 → 厂商图标（对齐 token-monitor usageCharts.modelVendorFor，openai 用 codex 标） */
function modelVendorId(name) {
  const s = String(name || "").toLowerCase();
  if (!s) return "";
  if (s.includes("claude") || s.includes("anthropic") || s.includes("sonnet") || s.includes("opus") || s.includes("haiku")) return "claude";
  if (s.includes("gpt") || s.includes("openai") || s.includes("chatgpt") || s.includes("codex") || /(?:^|[^a-z])o[1-9](?:[-.]|$)/.test(s)) return "codex";
  if (s.includes("gemini") || s.includes("gemma")) return "gemini";
  if (s.includes("grok") || s.includes("xai")) return "grok";
  if (s.includes("deepseek")) return "deepseek";
  if (s.includes("qwen") || s.includes("qwq")) return "qwen";
  if (s.includes("glm") || s.includes("zhipu") || /\bzai\b/.test(s)) return "zai";
  /* k3 / k3-256k 即 Moonshot Kimi K3；文案仍显示原名，只换厂商图标 */
  if (s.includes("kimi") || s.includes("moonshot") || /(?:^|[^a-z0-9])k3(?:[-._]|$)/.test(s)) return "kimi";
  if (s.includes("mistral") || s.includes("mixtral") || s.includes("codestral")) return "mistral";
  if (s.includes("llama") || s.includes("meta")) return "meta";
  if (s.includes("minimax")) return "minimax";
  if (s.includes("doubao")) return "doubao";
  if (s.includes("hunyuan")) return "hunyuan";
  if (s.includes("command-r") || s.includes("cohere") || s.includes("aya-")) return "cohere";
  if (s === "pi" || s.startsWith("pi-") || s.includes("inflection")) return "pi";
  if (s.includes("cursor")) return "cursor";
  if (s.includes("copilot")) return "copilot";
  return "";
}
function clientLogoId(name) {
  const raw = String(name || "").trim().toLowerCase();
  const key = raw.replace(/[^a-z0-9-]/g, "");
  const id = CLIENT_LOGO_ALIAS[key] || key;
  if (CLIENT_LOGO_IDS.has(id)) return id;
  const vendor = modelVendorId(raw);
  return vendor && CLIENT_LOGO_IDS.has(vendor) ? vendor : "";
}
function clientLogoHtml(name) {
  const id = clientLogoId(name);
  if (id) {
    const url = CLIENT_LOGO_DIR + id + ".svg";
    return `<i class="client-logo" style="-webkit-mask-image:url('${url}');mask-image:url('${url}')" aria-hidden="true"></i>`;
  }
  const ch = esc(String(name || "?").trim().slice(0, 1).toUpperCase() || "?");
  return `<i class="client-logo client-logo-fallback" aria-hidden="true">${ch}</i>`;
}
const POLL_MS = 5 * 60 * 1000;
const TREND_TOP_MODELS = 8;
/* 模型分布图例：超过 COLLAPSE_AT 行时只展开前 TOP 行，其余收进手风琴
   （本月/累计周期真实部署常见 10+ 模型，全量平铺会把面板撑到 700px+） */
const DONUT_LEGEND_TOP = 6;
const DONUT_LEGEND_COLLAPSE_AT = 8;
const MATRIX_TOP = 8;
const SESSIONS_SHOW = 5;
const HIST_PAGE = 30;

/* 矩阵色阶档数：颜色全部由 CSS 的 .mx-lv0…4 / .is-zero 承载（含暗色反向
   映射）。禁止 JS 内联色值——图例与格子必须走同一套类，否则夜间模式下
   图例还是亮色色板、方向与格子完全相反 */
const MX_LEVELS = 5;

const PERIODS = [
  ["today", "今日"],
  ["month", "本月"],
  ["allTime", "累计"],
];

/* token 构成维度：key / 中文名 / 语义色 class */
const SEGS = [
  ["input", "非缓存输入", "input"],
  ["output", "输出", "output"],
  ["cacheRead", "缓存读", "cacher"],
  ["cacheWrite", "缓存写", "cachew"],
  ["unclassified", "未分类", "uncls"],
];

const VIEWS = {
  overview: ["概览", "CLOUD MONITOR · 实时用量全景"],
  devices: ["设备", "DEVICES · 上报设备与健康度"],
  quota: ["配额与订阅", "ACCOUNTS · 配额窗口与订阅清单"],
  history: ["历史", "HISTORY · 活动热力与日归档"],
};
/* 导航次序：page-enter 的方向依据（前进从右进、后退从左进） */
const VIEW_ORDER = Object.keys(VIEWS);

const store = {
  get token() {
    try { return tokenStore().getItem(TOKEN_KEY) || ""; } catch (e) { return ""; }
  },
  set token(v) {
    try {
      if (v) tokenStore().setItem(TOKEN_KEY, v);
      else tokenStore().removeItem(TOKEN_KEY);
    } catch (e) { /* 隐私模式下静默失败 */ }
  },
};

const state = {
  data: null,
  subs: null,
  view: "overview",
  demo: false,
  modelPeriod: "today",
  clientPeriod: "today",
  actView: "month",
  mxMetric: "tokens",
  mxPeriod: "today",
  providers: null,
  histShown: HIST_PAGE,
  modelColors: {},
  clientColors: {},
  alive: false,
  loading: false,
  pollTimer: null,
  booted: false,
  entryFx: false, // true = 本次渲染播放入场动效（视图进入/首载；轮询刷新不播）
  staleData: false, // §3-10 网络失败保留上一份成功数据时置位
  /* §3 竞态控制：新请求中止旧请求；旧响应不得覆盖新密钥状态 */
  requestGeneration: 0,
  tokenRevision: 0,
  activeRequest: null,
  /* §4 辅助接口独立状态机：idle/loading/ready/empty/error/unsupported */
  aux: {
    providers: { status: "idle", data: null, aborter: null },
    subs: { status: "idle", data: null, aborter: null },
    history: {
      status: "idle", rows: [], cursor: null, done: false,
      totalDays: null, retentionDays: null, unsupported: false,
      fallback: false, loading: false, seen: new Set(), aborter: null,
      dayBasis: null, mixedTz: false, partial: false, retryTimer: null,
    },
  },
};

/* §5：后端权威在线状态。返回 true=在线 / false=离线 / null=无法判断 */
function deviceOnline(device, overview) {
  if (!device || typeof device !== "object") return null;
  if (typeof device.stale === "boolean") return !device.stale;
  let ageMs = Number(device.ageMs);
  if (!Number.isFinite(ageMs)) {
    const t = new Date(device.receivedAt).getTime();
    ageMs = Number.isNaN(t) ? NaN : Date.now() - t;
  }
  if (!Number.isFinite(ageMs)) return null;
  const sync = Number(device.syncUploadIntervalMs) || 0;
  const threshold = Math.max(sync * 2, Number((overview || {}).staleAfterMs) || 600000);
  return ageMs <= threshold;
}

/* §6：时区工具（按 overview.dashboard_time_zone / activity.time_zone） */
function tzParts(date, tz) {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short",
    });
    const p = {};
    for (const part of fmt.formatToParts(date)) p[part.type] = part.value;
    const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    return { y: Number(p.year), m: Number(p.month), d: Number(p.day), dow: DOW[p.weekday] };
  } catch (e) {
    return { y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate(), dow: date.getUTCDay() };
  }
}
function dayKeyTz(date, tz) {
  const p = tzParts(date, tz);
  return `${p.y}-${pad2(p.m)}-${pad2(p.d)}`;
}
/* 日期键日历运算（与时区无关，纯 yyyy-mm-dd 步进） */
function keyAdd(key, off) {
  const [y, m, d] = String(key).split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + off));
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}
function dowOfKey(key) {
  const dt = new Date(String(key) + "T00:00:00Z");
  return Number.isNaN(dt.getTime()) ? null : dt.getUTCDay();
}
const dashTz = () => {
  const d = state.data || {};
  return (d.activity && d.activity.time_zone) || d.dashboard_time_zone || "UTC";
};

/* 入场 stagger：--duration-stagger 40ms/项，封顶 7 项 → 总量 280ms < 300ms（polish 纪律） */
const STAGGER_CAP = 7;
const riseCls = () => (state.entryFx ? " t-rise" : "");
const riseStyle = (i) =>
  state.entryFx ? ` style="animation-delay:${Math.min(i, STAGGER_CAP) * 40}ms"` : "";


/* ================= API 层（真实 / 演示双通道） ================= */
class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function apiFetch(path, opts) {
  opts = opts || {};
  const headers = { Accept: "application/json" };
  if (store.token) headers.Authorization = "Bearer " + store.token;
  if (opts.body != null) headers["Content-Type"] = "application/json";
  let res;
  try {
    res = await fetch(path, {
      method: opts.method || "GET",
      headers,
      signal: opts && opts.signal,
      body: opts.body != null ? JSON.stringify(opts.body) : undefined,
    });
  } catch (e) {
    if (e && e.name === "AbortError") throw e;
    throw new ApiError(0, "无法连接服务器");
  }
  let data = {};
  try { data = await res.json(); } catch (e) { /* 保留默认 */ }
  if (!res.ok) {
    throw new ApiError(res.status, (data && (data.detail || data.error)) || "请求失败 " + res.status);
  }
  return data;
}

/* 统一取数入口：演示模式走 mock.js，真实模式走后端 API */
const dataApi = {
  async overview(signal) {
    if (state.demo) {
      await new Promise((r) => setTimeout(r, 180)); // 模拟网络延迟
      if (signal && signal.aborted) throw new DOMException("Aborted", "AbortError");
      if (!window.CM_MOCK) throw new ApiError(0, "演示数据模块未加载");
      return window.CM_MOCK.buildOverview();
    }
    return apiFetch(OVERVIEW_API, { signal });
  },
  async subscriptions(signal) {
    if (state.demo) {
      await new Promise((r) => setTimeout(r, 120));
      if (signal && signal.aborted) throw new DOMException("Aborted", "AbortError");
      return window.CM_MOCK ? window.CM_MOCK.buildSubscriptions() : null;
    }
    return apiFetch(SUBS_API, { signal });
  },
  async providerStatus(signal) {
    if (state.demo) {
      await new Promise((r) => setTimeout(r, 140));
      if (signal && signal.aborted) throw new DOMException("Aborted", "AbortError");
      return window.CM_MOCK && window.CM_MOCK.buildProviderStatus
        ? window.CM_MOCK.buildProviderStatus()
        : null;
    }
    return apiFetch(PROVIDER_STATUS_API, { signal });
  },
  /* §9：服务端分页日归档；后端未部署时由调用方按 unsupported 降级 */
  async historyDaily(cursor, deviceId, signal) {
    if (state.demo) {
      await new Promise((r) => setTimeout(r, 120));
      if (signal && signal.aborted) throw new DOMException("Aborted", "AbortError");
      if (!window.CM_MOCK || !window.CM_MOCK.buildHistoryPage) throw new ApiError(404, "not found");
      return window.CM_MOCK.buildHistoryPage(cursor, HIST_PAGE, deviceId);
    }
    const q = new URLSearchParams();
    q.set("limit", String(HIST_PAGE));
    if (cursor) q.set("cursor", cursor);
    if (deviceId) q.set("device_id", deviceId);
    return apiFetch(HISTORY_DAILY_API + "?" + q.toString(), { signal });
  },
  async updateCheck(signal, refresh) {
    if (state.demo) {
      await new Promise((r) => setTimeout(r, 80));
      if (signal && signal.aborted) throw new DOMException("Aborted", "AbortError");
      if (!window.CM_MOCK || !window.CM_MOCK.buildUpdateCheck) throw new ApiError(0, "演示数据模块未加载");
      return window.CM_MOCK.buildUpdateCheck();
    }
    return apiFetch(UPDATE_API + (refresh ? "?refresh=1" : ""), { signal });
  },
  async updateApply(ref, signal) {
    if (state.demo) {
      await new Promise((r) => setTimeout(r, 80));
      if (signal && signal.aborted) throw new DOMException("Aborted", "AbortError");
      if (!window.CM_MOCK || !window.CM_MOCK.applyUpdate) throw new ApiError(0, "演示数据模块未加载");
      return window.CM_MOCK.applyUpdate(ref);
    }
    return apiFetch(UPDATE_API, { method: "POST", body: { ref }, signal });
  },
};

/* ================= 连接状态 / 提示 ================= */
function setConn(stateName, text) {
  const el = $("#conn");
  el.dataset.state = stateName;
  $("#conn-text").textContent = text;
}

/* 32-banner-stacking：新 toast 顶入（depth 0），旧的后退压缩（更小、更高、更暗），
   第 4 条到来顶出最旧条；悬停堆叠展开为可读列表。指针几何判定而非 :hover ——
   展开后条目之间的间隙不属于任何元素，边界事件会抖动 */
const toastStack = { items: [] /* newest first */, spreadBound: false, expandedHeight: 0 };

function toastMs(name, fb) {
  const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name));
  return Number.isFinite(v) ? v : fb;
}

/* 无悬停 / 粗指针设备：堆叠没有展开入口，退化为普通纵向列表（审计第二轮 #1）。
   每次 toast 事件重评（仿真/混合设备可能切换），由 toastRestack 归一化 data-depth */
function toastFlat() {
  return Boolean(window.matchMedia && window.matchMedia("(hover: none), (pointer: coarse)").matches);
}

function toastRestack() {
  const flat = toastFlat();
  toastStack.items.forEach((t, i) => {
    if (flat) t.removeAttribute("data-depth");
    else t.setAttribute("data-depth", String(i));
  });
  /* 折叠态背面卡锁高到最新条：只露出受控的 12/24px 表面壳（审计第二轮 #2） */
  const root = $("#toast-root");
  if (root && !flat && toastStack.items.length) {
    root.style.setProperty("--stack-front-h", toastStack.items[0].offsetHeight + "px");
  }
}

/* 展开态位移：累计前序条目真实高度（offsetHeight）+ 间距 —— 各条高度不同也
   严丝合缝；折叠态分层位移仍由 CSS data-depth 规则负责（审计阻断项 2） */
function toastSpreadLayout() {
  const gap = toastMs("--stack-spread-gap", 8);
  let y = 0;
  toastStack.items.forEach((el, i) => {
    if (i === 0) {
      el.style.transform = "";
      y = el.offsetHeight;
    } else {
      y += gap;
      el.style.transform = `translateY(${-y}px) scale(1)`;
      el.style.opacity = "1";
      y += el.offsetHeight;
    }
  });
  toastStack.expandedHeight = y;
}

function toastSpreadReset() {
  toastStack.items.forEach((el) => { el.style.transform = ""; el.style.opacity = ""; });
  toastStack.expandedHeight = 0;
}

function toastBindSpread() {
  const root = $("#toast-root");
  if (!root) return;
  const canHover = !toastFlat();
  if (canHover && toastStack.items.length > 1 && !toastStack.spreadBound) {
    toastStack.spreadBound = true;
    document.addEventListener("pointermove", toastSpreadTrack, { passive: true });
    root.addEventListener("pointerdown", toastSpreadOpen);
  } else if ((!canHover || toastStack.items.length <= 1) && toastStack.spreadBound) {
    toastStack.spreadBound = false;
    root.classList.remove("is-spread");
    toastSpreadReset();
    document.removeEventListener("pointermove", toastSpreadTrack);
    root.removeEventListener("pointerdown", toastSpreadOpen);
  }
}

/* 点击 / 轻触入口（触屏笔记本等混合设备）：pointermove 悬停之外的第二入口 */
function toastSpreadOpen() {
  const root = $("#toast-root");
  if (toastFlat()) return;
  if (root && toastStack.items.length > 1 && !root.classList.contains("is-spread")) {
    root.classList.add("is-spread");
    toastSpreadLayout();
  }
}

function toastSpreadTrack(e) {
  const root = $("#toast-root");
  if (!root) return;
  const r = root.getBoundingClientRect();
  if (root.classList.contains("is-spread")) {
    /* 命中范围 = 实际展开边界（累计高度），不按 root 高度倍数估算 ——
       长文案展开后指针停在上层旧通知上也不得提前收拢（审计阻断项 2） */
    const top = r.bottom - (toastStack.expandedHeight || r.height);
    const inside =
      e.clientX >= r.left && e.clientX <= r.right &&
      e.clientY <= r.bottom && e.clientY >= top;
    if (!inside) {
      root.classList.remove("is-spread");
      toastSpreadReset();
    }
  } else {
    /* 命中上界 = 折叠堆栈的实际可见上缘：露出的 peek 表面也必须能触发展开
       （审计第二轮 #2 —— 视觉范围与交互命中范围不得脱节） */
    let vTop = r.top;
    toastStack.items.forEach((el) => {
      const b = el.getBoundingClientRect();
      if (b.top < vTop) vTop = b.top;
    });
    if (
      e.clientX >= r.left && e.clientX <= r.right &&
      e.clientY <= r.bottom && e.clientY >= vTop - 2
    ) {
      root.classList.add("is-spread");
      toastSpreadLayout();
    }
  }
}

function toastRetire(el) {
  if (!el || el.classList.contains("is-leaving")) return;
  /* 清掉展开态内联样式，is-leaving 的退场 transform 才能接管 */
  el.style.transform = "";
  el.style.opacity = "";
  el.classList.add("is-leaving");
  /* 关闭计时读 --stack-close，与 :root 值保持同步（22-toast 时期的手法沿用） */
  setTimeout(() => el.remove(), toastMs("--stack-close", 200) + 40);
  toastStack.items = toastStack.items.filter((t) => t !== el);
  toastRestack();
  const root = $("#toast-root");
  if (root && root.classList.contains("is-spread")) toastSpreadLayout();
  toastBindSpread();
}

function toast(msg, isErr) {
  const root = $("#toast-root");
  const flat = toastFlat();
  root.classList.toggle("t-stack-flat", flat);
  const el = document.createElement("div");
  el.className = "toast t-toast is-enter" + (isErr ? " err" : "");
  if (!flat) el.setAttribute("data-depth", "0");
  el.innerHTML =
    `<svg class="ic" aria-hidden="true"><use href="${iconHref(isErr ? "i-alert" : "i-check")}"/></svg>` +
    `<span>${esc(msg)}</span>`;
  root.appendChild(el);
  toastStack.items.unshift(el);
  /* 超出 3 层的最旧条直接顶出；其余按新→旧重排 depth，位移由 CSS 过渡接管 */
  const overflow = toastStack.items.slice(3);
  toastStack.items = toastStack.items.slice(0, 3);
  overflow.forEach((t) => toastRetire(t));
  toastRestack();
  /* 同任务内提交预入场态再释放：rAF 在帧时钟被节流时会被跳过，banner 会无动画落地 */
  void el.offsetWidth;
  el.classList.remove("is-enter");
  if (root.classList.contains("is-spread")) toastSpreadLayout();
  setTimeout(() => toastRetire(el), 4200);
  toastBindSpread();
}

/* ================= 全局悬浮 tooltip（玻璃浮层） ================= */
const floatTip = {
  el: null,
  trigger: null,
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
    if (!el.classList.contains("is-shown")) {
      /* 元素刚创建/已隐藏：先提交关闭态（reflow），再加 is-shown ——
         否则进入过渡（含 80ms intent delay）没有起点，首帧即是显示态 */
      void el.offsetWidth;
    }
    el.classList.add("is-shown");
    this.place(x, y);
  },
  place(x, y) {
    const el = this.el;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let lx = x - w / 2;
    lx = Math.max(8, Math.min(lx, vw - w - 8));
    let ly = y - h - 12;
    if (ly < 8) ly = y + 16;
    if (ly + h > vh - 8) {
      const above = y - h - 12;
      ly = above >= 8 ? above : Math.max(8, vh - h - 8);
    }
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
    rows.map(([k, v]) => `<div class="tip-row"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join("")
  );
}

/* 横条/格子 hover：tooltip 跟随 + 其余元素降透明度。
 * §10：同一 tooltip 支持 focus/blur（键盘可达）、触摸点击、Escape 与点外部关闭。 */
function bindHover(el, hotRoot, htmlFn, label) {
  const nativeInteractive = /^(A|BUTTON|INPUT|SELECT|TEXTAREA)$/.test(el.tagName);
  if (!el.hasAttribute("tabindex") && !nativeInteractive) {
    el.setAttribute("tabindex", "0");
  }
  if (label && !el.getAttribute("aria-label")) {
    /* generic 角色（div/span/i/svg rect）禁用 aria-label（axe aria-prohibited-attr），
       命名前必须先给个允许命名的角色；li 天然是 listitem，不另设 role */
    if (!nativeInteractive && !el.getAttribute("role") && el.tagName !== "LI") {
      el.setAttribute("role", "img");
    }
    el.setAttribute("aria-label", String(label));
  }
  const open = (x, y) => {
    if (hotRoot) {
      hotRoot.classList.add("has-hot");
      el.classList.add("is-hot");
    }
    floatTip.trigger = el;
    floatTip.show(htmlFn(), x, y);
  };
  const close = () => {
    if (hotRoot) {
      hotRoot.classList.remove("has-hot");
      el.classList.remove("is-hot");
    }
    floatTip.hide();
  };
  el.addEventListener("mouseenter", (e) => open(e.clientX, e.clientY));
  el.addEventListener("mousemove", (e) => floatTip.place(e.clientX, e.clientY));
  el.addEventListener("mouseleave", close);
  el.addEventListener("focus", () => {
    const r = el.getBoundingClientRect();
    open(r.left + r.width / 2, r.top);
  });
  el.addEventListener("blur", close);
  el.addEventListener("touchstart", (e) => {
    const t = e.changedTouches[0];
    if (t) open(t.clientX, t.clientY);
  }, { passive: true });
}

/* §10：Escape / 点击外部关闭浮动 tooltip */
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") floatTip.hide();
});
document.addEventListener("pointerdown", (e) => {
  if (!floatTip.el || !floatTip.el.classList.contains("is-shown")) return;
  if (floatTip.el.contains(e.target)) return;
  // 鼠标悬停中的正常点击不关闭；触摸/外部点击关闭
  if (e.pointerType !== "touch" && floatTip.trigger && floatTip.trigger.contains(e.target)) return;
  floatTip.hide();
}, true);

/* ================= 密钥门 ================= */
/* 12-error-state-shake：.is-error（边框）与 .is-shaking（抖动）分离，
   remove → reflow → re-add 保证抖动可重播 */
function gateShake() {
  const box = $("#gate-token").closest(".field-box");
  if (!box) return;
  const cs = getComputedStyle(document.documentElement);
  const ms = (n, fb) => {
    const v = parseFloat(cs.getPropertyValue(n));
    return Number.isFinite(v) ? v : fb;
  };
  box.classList.add("is-error");
  box.classList.remove("is-shaking");
  void box.offsetWidth; // force reflow
  box.classList.add("is-shaking");
  const shakeMs = ms("--shake-dur-a", 80) * 2 + ms("--shake-dur-b", 60) * 2;
  setTimeout(() => box.classList.remove("is-shaking"), shakeMs + 20);
}

function showGate(message) {
  floatTip.hide();
  state.alive = false;
  state.requestGeneration++; // §3-2：退出时中止全部请求并使在途响应失效
  abortAllRequests();
  stopPolling();
  endRefreshSpin($("#refresh"), true);
  $("#shell").hidden = true;
  $("#gate").hidden = false;
  if (IS_STANDALONE()) {
    const desc = $("#gate-desc");
    if (desc) desc.textContent = "已作为应用安装：密钥会保存在本设备，退出登录或卸载应用后清除。";
  }
  const err = $("#gate-error");
  if (message) {
    err.textContent = message;
    err.hidden = false;
    gateShake();
  } else {
    err.hidden = true;
    const box = $("#gate-token").closest(".field-box");
    if (box) box.classList.remove("is-error", "is-shaking");
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
  if (err instanceof ApiError && err.status === 500 && /密钥|token/i.test(err.message)) {
    setConn("err", "未配置");
    showGate("服务器访问令牌未配置，请先在后端设置 ACCESS_TOKEN。");
    return;
  }
  setConn("err", "服务器不可用");
  toast(err.message || "加载失败", true);
}

/* ================= 路由（四视图切换） ================= */
function updateTopbar() {
  const data = state.data || {};
  const tz = data.dashboard_time_zone ? " · 时区 " + data.dashboard_time_zone : "";
  $("#view-title").textContent = VIEWS[state.view][0];
  $("#view-sub").textContent =
    VIEWS[state.view][1] + (data.generated_at ? " · 生成于 " + fmtDateTime(data.generated_at, data.dashboard_time_zone) : "") + tz;
}

function switchView(view) {
  if (!VIEWS[view]) return;
  if (view === state.view && state.booted) return; // 重复点当前项不重播入场动画
  const prev = state.view;
  state.view = view;
  document.querySelectorAll(".view").forEach((s) => {
    s.hidden = s.dataset.view !== view;
  });
  /* page-enter：250ms 方向位移 + cross-blur（from 帧不碰 opacity，防白屏）；
     方向随 VIEW_ORDER（后退加 .page-from-left 从左进）；
     remove → reflow → re-add 保证连续切换可重播 */
  const shown = document.querySelector(`.view[data-view="${view}"]`);
  if (shown && !shown.hidden) {
    shown.classList.remove("page-enter", "page-from-left");
    void shown.offsetWidth;
    if (VIEW_ORDER.indexOf(view) < VIEW_ORDER.indexOf(prev)) shown.classList.add("page-from-left");
    shown.classList.add("page-enter");
  }
  document.querySelectorAll("[data-view].nav-item, [data-view].bn-item").forEach((b) => {
    const on = b.dataset.view === view;
    b.classList.toggle("is-active", on);
    if (on) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  });
  positionNavPills(); // is-active 更新后滑块滑向新条目（16-tabs-sliding 纵/横向）
  updateTopbar();
  floatTip.hide();
  // §4-3/§4-4：辅助数据切到对应页才加载
  if (state.alive && state.data) {
    if (view === "quota") ensureSubs();
    else if (view === "history" && state.aux.history.status === "idle") resetHistory();
  }
  // 视图可见后再渲染（图表尺寸依赖布局）；entryFx = 卡片/图表入场动效仅入场播放
  requestAnimationFrame(() => {
    state.entryFx = true;
    renderView(view);
    positionAllPills();
  });
  if (location.hash !== "#" + view) {
    const nextUrl = new URL(location.href);
    nextUrl.hash = view;
    history.replaceState(null, "", nextUrl.pathname + nextUrl.search + nextUrl.hash);
  }
}

function renderView(view) {
  if (!state.data) return;
  if (view === "overview") renderOverview();
  else if (view === "devices") renderDevicesView();
  else if (view === "quota") renderQuotaView();
  else if (view === "history") renderHistoryView();
  /* 消费入场标记并调度清理：动画结束后移除 fx 类（fill both 的终态与自然态
     一致，移除无跳变），不留永久合成层 */
  const fx = state.entryFx;
  state.entryFx = false;
  if (fx) clearEntryFxSoon();
}

/* 动画总时长上限 ≈ 280ms(stagger 封顶) + 500ms(pop) / 700ms(draw)，900ms 兜底。
   连点周期切换会重入，重置计时以免清掉正在播的 grow。 */
let clearFxTimer = 0;
function clearEntryFxSoon() {
  clearTimeout(clearFxTimer);
  clearFxTimer = setTimeout(() => {
    document.querySelectorAll(".t-rise, .t-pop, .grow, .is-drawing, .t-swap-enter").forEach((el) => {
      el.classList.remove("t-rise", "t-pop", "grow", "is-drawing", "t-swap-enter");
      el.style.animationDelay = "";
    });
    const c = $(".content");
    if (c) c.classList.remove("is-revealing");
  }, 900);
}

/* ================= 渲染层 · 公共 ================= */
/* 汇总全响应出现过的模型名 / 客户端名，生成全局一致颜色映射 */
function rebuildColorMaps(data) {
  const models = new Set();
  const clients = new Set();
  const addSplit = (per) => {
    if (!per) return;
    Object.keys(per.models || {}).forEach((m) => models.add(m));
    Object.keys(per.clients || {}).forEach((c) => clients.add(c));
    for (const key of ["clientModels", "clientModelCosts"]) {
      Object.keys(per[key] || {}).forEach((c) => {
        clients.add(c);
        const mm = per[key][c];
        if (mm && typeof mm === "object") Object.keys(mm).forEach((m) => models.add(m));
      });
    }
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
  (data.history || []).forEach((h) => {
    Object.keys((h && h.perClient) || {}).forEach((c) => clients.add(c));
    Object.keys((h && h.perModel) || {}).forEach((m) => models.add(m));
  });
  /* 取色优先级 = 全局用量降序（累计周期 tokens；缺数据的按名序垫底）：
     调色板槽位有限，唯一色必须先给「被看到最多」的名字——趋势图 top-N、
     图例头部；溢出复用只落在小占比长尾上（assignColors 契约见其注释） */
  const totalsAll = ((data.totals || {}).allTime || {});
  const byUsage = (usageMap) => (a, b) =>
    (Number((usageMap || {})[b]) || 0) - (Number((usageMap || {})[a]) || 0) || (a < b ? -1 : 1);
  state.modelColors = assignColors([...models].sort(byUsage(totalsAll.models)));
  state.clientColors = assignColors([...clients].sort(byUsage(totalsAll.clients)));
}

/* ---------- §7：Token 组成统一判定 ----------
 * componentBreakdown(period, entityType, entityName)
 * - entityType: "client" | "model" | null（null=周期整体）
 * 规则：
 * 1. 费用字段不代表 Token 组件（本函数不读任何 cost 字段）。
 * 2. 每个模型/客户端单独判断完整性（逐实体读拆分字段）。
 * 3. 来源未知（无任何拆分字段或 tokenComponents 不可用）→ known=false，调用方画单色总量条。
 * 4. 未知部分一律标「未分类」，绝不猜成非缓存输入（unclassified 独立分段）。
 * 5. 禁止按周期比例估算实体组成（本函数不做任何比例估算）。
 * 6. 组件和 ≠ 总量 → complete=false（调用方显示完整性警告）。
 * 7. capabilities.tokenComponents !== true → capable=false，不得标「真实构成」。
 */
function componentBreakdown(period, entityType, entityName) {
  period = period || {};
  /* 契约：capabilities 按周期嵌套（totals.<period>.capabilities.tokenComponents）；
     顶层 state.data.capabilities 仅作旧载荷回退 */
  const caps = period.capabilities || (state.data && state.data.capabilities) || {};
  const capable = caps.tokenComponents === true;
  let total;
  let raw;
  if (!entityType) {
    total = Number(period.totalTokens) || 0;
    raw = {
      output: period.outputTokens,
      cacheRead: period.cacheReadTokens,
      cacheWrite: period.cacheWriteTokens,
      unclassified: period.unclassifiedTokens,
    };
  } else {
    const base = entityType; // "client" | "model"
    const tokensMap = period[base + "s"] || {};
    total = Number(tokensMap[entityName]) || 0;
    raw = {
      output: (period[base + "Outputs"] || {})[entityName],
      cacheRead: (period[base + "CacheReads"] || {})[entityName],
      cacheWrite: (period[base + "CacheWrites"] || {})[entityName],
      unclassified: (period[base + "UnclassifiedTokens"] || {})[entityName],
    };
  }
  const hasAny = Object.values(raw).some((v) => v != null && Number.isFinite(Number(v)));
  if (!capable || !hasAny || total <= 0) {
    return { total, known: false, complete: false, capable, segs: [] };
  }
  const knownVals = {
    output: Number(raw.output) || 0,
    cacheRead: Number(raw.cacheRead) || 0,
    cacheWrite: Number(raw.cacheWrite) || 0,
    unclassified: Number(raw.unclassified) || 0,
  };
  // 非缓存输入 = 总量减去全部已知组件（含未分类），钳 0
  const input = Math.max(0, total - knownVals.output - knownVals.cacheRead - knownVals.cacheWrite - knownVals.unclassified);
  const segs = SEGS.map(([key, label, cls]) => ({
    key, label, cls,
    value: key === "input" ? input : knownVals[key],
  })).filter((s) => s.value > 0);
  const sum = segs.reduce((a, s) => a + s.value, 0);
  const complete = Math.abs(sum - total) <= Math.max(1, total * 0.01);
  return { total, known: true, complete, capable: true, segs };
}

function segValue(bd, key) {
  if (!bd || !bd.known) return 0;
  const s = bd.segs.find((x) => x.key === key);
  return s ? s.value : 0;
}

function cacheHitRate(bd) {
  if (!bd || !bd.known || bd.total <= 0) return null;
  return segValue(bd, "cacheRead") / bd.total;
}

/* ================= 渲染层 · 概览 ================= */
function renderKpis(data) {
  const totals = data.totals || {};
  const today = totals.today || {};
  const month = totals.month || {};
  const allTime = totals.allTime || {};
  const devices = data.devices || [];
  const onlineStates = devices.map((d) => deviceOnline(d, data));
  const online = onlineStates.filter((s) => s === true).length;
  const unknown = onlineStates.filter((s) => s === null).length;

  const breakdown = componentBreakdown(today, null, null);
  const segs = breakdown.known
    ? breakdown.segs
    : breakdown.total > 0
      ? [{ key: "unknown", label: "组成未知", cls: "uncls", value: breakdown.total }]
      : [];
  const sum = segs.reduce((a, s) => a + s.value, 0);
  const bar = segs.map((s) =>
    `<i class="seg-${s.cls}" data-label="${esc(s.label)}" data-v="${s.value}" data-pct="${((s.value / (sum || 1)) * 100).toFixed(1)}" style="width:${((s.value / (sum || 1)) * 100).toFixed(2)}%"></i>`
  ).join("");
  const legend = segs
    .map((s) => `<span><i class="seg-${s.cls}"></i>${esc(s.label)} <b>${fmtCompactHtml(s.value)}</b></span>`)
    .join("");
  const mixNote = breakdown.total > 0 && !breakdown.known
    ? '<p class="kpi-mix-note comp-warn">后端未提供精确 Token 组成，未将剩余量猜作非缓存输入。</p>'
    : breakdown.known && !breakdown.complete
      ? '<p class="kpi-mix-note comp-warn">Token 组件之和与总量不一致，请以总量为准。</p>'
      : "";
  const timedTokens = Number(today.timedTokens) || 0;
  const timedMs = Number(today.timedDurationMs) || 0;
  const timed = timedTokens > 0
    ? `计时 <b>${fmtCompactHtml(timedTokens)}</b> tokens${timedMs > 0 ? " / " + esc(fmtTimedMs(timedMs)) : ""}`
    : "今日暂无计时用量";

  const seen = devices
    .map((d) => new Date(d.receivedAt).getTime())
    .filter((t) => !Number.isNaN(t))
    .sort((a, b) => b - a)[0];

  /* 连接状态卡：有设备在 staleAfterMs 内上报 → 连线点亮 + 在线绿点；
     全部离线 → 灰线 + 离线灰点 + 最后上报时间 */
  const isOnline = online > 0;
  const connLine = isOnline
    ? `<span class="conn-track" aria-hidden="true"><i></i><i></i><i></i></span>`
    : `<span class="conn-track" aria-hidden="true"></span>`;
  const connState = isOnline
    ? `<span class="conn-state on"><span class="status-dot"></span>在线</span>`
    : `<span class="conn-state off"><span class="status-dot"></span>${onlineStates.some((s) => s === false) ? "离线" : "状态未知"}</span>`;
  const connSeen = seen
    ? `${isOnline ? "最近上报" : "最后上报"} <b>${esc(relTime(seen))}</b>`
    : "暂无设备上报";

  /* 数据刷新（非入场）时 KPI 主数字走 number pop-in（模糊滑动换数）；
     入场时整卡 t-rise，数字不再单独 pop */
  const pop = !state.entryFx && state.booted ? " t-pop" : "";

  const cards = [
    `<article class="kpi-card${riseCls()}"${riseStyle(0)}>
      <div class="kpi-tag"><span>今日 Tokens</span><svg class="ic" aria-hidden="true"><use href="${iconHref("i-zap")}"/></svg></div>
      <div class="kpi-value${pop}" title="${fmtInt(today.totalTokens)} tokens">${fmtCompactHtml(today.totalTokens)}</div>
      <p class="kpi-sub">${timed}</p>
      <div class="kpi-bar" id="kpi-mix">${bar}</div>
      <div class="kpi-legend">${legend}</div>
      ${mixNote}
    </article>`,
    `<article class="kpi-card${riseCls()}"${riseStyle(1)}>
      <div class="kpi-tag"><span>费用概览</span><svg class="ic" aria-hidden="true"><use href="${iconHref("i-coins")}"/></svg></div>
      <div class="kpi-value${pop}">${fmtUsd(today.costUsd)}<small class="kpi-unit">今日</small></div>
      <div class="kpi-rows">
        <div class="kpi-row"><span>本月成本</span><b>${fmtUsd(month.costUsd)}</b></div>
        <div class="kpi-row"><span>本月 Tokens</span><b title="${fmtInt(month.totalTokens)} tokens">${fmtCompactHtml(month.totalTokens)}</b></div>
        <div class="kpi-row"><span>历史累计</span><b title="${fmtInt(allTime.totalTokens)} tokens">${fmtCompactHtml(allTime.totalTokens)}</b></div>
      </div>
    </article>`,
    `<article class="kpi-card kpi-conn-card${isOnline ? " is-online" : " is-offline"}${riseCls()}"${riseStyle(2)}>
      <div class="kpi-tag"><span>连接状态</span><svg class="ic" aria-hidden="true"><use href="${iconHref("i-activity")}"/></svg></div>
      <div class="conn-diagram" aria-hidden="true">
        <span class="conn-node conn-node-agent"><svg class="ic"><use href="${iconHref("i-terminal")}"/></svg><em>AGENT</em></span>
        ${connLine}
        <span class="conn-node conn-node-cloud"><svg class="ic"><use href="${iconHref("i-cloud")}"/></svg><em>CLOUD</em></span>
      </div>
      <div class="conn-meta">${connState}<span class="conn-seen">${connSeen}</span></div>
      <p class="kpi-sub">在线设备 <b>${online}</b> / ${devices.length} 台${unknown ? `（${unknown} 台状态未知）` : ""}</p>
    </article>`,
  ];
  $("#kpis").innerHTML = cards.join("");
  if (pop) clearEntryFxSoon(); // 刷新换数的 t-pop 也要定时清掉，不留常驻动画类

  // 构成条 hover
  const mix = $("#kpi-mix");
  if (mix) {
    mix.querySelectorAll("i").forEach((seg) => {
      bindHover(seg, mix, () =>
        tipHtml(seg.dataset.label, [
          ["tokens", fmtCompact(seg.dataset.v)],
          ["占比", Number(seg.dataset.pct).toFixed(1) + "%"],
        ]),
        `${seg.dataset.label} ${fmtCompact(seg.dataset.v)} tokens`
      );
    });
  }
}

/* ---------- 近 30 天趋势（按模型堆叠） ---------- */
const TREND_WINDOW_DAYS = 30;

function trendRows() {
  const d = state.data || {};
  const byDay = new Map();
  const take = (day, total, models) => {
    day = String(day || "").slice(0, 10);
    if (!day) return;
    const prev = byDay.get(day) || { day, total: 0, models: {} };
    const n = Number(total) || 0;
    if (n > prev.total) prev.total = n;
    if (models && typeof models === "object") {
      for (const [k, v] of Object.entries(models)) {
        const nv = Number(typeof v === "object" && v ? v.tokens ?? v.totalTokens : v) || 0;
        if (nv > (Number(prev.models[k]) || 0)) prev.models[k] = nv;
      }
    }
    byDay.set(day, prev);
  };
  ((d.activity || {}).daily || []).forEach((r) => r && take(r.day, r.total, r.models));
  (Array.isArray(d.trend) ? d.trend : []).forEach((r) => r && take(r.day, r.total, null));
  (Array.isArray(d.trend_models) ? d.trend_models : []).forEach((r) => r && take(r.day, r.total, r.models));

  const end = ((d.dashboard_period || {}).today || {}).key || dayKeyTz(new Date(), dashTz());
  const rows = [];
  for (let i = TREND_WINDOW_DAYS - 1; i >= 0; i--) {
    const day = keyAdd(end, -i);
    rows.push(byDay.get(day) || { day, total: 0, models: {} });
  }
  return rows;
}

function renderTrend() {
  const svg = $("#trend-chart");
  const wrap = $("#trend-wrap");
  const legend = $("#trend-legend");
  const rows = trendRows();
  svg.innerHTML = "";
  svg.classList.remove("has-hot");
  legend.hidden = true;
  legend.innerHTML = "";
  if (!rows.some((r) => Number(r.total) > 0)) {
    $("#trend-empty").hidden = false;
    const old = wrap.parentElement && wrap.parentElement.querySelector(":scope > .chart-data");
    if (old) old.remove();
    return;
  }
  $("#trend-empty").hidden = true;

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

  const days = rows.map((r) => {
    const models = r.models || {};
    let other = 0;
    const vals = cats.map((m) => (m !== "其他" ? Number(models[m]) || 0 : 0));
    if (cats[cats.length - 1] === "其他") {
      for (const [k, v] of Object.entries(models)) {
        if (!topSet.has(k)) other += Number(v) || 0;
      }
      vals[vals.length - 1] = other;
    }
    const stackSum = vals.reduce((a, b) => a + b, 0);
    const total = Number(r.total) || 0;
    const rem = Math.max(0, total - stackSum);
    if (rem > 0 && cats[cats.length - 1] === "其他") vals[vals.length - 1] += rem;
    return { day: r.day, vals, total, v: stackSum + rem || total };
  });

  const W = wrap.clientWidth || 800;
  const H = wrap.clientHeight || 300;
  const padL = 58, padR = 10, padT = 18, padB = 26;
  const iw = W - padL - padR;
  const ih = H - padT - padB;
  const max = Math.max(...days.map((d) => d.v), 1);
  const n = days.length;
  const step = iw / n;
  const bw = Math.max(3, Math.min(26, step * 0.62));

  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  const NS = "http://www.w3.org/2000/svg";
  /* §10：SVG 图表 title/desc */
  const svgTitle = document.createElementNS(NS, "title");
  svgTitle.textContent = "近 30 天 tokens 趋势";
  svg.appendChild(svgTitle);
  const svgDesc = document.createElementNS(NS, "desc");
  svgDesc.textContent = `共 ${n} 天，最高单日 ${fmtInt(max)} tokens`;
  svg.appendChild(svgDesc);
  const mk = (tag, attrs) => {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    return el;
  };

  /* 柱状柔和投影：filter 作用于整组（一次滤镜 pass，30 根柱子无每根开销），
     悬停（svg.has-hot）切换为加深版投影 */
  const defs = mk("defs", {});
  defs.innerHTML =
    `<filter id="trend-shadow" x="-30%" y="-30%" width="160%" height="180%">` +
    `<feDropShadow dx="0" dy="1.5" stdDeviation="2.2" flood-color="#003770" flood-opacity="0.13"/>` +
    `</filter>` +
    `<filter id="trend-shadow-hot" x="-30%" y="-30%" width="160%" height="180%">` +
    `<feDropShadow dx="0" dy="2.5" stdDeviation="3.4" flood-color="#003770" flood-opacity="0.24"/>` +
    `</filter>`;
  svg.appendChild(defs);

  for (let g = 0; g <= 4; g++) {
    const y = padT + (ih * g) / 4;
    svg.appendChild(mk("line", { x1: padL, y1: y, x2: W - padR, y2: y, class: "chart-grid" }));
    const label = mk("text", { x: padL - 8, y: y + 3, class: "chart-axis", "text-anchor": "end" });
    label.textContent = fmtCompact(max * (1 - g / 4));
    svg.appendChild(label);
  }

  const labelEvery = Math.max(1, Math.ceil(n / (W < 560 ? 5 : 9)));
  days.forEach((d, i) => {
    if (i % labelEvery !== 0) return;
    if (n - 1 - i < labelEvery / 2 && i !== n - 1) return;
    const cx = padL + step * i + step / 2;
    const t = mk("text", { x: cx, y: H - 8, class: "chart-axis", "text-anchor": "middle" });
    t.textContent = d.day.slice(5);
    svg.appendChild(t);
  });
  if ((n - 1) % labelEvery !== 0) {
    const cx = padL + step * (n - 1) + step / 2;
    const t = mk("text", { x: Math.min(cx + step / 2, W - padR), y: H - 8, class: "chart-axis", "text-anchor": "end" });
    t.textContent = days[n - 1].day.slice(5);
    svg.appendChild(t);
  }

  const barsG = mk("g", { class: "trend-bars" });
  svg.appendChild(barsG);

  /* 入场：柱子 scaleY 从底部生长，按列 stagger 40ms，封顶 280ms（polish 总量纪律） */
  const grow = state.entryFx;

  days.forEach((d, i) => {
    const x = padL + step * i + (step - bw) / 2;
    const growCls = grow ? " grow" : "";
    const growDelay = grow ? `animation-delay:${Math.min(i, STAGGER_CAP) * 40}ms` : "";
    const radius = Math.min(4, bw / 2);
    if (d.v <= 0) {
      const bar = mk("rect", {
        x: x.toFixed(2), y: (padT + ih - 2).toFixed(2),
        width: bw.toFixed(2), height: "2",
        rx: radius.toFixed(2),
        ry: radius.toFixed(2),
        class: "trend-bar is-zero" + growCls,
        style: growDelay,
      });
      bindHover(bar, svg, () => tipHtml(d.day, [["tokens", "0"]]), `${d.day} 0 tokens`);
      barsG.appendChild(bar);
      return;
    }
    const bh = (d.v / max) * ih;
    const hasStack = (d.vals || []).some((v) => v > 0);
    if (cats.length && hasStack) {
      const clipId = `trend-col-clip-${i}`;
      const clip = mk("clipPath", { id: clipId });
      clip.appendChild(mk("rect", {
        x: x.toFixed(2),
        y: (padT + ih - bh).toFixed(2),
        width: bw.toFixed(2),
        height: Math.max(0.6, bh).toFixed(2),
        rx: radius.toFixed(2),
        ry: radius.toFixed(2),
      }));
      defs.appendChild(clip);
      const col = mk("g", { "clip-path": `url(#${clipId})` });
      let yBase = padT + ih;
      cats.forEach((m, j) => {
        const val = d.vals[j];
        if (val <= 0) return;
        const h = (val / max) * ih;
        yBase -= h;
        const rect = mk("rect", {
          x: x.toFixed(2), y: yBase.toFixed(2),
          width: bw.toFixed(2), height: Math.max(0.6, h).toFixed(2),
          class: "tseg" + growCls,
          fill: colorOf(m),
          style: growDelay,
        });
        bindHover(rect, svg, () =>
          tipHtml(d.day, [
            [m, fmtInt(val)],
            ["占当日", pct1(val, d.v)],
            ["当日合计", fmtCompact(d.total || d.v)],
          ]),
          `${d.day} ${m} ${fmtInt(val)} tokens`
        );
        col.appendChild(rect);
      });
      barsG.appendChild(col);
    } else {
      const bar = mk("rect", {
        x: x.toFixed(2), y: (padT + ih - bh).toFixed(2),
        width: bw.toFixed(2), height: bh.toFixed(2),
        rx: radius.toFixed(2),
        ry: radius.toFixed(2),
        class: "trend-bar" + growCls,
        style: growDelay,
      });
      bindHover(bar, svg, () => tipHtml(d.day, [["tokens", fmtInt(d.v)]]), `${d.day} ${fmtInt(d.v)} tokens`);
      barsG.appendChild(bar);
    }
  });

  if (cats.length) {
    legend.innerHTML = cats
      .map((m) => `<span class="lg" title="${esc(m)}"><i style="background:${colorOf(m)}"></i>${esc(m)}</span>`)
      .join("");
    legend.hidden = false;
  }

  /* §10：等价数据表放在图容器外，避免被 .chart-wrap 固定高度裁切 */
  const panel = wrap.parentElement;
  let dataTbl = panel && panel.querySelector(":scope > .chart-data");
  const wasOpen = !!(dataTbl && dataTbl.open);
  if (!dataTbl && panel) {
    dataTbl = document.createElement("details");
    dataTbl.className = "chart-data";
    panel.appendChild(dataTbl);
  }
  if (dataTbl) {
    dataTbl.innerHTML =
      `<summary>查看数据表</summary><div class="tbl-scroll"><table class="tbl"><caption>近 30 天每日 tokens 合计</caption>` +
      `<thead><tr><th scope="col">日期</th><th scope="col" class="num">Tokens</th></tr></thead><tbody>` +
      days.map((d) => `<tr><td class="mono">${esc(d.day)}</td><td class="num">${fmtInt(d.total || d.v)}</td></tr>`).join("") +
      `</tbody></table></div>`;
    dataTbl.open = wasOpen;
  }
}

/* ---------- 模型分布：环形图（中央总量 + 图例占比） ---------- */
const PERIOD_LABELS = { today: "今日", month: "本月", allTime: "累计" };

function showModelEmpty(message) {
  const box = $("#model-dist");
  box.innerHTML = "";
  box.style.display = "none";
  $("#model-empty").hidden = false;
  const p = $("#model-empty p");
  if (p) p.textContent = message;
}

/* 环形扇区：用 path 按角度画，不用 circle+dash。
   dashoffset 在累计超过 100 时和底环/scale 叠在一起，会在 6 点方向露出灰缝、
   选中段飘到另一圈半径上。外凸只加大外径，内孔不动。 */
const DONUT_CX = 60;
const DONUT_CY = 60;
const DONUT_R_IN = 38;
const DONUT_R_OUT = 52;
const DONUT_R_OUT_HOT = 56;

function donutPolar(r, deg) {
  const rad = ((deg - 90) * Math.PI) / 180;
  return [DONUT_CX + r * Math.cos(rad), DONUT_CY + r * Math.sin(rad)];
}

function donutFullRingPath(rIn, rOut) {
  return [
    `M${(DONUT_CX + rOut).toFixed(3)},${DONUT_CY.toFixed(3)}`,
    `A${rOut},${rOut} 0 1 1 ${(DONUT_CX - rOut).toFixed(3)},${DONUT_CY.toFixed(3)}`,
    `A${rOut},${rOut} 0 1 1 ${(DONUT_CX + rOut).toFixed(3)},${DONUT_CY.toFixed(3)}`,
    `M${(DONUT_CX + rIn).toFixed(3)},${DONUT_CY.toFixed(3)}`,
    `A${rIn},${rIn} 0 1 0 ${(DONUT_CX - rIn).toFixed(3)},${DONUT_CY.toFixed(3)}`,
    `A${rIn},${rIn} 0 1 0 ${(DONUT_CX + rIn).toFixed(3)},${DONUT_CY.toFixed(3)}`,
    "Z",
  ].join("");
}

function donutSlicePath(startDeg, endDeg, rOut) {
  const sweep = endDeg - startDeg;
  if (sweep >= 359.94) {
    return [
      `M${(DONUT_CX + rOut).toFixed(3)},${DONUT_CY.toFixed(3)}`,
      `A${rOut},${rOut} 0 1 1 ${(DONUT_CX - rOut).toFixed(3)},${DONUT_CY.toFixed(3)}`,
      `A${rOut},${rOut} 0 1 1 ${(DONUT_CX + rOut).toFixed(3)},${DONUT_CY.toFixed(3)}`,
      "Z",
    ].join("");
  }
  const large = sweep > 180 ? 1 : 0;
  const [x0, y0] = donutPolar(rOut, startDeg);
  const [x1, y1] = donutPolar(rOut, endDeg);
  return [
    `M${DONUT_CX},${DONUT_CY}`,
    `L${x0.toFixed(3)},${y0.toFixed(3)}`,
    `A${rOut},${rOut} 0 ${large} 1 ${x1.toFixed(3)},${y1.toFixed(3)}`,
    "Z",
  ].join("");
}

function renderModelDonut(per, animate) {
  const box = $("#model-dist");
  if (animate === undefined) animate = state.entryFx;
  per = per || {};
  const periodLabel = PERIOD_LABELS[state.modelPeriod] || "";
  const sub = $("#model-dist-sub");
  if (sub) sub.textContent = `按 token 占比 · ${periodLabel}周期`;

  const entries = Object.entries(per.models || {})
    .map(([name, v]) => [name, Number(v) || 0])
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1]);

  if (!entries.length) {
    showModelEmpty("该周期暂无模型数据");
    return;
  }

  const cacheMeta = new Map();
  entries.forEach(([name]) => {
    const rate = cacheHitRate(componentBreakdown(per, "model", name));
    if (rate != null) cacheMeta.set(name, rate);
  });
  const costs = per.modelCosts || {};

  const sliceTotal = entries.reduce((a, [, v]) => a + v, 0);
  const centerHtml = fmtCompactHtml(sliceTotal, true);
  const centerTitle = `${fmtInt(sliceTotal)} tokens`;
  const centerSub = `${periodLabel} tokens`;
  const ariaLabel = "模型分布环形图";
  const desc = `${entries.length} 个模型，合计 ${fmtInt(sliceTotal)} tokens`;
  const tipOf = (name) => () => {
    const e = entries.find(([n]) => n === name);
    const cost = costs[name];
    const rows = [
      ["tokens", fmtInt(e ? e[1] : 0)],
      ["占比", pct1(e ? e[1] : 0, sliceTotal)],
      ["模型使用费用", cost != null ? fmtUsd(cost) : "—"],
    ];
    if (cacheMeta.has(name)) rows.push(["缓存率", fmtPct(cacheMeta.get(name))]);
    return tipHtml(name, rows);
  };

  $("#model-empty").hidden = true;
  box.style.display = "";
  box.classList.remove("has-hot");
  const total = sliceTotal;

  /* SVG donut：环形扇区 path，12 点起笔顺时针。禁止底环、禁止 scale。 */
  const overlapDeg = entries.length > 1 ? 2.2 : 0;
  let deg = 0;
  const last = entries.length - 1;
  const arcs = entries.map(([name, v], i) => {
    const sweep = (v / total) * 360;
    const full = entries.length === 1;
    /* 每段两端都叠一点，12 点首尾接缝也要盖住。
       多段时禁止 sweep≥360，否则 99%+ 会被画成满环把小段吞掉。 */
    let start = full ? 0 : deg - overlapDeg;
    let end = full ? 360 : i === last ? 360 + overlapDeg : deg + sweep;
    if (!full && end - start >= 359.2) end = start + 359.2;
    const color = state.modelColors[name] || OTHER_COLOR;
    const cls = `donut-arc${animate ? " is-drawing" : ""}`;
    const arc = full
      ? `<circle class="${cls}" cx="${DONUT_CX}" cy="${DONUT_CY}" r="${DONUT_R_OUT}" fill="${color}" ` +
        `data-name="${esc(name)}" data-start="0" data-end="360" data-full="1"/>`
      : `<path class="${cls}" fill="${color}" d="${donutSlicePath(start, end, DONUT_R_OUT)}" ` +
        `data-name="${esc(name)}" data-start="${start.toFixed(3)}" data-end="${end.toFixed(3)}"/>`;
    deg += sweep;
    return arc;
  }).join("");

  const rowHtml = ([name, v]) => {
    const color = state.modelColors[name] || OTHER_COLOR;
    return `<li class="donut-lg-row" data-name="${esc(name)}">
      <i style="background:${color}"></i>
      <span class="donut-lg-name" title="${esc(name)}">${esc(name)}</span>
      <span class="donut-lg-stats">
        <span class="donut-lg-pct">${pct1(v, total)}</span>
        <b class="donut-lg-val" title="${esc(fmtInt(v) + " tokens")}">${fmtCompactHtml(v)}</b>
      </span>
    </li>`;
  };
  /* 图例折叠（catalog 21 accordion）：行数超阈值时只平铺头部大占比行，
     长尾收进 0fr↔1fr 手风琴；间隙放在裁剪层「后代」的 padding-top 上
     （0fr 轨道压不掉裁剪元素自身的 padding——PR#111 实测残条教训） */
  const collapsible = entries.length > DONUT_LEGEND_COLLAPSE_AT;
  const headEntries = collapsible ? entries.slice(0, DONUT_LEGEND_TOP) : entries;
  const tailEntries = collapsible ? entries.slice(DONUT_LEGEND_TOP) : [];
  const tailHtml = collapsible ? `
      <div class="t-acc-panel" id="model-lg-tail">
        <div class="t-acc-panel-inner">
          <ul class="donut-legend donut-legend-tail">${tailEntries.map(rowHtml).join("")}</ul>
        </div>
      </div>
      <button type="button" class="donut-lg-toggle" aria-expanded="false" aria-controls="model-lg-tail">
        <span>展开其余 ${tailEntries.length} 个模型</span>
        <span class="t-acc-chevron" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M4 6.5L8 10.5L12 6.5"/></svg></span>
      </button>` : "";

  box.innerHTML = `
    <div class="donut" role="img" aria-label="${esc(ariaLabel)}">
      <svg viewBox="0 0 120 120" width="120" height="120">
        <title>${esc(ariaLabel)}</title>
        <desc>${esc(desc)}</desc>
        <defs>
          <clipPath id="model-donut-clip" clipPathUnits="userSpaceOnUse">
            <path fill-rule="evenodd" d="${donutFullRingPath(DONUT_R_IN, 80)}"/>
          </clipPath>
        </defs>
        <g clip-path="url(#model-donut-clip)">${arcs}</g>
      </svg>
      <div class="donut-center">
        <b title="${esc(centerTitle)}">${centerHtml}</b>
        <span>${esc(centerSub)}</span>
      </div>
    </div>
    <div class="donut-lg-wrap t-acc" data-open="false">
      <ul class="donut-legend">${headEntries.map(rowHtml).join("")}</ul>${tailHtml}
    </div>`;

  /* 手风琴开合：CSS 负责高度与 chevron 翻转（scaleY 翻转跨浏览器，
     d: 路径插值是 Chromium-only——catalog 21）；重渲染默认收起 */
  const accWrap = box.querySelector(".donut-lg-wrap");
  const lgToggle = box.querySelector(".donut-lg-toggle");
  if (lgToggle) {
    lgToggle.addEventListener("click", () => {
      const open = accWrap.dataset.open !== "true";
      accWrap.dataset.open = String(open);
      lgToggle.setAttribute("aria-expanded", String(open));
      lgToggle.querySelector("span").textContent =
        open ? "收起模型列表" : `展开其余 ${tailEntries.length} 个模型`;
    });
  }

  /* 中央总量数字按内孔可用宽度自适应收缩（25→13px），
     避免大数值（如 6773.8万）在窄屏/小环上溢出错位 */
  const centerNum = box.querySelector(".donut-center b");
  const donutEl = box.querySelector(".donut");
  if (centerNum && donutEl) {
    const avail = donutEl.clientWidth * 0.58; // R=45 内孔直径 ≈ 环宽的 63%，留边取 58%
    let fs = 25;
    centerNum.style.fontSize = fs + "px";
    while (fs > 13 && centerNum.scrollWidth > avail) {
      fs -= 1;
      centerNum.style.fontSize = fs + "px";
    }
  }

  /* 弧段 / 图例行 hover 联动 + tooltip */
  const rows = box.querySelectorAll(".donut-lg-row");
  const arcEls = box.querySelectorAll(".donut-arc");
  const hot = (name, on) => {
    box.classList.toggle("has-hot", on);
    rows.forEach((r) => r.classList.toggle("is-hot", on && r.dataset.name === name));
    arcEls.forEach((a) => {
      const match = on && a.dataset.name === name;
      a.classList.toggle("is-hot", match);
      const r = match ? DONUT_R_OUT_HOT : DONUT_R_OUT;
      if (a.dataset.full === "1" && a.tagName.toLowerCase() === "circle") {
        a.setAttribute("r", r);
      } else {
        a.setAttribute("d", donutSlicePath(Number(a.dataset.start), Number(a.dataset.end), r));
      }
      if (match && a.parentNode) a.parentNode.appendChild(a);
    });
  };
  /* §10：与 bindHover 同等可达性——focus/blur（键盘）与 touchstart（触摸）
     也能触发联动与 tooltip；缓存率等 hover 信息在手机上不再不可达 */
  const bindHot = (el) => {
    const name = el.dataset.name;
    if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "0");
    if (name && !el.getAttribute("aria-label")) {
      /* generic 角色（svg path 等）命名前先给 role="img"（axe aria-prohibited-attr）；
         li 的 listitem 角色本就允许命名，加 role 反而破坏列表语义（axe list） */
      if (!el.getAttribute("role") && el.tagName !== "LI") el.setAttribute("role", "img");
      el.setAttribute("aria-label", name);
    }
    const openAt = (x, y) => { hot(name, true); floatTip.trigger = el; floatTip.show(tipOf(name)(), x, y); };
    const close = () => { hot(name, false); floatTip.hide(); };
    el.addEventListener("mouseenter", (e) => openAt(e.clientX, e.clientY));
    el.addEventListener("mousemove", (e) => floatTip.place(e.clientX, e.clientY));
    el.addEventListener("mouseleave", close);
    el.addEventListener("focus", () => {
      const r = el.getBoundingClientRect();
      openAt(r.left + r.width / 2, r.top);
    });
    el.addEventListener("blur", close);
    el.addEventListener("touchstart", (e) => {
      const t = e.changedTouches[0];
      if (t) openAt(t.clientX, t.clientY);
    }, { passive: true });
  };
  rows.forEach(bindHot);
  arcEls.forEach(bindHot);
}

function refitDonutCenters() {
  document.querySelectorAll(".donut").forEach((donutEl) => {
    const centerNum = donutEl.querySelector(".donut-center b");
    if (!centerNum) return;
    const avail = donutEl.clientWidth * 0.58;
    let fs = 25;
    centerNum.style.fontSize = fs + "px";
    while (fs > 13 && centerNum.scrollWidth > avail) {
      fs -= 1;
      centerNum.style.fontSize = fs + "px";
    }
  });
}

/* ---------- 分布（客户端条形） ---------- */
function renderDist(listSel, emptySel, subSel, per, kind, animate) {
  const box = $(listSel);
  const isModel = kind === "model";
  const base = isModel ? "model" : "client";
  per = per || {};
  if (animate === undefined) animate = state.entryFx;
  const grow = !!animate && !reducedMotion();
  const tokensMap = per[isModel ? "models" : "clients"] || {};
  const costs = per[base + "Costs"] || {};
  const colorMap = isModel ? state.modelColors : state.clientColors;
  const entries = Object.entries(tokensMap)
    .map(([name, v]) => [name, Number(v) || 0])
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1]);
  /* §7：逐实体经 componentBreakdown 判定；tokenComponents 不可用不得标「真实构成」 */
  const breakdowns = new Map(entries.map(([name]) => [name, componentBreakdown(per, base, name)]));
  const anyKnown = [...breakdowns.values()].some((b) => b.known);
  const capable = ((per.capabilities || (state.data || {}).capabilities || {}).tokenComponents) === true;
  const sub = subSel ? $(subSel) : null;
  if (sub) {
    sub.textContent = anyKnown
      ? "按 token 占比 · 条内为真实构成分段"
      : capable
        ? "按 token 占比 · 构成来源未知，显示总量"
        : "按 token 占比 · 后端未提供真实构成";
  }
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

  const tips = [];
  box.innerHTML = entries.map(([name, v], i) => {
    const color = colorMap[name] || OTHER_COLOR;
    const w = ((v / max) * 100).toFixed(2);
    const bd = breakdowns.get(name);
    let barInner, tip, costHtml = "";
    /* 未知构成：单色总量条，不做比例估算。客户端用今日/本月主段色
       （缓存读 --seg-cacher），避免累计实心 --brand-500 与有构成周期观感分裂。 */
    const solid = isModel ? color : "var(--seg-cacher)";
    const mark = clientLogoHtml(name);
    if (bd.known) {
      const denom = Math.max(v, bd.segs.reduce((a, s) => a + s.value, 0));
      barInner = bd.segs.length
        ? bd.segs.map((s) =>
            `<i class="dist-part seg-${s.cls}" style="width:${((s.value / denom) * 100).toFixed(2)}%"></i>`
          ).join("")
        : `<i class="dist-part" style="width:100%;background:${solid}"></i>`;
      const tipRows = bd.segs.map((s) => [s.label, `${fmtCompact(s.value)}（${pct1(s.value, v)}）`]);
      if (!bd.complete) tipRows.push(["完整性警告", "构成合计与总量不一致"]);
      if (costs[name] != null) {
        tipRows.push(["费用", fmtUsd(costs[name])]);
        costHtml = `<i class="dist-cost">${fmtUsd(costs[name])}</i>`;
      }
      tipRows.push(["合计", fmtInt(v)]);
      tip = () => tipHtml(name + (bd.complete ? "" : "（构成不完整）"), tipRows);
    } else {
      // §7-3/5：来源未知显示单色总量条，不做任何比例估算
      barInner = `<i class="dist-part" style="width:100%;background:${solid}"></i>`;
      const tipRows = [["合计", fmtInt(v)]];
      if (costs[name] != null) {
        tipRows.push(["费用", fmtUsd(costs[name])]);
        costHtml = `<i class="dist-cost">${fmtUsd(costs[name])}</i>`;
      }
      tipRows.push(["构成", capable ? "来源未知" : "后端未提供真实构成"]);
      tip = () => tipHtml(name, tipRows);
    }
    tips.push(tip);
    const warnHtml = bd.known && !bd.complete ? `<span class="comp-warn">构成不完整</span>` : "";
    const growCls = grow ? " grow" : "";
    const growDelay = grow ? `animation-delay:${Math.min(i, STAGGER_CAP) * 40}ms;` : "";
    return `<div class="dist-row">
      <span class="dist-name" title="${esc(name)}">${mark}${esc(name)}</span>
      <div class="dist-track"><div class="dist-bar${growCls}" style="width:${w}%;${growDelay}">${barInner}</div></div>
      <span class="dist-val" title="${fmtInt(v)} tokens"><b>${fmtCompactHtml(v)}</b>${pct1(v, sumAll)}${costHtml}${warnHtml}</span>
    </div>`;
  }).join("");

  box.querySelectorAll(".dist-row").forEach((row, i) => {
    const name = (row.querySelector(".dist-name") || {}).getAttribute?.("title") || "";
    bindHover(row.querySelector(".dist-track"), box, tips[i], name);
  });
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
  panel.hidden = false;
  box.classList.remove("has-hot");
  const cellOf = (c, m) => Number(((cm[c] || {})[m]) || 0);
  let maxV = 0;
  clients.forEach((c) => models.forEach((m) => { maxV = Math.max(maxV, cellOf(c, m)); }));
  const fmtV = isCost ? fmtUsd : fmtCompact;

  const head = [`<span class="mx-corner"></span>`]
    .concat(models.map((m) =>
      `<span class="mx-col" title="${esc(m)}">${clientLogoHtml(m)}<span class="mx-label">${esc(m)}</span></span>`
    )).join("");
  const rowsHtml = clients.map((c) => {
    const cells = models.map((m) => {
      const v = cellOf(c, m);
      if (v <= 0) return `<span class="mx-cell is-zero"></span>`;
      const t = maxV > 0 ? v / maxV : 0;
      // 离散 5 档：低值也清晰可见，避免连续渐变导致浅档看不清
      const lv = Math.min(MX_LEVELS - 1, Math.floor(t * MX_LEVELS));
      const label = `${c} × ${m}，${isCost ? "费用" : "tokens"} ${fmtV(v)}`;
      return `<span class="mx-cell mx-lv${lv}" role="img" data-c="${esc(c)}" data-m="${esc(m)}" data-v="${v}" ` +
        `data-lv="${lv}" aria-label="${esc(label)}"></span>`;
    }).join("");
    return `<span class="mx-row" title="${esc(c)}">${clientLogoHtml(c)}<span class="mx-label">${esc(c)}</span></span>${cells}`;
  }).join("");
  const scaleLegend =
    `<div class="mx-scale" aria-hidden="true"><span>低</span>` +
    `<i class="mx-cell is-zero"></i>` +
    Array.from({ length: MX_LEVELS }, (_, i) => `<i class="mx-cell mx-lv${i}"></i>`).join("") +
    `<span>高</span></div>`;
  // 格子正方形且随容器自适应，但列少时给整格网上限，避免巨型方块；
  // 窄屏（≤768px）改用 0 最小列宽 + 无整网上限，配合 CSS min-width:0 装入屏宽
  const narrow = window.matchMedia("(max-width: 768px)").matches;
  const labelCol = narrow ? "minmax(64px, 88px)" : "minmax(110px, 140px)";
  const cellCol = narrow ? "minmax(0, 1fr)" : "minmax(48px, 1fr)";
  const mxMaxW = narrow ? "none" : `${150 + models.length * 104}px`;
  box.innerHTML =
    `<div class="mx-grid" style="grid-template-columns:${labelCol} repeat(${models.length}, ${cellCol});max-width:${mxMaxW}">${head}${rowsHtml}</div>` +
    scaleLegend;

  const grid = box.querySelector(".mx-grid");
  /* 窄屏矩阵已适配屏宽：仅在确实溢出时保留“左右滑动查看”提示 */
  const scroller = panel.querySelector(".mx-scroll");
  const hint = panel.querySelector(".scroll-hint");
  if (scroller && hint) {
    hint.style.display = scroller.scrollWidth > scroller.clientWidth + 1 ? "" : "none";
  }
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
}

/* ---------- 会话明细 ---------- */
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
  const meta = data.sessions_meta || {};
  $("#sess-sub").textContent =
    `最近使用的 ${Math.min(SESSIONS_SHOW, list.length)} 条会话 · 共 ${meta.sessions_total || list.length} 条`;
  // 只保留最近 5 条：按 lastUsedAt 降序（无效/缺失时间按 0 处理，NaN 参与比较会让排序不确定）
  const lastUsedTs = (s) => {
    const t = new Date(s && s.lastUsedAt).getTime();
    return Number.isNaN(t) ? 0 : t;
  };
  const rows = list
    .slice()
    .sort((a, b) => lastUsedTs(b) - lastUsedTs(a))
    .slice(0, SESSIONS_SHOW);
  body.innerHTML = rows.map((s) => {
    const client = String(s.client || "");
    const color = state.clientColors[client] || OTHER_COLOR;
    const sid = String(s.sessionId || "");
    const models = modelNamesOf(s.models);
    const modelsHtml = models.length
      ? models.slice(0, 2).map((m) => `<span class="sess-model">${clientLogoHtml(m)}<span class="sess-model-name">${esc(m)}</span></span>`).join("")
        + (models.length > 2 ? `<span class="sess-more">+${models.length - 2}</span>` : "")
      : "—";
    const tokens = Number(s.tokens) || 0;
    const start = new Date(s.startedAt).getTime();
    const end = new Date(s.lastUsedAt).getTime();
    const dur = !Number.isNaN(start) && !Number.isNaN(end) && end >= start
      ? fmtDuration(end - start)
      : "—";
    return `<tr>
      <td><span class="dev-chip"><i style="background:${color}"></i>${esc(client || "—")}</span></td>
      <td><span class="sess-id" title="${esc(sid)}">${esc(sid.slice(0, 12))}</span></td>
      <td><span class="sess-models" title="${esc(models.join("、"))}">${modelsHtml}</span></td>
      <td class="num" title="${fmtInt(tokens)} tokens">${fmtCompact(tokens)}</td>
      <td class="num">${fmtUsd(s.costUsd)}</td>
      <td>${esc(s.project || "—")}</td>
      <td>${esc(dur)}</td>
      <td class="mute" title="${esc(fmtDateTime(s.lastUsedAt))}">${esc(relTime(s.lastUsedAt))}</td>
      <td class="mute">${esc(String(s.device || "—"))}</td>
    </tr>`;
  }).join("");
  const omitted = data.sessions_omitted || (meta.session_details_incomplete === true);
  $("#sess-omitted").hidden = !omitted;
  $("#sess-foot").hidden = !omitted;
}

/* ---------- 提供商状态（独立状态机；§9 失败显示「状态页暂不可用」） ---------- */
const PV_STATUS = {
  operational: ["正常", "ok"],
  degraded: ["部分降级", "warn"],
  maintenance: ["维护中", "warn"],
  outage: ["服务中断", "crit"],
  unknown: ["状态未知", "mute"],
};
/* status=unknown 且 error_code 非空：状态页抓取失败（稳定错误码 → 中文语义） */
const PV_ERROR_TEXT = {
  timeout: "状态页请求超时",
  http_status: "状态页返回异常",
  invalid_json: "状态页响应无法解析",
  network: "状态页网络错误",
  stats_unavailable: "用量来源暂不可用",
  subscriptions_unavailable: "订阅来源暂不可用",
};

/* 状态卡名 remap：后端 name 字段优先于 PROVIDER_NAMES，Grok 系在此统一
   改为 SpaceXAI 文案（保留 API / (Web) 区分） */
const PV_NAME_OVERRIDE = { grok: "SpaceXAI API", xai: "SpaceXAI API", "grok-web": "SpaceXAI (Web)" };

function renderProviderStatus() {
  const panel = $("#provider-panel");
  const grid = $("#provider-grid");
  const aux = state.aux.providers;
  // 404 / features.provider_status=false（Token Monitor 未启用或能力关闭）→ 整块隐藏
  if (aux.status === "unsupported") {
    panel.hidden = true;
    grid.innerHTML = "";
    return;
  }
  // 请求失败：不将失败解释为空列表
  if (aux.status === "error") {
    panel.hidden = false;
    grid.innerHTML = `<p class="aux-note err">状态页暂不可用</p>`;
    return;
  }
  const list = aux.data && Array.isArray(aux.data.providers)
    ? aux.data.providers.filter((p) => p && typeof p === "object")
    : [];
  if (!list.length) {
    panel.hidden = true;
    grid.innerHTML = "";
    return;
  }
  panel.hidden = false;
  /* 顶层 partial=true：部分来源（stats/subscriptions 或个别状态页）失败 → 面板级提示 */
  const errs = aux.data && Array.isArray(aux.data.errors) ? aux.data.errors : [];
  const errCodes = errs
    .map((e) => (e && typeof e === "object" ? e.error_code || e.code : e))
    .filter(Boolean);
  const partialNote = aux.data && aux.data.partial === true
    ? `<p class="aux-note">部分提供商状态来源暂不可用${errCodes.length ? `（${esc(errCodes.map((c) => PV_ERROR_TEXT[c] || c).join("、"))}）` : ""}</p>`
    : "";
  grid.innerHTML = partialNote + list.map((p, i) => {
    const status = String(p.status || "unknown");
    const errorCode = String(p.error_code || "");
    /* unknown + error_code：状态页抓取失败 → 「状态页暂不可用」语义，而非灰点空状态 */
    const unavailable = status === "unknown" && !!errorCode;
    const [text, lv] = unavailable
      ? ["状态页暂不可用", "warn"]
      : PV_STATUS[status] || PV_STATUS.unknown;
    const name = String(PV_NAME_OVERRIDE[String(p.provider || "").toLowerCase()] || p.name || fmtProvider(p.provider) || p.provider || "—");
    let desc = unavailable
      ? (PV_ERROR_TEXT[errorCode] || errorCode)
      : String(p.description || text);
    if (p.stale === true) desc += " · 缓存数据";
    const checked = p.checked_at ? `检测于 ${esc(relTime(p.checked_at))}` : "";
    const url = String(p.url || "");
    // scheme 白名单：esc() 只防属性逃逸，防不了 javascript:/data: 伪协议
    const safeUrl = /^https?:\/\//i.test(url) ? url : "";
    const tag = safeUrl ? "a" : "article";
    const href = safeUrl ? ` href="${esc(safeUrl)}" target="_blank" rel="noopener noreferrer"` : "";
    return `<${tag} class="pv-card lv-${lv}${riseCls()}"${riseStyle(i)}${href}${safeUrl ? ` title="${esc(safeUrl)}"` : ""}>
      <span class="pv-dot lv-${lv}" aria-hidden="true"></span>
      <div class="pv-info">
        <div class="pv-name"><strong>${esc(name)}</strong><em class="pv-status">${esc(text)}</em></div>
        <p class="pv-desc" title="${esc(desc)}">${esc(desc)}</p>
      </div>
      ${checked ? `<span class="pv-time mono">${checked}</span>` : ""}
    </${tag}>`;
  }).join("");
}

function renderOverview() {
  const data = state.data;
  floatTip.hide(); // 轮询重渲染会替换热点元素，旧 tooltip 的 mouseleave 永不触发
  renderKpis(data);
  renderProviderStatus();
  renderTrend();
  renderModelDonut((data.totals || {})[state.modelPeriod]);
  renderDist("#client-dist", "#client-empty", "#client-dist-sub", (data.totals || {})[state.clientPeriod], "client");
  renderMatrix();
  renderSessions();
}

/* ================= 渲染层 · 设备 ================= */
function diagHtml(diag, platform) {
  if (!diag) return "";
  const parts = [];
  const tools = healthEntries(diag.clientHealth);
  if (tools.length) {
    parts.push(`<div class="diag-health">${tools.map(([name, v]) => {
      const isObj = v && typeof v === "object";
      const ver = isObj ? (v.version || v.agentVersion || v.v || "") : "";
      const stRaw = diagnosticState(name, v, diag);
      const lv = healthLevel(stRaw);
      const stText = shortStatusText(stRaw) || "状态未知";
      const verText = String(ver || "").replace(/^v/, "");
      const widthPct = lv === "ok" ? 100 : lv === "warn" ? 62 : lv === "crit" ? 28 : 45;
      return `<span class="diag-tool">
        <span class="dt-name">${clientLogoHtml(name)}${esc(name)}${verText ? ` <em>v${esc(verText)}</em>` : ""}</span>
        <span class="dt-track"><i class="lv-${lv}" style="width:${widthPct}%"></i></span>
        <em title="${esc(stText)}">${esc({ ok: "健康", warn: "警告", crit: "异常", mute: "未知" }[lv])}</em>
      </span>`;
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

function renderDevicesView() {
  const data = state.data || {};
  const list = data.devices || [];
  const diagMap = {};
  (data.diagnostics || []).forEach((dg) => {
    if (dg && dg.deviceId != null) diagMap[String(dg.deviceId)] = dg;
  });
  const winMap = data.period_windows_by_device || {};
  const onlineMap = new Map(list.map((d) => [String(d.deviceId || ""), deviceOnline(d, data)]));
  const online = [...onlineMap.values()].filter((s) => s === true).length;
  const clientSet = new Set();
  list.forEach((d) => (d.trackedClients || []).forEach((c) => clientSet.add(c)));
  const todaySum = list.reduce((a, d) => a + (Number((d.today || {}).totalTokens) || 0), 0);

  $("#dev-summary").innerHTML = [
    `<span class="sum-pill${riseCls()}"${riseStyle(0)}><svg class="ic" aria-hidden="true"><use href="${iconHref("i-monitor")}"/></svg>在线 <b>${online}</b> / 共 ${list.length} 台</span>`,
    `<span class="sum-pill${riseCls()}"${riseStyle(1)}><svg class="ic" aria-hidden="true"><use href="${iconHref("i-terminal")}"/></svg>追踪客户端 <b>${clientSet.size}</b> 个</span>`,
    `<span class="sum-pill${riseCls()}"${riseStyle(2)}><svg class="ic" aria-hidden="true"><use href="${iconHref("i-zap")}"/></svg>今日合计 <b>${fmtCompactHtml(todaySum)}</b> tokens</span>`,
    `<span class="sum-pill${riseCls()}"${riseStyle(3)}><svg class="ic" aria-hidden="true"><use href="${iconHref("i-clock")}"/></svg>离线状态由服务端按每台设备的上传间隔判定</span>`,
  ].join("");

  $("#dev-grid").innerHTML = list.map((d, di) => {
    const devId = String(d.deviceId || "");
    const on = onlineMap.get(devId) ?? null;
    const name = d.hostname || devId.slice(0, 8) || "未知设备";
    const shortId = devId.length > 12 ? devId.slice(0, 8) + "…" : devId;

    const meta = [];
    const plat = [d.platform, [d.osName, d.osVersion].filter(Boolean).join(" ")].filter(Boolean).join(" · ");
    if (plat) meta.push(["i-cpu", plat]);
    const agent = [
      d.agentVersion ? `agent v${String(d.agentVersion).replace(/^v/, "")}` : "",
      d.agentRuntime || "",
    ].filter(Boolean).join(" · ");
    if (agent) meta.push(["i-activity", agent]);
    const interval = fmtInterval(d.syncUploadIntervalMs);
    if (interval) meta.push(["i-refresh", "同步 " + interval]);
    const tz = (winMap[devId] || {}).timeZone;
    if (tz) meta.push(["i-globe", String(tz)]);

    const chips = (d.trackedClients || []).map((c) =>
      `<span class="dev-chip">${clientLogoHtml(c)}${esc(c)}</span>`
    ).join("");

    const badges = [
      d.projectsEnabled ? `<span class="dev-badge">项目统计</span>` : "",
      d.historyAvailable ? `<span class="dev-badge">历史数据</span>` : "",
    ].filter(Boolean).join("");

    const stat = (label, key) => {
      const v = Number(((d[key] || {}).totalTokens) || 0);
      return `<div class="dev-stat"><span>${label}</span><b title="${fmtInt(v)} tokens">${fmtCompactHtml(v)}</b></div>`;
    };
    const cost = `<div class="dev-stat"><span>累计费用</span><b>${fmtUsd((d.allTime || {}).costUsd)}</b></div>`;

    return `<article class="dev-card${riseCls()}"${riseStyle(di)}>
      <div class="dev-top">
        <span class="status ${on === null ? "unknown" : on ? "on" : "off"}"><span class="status-dot"></span>${on === null ? "状态未知" : on ? "在线" : "离线"}</span>
        <span class="dev-seen" title="${esc(fmtDateTime(d.receivedAt))}">最近上报 ${esc(relTime(d.receivedAt))}</span>
      </div>
      <div class="dev-title">
        <h2 class="dev-host" title="${esc(d.hostname || devId)}">${esc(name)}</h2>
        ${shortId ? `<span class="dev-id mono" title="${esc(devId)}">${esc(shortId)}</span>` : ""}
      </div>
      ${meta.length ? `<div class="dev-meta">${meta.map(([ic, m]) => `<span><svg class="ic" aria-hidden="true"><use href="${iconHref(ic)}"/></svg>${esc(m)}</span>`).join("")}</div>` : ""}
      ${chips ? `<div class="dev-clients" title="AI 工具">${chips}</div>` : ""}
      ${badges ? `<div class="dev-badges">${badges}</div>` : ""}
      ${diagHtml(diagMap[devId], d.platform)}
      <div class="dev-stats">${stat("今日", "today")}${stat("本月", "month")}${stat("累计", "allTime")}${cost}</div>
    </article>`;
  }).join("");
}

/* ================= 渲染层 · 配额与订阅 ================= */
function ringSvg(pct, lv, animate) {
  const R = 26;
  const C = 2 * Math.PI * R;
  const off = C * (1 - pct / 100);
  /* 入场 draw（参考 spark-draw 700ms）：CSS keyframes 从 --ring-c（整周长）
     画到属性目标值；日常数值变化仍走 stroke-dashoffset transition */
  const draw = animate ? ` is-drawing" style="--ring-c:${C.toFixed(1)}` : "";
  return `<span class="ring lv-${lv}">
    <svg viewBox="0 0 64 64" aria-hidden="true">
      <circle class="ring-bg" cx="32" cy="32" r="${R}"/>
      <circle class="ring-fg${draw}" cx="32" cy="32" r="${R}" stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}"/>
    </svg>
    <span class="ring-num">${pct.toFixed(0)}%</span>
  </span>`;
}

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
  grid.innerHTML = list.map((l, li) => {
    const provider = String(l.provider || "unknown");
    const plan = l.planLabel ? `<span class="lim-plan">${esc(String(l.planLabel))}</span>` : "";
    let bal = "";
    if (l.balanceUsd != null && l.balanceUsd !== "" && !Number.isNaN(Number(l.balanceUsd))) {
      bal = fmtUsd(l.balanceUsd);
    } else if (typeof l.balance === "number") {
      bal = fmtCompact(l.balance);
    } else if (l.balance && typeof l.balance === "object") {
      const cand = l.balance.remaining ?? l.balance.total ?? l.balance.value ?? l.balance.amount;
      if (cand != null && !Number.isNaN(Number(cand))) bal = fmtCompact(cand);
    }
    const account = [l.accountLabel, l.accountName, l.accountEmail ? maskEmail(l.accountEmail) : ""]
      .filter(Boolean).map(String).join(" · ");
    const wins = (Array.isArray(l.windows) ? l.windows : []).map((w) => {
      if (!w || typeof w !== "object") return "";
      const label = w.label || w.name || w.window || "窗口";
      const reset = fmtReset(w.resetsAt);
      const metric = String(w.metric || "").toLowerCase();
      const hasPct = w.usedPercent != null && Number.isFinite(Number(w.usedPercent));
      const showMeter = w.showMeter !== false;
      let meter = "";
      let meta;
      if (hasPct && showMeter) {
        // percentage 窗口：圆环仪表。语义=剩余配额：未使用=整圈绿，
        // 随使用逐渐减少；颜色按已用量分档（用量越高越红，剩 ≤20% 即红）
        const used = Math.max(0, Math.min(100, Number(w.usedPercent)));
        const remain = 100 - used;
        const lv = used < 60 ? "ok" : used < 80 ? "warn" : "crit";
        meter = ringSvg(remain, lv, state.entryFx);
        meta = reset || "已用 " + used.toFixed(0) + "%";
      } else if (metric === "credits" && w.remaining != null && Number.isFinite(Number(w.remaining))) {
        // credits 只有余额：显示绝对余额
        meta = "剩余 " + fmtCompact(w.remaining) +
          (w.limit != null ? " / 上限 " + fmtCompact(w.limit) : "") + (reset ? " · " + reset : "");
      } else if (metric === "spend" && w.used != null && Number.isFinite(Number(w.used))) {
        // 与 credits 分支同规：used 未知时不得渲染成「已用 $0.00」
        meta = "已用 " + fmtUsd(w.used) + (w.limit != null ? " / " + fmtUsd(w.limit) : "") + (reset ? " · " + reset : "");
      } else if (hasPct) {
        // showMeter=false：纯文本百分比，不画仪表
        meta = "已用 " + Number(w.usedPercent).toFixed(0) + "%" + (reset ? " · " + reset : "");
      } else {
        // 没有 usedPercent：不显示 0%
        meta = reset || "用量未知";
      }
      return `<div class="lim-win">
        ${meter}
        <div class="lim-win-info">
          <span class="lim-win-label">${esc(String(label))}</span>
          <span class="lim-win-meta">${esc(meta)}</span>
        </div>
      </div>`;
    }).filter(Boolean).join("");
    return `<article class="lim-card${riseCls()}"${riseStyle(li)}>
      <div class="lim-top">
        <div class="lim-provider">${clientLogoHtml(provider)}<strong>${esc(fmtProvider(provider))}</strong>${plan}</div>
        ${bal ? `<div class="lim-balance"><span>余额</span><b>${esc(bal)}</b></div>` : ""}
      </div>
      ${account ? `<div class="lim-account" title="${esc(account)}">${esc(account)}</div>` : ""}
      ${wins ? `<div class="lim-wins">${wins}</div>` : ""}
      ${l.device ? `<div class="lim-dev">来源设备 · ${esc(String(l.device))}</div>` : ""}
    </article>`;
  }).join("");
}

/* ---------- 订阅卡（§8：kind=subscription/topup 分别渲染） ---------- */
const INTERVAL_UNITS = {
  day: "天", week: "周", month: "个月", year: "年",
  daily: "天", weekly: "周", monthly: "个月", yearly: "年", annual: "年",
};

/* 每3个月 / 每2年：interval × intervalCount */
function fmtBillingInterval(it) {
  const unit = INTERVAL_UNITS[String(it.interval || "month").toLowerCase()] || "个月";
  const count = Math.max(1, Number(it.intervalCount) || 1);
  return count > 1 ? `每 ${count} ${unit}` : `每${unit}`;
}

/* accountKey 只显示截断值 */
function truncateKey(v) {
  const s = String(v || "");
  if (!s) return "";
  return s.length > 8 ? s.slice(0, 6) + "…" : s;
}

function renderSubs() {
  const panel = $("#subs-panel");
  const grid = $("#sub-grid");
  const aux = state.aux.subs;
  if (aux.status === "loading" || aux.status === "idle") {
    panel.hidden = false;
    $("#subs-sub").textContent = "";
    grid.innerHTML = `<p class="aux-note">正在加载订阅清单…</p>`;
    return;
  }
  if (aux.status === "error" || aux.status === "unsupported") {
    panel.hidden = false;
    $("#subs-sub").textContent = "";
    grid.innerHTML = `<p class="aux-note err">订阅清单暂不可用</p>`;
    return;
  }
  const s = aux.data;
  const list = s && Array.isArray(s.subscriptions) ? s.subscriptions : [];
  if (!list.length) {
    panel.hidden = true;
    grid.innerHTML = "";
    return;
  }
  panel.hidden = false;
  $("#subs-sub").textContent = s.updated_at ? "更新于 " + fmtDateTime(s.updated_at) : "";
  grid.innerHTML = list.map((it, si) => {
    it = it && typeof it === "object" ? it : {};
    const kind = String(it.kind || "subscription").toLowerCase() === "topup" ? "topup" : "subscription";
    const topUps = Array.isArray(it.topUps) ? it.topUps : [];
    const binding = it.binding && typeof it.binding === "object"
      ? [it.binding.profileName, it.binding.accountEmail ? maskEmail(it.binding.accountEmail) : "", truncateKey(it.binding.accountKey)]
          .filter(Boolean).join(" · ")
      : (it.binding ? String(it.binding) : "");

    if (kind === "topup") {
      // 充值台账：次数 / 累计 / 最近充值；不显示月费与续费
      const topTotal = topUps.reduce((a, t) => a + (Number(t && t.amountMinor) || 0), 0);
      const latest = topUps
        .map((t) => String((t && (t.date || t.at)) || ""))
        .filter(Boolean).sort().pop();
      return `<article class="sub-card${riseCls()}"${riseStyle(si)}>
        <div class="sub-top">
          <span class="sub-provider">${clientLogoHtml(it.provider)}${esc(fmtProvider(it.provider))}</span>
          <span class="renew-badge">充值台账</span>
        </div>
        <h3 class="sub-plan">${esc(it.planName || "按量充值")}</h3>
        <div class="sub-meta">
          <span>充值 <b>${topUps.length}</b> 次</span>
          <span>累计 <b>${esc(fmtMoney(topTotal, it.currency))}</b></span>
          ${latest ? `<span>最近充值 <b>${esc(latest.slice(0, 10))}</b></span>` : ""}
        </div>
        ${binding ? `<div class="sub-binding" title="${esc(binding)}">${esc(binding)}</div>` : ""}
      </article>`;
    }

    const start = it.startDate ? String(it.startDate).slice(0, 10) : "—";
    const renewal = it.nextRenewalOverride ? String(it.nextRenewalOverride).slice(0, 10) : "";
    const tops = topUps.length
      ? `<div class="sub-topups">
          <p class="sub-topups-title">加购记录（${topUps.length}）</p>
          <ul>${topUps.map((t) => {
            const tLabel = (t && (t.label || t.name || t.title)) || "加购";
            const tAt = t && (t.date || t.at || t.createdAt);
            return `<li><span>${esc(String(tLabel))}${tAt ? ` <time>${esc(String(tAt).slice(0, 10))}</time>` : ""}</span><b>${esc(fmtMoney(t && t.amountMinor, it.currency))}</b></li>`;
          }).join("")}</ul>
        </div>`
      : "";
    return `<article class="sub-card${riseCls()}"${riseStyle(si)}>
      <div class="sub-top">
        <span class="sub-provider">${clientLogoHtml(it.provider)}${esc(fmtProvider(it.provider))}</span>
        <span class="renew-badge${it.autoRenew !== false ? " on" : ""}">${it.autoRenew !== false ? "自动续费" : "手动续费"}</span>
      </div>
      <h3 class="sub-plan">${esc(it.planName || "—")}</h3>
      <div class="sub-amount"><b>${esc(fmtMoney(it.amountMinor, it.currency))}</b><span>/ ${esc(fmtBillingInterval(it))}</span></div>
      <div class="sub-meta">
        <span><svg class="ic" aria-hidden="true"><use href="${iconHref("i-calendar")}"/></svg>开始于 <b>${esc(start)}</b></span>
        ${renewal ? `<span>下次续费 <b>${esc(renewal)}</b></span>` : ""}
      </div>
      ${binding ? `<div class="sub-binding" title="${esc(binding)}">${esc(binding)}</div>` : ""}
      ${tops}
    </article>`;
  }).join("");
}

function renderQuotaView() {
  const data = state.data || {};
  renderLimits(data.limits);
  renderSubs();
  const hasLimits = !$("#limits-panel").hidden;
  const hasSubs = !$("#subs-panel").hidden;
  $("#quota-empty").hidden = hasLimits || hasSubs;
}

/* ================= 渲染层 · 历史 ================= */
const hmLevel = (v, max) => (v > 0 ? Math.min(5, Math.max(1, Math.ceil((v / max) * 5))) : 0);

function bindHmCells(root, titleFn) {
  root.querySelectorAll(".hm-cell[data-v]").forEach((cell) => {
    const title = titleFn(cell);
    bindHover(cell, null, () => {
      const v = Number(cell.dataset.v) || 0;
      return tipHtml(titleFn(cell), [["tokens", fmtInt(v)]]);
    }, `${title} ${fmtInt(cell.dataset.v)} tokens`);
  });
}

/* 今日 24 小时桶：契约优先读 activity.hourly_today{day,time_zone,buckets}
 * （校验 day == dashboard_period.today.key，防跨日串桶），回退旧 activity.hourly 数组 */
function hourlyBuckets(act) {
  act = act || {};
  const dp = (state.data || {}).dashboard_period || {};
  const todayKey = dp.today && dp.today.key;
  const ht = act.hourly_today;
  if (ht && Array.isArray(ht.buckets) && (!todayKey || ht.day === todayKey)) return ht.buckets;
  // 旧契约回退：带 hourly_day 时同样校验日期，缺该字段（更旧后端）才放行
  if (Array.isArray(act.hourly) && (!todayKey || act.hourly_day == null || act.hourly_day === todayKey)) {
    return act.hourly;
  }
  return [];
}

/* 日：今日 24 小时格子（桶起点为后端按仪表盘时区换算后的值，直接使用） */
function renderHmDay(hm, hourly) {
  const byHour = new Array(24).fill(0);
  (hourly || []).forEach((h) => {
    const i = Number(h && h.hour);
    if (i >= 0 && i < 24) byHour[i] = Number(h.total) || 0;
  });
  const max = Math.max(...byHour, 1);
  $("#act-sub").textContent = `今日 24 小时活动（${dashTz()}）`;
  hm.innerHTML = `<div class="hm-day">` + byHour
    .map((v, i) => `<span class="hm-cell hm-d hm-${hmLevel(v, max)}" data-h="${i}" data-v="${v}">${i}</span>`)
    .join("") + `</div>`;
  bindHmCells(hm, (cell) => {
    const h = Number(cell.dataset.h);
    return `今日 ${pad2(h)}:00–${pad2((h + 1) % 24)}:00`;
  });
}

/* 周：GitHub 风格，最近 12 周 × 7 天（「今天」按仪表盘时区求值） */
function renderHmWeek(hm, daily) {
  const map = new Map((daily || []).map((r) => [r.day, Number(r.total) || 0]));
  const todayStr = dayKeyTz(new Date(), dashTz());
  const dow = (dowOfKey(todayStr) + 6) % 7; // 周一开头
  const mondayKey = keyAdd(todayStr, -dow);
  const startKey = keyAdd(mondayKey, -7 * 11);

  const grid = [];
  const months = [];
  let max = 1;
  for (let w = 0; w < 12; w++) {
    for (let d = 0; d < 7; d++) {
      const str = keyAdd(startKey, w * 7 + d);
      const future = str > todayStr;
      const v = future ? 0 : map.get(str) || 0;
      if (v > max) max = v;
      grid.push({ str, v, future });
    }
    const weekDays = grid.slice(w * 7, w * 7 + 7);
    const firstOfMonth = weekDays.find((c) => c.str.slice(8) === "01");
    if (firstOfMonth) months.push(`${Number(firstOfMonth.str.slice(5, 7))}月`);
    else if (w === 0) months.push(`${Number(weekDays[0].str.slice(5, 7))}月`);
    else months.push("");
  }
  $("#act-sub").textContent = `最近 12 周 · 每格一天（${dashTz()}）`;
  hm.innerHTML = `<div class="hm-week">
    <div class="hm-wk-months">${months.map((m) => `<span>${m}</span>`).join("")}</div>
    <div class="hm-wk-main">
      <div class="hm-wk-gutter"><span style="grid-row:1">一</span><span style="grid-row:3">三</span><span style="grid-row:5">五</span></div>
      <div class="hm-wk-grid">${grid
        .map((c) =>
          c.future
            ? `<span class="hm-cell hm-w hm-skip"></span>`
            : `<span class="hm-cell hm-w hm-${hmLevel(c.v, max)}" data-day="${c.str}" data-v="${c.v}" role="img" aria-label="${c.str} · ${fmtInt(c.v)} tokens"></span>`
        )
        .join("")}</div>
    </div>
  </div>`;
  bindHmCells(hm, (cell) => cell.dataset.day);
}

/* 月：本月日历网格 + 右侧本月摘要（月界/近 7 天/周环比均按仪表盘时区的日期键） */
function renderHmMonth(hm, daily) {
  const map = new Map((daily || []).map((r) => [r.day, Number(r.total) || 0]));
  const tz = dashTz();
  const todayStr = dayKeyTz(new Date(), tz);
  const dp = (state.data || {}).dashboard_period || {};
  // 本月键优先取后端 dashboard_period.month.key，回退时区换算
  const monthKey = String((dp.month && dp.month.key) || todayStr.slice(0, 7));
  const y = Number(monthKey.slice(0, 4));
  const m = Number(monthKey.slice(5, 7)) - 1;
  const daysIn = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const lead = (dowOfKey(monthKey + "-01") + 6) % 7;
  let max = 1;
  const cells = [];
  for (let d = 1; d <= daysIn; d++) {
    const str = `${y}-${pad2(m + 1)}-${pad2(d)}`;
    const v = map.get(str) || 0;
    if (v > max) max = v;
    cells.push({ d, v });
  }
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
  const avg = activeDays ? Math.round(total / activeDays) : 0;
  const last7 = [];
  for (let i = 6; i >= 0; i--) {
    const str = keyAdd(todayStr, -i);
    last7.push({ str, v: map.get(str) || 0 });
  }
  const sum7 = last7.reduce((a, x) => a + x.v, 0);
  const max7 = Math.max(...last7.map((x) => x.v), 1);
  const dow = (dowOfKey(todayStr) + 6) % 7; // 周一开头
  let wkThis = 0;
  let wkPrev = 0;
  for (let i = 0; i <= dow; i++) {
    wkThis += map.get(keyAdd(todayStr, -(dow - i))) || 0;
    wkPrev += map.get(keyAdd(todayStr, -(dow + 7 - i))) || 0;
  }
  const wowPct = wkPrev > 0 ? ((wkThis - wkPrev) / wkPrev) * 100 : null;
  const wowAbs = wowPct == null ? 0 : Math.abs(wowPct);
  const wow = wowPct == null
    ? ""
    : `<span class="hm-wow ${wowPct >= 0 ? "up" : "down"}" title="本周至今 ${fmtInt(wkThis)} · 上周同期 ${fmtInt(wkPrev)} tokens">` +
      `${wowPct >= 0 ? "↑" : "↓"} ${wowAbs >= 100 ? Math.round(wowAbs) : wowAbs.toFixed(1)}%<em>周环比</em></span>`;
  const sparkBars = last7.map((x) =>
    `<i${x.v > 0 ? "" : ' class="is-zero"'} data-day="${x.str}" data-v="${x.v}" ` +
    `style="height:${((x.v / max7) * 100).toFixed(1)}%"></i>`
  ).join("");
  $("#act-sub").textContent = `${y} 年 ${m + 1} 月逐日活动（${tz}）`;
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
        <div class="hm-sum"><span>本月总量</span><b title="${fmtInt(total)} tokens">${fmtCompactHtml(total)}</b></div>
        <div class="hm-sum"><span>活跃天数</span><b>${activeDays} 天</b></div>
        <div class="hm-sum"><span>最高单日</span>${best
          ? `<b title="${fmtInt(best.v)} tokens">${fmtCompactHtml(best.v)}<span class="hm-best-date"> · ${m + 1}月${best.d}日</span></b>`
          : `<b>—</b>`}</div>
      </div>
      <div class="hm-sum-mid">
        <div class="hm-avg"><span>日均 tokens</span><b title="${fmtInt(avg)} tokens">${fmtCompactHtml(avg)}</b><em>按活跃天</em></div>
        ${wow}
      </div>
      <div class="hm-spark">
        <div class="hm-spark-head"><span>近 7 天趋势</span><b title="${fmtInt(sum7)} tokens">合计 ${fmtCompactHtml(sum7)}</b></div>
        <div class="hm-spark-bars">${sparkBars}</div>
      </div>
    </div>
  </div>`;
  bindHmCells(hm, (cell) => `${m + 1}月${cell.dataset.d}日`);
  hm.querySelectorAll(".hm-spark-bars i").forEach((bar) => {
    bindHover(bar, null, () => tipHtml(bar.dataset.day, [["tokens", fmtInt(bar.dataset.v)]]), `${bar.dataset.day} ${fmtInt(bar.dataset.v)} tokens`);
  });
}

/* §6：采样覆盖率 / 首次/最近采样 / attribution_mode 展示 */
function renderCoverage(act) {
  const el = $("#hm-coverage");
  const warn = $("#hm-cov-warn");
  const devEl = $("#hm-cov-devices");
  if (!el) return;
  const cov = act && act.coverage;
  if (!cov || typeof cov !== "object") {
    el.hidden = true;
    if (warn) warn.hidden = true;
    if (devEl) devEl.hidden = true;
    return;
  }
  const parts = [];
  parts.push(`时区 <b>${esc(String(act.time_zone || (state.data || {}).dashboard_time_zone || "UTC"))}</b>`);
  if (cov.coverage_percent != null) {
    /* 契约钳制 0–100；前端再钳一次防御旧载荷 */
    const pct = Math.max(0, Math.min(100, Number(cov.coverage_percent) || 0));
    parts.push(`采样覆盖率 <b>${pct.toFixed(1)}%</b>`);
  }
  if (cov.first_sample_at) parts.push(`首次采样 <b>${esc(relTime(cov.first_sample_at))}</b>`);
  if (cov.last_sample_at) parts.push(`最近采样 <b>${esc(relTime(cov.last_sample_at))}</b>`);
  if (cov.attribution_mode) {
    const MODE = {
      delta: "增量归属",
      "delta-low-coverage": "增量归属（低覆盖）",
      "delta-with-reset": "增量归属（含计数重置）",
      none: "无归属",
    };
    parts.push(`归属模式 <b>${esc(MODE[String(cov.attribution_mode)] || String(cov.attribution_mode))}</b>`);
  }
  if (act.daily_mixed_basis === true) {
    parts.push("长期日归档 <b>混合日期口径</b>");
  }
  el.innerHTML = parts.join(" · ");
  el.hidden = false;
  /* 逐设备覆盖率诊断（契约 coverage.devices[]：expected/observed/gap/reset） */
  if (devEl) {
    const nameOf = {};
    ((state.data || {}).devices || []).forEach((d) => {
      if (d && d.deviceId != null) nameOf[String(d.deviceId)] = d.hostname || String(d.deviceId);
    });
    const devs = (Array.isArray(cov.devices) ? cov.devices : []).filter((d) => d && typeof d === "object");
    if (devs.length) {
      devEl.innerHTML = "逐设备采样（期望/实到）· " + devs.map((dv) => {
        const id = String(dv.device_id || "");
        const name = nameOf[id] || id || "未知设备";
        const exp = Number(dv.expected_buckets) || 0;
        const obs = Number(dv.observed_buckets) || 0;
        const extra = [];
        if (Number(dv.gap_count) > 0) extra.push(`缺口 ${Number(dv.gap_count)}`);
        if (Number(dv.reset_count) > 0) extra.push(`重置 ${Number(dv.reset_count)}`);
        return `<span class="hm-cov-dev"><b>${esc(name)}</b> ${obs}/${exp}${extra.length ? ` · ${esc(extra.join(" · "))}` : ""}</span>`;
      }).join(" ");
      devEl.hidden = false;
    } else {
      devEl.hidden = true;
    }
  }
  const low = cov.attribution_mode === "delta-low-coverage" ||
    (cov.coverage_percent != null && Number(cov.coverage_percent) < 60);
  if (warn) {
    const warnings = [];
    if (low) warnings.push("小时分布为采样增量归属，可能集中在首次采样时段。");
    if (act.daily_mixed_basis === true) {
      warnings.push("七天前数据来自设备本地日锚点；跨时区设备的长期日历不可视为统一仪表盘日。");
    }
    warn.textContent = warnings.join(" ");
    warn.hidden = warnings.length === 0;
  }
}

function renderActivity() {
  const act = (state.data && state.data.activity) || {};
  floatTip.hide();
  const hm = $("#hm");
  if (state.actView === "day") renderHmDay(hm, hourlyBuckets(act));
  else if (state.actView === "week") renderHmWeek(hm, act.daily || []);
  else renderHmMonth(hm, act.daily || []);
  renderCoverage(act);
}

/* ---------- 日归档表（滚动加载） ----------
 * 优先消费扩展字段 data.history[]（{day, tokens, costUsd, perClient, perModel}）；
 * 无该字段时退化为 trend_models + activity.daily 合并（仅 tokens/模型构成）。 */
const DOW_NAMES = ["日", "一", "二", "三", "四", "五", "六"];

function historyRows() {
  const d = state.data || {};
  if (Array.isArray(d.history) && d.history.length) {
    return d.history
      .filter((h) => h && h.day)
      .map((h) => ({
        day: String(h.day).slice(0, 10),
        tokens: Number(h.tokens ?? h.total) || 0,
        costUsd: h.costUsd != null ? Number(h.costUsd) : null,
        mix: h.perClient && typeof h.perClient === "object" ? { kind: "client", map: h.perClient } : null,
        mixModel: h.perModel && typeof h.perModel === "object" ? h.perModel : null,
      }))
      .sort((a, b) => (a.day < b.day ? 1 : -1));
  }
  // 回退：trend_models（30 天，模型构成）+ activity.daily（90 天，仅总量）。
  // 同日多源取 max（与 trendRows 同一合并策略）：先到先得会让日归档与
  // 趋势图在数据源不一致时对同一天显示不同总量
  const merged = new Map();
  const take = (day, total, models) => {
    if (!day) return;
    const tokens = Number(total) || 0;
    const prev = merged.get(day);
    if (!prev) {
      merged.set(day, {
        day, tokens, costUsd: null, mix: null, mixModel: models || null,
      });
      return;
    }
    if (tokens > prev.tokens) prev.tokens = tokens;
    if (models && !prev.mixModel) prev.mixModel = models;
  };
  (d.trend_models || []).forEach((r) => r && take(r.day, r.total, r.models));
  (d.trend || []).forEach((r) => r && take(r.day, r.total, null));
  ((d.activity || {}).daily || []).forEach((r) => r && take(r.day, r.total, null));
  return [...merged.values()].sort((a, b) => (a.day < b.day ? 1 : -1));
}

function histRowHtml(row) {
  const dowNum = dowOfKey(row.day);
  const dow = dowNum == null ? "" : DOW_NAMES[dowNum];
  const isToday = row.day === dayKeyTz(new Date(), dashTz());
  // 构成迷你条：优先 perClient（客户端配色），其次 perModel（模型配色）
  let mixHtml = `<span class="mute" style="font-size:11px">—</span>`;
  const src = row.mix ? row.mix.map : row.mixModel;
  if (src && row.tokens > 0) {
    const colorMap = row.mix ? state.clientColors : state.modelColors;
    const parts = Object.entries(src)
      .map(([k, v]) => [k, Number(v) || 0])
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1]);
    if (parts.length) {
      mixHtml = `<span class="hist-mix-wrap"><span class="hist-mix">` +
        parts.map(([k, v]) =>
          `<i data-label="${esc(k)}" data-v="${v}" data-pct="${((v / row.tokens) * 100).toFixed(1)}" style="width:${((v / row.tokens) * 100).toFixed(2)}%;background:${colorMap[k] || OTHER_COLOR}"></i>`
        ).join("") + `</span></span>`;
    }
  }
  /* complete=false 或 coverage 偏低 → 该日数据不完整标记 */
  const incomplete = row.complete === false || (row.coverage != null && row.coverage < 60);
  const covTitle = row.coverage != null ? `覆盖率 ${Number(row.coverage).toFixed(1)}%` : "部分设备归档损坏或缺失";
  const incBadge = incomplete
    ? `<span class="hist-inc" title="${esc(covTitle)}">数据不完整</span>`
    : "";
  return `<tr>
    <td class="${isToday ? "hist-today" : ""}"><span class="mono">${esc(row.day)}</span><span class="hist-dow">周${dow}${isToday ? " · 今天" : ""}</span>${incBadge}</td>
    <td class="num" title="${fmtInt(row.tokens)} tokens">${fmtCompact(row.tokens)}</td>
    <td class="num">${row.costUsd == null ? "—" : fmtUsd(row.costUsd)}</td>
    <td class="hist-mix-col">${mixHtml}</td>
  </tr>`;
}

function renderHistoryTable() {
  const aux = state.aux.history;
  const rows = aux.rows;
  const body = $("#hist-body");
  const sentinel = $("#hist-sentinel");
  $("#hist-empty").hidden = !(aux.status === "empty" || (aux.status !== "loading" && !rows.length));
  const retention = aux.retentionDays || 370;
  let sub;
  if (aux.fallback) {
    sub = `按日期倒序 · 共 ${rows.length} 天 · 保留 ${retention} 天（服务端分页接口不可用，显示概览内嵌数据）`;
  } else if (aux.status === "error") {
    sub = "日归档加载失败 · 稍后自动重试";
  } else {
    const total = aux.totalDays != null ? `共 ${aux.totalDays} 天` : `已加载 ${rows.length} 天`;
    sub = `按日期倒序 · ${total} · 保留 ${retention} 天`;
    /* 日口径提示：day_basis=device-local 或多设备时区混合时必须显式声明 */
    if (aux.dayBasis === "device-local") sub += " · 日口径：设备本地日";
    if (aux.mixedTz) sub += "（设备时区不一致，按各设备本地日聚合）";
    if (aux.partial) sub += " · 部分日期数据不完整";
  }
  $("#hist-sub").textContent = sub;
  body.innerHTML = rows.map(histRowHtml).join("");
  body.querySelectorAll(".hist-mix").forEach((mix) => {
    mix.querySelectorAll("i").forEach((seg) => {
      bindHover(seg, mix, () =>
        tipHtml(seg.dataset.label, [
          ["tokens", fmtCompact(seg.dataset.v)],
          ["占比", Number(seg.dataset.pct).toFixed(1) + "%"],
        ]),
        `${seg.dataset.label} ${fmtCompact(seg.dataset.v)} tokens`
      );
    });
  });
  if (aux.status === "error" && !rows.length) {
    body.innerHTML = `<tr><td colspan="4" class="aux-note err">日归档暂不可用</td></tr>`;
  }
  const more = !aux.done && aux.status !== "error";
  sentinel.hidden = !more && aux.status !== "loading";
  $("#hist-more").textContent = more ? "加载更早记录" : "";
}

function renderHistoryView() {
  renderActivity();
  renderHistoryTable();
}

/* ================= 渲染总入口 ================= */
function renderAll() {
  const data = state.data;
  if (!data) return;
  updateTopbar();
  const devices = data.devices || [];
  const empty = devices.length === 0;
  $("#empty-hero").hidden = !empty;
  document.querySelectorAll(".view").forEach((s) => {
    s.hidden = empty || s.dataset.view !== state.view;
  });
  if (empty) return;
  rebuildColorMaps(data);
  /* 首载 skeleton → 内容：面板做 cross-fade + cross-blur 400ms reveal（14 的低成本替代） */
  if (state.entryFx) $(".content").classList.add("is-revealing");
  renderView(state.view);
}

/* ================= 分段控件（滑动胶囊） ================= */
function positionPill(seg, instant) {
  const active = seg.querySelector("button.is-active");
  const pill = seg.querySelector(".seg-pill");
  if (!active || !pill) return;
  const w = active.offsetWidth;
  if (!w) return; // 容器不可见时跳过，由 positionAllPills 兜底
  /* 首次定位与 resize 必须 transition:none 写入（reflow 后恢复）——否则
     pill 从 translateX(0)/width:0 动画滑进来（catalog 16 常见错误清单） */
  const snap = instant || !pill.dataset.set;
  if (snap) pill.style.transition = "none";
  pill.style.width = w + "px";
  pill.style.transform = `translateX(${active.offsetLeft}px)`;
  if (snap) {
    void pill.offsetWidth; // force reflow
    pill.style.transition = "";
    pill.dataset.set = "1";
  }
}

/* 16-tabs-sliding 的导航适配：侧栏（纵向）/底栏（横向）共用一支定位器，
   与 positionPill 同一纪律 —— 首次与 resize 必须 transition:none 快照写入，
   否则滑块从 (0,0)/0×0 动画滑进来（catalog 16 常见错误清单）。
   对侧断点下容器 display:none → 尺寸为 0 直接跳过，resize 兜底重定位。 */
function positionNavPill(nav, instant) {
  if (!nav) return;
  const pill = nav.querySelector(".nav-pill, .bn-pill");
  const active = nav.querySelector(".is-active");
  if (!pill || !active) return;
  const w = active.offsetWidth;
  const h = active.offsetHeight;
  if (!w || !h) return;
  const snap = instant || !pill.dataset.set;
  if (snap) pill.style.transition = "none";
  pill.style.width = w + "px";
  pill.style.height = h + "px";
  pill.style.transform = `translate(${active.offsetLeft}px, ${active.offsetTop}px)`;
  if (snap) {
    void pill.offsetWidth; // force reflow
    pill.style.transition = "";
    pill.dataset.set = "1";
  }
}

function positionNavPills(instant) {
  positionNavPill($("#side-nav"), instant);
  positionNavPill(document.querySelector(".bottom-nav"), instant);
}

function positionAllPills(instant) {
  document.querySelectorAll(".seg").forEach((s) => positionPill(s, instant));
  positionNavPills(instant);
}

/* 分段内容换面：07-panel-reveal 同区双层 + 01-card-resize 舞台高度补间。
   stage = 裁剪/定位舞台（.t-swap-stage），content = 被 renderFn 以 innerHTML
   重建的容器。旧内容节点整体挪入幽灵层反向退场（挪移比克隆便宜；剥离全部
   data-* 防测试严格选择器双匹配，aria-hidden 防读屏重复），新内容 cross-blur
   进场，方向与分段滑块一致；快速连点先立刻结算上一次换面再开新面。 */
function animateContentSwap(stage, content, dir, renderFn) {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!stage || !content || reduced || !content.childElementCount || !stage.offsetHeight) {
    renderFn();
    return;
  }
  if (stage._swapDone) stage._swapDone();
  const oldH = stage.offsetHeight;
  const ghost = document.createElement("div");
  ghost.className = "t-swap-ghost";
  ghost.setAttribute("aria-hidden", "true");
  ghost.style.width = content.offsetWidth + "px";
  ghost.style.left = -stage.scrollLeft + "px";
  while (content.firstChild) ghost.appendChild(content.firstChild);
  ghost.querySelectorAll("*").forEach((el) => {
    for (const k of Object.keys(el.dataset)) delete el.dataset[k];
  });
  renderFn();
  stage.appendChild(ghost);
  /* 目标高取舞台自然高（此刻仍 auto；幽灵层 absolute 不参与），
     而非 content.offsetHeight —— 后者不含子元素外边距，结算时会跳 */
  const newH = stage.offsetHeight;
  stage.style.setProperty("--swap-from-x", (dir < 0 ? -1 : 1) * 12 + "px");
  content.classList.remove("t-swap-enter");
  void content.offsetWidth; // force reflow：连续换面可重播
  content.classList.add("t-swap-enter");
  /* 高度补间：显式旧高 → reflow → is-swapping(transition) 写新高 */
  stage.style.height = oldH + "px";
  stage.classList.add("is-swapping");
  void stage.offsetHeight;
  stage.style.height = newH + "px";
  const done = () => {
    if (stage._swapDone !== done) return;
    stage._swapDone = null;
    clearTimeout(timer);
    ghost.remove();
    content.classList.remove("t-swap-enter");
    stage.classList.remove("is-swapping");
    stage.style.height = "";
    stage.style.removeProperty("--swap-from-x");
  };
  stage._swapDone = done;
  const timer = setTimeout(done, 520); // ≥ max(进 400 / 出 350 / 补间 300) + 余量
}

function initSeg(sel, onChange, attr) {
  attr = attr || "data-p";
  const seg = $(sel);
  const panelId = seg.dataset.panel;
  if (panelId) {
    seg.querySelectorAll(`button[${attr}]`).forEach((b) => {
      if (!b.getAttribute("aria-controls")) b.setAttribute("aria-controls", panelId);
    });
    const panel = document.getElementById(panelId);
    if (panel && !panel.getAttribute("role")) {
      panel.setAttribute("role", "tabpanel");
      if (!panel.getAttribute("aria-label") && !panel.getAttribute("aria-labelledby")) {
        const labelled = seg.getAttribute("aria-label");
        if (labelled) panel.setAttribute("aria-label", labelled);
      }
    }
  }
  const activate = (btn) => {
    if (!btn || btn.classList.contains("is-active")) return;
    seg.querySelectorAll("button").forEach((b) => {
      b.classList.remove("is-active");
      b.setAttribute("aria-selected", "false");
      b.setAttribute("tabindex", "-1");
    });
    btn.classList.add("is-active");
    btn.setAttribute("aria-selected", "true");
    btn.setAttribute("tabindex", "0");
    positionPill(seg);
    onChange(btn.getAttribute(attr));
  };
  seg.addEventListener("click", (e) => {
    activate(e.target.closest(`button[${attr}]`));
  });
  /* §10：方向键 / Home / End / Enter / Space 键盘操作（tablist 语义） */
  seg.addEventListener("keydown", (e) => {
    const btns = [...seg.querySelectorAll(`button[${attr}]`)];
    const i = btns.indexOf(document.activeElement);
    if (i < 0) return;
    let j = null;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") j = (i + 1) % btns.length;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") j = (i - 1 + btns.length) % btns.length;
    else if (e.key === "Home") j = 0;
    else if (e.key === "End") j = btns.length - 1;
    if (j != null) {
      e.preventDefault();
      btns[j].focus();
      activate(btns[j]);
    }
    // Enter/Space 由原生 button click 触发（click 处理器已覆盖）
  });
  requestAnimationFrame(() => positionPill(seg, true)); // 首帧定位不带动画
}

/* ================= 骨架屏 ================= */
function skeletonAll() {
  $("#provider-panel").hidden = true;
  $("#kpis").innerHTML = Array.from({ length: 3 }).map(() =>
    `<div class="kpi-card">
      <div class="sk" style="height:11px;width:52px"></div>
      <div class="sk" style="height:30px;width:96px;margin-top:12px"></div>
      <div class="sk" style="height:11px;width:70%;margin-top:12px"></div>
      <div class="sk" style="height:10px;width:100%;margin-top:14px;border-radius:999px"></div>
    </div>`
  ).join("");
  $("#trend-chart").innerHTML = "";
  $("#trend-legend").hidden = true;
  $("#trend-empty").hidden = true;
  for (const id of ["#model-dist", "#client-dist"]) {
    $(id).innerHTML = Array.from({ length: 4 }).map((_, i) =>
      `<div style="padding:12px 0"><div class="sk" style="height:14px;width:${50 + ((i * 29) % 45)}%"></div></div>`
    ).join("");
    $(id).style.display = "block";
  }
  $("#model-empty").hidden = true;
  $("#client-empty").hidden = true;
  $("#dev-grid").innerHTML = Array.from({ length: 3 }).map(() =>
    `<article class="dev-card">
      <div class="sk" style="height:12px;width:40%"></div>
      <div class="sk" style="height:16px;width:62%"></div>
      <div class="sk" style="height:11px;width:80%"></div>
      <div class="sk" style="height:34px;width:100%;margin-top:6px"></div>
    </article>`
  ).join("");
}

/* ================= 加载与轮询 ================= */
const REFRESH_SPIN_MS = 900;
let refreshSpinTimer = null;
let refreshSpinStartedAt = 0;

function beginRefreshSpin(btn) {
  if (!btn) return;
  if (refreshSpinTimer) {
    clearTimeout(refreshSpinTimer);
    refreshSpinTimer = null;
  }
  refreshSpinStartedAt = performance.now();
  btn.disabled = true;
  btn.setAttribute("aria-busy", "true");
  btn.classList.add("is-spinning");
}

function endRefreshSpin(btn, immediate) {
  if (!btn) return;
  const finish = () => {
    refreshSpinTimer = null;
    btn.disabled = false;
    btn.removeAttribute("aria-busy");
    btn.classList.remove("is-spinning");
  };
  if (refreshSpinTimer) {
    clearTimeout(refreshSpinTimer);
    refreshSpinTimer = null;
  }
  if (immediate || !btn.classList.contains("is-spinning")) {
    finish();
    return;
  }
  const elapsed = performance.now() - refreshSpinStartedAt;
  const remain = elapsed % REFRESH_SPIN_MS === 0 && elapsed > 0
    ? 0
    : REFRESH_SPIN_MS - (elapsed % REFRESH_SPIN_MS);
  if (remain <= 16) {
    finish();
    return;
  }
  refreshSpinTimer = setTimeout(finish, remain);
}

function stopPolling() {
  if (state.pollTimer) {
    clearTimeout(state.pollTimer);
    state.pollTimer = null;
  }
}

function schedulePoll() {
  stopPolling();
  // 演示模式不轮询；页面隐藏时暂停轮询（§3-6）
  if (!state.alive || state.demo || document.hidden) return;
  state.pollTimer = setTimeout(() => load(false), POLL_MS);
}

/* §3：中止一切在途请求（主请求 + 辅助接口） */
function abortAllRequests() {
  if (state.activeRequest) state.activeRequest.abort();
  for (const key of ["providers", "subs", "history"]) {
    const aux = state.aux[key];
    if (aux.aborter) aux.aborter.abort();
  }
}

/* §4：顶部状态六态区分 */
function updateConn() {
  const d = state.data;
  if (!state.alive || !d) {
    setConn("off", "未连接");
    return;
  }
  if (state.demo) {
    setConn("ok", "演示模式");
    return;
  }
  let text;
  if (state.staleData) text = "数据可能已过期";
  else if (d.snapshot_degraded) text = "快照历史降级";
  else if (d.partial) text = "部分数据不可用";
  else text = "正常";
  const outbox = Number(d.pending_outbox) || 0;
  if (outbox > 0) text += ` · 待同步快照 ${outbox} 条`;
  setConn(text === "正常" ? "ok" : "warn", text);
}

async function load(manual) {
  /* §3-1/§3-3：新请求（含换密钥后的请求）中止旧请求，不被 state.loading 丢弃 */
  if (state.activeRequest) state.activeRequest.abort();
  const gen = ++state.requestGeneration;
  const rev = state.tokenRevision;
  const ctl = new AbortController();
  state.activeRequest = ctl;
  state.loading = true;
  const fresh = () => gen === state.requestGeneration && rev === state.tokenRevision; // §3-4
  const refreshBtn = $("#refresh");
  if (manual) beginRefreshSpin(refreshBtn);
  const firstBoot = !state.booted;
  if (firstBoot) skeletonAll();
  try {
    // §4：主加载只等 Overview；辅助接口独立异步
    const data = await dataApi.overview(ctl.signal);
    if (!fresh()) return; // 旧响应不得覆盖新密钥/新请求状态
    const dataUnchanged = !firstBoot && state.data
      && state.data.generated_at === data.generated_at
      && ((state.data.totals || {}).allTime || {}).totalTokens === ((data.totals || {}).allTime || {}).totalTokens;
    state.data = data;
    state.staleData = false;
    state.booted = true;
    hideGate();
    if (firstBoot) state.entryFx = true; // 首载：skeleton → reveal + 入场 stagger
    if (!dataUnchanged) renderAll();
    /* 同步快照定位（offsetWidth 会强制布局，无需等帧）：挂 rAF 的话，
       后台标签页/隐藏面板 rAF 冻结会让滑块一直停在 0×0（option-pro
       PR#111 教训——关键定位不挂 rAF） */
    positionAllPills(true);
    updateConn();
    $("#updated").textContent = "更新于 " + fmtDateTime(new Date().toISOString()).slice(11);
    if (manual) toast(state.demo ? "已重新生成演示数据" : "已刷新");
    // §4-2/3/4：provider-status 独立异步；配额/历史切到对应页才加载
    loadProviderStatus();
    peekUpdateBadge();
    if (state.view === "quota") ensureSubs();
    if (state.view === "history" && state.aux.history.status === "idle") resetHistory();
    schedulePoll();
  } catch (err) {
    if ((err && err.name === "AbortError") || !fresh()) return;
    if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
      store.token = ""; // §3-9：清除失效 Token
      state.tokenRevision++;
      handleApiError(err);
      return;
    }
    if (state.data) {
      // §3-10：网络失败保留上一份成功数据
      state.staleData = true;
      updateConn();
      toast((err && err.message ? err.message : "刷新失败") + "，显示上一份数据", true);
      if (state.alive) schedulePoll();
      return;
    }
    handleApiError(err);
    if (state.alive) schedulePoll();
  } finally {
    if (fresh()) {
      state.loading = false;
      state.activeRequest = null;
      endRefreshSpin(refreshBtn, !manual);
    }
  }
}

/* ---------- §4/§9：provider-status 独立状态机 ----------
 * §3-11 竞态纪律（三个辅助加载器共同遵守）：辅助接口有各自的 AbortController，
 * 不再校验主请求的 requestGeneration——同一密钥下的在途响应永远是有效数据，
 * 轮询/手动刷新/页面切回（gen 递增）不得作废它。真正要防的只有换密钥
 * （tokenRevision）与显式中止。任何提前返回都必须复位状态：此前 gen 不匹配
 * 直接 return 会把 status 永久留在 "loading"，订阅/历史从此不再加载。 */
async function loadProviderStatus() {
  const aux = state.aux.providers;
  /* 契约 features.provider_status=false → 能力关闭，不发请求、整块隐藏 */
  const feats = (state.data && state.data.features) || {};
  if (feats.provider_status === false) {
    aux.data = null;
    aux.status = "unsupported";
    renderProviderStatus();
    return;
  }
  if (aux.aborter) aux.aborter.abort();
  const ctl = new AbortController();
  aux.aborter = ctl;
  aux.status = "loading";
  const rev = state.tokenRevision;
  try {
    const res = await dataApi.providerStatus(ctl.signal);
    if (!ctl.signal.aborted && rev === state.tokenRevision) {
      const list = res && Array.isArray(res.providers) ? res.providers : [];
      aux.data = res;
      aux.status = list.length ? "ready" : "empty";
    }
  } catch (e) {
    if (!ctl.signal.aborted && rev === state.tokenRevision) {
      aux.data = null;
      aux.status = e instanceof ApiError && e.status === 404 ? "unsupported" : "error";
    }
  } finally {
    if (aux.aborter === ctl) {
      aux.aborter = null;
      if (aux.status === "loading") aux.status = "idle"; // 被中止/换密钥：允许重载
    }
  }
  renderProviderStatus();
}

/* ---------- §4：订阅清单（切到配额页才加载） ---------- */
async function ensureSubs() {
  const aux = state.aux.subs;
  if (aux.status === "ready" || aux.status === "empty" || aux.status === "loading") return;
  if (aux.aborter) aux.aborter.abort();
  const ctl = new AbortController();
  aux.aborter = ctl;
  aux.status = "loading";
  const rev = state.tokenRevision;
  if (state.view === "quota") renderQuotaView();
  try {
    const res = await dataApi.subscriptions(ctl.signal);
    if (!ctl.signal.aborted && rev === state.tokenRevision) {
      aux.data = res;
      aux.status = res && Array.isArray(res.subscriptions) && res.subscriptions.length ? "ready" : "empty";
    }
  } catch (e) {
    if (!ctl.signal.aborted && rev === state.tokenRevision) {
      aux.data = null;
      aux.status = e instanceof ApiError && e.status === 404 ? "unsupported" : "error";
    }
  } finally {
    if (aux.aborter === ctl) {
      aux.aborter = null;
      if (aux.status === "loading") aux.status = "idle"; // 被中止/换密钥：允许重载
    }
  }
  if (state.view === "quota") renderQuotaView();
}

/* ---------- §9：历史日归档（服务端分页，404/失败优雅降级） ---------- */
/* 首页加载失败（error 态）的定时重试：错误文案向用户承诺了「稍后自动重试」，
   轮询与视图切换都只认 idle 态，没有这条路径错误后只能整页刷新恢复 */
const HISTORY_RETRY_MS = 60000;

function clearHistoryRetry() {
  const aux = state.aux.history;
  if (aux.retryTimer) {
    clearTimeout(aux.retryTimer);
    aux.retryTimer = null;
  }
}

function scheduleHistoryRetry() {
  clearHistoryRetry();
  const aux = state.aux.history;
  aux.retryTimer = setTimeout(() => {
    aux.retryTimer = null;
    if (state.alive && aux.status === "error") resetHistory();
  }, HISTORY_RETRY_MS);
}

function fallbackHistoryRows() {
  const aux = state.aux.history;
  aux.unsupported = true;
  aux.fallback = true;
  aux.rows = historyRows();
  aux.totalDays = aux.rows.length;
  aux.done = true;
  aux.status = aux.rows.length ? "ready" : "empty";
}

function resetHistory() {
  const aux = state.aux.history;
  clearHistoryRetry();
  if (aux.aborter) aux.aborter.abort();
  aux.rows = [];
  aux.cursor = null;
  aux.done = false;
  aux.totalDays = null;
  aux.retentionDays = null;
  aux.unsupported = false;
  aux.fallback = false;
  aux.loading = false;
  aux.seen = new Set();
  aux.dayBasis = null;
  aux.mixedTz = false;
  aux.partial = false;
  aux.status = "idle";
  /* 契约 features.history_daily=false → 不发请求，直接走降级路径 */
  const feats = (state.data && state.data.features) || {};
  if (feats.history_daily === false) {
    fallbackHistoryRows();
    if (state.view === "history") renderHistoryTable();
    return;
  }
  loadHistoryPage();
}

async function loadHistoryPage() {
  const aux = state.aux.history;
  if (aux.loading || aux.done || !state.alive) return;
  aux.loading = true;
  aux.status = "loading";
  const ctl = new AbortController();
  aux.aborter = ctl;
  const rev = state.tokenRevision;
  const cursor = aux.cursor;
  updateHistLoading(true);
  try {
    const res = await dataApi.historyDaily(cursor, "", ctl.signal);
    if (ctl.signal.aborted || rev !== state.tokenRevision) return;
    /* 契约：items[]（day/tokens/costUsd/perClient/perModel/deviceCount/complete/coverage）；
       res.days 仅为旧载荷回退 */
    const items = res && Array.isArray(res.items) ? res.items
      : res && Array.isArray(res.days) ? res.days : [];
    let added = 0;
    for (const h of items) {
      if (!h || !h.day) continue;
      const key = String(h.day).slice(0, 10);
      if (aux.seen.has(key)) continue; // 游标去重
      aux.seen.add(key);
      added++;
      aux.rows.push({
        day: key,
        tokens: Number(h.tokens ?? h.total) || 0,
        costUsd: h.costUsd != null ? Number(h.costUsd) : null,
        mix: h.perClient && typeof h.perClient === "object" ? { kind: "client", map: h.perClient } : null,
        mixModel: h.perModel && typeof h.perModel === "object" ? h.perModel : null,
        deviceCount: h.deviceCount != null ? Number(h.deviceCount) : null,
        complete: h.complete !== false,
        coverage: h.coverage != null && Number.isFinite(Number(h.coverage)) ? Number(h.coverage) : null,
      });
    }
    aux.rows.sort((a, b) => (a.day < b.day ? 1 : -1));
    if (res.total_days != null) aux.totalDays = Number(res.total_days);
    if (res.retention_days != null) aux.retentionDays = Number(res.retention_days);
    aux.dayBasis = res.day_basis || aux.dayBasis;
    aux.mixedTz = res.mixed_time_zones === true;
    aux.partial = aux.partial || res.partial === true;
    // 游标 = 本页最后一条的 day（next_cursor 优先，缺失时取 items 尾日）
    const lastDay = items.length ? String(items[items.length - 1].day || "").slice(0, 10) : "";
    aux.cursor = res.next_cursor || lastDay || null;
    const hasMore = res.has_more != null ? res.has_more === true : !!res.next_cursor;
    aux.done = !hasMore || added === 0 || !aux.cursor;
    aux.status = aux.rows.length ? "ready" : "empty";
  } catch (e) {
    if (ctl.signal.aborted || rev !== state.tokenRevision) return;
    if (e instanceof ApiError && (e.status === 404 || e.status === 501)) {
      // 接口未部署（Token Monitor 未启用）：回退概览内嵌的 trend/activity 数据并标注
      fallbackHistoryRows();
    } else if (!aux.rows.length) {
      aux.status = "error";
      scheduleHistoryRetry();
    } else {
      aux.status = "ready"; // 已有页保留
      aux.done = true;
    }
  } finally {
    /* §3-11：只有本请求仍是当前持有者才复位（resetHistory 已开新请求时
       不得踩掉新请求的 loading）；无条件残留 loading=true 会让「加载更多」
       与滚动加载从此全部空转 */
    if (aux.aborter === ctl) {
      aux.aborter = null;
      aux.loading = false;
      if (aux.status === "loading") aux.status = aux.rows.length ? "ready" : "idle";
    }
    updateHistLoading(false);
    if (state.view === "history") renderHistoryTable();
  }
}

function updateHistLoading(on) {
  const el = $("#hist-loading");
  if (el) el.hidden = !on;
}

/* ================= 演示模式 ================= */
function resetAux() {
  for (const key of ["providers", "subs"]) {
    const aux = state.aux[key];
    if (aux.aborter) aux.aborter.abort();
    aux.status = "idle";
    aux.data = null;
  }
  const h = state.aux.history;
  clearHistoryRetry();
  if (h.aborter) h.aborter.abort();
  h.status = "idle";
  h.rows = [];
  h.cursor = null;
  h.done = false;
  h.totalDays = null;
  h.retentionDays = null;
  h.unsupported = false;
  h.fallback = false;
  h.loading = false;
  h.seen = new Set();
  h.dayBasis = null;
  h.mixedTz = false;
  h.partial = false;
}

function enterDemo() {
  state.demo = true;
  store.token = ""; // §12：演示模式不写入 sessionStorage Token
  state.tokenRevision++;
  resetAux();
  const badge = $("#demo-badge");
  if (badge) badge.hidden = false;
  const logoutText = $("#logout-text");
  if (logoutText) logoutText.textContent = "退出演示";
  const logout = $("#logout");
  if (logout) logout.setAttribute("aria-label", "退出演示");
  load(false);
}

function exitDemo() {
  state.demo = false;
  state.data = null;
  state.booted = false;
  state.staleData = false;
  resetAux();
  const badge = $("#demo-badge");
  if (badge) badge.hidden = true;
  const logoutText = $("#logout-text");
  if (logoutText) logoutText.textContent = "更换密钥";
  const logout = $("#logout");
  if (logout) logout.setAttribute("aria-label", "更换密钥");
  setConn("off", "未连接");
  showGate();
}

function peekUpdateBadge() {
  const btn = $("#upd-btn");
  if (!btn) return;
  dataApi.updateCheck().then((data) => {
    const dot = btn.querySelector(".upd-dot");
    if (dot) dot.hidden = !data.update_available;
  }).catch(() => {});
}

const updDialog = { prevFocus: null };

function closeUpdateDialog() {
  const el = $("#upd-overlay");
  if (!el || el.hidden) return;
  el.hidden = true;
  const btn = $("#upd-btn");
  if (btn) btn.setAttribute("aria-expanded", "false");
  document.removeEventListener("keydown", onUpdateDialogKeydown, true);
  const shell = $("#shell");
  if (shell) {
    shell.removeAttribute("aria-hidden");
    if ("inert" in shell) shell.inert = false;
  }
  const prev = updDialog.prevFocus;
  updDialog.prevFocus = null;
  if (prev && typeof prev.focus === "function") {
    try { prev.focus(); } catch (e) { /* 触发按钮可能已卸载 */ }
  }
}

function updDialogFocusables() {
  const card = document.querySelector("#upd-overlay .upd-card");
  if (!card) return [];
  return [...card.querySelectorAll(
    "button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex='-1'])"
  )].filter((el) => !el.hidden && el.getAttribute("hidden") == null);
}

function onUpdateDialogKeydown(e) {
  const overlay = $("#upd-overlay");
  if (!overlay || overlay.hidden) return;
  if (e.key !== "Tab") return;
  const nodes = updDialogFocusables();
  if (!nodes.length) {
    e.preventDefault();
    return;
  }
  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  const card = overlay.querySelector(".upd-card");
  const outside = card && !card.contains(document.activeElement);
  if (e.shiftKey && (document.activeElement === first || outside)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (document.activeElement === last || outside)) {
    e.preventDefault();
    first.focus();
  }
}

/* Release notes 走纯文本进入，再把 GitHub 自动 notes 里常见的 **粗体** 标记剥掉、
   URL 提升为可点链接（先 esc 转义，不产生注入面） */
function fmtUpdNotes(raw) {
  let t = esc(String(raw || "").trim());
  t = t.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/__([^_]+)__/g, "$1");
  t = t.replace(/https?:\/\/[^\s)<>"']+/g, (u) =>
    `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`);
  return t;
}

function renderUpdateDialog(data, errMsg) {
  const body = $("#upd-body");
  const applyRel = $("#upd-apply-rel");
  const applyMain = $("#upd-apply-main");
  if (!body) return;
  if (errMsg) {
    body.innerHTML = `<p class="upd-error">${esc(errMsg)}</p>`;
    if (applyRel) applyRel.hidden = true;
    if (applyMain) applyMain.hidden = true;
    return;
  }
  const cur = data.current || {};
  const latest = data.latest_release;
  const main = data.main;
  const job = data.job || {};
  const sha = cur.git_sha ? String(cur.git_sha).slice(0, 7) : "—";
  const row = (k, vHtml) =>
    `<div class="upd-row"><span class="upd-k">${k}</span><div class="upd-v">${vHtml}</div></div>`;
  const rows = [
    row("当前", `${esc(cur.version || "dev")} · <span class="mono">${esc(sha)}</span>`),
  ];
  let notesHtml = "";
  if (latest) {
    rows.push(row(
      "最新 Release",
      `${esc(latest.tag)}` +
      (latest.published_at ? ` · ${esc(String(latest.published_at).slice(0, 10))}` : "") +
      (data.release_ahead ? ` <span class="upd-pill new">有新版本</span>` : ` <span class="upd-pill ok">已是最新</span>`)
    ));
    if (latest.notes) notesHtml = `<div class="upd-notes">${fmtUpdNotes(latest.notes)}</div>`;
  } else {
    rows.push(row("最新 Release", "暂无 GitHub Release"));
  }
  if (main) {
    rows.push(row(
      "origin/main",
      `<span class="mono">${esc(main.short_sha || "")}</span>` +
      (data.main_ahead ? ` <span class="upd-pill new">有新提交</span>` : ` <span class="upd-pill ok">已同步</span>`) +
      (main.message ? ` · ${esc(main.message)}` : "")
    ));
  }
  if (data.github_error) {
    rows.push(`<p class="upd-error">${esc(data.github_error)}</p>`);
  }
  if (!data.apply_enabled) {
    rows.push(`<p class="upd-hint">检索可用。在线升级需要用 install.sh 安装，宿主机才会启动更新监视器。</p>`);
  }
  if (job.state && job.state !== "idle" && job.state !== "unavailable") {
    const JOB_LABELS = { ok: "完成", error: "失败", queued: "排队中", running: "执行中" };
    const pillCls = job.state === "error" ? "err" : job.state === "ok" ? "ok" : "new";
    rows.push(row(
      "任务",
      `<span class="upd-pill ${pillCls}">${esc(JOB_LABELS[job.state] || job.state)}</span> ` +
      esc(job.message || job.ref || "")
    ));
  }
  body.innerHTML = rows.join("") + notesHtml;
  const busy = job.state === "queued" || job.state === "running";
  if (applyRel) {
    applyRel.hidden = busy || !(data.apply_enabled && latest && data.release_ahead);
    applyRel.dataset.ref = latest ? latest.tag : "";
  }
  if (applyMain) {
    applyMain.hidden = busy || !(data.apply_enabled && data.main_ahead);
  }
  const btn = $("#upd-btn");
  if (btn) {
    const dot = btn.querySelector(".upd-dot");
    if (dot) dot.hidden = !data.update_available;
  }
}

async function openUpdateDialog() {
  const overlay = $("#upd-overlay");
  if (!overlay) return;
  if (overlay.hidden) updDialog.prevFocus = document.activeElement;
  overlay.hidden = false;
  const btn = $("#upd-btn");
  if (btn) btn.setAttribute("aria-expanded", "true");
  const shell = $("#shell");
  if (shell) {
    shell.setAttribute("aria-hidden", "true");
    if ("inert" in shell) shell.inert = true;
  }
  document.addEventListener("keydown", onUpdateDialogKeydown, true);
  const closeBtn = $("#upd-close");
  if (closeBtn) closeBtn.focus();
  const body = $("#upd-body");
  if (body) body.innerHTML = `<span class="t-shimmer">正在检索…</span>`;
  try {
    renderUpdateDialog(await dataApi.updateCheck(undefined, true));
  } catch (err) {
    renderUpdateDialog(null, (err && err.message) || "检索失败");
  }
}

async function applyUpdateRef(ref) {
  if (!ref) return;
  const body = $("#upd-body");
  if (body) body.innerHTML = `<span class="t-shimmer">已提交更新，后台执行中…</span>`;
  const applyRel = $("#upd-apply-rel");
  const applyMain = $("#upd-apply-main");
  if (applyRel) applyRel.hidden = true;
  if (applyMain) applyMain.hidden = true;
  try {
    const job = await dataApi.updateApply(ref);
    if (state.demo) {
      toast(job.message || "演示模式不会改服务器");
      renderUpdateDialog(await dataApi.updateCheck());
      return;
    }
    toast("已开始后台更新，完成后请刷新");
    let dropped = false;
    for (let i = 0; i < 180; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const data = await dataApi.updateCheck();
        const st = (data.job && data.job.state) || "";
        if (body) body.textContent = (data.job && data.job.message) || st || "更新中…";
        if (st === "ok") {
          toast("更新完成，即将刷新");
          location.reload();
          return;
        }
        if (st === "error") {
          renderUpdateDialog(data);
          toast(data.job.message || "更新失败", true);
          return;
        }
      } catch (e) {
        dropped = true;
        if (body) body.textContent = "服务正在重启，等待恢复…";
        try {
          const live = await fetch("/api/v1/health/live", { cache: "no-store" });
          if (live.ok) {
            toast("服务已恢复，即将刷新");
            location.reload();
            return;
          }
        } catch (e2) { /* still down */ }
      }
    }
    if (dropped) toast("等待超时，请手动刷新", true);
  } catch (err) {
    toast((err && err.message) || "无法提交更新", true);
    openUpdateDialog();
  }
}

/* ================= 事件 ================= */
$("#gate-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const token = $("#gate-token").value.trim();
  if (!token) {
    const err = $("#gate-error");
    err.textContent = "请输入访问密钥。";
    err.hidden = false;
    gateShake();
    return;
  }
  store.token = token;
  state.tokenRevision++; // §3-3：换密钥后新请求不被旧状态干扰
  $("#gate-token").value = "";
  load(true);
});

/* 输入即撤销错误边框（catalog 12：typing cancels），错误文案保留到下次提交 */
$("#gate-token").addEventListener("input", () => {
  const box = $("#gate-token").closest(".field-box");
  if (box) box.classList.remove("is-error", "is-shaking");
});

const gateDemo = $("#gate-demo");
if (gateDemo) gateDemo.addEventListener("click", enterDemo);

$("#logout").addEventListener("click", () => {
  if (state.demo) {
    exitDemo();
    return;
  }
  store.token = "";
  state.tokenRevision++;
  state.data = null;
  state.booted = false;
  state.staleData = false;
  resetAux();
  setConn("off", "未连接");
  showGate();
});

$("#refresh").addEventListener("click", () => load(true));

const updBtn = $("#upd-btn");
if (updBtn) updBtn.addEventListener("click", () => openUpdateDialog());
const updClose = $("#upd-close");
if (updClose) updClose.addEventListener("click", closeUpdateDialog);
const updOverlay = $("#upd-overlay");
if (updOverlay) {
  updOverlay.addEventListener("click", (e) => {
    if (e.target === updOverlay) closeUpdateDialog();
  });
}
const updRefresh = $("#upd-refresh");
if (updRefresh) updRefresh.addEventListener("click", () => openUpdateDialog());
const updApplyRel = $("#upd-apply-rel");
if (updApplyRel) {
  updApplyRel.addEventListener("click", () => applyUpdateRef(updApplyRel.dataset.ref));
}
const updApplyMain = $("#upd-apply-main");
if (updApplyMain) {
  updApplyMain.addEventListener("click", () => applyUpdateRef("main"));
}
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeUpdateDialog();
});

document.querySelectorAll("[data-view].nav-item, [data-view].bn-item").forEach((b) => {
  b.addEventListener("click", () => switchView(b.dataset.view));
});
window.addEventListener("hashchange", () => {
  const hashView = location.hash.replace(/^#/, "");
  if (VIEWS[hashView] && hashView !== state.view) switchView(hashView);
});

/* 周期/视图分段的方向：索引差的符号 → 换面进场方向与滑块一致 */
const periodIdx = (p) => PERIODS.findIndex((x) => x[0] === p);
const ACT_ORDER = ["day", "week", "month"];

/* 无舞台的轻量换面（环形图/分布列表：高度稳定，无幽灵层）：
   纯 cross-blur 重进场（--swap-from-x 未设 → 位移 0），类由 clearEntryFxSoon 回收 */
function replayEnter(el) {
  if (!el || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  el.classList.remove("t-swap-enter");
  void el.offsetWidth;
  el.classList.add("t-swap-enter");
}

initSeg("#model-seg", (p) => {
  state.modelPeriod = p;
  if (state.data) {
    renderModelDonut((state.data.totals || {})[p], true);
    replayEnter($("#model-dist"));
    clearEntryFxSoon(); // 周期切换的 is-drawing / t-swap-enter 也要清，不留常驻动画类
  }
});
initSeg("#client-seg", (p) => {
  state.clientPeriod = p;
  if (state.data) {
    renderDist("#client-dist", "#client-empty", "#client-dist-sub", (state.data.totals || {})[p], "client", true);
    clearEntryFxSoon();
  }
});
initSeg("#act-seg", (v) => {
  const dir = ACT_ORDER.indexOf(v) - ACT_ORDER.indexOf(state.actView);
  state.actView = v;
  if (state.data) animateContentSwap($(".hm-scroll"), $("#hm"), dir, renderActivity);
}, "data-v");
initSeg("#mx-metric-seg", (m) => {
  const dir = m === "cost" ? 1 : -1;
  state.mxMetric = m;
  if (state.data) animateContentSwap($(".mx-scroll"), $("#mx"), dir, renderMatrix);
}, "data-m");
initSeg("#mx-period-seg", (p) => {
  const dir = periodIdx(p) - periodIdx(state.mxPeriod);
  state.mxPeriod = p;
  if (state.data) animateContentSwap($(".mx-scroll"), $("#mx"), dir, renderMatrix);
});

/* §9：日归档服务端分页滚动加载：IntersectionObserver + 按钮兜底（防重复由 aux.loading 保证） */
$("#hist-more").addEventListener("click", () => loadHistoryPage());
if ("IntersectionObserver" in window) {
  const io = new IntersectionObserver((entries) => {
    if (entries.some((en) => en.isIntersecting) && state.alive && state.view === "history") {
      loadHistoryPage();
    }
  }, { rootMargin: "160px" });
  io.observe($("#hist-sentinel"));
}

let resizeTimer = null;
window.addEventListener("resize", () => {
  positionAllPills(true);
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (state.data && state.view === "overview") {
      renderTrend();
      /* 矩阵的窄/宽布局由渲染时的 matchMedia 快照内联决定：跨过 768px
         断点不重渲染的话，窄屏布局在宽窗口下会膨胀成巨格（反之锁死溢出） */
      renderMatrix();
      refitDonutCenters();
    }
  }, 160);
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    stopPolling(); // §3-6：页面隐藏暂停轮询
    return;
  }
  // §3-7：页面恢复只刷新一次（load 内部中止在途请求，避免并发）
  if (state.alive && !state.demo) load(false);
});

/* §3-8：页面卸载时中止请求 */
window.addEventListener("pagehide", abortAllRequests);
window.addEventListener("beforeunload", abortAllRequests);

/* ================= 主题 ================= */
const THEME_KEY = "cm_theme";
const THEME_COLOR = { light: "#f8fafd", dark: "#0b1220" };

function currentTheme() {
  return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
}

/* persist=true 仅限用户显式切换：启动即落盘会把「从未选过」固化成
   「选了亮色」，系统偏好从此永远失效，还会覆写掉其他标签页存的选择 */
function applyTheme(theme, persist) {
  const t = theme === "dark" ? "dark" : "light";
  document.documentElement.setAttribute("data-theme", t);
  if (persist) {
    try { localStorage.setItem(THEME_KEY, t); } catch (e) { /* private mode */ }
  }
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", THEME_COLOR[t]);
  document.querySelectorAll("[data-theme-toggle]").forEach((btn) => {
    btn.setAttribute("aria-pressed", t === "dark" ? "true" : "false");
    btn.setAttribute("aria-label", t === "dark" ? "切换日间模式" : "切换夜间模式");
  });
  const tip = $("#tt-theme");
  if (tip) tip.textContent = t === "dark" ? "日间模式" : "夜间模式";
}

function toggleTheme() {
  applyTheme(currentTheme() === "dark" ? "light" : "dark", true);
}

function storedTheme() {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === "dark" || v === "light" ? v : null;
  } catch (e) {
    return null;
  }
}

/* 未显式选择过主题时跟随系统亮暗切换 */
if (window.matchMedia) {
  try {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", (e) => {
      if (!storedTheme()) applyTheme(e.matches ? "dark" : "light");
    });
  } catch (e) { /* 旧内核无 addEventListener：放弃跟随，不影响手动切换 */ }
}

/* ================= 启动 ================= */
(function boot() {
  const demoMeta = document.querySelector('meta[name="cm-demo"]');
  const isDemoPage =
    document.documentElement.getAttribute("data-cm-demo") === "1" ||
    (demoMeta && String(demoMeta.content).toLowerCase() === "on");
  const hashView = location.hash.replace("#", "");
  if (VIEWS[hashView]) state.view = hashView;
  // 初始应用视图可见性
  document.querySelectorAll(".view").forEach((s) => {
    s.hidden = s.dataset.view !== state.view;
  });
  document.querySelectorAll("[data-view].nav-item, [data-view].bn-item").forEach((b) => {
    b.classList.toggle("is-active", b.dataset.view === state.view);
  });
  $("#view-title").textContent = VIEWS[state.view][0];

  /* theme-boot.js 已在 CSS 前写好 data-theme；这里只同步按钮态。
     若 theme-boot 加载失败（部署漏拷等），按存储值→系统偏好兜底恢复，
     不得把缺省当亮色回写覆盖用户已存的选择 */
  const bootAttr = document.documentElement.getAttribute("data-theme");
  applyTheme(
    bootAttr === "dark" || bootAttr === "light"
      ? bootAttr
      : storedTheme() ||
          (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches
            ? "dark"
            : "light")
  );
  document.querySelectorAll("[data-theme-toggle]").forEach((btn) => {
    btn.addEventListener("click", toggleTheme);
  });

  if (isDemoPage) enterDemo();
  else if (store.token) load(false);
  else showGate();
})();
