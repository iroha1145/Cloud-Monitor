package io.github.iroha1145.cloudmonitor.data

/** Hourly activity states from hub/dashboard `normalizeActivity`. */
enum class HourlyStatus { Ready, Unavailable, DateMismatch, Disabled }

data class ResolvedHourly(
    val status: HourlyStatus,
    val day: String?,
    val totals: Map<Int, Double>,
)

fun hourlyMessage(status: HourlyStatus): String = when (status) {
    HourlyStatus.Disabled -> "服务尚未启用小时活动。"
    HourlyStatus.Unavailable -> "当前数据未提供小时活动，未上报时段保留为未知。"
    HourlyStatus.DateMismatch -> "小时记录与当前数据的日期不一致，已暂不展示。"
    HourlyStatus.Ready -> ""
}

/**
 * Same branch order as `normalizeActivity`: disabled clears buckets, a matching
 * hourly_today or legacy array is used, a present array on the wrong day is a
 * mismatch, and only valid hours promote the state to ready.
 */
fun resolveHourly(activity: Activity, hourlyEnabled: Boolean, today: String?): ResolvedHourly {
    val expected = today?.takeIf(::isCalendarDay)
    val block = activity.hourlyToday
    val newBuckets = block?.buckets
    val newDay = block?.day?.takeIf(::isCalendarDay)
    val legacy = activity.hourly
    val legacyDay = activity.hourlyDay?.takeIf(::isCalendarDay)
    var status = HourlyStatus.Unavailable
    var buckets: List<HourBucket> = emptyList()
    var day: String? = null
    if (!hourlyEnabled) {
        status = HourlyStatus.Disabled
    } else if (newBuckets != null && newDay != null && (expected == null || newDay == expected)) {
        buckets = newBuckets
        day = newDay
    } else if (legacy != null && (expected == null || activity.hourlyDay == null || legacyDay == expected)) {
        buckets = legacy
        day = legacyDay ?: expected
    } else if (newBuckets != null || legacy != null) {
        status = HourlyStatus.DateMismatch
    }
    val totals = linkedMapOf<Int, Double>()
    if (hourlyEnabled && status != HourlyStatus.DateMismatch) {
        for (item in buckets) {
            if (item.hour in 0..23 && item.total.isFinite() && item.total >= 0) totals[item.hour] = item.total
        }
    }
    if (totals.isNotEmpty()) status = HourlyStatus.Ready
    return ResolvedHourly(status, day, if (status == HourlyStatus.Ready) totals else emptyMap())
}

fun samplingModeLabel(value: String?): String = when (value) {
    "delta" -> "增量采样"
    "delta-low-coverage" -> "采样覆盖不足"
    "delta-with-reset" -> "采样含计数重置"
    "none" -> "暂无可归属采样"
    null, "" -> "归属方式未提供"
    else -> value
}

fun coverageWarning(coverage: Coverage): String? {
    val low = coverage.attributionMode == "delta-low-coverage" ||
        (coverage.observedBuckets != 0 && coverage.coveragePercent != null && coverage.coveragePercent < 60.0)
    return if (low) "小时分布按采样增量记录，可能集中在首次采样时段。" else null
}

fun dailyBasisNotice(activity: Activity): String {
    val hybrid = activity.dailyMixedBasis || activity.dailyDayBasis == "hybrid-dashboard-and-device-local"
    if (hybrid) {
        val cut = activity.dailyArchiveCutoverDay?.takeIf(::isCalendarDay)
        val range = if (cut != null) "（${cut}及之前）" else ""
        return "历史活动包含设备本地日${range}，跨时区设备不可视为同一日期。"
    }
    if (activity.dailyDayBasis == "device-local") return "每日记录按设备本地日期汇总。"
    return ""
}

data class ActivityCellModel(
    val key: String,
    val label: String,
    val day: String?,
    val total: Double?,
    val future: Boolean,
    val column: Int,
    val row: Int,
    val pad: Boolean = false,
)

/** Diagonal entrance delay: (column + row) × 14ms, matching ActivityPanel. */
fun cellEnterDelayMs(column: Int, row: Int): Int = (column + row) * 14

fun activitySubtitle(view: Int, today: String, hourlyDay: String?, monthKey: String?): String = when (view) {
    0 -> "${hourlyDay ?: today.ifBlank { "日期未提供" }} · 24 小时"
    1 -> "最近 12 周 · 每格一天"
    else -> {
        val label = monthKey?.takeIf { it.matches(Regex("""^\d{4}-\d{2}$""")) }?.let {
            "${it.take(4).toInt()} 年 ${it.drop(5).toInt()} 月"
        } ?: "日期未提供"
        "$label · 每格一天"
    }
}

fun activityCells(view: Int, today: String, overview: Overview): List<ActivityCellModel> {
    val todayDate = runCatching { java.time.LocalDate.parse(today) }.getOrNull() ?: return emptyList()
    val daily = overview.activity.daily.associate { it.day to it.total }
    return when (view) {
        0 -> {
            val hourly = resolveHourly(overview.activity, overview.features.activityHourly, today)
            (0..23).map { hour ->
                ActivityCellModel(
                    key = "$today-$hour",
                    label = hour.toString().padStart(2, '0'),
                    day = null,
                    total = if (hourly.status == HourlyStatus.Ready) hourly.totals[hour] else null,
                    future = false,
                    column = hour % 6,
                    row = hour / 6,
                )
            }
        }
        1 -> {
            val monday = todayDate.minusDays((todayDate.dayOfWeek.value - 1).toLong())
            val start = monday.minusWeeks(11)
            (0 until 84).map { index ->
                val day = start.plusDays(index.toLong())
                val key = day.toString()
                ActivityCellModel(key, "", key, daily[key], day.isAfter(todayDate), index / 7, index % 7)
            }
        }
        else -> {
            val month = runCatching {
                java.time.YearMonth.parse(overview.dashboardPeriod?.month?.key ?: today.take(7))
            }.getOrNull() ?: return emptyList()
            val leading = month.atDay(1).dayOfWeek.value - 1
            (0 until leading).map { index ->
                ActivityCellModel("pad-$index", "", null, null, false, index % 7, index / 7, pad = true)
            } + (1..month.lengthOfMonth()).map { dayNumber ->
                val day = month.atDay(dayNumber)
                val index = leading + dayNumber - 1
                ActivityCellModel(day.toString(), dayNumber.toString(), day.toString(), daily[day.toString()], day.isAfter(todayDate), index % 7, index / 7)
            }
        }
    }
}

data class ActivitySummary(val reported: Int, val active: Int, val past: Int, val total: Double, val missing: Int)

fun summarizeActivity(cells: List<ActivityCellModel>): ActivitySummary {
    val past = cells.filter { !it.pad && !it.future }
    val reported = past.filter { it.total != null }
    return ActivitySummary(
        reported = reported.size,
        active = reported.count { (it.total ?: 0.0) > 0.0 },
        past = past.size,
        total = reported.sumOf { it.total ?: 0.0 },
        missing = past.count { it.total == null },
    )
}

data class HistoryRetain(val days: List<HistoryDay>, val keptCost: Boolean, val keptComponents: Boolean)

fun historyHasComponents(day: HistoryDay): Boolean =
    day.tokenComponentsAvailable != null || day.cacheReadTokens != null || day.outputTokens != null ||
        day.cacheWriteTokens != null || day.unclassifiedTokens != null

/** Copy cost and components from the previous day only when the token total still matches. */
fun retainHistoryDays(next: List<HistoryDay>, previous: List<HistoryDay>): HistoryRetain {
    var keptCost = false
    var keptComponents = false
    val days = next.map { point ->
        val prior = previous.find { it.day == point.day }
        if (prior == null || prior.tokens != point.tokens) return@map point
        val retainsCost = point.costUsd == null && prior.costUsd != null
        val retainsComponents = !historyHasComponents(point) && historyHasComponents(prior)
        if (!retainsCost && !retainsComponents) return@map point
        keptCost = keptCost || retainsCost
        keptComponents = keptComponents || retainsComponents
        point.copy(
            costUsd = if (retainsCost) prior.costUsd else point.costUsd,
            perClient = if (retainsComponents) prior.perClient else point.perClient,
            perModel = if (retainsComponents) prior.perModel else point.perModel,
            outputTokens = if (retainsComponents) prior.outputTokens else point.outputTokens,
            cacheReadTokens = if (retainsComponents) prior.cacheReadTokens else point.cacheReadTokens,
            cacheWriteTokens = if (retainsComponents) prior.cacheWriteTokens else point.cacheWriteTokens,
            unclassifiedTokens = if (retainsComponents) prior.unclassifiedTokens else point.unclassifiedTokens,
            tokenComponentsAvailable = if (retainsComponents) prior.tokenComponentsAvailable else point.tokenComponentsAvailable,
            componentsPartial = if (retainsComponents) prior.componentsPartial else point.componentsPartial,
        )
    }
    return HistoryRetain(days, keptCost, keptComponents)
}

fun modelsCsv(periodLabel: String, models: List<UsageEntity>): String {
    fun cell(value: String): String {
        val safe = if (value.trimStart().firstOrNull() in listOf('=', '+', '-', '@', '\t', '\r')) "'$value" else value
        return "\"${safe.replace("\"", "\"\"")}\""
    }
    val lines = mutableListOf("模型,周期,总词元,缓存读取,缓存占比,费用美元")
    models.forEach { model ->
        lines += listOf(
            model.name,
            periodLabel,
            model.totalTokens.toString(),
            if (model.components.cacheReadKnown) model.components.cacheRead.toString() else "未提供",
            model.components.cacheRate?.let(Format::fmtPct) ?: "未提供",
            model.costUsd?.toString().orEmpty(),
        ).joinToString(",", transform = ::cell)
    }
    return "\uFEFF" + lines.joinToString("\r\n") + "\r\n"
}
