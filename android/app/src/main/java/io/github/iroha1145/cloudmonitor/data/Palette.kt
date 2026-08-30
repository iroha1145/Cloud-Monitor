package io.github.iroha1145.cloudmonitor.data

import androidx.compose.ui.graphics.Color

val PALETTE = listOf(
    Color(0xFF533AFD), Color(0xFFF59E0B), Color(0xFF0EA5E9), Color(0xFF7F7DFC),
    Color(0xFF00B261), Color(0xFFD8351E), Color(0xFFEC4899), Color(0xFF14B8A6),
    Color(0xFFF97316), Color(0xFF64748D), Color(0xFF84CC16), Color(0xFF0E7490),
    Color(0xFFA21CAF), Color(0xFF854D0E), Color(0xFF4032C8), Color(0xFF006F3A),
)

val OTHER_COLOR = Color(0xFF95A4BA)

val SEG_INPUT = Color(0xFF64748D)
val SEG_OUTPUT = Color(0xFF533AFD)
val SEG_CACHE_READ = Color(0xFF7F7DFC)
val SEG_CACHE_WRITE = Color(0xFFB9B9F9)
val SEG_UNCLS = Color(0xFF95A4BA)

private val PALETTE_SPREAD = intArrayOf(0, 1, 3, 4, 6, 2, 8, 12, 10, 9, 5, 13, 7, 14, 15, 11)

fun assignColors(names: List<String>): Map<String, Color> {
    val counts = IntArray(PALETTE.size)
    val out = LinkedHashMap<String, Color>()
    var rank = 0
    for (name in names) {
        val idx = if (rank < PALETTE.size) {
            PALETTE_SPREAD[rank]
        } else {
            var best = PALETTE_SPREAD[0]
            for (s in PALETTE_SPREAD) if (counts[s] < counts[best]) best = s
            best
        }
        counts[idx]++
        out[name] = PALETTE[idx]
        rank++
    }
    return out
}

data class TokenSeg(val key: String, val label: String, val color: Color, val value: Double)

fun componentBreakdown(period: PeriodTotals): Pair<Boolean, List<TokenSeg>> {
    val total = period.totalTokens
    val capable = period.capabilities.tokenComponents
    val hasAny = listOf(
        period.outputTokens, period.cacheReadTokens,
        period.cacheWriteTokens, period.unclassifiedTokens,
    ).any { it > 0 }
    if (!capable || !hasAny || total <= 0) {
        return false to if (total > 0) {
            listOf(TokenSeg("unknown", "组成未知", SEG_UNCLS, total))
        } else emptyList()
    }
    val output = period.outputTokens
    val cacheRead = period.cacheReadTokens
    val cacheWrite = period.cacheWriteTokens
    val unclassified = period.unclassifiedTokens
    val input = maxOf(0.0, total - output - cacheRead - cacheWrite - unclassified)
    val segs = listOf(
        TokenSeg("input", "非缓存输入", SEG_INPUT, input),
        TokenSeg("output", "输出", SEG_OUTPUT, output),
        TokenSeg("cacheRead", "缓存读", SEG_CACHE_READ, cacheRead),
        TokenSeg("cacheWrite", "缓存写", SEG_CACHE_WRITE, cacheWrite),
        TokenSeg("unclassified", "未分类", SEG_UNCLS, unclassified),
    ).filter { it.value > 0 }
    return true to segs
}

fun clientBreakdown(period: PeriodTotals, name: String): List<TokenSeg> {
    val total = period.clients[name] ?: 0.0
    if (!period.capabilities.tokenComponents || total <= 0) return emptyList()
    val output = period.clientOutputs[name] ?: 0.0
    val cacheRead = period.clientCacheReads[name] ?: 0.0
    val cacheWrite = period.clientCacheWrites[name] ?: 0.0
    val unclassified = period.clientUnclassifiedTokens[name] ?: 0.0
    val input = maxOf(0.0, total - output - cacheRead - cacheWrite - unclassified)
    return listOf(
        TokenSeg("input", "非缓存输入", SEG_INPUT, input),
        TokenSeg("output", "输出", SEG_OUTPUT, output),
        TokenSeg("cacheRead", "缓存读", SEG_CACHE_READ, cacheRead),
        TokenSeg("cacheWrite", "缓存写", SEG_CACHE_WRITE, cacheWrite),
        TokenSeg("unclassified", "未分类", SEG_UNCLS, unclassified),
    ).filter { it.value > 0 }
}

fun hmLevel(v: Double, max: Double): Int {
    if (v <= 0 || max <= 0) return 0
    return minOf(5, maxOf(1, kotlin.math.ceil(v / max * 5).toInt()))
}

val HM_COLORS_LIGHT = listOf(
    Color(0xFFE5EDF5), Color(0xFFE8E9FF), Color(0xFFD6D9FC),
    Color(0xFFB9B9F9), Color(0xFF533AFD), Color(0xFF2E2B8C),
)
val HM_COLORS_DARK = listOf(
    Color(0xFF1A2333), Color(0xFF1E2547), Color(0xFF2E2B8C),
    Color(0xFF4032C8), Color(0xFF7F7DFC), Color(0xFFC5C4FF),
)

data class TrendRow(val day: String, val total: Double, val models: Map<String, Double>)

fun trendRows(overview: Overview, now: Long = System.currentTimeMillis()): List<TrendRow> {
    val byDay = LinkedHashMap<String, TrendRow>()
    fun take(dayRaw: String?, total: Double, models: Map<String, Double>?) {
        val day = dayRaw.orEmpty().take(10)
        if (day.isEmpty()) return
        val prev = byDay[day] ?: TrendRow(day, 0.0, emptyMap())
        val nextTotal = if (total > prev.total) total else prev.total
        val nextModels = prev.models.toMutableMap()
        models?.forEach { (k, v) -> if (v > (nextModels[k] ?: 0.0)) nextModels[k] = v }
        byDay[day] = TrendRow(day, nextTotal, nextModels)
    }
    overview.activity.daily.forEach { take(it.day, it.total, it.models) }
    overview.trend.forEach { take(it.day, it.total, null) }
    overview.trendModels.forEach { take(it.day, it.total, it.models) }
    val tz = overview.dashboardPeriod?.timeZone ?: overview.dashboardTimeZone
    val end = overview.dashboardPeriod?.today?.key ?: Format.dayKeyTz(now, tz)
    return (29 downTo 0).map { i ->
        val day = Format.keyAdd(end, -i)
        byDay[day] ?: TrendRow(day, 0.0, emptyMap())
    }
}

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
