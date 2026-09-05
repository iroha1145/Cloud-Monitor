package io.github.iroha1145.cloudmonitor.data

import androidx.compose.ui.graphics.Color

val PALETTE = listOf(
    Color(0xFF608AC5), Color(0xFF338B87), Color(0xFFC49462), Color(0xFF9C85B4),
    Color(0xFF7A9AAA), Color(0xFF9AA5B2), Color(0xFF467EA9), Color(0xFF5C9878),
    Color(0xFFD09A70), Color(0xFF8C83B8), Color(0xFF588DA0), Color(0xFFB68790),
    Color(0xFF879B69), Color(0xFF9E8973), Color(0xFF6982A6), Color(0xFF6B9A92),
)

val OTHER_COLOR = Color(0xFF9AA5B2)

val SEG_INPUT = Color(0xFF2672C0)
val SEG_OUTPUT = Color(0xFFF09A2F)
val SEG_CACHE_READ = Color(0xFF16765E)
val SEG_CACHE_WRITE = Color(0xFFB393C5)
val SEG_UNCLS = Color(0xFFB4BECF)

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
    TokenSeg("input", "非缓存输入", SEG_INPUT, parts.input),
    TokenSeg("cacheRead", "缓存读取", SEG_CACHE_READ, parts.cacheRead),
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

/** For partial data the caller should use UsageComponents.cacheLabel. */
fun cacheHitRate(period: PeriodTotals, name: String): Double? =
    usageComponents(period, "model", name).cacheRate

fun componentsComplete(period: PeriodTotals, segs: List<TokenSeg>): Boolean {
    val total = period.totalTokens
    if (total <= 0 || segs.isEmpty()) return true
    val sum = segs.sumOf { it.value }
    return kotlin.math.abs(sum - total) <= maxOf(1.0, total * 0.01)
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
    val outbox = overview.pendingOutbox
    if (outbox > 0) text += " · 待同步快照 $outbox 条"
    val ok = text == "正常"
    return text to ok
}

fun sessionsDetailsIncomplete(overview: Overview): Boolean =
    overview.sessionsOmitted || overview.sessionsMeta.sessionDetailsIncomplete

fun isWindowsPlatform(platform: String?, osName: String?): Boolean {
    val s = "${platform.orEmpty()} ${osName.orEmpty()}".lowercase()
    return "win" in s
}

fun hmLevel(v: Double, max: Double): Int {
    if (v <= 0 || max <= 0) return 0
    return minOf(5, maxOf(1, kotlin.math.ceil(v / max * 5).toInt()))
}

val HM_COLORS_LIGHT = listOf(
    Color(0xFFEDF0F2), Color(0xFFE3F0E8), Color(0xFFB9DCCB),
    Color(0xFF7EBB9D), Color(0xFF338B6B), Color(0xFF16765E),
)
val HM_COLORS_DARK = listOf(
    Color(0xFF292D34), Color(0xFF203C34), Color(0xFF285C49),
    Color(0xFF3F8767), Color(0xFF66AE8A), Color(0xFF9AD4B4),
)

/** Keep the old chart entry point without inventing days or mixing activity totals. */
@Suppress("UNUSED_PARAMETER")
fun trendRows(overview: Overview, now: Long = System.currentTimeMillis()): List<TrendRow> =
    analyzeTrend(overview).takeLast(30)

fun deviceOnline(device: Device, overview: Overview, now: Long = System.currentTimeMillis()): Boolean? {
    device.stale?.let { return !it }
    var age = device.ageMs
    if (age == null || !age.isFinite()) {
        val t = Format.parseMillis(device.receivedAt)
        age = if (t == null) Double.NaN else (now - t).toDouble()
    }
    if (age == null || !age.isFinite()) return null
    val sync = device.syncUploadIntervalMs
    val threshold = maxOf(sync * 2, overview.staleAfterMs.toDouble())
    return age <= threshold
}

fun hourlyBuckets(overview: Overview): List<HourBucket> {
    val todayKey = overview.dashboardPeriod?.today?.key
    val ht = overview.activity.hourlyToday
    if (ht != null && ht.buckets.isNotEmpty() && (todayKey == null || ht.day == todayKey)) {
        return ht.buckets
    }
    return overview.activity.hourly
}

fun rankedNames(map: Map<String, Double>): List<String> =
    map.entries.sortedByDescending { it.value }.map { it.key }
