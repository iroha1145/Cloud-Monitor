package io.github.iroha1145.cloudmonitor.data

import org.junit.Assert.assertEquals
import org.junit.Test

class FormatTest {
    @Test fun usdUsesTwoDecimalsAndKeepsSignOutsideTheDollar() {
        assertEquals("$0.00", Format.fmtUsd(0.0))
        assertEquals("$0.00", Format.fmtUsd(0.0034))
        assertEquals("-$0.00", Format.fmtUsd(-0.0034))
        assertEquals("$4.82", Format.fmtUsd(4.82))
        assertEquals("$1,234.56", Format.fmtUsd(1234.56))
        assertEquals("-$1,234.56", Format.fmtUsd(-1234.56))
    }

    @Test fun percentKeepsOneDecimalLikeTheWeb() {
        assertEquals("0.0%", Format.fmtPct(0.0))
        assertEquals("50.0%", Format.fmtPct(0.5))
        assertEquals("12.3%", Format.fmtPct(0.123))
        assertEquals("0.0%", Format.fmtPct(0.0004))
        assertEquals("—", Format.fmtPct(Double.NaN))
    }

    @Test fun compactKeepsWebDecimalsAndASpaceBeforeTheUnit() {
        assertEquals("1,234", Format.fmtCompact(1234.0))
        assertEquals("1.2 万", Format.fmtCompact(12_000.0))
        assertEquals("12.0 万", Format.fmtCompact(120_000.0))
        assertEquals("70.0 万", Format.fmtCompact(700_000.0))
        assertEquals("98.6 万", Format.fmtCompact(986_000.0))
        assertEquals("1.20 亿", Format.fmtCompact(120_000_000.0))
        assertEquals("1.00 亿", Format.fmtCompact(1e8))
        assertEquals(Format.Compact("1", "亿"), Format.compactParts(99_995_000.0, tight = true))
    }

    @Test fun syncAgeUsesTheSnapshotAndAMonthlyPriceUsesTheWebSuffix() {
        assertEquals("刚刚同步", Format.relativeSync("2026-08-25T03:18:15.168Z", "2026-08-25T03:18:15.180Z"))
        assertEquals("2 天前同步", Format.relativeSync("2026-08-23T03:18:15Z", "2026-08-25T03:18:15Z"))
        assertEquals("尚无同步时间", Format.relativeSync(null, "2026-08-25T03:18:15Z"))
        assertEquals(" / 月", Format.subscriptionCadence("month", 1))
        assertEquals(" / 2 月", Format.subscriptionCadence("monthly", 2))
    }
}
