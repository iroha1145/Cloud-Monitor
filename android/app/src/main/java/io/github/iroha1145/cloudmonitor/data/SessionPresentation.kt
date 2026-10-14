package io.github.iroha1145.cloudmonitor.data

import kotlin.math.max
import kotlin.math.roundToInt

private const val RUNNING_WINDOW_MS = 10 * 60 * 1000L
private const val LIVE_ACTIVITY_TTL_MS = 30 * 1000L
private val SESSION_ACTIVITY_CLIENTS = setOf("claude", "codex")

/** Same labels as hub/dashboard `sessionActivity`. */
fun sessionActivity(session: SessionRow, generatedAt: String?): String {
    if (session.archived == true) return "闲置"
    val now = Format.parseMillis(generatedAt) ?: return "状态未提供"
    val client = session.client?.lowercase().orEmpty()
    val live = session.liveActivity
    if (session.deviceStale == false && client in SESSION_ACTIVITY_CLIENTS && live != null) {
        val observed = Format.parseMillis(live.observedAt)
        if (observed != null && observed <= now && observed + LIVE_ACTIVITY_TTL_MS > now) {
            when (live.state) {
                "running" -> return "运行中"
                "waiting" -> return "等待输入"
                "idle" -> return "闲置"
            }
        }
    }
    val last = Format.parseMillis(session.lastUsedAt) ?: return "状态未提供"
    if (last > now) return "状态未提供"
    if (session.deviceStale == true || now - last > RUNNING_WINDOW_MS) return "闲置"
    if (session.deviceStale != false || session.turnEnded == null) return "状态未提供"
    if (session.turnEnded) return "已完成"
    if (client == "codex" && session.waitingForInput == true) return "等待输入"
    return "运行中"
}

fun sessionTitle(session: SessionRow): String =
    session.title?.takeIf { it.isNotBlank() }
        ?: session.project?.takeIf { it.isNotBlank() }
        ?: session.sessionId?.takeIf { it.isNotBlank() }?.take(24)
        ?: "未命名会话"

/** Used percent to remaining percent, matching `sessionContext`. Null when either side is missing. */
fun sessionContext(session: SessionRow): Pair<Int, Int>? {
    val used = session.contextTokens ?: return null
    val window = session.contextWindow ?: return null
    if (!used.isFinite() || !window.isFinite() || used <= 0.0 || window <= 0.0) return null
    val remaining = max(0, (((window - used) / window) * 100.0).roundToInt())
    return (100 - remaining) to remaining
}
