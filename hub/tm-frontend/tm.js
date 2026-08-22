/* token-monitor 云端面板：拉取 /api/v1/tm/overview 并渲染。无构建，原生 JS。 */
"use strict";

const TOKEN_KEY = "tm-panel-access-token";

const $ = (id) => document.getElementById(id);

function fmtTokens(n) {
  if (n == null) return "—";
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
}
function fmtCost(usd) {
  return usd ? "$" + usd.toFixed(2) : "$0";
}
function fmtWhen(iso) {
  if (!iso) return "—";
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "刚刚";
  if (mins < 60) return mins + " 分钟前";
  if (mins < 60 * 24) return Math.floor(mins / 60) + " 小时前";
  return Math.floor(mins / 1440) + " 天前";
}
function isStale(iso) {
  return Date.now() - new Date(iso).getTime() > 20 * 60 * 1000;
}
function esc(text) {
  const el = document.createElement("span");
  el.textContent = text == null ? "" : String(text);
  return el.innerHTML;
}

async function api(path) {
  const token = localStorage.getItem(TOKEN_KEY) || "";
  const res = await fetch(path, { headers: { Authorization: "Bearer " + token } });
  if (res.status === 401) throw new Error("unauthorized");
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}

function renderPeriodCard(name, period) {
  const components = [];
  if (period.outputTokens)
    components.push("输出 " + fmtTokens(period.outputTokens));
  if (period.cacheReadTokens)
    components.push("缓存读 " + fmtTokens(period.cacheReadTokens));
  if (period.cacheWriteTokens)
    components.push("缓存写 " + fmtTokens(period.cacheWriteTokens));
  if (period.unclassifiedTokens)
    components.push("未分类 " + fmtTokens(period.unclassifiedTokens));
  return (
    '<div class="period-card">' +
    '<div class="label">' + name + '</div>' +
    '<div class="tokens">' + fmtTokens(period.totalTokens) + '</div>' +
    '<div class="cost">' + fmtCost(period.costUsd) + '</div>' +
    (components.length
      ? '<div class="components">' +
        components.map((c) => '<span class="chip">' + c + "</span>").join("") +
        "</div>"
      : "") +
    "</div>"
  );
}

function renderBars(entries, unitFormatter) {
  const fmt = unitFormatter || fmtTokens;
  const max = Math.max(1, ...entries.map(([, v]) => v));
  return entries
    .map(([name, value]) => {
      const width = Math.round((value / max) * 100);
      return (
        '<div class="row">' +
        '<div class="name"><span>' + esc(name) + "</span><span>" + fmt(value) + "</span></div>" +
        '<div class="track"><div class="fill" style="width:' + width + '%"></div></div>' +
        "</div>"
      );
    })
    .join("");
}

function renderTrend(trend) {
  if (!trend || trend.length === 0)
    return '<div class="trend-empty">暂无趋势数据（数据积累后自动出现）</div>';
  const max = Math.max(1, ...trend.map((d) => d.total));
  return trend
    .map((d) => {
      const height = Math.max(2, Math.round((d.total / max) * 100));
      return (
        '<div class="bar" style="height:' + height + '%">' +
        "<span>" + d.day.slice(5) + " · " + fmtTokens(d.total) + "</span>" +
        "</div>"
      );
    })
    .join("");
}

function renderDevices(devices) {
  const tbody = $("devices").querySelector("tbody");
  tbody.innerHTML = devices
    .map((d) => {
      const stale = isStale(d.receivedAt);
      return (
        "<tr>" +
        "<td>" + esc(d.hostname || d.deviceId) + (stale ? ' <span class="stale">· 离线</span>' : "") + "</td>" +
        "<td>" + esc((d.platform || "") + (d.osName ? " / " + d.osName : "")) + "</td>" +
        '<td class="num">' + fmtTokens(d.today && d.today.totalTokens) + "</td>" +
        '<td class="num">' + fmtTokens(d.month && d.month.totalTokens) + "</td>" +
        '<td class="num">' + fmtTokens(d.allTime && d.allTime.totalTokens) + "</td>" +
        "<td>" + fmtWhen(d.receivedAt) + "</td>" +
        "</tr>"
      );
    })
    .join("");
}

function render(data) {
  $("period-cards").innerHTML =
    renderPeriodCard("今日", data.totals.today) +
    renderPeriodCard("本月", data.totals.month) +
    renderPeriodCard("全部", data.totals.allTime);

  const models = Object.entries(data.totals.today.models || {}).sort((a, b) => b[1] - a[1]).slice(0, 12);
  $("models").innerHTML = models.length ? renderBars(models) : '<div class="trend-empty">今日暂无模型数据</div>';

  const clients = Object.entries(data.totals.today.clients || {}).sort((a, b) => b[1] - a[1]);
  $("clients").innerHTML = clients.length ? renderBars(clients) : '<div class="trend-empty">今日暂无客户端数据</div>';

  $("trend").innerHTML = renderTrend(data.trend);
  renderDevices(data.devices || []);
  $("generated-at").textContent = "更新于 " + new Date(data.generated_at).toLocaleString();

  const noDevices = !data.devices || data.devices.length === 0;
  $("empty").hidden = !noDevices;
  $("content").hidden = noDevices;
}

async function load() {
  try {
    const data = await api("/api/v1/tm/overview");
    $("login").hidden = true;
    $("logout").hidden = false;
    render(data);
  } catch (err) {
    if (err.message === "unauthorized") {
      $("login").hidden = false;
      $("content").hidden = true;
      $("empty").hidden = true;
      const saved = localStorage.getItem(TOKEN_KEY);
      if (saved) {
        const el = $("login-error");
        el.textContent = "密钥无效或已变更，请重新输入";
        el.hidden = false;
      }
    }
  }
}

$("login-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const token = $("token").value.trim();
  if (!token) return;
  localStorage.setItem(TOKEN_KEY, token);
  $("login-error").hidden = true;
  load();
});

$("logout").addEventListener("click", () => {
  localStorage.removeItem(TOKEN_KEY);
  location.reload();
});

$("refresh").addEventListener("click", load);

load();
setInterval(load, 5 * 60 * 1000);
