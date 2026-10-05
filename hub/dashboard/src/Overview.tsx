import { useMemo, useState } from "react";
import { AppErrorBoundary } from "./chunkLoad";
import { InsightTrend } from "./InsightTrend";
import { ArrowDown, ArrowUpRight, CircleHelp, Search } from "lucide-react";
import { BrandIcon } from "./BrandIcon";
import GlideMenu from "./components/primitives/GlideMenu";
import { NumberTicker } from "./components/motion/number-ticker";
import { MetricTooltip, type MetricDetailRow } from "./MetricTooltip";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select";
import {
  type DashboardData,
  type PeriodKey,
  type PeriodUsage,
  type UsageEntity,
} from "./data";
import { providerName } from "./vendors";
import { matrixHeatLevel, matrixHeatPeak } from "./matrix-heat";
import { COMPOSITION } from "./palette";
import { usd } from "./money";
import { compact, count, pct } from "./lib/format";
import { useSlidingIndicator } from "./lib/hooks/use-sliding-indicator";


/** A part the source did not report is unknown, never zero. */
function partUnknown(
  parts: PeriodUsage["components"],
  key: (typeof COMPOSITION)[number]["key"],
) {
  return (
    (!parts.known && key !== "unclassified") ||
    (key === "cacheRead" && !parts.cacheReadKnown) ||
    (key === "cacheWrite" && !parts.cacheWriteKnown)
  );
}

function usageDetails(
  item: Pick<PeriodUsage, "totalTokens" | "costUsd" | "components">,
): MetricDetailRow[] {
  const parts = item.components;
  return [
    { label: "总用量", value: count(item.totalTokens) },
    {
      label: "费用",
      value: item.costUsd === null ? "来源未提供" : usd(item.costUsd),
    },
    {
      label: parts.partial ? "已识别缓存占比" : "缓存占比",
      value: pct(parts.cacheRate),
    },
    ...COMPOSITION.map((part) => ({
      label: part.label,
      color: part.color,
      value: partUnknown(parts, part.key) ? "来源未提供" : count(parts[part.key]),
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

function compositionNote(parts: PeriodUsage["components"]) {
  return !parts.complete && parts.known
    ? "组成与总量不一致，暂不计算缓存占比。"
    : parts.partial
      ? "保留已知缓存，未识别用量单独列出。"
      : "所有已上报用量均已完成分类。";
}

function CompositionLegend({ parts }: { parts: PeriodUsage["components"] }) {
  const sum = COMPOSITION.reduce((total, part) => total + parts[part.key], 0) || 1;
  return (
    <div className="composition-legend">
      {COMPOSITION.map((part) => {
        const unknown = partUnknown(parts, part.key);
        return (
          <div key={part.key}>
            <span>
              <i className="legend-dot" style={{ background: part.color }} />
              {part.label}
            </span>
            <strong>{unknown ? "未提供" : compact(parts[part.key])}</strong>
            <span>
              {unknown || (parts.known && !parts.complete)
                ? "未提供"
                : pct(parts[part.key] / sum)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** The five-part spectrum: one bar, widths proportional to the reported parts. */
function UsageSpectrum({ per }: { per: PeriodUsage }) {
  const parts = per.components;
  const sum = COMPOSITION.reduce((total, part) => total + parts[part.key], 0);
  const drawable = parts.complete && sum > 0;
  return (
    <section className="ledger-composition" aria-labelledby="ledger-composition-title">
      <div className="ledger-composition-head">
        <h2 id="ledger-composition-title">用量组成</h2>
        <p>{compositionNote(parts)}</p>
      </div>
      <div
        className={`spectrum ${drawable ? "" : "is-incomplete"}`}
        role="img"
        aria-label={
          drawable
            ? `用量组成色谱：${COMPOSITION
                .map((part) => `${part.label} ${pct(parts[part.key] / sum)}`)
                .join("，")}`
            : "用量组成色谱：组成记录不足，无法绘制准确比例"
        }
      >
        {drawable &&
          COMPOSITION.map((part) =>
            parts[part.key] > 0 ? (
              <span
                key={part.key}
                style={{
                  flexGrow: parts[part.key],
                  background: part.color,
                }}
              />
            ) : null,
          )}
      </div>
      <CompositionLegend parts={parts} />
    </section>
  );
}

export function Stats({
  data,
  period,
  showComposition = false,
}: {
  data: DashboardData;
  period: PeriodKey;
  showComposition?: boolean;
}) {
  const per = data.periods[period],
    rate = per.components.cacheRate;
  const online = data.devices.filter((d) => d.status === "online").length;
  return (
    <section className="ledger" aria-label="用量摘要">
      <div className="ledger-figures">
        <article className="ledger-figure ledger-lead">
          <span className="ledger-label">
            总用量<small>词元（Tokens）</small>
          </span>
          <strong className="ledger-value">
            <NumberTicker
              digitClassName="ledger-digit"
              value={per.totalTokens}
              format={(n) => compact(n).split(" ")[0]}
              duration={0.45}
              stagger={0.015}
              startOnView={false}
            />
            <span className="ledger-unit">{compact(per.totalTokens).split(" ")[1]}</span>
          </strong>
          <span className="ledger-note">
            {count(per.totalTokens)} · 所有模型与客户端
          </span>
        </article>
        <article className="ledger-figure">
          <span className="ledger-label">
            使用费用<small>美元</small>
          </span>
          <strong className="ledger-value">
            {per.costUsd === null ? (
              "未提供"
            ) : (
              <>
                <span className="ledger-unit is-prefix">$</span>
                <NumberTicker
                digitClassName="ledger-digit"
                  value={Math.round(per.costUsd * 100)}
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
              </>
            )}
          </strong>
          <span className="ledger-note">按上报价格统计</span>
        </article>
        <article className="ledger-figure">
          <span className="ledger-label">
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
          </span>
          <strong className="ledger-value">
            {rate === null ? (
              "未提供"
            ) : (
              <>
                <NumberTicker
                digitClassName="ledger-digit"
                  value={Math.round(rate * 1000)}
                  format={(n) => (n / 10).toFixed(1)}
                  duration={0.45}
                  startOnView={false}
                />
                <span className="ledger-unit">%</span>
              </>
            )}
          </strong>
          <span className="ledger-note">
            {per.components.cacheReadKnown
              ? `${compact(per.components.cacheRead)} 缓存读取`
              : "等待来源提供缓存数据"}
          </span>
        </article>
        <article className="ledger-figure">
          <span className="ledger-label">在线设备</span>
          <strong className="ledger-value">
            <NumberTicker value={online} duration={0.4} startOnView={false} digitClassName="ledger-digit" />
            <span className="ledger-denominator">/ {data.devices.length}</span>
          </strong>
          <span className="ledger-note">
            <i className={online ? "status-dot" : "status-dot muted"} />
            {online ? "设备正在同步" : "暂无在线设备"}
          </span>
        </article>
      </div>
      {showComposition && <UsageSpectrum per={per} />}
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
  const values = COMPOSITION.map((s) => ({
    ...s,
    value: per.components[s.key],
  }));
  const sum = values.reduce((a, s) => a + s.value, 0) || 1;
  let offset = 0;
  return (
    <section className={`panel composition-panel ${small ? "small" : ""}`}>
      <div className="panel-head">
        <h2>用量组成</h2>
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
          aria-label={`用量组成环形图，总用量 ${count(per.totalTokens)}，缓存占比 ${pct(per.components.cacheRate)}`}
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
                  style={{
                    strokeDasharray: `${Math.max(0, len - 2.8)} 270.18`,
                    strokeDashoffset: -start,
                  }}
                  transform="rotate(-90 55 55)"
                />
              );
            })}
        </svg>
      </div>
      <CompositionLegend parts={per.components} />
      <p className="composition-note">
        <CircleHelp size={13} />
        {compositionNote(per.components)}
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
  onSelect: (item: UsageEntity, opener: HTMLButtonElement) => void;
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
          <p>按总用量排序，展开查看每个模型的组成</p>
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
        {COMPOSITION.map((part) => (
          <span key={part.key}>
            <i style={{ background: part.color }} />
            {part.label}
          </span>
        ))}
      </div>
      <div className="model-table-scroll">
        <GlideMenu
          className="table-glide-scope"
          highlightClassName="table-glide"
          rowSelector="tbody tr"
        >
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
                      onClick={(event) => onSelect(m, event.currentTarget)}
                      aria-label={`查看 ${m.name} 详情`}
                    >
                      <BrandIcon name={m.name} />
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
                      focusable
                    >
                      <span>{compact(m.totalTokens)}</span>
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
                      focusable
                    >
                      <span>
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
                        focusable
                      >
                        <span
                          className="metric-bar-trigger"
                          role="img"
                          aria-label={
                            m.components.complete
                              ? COMPOSITION
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
                              COMPOSITION.map((part) => (
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
                    {usd(m.costUsd)}
                  </td>
                  <td className="model-action-cell">
                    <button
                      className="row-arrow"
                      onClick={(event) => onSelect(m, event.currentTarget)}
                      aria-label={`展开 ${m.name}`}
                    >
                      <ArrowUpRight size={15} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </GlideMenu>
      </div>
      {!models.length && (
        <div className="empty-inline">
          <Search size={22} />
          <strong>没有找到匹配的模型</strong>
          <span>调整搜索词或提供商筛选后再试。</span>
        </div>
      )}
      <div className="table-foot">
        <span>缓存读取单独展示，不受其他来源影响</span>
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
          <p>{per.clients.length} 个客户端 · 占全部用量</p>
        </div>
      </div>
      <div className="client-rows">
        {per.clients.map((c) => (
          <div className="client-row" key={c.id}>
            <div className="client-head">
              <span>
                <BrandIcon name={c.id} size={27} />
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
              focusable
            >
              <div
                className="metric-bar-trigger"
                role="img"
                aria-label={`${c.name} 用量 ${count(c.totalTokens)}`}
              >
                <div
                  className={`client-track ${!c.components.complete ? "is-incomplete" : ""}`}
                  aria-hidden="true"
                >
                  {c.components.complete &&
                    COMPOSITION.map((s) => (
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
              <span>{usd(c.costUsd)}</span>
            </div>
          </div>
        ))}
      </div>
      <p className="client-note">同一模型跨客户端汇总，未知组成单独显示。</p>
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
  onModel: (m: UsageEntity, opener: HTMLButtonElement) => void;
}) {
  const per = data.periods[period];
  return (
    <>
        <Stats data={data} period={period} showComposition />
        <div className="overview-layout">
          <AppErrorBoundary title="用量趋势已更新，请刷新。">
            <InsightTrend data={data} />
          </AppErrorBoundary>
          <Clients per={per} />
        </div>
        <ModelTable per={per} onSelect={onModel} />
        {data.providers.length > 0 && <section className="provider-strip" aria-label="提供商状态">
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
        </section>}
    </>
  );
}

export function ModelMatrix({ per }: { per: PeriodUsage }) {
  const [metric, setMetric] = useState<"tokens" | "cost">("tokens");
  const metricSwitch = useSlidingIndicator<HTMLDivElement>('[aria-pressed="true"]');
  const source = metric === "tokens" ? per.clientModels : per.clientModelCosts;
  const clients = Object.keys(source || {});
  const models = per.models.filter((m) =>
    clients.some((c) => source?.[c]?.[m.id] !== undefined),
  );
  const peak = matrixHeatPeak(source);
  return (
    <section className="panel matrix-panel">
      <div className="panel-head">
        <div>
          <h2>客户端 × 模型</h2>
          <p>每个客户端用了哪些模型</p>
        </div>
        <div className="metric-switch" ref={metricSwitch}>
          <span data-sliding-indicator aria-hidden="true" />
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
                      title={m.name}
                      rows={[{ label: "完整名称", value: m.name }]}
                    >
                      <span className="matrix-model-heading">
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
                    const level = matrixHeatLevel(v, peak);
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
                                    : usd(v),
                            },
                          ]}
                        >
                          <span
                            className={`matrix-cell level-${level}`}
                          >
                            {v === undefined
                              ? "未提供"
                              : metric === "tokens"
                                ? compact(v)
                                : usd(v)}
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
