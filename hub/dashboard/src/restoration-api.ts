import type { DashboardData } from "./data";

type JsonObject = Record<string, unknown>;
const object = (value: unknown): JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
const string = (value: unknown): string =>
  typeof value === "string" ? value : "";
const nonnegative = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
const money = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const nullableBoolean = (value: unknown): boolean | null =>
  typeof value === "boolean" ? value : null;
export const validArchiveDay = (value: unknown): value is string => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false;
  const date = new Date(`${value}T00:00:00Z`);
  return (
    Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
};
function tokenMap(value: unknown): Record<string, number> {
  return Object.fromEntries(
    Object.entries(object(value)).flatMap(([key, amount]) => {
      const parsed = nonnegative(amount);
      return parsed === null ? [] : [[key, parsed]];
    }),
  );
}

export interface ArchiveDay {
  day: string;
  tokens: number | null;
  costUsd: number | null;
  perClient: Record<string, number>;
  perModel: Record<string, number>;
  deviceCount: number | null;
  complete: boolean | null;
  coverage: number | null;
}
export interface ArchivePage {
  items: ArchiveDay[];
  nextCursor: string | null;
  hasMore: boolean;
  dayBasis: string;
  dashboardTimeZone: string;
  deviceTimeZone: string;
  mixedTimeZones: boolean;
  retentionDays: number | null;
  partial: boolean;
  partialErrorCount: number;
}
export function normalizeArchivePage(value: unknown): ArchivePage {
  const raw = object(value);
  if (!Array.isArray(raw.items))
    throw new Error("历史归档返回的数据格式不完整，请重试。");
  const items: ArchiveDay[] = raw.items.flatMap((value) => {
    const row = object(value);
    if (!validArchiveDay(row.day)) return [];
    const coverage = nonnegative(row.coverage);
    return [
      {
        day: row.day,
        tokens: nonnegative(row.tokens),
        costUsd: money(row.costUsd),
        perClient: tokenMap(row.perClient),
        perModel: tokenMap(row.perModel),
        deviceCount: nonnegative(row.deviceCount),
        complete: nullableBoolean(row.complete),
        coverage: coverage !== null && coverage <= 100 ? coverage : null,
      },
    ];
  });
  return {
    items: mergeArchiveDays([], items),
    nextCursor: validArchiveDay(raw.next_cursor) ? raw.next_cursor : null,
    hasMore: raw.has_more === true,
    dayBasis: string(raw.day_basis),
    dashboardTimeZone: string(raw.dashboard_time_zone),
    deviceTimeZone: string(raw.device_time_zone),
    mixedTimeZones: raw.mixed_time_zones === true,
    retentionDays: nonnegative(raw.retention_days),
    partial: raw.partial === true,
    partialErrorCount: Array.isArray(raw.partial_errors)
      ? raw.partial_errors.length
      : 0,
  };
}
export function mergeArchiveDays(
  previous: ArchiveDay[],
  next: ArchiveDay[],
): ArchiveDay[] {
  const rows = new Map(previous.map((row) => [row.day, row]));
  next.forEach((row) => rows.set(row.day, row));
  return [...rows.values()].sort((a, b) => b.day.localeCompare(a.day));
}
export function nextArchiveCursor(
  page: ArchivePage,
  requestedCursor: string | null,
  addedDays: number,
): string | null {
  if (!page.hasMore || !page.nextCursor || addedDays === 0) return null;
  // Each next page must move toward an older day, including across repeated responses.
  return requestedCursor && page.nextCursor >= requestedCursor
    ? null
    : page.nextCursor;
}
export type ArchiveFallbackData = Pick<
  DashboardData,
  "trend" | "activity" | "timeZone"
>;
export function makeArchiveFallback(data?: ArchiveFallbackData): ArchiveDay[] {
  const rows = new Map<string, ArchiveDay>();
  const empty = (day: string, tokens: number): ArchiveDay => ({
    day,
    tokens,
    costUsd: null,
    perClient: {},
    perModel: {},
    deviceCount: null,
    complete: null,
    coverage: null,
  });
  data?.activity.forEach((row) => {
    if (validArchiveDay(row.day))
      rows.set(row.day, empty(row.day, row.totalTokens));
  });
  data?.trend.forEach((row) => {
    if (!validArchiveDay(row.day)) return;
    const previous = rows.get(row.day);
    rows.set(row.day, {
      ...empty(row.day, Math.max(previous?.tokens ?? 0, row.totalTokens)),
      costUsd: money(row.costUsd),
      perModel: tokenMap(row.models),
    });
  });
  return mergeArchiveDays([], [...rows.values()]);
}

export class RestorationHttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "RestorationHttpError";
    this.status = status;
  }
}
export function isAuthError(error: unknown): boolean {
  return (
    error instanceof RestorationHttpError &&
    (error.status === 401 || error.status === 403)
  );
}
export function isMissingArchive(error: unknown): boolean {
  return (
    error instanceof RestorationHttpError &&
    (error.status === 404 || error.status === 501)
  );
}
async function requestJson(
  path: string,
  token: string,
  signal?: AbortSignal,
  ref?: string,
): Promise<unknown> {
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) controller.abort();
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 15000);
  try {
    const response = await fetch(path, {
      method: ref === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        ...(ref === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(ref === undefined ? {} : { body: JSON.stringify({ ref }) }),
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) {
      let detail = "";
      try {
        const body = object(await response.json());
        detail = string(body.detail) || string(body.error);
      } catch {
        /* HTTP status remains useful. */
      }
      throw new RestorationHttpError(
        response.status,
        response.status === 401 || response.status === 403
          ? "访问密钥已失效，或没有访问权限。"
          : detail || `请求失败（${response.status}），请稍后重试。`,
      );
    }
    return await response.json();
  } catch (error) {
    if (timedOut) throw new Error("服务响应超时，请稍后重试。");
    if (error instanceof TypeError)
      throw new Error("网络连接失败，请检查服务是否可用。");
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}
export async function readArchive(
  token: string,
  cursor: string | null,
  signal?: AbortSignal,
): Promise<ArchivePage> {
  const params = new URLSearchParams({ limit: "30" });
  if (cursor) params.set("cursor", cursor);
  return normalizeArchivePage(
    await requestJson(`/api/v1/tm/history/daily?${params}`, token, signal),
  );
}

export interface UpdateJob {
  state: string;
  id: string;
  ref: string;
  message: string;
  updatedAt: string;
}
export interface UpdateRelease {
  tag: string;
  name: string;
  publishedAt: string;
  url: string;
  prerelease: boolean;
  notes: string;
}
export interface UpdateStatus {
  current: { version: string; gitSha: string };
  repo: string;
  latestRelease: UpdateRelease | null;
  main: { sha: string; shortSha: string; message: string } | null;
  releaseAhead: boolean;
  mainAhead: boolean;
  updateAvailable: boolean;
  githubError: string;
  checkedAt: string;
  applyEnabled: boolean;
  job: UpdateJob;
}
export function safeGithubUrl(value: unknown): string {
  try {
    const url = new URL(string(value));
    return url.protocol === "https:" &&
      url.hostname === "github.com" &&
      !url.username &&
      !url.password
      ? url.href
      : "";
  } catch {
    return "";
  }
}
export function normalizeUpdateJob(value: unknown): UpdateJob {
  const raw = object(value);
  return {
    state: string(raw.state) || "unknown",
    id: string(raw.id),
    ref: string(raw.ref),
    message: string(raw.message),
    updatedAt: string(raw.updated_at),
  };
}
export function normalizeUpdateStatus(value: unknown): UpdateStatus {
  const raw = object(value);
  if (!raw.current || !raw.job)
    throw new Error("更新检查返回的数据格式不完整，请重试。");
  const current = object(raw.current);
  const release = raw.latest_release ? object(raw.latest_release) : null;
  const main = raw.main ? object(raw.main) : null;
  return {
    current: {
      version: string(current.version) || "dev",
      gitSha: string(current.git_sha),
    },
    repo: safeGithubUrl(raw.repo),
    latestRelease: release
      ? {
          tag: string(release.tag),
          name: string(release.name),
          publishedAt: string(release.published_at),
          url: safeGithubUrl(release.html_url),
          prerelease: release.prerelease === true,
          notes: string(release.notes),
        }
      : null,
    main: main
      ? {
          sha: string(main.sha),
          shortSha: string(main.short_sha),
          message: string(main.message),
        }
      : null,
    releaseAhead: raw.release_ahead === true,
    mainAhead: raw.main_ahead === true,
    updateAvailable: raw.update_available === true,
    githubError: string(raw.github_error),
    checkedAt: string(raw.checked_at),
    applyEnabled: raw.apply_enabled === true,
    job: normalizeUpdateJob(raw.job),
  };
}
export const isUpdateBusy = (job: UpdateJob): boolean =>
  ["queued", "running"].includes(job.state);
export function validUpdateRef(ref: string): boolean {
  return (
    /^(main|master|v?[0-9][A-Za-z0-9._-]{0,64})$/.test(ref) &&
    !ref.includes("..")
  );
}
export function availableUpdateTargets(
  status: UpdateStatus,
): { ref: string; label: string }[] {
  if (
    !status.applyEnabled ||
    !["idle", "ok", "error", "unavailable"].includes(status.job.state)
  )
    return [];
  const targets: { ref: string; label: string }[] = [];
  if (
    status.releaseAhead &&
    status.latestRelease &&
    validUpdateRef(status.latestRelease.tag)
  )
    targets.push({
      ref: status.latestRelease.tag,
      label: `升级至 ${status.latestRelease.tag}`,
    });
  if (status.mainAhead && status.main)
    targets.push({ ref: "main", label: "更新至主分支（main）" });
  return targets;
}
export async function readUpdateStatus(
  token: string,
  refresh = false,
  signal?: AbortSignal,
): Promise<UpdateStatus> {
  return normalizeUpdateStatus(
    await requestJson(
      `/api/v1/system/update${refresh ? "?refresh=1" : ""}`,
      token,
      signal,
    ),
  );
}
export async function submitSystemUpdate(
  token: string,
  ref: string,
  signal?: AbortSignal,
): Promise<UpdateJob> {
  if (!validUpdateRef(ref))
    throw new Error("该版本标识不受支持，请重新检查更新。");
  return normalizeUpdateJob(
    await requestJson("/api/v1/system/update", token, signal, ref),
  );
}
