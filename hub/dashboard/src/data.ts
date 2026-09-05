/**
 * Cloud Monitor preview data boundary.
 * All demo records are synthetic. The live adapter consumes the existing v2
 * /api/v1/tm/overview contract without changing aggregation or fetching secrets.
 */
export type PeriodKey = "today" | "month" | "allTime";
export const PERIOD_LABELS: Record<PeriodKey, string> = {
  today: "今日",
  month: "本月",
  allTime: "累计",
};
export const API_ENDPOINTS = {
  overview: "/api/v1/tm/overview",
  subscriptions: "/api/v1/tm/subscriptions",
  providers: "/api/v1/tm/provider-status",
  history: "/api/v1/tm/history/daily",
} as const;

export interface UsageComponents {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  unclassified: number;
  known: boolean;
  /** Arithmetic closure, independent of whether classification is partial. */
  complete: boolean;
  partial: boolean;
  inputKnown: boolean;
  outputKnown: boolean;
  cacheReadKnown: boolean;
  cacheWriteKnown: boolean;
  /** 0..1; null means unavailable. Label partial values as 已识别缓存占比. */
  cacheRate: number | null;
}

export interface UsageEntity {
  id: string;
  name: string;
  provider: string;
  color: string;
  totalTokens: number;
  costUsd: number | null;
  components: UsageComponents;
}

export interface PeriodUsage {
  totalTokens: number;
  costUsd: number | null;
  components: UsageComponents;
  models: UsageEntity[];
  clients: UsageEntity[];
  /** Absent when the source did not report a client × model matrix. */
  clientModels?: Record<string, Record<string, number>>;
  clientModelCosts?: Record<string, Record<string, number>>;
}

export interface TrendPoint {
  day: string;
  totalTokens: number;
  /** Raw total is exactly zero with no contradictory component counters. */
  zeroUsageConfirmed?: boolean;
  costUsd: number | null;
  models: Record<string, number>;
  /** Daily components only. Never borrow today's or a whole period's cache mix. */
  components: UsageComponents | null;
}

export interface TrendSummary {
  tokenTotal: number;
  hasCost: boolean;
  allCosts: boolean;
  costTotal: number | null;
  /** Days with valid cache data, including confirmed zero-usage days. */
  cacheDays: number;
  cacheSkippedDays: number;
  /** Denominator from the same days that contribute to cacheTotal. */
  cacheTokenTotal: number;
  cacheTotal: number | null;
  cacheRate: number | null;
  partialCache: boolean;
}

export interface Device {
  id: string;
  name: string;
  platform: string;
  version: string;
  osVersion?: string;
  runtime?: string;
  syncIntervalMs?: number | null;
  timeZone?: string;
  projectsEnabled?: boolean | null;
  historyAvailable?: boolean | null;
  clientHealth?: ClientHealth[];
  clientStatus?: string;
  wslStatus?: string;
  status: "online" | "delayed" | "offline";
  lastSeen: string | null;
  clients: string[];
  periods: Record<PeriodKey, { totalTokens: number; costUsd: number | null }>;
}

export interface ClientHealth {
  name: string;
  version: string;
  state: string;
  level: "ok" | "warning" | "error" | "unknown";
  observedAt: string | null;
}

export interface Quota {
  id: string;
  /** Preserve each official account entry even when display labels coincide. */
  groupId?: string;
  provider: string;
  name: string;
  plan: string;
  account: string;
  label: string;
  metric: string;
  usedPercent: number | null;
  used: number | null;
  remaining: number | null;
  limit: number | null;
  balanceUsd: number | null;
  balance?: number | null;
  sourceDevice?: string;
  resetsAt: string | null;
  currency?: string | null;
  showMeter?: boolean;
  sourceStatus?: string;
  stale?: boolean;
}

export interface Subscription {
  id: string;
  provider: string;
  name: string;
  kind: "subscription" | "topup";
  amount: number | null;
  currency: string;
  interval: string;
  intervalCount: number;
  autoRenew: boolean;
  renewsAt: string | null;
  startDate: string | null;
  topUpTotal: number | null;
  latestTopUpAt?: string | null;
  binding?: string;
  topUps?:
    | {
        id: string;
        label: string;
        date: string | null;
        amount: number | null;
      }[]
    | null;
  endDate?: string | null;
  note?: string;
}

export interface Session {
  id: string;
  name: string;
  project: string;
  client: string;
  deviceId: string;
  device: string;
  models: string[];
  totalTokens: number;
  costUsd: number | null;
  startedAt: string | null;
  lastUsedAt: string | null;
}

export interface Provider {
  id: string;
  name: string;
  status: "operational" | "degraded" | "maintenance" | "outage" | "unknown";
  description: string;
  checkedAt: string | null;
  stale: boolean;
  url: string | null;
}

export interface DashboardFeatures {
  trend_models?: boolean;
  activity_hourly?: boolean;
  subscriptions?: boolean;
  provider_status?: boolean;
  history_daily?: boolean;
  [name: string]: boolean | undefined;
}

export interface ActivityDeviceCoverage {
  deviceId: string;
  firstSampleAt: string | null;
  lastSampleAt: string | null;
  expectedBuckets: number | null;
  observedBuckets: number | null;
  gapCount: number | null;
  resetCount: number | null;
}

export interface ActivityCoverage {
  firstSampleAt: string | null;
  lastSampleAt: string | null;
  expectedBuckets: number | null;
  observedBuckets: number | null;
  coveragePercent: number | null;
  attributionMode: string | null;
  gapCount: number | null;
  resetCount: number | null;
  devices: ActivityDeviceCoverage[];
}

export interface ActivityMetadata {
  timeZone: string;
  today: string | null;
  month: string | null;
  hourlyDay: string | null;
  hourlyStatus: "ready" | "unavailable" | "date-mismatch" | "disabled";
  dailyBasis: string | null;
  dailyMixedBasis: boolean | null;
  archiveCutoverDay: string | null;
  coverage: ActivityCoverage | null;
}

export interface DashboardData {
  mode: "demo" | "live";
  generatedAt: string;
  timeZone: string;
  periods: Record<PeriodKey, PeriodUsage>;
  trend: TrendPoint[];
  activity: { day: string; totalTokens: number }[];
  hourly: { hour: number; totalTokens: number }[];
  /** Original backend capability flags; absent does not mean disabled. */
  features?: DashboardFeatures;
  /** Source dates and coverage stay separate from token totals. */
  activityMetadata?: ActivityMetadata;
  devices: Device[];
  quotas: Quota[];
  subscriptions: Subscription[];
  subscriptionsUpdatedAt?: string | null;
  sessions: Session[];
  providers: Provider[];
  notices: string[];
}

type JsonRecord = Record<string, unknown>;
const record = (value: unknown): JsonRecord =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
const isRecord = (value: unknown): value is JsonRecord =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const text = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback;
const validCounter = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
const count = (value: unknown): number => (validCounter(value) ? value : 0);
// Amounts and balances may legitimately be negative; token counters may not.
const optionalNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const optionalText = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

function maskedEmail(value: unknown): string {
  const email = text(value);
  const at = email.indexOf("@");
  return at > 0
    ? `${email.slice(0, Math.min(2, at))}***${email.slice(at)}`
    : email;
}

function displayBinding(value: unknown): string {
  if (typeof value === "string")
    return value.replace(/[^\s@]+@[^\s@]+/g, maskedEmail);
  const binding = record(value);
  const key = text(binding.accountKey);
  const shortKey = key
    ? `${key.slice(0, key.length > 6 ? 6 : Math.max(1, key.length - 1))}…`
    : "";
  return [
    text(binding.profileName),
    maskedEmail(binding.accountEmail),
    shortKey,
  ]
    .filter(Boolean)
    .join(" · ");
}

function diagnosticText(value: unknown): string {
  if (typeof value === "string") return value;
  return Object.entries(record(value))
    .slice(0, 4)
    .map(
      ([key, entry]) =>
        `${key}: ${typeof entry === "object" && entry !== null ? JSON.stringify(entry) : String(entry)}`,
    )
    .join(" · ");
}

function normalizeClientHealth(diagnostic: JsonRecord): ClientHealth[] {
  const health = diagnostic.clientHealth;
  const envelope = record(health);
  const entries: [string, unknown][] = Array.isArray(health)
    ? health.map((value) => [
        text(record(value).client) ||
          text(record(value).name) ||
          text(record(value).id),
        value,
      ])
    : Object.entries(
        isRecord(envelope.clients) ? envelope.clients : envelope,
      ).filter(
        ([name]) => !["version", "observedAt", "clients"].includes(name),
      );
  const levels: Record<string, ClientHealth["level"]> = {
    active: "ok",
    direct: "ok",
    detected: "ok",
    healthy: "ok",
    operational: "ok",
    ok: "ok",
    ready: "ok",
    normal: "ok",
    waiting: "warning",
    warning: "warning",
    stale: "warning",
    degraded: "warning",
    partial: "warning",
    "no-data": "warning",
    missing: "error",
    error: "error",
    failed: "error",
    unhealthy: "error",
    critical: "error",
    "not-running": "error",
    stopped: "error",
    crashed: "error",
  };
  return entries
    .filter(([name]) => name)
    .map(([name, value]) => {
      const item = record(value);
      const override = text(record(diagnostic.clientStatus)[name]);
      const state =
        override ||
        [
          item.status,
          item.health,
          item.state,
          record(item.collection).state,
          record(item.source).state,
          record(item.data).state,
        ]
          .map((entry) => text(entry).trim())
          .find(Boolean) ||
        (typeof value === "string"
          ? value
          : item.healthy === true
            ? "healthy"
            : item.healthy === false
              ? "unhealthy"
              : "unknown");
      return {
        name,
        version: text(item.version) || text(item.agentVersion) || text(item.v),
        state,
        level: levels[state.trim().toLowerCase()] || "unknown",
        observedAt:
          optionalText(item.observedAt) || optionalText(envelope.observedAt),
      };
    });
}
const periods: PeriodKey[] = ["today", "month", "allTime"];
const colors = [
  "#608ac5",
  "#338b87",
  "#c49462",
  "#9c85b4",
  "#7a9aaa",
  "#9aa5b2",
];

export function providerFor(name: string): string {
  if (/claude|anthropic|sonnet|opus|haiku/i.test(name)) return "anthropic";
  if (/codex|gpt|openai/i.test(name)) return "openai";
  if (/cursor/i.test(name)) return "cursor";
  if (/gemini|google/i.test(name)) return "google";
  if (/grok|xai/i.test(name)) return "xai";
  if (/deepseek/i.test(name)) return "deepseek";
  return "other";
}

export function providerName(provider: string): string {
  return (
    (
      {
        anthropic: "Anthropic",
        openai: "OpenAI",
        cursor: "Cursor",
        google: "Google",
        xai: "xAI",
        deepseek: "DeepSeek",
      } as Record<string, string>
    )[provider] || provider
  );
}

/** Mirrors the shipped cache-preservation contract, including legacy gaps. */
export function normalizeComponents(
  source: unknown,
  entityType?: "model" | "client",
  entityId?: string,
  options: { preserveExplicitCacheZero?: boolean } = {},
): UsageComponents {
  const period = record(source);
  const id = entityId || "";
  const base = entityType || "";
  const rawTotal = entityType
    ? record(period[base + "s"])[id]
    : period.totalTokens;
  const total = count(rawTotal);
  const capable = record(period.capabilities).tokenComponents === true ||
    (!entityType && period.tokenComponentsAvailable === true);
  const raw = entityType
    ? {
        output: record(period[base + "Outputs"])[id],
        cacheRead: record(period[base + "CacheReads"])[id],
        cacheWrite: record(period[base + "CacheWrites"])[id],
        unclassified: record(period[base + "UnclassifiedTokens"])[id],
      }
    : {
        output: period.outputTokens,
        cacheRead: period.cacheReadTokens,
        cacheWrite: period.cacheWriteTokens,
        unclassified: period.unclassifiedTokens,
      };
  const unknown: UsageComponents = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    unclassified: total,
    known: false,
    complete: false,
    partial: total > 0,
    inputKnown: false,
    outputKnown: false,
    cacheReadKnown: false,
    cacheWriteKnown: false,
    cacheRate: null,
  };
  // An explicit zero day has known counts, but its 0/0 rate is undefined.
  // Missing totals/components must not acquire that zero-day evidence.
  if (rawTotal === 0 && Object.values(raw).every((value) => value === 0)) {
    return {
      ...unknown,
      known: true,
      complete: true,
      partial: !entityType && period.componentsPartial === true,
      inputKnown: true,
      outputKnown: true,
      cacheReadKnown: true,
      cacheWriteKnown: true,
    };
  }
  if (total <= 0 || !Object.values(raw).some(validCounter)) return unknown;
  const coverageKnown = entityType
    ? isRecord(period[base + "UnclassifiedTokens"]) &&
      (raw.unclassified === undefined || validCounter(raw.unclassified))
    : validCounter(raw.unclassified);
  const output = count(raw.output);
  const cacheRead = count(raw.cacheRead);
  const cacheWrite = count(raw.cacheWrite);
  const classified = output + cacheRead + cacheWrite;
  const remainder = Math.max(0, total - classified);
  const canInferInput = capable || coverageKnown;
  const unclassified = canInferInput
    ? count(raw.unclassified)
    : Math.max(count(raw.unclassified), remainder);
  const input = canInferInput ? Math.max(0, remainder - unclassified) : 0;
  // Daily archives distinguish a recorded zero from legacy missing counters.
  // A proven cache zero remains useful even if all other usage is unclassified.
  // Period/entity defaults retain the stricter rule unless this is opted into.
  const explicitCacheZero = !entityType && options.preserveExplicitCacheZero === true &&
    raw.cacheRead === 0;
  if (classified + input <= 0 && !explicitCacheZero) return unknown;
  const complete =
    Math.abs(input + classified + unclassified - total) <=
    Math.max(1, total * 0.01);
  const partial = unclassified > 0 || !canInferInput || !complete ||
    (!entityType && period.componentsPartial === true);
  const outputKnown = validCounter(raw.output) || Boolean(
    entityType && !partial && isRecord(period[base + "Outputs"]) && raw.output === undefined,
  );
  // A positive remainder is an identified input count. With unknown components,
  // a zero remainder does not establish that the source had no uncached input.
  const inputKnown = canInferInput && (input > 0 || !partial);
  const cacheReadKnown =
    validCounter(raw.cacheRead) ||
    Boolean(
      entityType &&
      !partial &&
      isRecord(period[base + "CacheReads"]) &&
      raw.cacheRead === undefined,
    );
  const cacheWriteKnown =
    validCounter(raw.cacheWrite) ||
    Boolean(
      entityType &&
      !partial &&
      isRecord(period[base + "CacheWrites"]) &&
      raw.cacheWrite === undefined,
    );
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    unclassified,
    known: true,
    complete,
    partial,
    inputKnown,
    outputKnown,
    cacheReadKnown,
    cacheWriteKnown,
    cacheRate:
      cacheReadKnown && complete && cacheRead <= total
        ? cacheRead / total
        : null,
  };
}

/** Cache metrics skip missing or invalid days from both sums. Token and cost
 * totals retain the full range; cache coverage describes its smaller sample. */
export function summarizeTrend(series: readonly TrendPoint[]): TrendSummary {
  const tokenTotal = series.reduce((sum, point) => sum + point.totalTokens, 0);
  const hasCost = series.some(
    (point) => optionalNumber(point.costUsd) !== null,
  );
  const allCosts =
    series.length > 0 &&
    series.every((point) => optionalNumber(point.costUsd) !== null);
  const costTotal = hasCost
    ? optionalNumber(
        series.reduce(
          (sum, point) => sum + (optionalNumber(point.costUsd) ?? 0),
          0,
        ),
      )
    : null;
  const cacheSeries = series.filter((point) => {
    // A proven zero total contributes nothing even when legacy component
    // fields were not recorded. Keep that day's detail availability intact.
    if (point.totalTokens === 0 && point.zeroUsageConfirmed === true)
      return true;
    const parts = point.components;
    if (
      !validCounter(point.totalTokens) ||
      !parts?.known ||
      !parts.cacheReadKnown ||
      !parts.complete ||
      !validCounter(parts.cacheRead) ||
      parts.cacheRead > point.totalTokens
    )
      return false;
    if (point.totalTokens === 0)
      return [
        parts.input,
        parts.output,
        parts.cacheRead,
        parts.cacheWrite,
        parts.unclassified,
      ].every((value) => value === 0);
    // Daily validation can reject a ratio even when arithmetic closure is
    // within its tolerance. Do not bypass that decision for the range.
    return (
      parts.cacheRate !== null &&
      Number.isFinite(parts.cacheRate) &&
      parts.cacheRate >= 0 &&
      parts.cacheRate <= 1
    );
  });
  const cacheTokenTotal = cacheSeries.reduce(
    (sum, point) => sum + point.totalTokens,
    0,
  );
  const sum =
    cacheSeries.length > 0
      ? cacheSeries.reduce(
          (total, point) =>
            total + (point.totalTokens === 0 ? 0 : point.components!.cacheRead),
          0,
        )
      : null;
  const cacheTotal =
    sum !== null &&
    validCounter(sum) &&
    validCounter(cacheTokenTotal) &&
    sum <= cacheTokenTotal
      ? sum
      : null;
  return {
    tokenTotal,
    hasCost,
    allCosts,
    costTotal,
    cacheDays: cacheSeries.length,
    cacheSkippedDays: series.length - cacheSeries.length,
    cacheTokenTotal,
    cacheTotal,
    cacheRate:
      cacheTotal !== null && cacheTokenTotal > 0
        ? cacheTotal / cacheTokenTotal
        : null,
    partialCache: cacheSeries.some((point) => point.components?.partial),
  };
}

export function normalizePeriod(source: unknown): PeriodUsage {
  const period = record(source);
  const matrix = (
    value: unknown,
    money = false,
  ): Record<string, Record<string, number>> | undefined => {
    if (!isRecord(value)) return undefined;
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, row]) => isRecord(row))
        .map(([client, row]) => [
          client,
          Object.fromEntries(
            Object.entries(record(row))
              .filter(([, amount]) =>
                money ? optionalNumber(amount) !== null : validCounter(amount),
              )
              .map(([model, amount]) => [model, amount as number]),
          ),
        ]),
    );
  };
  const entities = (kind: "model" | "client"): UsageEntity[] =>
    Object.entries(record(period[kind + "s"]))
      .filter(([, value]) => validCounter(value) && value > 0)
      .map(([id, value], index) => ({
        id,
        name:
          kind === "client"
            ? (
                {
                  codex: "Codex",
                  claude: "Claude Code",
                  cursor: "Cursor",
                } as Record<string, string>
              )[id] || id
            : id,
        provider: providerFor(id),
        color: colors[index % colors.length],
        totalTokens: count(value),
        costUsd: optionalNumber(record(period[kind + "Costs"])[id]),
        components: normalizeComponents(period, kind, id),
      }))
      .sort((a, b) => b.totalTokens - a.totalTokens);
  return {
    totalTokens: count(period.totalTokens),
    costUsd: optionalNumber(period.costUsd),
    components: normalizeComponents(period),
    models: entities("model"),
    clients: entities("client"),
    clientModels: matrix(period.clientModels),
    clientModelCosts: matrix(period.clientModelCosts, true),
  };
}

export interface OverviewExtras {
  subscriptions?: unknown;
  providers?: unknown;
  /** Optional /history/daily page, whose device-local dates match overview.trend. */
  history?: unknown;
  /** Explicit reference time makes stale classification deterministic in tests. */
  now?: Date;
}

const sourceCounter = (value: unknown): number | null =>
  validCounter(value) ? value : null;
const sourceDate = (value: unknown): string | null => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return null;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
    ? value
    : null;
};
const sourceTimestamp = (value: unknown): string | null =>
  typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
const sourceDateKey = (value: unknown, timeZone: string): string | null => {
  const stamp = sourceTimestamp(value);
  if (!stamp) return null;
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(stamp));
  } catch {
    return null;
  }
};

function normalizeActivity(root: JsonRecord, features: DashboardFeatures) {
  const activity = record(root.activity);
  const dashboardPeriod = record(root.dashboard_period);
  const timeZone = text(activity.time_zone) || text(root.dashboard_time_zone, "UTC");
  const today =
    sourceDate(record(dashboardPeriod.today).key) ||
    sourceDateKey(root.generated_at, timeZone);
  const monthKey = text(record(dashboardPeriod.month).key);
  const month = sourceDate(`${monthKey}-01`) ? monthKey : today?.slice(0, 7) || null;
  const daily = new Map<string, number>();
  for (const value of list(activity.daily)) {
    const item = record(value);
    const day = sourceDate(item.day);
    if (day && validCounter(item.total)) daily.set(day, item.total);
  }

  const hourlyToday = record(activity.hourly_today);
  const expectedDay = today;
  const newDay = sourceDate(hourlyToday.day);
  const legacyDay = sourceDate(activity.hourly_day);
  let buckets: unknown[] = [];
  let hourlyDay: string | null = null;
  let hourlyStatus: ActivityMetadata["hourlyStatus"] = "unavailable";
  if (features.activity_hourly === false) {
    hourlyStatus = "disabled";
  } else if (
    Array.isArray(hourlyToday.buckets) &&
    newDay !== null && (!expectedDay || newDay === expectedDay)
  ) {
    buckets = hourlyToday.buckets;
    hourlyDay = newDay || today;
  } else if (
    Array.isArray(activity.hourly) &&
    (!expectedDay || activity.hourly_day == null || legacyDay === expectedDay)
  ) {
    buckets = activity.hourly;
    hourlyDay = legacyDay || today;
  } else if (Array.isArray(hourlyToday.buckets) || Array.isArray(activity.hourly)) {
    hourlyStatus = "date-mismatch";
  }
  const hourly = new Map<number, number>();
  for (const value of buckets) {
    const item = record(value);
    if (
      typeof item.hour === "number" && Number.isInteger(item.hour) &&
      item.hour >= 0 && item.hour < 24 && validCounter(item.total)
    ) hourly.set(item.hour, item.total);
  }
  if (hourly.size) hourlyStatus = "ready";

  const rawCoverage = record(activity.coverage);
  const percent = optionalNumber(rawCoverage.coverage_percent);
  const coverage: ActivityCoverage | null = isRecord(activity.coverage)
    ? {
        firstSampleAt: sourceTimestamp(rawCoverage.first_sample_at),
        lastSampleAt: sourceTimestamp(rawCoverage.last_sample_at),
        expectedBuckets: sourceCounter(rawCoverage.expected_buckets),
        observedBuckets: sourceCounter(rawCoverage.observed_buckets),
        coveragePercent: percent !== null && percent >= 0 && percent <= 100 ? percent : null,
        attributionMode: optionalText(rawCoverage.attribution_mode),
        gapCount: sourceCounter(rawCoverage.gap_count),
        resetCount: sourceCounter(rawCoverage.reset_count),
        devices: list(rawCoverage.devices).filter(isRecord).map((device) => ({
          deviceId: text(device.device_id),
          firstSampleAt: sourceTimestamp(device.first_sample_at),
          lastSampleAt: sourceTimestamp(device.last_sample_at),
          expectedBuckets: sourceCounter(device.expected_buckets),
          observedBuckets: sourceCounter(device.observed_buckets),
          gapCount: sourceCounter(device.gap_count),
          resetCount: sourceCounter(device.reset_count),
        })),
      }
    : null;
  const metadata: ActivityMetadata = {
    timeZone,
    today,
    month,
    hourlyDay,
    hourlyStatus,
    dailyBasis: optionalText(activity.daily_day_basis),
    dailyMixedBasis: typeof activity.daily_mixed_basis === "boolean"
      ? activity.daily_mixed_basis : null,
    archiveCutoverDay: sourceDate(activity.daily_archive_cutover_day),
    coverage,
  };
  return {
    activity: [...daily].sort(([a], [b]) => a.localeCompare(b))
      .map(([day, totalTokens]) => ({ day, totalTokens })),
    hourly: [...hourly].sort(([a], [b]) => a - b)
      .map(([hour, totalTokens]) => ({ hour, totalTokens })),
    metadata,
  };
}

/** Pass API JSON, never credentials. Missing auxiliary data remains unavailable. */
export function normalizeOverview(
  payload: unknown,
  extras: OverviewExtras = {},
): DashboardData {
  const root = record(payload);
  if (!isRecord(root.totals))
    throw new Error("服务器返回的用量格式无法识别，请检查服务版本。");
  const now = extras.now || new Date();
  const generatedAt = text(root.generated_at, now.toISOString());
  const features = Object.fromEntries(
    Object.entries(record(root.features)).filter(([, value]) => typeof value === "boolean"),
  ) as DashboardFeatures;
  const totals = record(root.totals);
  const normalizedPeriods = Object.fromEntries(
    periods.map((key) => [key, normalizePeriod(totals[key])]),
  ) as Record<PeriodKey, PeriodUsage>;
  const trendModels = new Map(
    list(root.trend_models).map((value) => {
      const item = record(value);
      return [text(item.day), record(item.models)];
    }),
  );
  const dailyHistory = new Map(
    list(record(extras.history).items).map((value) => {
      const item = record(value);
      return [text(item.day), item];
    }),
  );
  const trend = list(root.trend)
    .map((value) => {
      const item = record(value);
      const totalTokens = count(item.total);
      const archive = dailyHistory.get(text(item.day));
      // Do not combine two different snapshots of the same day. The auxiliary
      // request may land after a new upload and must not alter overview totals.
      const matchingArchive =
        archive &&
        validCounter(item.total) &&
        validCounter(archive.tokens) &&
        archive.tokens === totalTokens
          ? archive
          : {};
      const models = Object.fromEntries(
        Object.entries(
          trendModels.get(text(item.day)) || record(matchingArchive.perModel),
        ).filter(([, amount]) => validCounter(amount)),
      ) as Record<string, number>;
      const daily: JsonRecord = { ...matchingArchive, ...item, totalTokens: item.total };
      const dailyCounters = [
        daily.outputTokens,
        daily.cacheReadTokens,
        daily.cacheWriteTokens,
        daily.unclassifiedTokens,
      ];
      const hasDailyComponents = dailyCounters.some(validCounter);
      // Reject explicit malformed counters before normalization can replace
      // them with zeros. Absent counters still allow recognized partial data.
      const validDailyComponents = dailyCounters.every(
        (value) => value === null || value === undefined || validCounter(value),
      );
      return {
        day: text(item.day),
        totalTokens,
        // count() also maps invalid/missing totals to zero, so retain evidence
        // from the source before normalization can erase the distinction.
        zeroUsageConfirmed: item.total === 0 && dailyCounters.every(
          (value) => value === 0 || value === null || value === undefined,
        ),
        costUsd:
          optionalNumber(item.costUsd) ??
          optionalNumber(matchingArchive.costUsd),
        models,
        components: hasDailyComponents && validDailyComponents
          ? normalizeComponents(daily, undefined, undefined, { preserveExplicitCacheZero: true })
          : null,
      };
    })
    .filter((point) => point.day)
    .sort((a, b) => a.day.localeCompare(b.day));
  const devices: Device[] = list(root.devices).map((value, index) => {
    const item = record(value);
    const diagnostic = record(
      list(root.diagnostics).find(
        (entry) => record(entry).deviceId === item.deviceId,
      ),
    );
    const lastSeen =
      optionalText(item.receivedAt) || optionalText(item.updatedAt);
    const parsed = lastSeen ? Date.parse(lastSeen) : NaN;
    const age = validCounter(item.ageMs)
      ? item.ageMs
      : Number.isFinite(parsed)
        ? Math.max(0, now.getTime() - parsed)
        : Infinity;
    const staleAfter = count(root.staleAfterMs) || 600_000;
    // Official stale already incorporates each device's upload interval.
    // In particular, a 30-minute uploader can remain fresh for 60 minutes.
    const uploadInterval = [600_000, 1_200_000, 1_800_000].includes(
      count(item.syncUploadIntervalMs),
    )
      ? count(item.syncUploadIntervalMs)
      : 0;
    const deviceStaleAfter = Math.max(staleAfter, uploadInterval * 2);
    const status: Device["status"] =
      typeof item.stale === "boolean"
        ? item.stale
          ? "offline"
          : "online"
        : age > Math.max(3_600_000, deviceStaleAfter)
          ? "offline"
          : age > deviceStaleAfter
            ? "delayed"
            : "online";
    return {
      id: text(item.deviceId, `device-${index}`),
      name: text(item.hostname, "未命名设备"),
      platform:
        text(item.osName) ||
        (
          { darwin: "macOS", win32: "Windows", linux: "Linux" } as Record<
            string,
            string
          >
        )[text(item.platform)] ||
        text(item.platform, "未知系统"),
      version: text(item.agentVersion, "未知版本"),
      osVersion: text(item.osVersion),
      runtime: text(item.agentRuntime),
      syncIntervalMs: optionalNumber(item.syncUploadIntervalMs),
      timeZone: text(
        record(record(root.period_windows_by_device)[text(item.deviceId)])
          .timeZone,
      ),
      projectsEnabled:
        typeof item.projectsEnabled === "boolean" ? item.projectsEnabled : null,
      historyAvailable:
        typeof item.historyAvailable === "boolean"
          ? item.historyAvailable
          : null,
      clientHealth: normalizeClientHealth(diagnostic),
      clientStatus: diagnosticText(diagnostic.clientStatus),
      wslStatus: diagnosticText(diagnostic.wslStatus),
      status,
      lastSeen,
      clients: list(item.trackedClients).filter(
        (entry): entry is string => typeof entry === "string",
      ),
      periods: Object.fromEntries(
        periods.map((key) => {
          const p = record(item[key]);
          return [
            key,
            {
              totalTokens: count(p.totalTokens),
              costUsd: optionalNumber(p.costUsd),
            },
          ];
        }),
      ) as Device["periods"],
    };
  });
  const quotas = list(root.limits).flatMap((value, index) => {
    const item = record(value);
    const balanceObject = record(item.balance);
    const balance =
      optionalNumber(item.balance) ??
      optionalNumber(balanceObject.remaining) ??
      optionalNumber(balanceObject.total) ??
      optionalNumber(balanceObject.value) ??
      optionalNumber(balanceObject.amount);
    const windows = [...list(item.windows)];
    if (
      !windows.length &&
      (optionalNumber(item.balanceUsd) !== null || balance !== null)
    )
      windows.push({ label: "账户余额", metric: "balance" });
    // An unavailable or unauthorized provider is still a connected source,
    // not an absent account. Retain a visibly unknown quota row.
    if (!windows.length) windows.push({ label: "使用额度", showMeter: false });
    return windows.map((window, wi): Quota => {
      const w = record(window);
      return {
        id: `${index}-${wi}`,
        groupId: `quota-account-${index}`,
        provider: text(item.provider, "other"),
        name: providerName(text(item.provider, "other")),
        plan: text(item.planLabel),
        account: [
          ...new Set(
            [
              text(item.accountLabel),
              text(item.accountName),
              maskedEmail(item.accountEmail),
            ].filter(Boolean),
          ),
        ].join(" · "),
        label:
          text(w.label) ||
          text(w.name) ||
          text(w.window) ||
          text(w.kind, "使用额度"),
        metric: text(w.metric, "percentage"),
        usedPercent: validCounter(w.usedPercent)
          ? Math.min(100, w.usedPercent)
          : null,
        used: optionalNumber(w.used),
        remaining: optionalNumber(w.remaining),
        limit: optionalNumber(w.limit),
        balanceUsd: optionalNumber(item.balanceUsd),
        balance,
        sourceDevice:
          text(item.device) ||
          devices.find((device) => device.id === text(item.sourceDeviceId))
            ?.name ||
          "",
        resetsAt: optionalText(w.resetsAt),
        currency:
          optionalText(w.currency) || (w.metric === "spend" ? "USD" : null),
        showMeter: w.showMeter !== false,
        sourceStatus: text(item.status, "unknown"),
        stale: item.stale === true,
      };
    });
  });
  const subscriptions: Subscription[] = list(
    record(extras.subscriptions).subscriptions,
  ).map((value, index) => {
    const item = record(value);
    const topUps = list(item.topUps);
    const dates = topUps
      .map(
        (top) =>
          optionalText(record(top).date) ||
          optionalText(record(top).at) ||
          optionalText(record(top).createdAt),
      )
      .filter((date): date is string => date !== null)
      .sort();
    return {
      id: text(item.id, `subscription-${index}`),
      provider: text(item.provider, "other"),
      name: text(item.planName, "未命名订阅"),
      kind: item.kind === "topup" ? "topup" : "subscription",
      amount: validCounter(item.amountMinor) ? item.amountMinor / 100 : null,
      currency: text(item.currency, "USD"),
      interval: text(item.interval, "month"),
      intervalCount: count(item.intervalCount) || 1,
      autoRenew: item.autoRenew !== false,
      renewsAt: optionalText(item.nextRenewalOverride),
      startDate: optionalText(item.startDate),
      topUpTotal:
        Array.isArray(item.topUps) &&
        topUps.every((top) => validCounter(record(top).amountMinor))
          ? topUps.reduce<number>(
              (sum, top) => sum + count(record(top).amountMinor),
              0,
            ) / 100
          : null,
      latestTopUpAt: dates.at(-1) || null,
      binding: displayBinding(item.binding),
      topUps: Array.isArray(item.topUps)
        ? topUps.map((top, topIndex) => {
            const entry = record(top);
            return {
              id: text(entry.id, `topup-${topIndex}`),
              label:
                text(entry.label) ||
                text(entry.name) ||
                text(entry.title) ||
                (item.kind === "topup" ? "充值" : "加购"),
              date:
                optionalText(entry.date) ||
                optionalText(entry.at) ||
                optionalText(entry.createdAt),
              amount: validCounter(entry.amountMinor)
                ? entry.amountMinor / 100
                : null,
            };
          })
        : null,
      endDate: optionalText(item.endDate),
      note: text(item.note),
    };
  });
  const sessions: Session[] = list(root.sessions).map((value, index) => {
    const item = record(value);
    const deviceId = text(item.deviceId);
    const client = text(item.client);
    const stableId =
      text(item.key) ||
      `${deviceId}:${client}:${text(item.sessionId, String(index))}`;
    return {
      id: stableId,
      name:
        text(item.title) ||
        text(item.project) ||
        text(item.sessionId, "未命名会话"),
      project: text(item.project, "未归属项目"),
      client,
      deviceId,
      device:
        text(item.device) ||
        devices.find((device) => device.id === deviceId)?.name ||
        "未知设备",
      models: Object.keys(record(item.models)),
      totalTokens: count(item.tokens),
      costUsd: optionalNumber(item.costUsd),
      startedAt: optionalText(item.startedAt),
      lastUsedAt: optionalText(item.lastUsedAt),
    };
  });
  const providers: Provider[] = list(record(extras.providers).providers).map(
    (value) => {
      const item = record(value);
      const status = [
        "operational",
        "degraded",
        "maintenance",
        "outage",
      ].includes(text(item.status))
        ? (text(item.status) as Provider["status"])
        : "unknown";
      return {
        id: text(item.provider),
        name: text(item.name) || providerName(text(item.provider)),
        status,
        description: text(item.description),
        checkedAt: optionalText(item.checked_at),
        stale: item.stale === true,
        url: optionalText(item.url),
      };
    },
  );
  const activityData = normalizeActivity(root, features);
  const notices: string[] = [];
  if (root.partial === true)
    notices.push("部分辅助数据暂不可用，用量总计仍来自设备上报。");
  if (root.snapshot_degraded === true)
    notices.push("历史快照同步延迟，趋势可能尚未更新。");
  if (validCounter(root.pending_outbox) && root.pending_outbox > 0)
    notices.push(`还有 ${root.pending_outbox.toLocaleString("zh-CN")} 条快照等待同步，历史记录可能尚未更新。`);
  if (root.stale === true || root.stale_data === true)
    notices.push("当前显示的是上一次数据，可能已经过期。");
  if (normalizedPeriods.today.components.partial)
    notices.push("已保留可识别的缓存与输出，其余用量列为未分类。");
  if (
    normalizedPeriods.today.components.known &&
    !normalizedPeriods.today.components.complete
  )
    notices.push("今日组件合计与总量不一致，缓存占比暂不显示。");
  if (
    record(root.sessions_meta).session_details_incomplete === true ||
    root.sessions_omitted === true
  )
    notices.push("当前快照未包含全部会话详情，不能用会话列表反推全部用量。");
  for (const item of list(root.limits).map(record)) {
    if (item.stale === true)
      notices.push(
        `${providerName(text(item.provider))} 额度尚未刷新，保留上一次上报。`,
      );
    else if (typeof item.status === "string" && item.status !== "ok")
      notices.push(`${providerName(text(item.provider))} 额度来源暂不可用。`);
  }
  for (const provider of providers) {
    if (provider.stale)
      notices.push(`${provider.name} 服务状态尚未刷新，正在显示上一次查询结果。`);
  }
  if (extras.subscriptions === undefined && features.subscriptions !== false)
    notices.push("未载入订阅清单。");
  if (extras.providers === undefined && features.provider_status !== false)
    notices.push("未载入服务商状态。");
  return {
    mode: "live",
    generatedAt,
    timeZone: text(root.dashboard_time_zone, "UTC"),
    periods: normalizedPeriods,
    trend,
    devices,
    quotas,
    subscriptions,
    subscriptionsUpdatedAt: optionalText(
      record(extras.subscriptions).updated_at,
    ),
    sessions,
    providers,
    notices,
    features,
    activity: activityData.activity,
    hourly: activityData.hourly,
    activityMetadata: activityData.metadata,
  };
}

const DAY = 86_400_000;
const DEMO_TIME_ZONE = "Asia/Tokyo";
const dayKey = (date: Date): string =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: DEMO_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
const cents = (value: number): number => Math.round(value * 100) / 100;
const DEMO_MODELS = [
  {
    id: "gpt-6-astra",
    client: "codex",
    weight: 0.52,
    read: 0.94,
    write: 0,
    output: 0.012,
    unknown: 0,
    rate: 0.65,
    color: "#608ac5",
  },
  {
    id: "claude-sonnet-4-6",
    client: "claude",
    weight: 0.24,
    read: 0.76,
    write: 0.055,
    output: 0.035,
    unknown: 0,
    rate: 1.25,
    color: "#338b87",
  },
  {
    id: "claude-opus-4-6",
    client: "claude",
    weight: 0.13,
    read: 0.72,
    write: 0.07,
    output: 0.05,
    unknown: 0,
    rate: 3.15,
    color: "#9c85b4",
  },
  {
    id: "gemini-2.5-flash",
    client: "cursor",
    weight: 0.07,
    read: 0,
    write: 0,
    output: 0,
    unknown: 1,
    rate: 0.38,
    color: "#c49462",
  },
  {
    id: "grok-bot-default",
    client: "cursor",
    weight: 0.04,
    read: 0,
    write: 0,
    output: 0,
    unknown: 1,
    rate: 1.08,
    color: "#7a9aaa",
  },
];

function demoPeriod(total: number): PeriodUsage {
  const raw: JsonRecord = {
    totalTokens: total,
    costUsd: 0,
    capabilities: { tokenComponents: false },
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    unclassifiedTokens: 0,
    clientModels: {},
    clientModelCosts: {},
  };
  for (const kind of ["model", "client"])
    for (const suffix of [
      "s",
      "Costs",
      "Outputs",
      "CacheReads",
      "CacheWrites",
      "UnclassifiedTokens",
    ])
      raw[kind + suffix] = {};
  let remainder = total;
  DEMO_MODELS.forEach((model, index) => {
    const tokens =
      index === DEMO_MODELS.length - 1
        ? remainder
        : Math.round(total * model.weight);
    remainder -= tokens;
    const cost = cents((tokens / 1_000_000) * model.rate);
    for (const [key, value] of [
      ["clientModels", tokens],
      ["clientModelCosts", cost],
    ] as const) {
      const rows = record(raw[key]);
      if (!isRecord(rows[model.client])) rows[model.client] = {};
      record(rows[model.client])[model.id] = value;
    }
    const values = {
      s: tokens,
      Costs: cost,
      Outputs: Math.round(tokens * model.output),
      CacheReads: Math.round(tokens * model.read),
      CacheWrites: Math.round(tokens * model.write),
      UnclassifiedTokens: Math.round(tokens * model.unknown),
    };
    for (const [suffix, value] of Object.entries(values)) {
      record(raw["model" + suffix])[model.id] = value;
      const clients = record(raw["client" + suffix]);
      clients[model.client] =
        suffix === "Costs"
          ? cents(count(clients[model.client]) + value)
          : count(clients[model.client]) + value;
    }
    raw.costUsd = cents(count(raw.costUsd) + cost);
    for (const [target, suffix] of [
      ["outputTokens", "Outputs"],
      ["cacheReadTokens", "CacheReads"],
      ["cacheWriteTokens", "CacheWrites"],
      ["unclassifiedTokens", "UnclassifiedTokens"],
    ])
      raw[target] = count(raw[target]) + values[suffix as keyof typeof values];
  });
  const normalized = normalizePeriod(raw);
  normalized.models.forEach((model) => {
    model.color = DEMO_MODELS.find((item) => item.id === model.id)!.color;
  });
  return normalized;
}

function sumDemoPeriods(items: PeriodUsage[]): PeriodUsage {
  const sum = demoPeriod(0);
  sum.costUsd = 0;
  const mergeEntities = (key: "models" | "clients") => {
    const merged = new Map<string, UsageEntity>();
    for (const period of items)
      for (const entity of period[key]) {
        const existing = merged.get(entity.id);
        if (!existing) merged.set(entity.id, structuredClone(entity));
        else {
          existing.totalTokens += entity.totalTokens;
          existing.costUsd = cents(
            (existing.costUsd || 0) + (entity.costUsd || 0),
          );
          for (const component of [
            "input",
            "output",
            "cacheRead",
            "cacheWrite",
            "unclassified",
          ] as const)
            existing.components[component] += entity.components[component];
          existing.components.cacheRate = existing.components.cacheReadKnown
            ? existing.components.cacheRead / existing.totalTokens
            : null;
        }
      }
    return [...merged.values()].sort((a, b) => b.totalTokens - a.totalTokens);
  };
  sum.models = mergeEntities("models");
  sum.clients = mergeEntities("clients");
  for (const key of ["clientModels", "clientModelCosts"] as const) {
    const merged: Record<string, Record<string, number>> = {};
    for (const period of items)
      for (const [client, row] of Object.entries(period[key] || {})) {
        merged[client] ||= {};
        for (const [model, amount] of Object.entries(row)) {
          const value = (merged[client][model] || 0) + amount;
          merged[client][model] =
            key === "clientModelCosts" ? cents(value) : value;
        }
      }
    sum[key] = merged;
  }
  sum.totalTokens = items.reduce((total, item) => total + item.totalTokens, 0);
  sum.costUsd = cents(
    items.reduce((total, item) => total + (item.costUsd || 0), 0),
  );
  for (const key of [
    "input",
    "output",
    "cacheRead",
    "cacheWrite",
    "unclassified",
  ] as const)
    sum.components[key] = items.reduce(
      (total, item) => total + item.components[key],
      0,
    );
  sum.components.known = sum.totalTokens > 0;
  sum.components.complete = true;
  sum.components.partial = sum.components.unclassified > 0;
  sum.components.cacheReadKnown = true;
  sum.components.cacheWriteKnown = true;
  sum.components.cacheRate =
    sum.totalTokens > 0 ? sum.components.cacheRead / sum.totalTokens : null;
  return sum;
}

/** Deterministic, anonymous sample; dates follow the dashboard's Tokyo day. */
export function createDemoData(now = new Date()): DashboardData {
  const today = dayKey(now);
  const history = Array.from({ length: 90 }, (_, index) => {
    const offset = 89 - index;
    const day = dayKey(new Date(now.getTime() - offset * DAY));
    const weekend = [0, 6].includes(new Date(day + "T12:00:00Z").getUTCDay());
    const weight =
      0.52 +
      index / 150 +
      Math.sin(index * 1.17) * 0.14 +
      Math.sin(index * 0.31) * 0.2;
    const tokens =
      offset === 0
        ? 74_369_365
        : Math.round(66_000_000 * weight * (weekend ? 0.63 : 1));
    return { day, period: demoPeriod(tokens) };
  });
  const todayPeriod = history[history.length - 1].period;
  const month = sumDemoPeriods(
    history
      .filter((item) => item.day.slice(0, 7) === today.slice(0, 7))
      .map((item) => item.period),
  );
  const allTime = sumDemoPeriods(history.map((item) => item.period));
  const allPeriods = { today: todayPeriod, month, allTime };
  const deviceDefinitions = [
    {
      id: "demo-mac",
      name: "MacBook Pro",
      platform: "macOS",
      version: "0.54.0",
      status: "online" as const,
      age: 28_000,
      clients: ["Codex", "Claude Code", "Cursor"],
      share: 0.73,
    },
    {
      id: "demo-workstation",
      name: "Studio workstation",
      platform: "Windows 11",
      version: "0.54.0",
      status: "online" as const,
      age: 142_000,
      clients: ["Codex", "Claude Code"],
      share: 0.24,
    },
    {
      id: "demo-linux",
      name: "Build server",
      platform: "Ubuntu",
      version: "0.53.2",
      status: "offline" as const,
      age: 9_660_000,
      clients: ["Codex"],
      share: 0.03,
    },
  ];
  const remaining = structuredClone(allPeriods);
  const devices: Device[] = deviceDefinitions.map((device, index) => ({
    id: device.id,
    name: device.name,
    platform: device.platform,
    version: device.version,
    osVersion: ["15.5", "24H2", "24.04 LTS"][index],
    runtime: index === 2 ? "service" : "desktop",
    syncIntervalMs: index === 2 ? 600_000 : 300_000,
    timeZone: DEMO_TIME_ZONE,
    projectsEnabled: index !== 2,
    historyAvailable: true,
    clientHealth: device.clients.map((name) => ({
      name,
      version:
        name === "Codex"
          ? "0.88.0"
          : name === "Claude Code"
            ? "2.1.1"
            : "1.5.3",
      state: index === 2 ? "stale" : "healthy",
      level: index === 2 ? ("warning" as const) : ("ok" as const),
      observedAt: new Date(now.getTime() - device.age).toISOString(),
    })),
    wslStatus: index === 1 ? "正常运行 · Ubuntu 24.04" : "",
    status: device.status,
    lastSeen: new Date(now.getTime() - device.age).toISOString(),
    clients: device.clients,
    periods: Object.fromEntries(
      periods.map((key) => {
        const totalTokens =
          index === 2
            ? remaining[key].totalTokens
            : Math.round(allPeriods[key].totalTokens * device.share);
        const costUsd =
          index === 2
            ? cents(remaining[key].costUsd || 0)
            : cents((allPeriods[key].costUsd || 0) * device.share);
        remaining[key].totalTokens -= totalTokens;
        remaining[key].costUsd = cents((remaining[key].costUsd || 0) - costUsd);
        return [key, { totalTokens, costUsd }];
      }),
    ) as Device["periods"],
  }));
  const relative = (ms: number) => new Date(now.getTime() + ms).toISOString();
  const quota = (
    id: string,
    provider: string,
    plan: string,
    label: string,
    usedPercent: number,
    resetsIn: number,
  ): Quota => ({
    id,
    groupId: `demo-account-${provider}`,
    provider,
    name: providerName(provider),
    plan,
    account: "示例个人账户 · de***@example.invalid",
    sourceDevice: provider === "cursor" ? "Studio workstation" : "MacBook Pro",
    label,
    metric: "percentage",
    usedPercent,
    used: null,
    remaining: null,
    limit: null,
    balanceUsd: null,
    resetsAt: relative(resetsIn),
    sourceStatus: "ok",
    stale: false,
    showMeter: true,
  });
  const sessionNames = [
    "重构工作区导航",
    "梳理缓存与用量组成",
    "设备同步检查",
    "优化移动端布局",
    "整理组件规范",
    "回归测试与问题修复",
    "趋势图交互",
    "改进异常提示",
  ];
  const sessions: Session[] = sessionNames.map((name, index) => {
    const model = DEMO_MODELS[index % 3];
    const totalTokens = [
      2_810_400, 1_642_820, 961_730, 824_510, 633_440, 451_680, 328_920,
      217_550,
    ][index];
    return {
      id: `demo-session-${index}`,
      name,
      project: ["Cloud Monitor", "Workspace", "Design system"][index % 3],
      client: model.client,
      deviceId: devices[index % 2].id,
      device: devices[index % 2].name,
      models: [model.id],
      totalTokens,
      costUsd: cents((totalTokens / 1_000_000) * model.rate),
      startedAt: relative(-(index * 39 + 45) * 60_000),
      lastUsedAt: relative(-(index * 39 + 3) * 60_000),
    };
  });
  const tokyoHour = Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: DEMO_TIME_ZONE,
      hour: "2-digit",
      hourCycle: "h23",
    }).format(now),
  );
  const hourlyWeights = Array.from({ length: 24 }, (_, hour) =>
    hour <= tokyoHour ? 1 + Math.pow(Math.sin((hour + 1) * 0.47), 2) * 3 : 0,
  );
  const weightTotal = hourlyWeights.reduce((sum, weight) => sum + weight, 0);
  let hourlyRemaining = todayPeriod.totalTokens;
  const hourly = hourlyWeights.map((weight, hour) => {
    const totalTokens =
      hour === tokyoHour
        ? hourlyRemaining
        : Math.round((todayPeriod.totalTokens * weight) / weightTotal);
    hourlyRemaining -= totalTokens;
    return { hour, totalTokens };
  });
  return {
    mode: "demo",
    generatedAt: now.toISOString(),
    timeZone: DEMO_TIME_ZONE,
    features: {
      trend_models: true,
      activity_hourly: true,
      subscriptions: true,
      provider_status: true,
      history_daily: true,
    },
    activityMetadata: {
      timeZone: DEMO_TIME_ZONE,
      today,
      month: today.slice(0, 7),
      hourlyDay: today,
      hourlyStatus: "ready",
      dailyBasis: "dashboard-time-zone",
      dailyMixedBasis: false,
      archiveCutoverDay: null,
      coverage: null,
    },
    periods: allPeriods,
    devices,
    sessions,
    trend: history.slice(-30).map(({ day, period }) => ({
      day,
      totalTokens: period.totalTokens,
      costUsd: period.costUsd,
      components: { ...period.components },
      models: Object.fromEntries(
        period.models.map((model) => [model.id, model.totalTokens]),
      ),
    })),
    activity: history.map(({ day, period }) => ({
      day,
      totalTokens: period.totalTokens,
    })),
    hourly,
    quotas: [
      quota(
        "codex-session",
        "openai",
        "Codex Pro",
        "5 小时窗口",
        38,
        132 * 60_000,
      ),
      quota("codex-week", "openai", "Codex Pro", "7 天窗口", 61, 4 * DAY),
      quota(
        "claude-session",
        "anthropic",
        "Claude Max",
        "5 小时窗口",
        27,
        194 * 60_000,
      ),
      quota("claude-week", "anthropic", "Claude Max", "7 天窗口", 62, 3 * DAY),
      {
        ...quota(
          "cursor-month",
          "cursor",
          "Cursor Pro",
          "月度额度",
          24,
          19 * DAY,
        ),
        balanceUsd: 30.84,
      },
      {
        ...quota(
          "cursor-extra",
          "cursor",
          "Cursor Pro",
          "按量支出",
          0,
          19 * DAY,
        ),
        balanceUsd: 30.84,
        metric: "spend",
        usedPercent: null,
        used: 6.4,
        limit: 50,
        currency: "USD",
        showMeter: false,
      },
    ],
    subscriptionsUpdatedAt: now.toISOString(),
    subscriptions: [
      {
        id: "demo-sub-codex",
        provider: "openai",
        name: "Codex Pro",
        kind: "subscription",
        amount: 200,
        currency: "USD",
        interval: "month",
        intervalCount: 1,
        autoRenew: true,
        renewsAt: relative(14 * DAY).slice(0, 10),
        startDate: relative(-76 * DAY).slice(0, 10),
        binding: "示例个人账户 · de***@example.invalid · demo-a…",
        topUps: [
          {
            id: "demo-codex-top-1",
            label: "额外额度",
            date: relative(-18 * DAY).slice(0, 10),
            amount: 20,
          },
          {
            id: "demo-codex-top-2",
            label: "补充额度",
            date: relative(-5 * DAY).slice(0, 10),
            amount: 15,
          },
        ],
        latestTopUpAt: relative(-5 * DAY).slice(0, 10),
        topUpTotal: 35,
      },
      {
        id: "demo-sub-claude",
        provider: "anthropic",
        name: "Claude Max",
        kind: "subscription",
        amount: 100,
        currency: "USD",
        interval: "month",
        intervalCount: 1,
        autoRenew: true,
        renewsAt: relative(8 * DAY).slice(0, 10),
        startDate: relative(-82 * DAY).slice(0, 10),
        binding: "示例工作账户 · wo***@example.invalid · demo-b…",
        topUps: [],
        topUpTotal: 0,
      },
      {
        id: "demo-sub-cursor",
        provider: "cursor",
        name: "Cursor Pro",
        kind: "subscription",
        amount: 20,
        currency: "USD",
        interval: "month",
        intervalCount: 1,
        autoRenew: true,
        renewsAt: relative(19 * DAY).slice(0, 10),
        startDate: relative(-71 * DAY).slice(0, 10),
        binding: "示例开发账户 · co***@example.invalid · demo-c…",
        topUps: [
          {
            id: "demo-cursor-top-1",
            label: "按量额度",
            date: relative(-9 * DAY).slice(0, 10),
            amount: 10,
          },
        ],
        latestTopUpAt: relative(-9 * DAY).slice(0, 10),
        topUpTotal: 10,
      },
    ],
    providers: ["openai", "anthropic", "cursor"].map((id) => ({
      id,
      name: providerName(id),
      status: "operational",
      description: "所有系统运行正常 · 示例状态",
      checkedAt: now.toISOString(),
      stale: false,
      url: null,
    })),
    notices: [
      "当前为本地设计预览，所有用量、订阅价格和服务状态均为虚构示例。",
      "Cursor 示例用量仅提供总量，已知模型缓存仍保留，未分类用量单独列出。",
    ],
  };
}

export const dashboardData = createDemoData();
