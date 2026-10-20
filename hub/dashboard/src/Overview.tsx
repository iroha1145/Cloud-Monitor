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
import { clientName, providerName } from "./vendors";
import { matrixHeatLevel, matrixHeatPeak } from "./matrix-heat";
import { COMPOSITION } from "./palette";
import { usd } from "./money";
import { compact, count, pct } from "./lib/format";
import { useSlidingIndicator } from "./lib/hooks/use-sliding-indicator";
import { useScrollEdges } from "./lib/hooks/use-scroll-edges";
import { sector } from "./lib/donut-sector";
import { modelUsageDetails } from "./model-details";
import "./usage-details.css";


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
      value: item.costUsd === null ? "未提供" : usd(item.costUsd),
    },
    {
      label: parts.partial ? "已识别缓存占比" : "缓存占比",
      value: pct(parts.cacheRate),
    },
    ...COMPOSITION.map((part) => ({
      label: part.label,
      color: part.color,
      value: partUnknown(parts, part.key) ? "未提供" : count(parts[part.key]),
    })),
  ];
}

function usageNote(item: Pick<PeriodUsage, "components">) {
  return !item.components.complete && item.components.known
    ? "细项与总量不一致，暂不计算比例。"
    : item.components.partial
      ? "部分用量未分类，仅统计已知缓存。"
      : undefined;
}

function compositionNote(per: Pick<PeriodUsage, "totalTokens" | "components">) {
  const parts = per.components;
  if (per.totalTokens === 0) return "暂无上报用量";
  if (!parts.known) return "用量尚未分类";
  return !parts.complete
    ? "细项与总量数据不一致，暂不计算占比"
    : parts.partial
      ? "部分用量未分类，仅统计已知缓存"
      : "输入、输出与缓存占比";
}

function CompositionLegend({ parts, feelItems = false }: { parts: PeriodUsage["components"]; feelItems?: boolean }) {
  const sum = COMPOSITION.reduce((total, part) => total + parts[part.key], 0) || 1;
  return (
    <div className="composition-legend">
      {COMPOSITION.map((part) => {
        const unknown = partUnknown(parts, part.key);
        return (
          <div key={part.key} data-feel-item={feelItems ? "row" : undefined}>
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
  const showNote = !parts.complete || parts.partial || per.totalTokens === 0;
  return (
    <section className="ledger-composition" aria-labelledby="ledger-composition-title" data-feel-card>
      <div className="ledger-composition-head">
        <h2 id="ledger-composition-title">用量组成</h2>
        {showNote && <p>{compositionNote(per)}</p>}
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
      <CompositionLegend parts={parts} feelItems />
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
      <div className="ledger-figures" data-feel-group>
        <article className="ledger-figure ledger-lead" data-feel-card>
          <span className="ledger-label">
            总用量<small>词元</small>
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
            {count(per.totalTokens)} 词元
          </span>
        </article>
        <article className="ledger-figure" data-feel-card>
          <span className="ledger-label">
            使用费用
          </span>
          <strong className="ledger-value">
            {per.costUsd === null ? (
              "未提供"
            ) : (
              (() => {
                const cents = Math.round(per.costUsd * 100);
                return (
                  <>
                    <span className="ledger-unit is-prefix">
                      {cents < 0 ? "-$" : "$"}
                    </span>
                    <NumberTicker
                      digitClassName="ledger-digit"
                      value={Math.abs(cents)}
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
                );
              })()
            )}
          </strong>
          <span className="ledger-note">按模型单价估算</span>
        </article>
        <article className="ledger-figure" data-feel-card>
          <span className="ledger-label">
            {per.components.partial ? "已识别缓存占比" : "缓存占比"}
            <MetricTooltip
              title="缓存占比"
              rows={[
                { label: "计算公式", value: "缓存读取量 ÷ 总用量" },
              ]}
            >
              <button className="help-icon" aria-label="查看缓存占比说明">
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
              : "未提供缓存明细"}
          </span>
        </article>
        <article className="ledger-figure" data-feel-card>
          <span className="ledger-label">在线设备</span>
          <strong className="ledger-value">
            <NumberTicker value={online} duration={0.4} startOnView={false} digitClassName="ledger-digit" />
            <span className="ledger-denominator">/ {data.devices.length}</span>
          </strong>
          <span className="ledger-note">
            <i className={online ? "status-dot" : "status-dot muted"} aria-hidden="true" />
            {online ? "设备正在同步" : "暂无在线设备"}
          </span>
        </article>
      </div>
      {showComposition && <UsageSpectrum per={per} />}
    </section>
  );
}

/** Arc UI donut geometry: a 208px ring 24px thick, 3px gaps, 4px corners. */
const RING = { size: 208, margin: 7, thickness: 24, gap: 3, corner: 4 };

export function CompositionCard({
  per,
  small = false,
}: {
  per: PeriodUsage;
  small?: boolean;
}) {
  const parts = per.components;
  const sum = COMPOSITION.reduce((total, part) => total + parts[part.key], 0);
  const c = RING.size / 2;
  const outer = c - RING.margin;
  const inner = outer - RING.thickness;
  let turn = 0;
  const arcs = COMPOSITION.flatMap((part) => {
    if (!sum || parts[part.key] <= 0) return [];
    const start = turn;
    turn += parts[part.key] / sum;
    return [{ key: part.key, color: part.color, d: sector(c, outer, inner, start, turn, RING.gap, RING.corner) }];
  });
  return (
    <section className={`panel composition-panel ${small ? "small" : ""}`} data-feel-card={small ? undefined : true}>
      <div className="panel-head">
        <h2>用量组成</h2>
      </div>
      {/* The ring and the reading in its hole are one picture. */}
      <div
        className="composition-hero"
        role="img"
        aria-label={`用量组成环形图，总用量 ${count(per.totalTokens)}，缓存占比 ${pct(parts.cacheRate)}`}
      >
        <svg
          viewBox={`0 0 ${RING.size} ${RING.size}`}
          className="composition-ring"
          aria-hidden="true"
        >
          {arcs.length ? (
            arcs.map((arc) => <path key={arc.key} d={arc.d} fill={arc.color} />)
          ) : (
            <path className="composition-ring-track" d={sector(c, outer, inner, 0, 1, 0, 0)} />
          )}
        </svg>
        <div className="composition-center">
          <span className="eyebrow">
            {parts.partial ? "已识别缓存占比" : "缓存占比"}
          </span>
          <strong>{pct(parts.cacheRate)}</strong>
          <span className="composition-hint">
            {parts.cacheReadKnown
              ? `${compact(parts.cacheRead)} 缓存读取`
              : "未提供缓存明细"}
          </span>
        </div>
      </div>
      <CompositionLegend parts={parts} />
      {(!parts.complete || parts.partial || per.totalTokens === 0) && (
        <p className="composition-note">
          <CircleHelp size={13} />
          {compositionNote(per)}
        </p>
      )}
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
    <section className={`panel models-panel ${full ? "full-models" : ""}`} data-feel-card>
      <div className="panel-head">
        <div>
          <h2>
            模型用量 <span className="count-badge">{per.models.length}</span>
          </h2>
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
                <tr key={m.id} data-feel-item="row">
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
                    <div className="model-compact-split">
                      {m.components.inputKnown && <span><i style={{ background: COMPOSITION[1].color }} aria-hidden="true" />非缓存输入 {compact(m.components.input)}</span>}
                      {m.components.outputKnown && <span><i style={{ background: COMPOSITION[2].color }} aria-hidden="true" />输出 {compact(m.components.output)}</span>}
                    </div>
                  </td>
                  <td data-label="缓存读取" className="model-read-cell">
                    <MetricTooltip
                      title={`${m.name} · 缓存读取`}
                      rows={[
                        {
                          label: "完整用量",
                          value: m.components.cacheReadKnown
                            ? count(m.components.cacheRead)
                            : "未提供",
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
                              COMPOSITION.filter((part) => m.components[part.key] > 0).map((part) => (
                                <span
                                  key={part.key}
                                  style={{ flexGrow: m.components[part.key], background: part.color }}
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
                    {modelUsageDetails(per, m.id).outputTokensPerSecond !== null && <small className="model-speed-note">输出 {modelUsageDetails(per, m.id).outputTokensPerSecond!.toFixed(1)} 词元/秒</small>}
                  </td>
                  <td className="model-action-cell">
                    {/* Pointer shortcut only: the name button is the keyboard and
                        screen-reader entry, and focus returns to it on close. */}
                    <span
                      className="row-arrow"
                      aria-hidden="true"
                      onClick={(event) => {
                        const opener = event.currentTarget
                          .closest("tr")
                          ?.querySelector<HTMLButtonElement>(".model-open");
                        if (opener) onSelect(m, opener);
                      }}
                    >
                      <ArrowUpRight size={15} />
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </GlideMenu>
      </div>
      {!models.length &&
        (per.models.length ? (
          <div className="empty-inline">
            <Search size={22} />
            <strong>没有找到匹配的模型</strong>
            <span>请尝试其他关键词或筛选条件。</span>
            {(query || provider !== "all") && (
              <button
                type="button"
                className="plain-button"
                onClick={() => {
                  setQuery("");
                  setProvider("all");
                }}
              >
                清除筛选
              </button>
            )}
          </div>
        ) : (
          <div className="empty-inline">
            <strong>暂无模型用量</strong>
            <span>设备同步后，这里会列出各模型的用量与费用。</span>
          </div>
        ))}
      <div className="table-foot">
        <span>
          显示 {Math.min(full ? models.length : 5, models.length)} /{" "}
          {per.models.length} 个模型
        </span>
      </div>
    </section>
  );
}

function Clients({ per }: { per: PeriodUsage }) {
  return (
    <section className="panel clients-panel" data-feel-card>
      <div className="panel-head">
        <div>
          <h2>客户端分布</h2>
          <p>共 {per.clients.length} 个客户端</p>
        </div>
      </div>
      {!per.clients.length && (
        <div className="empty-inline">
          <strong>暂无客户端数据</strong>
          <span>设备同步后，这里会按客户端展示用量占比。</span>
        </div>
      )}
      <div className="client-rows">
        {per.clients.map((c) => (
          <div className="client-row" key={c.id} data-feel-item="row">
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
                  {c.components.complete && (
                    <>
                      {COMPOSITION.filter((s) => c.components[s.key] > 0).map((s) => (
                        <span key={s.key} style={{ flexGrow: c.components[s.key], background: s.color }} />
                      ))}
                      {per.totalTokens > c.totalTokens && (
                        <span className="track-rest" style={{ flexGrow: per.totalTokens - c.totalTokens }} />
                      )}
                    </>
                  )}
                </div>
              </div>
            </MetricTooltip>
            <div className="client-foot">
              <span>{compact(c.totalTokens)} 词元</span>
              <span>{usd(c.costUsd)}</span>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/** A new server has no devices yet: say how to connect one, not just "0". */
function FirstReport() {
  return (
    <section className="panel first-report" aria-labelledby="first-report-title" data-feel-card>
      <div>
        <h2 id="first-report-title">等待设备接入</h2>
        <p>
          在本机的 token-monitor 里打开「设置 → 多设备同步」，填入以下服务地址与密钥即可开始同步。
        </p>
      </div>
      <dl>
        <div>
          <dt>地址</dt>
          <dd>
            <code>{location.origin}</code>
          </dd>
        </div>
        <div>
          <dt>密钥</dt>
          <dd>
            服务端配置的 <code>TOKEN_MONITOR_SECRET</code>
          </dd>
        </div>
      </dl>
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
  const awaitingFirstReport =
    data.mode === "live" &&
    data.devices.length === 0 &&
    data.periods.allTime.totalTokens === 0;
  return (
    <>
      {awaitingFirstReport && <FirstReport />}
      <Stats data={data} period={period} showComposition />
      <div className="overview-layout">
        <AppErrorBoundary title="用量趋势已更新，请刷新。">
          <InsightTrend data={data} />
        </AppErrorBoundary>
        <Clients per={per} />
      </div>
      <ModelTable per={per} onSelect={onModel} />
      {data.providers.length > 0 && <section className="provider-strip" aria-label="提供商状态" data-feel-card>
        <span className="provider-caption">服务状态</span>
        {data.providers.map((p) => (
          <div key={p.id} className="provider-status" data-feel-item="row">
            <BrandIcon name={p.name} size={22} />
            <strong>{p.name}</strong>
            <span className={`provider-state ${p.status}`}>
              <i
                className={`status-dot ${p.status === "operational" ? "" : p.status === "unknown" ? "muted" : "amber"}`}
                aria-hidden="true"
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
          {data.mode === "demo" ? "演示状态" : "官方状态页"}
        </span>
      </section>}
    </>
  );
}

export function ModelMatrix({ per }: { per: PeriodUsage }) {
  const [metric, setMetric] = useState<"tokens" | "cost">("tokens");
  const metricSwitch = useSlidingIndicator<HTMLDivElement>('[aria-pressed="true"]');
  const matrixEdges = useScrollEdges<HTMLDivElement>();
  const source = metric === "tokens" ? per.clientModels : per.clientModelCosts;
  const clients = Object.keys(source || {});
  const models = per.models.filter((m) =>
    clients.some((c) => source?.[c]?.[m.id] !== undefined),
  );
  const peak = matrixHeatPeak(source);
  return (
    <section className="panel matrix-panel" data-feel-card>
      <div className="panel-head">
        <div>
          <h2>客户端 × 模型</h2>
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
        <div
          className="matrix-scroll"
          ref={matrixEdges}
          role="region"
          aria-label="客户端与模型用量对照表"
        >
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
                      {clientName(c)}
                    </span>
                  </th>
                  {models.map((m) => {
                    const v = source?.[c]?.[m.id];
                    const level = matrixHeatLevel(v, peak);
                    return (
                      <td key={m.id} data-model={m.name}>
                        <MetricTooltip
                          title={`${clientName(c)} × ${m.name}`}
                          rows={[
                            {
                              label:
                                metric === "tokens" ? "词元用量" : "使用费用",
                              value:
                                v === undefined
                                  ? "无记录"
                                  : metric === "tokens"
                                    ? count(v)
                                    : usd(v),
                            },
                          ]}
                        >
                          <span
                            className={`matrix-cell level-${level}`}
                            data-feel-item="cell"
                          >
                            {v === undefined ? (
                              <>
                                <span aria-hidden="true">—</span>
                                <span className="sr-only">无记录</span>
                              </>
                            ) : metric === "tokens" ? (
                              compact(v)
                            ) : (
                              usd(v)
                            )}
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
          暂无客户端与模型的交叉记录。
        </div>
      )}
      <div className="table-foot">
        <span>颜色越深代表{metric === "tokens" ? "用量" : "费用"}越高；— 表示无记录</span>
      </div>
    </section>
  );
}
