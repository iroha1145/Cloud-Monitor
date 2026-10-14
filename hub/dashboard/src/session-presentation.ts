import type { Session } from "./data";

const RUNNING_WINDOW_MS = 10 * 60 * 1000;
const LIVE_ACTIVITY_TTL_MS = 30 * 1000;
const LIVE_ACTIVITY_CLIENTS = new Set(["claude", "codex"]);

export function sessionActivity(session: Session, generatedAt: string): string {
  if (session.archived === true) return "闲置";
  const now = Date.parse(generatedAt);
  if (!Number.isFinite(now)) return "状态未提供";
  if (session.deviceStale === false && LIVE_ACTIVITY_CLIENTS.has(session.client)) {
    const live = session.liveActivity;
    const observed = live ? Date.parse(live.observedAt || "") : NaN;
    if (
      live &&
      live.state !== "unknown" &&
      Number.isFinite(observed) &&
      observed <= now &&
      observed + LIVE_ACTIVITY_TTL_MS > now
    ) {
      if (live.state === "running") return "运行中";
      if (live.state === "waiting") return "等待输入";
      if (live.state === "idle") return "闲置";
    }
  }
  const last = Date.parse(session.lastUsedAt || "");
  if (!Number.isFinite(last) || last > now) return "状态未提供";
  if (session.deviceStale === true || now - last > RUNNING_WINDOW_MS) return "闲置";
  if (session.deviceStale !== false) return "状态未提供";
  if (session.turnEnded === true) return "已完成";
  if (session.client === "codex" && session.waitingForInput === true) return "等待输入";
  if (session.turnEnded === false) return "运行中";
  return "状态未提供";
}

export function sessionContext(session: Session): { used: number; remaining: number } | null {
  const used = session.contextTokens;
  const window = session.contextWindow;
  if (used === null || used === undefined || window === null || window === undefined ||
      !Number.isFinite(used) || !Number.isFinite(window) || used <= 0 || window <= 0) return null;
  const remaining = Math.max(0, Math.round(((window - used) / window) * 100));
  return { used: 100 - remaining, remaining };
}
