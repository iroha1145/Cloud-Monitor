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

    @Test fun percentStripsTrailingPointZero() {
        assertEquals("50%", Format.fmtPct(0.5))
        assertEquals("12.3%", Format.fmtPct(0.123))
        assertEquals("<0.1%", Format.fmtPct(0.0004))
        assertEquals("—", Format.fmtPct(Double.NaN))
    }

    @Test fun compactCarriesWanIntoYiAndKeepsPlainThousands() {
        assertEquals("1,234", Format.fmtCompact(1234.0))
        assertEquals(Format.Compact("1.2", "万"), Format.compactParts(12_000.0))
        assertEquals(Format.Compact("1", "亿"), Format.compactParts(99_995_000.0, tight = true))
        assertEquals(Format.Compact("1.2", "亿"), Format.compactParts(120_000_000.0))
        val yi = Format.compactParts(1e8)
        assertEquals("亿", yi.u)
        assertEquals("1", yi.n)
    }
}
