import { API_ENDPOINTS, normalizeOverview, type DashboardData, type TrendPoint } from "./data";

type AuxOutcome = "fulfilled" | "rejected" | "skipped";

type AuxSettlement = {
  subscriptions: AuxOutcome;
  providers: AuxOutcome;
  history: AuxOutcome;
};

function retainMatchingHistory(next: TrendPoint[], previous: TrendPoint[]): {
  points: TrendPoint[];
  keptCost: boolean;
  keptComponents: boolean;
} {
  let keptCost = false;
  let keptComponents = false;
  const points = next.map((point) => {
    const prior = previous.find((row) => row.day === point.day);
    if (!prior || prior.totalTokens !== point.totalTokens) return point;
    const retainsCost = point.costUsd === null && prior.costUsd !== null;
    const retainsComponents = point.components === null && prior.components !== null;
    if (!retainsCost && !retainsComponents) return point;
    keptCost ||= retainsCost;
    keptComponents ||= retainsComponents;
    return {
      ...point,
      costUsd: retainsCost ? prior.costUsd : point.costUsd,
      components: retainsComponents ? prior.components : point.components,
      ...(retainsCost ? { costStale: true } : {}),
      ...(retainsComponents ? { componentsStale: true } : {}),
    };
  });
  return { points, keptCost, keptComponents };
}

function retainAuxiliary(
  next: DashboardData,
  previous?: DashboardData,
  settled?: AuxSettlement,
): DashboardData {
  if (!previous || previous.mode !== "live") return next;
  if (!settled) {
    const retained = retainMatchingHistory(next.trend, previous.trend);
    return {
      ...next,
      subscriptions: previous.subscriptions,
      subscriptionsUpdatedAt: previous.subscriptionsUpdatedAt,
      providers: previous.providers,
      trend: retained.points,
    };
  }
  let subscriptions = next.subscriptions;
  let subscriptionsUpdatedAt = next.subscriptionsUpdatedAt;
  let providers = next.providers;
  let trend = next.trend;
  const notices = [...next.notices];
  if (settled.subscriptions === "rejected") {
    subscriptions = previous.subscriptions;
    subscriptionsUpdatedAt = previous.subscriptionsUpdatedAt;
  }
  if (settled.providers === "rejected") providers = previous.providers;
  if (settled.history === "rejected") {
    const retained = retainMatchingHistory(next.trend, previous.trend);
    trend = retained.points;
    if (retained.keptCost)
      notices.push("部分日期费用暂时读不到，先沿用上次的费用。");
    if (retained.keptComponents)
      notices.push("部分日期缓存组成暂时读不到，先沿用上次的组成。");
  }
  return { ...next, subscriptions, subscriptionsUpdatedAt, providers, trend, notices };
}

function outcome(disabled: boolean, result: PromiseSettledResult<unknown>): AuxOutcome {
  if (disabled) return "skipped";
  return result.status === "fulfilled" ? "fulfilled" : "rejected";
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.name = "ApiError"; this.status = status; }
}
export const isAuthFailure = (error: unknown): boolean => error instanceof ApiError && (error.status === 401 || error.status === 403);

export async function requestJSON(path: string, token: string, signal?: AbortSignal): Promise<unknown> {
  // Avoid optional AbortSignal.any/timeout helpers and release timer/listener
  // after *body consumption*, not merely after response headers arrive.
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(signal?.reason);
  if (signal?.aborted) {
    abortFromCaller();
    throw controller.signal.reason;
  }
  signal?.addEventListener("abort", abortFromCaller, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException("Request timed out", "TimeoutError"));
  }, 15000);
  try {
    const response = await fetch(path, {
      headers: { Authorization: `Bearer ${token}` }, cache: "no-store", signal: controller.signal,
    });
    if (!response.ok) throw new ApiError(response.status,
      response.status === 401 || response.status === 403 ? "访问密钥不正确，或没有读取权限。" :
      response.status === 404 ? "服务尚未启用该数据接口。" : `暂时无法获取数据（${response.status}），请稍后重试。`);
    try {
      return await response.json();
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason;
      if (error instanceof SyntaxError)
        throw new Error("服务返回格式异常，请稍后重试。");
      throw error;
    }
  } catch (error) {
    if (timedOut) throw new Error("服务响应超时，请稍后重试。");
    if (controller.signal.aborted) throw controller.signal.reason;
    if (error instanceof TypeError) throw new Error("网络连接失败，请检查服务是否可用。");
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abortFromCaller);
  }
}

export async function loadOverview(token: string, signal?: AbortSignal): Promise<DashboardData> {
  return normalizeOverview(await requestJSON(API_ENDPOINTS.overview, token, signal));
}

export async function loadDashboard(
  token: string,
  signal?: AbortSignal,
  onOverview?: (data: DashboardData) => void,
  previous?: DashboardData,
): Promise<DashboardData> {
  const raw = await requestJSON(API_ENDPOINTS.overview, token, signal);
  const initial = retainAuxiliary(normalizeOverview(raw), previous);
  onOverview?.(initial);
  const features = initial.features;
  const requests = [
    features?.subscriptions === false ? Promise.resolve(undefined) : requestJSON(API_ENDPOINTS.subscriptions, token, signal),
    features?.provider_status === false ? Promise.resolve(undefined) : requestJSON(API_ENDPOINTS.providers, token, signal),
    features?.history_daily === false ? Promise.resolve(undefined) : requestJSON(`${API_ENDPOINTS.history}?limit=30`, token, signal),
  ];
  const [subs, providers, history] = await Promise.allSettled(requests);
  for (const result of [subs, providers, history]) {
    if (result.status === "rejected" && isAuthFailure(result.reason)) throw result.reason;
  }
  if (signal?.aborted) throw signal.reason;
  const data = normalizeOverview(raw, {
    subscriptions: subs.status === "fulfilled" ? subs.value : undefined,
    providers: providers.status === "fulfilled" ? providers.value : undefined,
    history: history.status === "fulfilled" ? history.value : undefined,
    complete: true,
  });
  if (subs.status === "rejected") data.notices.push("订阅信息暂时未能加载。");
  if (providers.status === "rejected") data.notices.push("提供商状态暂时未能加载。");
  if (history.status === "rejected") data.notices.push("每日费用明细暂时未能加载。");
  return retainAuxiliary(data, previous, {
    subscriptions: outcome(features?.subscriptions === false, subs),
    providers: outcome(features?.provider_status === false, providers),
    history: outcome(features?.history_daily === false, history),
  });
}
