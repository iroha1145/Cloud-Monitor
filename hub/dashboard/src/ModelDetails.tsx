import { useState } from "react";
import { ChevronDown, Gauge, MessageSquareText } from "lucide-react";
import type { DashboardData, PeriodKey, PeriodUsage, UsageEntity } from "./data";
import { CompositionCard } from "./Overview";
import { BrandIcon } from "./BrandIcon";
import { clientName } from "./vendors";
import { count, compact } from "./lib/format";
import { usd } from "./money";
import { modelUsageDetails, sessionsForModel } from "./model-details";
import { LOCAL_DETAIL_NOTICE, sessionPeriodDetails, sessionsForPeriod } from "./session-details";
import { SessionUsageCard, durationLabel } from "./SessionUsage";
import { useActivityReference } from "./lib/hooks/use-activity-reference";
import "./usage-details.css";

export function ModelDetails({ model, data, per, period }: { model: UsageEntity; data: DashboardData; per: PeriodUsage; period: PeriodKey }) {
  const [shown, setShown] = useState(5);
  const activityReference = useActivityReference(data.generatedAt);
  const detail = modelUsageDetails(per, model.id);
  const meta = sessionPeriodDetails(data, period);
  const sessions = sessionsForModel(sessionsForPeriod(data, period), model.id).sort((a, b) => (Date.parse(b.lastUsedAt ?? "") || 0) - (Date.parse(a.lastUsedAt ?? "") || 0));
  return <div className="model-details-content">
    <div className="model-detail-stats">
      <div><span>总用量</span><strong>{compact(model.totalTokens)}</strong><small>{count(model.totalTokens)} 词元</small></div>
      <div><span>估算费用</span><strong>{usd(model.costUsd)}</strong><small>按模型单价估算</small></div>
    </div>
    <CompositionCard small per={{ ...per, totalTokens: model.totalTokens, components: model.components }} />
    {model.unpricedTokens != null && model.unpricedTokens > 0 && <p className="detail-footnote">另有 {count(model.unpricedTokens)} 词元未提供单价，未计入费用。</p>}
    {detail.outputTokensPerSecond !== null && <section className="model-speed-detail" aria-label="模型输出速度">
      <Gauge size={20} aria-hidden="true" />
      <div><span>平均输出速度</span><strong>{detail.outputTokensPerSecond.toFixed(1)} <small>词元/秒</small></strong></div>
      <details><summary>测速详情 <ChevronDown size={14} aria-hidden="true" /></summary><dl>
        <div><dt>计时输出</dt><dd>{count(detail.throughput!.timedOutputTokens!)} 词元</dd></div>
        <div><dt>计时耗时</dt><dd>{durationLabel(detail.throughput!.timedDurationMs)}</dd></div>
        {detail.throughput?.timedTokens != null && <div><dt>测速样本总量</dt><dd>{count(detail.throughput.timedTokens)} 词元</dd></div>}
      </dl><p>仅统计带有效计时的记录，耗时可能包含等待时间。</p></details>
    </section>}
    {detail.outputTokensPerSecond !== null && detail.untimedDevices > 0 && <p className="detail-footnote">另有 {detail.untimedDevices} 台设备用过这个模型，但没有上报计时，没算进速度。</p>}
    {detail.clients !== null && detail.clients.length > 0 && <section className="model-client-detail" aria-label="模型的客户端来源">
      <div className="detail-section-heading"><h3>客户端分布</h3><span>{detail.clients.length} 个客户端</span></div>
      <div className="model-client-rows">{detail.clients.sort((a, b) => b.tokens - a.tokens).map(client => <div key={client.client}>
        <span><BrandIcon name={client.client} size={24} />{clientName(client.client)}</span>
        <strong>{compact(client.tokens)}<small>词元</small></strong><span>{usd(client.costUsd)}</span>
      </div>)}</div>
    </section>}
    <section className="model-session-section" aria-label="模型相关会话">
      <div className="detail-section-heading"><h3>相关会话</h3><span>{sessions.length ? `${sessions.length} 条会话` : "仅保留汇总"}</span></div>
      {meta.availability === "partial" && <p className="detail-footnote">当前周期会话明细不完整，模型汇总仍包含全部已上报用量。</p>}
      {sessions.length ? <>
        <div className="model-session-list">{sessions.slice(0, shown).map(session => <SessionUsageCard key={session.id} session={session} modelId={model.id} generatedAt={activityReference} timeZone={data.timeZone} />)}</div>
        {sessions.length > shown && <button type="button" className="plain-button more-sessions" onClick={() => setShown(value => value + 10)}>再显示 {Math.min(10, sessions.length - shown)} 条会话 <ChevronDown size={15} /></button>}
      </> : <div className="session-detail-empty"><MessageSquareText size={22} aria-hidden="true" /><p>{period === "allTime" ? "累计视图未同步全部历史会话，切换到「今日」或「本月」可查看具体会话。" : meta.availability === "unavailable" ? "当前周期暂无会话明细。" : "未找到使用该模型的会话。"}</p></div>}
      <p className="local-detail-note">{LOCAL_DETAIL_NOTICE}</p>
    </section>
  </div>;
}
