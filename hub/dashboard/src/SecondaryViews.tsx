import { Fragment, useMemo, useState, type ReactNode } from "react";
import {
  Activity,
  ArrowDownToLine,
  CalendarDays,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock3,
  CreditCard,
  Database,
  Info,
  Laptop,
  Monitor,
  Search,
  Server,
  Wifi,
  X,
} from "lucide-react";
import {
  providerName,
  type DashboardData,
  type Device,
  type Quota,
  type Session,
  type Subscription,
} from "./data";
import "./secondary.css";
import { BrandIcon } from "./BrandIcon";
import { MetricTooltip } from "./MetricTooltip";
import { ActivityPanel } from "./ActivityPanel";

export interface SecondaryProps {
  data: DashboardData;
  onDevice?: (device: Device) => void;
}

const fullNumber = (value: number) =>
  new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(value);
const compactNumber = (value: number) =>
  value >= 1_000_000
    ? `${(value / 1_000_000).toFixed(value >= 100_000_000 ? 0 : 2)}M`
    : value >= 10_000
      ? `${(value / 1_000).toFixed(1)}K`
      : fullNumber(value);
const usd = (value: number | null) =>
  value === null
    ? "未提供"
    : new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(value);
const DAY = 86_400_000;

function dateLabel(
  value: string | null,
  timeZone: string,
  withTime = false,
): string {
  if (!value) return "未提供";
  const parsed = new Date(value.length === 10 ? `${value}T12:00:00Z` : value);
  if (!Number.isFinite(parsed.getTime())) return "未提供";
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: value.length === 10 ? "UTC" : timeZone,
      month: "2-digit",
      day: "2-digit",
      ...(withTime
        ? { hour: "2-digit", minute: "2-digit", hourCycle: "h23" as const }
        : {}),
    }).format(parsed);
  } catch {
    return parsed
      .toISOString()
      .slice(0, withTime ? 16 : 10)
      .replace("T", " ");
  }
}

function detailDateTime(
  value: string | null | undefined,
  timeZone: string,
): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "未提供";
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(new Date(value));
  } catch {
    return value;
  }
}

function dateKey(value: string | null, timeZone: string): string | null {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(parsed);
    return ["year", "month", "day"]
      .map((type) => parts.find((part) => part.type === type)?.value)
      .join("-");
  } catch {
    return parsed.toISOString().slice(0, 10);
  }
}

function relativeTime(value: string | null, reference: string): string {
  if (!value) return "尚无同步时间";
  const seconds =
    (new Date(reference).getTime() - new Date(value).getTime()) / 1000;
  if (!Number.isFinite(seconds)) return "同步时间未知";
  if (seconds < -60) return "时间晚于当前快照";
  if (seconds < 60) return "刚刚同步";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前同步`;
  if (seconds < DAY / 1000) return `${Math.floor(seconds / 3600)} 小时前同步`;
  return `${Math.floor(seconds / (DAY / 1000))} 天前同步`;
}

function EmptyState({
  icon,
  title,
  text,
  children,
}: {
  icon: ReactNode;
  title: string;
  text: string;
  children?: ReactNode;
}) {
  return (
    <div className="sv-empty">
      <div className="sv-empty-icon" aria-hidden="true">
        {icon}
      </div>
      <h3>{title}</h3>
      <p>{text}</p>
      {children}
    </div>
  );
}

function SummaryItem({
  icon,
  label,
  value,
  unit,
  foot,
}: {
  icon: ReactNode;
  label: string;
  value: ReactNode;
  unit?: string;
  foot: string;
}) {
  return (
    <div className="sv-summary-item">
      <div className="sv-summary-label">
        <span aria-hidden="true">{icon}</span>
        {label}
      </div>
      <div className="sv-summary-value">
        {value}
        {unit && <small>{unit}</small>}
      </div>
      <div className="sv-summary-foot">{foot}</div>
    </div>
  );
}

function syncInterval(value?: number | null): string {
  if (!value || value < 0) return "";
  if (value % 3_600_000 === 0) return `每 ${value / 3_600_000} 小时`;
  if (value >= 60_000) return `每 ${fullNumber(value / 60_000)} 分钟`;
  return value >= 1000
    ? `每 ${Math.round(value / 1000)} 秒`
    : `每 ${value} 毫秒`;
}

function DeviceCard({
  device,
  total,
  data,
  onDevice,
}: { device: Device; total: number } & SecondaryProps) {
  const [expanded, setExpanded] = useState(false);
  const Icon = /linux|ubuntu|debian|server/i.test(device.platform)
    ? Server
    : /mac/i.test(device.platform)
      ? Laptop
      : Monitor;
  const status = { online: "在线", delayed: "同步延迟", offline: "离线" }[
    device.status
  ];
  const share =
    total > 0
      ? Math.min(100, (device.periods.today.totalTokens / total) * 100)
      : 0;
  const healthNames = new Set(
    (device.clientHealth || []).map((client) => client.name.toLowerCase()),
  );
  return (
    <article className="sv-card sv-device-card">
      <div className="sv-device-main">
        <div className="sv-device-statusline">
          <span
            className={`sv-status sv-status-${device.status === "delayed" ? "stale" : device.status}`}
          >
            {status}
          </span>
          <MetricTooltip
            title={`${device.name} · 最近同步`}
            rows={[
              {
                label: "上报时间",
                value: detailDateTime(device.lastSeen, data.timeZone),
              },
              { label: "设备状态", value: status },
            ]}
          >
            <span className="sv-inline-detail" role="button" tabIndex={0}>
              <Clock3 size={12} aria-hidden="true" />
              {relativeTime(device.lastSeen, data.generatedAt)}
            </span>
          </MetricTooltip>
        </div>
        <div className="sv-device-heading">
          <div className="sv-device-icon" aria-hidden="true">
            <Icon />
          </div>
          <div>
            <h3>{device.name}</h3>
            <p>
              {[device.platform, device.osVersion].filter(Boolean).join(" ")}
              <MetricTooltip
                title="设备标识"
                rows={[
                  { label: "设备", value: device.name },
                  { label: "完整标识", value: device.id },
                ]}
              >
                <span
                  className="sv-device-id sv-inline-detail"
                  role="button"
                  tabIndex={0}
                >
                  {device.id.length > 12
                    ? `${device.id.slice(0, 8)}…`
                    : device.id}
                </span>
              </MetricTooltip>
            </p>
          </div>
        </div>
        <div className="sv-device-meta">
          <span>
            采集程序 {device.version}
            {device.runtime
              ? ` · ${({ desktop: "桌面程序", widget: "桌面组件", service: "后台服务", daemon: "后台进程", cli: "命令行" } as Record<string, string>)[device.runtime] || device.runtime}`
              : ""}
          </span>
          {syncInterval(device.syncIntervalMs) && (
            <span>同步 {syncInterval(device.syncIntervalMs)}</span>
          )}
          {device.timeZone && <span>{device.timeZone}</span>}
          {device.projectsEnabled !== undefined &&
            device.projectsEnabled !== null && (
              <span>
                项目统计{device.projectsEnabled ? "已开启" : "已关闭"}
              </span>
            )}
          {device.historyAvailable !== undefined &&
            device.historyAvailable !== null && (
              <span>
                {device.historyAvailable ? "包含历史数据" : "暂无历史数据"}
              </span>
            )}
        </div>
        <div className="sv-device-tools" aria-label="客户端与健康状态">
          {(device.clientHealth || []).map((client) => (
            <MetricTooltip
              key={client.name}
              title={`${device.name} · ${client.name}`}
              rows={[
                {
                  label: "客户端版本",
                  value: client.version
                    ? `v${client.version.replace(/^v/, "")}`
                    : "未提供",
                },
                { label: "上报状态", value: client.state },
                {
                  label: "观察时间",
                  value: detailDateTime(client.observedAt, data.timeZone),
                },
                {
                  label: "最近同步",
                  value: detailDateTime(device.lastSeen, data.timeZone),
                },
              ]}
            >
              <span
                className="sv-client-health sv-detail-trigger"
                tabIndex={0}
                role="button"
                aria-label={`查看 ${device.name} ${client.name} 状态详情`}
              >
                <BrandIcon name={client.name} size={22} />
                <span>
                  {client.name}
                  {client.version && (
                    <small>v{client.version.replace(/^v/, "")}</small>
                  )}
                </span>
                <em className={`sv-health-${client.level}`}>
                  {
                    {
                      ok: "健康",
                      warning: "警告",
                      error: "异常",
                      unknown: "未知",
                    }[client.level]
                  }
                </em>
              </span>
            </MetricTooltip>
          ))}
          {device.clients
            .filter((client) => !healthNames.has(client.toLowerCase()))
            .map((client) => (
              <span className="sv-client-health" key={client}>
                <BrandIcon name={client} size={22} />
                {client}
              </span>
            ))}
          {!device.clients.length && !device.clientHealth?.length && (
            <span className="sv-muted">客户端信息未上报</span>
          )}
        </div>
        {(device.clientStatus ||
          (/win/i.test(device.platform) && device.wslStatus)) && (
          <div className="sv-diagnostic-lines">
            {device.clientStatus && <p>{device.clientStatus}</p>}
            {/win/i.test(device.platform) && device.wslStatus && (
              <p>WSL · {device.wslStatus}</p>
            )}
          </div>
        )}
        <div className="sv-device-metrics">
          {(
            [
              ["today", "今日用量"],
              ["month", "本月用量"],
              ["allTime", "累计用量"],
            ] as const
          ).map(([key, label]) => (
            <MetricTooltip
              key={key}
              title={`${device.name} · ${label}`}
              rows={[
                {
                  label: "完整用量",
                  value: `${fullNumber(device.periods[key].totalTokens)} tokens`,
                },
                { label: "估算费用", value: usd(device.periods[key].costUsd) },
                {
                  label: "最近同步",
                  value: detailDateTime(device.lastSeen, data.timeZone),
                },
                { label: "设备时区", value: device.timeZone || "未提供" },
              ]}
            >
              <div
                className="sv-device-stat sv-detail-trigger"
                tabIndex={0}
                role="button"
                aria-label={`查看 ${device.name} ${label}详情`}
              >
                <span className="sv-metric-label">{label}</span>
                <span className="sv-metric-value">
                  {compactNumber(device.periods[key].totalTokens)}
                </span>
              </div>
            </MetricTooltip>
          ))}
          <MetricTooltip
            title={`${device.name} · 估算费用`}
            rows={[
              { label: "今日费用", value: usd(device.periods.today.costUsd) },
              { label: "本月费用", value: usd(device.periods.month.costUsd) },
              { label: "累计费用", value: usd(device.periods.allTime.costUsd) },
            ]}
          >
            <div
              className="sv-device-stat sv-detail-trigger"
              tabIndex={0}
              role="button"
              aria-label={`查看 ${device.name} 估算费用详情`}
            >
              <span className="sv-metric-label">累计估算费用</span>
              <span className="sv-metric-value">
                {usd(device.periods.allTime.costUsd)}
              </span>
            </div>
          </MetricTooltip>
        </div>
      </div>
      <div className="sv-device-footer">
        <p>
          今日费用 <strong>{usd(device.periods.today.costUsd)}</strong>
          <span>·</span>本月{" "}
          <strong>{usd(device.periods.month.costUsd)}</strong>
        </p>
        <button
          type="button"
          className="sv-device-toggle"
          aria-expanded={expanded}
          aria-controls={`device-detail-${device.id}`}
          onClick={() => {
            setExpanded(!expanded);
            if (!expanded) onDevice?.(device);
          }}
        >
          {expanded ? "收起详情" : "设备详情"}
          <ChevronDown aria-hidden="true" />
        </button>
      </div>
      {expanded && (
        <div className="sv-device-detail" id={`device-detail-${device.id}`}>
          <dl className="sv-detail-grid">
            <div>
              <dt>设备标识</dt>
              <dd>{device.id}</dd>
            </div>
            <div>
              <dt>最近同步</dt>
              <dd>{dateLabel(device.lastSeen, data.timeZone, true)}</dd>
            </div>
            <div>
              <dt>今日用量占比</dt>
              <dd>{share.toFixed(1)}%</dd>
            </div>
            <div>
              <dt>本月完整用量</dt>
              <dd>{fullNumber(device.periods.month.totalTokens)} tokens</dd>
            </div>
          </dl>
        </div>
      )}
    </article>
  );
}

export function DevicesView({ data, onDevice }: SecondaryProps) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const total = data.devices.reduce(
    (sum, device) => sum + device.periods.today.totalTokens,
    0,
  );
  const online = data.devices.filter(
    (device) => device.status === "online",
  ).length;
  const filtered = data.devices.filter(
    (device) =>
      (status === "all" || device.status === status) &&
      [device.name, device.platform, ...device.clients].some((value) =>
        value.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
      ),
  );
  return (
    <div className="sv-page sv-dense-page">
      <section className="sv-summary" aria-label="设备概况">
        <SummaryItem
          icon={<Monitor />}
          label="已连接设备"
          value={data.devices.length}
          unit="台"
          foot="按已上报设备统计"
        />
        <SummaryItem
          icon={<Wifi />}
          label="当前在线"
          value={online}
          unit="台"
          foot={`${data.devices.length - online} 台离线或同步延迟`}
        />
        <SummaryItem
          icon={<Activity />}
          label="今日设备用量"
          value={compactNumber(total)}
          foot="来自全部已上报设备"
        />
      </section>
      <div className="sv-toolbar">
        <label className="sv-search">
          <Search aria-hidden="true" />
          <input
            type="search"
            aria-label="搜索设备"
            placeholder="搜索设备、系统或客户端…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div className="sv-toolbar-actions">
          <select
            className="sv-select"
            aria-label="筛选设备状态"
            value={status}
            onChange={(event) => setStatus(event.target.value)}
          >
            <option value="all">所有状态</option>
            <option value="online">在线</option>
            <option value="delayed">同步延迟</option>
            <option value="offline">离线</option>
          </select>
          <span className="sv-result-count" aria-live="polite">
            {filtered.length} 台设备
          </span>
        </div>
      </div>
      {filtered.length > 0 ? (
        <div className="sv-device-grid">
          {filtered.map((device) => (
            <DeviceCard
              key={device.id}
              device={device}
              total={total}
              data={data}
              onDevice={onDevice}
            />
          ))}
        </div>
      ) : (
        <div className="sv-card">
          <EmptyState
            icon={<Monitor />}
            title={data.devices.length ? "没有匹配的设备" : "还没有设备上报"}
            text={
              data.devices.length
                ? "换一个设备名称，或清除状态筛选。"
                : "设备连接后，会在这里显示同步状态和用量。"
            }
          >
            {data.devices.length > 0 && (
              <button
                className="sv-button"
                type="button"
                onClick={() => {
                  setQuery("");
                  setStatus("all");
                }}
              >
                清除筛选
              </button>
            )}
          </EmptyState>
        </div>
      )}
      <div className="sv-note">
        <Info aria-hidden="true" />
        <span>
          在线状态与同步时间以{" "}
          {dateLabel(data.generatedAt, data.timeZone, true)}{" "}
          的数据快照为准。离线设备已上报的用量会继续保留。
        </span>
      </div>
    </div>
  );
}

function quotaPercent(quota: Quota): number | null {
  if (quota.usedPercent !== null)
    return Math.max(0, Math.min(100, quota.usedPercent));
  if (quota.limit !== null && quota.limit > 0 && quota.used !== null)
    return Math.max(0, Math.min(100, (quota.used / quota.limit) * 100));
  return null;
}

function quotaAmount(value: number, quota: Quota): string {
  if (!quota.currency) return fullNumber(value);
  try {
    return new Intl.NumberFormat("zh-CN", {
      style: "currency",
      currency: quota.currency,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return `${quota.currency} ${fullNumber(value)}`;
  }
}

function quotaGroupStatus(group: Quota[]) {
  if (group.some((quota) => quota.stale))
    return { label: "数据已过期", className: "sv-status-warning" };
  const unavailable = group.find((quota) => quota.sourceStatus !== "ok");
  if (unavailable)
    return {
      label:
        unavailable.sourceStatus === "unauthorized"
          ? "授权失效"
          : unavailable.sourceStatus === "error"
            ? "读取失败"
            : "等待同步",
      className: "sv-status-warning",
    };
  if (
    group.every(
      (quota) =>
        quotaPercent(quota) === null &&
        quota.balanceUsd === null &&
        quota.balance == null &&
        quota.remaining === null &&
        quota.used === null,
    )
  )
    return { label: "数据待更新", className: "" };
  if (
    group.some(
      (quota) => (quotaPercent(quota) ?? -1) >= 75 || quota.remaining === 0,
    )
  )
    return { label: "额度留意", className: "sv-status-warning" };
  return {
    label: group.some((quota) => quotaPercent(quota) !== null)
      ? "额度充足"
      : "已同步",
    className: "sv-status-active",
  };
}

function QuotaWindow({ quota, data }: { quota: Quota; data: DashboardData }) {
  const percent = quotaPercent(quota);
  const color =
    percent !== null && percent >= 90
      ? "sv-progress-danger"
      : percent !== null && percent >= 75
        ? "sv-progress-warning"
        : "";
  const expired =
    quota.resetsAt !== null &&
    new Date(quota.resetsAt).getTime() < new Date(data.generatedAt).getTime();
  const isBalance = quota.metric === "balance";
  const percentageHeadline =
    quota.usedPercent !== null ||
    (quota.metric === "percentage" && percent !== null);
  const headline = isBalance
    ? {
        value:
          quota.balanceUsd !== null
            ? usd(quota.balanceUsd)
            : quota.balance != null
              ? fullNumber(quota.balance)
              : "未提供",
        label: "",
      }
    : percentageHeadline && percent !== null
      ? { value: `${fullNumber(percent)}%`, label: "已用" }
      : quota.remaining !== null
        ? { value: quotaAmount(quota.remaining, quota), label: "剩余" }
        : quota.used !== null
          ? { value: quotaAmount(quota.used, quota), label: "已用" }
          : quota.balanceUsd !== null
            ? { value: usd(quota.balanceUsd), label: "余额" }
            : { value: "未提供", label: "" };
  const detailRows: { label: string; value: string }[] = [
    { label: "服务", value: providerName(quota.provider) },
    { label: "账户", value: quota.account || "未提供" },
  ];
  if (percent !== null)
    detailRows.push(
      { label: "已用比例", value: `${fullNumber(percent)}%` },
      { label: "剩余比例", value: `${fullNumber(100 - percent)}%` },
    );
  if (quota.used !== null)
    detailRows.push({
      label: "已用额度",
      value: quotaAmount(quota.used, quota),
    });
  if (quota.remaining !== null)
    detailRows.push({
      label: "剩余额度",
      value: quotaAmount(quota.remaining, quota),
    });
  if (quota.limit !== null)
    detailRows.push({
      label: "额度上限",
      value: quotaAmount(quota.limit, quota),
    });
  if (quota.balanceUsd !== null || quota.balance != null)
    detailRows.push({
      label: "账户余额",
      value:
        quota.balanceUsd !== null
          ? usd(quota.balanceUsd)
          : fullNumber(quota.balance!),
    });
  if (
    percent === null &&
    quota.used === null &&
    quota.remaining === null &&
    !isBalance
  )
    detailRows.push({ label: "使用情况", value: "未提供" });
  detailRows.push(
    { label: "重置时间", value: detailDateTime(quota.resetsAt, data.timeZone) },
    { label: "来源设备", value: quota.sourceDevice || "未提供" },
    {
      label: "同步状态",
      value: quota.stale
        ? "数据已过期"
        : (
            {
              ok: "已同步",
              unauthorized: "授权失效",
              error: "读取失败",
              unknown: "状态未知",
            } as Record<string, string>
          )[quota.sourceStatus || "unknown"] ||
          quota.sourceStatus ||
          "状态未知",
    },
    {
      label: "数据时间",
      value: detailDateTime(data.generatedAt, data.timeZone),
    },
  );
  const detailNote = [
    percent !== null && quota.usedPercent === null
      ? "百分比按已用额度与上限计算。"
      : "",
    expired ? "重置时间已过，等待来源更新。" : "",
    `时间按 ${data.timeZone} 显示。`,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <MetricTooltip
      title={`${quota.plan || quota.name} · ${quota.label}`}
      rows={detailRows}
      note={detailNote}
    >
      <div
        className="sv-quota-window sv-detail-trigger"
        tabIndex={0}
        role="button"
        aria-label={`查看 ${quota.plan || quota.name} ${quota.label} 额度详情`}
      >
        <div className="sv-progress-label">
          <span>{quota.label}</span>
          <strong>
            {headline.value}
            {headline.label && <small>{headline.label}</small>}
          </strong>
        </div>
        {!isBalance && quota.showMeter !== false && percent !== null && (
          <div
            className={`sv-progress ${color} ${percent === null ? "sv-progress-unknown" : ""}`}
            {...(percent === null
              ? { role: "img", "aria-label": `${quota.label}：未提供使用进度` }
              : {
                  role: "progressbar",
                  "aria-label": `${quota.label}已用额度`,
                  "aria-valuenow": percent,
                  "aria-valuemin": 0,
                  "aria-valuemax": 100,
                })}
          >
            {percent !== null && <span style={{ width: `${percent}%` }} />}
          </div>
        )}
        <div className="sv-quota-window-foot">
          <span>
            {isBalance
              ? "账户余额"
              : quota.limit !== null && !percentageHeadline
                ? `上限 ${quotaAmount(quota.limit, quota)}`
                : percentageHeadline && percent !== null
                  ? `剩余 ${fullNumber(100 - percent)}%`
                  : quota.used !== null
                    ? "已上报使用金额"
                    : quota.remaining !== null
                      ? "已上报剩余额度"
                      : "用量未提供"}
            {quota.used !== null && !isBalance && percentageHeadline && (
              <> · 已用 {quotaAmount(quota.used, quota)}</>
            )}
          </span>
          <span>
            {quota.resetsAt
              ? `${expired ? "重置时间已过，等待同步" : "重置于"} ${dateLabel(quota.resetsAt, data.timeZone, true)}`
              : "重置时间未提供"}
          </span>
        </div>
      </div>
    </MetricTooltip>
  );
}

function subscriptionInterval(subscription: Subscription) {
  if (subscription.kind === "topup") return "一次性";
  const label =
    (
      {
        day: "天",
        daily: "天",
        week: "周",
        weekly: "周",
        month: "月",
        monthly: "月",
        year: "年",
        yearly: "年",
        annual: "年",
      } as Record<string, string>
    )[subscription.interval] ||
    subscription.interval ||
    "周期";
  return subscription.intervalCount > 1
    ? `${subscription.intervalCount} ${label}`
    : label;
}

function money(amount: number | null, currency: string): string {
  if (amount === null) return "未提供";
  try {
    return new Intl.NumberFormat("zh-CN", {
      style: "currency",
      currency: currency || "USD",
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${currency} ${fullNumber(amount)}`;
  }
}

function fullDate(value?: string | null): string {
  return value &&
    /^\d{4}-\d{2}-\d{2}/.test(value) &&
    Number.isFinite(Date.parse(value))
    ? value.slice(0, 10)
    : "未提供";
}

function SubscriptionRow({ subscription }: { subscription: Subscription }) {
  const isTopUp = subscription.kind === "topup";
  const records = subscription.topUps || [];
  return (
    <article className="sv-card sv-subscription">
      <div className="sv-subscription-top">
        <span className="sv-subscription-provider">
          <BrandIcon
            name={subscription.provider || subscription.name}
            size={25}
          />
          {providerName(subscription.provider)}
        </span>
        <span
          className={`sv-status ${!isTopUp && subscription.autoRenew ? "sv-status-active" : ""}`}
        >
          {isTopUp
            ? "充值台账"
            : subscription.autoRenew
              ? "自动续订"
              : "手动续订"}
        </span>
      </div>
      <h3 className="sv-subscription-plan">{subscription.name}</h3>
      <div className="sv-subscription-price">
        {isTopUp && <span className="sv-metric-label">累计充值</span>}
        <strong>
          {money(
            isTopUp ? subscription.topUpTotal : subscription.amount,
            subscription.currency,
          )}
        </strong>
        {!isTopUp && <small> / {subscriptionInterval(subscription)}</small>}
      </div>
      <dl className="sv-subscription-dates">
        <div>
          <dt>{isTopUp ? "充值次数" : "开始日期"}</dt>
          <dd>
            {isTopUp
              ? subscription.topUps == null
                ? "未提供"
                : `${records.length} 次`
              : fullDate(subscription.startDate)}
          </dd>
        </div>
        <div>
          <dt>{isTopUp ? "最近充值" : "下次续订"}</dt>
          <dd>
            {fullDate(
              isTopUp ? subscription.latestTopUpAt : subscription.renewsAt,
            )}
          </dd>
        </div>
        {subscription.endDate && (
          <div>
            <dt>结束日期</dt>
            <dd>{fullDate(subscription.endDate)}</dd>
          </div>
        )}
      </dl>
      {subscription.binding && (
        <p className="sv-binding">
          <MetricTooltip
            title={`${subscription.name} · 绑定账户`}
            rows={[
              { label: "服务", value: providerName(subscription.provider) },
              { label: "绑定账户", value: subscription.binding },
            ]}
          >
            <span className="sv-inline-detail" role="button" tabIndex={0}>
              绑定 {subscription.binding}
            </span>
          </MetricTooltip>
        </p>
      )}
      {!!records.length && (
        <div className="sv-subscription-records">
          <span className="sv-records-label">
            {isTopUp ? "充值记录" : "加购记录"} · {records.length} 笔
          </span>
          <ul>
            {records.map((top, index) => (
              <li key={`${top.id}-${index}`}>
                <span>
                  {top.label}
                  <time>{fullDate(top.date)}</time>
                </span>
                <strong>{money(top.amount, subscription.currency)}</strong>
              </li>
            ))}
          </ul>
        </div>
      )}
      {subscription.note && (
        <p className="sv-subscription-note">备注 · {subscription.note}</p>
      )}
    </article>
  );
}

export function QuotaView({ data }: SecondaryProps) {
  const groups = useMemo(() => {
    const result = new Map<string, Quota[]>();
    for (const quota of data.quotas) {
      const key =
        quota.groupId ||
        `${quota.provider}\u0000${quota.name}\u0000${quota.plan}\u0000${quota.account}`;
      result.set(key, [...(result.get(key) || []), quota]);
    }
    return [...result.values()];
  }, [data.quotas]);
  const warnings = data.quotas.filter(
    (quota) => (quotaPercent(quota) ?? -1) >= 75,
  ).length;
  return (
    <div className="sv-page sv-dense-page">
      <section className="sv-summary" aria-label="配额与订阅概况">
        <SummaryItem
          icon={<Database />}
          label="已连接服务"
          value={new Set(data.quotas.map((quota) => quota.provider)).size}
          unit="个"
          foot={`${data.quotas.length} 个已上报额度窗口`}
        />
        <SummaryItem
          icon={<Activity />}
          label="接近额度上限"
          value={warnings}
          unit="个"
          foot="已使用至少 75% 的窗口"
        />
        <SummaryItem
          icon={<CreditCard />}
          label="订阅与充值"
          value={data.subscriptions.length}
          unit="项"
          foot="按已录入账单统计"
        />
      </section>
      <section aria-label="使用额度">
        {groups.length ? (
          <div className="sv-quota-grid">
            {groups.map((group) => {
              const first = group[0];
              const status = quotaGroupStatus(group);
              return (
                <article
                  className="sv-card sv-card-padding sv-quota-card"
                  key={first.id}
                >
                  <div className="sv-quota-identity">
                    <div className="sv-quota-topline">
                      <div className="sv-provider-heading">
                        <div className="sv-provider-icon">
                          <BrandIcon
                            name={first.provider || first.name}
                            size={34}
                          />
                        </div>
                        <div>
                          <h3>{first.plan || first.name}</h3>
                          <p>{providerName(first.provider)}</p>
                        </div>
                      </div>
                      {(first.balanceUsd !== null || first.balance != null) &&
                        !group.some((quota) => quota.metric === "balance") && (
                          <div className="sv-quota-balance">
                            <span>账户余额</span>
                            <strong>
                              {first.balanceUsd !== null
                                ? usd(first.balanceUsd)
                                : fullNumber(first.balance!)}
                            </strong>
                          </div>
                        )}
                    </div>
                    {first.account && (
                      <p className="sv-binding">
                        <MetricTooltip
                          title={`${first.plan || first.name} · 账户`}
                          rows={[
                            { label: "账户", value: first.account },
                            {
                              label: "服务",
                              value: providerName(first.provider),
                            },
                          ]}
                        >
                          <span
                            className="sv-inline-detail"
                            role="button"
                            tabIndex={0}
                          >
                            {first.account}
                          </span>
                        </MetricTooltip>
                      </p>
                    )}
                    <div className="sv-quota-source">
                      <span className={`sv-status ${status.className}`}>
                        {status.label}
                      </span>
                      {first.sourceDevice && (
                        <MetricTooltip
                          title="配额来源"
                          rows={[
                            { label: "来源设备", value: first.sourceDevice },
                            {
                              label: "服务",
                              value: providerName(first.provider),
                            },
                            { label: "套餐", value: first.plan || "未提供" },
                          ]}
                        >
                          <span
                            className="sv-inline-detail"
                            role="button"
                            tabIndex={0}
                          >
                            <Monitor size={12} aria-hidden="true" />
                            {first.sourceDevice}
                          </span>
                        </MetricTooltip>
                      )}
                    </div>
                  </div>
                  <div className="sv-quota-windows">
                    {group.map((quota) => (
                      <QuotaWindow key={quota.id} quota={quota} data={data} />
                    ))}
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="sv-card">
            <EmptyState
              icon={<Database />}
              title="还没有配额数据"
              text="连接支持配额上报的服务后，将显示可用额度和重置时间。"
            />
          </div>
        )}
      </section>
      <section
        className="sv-subscriptions-section"
        aria-labelledby="sv-subscription-title"
      >
        <div className="sv-section-head">
          <div>
            <h2 id="sv-subscription-title">订阅与账单</h2>
            <p className="sv-muted">
              套餐、绑定账户与账单记录。
              {data.subscriptionsUpdatedAt &&
                ` 更新于 ${fullDate(data.subscriptionsUpdatedAt)}`}
            </p>
          </div>
          <span className="sv-result-count">
            {data.subscriptions.length} 项
          </span>
        </div>
        {data.subscriptions.length ? (
          <div className="sv-subscription-grid">
            {data.subscriptions.map((subscription) => (
              <SubscriptionRow
                key={subscription.id}
                subscription={subscription}
              />
            ))}
          </div>
        ) : (
          <EmptyState
            icon={<CreditCard />}
            title="尚未记录订阅"
            text="已有的订阅记录会显示在这里；缺失的价格不会按零元计算。"
          />
        )}
      </section>
      <div className="sv-note">
        <Info aria-hidden="true" />
        <span>
          不同服务独立计算额度，不能互相抵扣。订阅记录与实际用量费用分别展示；未上报的余额或重置时间会保留为未知。
        </span>
      </div>
    </div>
  );
}

/** Quote every cell and neutralize formula prefixes before spreadsheet export. */
export function sessionsToCsv(sessions: Session[]): string {
  const cell = (value: string | number | null) => {
    const raw = value === null ? "" : String(value);
    const safe = /^(?:\s*[=+\-@]|[\t\r\n])/.test(raw) ? `'${raw}` : raw;
    return `"${safe.replace(/"/g, '""')}"`;
  };
  const rows: (string | number | null)[][] = [
    [
      "会话",
      "项目",
      "客户端",
      "设备",
      "模型",
      "Token 用量",
      "估算费用 USD",
      "开始时间",
      "最后活动时间",
    ],
    ...sessions.map((session) => [
      session.name,
      session.project,
      session.client,
      session.device,
      session.models.join(" / "),
      session.totalTokens,
      session.costUsd,
      session.startedAt,
      session.lastUsedAt,
    ]),
  ];
  return "\uFEFF" + rows.map((row) => row.map(cell).join(",")).join("\r\n");
}

export function HistoryView({ data }: SecondaryProps) {
  const [query, setQuery] = useState("");
  const [client, setClient] = useState("all");
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [exported, setExported] = useState(false);
  const clients = [
    ...new Set(data.sessions.map((session) => session.client)),
  ].sort();
  const pageSize = 8;
  const filtered = useMemo(
    () =>
      data.sessions
        .filter(
          (session) =>
            (client === "all" || session.client === client) &&
            (!selectedDay ||
              dateKey(
                session.lastUsedAt || session.startedAt,
                data.timeZone,
              ) === selectedDay) &&
            [
              session.name,
              session.project,
              session.client,
              session.device,
              ...session.models,
            ].some((value) =>
              value
                .toLocaleLowerCase()
                .includes(query.trim().toLocaleLowerCase()),
            ),
        )
        .sort(
          (a, b) =>
            (Date.parse(b.lastUsedAt || b.startedAt || "") || 0) -
            (Date.parse(a.lastUsedAt || a.startedAt || "") || 0),
        ),
    [data.sessions, data.timeZone, client, selectedDay, query],
  );
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const activePage = Math.min(page, pages);
  const displayed = filtered.slice(
    (activePage - 1) * pageSize,
    activePage * pageSize,
  );
  const activeDays = data.activity.filter((day) => day.totalTokens > 0).length;
  const activityTotal = data.activity.reduce(
    (sum, day) => sum + day.totalTokens,
    0,
  );
  function exportCsv() {
    const url = URL.createObjectURL(
      new Blob([sessionsToCsv(filtered)], { type: "text/csv;charset=utf-8;" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `cloud-monitor-sessions-${selectedDay || dateKey(data.generatedAt, data.timeZone) || "export"}.csv`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setExported(true);
  }
  function changeDay(day: string | null) {
    setSelectedDay(day);
    setPage(1);
    setExported(false);
  }
  function clearFilters() {
    setQuery("");
    setClient("all");
    setSelectedDay(null);
    setPage(1);
    setExported(false);
  }
  return (
    <div className="sv-page sv-history-page">
      <section className="sv-summary" aria-label="历史活动概况">
        <SummaryItem
          icon={<CalendarDays />}
          label="有活动的日期"
          value={activeDays}
          unit="天"
          foot={`在 ${data.activity.length} 个已上报日期中`}
        />
        <SummaryItem
          icon={<Activity />}
          label="历史上报用量"
          value={compactNumber(activityTotal)}
          foot="按活动记录汇总"
        />
        <SummaryItem
          icon={<Database />}
          label="已上报会话"
          value={data.sessions.length}
          unit="次"
          foot="仅统计当前快照内的记录"
        />
      </section>
      <div className="sv-history-layout">
        <ActivityPanel
          data={data}
          selected={selectedDay}
          onSelect={changeDay}
        />
        <section
          className="sv-card sv-history-sessions"
          aria-labelledby="sv-sessions-title"
        >
          <div className="sv-section-head">
            <div>
              <h2 id="sv-sessions-title">会话记录</h2>
              <p className="sv-muted">
                按最后活动时间排列，展开查看来源与模型。
              </p>
            </div>
            <div className="sv-session-actions">
              <span
                className={exported ? "sv-download-note" : "sv-result-count"}
                aria-live="polite"
              >
                {exported
                  ? `已导出 ${filtered.length} 条记录`
                  : `${filtered.length} 条记录`}
              </span>
              <button
                type="button"
                className="sv-button"
                onClick={exportCsv}
                disabled={!filtered.length}
              >
                <ArrowDownToLine aria-hidden="true" />
                导出会话
              </button>
            </div>
          </div>
          <div className="sv-toolbar sv-history-filters">
            <label className="sv-search">
              <Search aria-hidden="true" />
              <input
                type="search"
                aria-label="搜索会话"
                placeholder="搜索会话、项目或模型…"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setPage(1);
                  setExported(false);
                }}
              />
            </label>
            <div className="sv-toolbar-actions">
              {selectedDay && (
                <span className="sv-date-filter">
                  <CalendarDays size={12} aria-hidden="true" />
                  {selectedDay}
                  <button
                    type="button"
                    aria-label="清除日期筛选"
                    onClick={() => changeDay(null)}
                  >
                    <X aria-hidden="true" />
                  </button>
                </span>
              )}
              <select
                className="sv-select"
                aria-label="筛选会话客户端"
                value={client}
                onChange={(event) => {
                  setClient(event.target.value);
                  setPage(1);
                  setExported(false);
                }}
              >
                <option value="all">所有客户端</option>
                {clients.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {displayed.length ? (
            <div className="sv-table-wrap">
              <table className="sv-session-table">
                <thead>
                  <tr>
                    <th scope="col">会话</th>
                    <th scope="col">客户端</th>
                    <th scope="col">最后活动</th>
                    <th scope="col" className="sv-number">
                      用量
                    </th>
                    <th scope="col" className="sv-number">
                      估算费用
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {displayed.map((session) => (
                    <Fragment key={session.id}>
                      <tr>
                        <td data-label="会话">
                          <button
                            className="sv-session-toggle"
                            type="button"
                            aria-expanded={expanded === session.id}
                            aria-controls={`session-detail-${session.id}`}
                            onClick={() =>
                              setExpanded(
                                expanded === session.id ? null : session.id,
                              )
                            }
                          >
                            <strong>
                              {session.name || "未命名会话"}
                              <ChevronRight aria-hidden="true" />
                            </strong>
                            <small>{session.project || "项目未提供"}</small>
                          </button>
                        </td>
                        <td data-label="客户端">
                          <span className="sv-session-source">
                            <BrandIcon name={session.client} size={26} />
                            {session.client || "未提供"}
                          </span>
                        </td>
                        <td data-label="最后活动">
                          {dateLabel(session.lastUsedAt, data.timeZone, true)}
                        </td>
                        <td data-label="用量" className="sv-number">
                          <MetricTooltip
                            title={`${session.name || "未命名会话"} · 用量`}
                            rows={[
                              {
                                label: "完整词元用量",
                                value: fullNumber(session.totalTokens),
                              },
                              {
                                label: "估算费用",
                                value: usd(session.costUsd),
                              },
                              {
                                label: "客户端",
                                value: session.client || "未提供",
                              },
                              {
                                label: "来源设备",
                                value: session.device || "未提供",
                              },
                            ]}
                          >
                            <span
                              className="sv-inline-detail"
                              role="button"
                              tabIndex={0}
                            >
                              {compactNumber(session.totalTokens)}
                            </span>
                          </MetricTooltip>
                        </td>
                        <td data-label="估算费用" className="sv-number">
                          {usd(session.costUsd)}
                        </td>
                      </tr>
                      {expanded === session.id && (
                        <tr
                          className="sv-session-detail"
                          id={`session-detail-${session.id}`}
                        >
                          <td colSpan={5}>
                            <dl className="sv-detail-grid">
                              <div>
                                <dt>使用模型</dt>
                                <dd>
                                  {session.models.length ? (
                                    <span className="sv-model-list">
                                      {session.models.map((model) => (
                                        <span
                                          className="sv-model-name"
                                          key={model}
                                        >
                                          <BrandIcon name={model} size={22} />
                                          <span>{model}</span>
                                        </span>
                                      ))}
                                    </span>
                                  ) : (
                                    "未提供"
                                  )}
                                </dd>
                              </div>
                              <div>
                                <dt>来源设备</dt>
                                <dd>{session.device || "未提供"}</dd>
                              </div>
                              <div>
                                <dt>开始时间</dt>
                                <dd>
                                  {dateLabel(
                                    session.startedAt,
                                    data.timeZone,
                                    true,
                                  )}
                                </dd>
                              </div>
                              <div>
                                <dt>完整用量</dt>
                                <dd>
                                  {fullNumber(session.totalTokens)} tokens
                                </dd>
                              </div>
                            </dl>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState
              icon={<Search />}
              title={data.sessions.length ? "没有匹配的会话" : "还没有会话记录"}
              text={
                selectedDay
                  ? `${selectedDay} 没有匹配的已上报会话。活动用量可能来自未包含在当前快照中的会话。`
                  : data.sessions.length
                    ? "调整搜索词或客户端筛选后，再查看会话。"
                    : "设备上报会话记录后，会在这里显示；不会根据总用量生成会话。"
              }
            >
              {data.sessions.length > 0 && (
                <button
                  className="sv-button"
                  type="button"
                  onClick={clearFilters}
                >
                  清除筛选
                </button>
              )}
            </EmptyState>
          )}
          <div className="sv-table-footer">
            <span>
              {filtered.length
                ? `${(activePage - 1) * pageSize + 1}–${Math.min(activePage * pageSize, filtered.length)} / ${filtered.length} 条记录`
                : "0 条记录"}{" "}
              · {data.timeZone}
            </span>
            <div className="sv-pagination">
              <button
                type="button"
                className="sv-button"
                aria-label="上一页会话"
                disabled={activePage === 1}
                onClick={() => setPage(activePage - 1)}
              >
                <ChevronLeft aria-hidden="true" />
              </button>
              <span>
                {activePage} / {pages}
              </span>
              <button
                type="button"
                className="sv-button"
                aria-label="下一页会话"
                disabled={activePage >= pages}
                onClick={() => setPage(activePage + 1)}
              >
                <ChevronRight aria-hidden="true" />
              </button>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
