/** Pure presentation facts from synchronized session accounting; no transcript reconstruction. */
import type { DashboardData, PeriodKey, Session, SessionPeriodDetails, ThroughputCounters } from "./data";

const counter = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

export const LOCAL_DETAIL_NOTICE = "逐次回复、提问正文和工具事件尚未同步，此处仅展示会话汇总。";

export function sessionsForPeriod(data: DashboardData, period: PeriodKey): Session[] {
  return data.sessionsByPeriod?.[period] ?? (period === "today" ? data.sessions : []);
}

export function sessionPeriodDetails(data: DashboardData, period: PeriodKey): SessionPeriodDetails {
  return data.sessionDetailsByPeriod?.[period] ?? {
    period, availability: period === "today" && data.sessions.length ? "available" : "unavailable",
    reason: period === "allTime" ? "not-synced" : period === "today" && data.sessions.length ? null : "not-reported",
    total: null, returned: sessionsForPeriod(data, period).length, omitted: null, dashboardOmitted: null,
    callDetailsAvailable: false, messageContentAvailable: false, toolEventsAvailable: false,
  };
}

/** Ratio of matching timed outputs and summed message durations; never wall-clock latency. */
export function outputTokensPerSecond(source: Pick<ThroughputCounters, "timedOutputTokens" | "timedDurationMs"> | Session): number | null {
  const output = "totalTokens" in source && source.zeroValuesUnconfirmed !== false && source.timedOutputTokens === 0 ? null : counter(source.timedOutputTokens);
  const duration = counter(source.timedDurationMs);
  return output !== null && duration !== null && duration > 0 ? output * 1000 / duration : null;
}

export function sessionUsageDetails(session: Session) {
  const observed = (value: unknown) => session.zeroValuesUnconfirmed !== false && value === 0 ? null : counter(value);
  const input = observed(session.inputTokens), output = observed(session.outputTokens);
  const cacheRead = observed(session.cacheReadTokens), cacheWrite = observed(session.cacheWriteTokens);
  const components = [input, output, cacheRead, cacheWrite];
  const componentTotal = components.every(value => value !== null) ? components.reduce<number>((sum, value) => sum + (value ?? 0), 0) : null;
  const complete = componentTotal !== null && componentTotal === session.totalTokens;
  const reasoning = observed(session.reasoningTokens);
  const contextTokens = observed(session.contextTokens), contextWindow = observed(session.contextWindow);
  const context = contextTokens !== null && contextWindow !== null && contextWindow > 0
    ? { tokens: contextTokens, window: contextWindow, percentUsed: contextTokens / contextWindow * 100 } : null;
  return {
    input, output, cacheRead, cacheWrite,
    reasoning: reasoning !== null && output !== null && reasoning <= output ? reasoning : null,
    componentTotal, complete,
    unclassified: componentTotal !== null && componentTotal <= session.totalTokens ? session.totalTokens - componentTotal : null,
    messageCount: observed(session.messageCount), context,
    hasUnconfirmedZeros: session.hasUnconfirmedZeros === true || session.zeroValuesUnconfirmed !== false && [
      session.inputTokens, session.outputTokens, session.cacheReadTokens, session.cacheWriteTokens,
      session.reasoningTokens, session.messageCount, session.costUsd, session.contextTokens,
      session.contextWindow, session.timedOutputTokens, session.timedDurationMs, session.unpricedTokens,
      ...Object.values(session.modelCosts ?? {}),
    ].some(value => value === 0),
    outputTokensPerSecond: outputTokensPerSecond(session),
    callDetailsAvailable: false, messageContentAvailable: false, toolEventsAvailable: false,
  };
}

/** A multi-model session's components and total must never be attributed wholesale to one model. */
export function sessionModelUsage(session: Session, modelId: string) {
  const tokens = counter(session.modelTokens?.[modelId]);
  const cost = session.modelCosts?.[modelId];
  return {
    tokens,
    costUsd: typeof cost === "number" && Number.isFinite(cost) && (cost !== 0 || session.zeroValuesUnconfirmed === false) ? cost : null,
    wholeSession: tokens !== null && tokens === session.totalTokens && Object.entries(session.modelTokens ?? {}).every(([id, amount]) => id === modelId || amount === 0),
  };
}
