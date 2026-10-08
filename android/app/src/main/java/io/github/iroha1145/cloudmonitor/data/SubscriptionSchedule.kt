package io.github.iroha1145.cloudmonitor.data

import java.time.LocalDate
import java.time.YearMonth
import kotlin.math.max
import kotlin.math.min

/**
 * Same projection as `subscriptionDisplay.nextRenewalDate` and the web dashboard.
 * A future override wins; a past override is ignored. The anchor day is the
 * original start day, so a 31st does not collapse after February.
 */
fun nextRenewalDate(
    kind: String?,
    autoRenew: Boolean,
    nextRenewalOverride: String?,
    startDate: String?,
    interval: String?,
    intervalCount: Int,
    today: LocalDate = LocalDate.now(),
): String? {
    if (kind.equals("topup", ignoreCase = true) || !autoRenew) return null
    val todayText = today.toString()
    val override = calendarDay(nextRenewalOverride)
    if (override != null && override >= todayText) return override
    val anchor = calendarDay(startDate)?.let(LocalDate::parse) ?: return null
    if (calendarDay(todayText) == null) return null
    val step = renewalStepMonths(interval, intervalCount)
    val monthsElapsed = (today.year - anchor.year) * 12 + (today.monthValue - anchor.monthValue)
    var periods = max(0, monthsElapsed / step)
    var candidate = addMonthsAnchored(anchor, periods * step)
    while (candidate.toString() < todayText) {
        periods += 1
        candidate = addMonthsAnchored(anchor, periods * step)
    }
    while (periods > 0) {
        val previous = addMonthsAnchored(anchor, (periods - 1) * step)
        if (previous.toString() < todayText) break
        periods -= 1
        candidate = previous
    }
    return candidate.toString()
}

private val calendarDayPattern = Regex("""^\d{4}-\d{2}-\d{2}$""")

private fun calendarDay(value: String?): String? {
    val head = value?.trim().orEmpty().take(10)
    if (!calendarDayPattern.matches(head)) return null
    return runCatching { LocalDate.parse(head).toString() }.getOrNull()?.takeIf { it == head }
}

private fun renewalStepMonths(interval: String?, count: Int): Int {
    val unit = if (interval?.trim()?.lowercase() == "year") 12 else 1
    return unit * count.coerceIn(1, 24)
}

private fun addMonthsAnchored(anchor: LocalDate, monthsToAdd: Int): LocalDate {
    val total = anchor.year * 12 + (anchor.monthValue - 1) + monthsToAdd
    val year = Math.floorDiv(total, 12)
    val month = Math.floorMod(total, 12) + 1
    val day = min(anchor.dayOfMonth, YearMonth.of(year, month).lengthOfMonth())
    return LocalDate.of(year, month, day)
}
