import type { Session } from "./data";

const RUNNING_WINDOW_MS = 10 * 60 * 1000;

export function sessionActivity(session: Session, generatedAt: string): string {
  if (session.archived === true) return "闲置";
  const now = Date.parse(generatedAt);
  const last = Date.parse(session.lastUsedAt || "");
  if (!Number.isFinite(now) || !Number.isFinite(last) || last > now) return "状态未提供";
  if (session.deviceStale === true || now - last > RUNNING_WINDOW_MS) return "闲置";
  if (session.deviceStale !== false || session.turnEnded === null || session.turnEnded === undefined)
    return "状态未提供";
  return session.turnEnded ? "已完成" : "运行中";
}

export function sessionContext(session: Session): { used: number; remaining: number } | null {
  const used = session.contextTokens;
  const window = session.contextWindow;
  if (used === null || used === undefined || window === null || window === undefined ||
      !Number.isFinite(used) || !Number.isFinite(window) || used <= 0 || window <= 0) return null;
  const remaining = Math.max(0, Math.round(((window - used) / window) * 100));
  return { used: 100 - remaining, remaining };
}
