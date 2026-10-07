package io.github.iroha1145.cloudmonitor.data

import androidx.compose.ui.graphics.toArgb
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ParityTest {
    @Test fun auxiliaryFailureKeepsCostAndComponentsWhenTokensMatch() {
        val previous = listOf(
            HistoryDay(day = "2026-08-25", tokens = 100.0, costUsd = 1.5, cacheReadTokens = 40.0, tokenComponentsAvailable = true),
            HistoryDay(day = "2026-08-26", tokens = 80.0, costUsd = 2.0, cacheReadTokens = 10.0, tokenComponentsAvailable = true),
        )
        val next = listOf(
            HistoryDay(day = "2026-08-25", tokens = 100.0),
            HistoryDay(day = "2026-08-26", tokens = 90.0),
            HistoryDay(day = "2026-08-27", tokens = 10.0, costUsd = 0.2),
        )
        val retained = retainHistoryDays(next, previous)
        assertTrue(retained.keptCost)
        assertTrue(retained.keptComponents)
        assertEquals(1.5, retained.days[0].costUsd!!, 0.0)
        assertEquals(40.0, retained.days[0].cacheReadTokens!!, 0.0)
        assertNull(retained.days[1].costUsd)
        assertNull(retained.days[1].cacheReadTokens)
        assertEquals(0.2, retained.days[2].costUsd!!, 0.0)
    }

    @Test fun hourlyActivityUsesTheFourWebStates() {
        val ready = resolveHourly(
            Activity(hourlyToday = HourlyToday(day = "2026-08-25", buckets = listOf(HourBucket(3, 10.0)))),
            hourlyEnabled = true,
            today = "2026-08-25",
        )
        assertEquals(HourlyStatus.Ready, ready.status)
        assertEquals(10.0, ready.totals[3]!!, 0.0)
        assertEquals("", hourlyMessage(ready.status))

        val disabled = resolveHourly(
            Activity(hourlyToday = HourlyToday(day = "2026-08-25", buckets = listOf(HourBucket(3, 10.0)))),
            hourlyEnabled = false,
            today = "2026-08-25",
        )
        assertEquals(HourlyStatus.Disabled, disabled.status)
        assertTrue(disabled.totals.isEmpty())
        assertEquals("服务尚未启用小时活动。", hourlyMessage(disabled.status))

        val mismatch = resolveHourly(
            Activity(hourlyToday = HourlyToday(day = "2026-08-24", buckets = listOf(HourBucket(3, 10.0)))),
            hourlyEnabled = true,
            today = "2026-08-25",
        )
        assertEquals(HourlyStatus.DateMismatch, mismatch.status)
        assertTrue(mismatch.totals.isEmpty())
        assertEquals("小时记录与当前数据的日期不一致，已暂不展示。", hourlyMessage(mismatch.status))

        val missing = resolveHourly(Activity(), hourlyEnabled = true, today = "2026-08-25")
        assertEquals(HourlyStatus.Unavailable, missing.status)
        assertEquals("当前数据未提供小时活动，未上报时段保留为未知。", hourlyMessage(missing.status))

        val cells = activityCells(0, "2026-08-25", Overview(
            features = Features(activityHourly = false),
            activity = Activity(hourlyToday = HourlyToday(day = "2026-08-25", buckets = listOf(HourBucket(1, 8.0)))),
            dashboardPeriod = DashboardPeriod(today = PeriodKey("2026-08-25")),
        ))
        assertEquals(24, cells.size)
        assertTrue(cells.all { it.total == null })
        assertEquals(14, cellEnterDelayMs(cells[6].column, cells[6].row))
    }

    @Test fun compositionOrderMatchesTheWebPalette() {
        val parts = UsageComponents(
            input = 1.0, output = 2.0, cacheRead = 3.0, cacheWrite = 4.0, unclassified = 5.0, known = true,
        )
        assertEquals(
            listOf("cacheRead", "input", "output", "cacheWrite", "unclassified"),
            componentSegments(parts).map { it.key },
        )
    }

    @Test fun quotaBarColorsFollowTheWebThresholds() {
        assertEquals(0xFF27847F.toInt(), quotaBarColor(0, 10.0).toArgb())
        assertEquals(0xFF428AB5.toInt(), quotaBarColor(1, 74.0).toArgb())
        assertEquals(0xFFB78246.toInt(), quotaBarColor(2, null).toArgb())
        assertEquals(0xFFDBA54A.toInt(), quotaBarColor(1, 75.0).toArgb())
        assertEquals(0xFFCB7065.toInt(), quotaBarColor(0, 90.0).toArgb())
        assertEquals(0xFF27847F.toInt(), quotaBarColor(3, 0.0).toArgb())
    }

    @Test fun coverageCopyAndDeviceNoticesMatchTheWeb() {
        assertEquals("增量采样", samplingModeLabel("delta"))
        assertEquals("采样覆盖不足", samplingModeLabel("delta-low-coverage"))
        assertEquals("采样含计数重置", samplingModeLabel("delta-with-reset"))
        assertEquals("暂无可归属采样", samplingModeLabel("none"))
        assertEquals("归属方式未提供", samplingModeLabel(null))
        val activity = Activity(
            dailyMixedBasis = true,
            dailyArchiveCutoverDay = "2026-01-01",
            dailyDayBasis = "hybrid-dashboard-and-device-local",
        )
        assertEquals(
            "历史活动包含设备本地日（2026-01-01及之前），跨时区设备不可视为同一日期。",
            dailyBasisNotice(activity),
        )
        assertEquals("每日记录按设备本地日期汇总。", dailyBasisNotice(Activity(dailyDayBasis = "device-local")))
        val overview = Overview(devices = listOf(Device(deviceId = "a", hostname = "studio", ageMs = 9_000_000.0)))
        val notes = workspaceNotices(overview)
        assertTrue(notes.any { it == "studio 当前离线，已保留最近一次用量。" })
        val delayed = Overview(devices = listOf(Device(deviceId = "b", hostname = "laptop", ageMs = 700_000.0)))
        assertTrue(workspaceNotices(delayed).any { it.contains("上报有延迟") })
        assertFalse(workspaceNotices(Overview()).any { it.contains("沿用上次") })
        val retained = workspaceNotices(Overview(), historyCostRetained = true, historyComponentsRetained = true)
        assertTrue(retained.any { it.contains("先沿用上次的费用") })
        assertTrue(retained.any { it.contains("先沿用上次的组成") })
    }
}
