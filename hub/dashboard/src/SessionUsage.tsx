import { ChevronDown, Clock3, Layers3 } from "lucide-react";
import type { CSSProperties } from "react";
import type { Session } from "./data";
import { BrandIcon } from "./BrandIcon";
import { COMPOSITION } from "./palette";
import { compact, count } from "./lib/format";
import { formatZoned } from "./lib/datetime";
import { usd } from "./money";
import { clientName, providerName } from "./vendors";
import { sessionActivity, sessionPromptCache, sessionUsageSource } from "./session-presentation";
import { sessionModelUsage, sessionUsageDetails } from "./session-details";
import "./usage-details.css";

const CONTEXT_USAGE_FILL = `linear-gradient(90deg, ${COMPOSITION.map(part => part.color).join(", ")})`;

export function durationLabel(milliseconds: number | null | undefined): string {
  if (milliseconds == null || !Number.isFinite(milliseconds) || milliseconds < 0) return "未提供";
  if (milliseconds < 1000) return `${Math.round(milliseconds)} 毫秒`;
  const seconds = milliseconds / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} 秒`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes.toLocaleString("zh-CN")} 分 ${Math.floor(seconds % 60)} 秒`;
}

export function eventTime(value: string | null | undefined, timeZone: string): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "未提供";
  return formatZoned(new Date(value), timeZone, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }) ?? "未提供";
}

export function SessionTokenBreakdown({ session }: { session: Session }) {
  const usage = sessionUsageDetails(session);
  const rows = [
    { label: "非缓存输入", value: usage.input, color: COMPOSITION[1].color },
    { label: "输出", value: usage.output, color: COMPOSITION[2].color },
    { label: "缓存读取", value: usage.cacheRead, color: COMPOSITION[0].color },
    { label: "缓存写入", value: usage.cacheWrite, color: COMPOSITION[3].color },
    { label: "其中推理", value: usage.reasoning, color: COMPOSITION[2].color },
    { label: "未分类", value: usage.unclassified, color: COMPOSITION[4].color },
  ];
  return <section className="session-token-breakdown" aria-label="会话累计词元组成">
    <div className="detail-section-heading"><h3>会话累计用量</h3><span>词元</span></div>
    <dl className="session-token-grid">
      {rows.map(row => <div key={row.label} data-feel-item="row" style={{ "--usage-part-color": row.color } as CSSProperties}>
        <dt><i style={{ background: row.color }} aria-hidden="true" />{row.label}</dt>
        <dd>{row.value === null ? <span className="value-unavailable">未提供</span> : count(row.value)}</dd>
      </div>)}
    </dl>
    <p className="detail-footnote">推理用量已包含在输出中。{usage.hasUnconfirmedZeros ? " 部分零值无法确认，显示为未提供。" : !usage.complete ? " 部分细项未提供，与总量不完全一致。" : ""}</p>
  </section>;
}

export function SessionDetails({ session, generatedAt, timeZone }: { session: Session; generatedAt: string; timeZone: string }) {
  const usage = sessionUsageDetails(session);
  const activity = sessionActivity(session, generatedAt);
  const promptCache = sessionPromptCache(session, generatedAt);
  const source = sessionUsageSource(session);
  return <div className="session-details-content">
    <SessionTokenBreakdown session={session} />
    {usage.context && <section className="session-context-block sv-session-context" aria-label="上次上报的上下文" data-feel-item="row">
      <div className="detail-section-heading"><h3>上次上报的上下文</h3><strong>{usage.context.percentUsed.toFixed(1)}%</strong></div>
      <progress max={100} value={Math.min(100, usage.context.percentUsed)} aria-label="上次上报的上下文已用比例" style={{ "--context-usage-fill": CONTEXT_USAGE_FILL } as CSSProperties} />
      <p>{count(usage.context.tokens)} / {count(usage.context.window)} 词元 <span>· 已用 {usage.context.percentUsed.toFixed(1)}% · 剩余 {Math.max(0, 100 - usage.context.percentUsed).toFixed(1)}%</span></p>
    </section>}
    <dl className="session-facts sv-detail-grid">
      <div data-feel-item="row"><dt>活动状态</dt><dd className={activity === "等待输入" ? "sv-session-activity-waiting" : undefined}>{activity}{session.archived ? " · 已归档" : ""}</dd></div>
      <div data-feel-item="row"><dt>来源设备</dt><dd>{session.device || "未提供"}</dd></div>
      <div data-feel-item="row"><dt>已记录消息</dt><dd>{usage.messageCount === null ? "未提供" : `${count(usage.messageCount)} 条`}</dd></div>
      <div data-feel-item="row"><dt>输出速率</dt><dd>{usage.outputTokensPerSecond === null ? "未提供" : `${usage.outputTokensPerSecond.toFixed(1)} 词元/秒`}</dd></div>
      <div data-feel-item="row"><dt>开始时间</dt><dd><time dateTime={session.startedAt ?? undefined}>{eventTime(session.startedAt, timeZone)}</time></dd></div>
      <div data-feel-item="row"><dt>最后活动</dt><dd><time dateTime={session.lastUsedAt ?? undefined}>{eventTime(session.lastUsedAt, timeZone)}</time></dd></div>
      <div data-feel-item="row"><dt>完整用量</dt><dd>{count(session.totalTokens)} 词元</dd></div>
      <div data-feel-item="row"><dt>估算费用</dt><dd>{usd(session.costUsd)}</dd></div>
      {session.timedDurationMs != null && session.timedDurationMs > 0 && <div data-feel-item="row"><dt>生成耗时</dt><dd>{durationLabel(session.timedDurationMs)}</dd></div>}
      {session.timedOutputTokens != null && session.timedDurationMs != null && session.timedDurationMs > 0 && <div data-feel-item="row"><dt>测速输出量</dt><dd>{count(session.timedOutputTokens)} 词元</dd></div>}
      {promptCache && <div data-feel-item="row"><dt>提示词缓存</dt><dd>约剩 {promptCache.minutes} 分钟</dd></div>}
      {session.unpricedTokens != null && session.unpricedTokens > 0 && <div data-feel-item="row"><dt>未定价词元</dt><dd>{count(session.unpricedTokens)} 词元，未计入费用</dd></div>}
      {session.sessionKind && <div data-feel-item="row"><dt>会话类型</dt><dd>{session.sessionKind}</dd></div>}
      {source && <div data-feel-item="row"><dt>统计范围</dt><dd>{source}</dd></div>}
    </dl>
    {usage.outputTokensPerSecond !== null && <p className="detail-footnote">速率仅统计带有效计时的输出，耗时可能包含等待时间。</p>}
    <details className="session-origin-disclosure">
      <summary>来源与模型 <ChevronDown size={15} aria-hidden="true" /></summary>
      <dl className="session-facts">
        <div data-feel-item="row"><dt>客户端</dt><dd>{clientName(session.client)}</dd></div>
        {session.title && <div data-feel-item="row"><dt>会话标题</dt><dd className="session-identifier">{session.title}</dd></div>}
        <div data-feel-item="row"><dt>项目</dt><dd>{session.project || "未提供"}</dd></div>
        <div data-feel-item="row"><dt>会话标识</dt><dd className="session-identifier">{session.sessionId || session.id}</dd></div>
        {session.deviceId && <div data-feel-item="row"><dt>设备标识</dt><dd className="session-identifier">{session.deviceId}</dd></div>}
        {session.projectId && <div data-feel-item="row"><dt>项目标识</dt><dd className="session-identifier">{session.projectId}</dd></div>}
        {session.nativeSessionId && session.nativeSessionId !== session.sessionId && <div data-feel-item="row"><dt>原生会话标识</dt><dd className="session-identifier">{session.nativeSessionId}</dd></div>}
        {session.t3ThreadId && <div data-feel-item="row"><dt>关联会话标识（T3）</dt><dd className="session-identifier">{session.t3ThreadId}</dd></div>}
        {session.liveActivity?.observedAt && <div data-feel-item="row"><dt>状态更新时间</dt><dd>{eventTime(session.liveActivity.observedAt, timeZone)}</dd></div>}
        {session.promptCache?.observedAt && <div data-feel-item="row"><dt>缓存记录时间</dt><dd>{eventTime(session.promptCache.observedAt, timeZone)}</dd></div>}
        {(session.parentSessionId || session.parentClient) && <div data-feel-item="row"><dt>父级会话</dt><dd className="session-identifier">{[session.parentClient ? clientName(session.parentClient) : null, session.parentSessionId].filter(Boolean).join(" · ")}</dd></div>}
        {Object.entries(session.providers ?? {}).map(([provider, tokens]) => <div key={provider} data-feel-item="row"><dt>提供商 · {providerName(provider)}</dt><dd>{tokens === 0 && session.zeroValuesUnconfirmed !== false ? "未提供" : `${count(tokens)} 词元`}</dd></div>)}
      </dl>
      <div className="session-model-ledger" aria-label="会话使用模型">
        {session.models.length ? session.models.map(model => <div key={model} data-feel-item="row">
          <span><BrandIcon name={model} size={20} /><span>{model}</span></span>
          <span>{session.modelTokens?.[model] == null ? "词元未提供" : `${compact(session.modelTokens[model])} 词元`}</span>
          <span>{usd(session.modelCosts?.[model] ?? null)}</span>
        </div>) : <p className="detail-footnote">未提供模型明细</p>}
      </div>
    </details>
  </div>;
}

export function SessionUsageCard({ session, modelId, generatedAt, timeZone }: { session: Session; modelId: string; generatedAt: string; timeZone: string }) {
  const model = sessionModelUsage(session, modelId);
  return <details className="session-usage-card">
    <summary>
      <BrandIcon name={session.client} size={30} />
      <span className="session-card-title"><strong>{session.project || clientName(session.client)}</strong><small>{session.device || "设备未提供"} · {eventTime(session.lastUsedAt, timeZone)}</small></span>
      <span className="session-card-amount"><strong>{model.tokens === null ? "未提供" : compact(model.tokens)}</strong><small>本模型词元</small></span>
      <ChevronDown size={17} className="disclosure-chevron" aria-hidden="true" />
    </summary>
    <div className="session-card-body">
      {!model.wholeSession && <p className="session-scope-note"><Layers3 size={14} />此会话使用了多个模型，下方为整个会话的统计。</p>}
      <p className="session-current-line"><Clock3 size={14} />{sessionActivity(session, generatedAt)}<span>·</span>{clientName(session.client)}<span>·</span>本模型费用 {usd(model.costUsd)}</p>
      <SessionDetails session={session} generatedAt={generatedAt} timeZone={timeZone} />
    </div>
  </details>;
}
