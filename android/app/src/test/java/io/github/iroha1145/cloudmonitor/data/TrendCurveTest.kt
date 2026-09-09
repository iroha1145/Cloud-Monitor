package io.github.iroha1145.cloudmonitor.data

import org.junit.Assert.*
import org.junit.Test

class TrendCurveTest {
    @Test fun latestDayIsFlattenedOnARisingSeries() {
        val xs = floatArrayOf(0f, 1f, 2f)
        val ys = floatArrayOf(2f, 10f, 40f)
        val slopes = monotoneTrendSlopes(xs, ys)
        assertEquals(0f, slopes.last())
        assertTrue(slopes[0] > 0f)
    }

    @Test fun twoDaysEaseIntoAFlatLatestPoint() {
        val xs = floatArrayOf(0f, 1f)
        val ys = floatArrayOf(1f, 9f)
        val slopes = monotoneTrendSlopes(xs, ys)
        assertEquals(2, slopes.size)
        assertEquals(0f, slopes[1])
        assertTrue(slopes[0] > 0f)
    }

    @Test fun aPeakGetsAFlatTangentWithoutOvershootingNeighbors() {
        val xs = floatArrayOf(0f, 1f, 2f, 3f)
        val ys = floatArrayOf(2f, 100f, 1f, 80f)
        val slopes = monotoneTrendSlopes(xs, ys)
        assertEquals(0f, slopes[1], 0f)
        assertEquals(0f, slopes.last())
    }
}