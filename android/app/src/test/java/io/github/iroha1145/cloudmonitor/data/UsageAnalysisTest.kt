package io.github.iroha1145.cloudmonitor.data

import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.junit.Assert.*
import org.junit.Test
import kotlin.random.Random

class UsageAnalysisTest {
    private val json = Json {
        ignoreUnknownKeys = true
        coerceInputValues = true
        explicitNulls = false
    }

    private fun rows(vararg rows: String): List<TrendRow> = analyzeTrend(
        json.decodeFromString<Overview>("""{"totals":{},"trend":[${rows.joinToString(",")}]}"""),
    )

    private fun complete(day: String, total: Int, cache: Int, cost: String = "null"): String =
        """{"day":"$day","total":$total,"cacheReadTokens":$cache,"outputTokens":0,"cacheWriteTokens":0,"unclassifiedTokens":0,"tokenComponentsAvailable":true,"componentsPartial":false,"costUsd":$cost}"""

    private fun fixture(name: String): String = checkNotNull(javaClass.getResourceAsStream("/fixtures/$name")) {
        "Missing checked-in contract fixture $name"
    }.bufferedReader().use { it.readText() }

    @Test fun mixedMissingDaysUseTheSameNumeratorAndDenominator() {
        val result = summarizeTrend(rows(
            complete("2026-09-04", 100, 80),
            """{"day":"2026-09-05","total":900}""",
        ))
        assertEquals(1000.0, result.tokenTotal, 0.0)
        assertEquals(80.0, result.cacheTotal!!, 0.0)
        assertEquals(100.0, result.cacheTokenTotal, 0.0)
        assertEquals(0.8, result.cacheRate!!, 1e-12)
        assertEquals(1, result.cacheDays)
        assertEquals(1, result.cacheSkippedDays)
    }

    @Test fun rangeRatioIsWeightedByTokensRatherThanByDays() {
        val result = summarizeTrend(rows(complete("2026-09-04", 100, 80), complete("2026-09-05", 900, 90)))
        assertEquals(170.0, result.cacheTotal!!, 0.0)
        assertEquals(1000.0, result.cacheTokenTotal, 0.0)
        assertEquals(0.17, result.cacheRate!!, 1e-12)
        assertEquals(2, result.cacheDays)
    }

    @Test fun confirmedZeroUsageContributesWithoutInventingItsMissingDetails() {
        val series = rows(complete("2026-09-04", 100, 80), """{"day":"2026-09-05","total":0}""")
        assertTrue(series[1].zeroUsageConfirmed)
        assertNull(series[1].components)
        val result = summarizeTrend(series)
        assertEquals(2, result.cacheDays)
        assertEquals(0, result.cacheSkippedDays)
        assertEquals(0.8, result.cacheRate!!, 1e-12)
        val zeroOnly = summarizeTrend(listOf(series[1]))
        assertEquals(0.0, zeroOnly.cacheTotal!!, 0.0)
        assertNull(zeroOnly.cacheRate)
    }

    @Test fun explicitZeroCountsAreKnownButZeroOverZeroHasNoRatio() {
        val zero = rows(complete("2026-09-05", 0, 0)).single()
        assertTrue(zero.zeroUsageConfirmed)
        assertTrue(zero.components!!.cacheReadKnown)
        assertNull(zero.components!!.cacheRate)
        assertNull(summarizeTrend(listOf(zero)).cacheRate)
    }

    @Test fun missingAndInvalidTotalsAreNeverEvidenceOfZeroUsage() {
        for (total in listOf("", "\"total\":null,", "\"total\":-1,", "\"total\":\"0\",", "\"total\":false,")) {
            val series = rows(complete("2026-09-04", 100, 80),
                """{"day":"2026-09-05",${total}"cacheReadTokens":0,"outputTokens":0,"cacheWriteTokens":0,"unclassifiedTokens":0}""")
            assertFalse(total, series[1].zeroUsageConfirmed)
            assertFalse(total, series[1].components?.known == true)
            val result = summarizeTrend(series)
            assertEquals(total, 1, result.cacheDays)
            assertEquals(total, 1, result.cacheSkippedDays)
            assertEquals(0.8, result.cacheRate!!, 1e-12)
        }
    }

    @Test fun zeroTotalsWithContradictoryComponentsAreExcluded() {
        for (value in listOf("1", "-1", "\"0\"", "false")) {
            val series = rows(complete("2026-09-04", 100, 80),
                """{"day":"2026-09-05","total":0,"cacheReadTokens":$value}""")
            assertFalse(series[1].zeroUsageConfirmed)
            assertEquals(1, summarizeTrend(series).cacheDays)
            assertEquals(0.8, summarizeTrend(series).cacheRate!!, 1e-12)
        }
    }

    @Test fun malformedDailyCountersDoNotBecomeZeroDuringDecoding() {
        for (field in listOf("outputTokens", "cacheReadTokens", "cacheWriteTokens", "unclassifiedTokens")) {
            for (value in listOf("-1", "\"0\"", "false")) {
                val malformed = complete("2026-09-05", 300, 60)
                    .replace(Regex("\"$field\":\\d+"), "\"$field\":$value")
                val series = rows(complete("2026-09-04", 100, 80), malformed)
                assertNull("$field=$value", series[1].components)
                val result = summarizeTrend(series)
                assertEquals(400.0, result.tokenTotal, 0.0)
                assertEquals(1, result.cacheDays)
                assertEquals(100.0, result.cacheTokenTotal, 0.0)
            }
        }
    }

    @Test fun explicitZeroCacheWithOtherwiseUnclassifiedUsageStillParticipates() {
        val day = rows("""{"day":"2026-09-05","total":1000,"cacheReadTokens":0,"unclassifiedTokens":1000,"componentsPartial":true}""").single()
        val parts = day.components!!
        assertTrue(parts.known)
        assertTrue(parts.complete)
        assertTrue(parts.partial)
        assertFalse(parts.inputKnown)
        assertFalse(parts.outputKnown)
        assertFalse(parts.cacheWriteKnown)
        assertTrue(parts.cacheReadKnown)
        assertEquals(0.0, parts.cacheRate!!, 0.0)
        assertEquals("已识别缓存占比", parts.cacheLabel)
        val result = summarizeTrend(listOf(day))
        assertEquals(1, result.cacheDays)
        assertEquals(1000.0, result.cacheTokenTotal, 0.0)
        assertEquals(0.0, result.cacheRate!!, 0.0)
        assertTrue(result.partialCache)
    }

    @Test fun allMissingCacheAndEmptyRangesHaveNoCacheRatio() {
        val result = summarizeTrend(rows(
            """{"day":"2026-09-04","total":100}""",
            """{"day":"2026-09-05","total":300,"cacheReadTokens":null}""",
        ))
        assertEquals(400.0, result.tokenTotal, 0.0)
        assertEquals(0, result.cacheDays)
        assertEquals(2, result.cacheSkippedDays)
        assertNull(result.cacheTotal)
        assertNull(result.cacheRate)
        val empty = summarizeTrend(emptyList())
        assertNull(empty.cacheTotal)
        assertNull(empty.cacheRate)
        assertNull(empty.costTotal)
        assertFalse(empty.allCosts)
    }

    @Test fun missingFeesAndNegativeAdjustmentsRetainTheirMeaning() {
        val result = summarizeTrend(rows(
            complete("2026-09-03", 100, 40, "2"),
            complete("2026-09-04", 200, 80, "-0.5"),
            complete("2026-09-05", 300, 120),
        ))
        assertTrue(result.hasCost)
        assertFalse(result.allCosts)
        assertEquals(1.5, result.costTotal!!, 0.0)
        assertEquals(600.0, result.tokenTotal, 0.0)
    }

    @Test fun cacheComponentsThatExceedTheDaysTotalHaveNoRatio() {
        val day = rows("""{"day":"2026-09-05","total":100,"cacheReadTokens":90,"outputTokens":30,"unclassifiedTokens":0}""").single()
        assertFalse(day.components!!.complete)
        assertNull(day.components!!.cacheRate)
        assertEquals(0, summarizeTrend(listOf(day)).cacheDays)
    }

    @Test fun archiveFallbackRequiresMatchingTotalAndRespectsExplicitUnknownFields() {
        val overview = json.decodeFromString<Overview>("""{"totals":{},"trend":[
          {"day":"2026-09-03","total":100},
          {"day":"2026-09-04","total":100},
          {"day":"2026-09-05","total":100,"cacheReadTokens":null,"cacheWriteTokens":null,"outputTokens":null}
        ]}""")
        val history = json.decodeFromString<HistoryPage>("""{"items":[
          {"day":"2026-09-03","tokens":100,"cacheReadTokens":80,"unclassifiedTokens":0},
          {"day":"2026-09-04","tokens":200,"cacheReadTokens":180,"unclassifiedTokens":0},
          {"day":"2026-09-05","tokens":100,"cacheReadTokens":80,"cacheWriteTokens":0,"outputTokens":0,"unclassifiedTokens":0}
        ]}""")
        val series = analyzeTrend(overview, history.items)
        assertEquals(0.8, series[0].components!!.cacheRate!!, 1e-12)
        assertNull(series[1].components)
        assertFalse(series[2].components!!.cacheReadKnown)
        assertNull(series[2].components!!.cacheRate)
        assertEquals(1, summarizeTrend(series).cacheDays)
    }

    @Test fun currentPeriodCacheNeverReplacesHistoricalMissingFields() {
        val overview = json.decodeFromString<Overview>("""{"totals":{"today":{"totalTokens":100,"cacheReadTokens":90,"unclassifiedTokens":0}},"trend":[{"day":"2026-09-04","total":100}]}""")
        val first = analyzeTrend(overview)
        val changed = analyzeTrend(overview.copy(totals = Totals(today = PeriodTotals(
            totalTokens = 100.0, cacheReadTokens = 5.0, capabilities = Capabilities(true),
        ))))
        assertEquals(first, changed)
        assertNull(first.single().components)
    }

    @Test fun aggregateCapabilityDoesNotHideRecognizedModelFields() {
        val period = json.decodeFromString<PeriodTotals>("""{
          "capabilities":{"tokenComponents":false},"totalTokens":1000,
          "models":{"complete":600,"partial":400},
          "modelOutputs":{"complete":100,"partial":50},
          "modelCacheReads":{"complete":300,"partial":100},
          "modelCacheWrites":{},"modelUnclassifiedTokens":{"partial":200}
        }""")
        val models = modelUsage(period)
        assertEquals(listOf("complete", "partial"), models.map { it.id })
        val complete = models[0].components
        assertTrue(complete.known)
        assertFalse(complete.partial)
        assertEquals(200.0, complete.input, 0.0)
        assertEquals(0.5, complete.cacheRate!!, 1e-12)
        assertTrue(complete.cacheWriteKnown)
        val partial = models[1].components
        assertTrue(partial.partial)
        assertEquals(0.25, partial.cacheRate!!, 1e-12)
        assertEquals("已识别缓存占比", partial.cacheLabel)
        assertNull(models[0].costUsd)
    }

    @Test fun emptyEntityMapsDoNotInventUncachedInputEvenWhenPeriodIsCapable() {
        val period = json.decodeFromString<PeriodTotals>("""{
          "capabilities":{"tokenComponents":true},"totalTokens":1000,"models":{"unknown":1000},
          "modelOutputs":{},"modelCacheReads":{},"modelCacheWrites":{},"modelUnclassifiedTokens":{}
        }""")
        val parts = modelUsage(period).single().components
        assertFalse(parts.known)
        assertFalse(parts.cacheReadKnown)
        assertEquals(1000.0, parts.unclassified, 0.0)
        assertNull(parts.cacheRate)
    }

    @Test fun explicitEntityZeroIsEvidenceButAbsentLegacyCoverageKeepsTheRemainderUnknown() {
        val zero = json.decodeFromString<PeriodTotals>("""{"totalTokens":100,"models":{"m":100},"modelCacheReads":{"m":0},"modelUnclassifiedTokens":{}}""")
        assertEquals(0.0, modelUsage(zero).single().components.cacheRate!!, 0.0)
        val legacy = json.decodeFromString<PeriodTotals>("""{"totalTokens":1000,"models":{"m":1000},"modelCacheReads":{"m":400},"modelOutputs":{"m":100}}""")
        val parts = modelUsage(legacy).single().components
        assertEquals(0.0, parts.input, 0.0)
        assertFalse(parts.inputKnown)
        assertEquals(500.0, parts.unclassified, 0.0)
        assertTrue(parts.partial)
        assertEquals(0.4, parts.cacheRate!!, 1e-12)
    }

    @Test fun wholePeriodMissingCacheCannotDisplayZeroPercent() {
        val period = json.decodeFromString<PeriodTotals>("""{"totalTokens":1000,"outputTokens":100,"unclassifiedTokens":900}""")
        val parts = usageComponents(period)
        assertTrue(parts.outputKnown)
        assertFalse(parts.cacheReadKnown)
        assertNull(parts.cacheRate)
        assertNull(periodCost(period))
        assertFalse(usageComponents(PeriodTotals(totalTokens = 1000.0)).known)
    }

    @Test fun realOverviewContractFixturePreservesPartialFieldsAndModelTotals() {
        val overview = json.decodeFromString<Overview>(fixture("overview.json"))
        val period = overview.totals.today
        assertEquals(1_846_320.0, period.totalTokens, 0.0)
        assertFalse(period.capabilities.tokenComponents)
        val parts = usageComponents(period)
        assertTrue(parts.known)
        assertTrue(parts.partial)
        assertEquals(986_000.0, parts.cacheRead, 0.0)
        assertEquals(986_000.0 / 1_846_320.0, parts.cacheRate!!, 1e-12)
        val models = modelUsage(period)
        assertEquals(2, models.size)
        assertEquals(period.totalTokens, models.sumOf { it.totalTokens }, 0.0)
        assertEquals(4.82, periodCost(period)!!, 1e-12)
        assertTrue(models.all { it.components.cacheReadKnown })
        assertEquals(overview.trend.size, analyzeTrend(overview).size)
    }

    @Test fun realDailyArchiveContractFixtureParsesWithoutLosingCounts() {
        val history = json.decodeFromString<HistoryPage>(fixture("history_daily.json"))
        assertTrue(history.items.isNotEmpty())
        val normalized = history.items.map(::dailyUsage)
        assertEquals(history.items.sumOf { it.tokens }, summarizeTrend(normalized).tokenTotal, 0.0)
        history.items.zip(normalized).forEach { (day, row) ->
            assertEquals(day.day, row.day)
            assertEquals(day.tokens, row.total, 0.0)
            assertEquals(day.costUsd, row.costUsd)
            assertEquals(day.perModel, row.models)
        }
    }

    @Test fun serializationRoundTripRetainsMissingVersusExplicitNullVersusZero() {
        val text = """{"day":"2026-09-05","total":100,"cacheReadTokens":0,"cacheWriteTokens":null}"""
        val original = json.decodeFromString<TrendPoint>(text)
        val restored = json.decodeFromString<TrendPoint>(json.encodeToString(original))
        assertEquals(original.rawUsage, restored.rawUsage)
        assertTrue(restored.rawUsage!!.containsKey("cacheWriteTokens"))
        assertFalse(restored.rawUsage!!.containsKey("outputTokens"))
        assertEquals(0.0, restored.cacheReadTokens!!, 0.0)
    }

    @Test fun demoTrendsContainIndependentDailyComponentsAndMissingDays() {
        for (day in listOf("2026-01-01", "2026-02-28", "2026-09-05", "2026-12-31", "2028-03-01")) {
            val now = java.time.Instant.parse("${day}T00:00:00Z").toEpochMilli()
            val overview = DemoCatalog.overview(Random(42), now)
            val series = analyzeTrend(overview)
            assertEquals(day, 30, series.size)
            val result = summarizeTrend(series)
            assertTrue(day, result.cacheDays > 0)
            assertTrue(day, result.cacheSkippedDays > 0)
            assertTrue(day, series.any { it.zeroUsageConfirmed })
            assertTrue(day, series.mapNotNull { it.components?.cacheRate }.distinct().size > 3)
            val explicitZeroDays = series.filter {
                it.total > 0 && it.components?.cacheReadKnown == true && it.components?.cacheRead == 0.0
            }
            assertTrue("$day needs a recorded cache zero on a positive-usage day", explicitZeroDays.isNotEmpty())
            val zeroSummary = summarizeTrend(explicitZeroDays)
            assertEquals(explicitZeroDays.size, zeroSummary.cacheDays)
            assertEquals(explicitZeroDays.sumOf { it.total }, zeroSummary.cacheTokenTotal, 0.0)
            assertEquals(0.0, zeroSummary.cacheRate!!, 0.0)
            assertTrue(zeroSummary.partialCache)
            assertTrue(day, result.cacheTokenTotal < result.tokenTotal)
        }
    }
}
