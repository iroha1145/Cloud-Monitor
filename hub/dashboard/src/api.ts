import { API_ENDPOINTS, normalizeOverview, type DashboardData } from "./data";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.name = "ApiError"; this.status = status; }
}
export const isAuthFailure = (error: unknown): boolean => error instanceof ApiError && (error.status === 401 || error.status === 403);

export async function requestJSON(path: string, token: string, signal?: AbortSignal): Promise<unknown> {
  const deadline = AbortSignal.timeout(15000);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let response: Response;
  try {
    response = await fetch(path, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store", signal: combined });
  } catch (error) {
    if (combined.reason?.name === "TimeoutError") throw new Error("服务响应超时，请稍后重试。");
    if (error instanceof TypeError) throw new Error("网络连接失败，请检查服务是否可用。");
    throw error;
  }
  if (!response.ok) throw new ApiError(response.status,
    response.status === 401 || response.status === 403 ? "访问密钥不正确，或没有读取权限。" :
    response.status === 404 ? "服务尚未启用该数据接口。" : `暂时无法获取数据（${response.status}），请稍后重试。`);
  return response.json();
}

export async function loadOverview(token: string, signal?: AbortSignal): Promise<DashboardData> {
  return normalizeOverview(await requestJSON(API_ENDPOINTS.overview, token, signal));
}

export async function loadDashboard(token: string, signal?: AbortSignal, onOverview?: (data: DashboardData) => void): Promise<DashboardData> {
  const raw = await requestJSON(API_ENDPOINTS.overview, token, signal);
  const initial = normalizeOverview(raw);
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
  });
  if (subs.status === "rejected") data.notices.push("订阅信息暂时未能加载。");
  if (providers.status === "rejected") data.notices.push("提供商状态暂时未能加载。");
  if (history.status === "rejected") data.notices.push("每日费用明细暂时未能加载。");
  return data;
}
