package io.github.iroha1145.cloudmonitor.data

import androidx.compose.ui.graphics.Color

val PALETTE = listOf(
    Color(0xFF608AC5), Color(0xFF338B87), Color(0xFFC49462), Color(0xFF9C85B4),
    Color(0xFF7A9AAA), Color(0xFF9AA5B2), Color(0xFF467EA9), Color(0xFF5C9878),
    Color(0xFFD09A70), Color(0xFF8C83B8), Color(0xFF588DA0), Color(0xFFB68790),
    Color(0xFF879B69), Color(0xFF9E8973), Color(0xFF6982A6), Color(0xFF6B9A92),
)

val OTHER_COLOR = Color(0xFF9AA5B2)

val SEG_INPUT = Color(0xFF3D9AFF)
val SEG_OUTPUT = Color(0xFFF09A2F)
val SEG_CACHE_READ = Color(0xFF25A878)
val SEG_CACHE_WRITE = Color(0xFFB393C5)
val SEG_UNCLS = Color(0xFFB4BECF)

/** Quota meters use the same five colours in both themes. */
val QUOTA_1 = Color(0xFF27847F)
val QUOTA_2 = Color(0xFF428AB5)
val QUOTA_3 = Color(0xFFB78246)
val QUOTA_WARNING = Color(0xFFDBA54A)
val QUOTA_DANGER = Color(0xFFCB7065)

/** Cards rotate the first three colours; 75% and 90% replace them. */
fun quotaBarColor(cardIndex: Int, percent: Double?): Color = when {
    percent != null && percent >= 90.0 -> QUOTA_DANGER
    percent != null && percent >= 75.0 -> QUOTA_WARNING
    cardIndex % 3 == 1 -> QUOTA_2
    cardIndex % 3 == 2 -> QUOTA_3
    else -> QUOTA_1
}

private val PALETTE_SPREAD = intArrayOf(0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15)

/**
 * 会话级配色注册表：名字一旦分配颜色就保持稳定（对齐网页 modelColorMap/clientColorMap 语义），
 * 概览、历史等各卡片共用同一张表，避免同名异色。
 */
class ColorRegistry {
    private val assigned = LinkedHashMap<String, Color>()
    private val counts = IntArray(PALETTE.size)

    @Synchronized
    fun seed(names: Collection<String>) {
        for (name in names) obtain(name)
    }

    @Synchronized
    fun snapshot(): Map<String, Color> = LinkedHashMap(assigned)

    @Synchronized
    fun reset() {
        assigned.clear()
        counts.fill(0)
    }

    private fun obtain(name: String): Color = assigned.getOrPut(name) {
        val rank = assigned.size
        val idx = if (rank < PALETTE.size) {
            PALETTE_SPREAD[rank]
        } else {
            var best = PALETTE_SPREAD[0]
            for (s in PALETTE_SPREAD) if (counts[s] < counts[best]) best = s
            best
        }
        counts[idx]++
        PALETTE[idx]
    }
}

data class TokenSeg(val key: String, val label: String, val color: Color, val value: Double)

/** The numeric analysis stays independent of Compose; this is its chart adapter. */
fun componentSegments(parts: UsageComponents): List<TokenSeg> = listOf(
    TokenSeg("cacheRead", "缓存读取", SEG_CACHE_READ, parts.cacheRead),
    TokenSeg("input", "非缓存输入", SEG_INPUT, parts.input),
    TokenSeg("output", "输出", SEG_OUTPUT, parts.output),
    TokenSeg("cacheWrite", "缓存写入", SEG_CACHE_WRITE, parts.cacheWrite),
    TokenSeg("unclassified", if (parts.known) "未分类" else "组成未知", SEG_UNCLS, parts.unclassified),
).filter { it.value.isFinite() && it.value > 0 }

fun componentBreakdown(period: PeriodTotals): Pair<Boolean, List<TokenSeg>> {
    val parts = usageComponents(period)
    return parts.known to componentSegments(parts)
}

fun clientBreakdown(period: PeriodTotals, name: String): List<TokenSeg> {
    val parts = usageComponents(period, "client", name)
    return if (parts.known) componentSegments(parts) else emptyList()
}

fun modelBreakdown(period: PeriodTotals, name: String): List<TokenSeg> {
    val parts = usageComponents(period, "model", name)
    return if (parts.known) componentSegments(parts) else emptyList()
}

fun matrixAxes(map: Map<String, Map<String, Double>>, top: Int = 8): Pair<List<String>, List<String>> {
    val rowSum = mutableMapOf<String, Double>()
    val colSum = mutableMapOf<String, Double>()
    map.forEach { (client, models) ->
        models.forEach { (model, v) ->
            if (v > 0) {
                rowSum[client] = (rowSum[client] ?: 0.0) + v
                colSum[model] = (colSum[model] ?: 0.0) + v
            }
        }
    }
    return rankedNames(rowSum).take(top) to rankedNames(colSum).take(top)
}

fun connBanner(overview: Overview, demo: Boolean, staleData: Boolean): Pair<String, Boolean> {
    if (demo) return "演示模式" to true
    val codes = overview.partialErrors.map { Format.partialErrorText(it) }.filter { it.isNotBlank() }.distinct()
    var text = when {
        staleData -> "数据可能已过期"
        overview.snapshotDegraded -> "快照历史降级"
        overview.partial -> if (codes.isEmpty()) "部分数据不可用" else "部分数据不可用（${codes.joinToString("、")}）"
        else -> "正常"
    }
    val forwarding = overview.forwardingOutbox.coerceAtLeast(0)
    val pendingSnapshots = (overview.pendingOutbox - forwarding).coerceAtLeast(0)
    if (forwarding > 0) text += " · 待确认上报 $forwarding 条"
    if (pendingSnapshots > 0) text += " · 待同步快照 $pendingSnapshots 条"
    if (overview.expiredUnconfirmedOutbox > 0) text += " · 未完成同步 ${overview.expiredUnconfirmedOutbox} 条"
    val ok = text == "正常"
    return text to ok
}

fun sessionsDetailsIncomplete(overview: Overview): Boolean =
    overview.sessionsOmitted || overview.sessionsMeta.sessionDetailsIncomplete

fun isWindowsPlatform(platform: String?, osName: String?): Boolean {
    val s = "${platform.orEmpty()} ${osName.orEmpty()}".lowercase()
    return "win" in s
}

/** Same 5-stop scale as hub/dashboard `matrixHeatLevel`. Level 0 is empty. */
fun matrixHeatLevel(value: Double, peak: Double): Int {
    if (!(value > 0.0)) return 0
    if (!(peak > 0.0)) return 1
    return maxOf(1, minOf(4, kotlin.math.floor(value / peak * 4).toInt()))
}

/** Same steps as the web activity grid: unknown is null, zero is 0, else ceil into 1..4. */
fun activityHeatLevel(total: Double?, maximum: Double): Int? {
    if (total == null) return null
    if (total == 0.0) return 0
    val peak = maximum.coerceAtLeast(1.0)
    return minOf(4, maxOf(1, kotlin.math.ceil(total / peak * 4).toInt()))
}

fun hmLevel(v: Double, max: Double): Int = matrixHeatLevel(v, max)

/** Keep the old chart entry point without inventing days or mixing activity totals. */
@Suppress("UNUSED_PARAMETER")
fun trendRows(overview: Overview, now: Long = System.currentTimeMillis()): List<TrendRow> =
    analyzeTrend(overview).takeLast(30)

enum class DeviceStatus { Online, Delayed, Offline }

private val OFFICIAL_SYNC_MS = setOf(600_000.0, 1_200_000.0, 1_800_000.0)

fun deviceStatusLabel(status: DeviceStatus): String = when (status) {
    DeviceStatus.Online -> "在线"
    DeviceStatus.Delayed -> "同步延迟"
    DeviceStatus.Offline -> "离线"
}

/** Same online / delayed / offline thresholds as hub/dashboard/src/data.ts. */
fun deviceStatus(device: Device, overview: Overview, now: Long = System.currentTimeMillis()): DeviceStatus {
    device.stale?.let { return if (it) DeviceStatus.Offline else DeviceStatus.Online }
    var age = device.ageMs
    if (age == null || !age.isFinite()) {
        val t = Format.parseMillis(device.receivedAt)
        age = if (t == null) Double.POSITIVE_INFINITY else (now - t).toDouble().coerceAtLeast(0.0)
    }
    val staleAfter = overview.staleAfterMs.toDouble().takeIf { it > 0 } ?: 600_000.0
    val uploadInterval = device.syncUploadIntervalMs.takeIf { it in OFFICIAL_SYNC_MS } ?: 0.0
    val deviceStaleAfter = maxOf(staleAfter, uploadInterval * 2)
    return when {
        age > maxOf(3_600_000.0, deviceStaleAfter) -> DeviceStatus.Offline
        age > deviceStaleAfter -> DeviceStatus.Delayed
        else -> DeviceStatus.Online
    }
}

fun deviceOnline(device: Device, overview: Overview, now: Long = System.currentTimeMillis()): Boolean =
    deviceStatus(device, overview, now) == DeviceStatus.Online

fun rankedNames(map: Map<String, Double>): List<String> =
    map.entries.sortedByDescending { it.value }.map { it.key }
