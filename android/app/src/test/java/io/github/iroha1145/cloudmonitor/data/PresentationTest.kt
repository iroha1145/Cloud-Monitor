package io.github.iroha1145.cloudmonitor.data

import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PresentationTest {
    @Test fun noticesSplitForwardingFromPendingSnapshots() {
        val notes = workspaceNotices(
            Overview(
                forwardingOutbox = 2,
                pendingOutbox = 5,
                expiredUnconfirmedOutbox = 1,
                partialErrors = listOf("history_unavailable"),
                partial = true,
            ),
        )
        assertTrue(notes.any { it.contains("2 条上报等待服务恢复后确认") })
        assertTrue(notes.any { it.contains("3 条快照等待同步") })
        assertTrue(notes.any { it.contains("1 条较早的上报未能完成同步") })
        assertTrue(notes.any { it.contains("官方历史记录暂时不可用") })
        assertTrue(notes.none { it.contains("部分辅助数据暂不可用") })
    }

    @Test fun unknownLimitStatusStillProducesANotice() {
        val notes = workspaceNotices(
            Overview(limits = listOf(LimitProvider(provider = "openai", status = "mystery"))),
        )
        assertEquals(listOf("OpenAI 额度状态暂时无法识别，等待同步。"), notes)
    }

    @Test fun sessionActivityFollowsTheWebWindow() {
        val generated = "2026-10-07T12:00:00Z"
        val running = SessionRow(
            lastUsedAt = "2026-10-07T11:55:00Z",
            deviceStale = false,
            turnEnded = false,
        )
        assertEquals("运行中", sessionActivity(running, generated))
        assertEquals("已完成", sessionActivity(running.copy(turnEnded = true), generated))
        assertEquals("闲置", sessionActivity(running.copy(archived = true), generated))
        assertEquals("闲置", sessionActivity(running.copy(lastUsedAt = "2026-10-07T11:40:00Z"), generated))
        assertEquals("状态未提供", sessionActivity(running.copy(deviceStale = null), generated))
        assertEquals(
            "未命名会话",
            sessionTitle(SessionRow()),
        )
        assertEquals("评审会话", sessionTitle(SessionRow(title = "评审会话", project = "其他")))
    }

    @Test fun sessionContextRoundsLikeTheWeb() {
        val session = SessionRow(contextTokens = 25000.0, contextWindow = 100000.0)
        assertEquals(25 to 75, sessionContext(session))
        assertNull(sessionContext(session.copy(contextWindow = 0.0)))
        assertNull(sessionContext(session.copy(contextTokens = null)))
    }

    @Test fun quotaHeadlinePrefersCreditsRemainingAndPreservesMissingUnits() {
        val credits = LimitWindow(metric = "credits", remaining = 1800.0, currency = "CREDITS")
        assertEquals(QuotaHeadline("1,800", "剩余点数"), quotaHeadline(credits, LimitProvider()))
        val spend = LimitWindow(metric = "spend", used = 12.5, currency = null)
        assertEquals(QuotaHeadline("12.5（单位未提供）", "已用"), quotaHeadline(spend, LimitProvider(provider = "openai")))
        val percent = LimitWindow(metric = "percentage", usedPercent = 90.0)
        assertEquals(QuotaHeadline("90%", "已用"), quotaHeadline(percent, LimitProvider()))
        assertEquals("到期", quotaBoundaryLabel("expiry"))
        assertEquals("重置", quotaBoundaryLabel(null))
    }

    @Test fun balanceTranchesAndMatrixLevelsMatchTheWeb() {
        val provider = LimitProvider(
            balance = buildJsonObject {
                put("currency", "USD")
                put("tranches", buildJsonArray {
                    add(buildJsonObject {
                        put("amount", 3.5)
                        put("currency", "USD")
                        put("expiresAt", "2026-12-01T00:00:00Z")
                    })
                    add(buildJsonObject { put("amount", JsonPrimitive("nope")) })
                })
            },
        )
        val tranches = balanceTranches(provider)
        assertEquals(1, tranches.size)
        assertEquals(3.5, tranches.first().amount, 0.0)
        assertEquals(0, matrixHeatLevel(0.0, 100.0))
        assertEquals(1, matrixHeatLevel(1.0, 100.0))
        assertEquals(4, matrixHeatLevel(100.0, 100.0))
        assertEquals(0, activityHeatLevel(0.0, 10.0))
        assertNull(activityHeatLevel(null, 10.0))
        assertEquals(4, activityHeatLevel(10.0, 10.0))
    }
}
