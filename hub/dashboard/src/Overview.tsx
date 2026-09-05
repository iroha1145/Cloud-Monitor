import { useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowUpRight,
  ArrowRight,
  CircleHelp,
  Cpu,
  Database,
  Layers3,
  Monitor,
  Search,
  Sparkles,
  Wallet,
  Zap,
} from "lucide-react";
import { BrandIcon } from "./BrandIcon";
export { BrandIcon } from "./BrandIcon";
import { NumberTicker } from "./components/motion/number-ticker";
import { InsightTrend } from "./InsightTrend";
import { MetricTooltip, type MetricDetailRow } from "./MetricTooltip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select";
import {
  providerName,
  type DashboardData,
  type PeriodKey,
  type PeriodUsage,
  type UsageEntity,
} from "./data";

export const compact = (n: number) =>
  n >= 1e8
    ? `${(n / 1e8).toFixed(2)} 亿`
    : n >= 1e4
      ? `${(n / 1e4).toFixed(1)} 万`
      : n.toLocaleString("en-US");
export const money = (n: number | null) =>
  n === null
    ? "—"
    : `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const pct = (n: number | null) =>
  n === null ? "—" : `${(n * 100).toFixed(1)}%`;
export const count = (n: number) => n.toLocaleString("en-US");
export const composition = [
  { key: "cacheRead", label: "缓存读取", color: "#25a878" },
  { key: "input", label: "非缓存输入", color: "#3d9aff" },
  { key: "output", label: "输出", color: "#f09a2f" },
  { key: "cacheWrite", label: "缓存写入", color: "#b393c5" },
  { key: "unclassified", label: "未分类", color: "#b4becf" },
] as const;

function usageDetails(
  item: Pick<PeriodUsage, "totalTokens" | "costUsd" | "components">,
): MetricDetailRow[] {
  const parts = item.components;
  return [
    { label: "总用量", value: count(item.totalTokens) },
    {
      label: "费用",
      value: item.costUsd === null ? "来源未提供" : money(item.costUsd),
    },
    {
      label: parts.partial ? "已识别缓存占比" : "缓存占比",
      value: pct(parts.cacheRate),
    },
    ...composition.map((part) => ({
      label: part.label,
      color: part.color,
      value:
        (!parts.known && part.key !== "unclassified") ||
        (part.key === "cacheRead" && !parts.cacheReadKnown) ||
        (part.key === "cacheWrite" && !parts.cacheWriteKnown)
          ? "来源未提供"
          : count(parts[part.key]),
    })),
  ];
}

function usageNote(item: Pick<PeriodUsage, "components">) {
  return !item.components.complete && item.components.known
    ? "组成与总量不一致，暂不计算比例。"
    : item.components.partial
      ? "仅展示来源已上报的组成，未识别部分单独保留。"
      : undefined;
}

function Sparkline({
  values,
  color = "#608ac5",
}: {
  values: number[];
  color?: string;
}) {
  const max = Math.max(...values, 1),
    min = Math.min(...values, 0);
  const pts = values
    .map(
      (v, i) =>
        `${(i / Math.max(1, values.length - 1)) * 105},${33 - ((v - min) / Math.max(1, max - min)) * 28}`,
    )
    .join(" ");
  return (
    <svg className="stat-spark" viewBox="0 0 106 36" aria-hidden="true">
      <polyline
        points={pts}
        fill="none"
        stroke={color}
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Stats({
  data,
  period,
}: {
  data: DashboardData;
  period: PeriodKey;
}) {
  const per = data.periods[period],
    rate = per.components.cacheRate;
  const suffix =
    per.totalTokens >= 1e8 ? " 亿" : per.totalTokens >= 1e4 ? " 万" : "";
  const divisor =
    per.totalTokens >= 1e8 ? 1e8 : per.totalTokens >= 1e4 ? 1e4 : 1;
  const online = data.devices.filter((d) => d.status === "online").length;
  return (
    <section className="stats-row" aria-label="用量摘要">
      <article className="stat">
        <div className="stat-label">
          <Zap size={15} />
          总用量<span className="metric-unit">词元（Tokens）</span>
        </div>
        <div className="stat-value">
          <NumberTicker
            value={Math.round((per.totalTokens / divisor) * 100)}
            format={(n) =>
              (n / 100).toLocaleString("en-US", {
                maximumFractionDigits: divisor === 1e4 ? 1 : 2,
                useGrouping: false,
              })
            }
            suffix={suffix}
            duration={0.45}
            stagger={0.015}
            startOnView={false}
          />
        </div>
        <div className="stat-foot">
          <span>所有模型与客户端</span>
          <Sparkline values={data.trend.slice(-14).map((t) => t.totalTokens)} />
        </div>
      </article>
      <article className="stat">
        <div className="stat-label">
          <Wallet size={15} />
          使用费用<span className="metric-unit">美元</span>
        </div>
        <div className="stat-value">
          {per.costUsd === null ? (
            "—"
          ) : (
            <NumberTicker
              value={Math.round(per.costUsd * 100)}
              prefix="$"
              format={(n) =>
                (n / 100).toLocaleString("en-US", {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })
              }
              duration={0.45}
              stagger={0.015}
              startOnView={false}
            />
          )}
        </div>
        <div className="stat-foot">
          <span>按上报价格统计</span>
          {data.trend.slice(-14).every((t) => t.costUsd !== null) && (
            <Sparkline
              values={data.trend.slice(-14).map((t) => t.costUsd!)}
              color="#32a397"
            />
          )}
        </div>
      </article>
      <article className="stat">
        <div className="stat-label">
          <Database size={15} />
          {per.components.partial ? "已识别缓存占比" : "缓存占比"}
          <MetricTooltip
            title="缓存占比说明"
            rows={[
              { label: "计算方式", value: "缓存读取量 ÷ 总用量" },
              { label: "未知组成", value: "单独保留，不推算缓存" },
            ]}
          >
            <button className="help-icon" aria-label="缓存占比说明">
              <CircleHelp size={14} />
            </button>
          </MetricTooltip>
        </div>
        <div className="stat-value">
          {rate === null ? (
            "—"
          ) : (
            <NumberTicker
              value={Math.round(rate * 1000)}
              format={(n) => (n / 10).toFixed(1)}
              suffix="%"
              duration={0.45}
              startOnView={false}
            />
          )}
        </div>
        <div className="stat-foot">
          <span className="stat-highlight">
            {per.components.cacheReadKnown
              ? `${compact(per.components.cacheRead)} 缓存读取`
              : "等待来源提供缓存数据"}
          </span>
        </div>
      </article>
      <article className="stat">
        <div className="stat-label">
          <Monitor size={15} />
          在线设备
        </div>
        <div className="stat-value">
          <NumberTicker value={online} duration={0.4} startOnView={false} />
          <span className="stat-denominator">/ {data.devices.length}</span>
        </div>
        <div className="stat-foot">
          <span>
            <i className={online ? "status-dot" : "status-dot muted"} />
            {online ? "设备正在同步" : "暂无在线设备"}
          </span>
          <span className="mini-tag">跨设备汇总</span>
        </div>
      </article>
    </section>
  );
}

export function CompositionCard({
  per,
  small = false,
}: {
  per: PeriodUsage;
  small?: boolean;
}) {
  const values = composition.map((s) => ({
    ...s,
    value: per.components[s.key],
  }));
  const sum = values.reduce((a, s) => a + s.value, 0) || 1;
  let offset = 0;
  return (
    <section className={`panel composition-panel ${small ? "small" : ""}`}>
      <div className="panel-head">
        <div>
          <h2>用量组成</h2>
          <p>缓存，让每次调用更轻盈</p>
        </div>
        <span className="soft-icon">
          <Layers3 size={18} />
        </span>
      </div>
      <div className="composition-hero">
        <div>
          <span className="eyebrow">
            {per.components.partial ? "已识别缓存占比" : "缓存占比"}
          </span>
          <strong>{pct(per.components.cacheRate)}</strong>
          <span className="composition-hint">
            {per.components.cacheReadKnown
              ? `${compact(per.components.cacheRead)} 缓存读取`
              : "该来源未上报缓存组成"}
          </span>
        </div>
        <svg
          viewBox="0 0 110 110"
          className="composition-ring"
          role="img"
          aria-label="用量组成环形图"
        >
          <circle
            cx="55"
            cy="55"
            r="43"
            stroke="var(--border)"
            strokeWidth="10"
            fill="none"
          />
          {values
            .filter((v) => v.value > 0)
            .map((v) => {
              const len = (v.value / sum) * 270.18,
                start = offset;
              offset += len;
              return (
                <circle
                  key={v.key}
                  cx="55"
                  cy="55"
                  r="43"
                  fill="none"
                  stroke={v.color}
                  strokeWidth="10"
                  strokeDasharray={`${Math.max(0, len - 2.8)} ${270.18}`}
                  strokeDashoffset={-start}
                  transform="rotate(-90 55 55)"
                />
              );
            })}
          <path d="m59 38-14 20h10l-4 15 16-22H57z" fill="var(--primary)" />
        </svg>
      </div>
      <div className="composition-legend">
        {values.map((v) => (
          <div key={v.key}>
            <span>
              <i className="legend-dot" style={{ background: v.color }} />
              {v.label}
            </span>
            <strong>
              {(!per.components.known && v.key !== "unclassified") ||
              (v.key === "cacheRead" && !per.components.cacheReadKnown) ||
              (v.key === "cacheWrite" && !per.components.cacheWriteKnown)
                ? "—"
                : compact(v.value)}
            </strong>
            <span>
              {(!per.components.known && v.key !== "unclassified") ||
              (v.key === "cacheRead" && !per.components.cacheReadKnown) ||
              (v.key === "cacheWrite" && !per.components.cacheWriteKnown)
                ? "—"
                : per.components.known && !per.components.complete
                  ? "—"
                  : pct(v.value / sum)}
            </span>
          </div>
        ))}
      </div>
      <p className="composition-note">
        <CircleHelp size={13} />
        {!per.components.complete && per.components.known
          ? "组成与总量不一致，暂不计算缓存占比。"
          : per.components.partial
            ? "保留已知缓存，未识别用量单独列出。"
            : "所有已上报用量均已完成分类。"}
      </p>
    </section>
  );
}

export function ModelTable({
  per,
  onSelect,
  full = false,
}: {
  per: PeriodUsage;
  onSelect: (item: UsageEntity) => void;
  full?: boolean;
}) {
  const [query, setQuery] = useState(""),
    [provider, setProvider] = useState("all"),
    [sort, setSort] = useState("totalTokens");
  const models = useMemo(
    () =>
      per.models
        .filter(
          (m) =>
            m.name.toLowerCase().includes(query.toLowerCase()) &&
            (provider === "all" || m.provider === provider),
        )
        .sort((a, b) =>
          sort === "cache"
            ? (b.components.cacheRate ?? -1) - (a.components.cacheRate ?? -1)
            : sort === "cost"
              ? (b.costUsd ?? -Infinity) - (a.costUsd ?? -Infinity)
              : b.totalTokens - a.totalTokens,
        ),
    [per, query, provider, sort],
  );
  return (
    <section className={`panel models-panel ${full ? "full-models" : ""}`}>
      <div className="panel-head">
        <div>
          <h2>
            模型用量 <span className="count-badge">{per.models.length}</span>
          </h2>
          <p>用量、缓存与费用，在同一处比较</p>
        </div>
        {!full && (
          <a href="#models" className="text-link">
            查看全部 <ArrowUpRight size={15} />
          </a>
        )}
      </div>
      {full && (
        <div className="model-filters">
          <label className="search-field">
            <Search size={16} />
            <input
              aria-label="搜索模型"
              placeholder="搜索模型名称…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <Select value={provider} onValueChange={setProvider}>
            <SelectTrigger aria-label="筛选提供商">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">所有提供商</SelectItem>
              {[...new Set(per.models.map((m) => m.provider))].map((p) => (
                <SelectItem key={p} value={p}>
                  {providerName(p)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={sort} onValueChange={setSort}>
            <SelectTrigger aria-label="排序模型">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="totalTokens">按总用量排序</SelectItem>
              <SelectItem value="cache">按缓存占比排序</SelectItem>
              <SelectItem value="cost">按费用排序</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}
      <div className="cache-bar-legend" aria-label="用量组成颜色说明">
        {composition.map((part) => (
          <span key={part.key}>
            <i style={{ background: part.color }} />
            {part.label}
          </span>
        ))}
      </div>
      <div className="model-table-scroll">
        <table className="model-table">
          <thead>
            <tr>
              <th>模型</th>
              <th>
                总用量 <ArrowDown size={11} />
              </th>
              <th>缓存读取</th>
              <th>缓存占比</th>
              <th>费用</th>
              <th>
                <span className="sr-only">详情</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {(full ? models : models.slice(0, 5)).map((m) => (
              <tr key={m.id}>
                <td className="model-identity-cell">
                  <button
                    className="model-open"
                    onClick={() => onSelect(m)}
                    aria-label={`查看 ${m.name} 详情`}
                  >
                    <BrandIcon name={m.name} color={m.color} />
                    <span>
                      <strong>{m.name}</strong>
                      <small>{providerName(m.provider)}</small>
                    </span>
                  </button>
                </td>
                <td data-label="总用量" className="model-total-cell">
                  <MetricTooltip
                    title={`${m.name} · 总用量`}
                    rows={[{ label: "完整用量", value: count(m.totalTokens) }]}
                  >
                    <span role="img">{compact(m.totalTokens)}</span>
                  </MetricTooltip>
                </td>
                <td data-label="缓存读取" className="model-read-cell">
                  <MetricTooltip
                    title={`${m.name} · 缓存读取`}
                    rows={[
                      {
                        label: "完整用量",
                        value: m.components.cacheReadKnown
                          ? count(m.components.cacheRead)
                          : "来源未提供",
                      },
                    ]}
                  >
                    <span role="img">
                      {m.components.cacheReadKnown ? (
                        compact(m.components.cacheRead)
                      ) : (
                        <span className="unknown">未提供</span>
                      )}
                    </span>
                  </MetricTooltip>
                </td>
                <td data-label="缓存占比" className="model-cache-cell">
                  <div className="cache-rate">
                    <MetricTooltip
                      title={`${m.name} · 用量明细`}
                      rows={usageDetails(m)}
                      note={usageNote(m)}
                      strictTouchBounds
                    >
                      <span
                        className="metric-bar-trigger"
                        role="img"
                        aria-label={
                          m.components.complete
                            ? composition
                                .map(
                                  (part) =>
                                    `${part.label} ${count(m.components[part.key])}`,
                                )
                                .join("，")
                            : "组成记录不足，无法绘制准确比例"
                        }
                      >
                        <span
                          className={`cache-track ${!m.components.complete ? "is-incomplete" : ""}`}
                          aria-hidden="true"
                        >
                          {m.components.complete &&
                            composition.map((part) => (
                              <span
                                key={part.key}
                                style={{
                                  width: `${m.totalTokens ? (m.components[part.key] / m.totalTokens) * 100 : 0}%`,
                                  background: part.color,
                                }}
                              />
                            ))}
                        </span>
                      </span>
                    </MetricTooltip>
                    <span>{pct(m.components.cacheRate)}</span>
                  </div>
                  {m.components.partial && (
                    <small className="partial-label">
                      {m.components.cacheReadKnown ? "已识别部分" : "组成未知"}
                    </small>
                  )}
                </td>
                <td data-label="使用费用" className="money-cell">
                  {money(m.costUsd)}
                </td>
                <td className="model-action-cell">
                  <button
                    className="row-arrow"
                    onClick={() => onSelect(m)}
                    aria-label={`展开 ${m.name}`}
                  >
                    <ArrowUpRight size={15} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!models.length && (
        <div className="empty-inline">
          <Search size={22} />
          <strong>没有找到匹配的模型</strong>
          <span>调整搜索词或提供商筛选后再试。</span>
        </div>
      )}
      <div className="table-foot">
        <span>
          <i className="status-dot purple" />
          缓存读取单独展示，不受其他来源影响
        </span>
        <span>
          {Math.min(full ? models.length : 5, models.length)} /{" "}
          {per.models.length} 个模型
        </span>
      </div>
    </section>
  );
}

function Clients({ per }: { per: PeriodUsage }) {
  return (
    <section className="panel clients-panel">
      <div className="panel-head">
        <div>
          <h2>客户端分布</h2>
          <p>了解用量从哪里来</p>
        </div>
        <Cpu size={19} className="muted" />
      </div>
      <div className="client-rows">
        {per.clients.map((c) => (
          <div className="client-row" key={c.id}>
            <div className="client-head">
              <span>
                <BrandIcon name={c.name} color={c.color} size={27} />
                <strong>{c.name}</strong>
              </span>
              <strong>
                {pct(per.totalTokens ? c.totalTokens / per.totalTokens : 0)}
              </strong>
            </div>
            <MetricTooltip
              title={`${c.name} · 用量明细`}
              rows={[
                {
                  label: "占全部用量",
                  value: pct(
                    per.totalTokens ? c.totalTokens / per.totalTokens : 0,
                  ),
                },
                ...usageDetails(c),
              ]}
              note={usageNote(c)}
              strictTouchBounds
            >
              <div className="metric-bar-trigger" role="img">
                <div
                  className={`client-track ${!c.components.complete ? "is-incomplete" : ""}`}
                  aria-hidden="true"
                >
                  {c.components.complete &&
                    composition.map((s) => (
                      <span
                        key={s.key}
                        style={{
                          background: s.color,
                          width: `${per.totalTokens ? (c.components[s.key] / per.totalTokens) * 100 : 0}%`,
                        }}
                      />
                    ))}
                </div>
              </div>
            </MetricTooltip>
            <div className="client-foot">
              <span>{compact(c.totalTokens)} Tokens</span>
              <span>{money(c.costUsd)}</span>
            </div>
          </div>
        ))}
      </div>
      <div className="client-note">
        <span className="soft-icon">
          <Database size={17} />
        </span>
        <p>
          <strong>清晰保留每一份用量</strong>
          <span>同一模型跨客户端汇总，未知组成独立显示。</span>
        </p>
      </div>
    </section>
  );
}

export function Overview({
  data,
  period,
  onModel,
}: {
  data: DashboardData;
  period: PeriodKey;
  onModel: (m: UsageEntity) => void;
}) {
  const per = data.periods[period];
  return (
    <>
      <Stats data={data} period={period} />
      <div className="overview-layout">
        <div className="overview-primary">
          <InsightTrend data={data} />
          <ModelTable per={per} onSelect={onModel} />
        </div>
        <div className="overview-aside">
          <CompositionCard per={per} />
          <Clients per={per} />
        </div>
      </div>
      <section className="provider-strip" aria-label="提供商状态">
        <span className="provider-caption">服务状态</span>
        {data.providers.map((p) => (
          <div key={p.id} className="provider-status">
            <BrandIcon name={p.name} size={22} />
            <strong>{p.name}</strong>
            <span className={`provider-state ${p.status}`}>
              <i
                className={`status-dot ${p.status === "operational" ? "" : p.status === "unknown" ? "muted" : "amber"}`}
              />
              {p.stale
                ? "上次状态"
                : p.status === "operational"
                  ? "运行正常"
                  : p.status === "unknown"
                    ? "暂无状态"
                    : p.status === "maintenance"
                      ? "维护中"
                      : "服务异常"}
            </span>
          </div>
        ))}
        <span className="provider-demo-note">
          {data.mode === "demo" ? "示例状态" : "官方状态页"}
        </span>
      </section>
    </>
  );
}

export function ModelMatrix({ per }: { per: PeriodUsage }) {
  const [metric, setMetric] = useState<"tokens" | "cost">("tokens");
  const source = metric === "tokens" ? per.clientModels : per.clientModelCosts;
  const clients = Object.keys(source || {});
  const models = per.models.filter((m) =>
    clients.some((c) => source?.[c]?.[m.id] !== undefined),
  );
  const max = Math.max(
    1,
    ...Object.values(source || {}).flatMap((m) => Object.values(m)),
  );
  return (
    <section className="panel matrix-panel">
      <div className="panel-head">
        <div>
          <h2>客户端 × 模型</h2>
          <p>顺着使用来源，进一步了解每个模型</p>
        </div>
        <div className="metric-switch">
          <button
            aria-pressed={metric === "tokens"}
            onClick={() => setMetric("tokens")}
          >
            词元用量
          </button>
          <button
            aria-pressed={metric === "cost"}
            onClick={() => setMetric("cost")}
          >
            使用费用
          </button>
        </div>
      </div>
      {clients.length && models.length ? (
        <div className="matrix-scroll">
          <table className="matrix-table">
            <caption className="sr-only">各客户端的模型用量对照表</caption>
            <thead>
              <tr>
                <th scope="col">客户端</th>
                {models.map((m) => (
                  <th scope="col" key={m.id}>
                    <MetricTooltip
                      title="模型名称"
                      rows={[{ label: "完整名称", value: m.name }]}
                    >
                      <span className="matrix-model-heading" role="img">
                        <BrandIcon name={m.name} size={25} />
                        <span>{m.name}</span>
                      </span>
                    </MetricTooltip>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {clients.map((c) => (
                <tr key={c}>
                  <th scope="row">
                    <span className="matrix-client-heading">
                      <BrandIcon name={c} size={27} />
                      {c}
                    </span>
                  </th>
                  {models.map((m) => {
                    const v = source?.[c]?.[m.id];
                    const level =
                      v === undefined
                        ? 0
                        : Math.min(4, Math.floor((Math.max(0, v) / max) * 4));
                    return (
                      <td key={m.id} data-model={m.name}>
                        <MetricTooltip
                          title={`${c} × ${m.name}`}
                          rows={[
                            {
                              label:
                                metric === "tokens" ? "词元用量" : "使用费用",
                              value:
                                v === undefined
                                  ? "未提供该组合的记录"
                                  : metric === "tokens"
                                    ? count(v)
                                    : money(v),
                            },
                          ]}
                        >
                          <span
                            className={`matrix-cell level-${level}`}
                            role="img"
                          >
                            {v === undefined
                              ? "—"
                              : metric === "tokens"
                                ? compact(v)
                                : money(v)}
                          </span>
                        </MetricTooltip>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="empty-inline">
          该来源尚未提供客户端与模型的对应记录。
        </div>
      )}
      <div className="table-foot">
        <span>颜色越深，当前组合的用量越高。— 表示未上报该组合。</span>
        <span>按来源原始对应关系统计</span>
      </div>
    </section>
  );
}
