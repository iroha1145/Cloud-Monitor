package io.github.iroha1145.cloudmonitor.data

import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.time.Instant
import java.time.ZoneId
import kotlin.math.max
import kotlin.math.pow
import kotlin.math.roundToInt
import kotlin.random.Random

object DemoCatalog {
    private val MODELS = listOf("claude-opus-4.1", "claude-sonnet-4.5", "gpt-5-codex")
    private val CLIENTS = listOf("claude", "codex", "cursor")
    private val AFFINITY = mapOf(
        "claude" to mapOf("claude-opus-4.1" to 0.52, "claude-sonnet-4.5" to 0.48),
        "codex" to mapOf("gpt-5-codex" to 0.94, "claude-sonnet-4.5" to 0.06),
        "cursor" to mapOf("claude-sonnet-4.5" to 0.62, "claude-opus-4.1" to 0.23, "gpt-5-codex" to 0.15),
    )
    private val CLIENT_SHARE = mapOf("claude" to 0.46, "codex" to 0.33, "cursor" to 0.21)
    private val COST_PER_M = mapOf("claude-opus-4.1" to 12.5, "claude-sonnet-4.5" to 4.8, "gpt-5-codex" to 7.2)
    private val CACHE_HIT = mapOf("claude-opus-4.1" to 0.62, "claude-sonnet-4.5" to 0.39, "gpt-5-codex" to 0.17)
    private val PROJECTS = listOf("cloud-monitor", "stitch-ui", "data-pipeline")
    private const val DAY = 86_400_000L

    private fun demoZone(): ZoneId = ZoneId.of("Asia/Shanghai")

    private fun Random.rand(a: Double, b: Double) = a + nextDouble() * (b - a)
    private fun Random.randInt(a: Int, b: Int) = nextInt(a, b + 1)
    private fun clamp0(v: Double) = max(0.0, kotlin.math.round(v))

    /** 已安装未用量客户端走官方 overall=waiting，避免 collection.direct 被误判为健康。 */
    private fun demoHealthEntry(st: String, version: String) = when (st) {
        "waiting", "warn" -> buildJsonObject {
            put("overall", "waiting")
            put("version", version)
            put("source", buildJsonObject { put("state", "detected") })
            put("collection", buildJsonObject { put("state", "direct") })
            put("data", buildJsonObject { put("liveTokens", 0) })
        }
        else -> buildJsonObject {
            put("status", st)
            put("version", version)
        }
    }

    private fun cnDay(offset: Int, now: Long): String =
        Instant.ofEpochMilli(now).atZone(demoZone()).toLocalDate().minusDays(offset.toLong()).toString()

    private fun utcHour(offsetMs: Long, now: Long): String =
        Instant.ofEpochMilli(now - offsetMs).toString()

    data class Hist(val day: String, val tokens: Double, val costUsd: Double, val perClient: Map<String, Double>, val perModel: Map<String, Double>)

    private fun buildHistory(rng: Random, now: Long): List<Hist> {
        val out = ArrayList<Hist>(370)
        for (i in 369 downTo 1) {
            val t = now - i * DAY
            val dow = Instant.ofEpochMilli(t).atZone(demoZone()).dayOfWeek.value
            val weekend = dow >= 6
            val weekday = if (weekend) rng.rand(0.34, 0.58) else rng.rand(0.86, 1.18)
            val growth = 0.55 + (1 - i / 370.0) * 0.75
            val spike = if (rng.nextDouble() < 0.06) rng.rand(1.5, 2.1) else 1.0
            val tokens = if (i % 17 == 0) 0.0 else clamp0(3_200_000 * weekday * growth * spike * rng.rand(0.82, 1.18))
            val cs = CLIENTS.associateWith { c -> (CLIENT_SHARE[c] ?: 0.0) * rng.rand(0.8, 1.2) }
            val csSum = cs.values.sum()
            val perClient = CLIENTS.associateWith { c -> clamp0(tokens * (cs[c] ?: 0.0) / csSum) }
            val gptW = 0.14 + (1 - i / 370.0) * 0.16
            val ms = mapOf(
                "claude-opus-4.1" to (0.34 - (1 - i / 370.0) * 0.08) * rng.rand(0.85, 1.15),
                "claude-sonnet-4.5" to (0.52 - (1 - i / 370.0) * 0.08) * rng.rand(0.85, 1.15),
                "gpt-5-codex" to gptW * rng.rand(0.85, 1.15),
            )
            val msSum = MODELS.sumOf { ms[it] ?: 0.0 }
            var cost = 0.0
            val perModel = MODELS.associateWith { m ->
                val v = clamp0(tokens * (ms[m] ?: 0.0) / msSum)
                cost += (v / 1e6) * (COST_PER_M[m] ?: 0.0)
                v
            }
            out += Hist(cnDay(i, now), tokens, kotlin.math.round(cost * 100) / 100.0, perClient, perModel)
        }
        return out
    }

    /** Synthetic daily snapshots vary by date, independently of today's component mix. */
    private fun dailySample(h: Hist): HistoryDay {
        val sample = HistoryDay(h.day, h.tokens, h.costUsd, h.perClient, h.perModel, 2)
        // A calendar cycle guarantees every 30-day window contains each example.
        // A date-string hash can cluster by month and omit explicit cache-zero days.
        val index = Math.floorMod(java.time.LocalDate.parse(h.day).toEpochDay(), 14L).toInt()
        // Retain some older days with no component evidence, and genuine unused days.
        if (index == 0 || index == 7 || h.tokens == 0.0) return sample
        // A recorded cache zero remains useful even with otherwise unclassified usage.
        if (index == 4 || index == 11) return sample.copy(
            cacheReadTokens = 0.0, unclassifiedTokens = h.tokens,
            tokenComponentsAvailable = false, componentsPartial = true,
        )
        val partial = index % 5 == 0
        return sample.copy(
            outputTokens = clamp0(h.tokens * 0.16),
            cacheReadTokens = clamp0(h.tokens * (0.12 + (index % 7) * 0.06)),
            cacheWriteTokens = clamp0(h.tokens * 0.04),
            unclassifiedTokens = if (partial) clamp0(h.tokens * 0.12) else 0.0,
            tokenComponentsAvailable = !partial, componentsPartial = partial,
        )
    }

    private fun HistoryDay.asTrendPoint(): TrendPoint = TrendPoint(
        day, tokens, costUsd, outputTokens, cacheReadTokens, cacheWriteTokens,
        unclassifiedTokens, tokenComponentsAvailable, componentsPartial,
    )

    private fun periodFrom(rng: Random, totalTokens: Double, modelTokens: Map<String, Double>, clientTokens: Map<String, Double>): PeriodTotals {
        val output = clamp0(totalTokens * rng.rand(0.16, 0.2))
        val cacheWrite = clamp0(totalTokens * rng.rand(0.06, 0.09))
        val unclassified = clamp0(totalTokens * rng.rand(0.004, 0.012))
        val outShare = if (totalTokens > 0) output / totalTokens else 0.0
        val writeShare = if (totalTokens > 0) cacheWrite / totalTokens else 0.0
        val unclsShare = if (totalTokens > 0) unclassified / totalTokens else 0.0
        val room = max(0.0, 0.92 - outShare - writeShare - unclsShare)
        val modelCosts = mutableMapOf<String, Double>()
        val modelOutputs = mutableMapOf<String, Double>()
        val modelWrites = mutableMapOf<String, Double>()
        val modelUncls = mutableMapOf<String, Double>()
        val modelReads = mutableMapOf<String, Double>()
        var costSum = 0.0
        for (m in MODELS) {
            val v = clamp0(modelTokens[m] ?: 0.0)
            modelCosts[m] = kotlin.math.round((v / 1e6) * (COST_PER_M[m] ?: 0.0) * 100) / 100.0
            modelOutputs[m] = clamp0(v * outShare)
            modelWrites[m] = clamp0(v * writeShare)
            modelUncls[m] = clamp0(v * unclsShare)
            val hit = minOf(CACHE_HIT[m] ?: 0.35, room) * rng.rand(0.97, 1.03)
            modelReads[m] = clamp0(v * hit)
            costSum += modelCosts[m] ?: 0.0
        }
        val cacheRead = MODELS.sumOf { modelReads[it] ?: 0.0 }
        val clients = mutableMapOf<String, Double>()
        val clientCosts = mutableMapOf<String, Double>()
        val clientModels = mutableMapOf<String, Map<String, Double>>()
        val clientOutputs = mutableMapOf<String, Double>()
        val clientReads = mutableMapOf<String, Double>()
        val clientWrites = mutableMapOf<String, Double>()
        val clientUncls = mutableMapOf<String, Double>()
        for (c in CLIENTS) {
            val v = clamp0(clientTokens[c] ?: 0.0)
            clients[c] = v
            val aff = AFFINITY[c] ?: emptyMap()
            val affSum = aff.values.sum().coerceAtLeast(1e-9)
            val cm = mutableMapOf<String, Double>()
            var cCost = 0.0
            for ((m, shareRaw) in aff) {
                val share = shareRaw / affSum
                if (share <= 0.005) continue
                val mv = clamp0(v * share * rng.rand(0.92, 1.08))
                if (mv <= 0) continue
                cm[m] = mv
                cCost += (mv / 1e6) * (COST_PER_M[m] ?: 0.0)
            }
            clientModels[c] = cm
            clientCosts[c] = kotlin.math.round(cCost * 100) / 100.0
            clientOutputs[c] = clamp0(v * outShare)
            clientReads[c] = clamp0(v * (if (totalTokens > 0) cacheRead / totalTokens else 0.0))
            clientWrites[c] = clamp0(v * writeShare)
            clientUncls[c] = clamp0(v * unclsShare)
        }
        val clientModelCosts = clientModels.mapValues { (_, models) ->
            models.mapValues { (m, tokens) ->
                kotlin.math.round((tokens / 1e6) * (COST_PER_M[m] ?: 0.0) * 100) / 100.0
            }
        }
        return PeriodTotals(
            capabilities = Capabilities(tokenComponents = true),
            totalTokens = totalTokens,
            costUsd = kotlin.math.round(costSum * 100) / 100.0,
            cacheReadTokens = cacheRead,
            cacheWriteTokens = cacheWrite,
            outputTokens = output,
            unclassifiedTokens = unclassified,
            timedTokens = clamp0(totalTokens * rng.rand(0.6, 0.8)),
            timedOutputTokens = clamp0(output * rng.rand(0.75, 0.95)),
            timedDurationMs = (rng.randInt(6, 16) * 3_600_000 + rng.randInt(0, 59) * 60_000).toDouble(),
            clients = clients,
            clientCosts = clientCosts,
            clientCacheReads = clientReads,
            clientCacheWrites = clientWrites,
            clientOutputs = clientOutputs,
            clientUnclassifiedTokens = clientUncls,
            models = MODELS.associateWith { clamp0(modelTokens[it] ?: 0.0) },
            modelCosts = modelCosts,
            modelCacheReads = modelReads,
            modelCacheWrites = modelWrites,
            modelOutputs = modelOutputs,
            modelUnclassifiedTokens = modelUncls,
            clientModels = clientModels,
            clientModelCosts = clientModelCosts,
        )
    }

    fun overview(rng: Random = Random.Default, now: Long = System.currentTimeMillis()): Overview {
        val history = buildHistory(rng, now)
        val todayTokens = rng.randInt(3_800_000, 5_200_000).toDouble()
        val todayModelShares = mapOf("claude-opus-4.1" to 0.28, "claude-sonnet-4.5" to 0.42, "gpt-5-codex" to 0.3)
        val todayModels = MODELS.associateWith { todayTokens * (todayModelShares[it] ?: 0.0) * rng.rand(0.9, 1.1) }
        val todayClients = CLIENTS.associateWith { todayTokens * (CLIENT_SHARE[it] ?: 0.0) * rng.rand(0.9, 1.1) }
        val thisMonth = cnDay(0, now).take(7)
        var monthTokens = todayTokens
        val monthModels = todayModels.toMutableMap()
        val monthClients = todayClients.toMutableMap()
        var allTokens = todayTokens
        val allModels = todayModels.toMutableMap()
        val allClients = todayClients.toMutableMap()
        for (h in history) {
            allTokens += h.tokens
            for (m in MODELS) allModels[m] = (allModels[m] ?: 0.0) + (h.perModel[m] ?: 0.0)
            for (c in CLIENTS) allClients[c] = (allClients[c] ?: 0.0) + (h.perClient[c] ?: 0.0)
            if (h.day.take(7) == thisMonth) {
                monthTokens += h.tokens
                for (m in MODELS) monthModels[m] = (monthModels[m] ?: 0.0) + (h.perModel[m] ?: 0.0)
                for (c in CLIENTS) monthClients[c] = (monthClients[c] ?: 0.0) + (h.perClient[c] ?: 0.0)
            }
        }
        var today = periodFrom(rng, todayTokens, todayModels, todayClients)
        today = today.copy(
            clients = today.clients + mapOf(
                "deepseek" to clamp0(todayTokens * 0.07),
                "kimi" to clamp0(todayTokens * 0.05),
            ),
            models = today.models + mapOf(
                "deepseek-chat" to clamp0(todayTokens * 0.05),
                "kimi-k2" to clamp0(todayTokens * 0.04),
                "grok-4.6" to clamp0(todayTokens * 0.03),
            ),
        )
        val totals = Totals(
            today = today,
            month = periodFrom(rng, monthTokens, monthModels, monthClients),
            allTime = periodFrom(rng, allTokens, allModels, allClients),
        )
        val trend = mutableListOf<TrendPoint>()
        val trendModels = mutableListOf<TrendModelsPoint>()
        for (i in 29 downTo 1) {
            val h = history[history.size - i]
            trend += dailySample(h).asTrendPoint()
            trendModels += TrendModelsPoint(h.day, h.tokens, h.perModel)
        }
        trend += TrendPoint(
            cnDay(0, now), todayTokens, today.costUsd, today.outputTokens, today.cacheReadTokens,
            today.cacheWriteTokens, today.unclassifiedTokens,
            tokenComponentsAvailable = today.capabilities.tokenComponents,
            componentsPartial = today.unclassifiedTokens > 0,
        )
        trendModels += TrendModelsPoint(cnDay(0, now), todayTokens, todayModels)

        val daily = history.takeLast(89).map { DailyPoint(it.day, it.tokens, it.perModel) } +
            DailyPoint(cnDay(0, now), todayTokens, todayModels)

        val nowHour = Instant.ofEpochMilli(now).atZone(demoZone()).hour
        val weights = (0 until 24).map { h ->
            if (h > nowHour) 0.0
            else {
                val dayCurve = kotlin.math.exp(-((h - 14).toDouble().pow(2)) / 42)
                val nightCurve = kotlin.math.exp(-((h - 1).toDouble().pow(2)) / 18) * 0.35
                (0.18 + dayCurve + nightCurve) * rng.rand(0.7, 1.3)
            }
        }
        val wSum = weights.sum()
        val hourly = weights.mapIndexed { h, w ->
            HourBucket(h, if (wSum > 0) clamp0(todayTokens * w / wSum) else 0.0)
        }

        data class DevRaw(
            val deviceId: String, val hostname: String, val platform: String,
            val osName: String, val osVersion: String, val agentVersion: String,
            val agentRuntime: String, val sync: Double, val receivedOff: Long,
            val tracked: List<String>, val split: Double, val stale: Boolean,
            val projects: Boolean, val tz: String, val health: Map<String, String>,
            val status: String, val wsl: String?,
        )
        val devicesRaw = listOf(
            DevRaw("dev-mac-9f2ac1", "MacBook-Pro.local", "darwin", "macOS", "15.5", "1.4.2", "node v22.11.0", 300_000.0, rng.randInt(1, 4) * 60_000L, CLIENTS, 0.52, false, true, demoZone().id, mapOf("claude" to "healthy", "codex" to "healthy", "cursor" to "warn"), "3 个工具采集中", null),
            DevRaw("dev-win-47bd90", "Win11-Desktop", "win32", "Windows 11", "23H2", "1.4.2", "node v20.18.1", 300_000.0, rng.randInt(5, 9) * 60_000L, listOf("claude", "codex"), 0.31, false, true, demoZone().id, mapOf("claude" to "healthy", "codex" to "healthy"), "2 个工具采集中", "WSL2 运行中"),
            DevRaw("dev-ubu-e0538a", "ubuntu-server", "linux", "Ubuntu", "22.04 LTS", "1.3.7", "node v20.11.0", 600_000.0, rng.randInt(150, 220) * 60_000L, listOf("codex"), 0.17, true, false, "UTC", mapOf("codex" to "stale"), "采集暂停（设备离线）", null),
        )
        fun split(p: PeriodTotals, r: Double) = PeriodTotals(
            totalTokens = clamp0(p.totalTokens * r * rng.rand(0.92, 1.08)),
            costUsd = kotlin.math.round(p.costUsd * r * rng.rand(0.92, 1.08) * 100) / 100.0,
        )
        val devices = devicesRaw.map { d ->
            val recv = utcHour(d.receivedOff, now)
            Device(
                deviceId = d.deviceId, hostname = d.hostname, platform = d.platform,
                osName = d.osName, osVersion = d.osVersion, agentVersion = d.agentVersion,
                agentRuntime = d.agentRuntime, receivedAt = recv, updatedAt = recv,
                stale = d.stale, ageMs = d.receivedOff.toDouble(),
                syncUploadIntervalMs = d.sync, trackedClients = d.tracked,
                today = split(totals.today, d.split), month = split(totals.month, d.split),
                allTime = split(totals.allTime, d.split),
                projectsEnabled = d.projects, historyAvailable = !d.stale,
            )
        }
        val windows = devicesRaw.associate { d ->
            d.deviceId to DeviceWindows(
                timeZone = d.tz,
                today = PeriodKey(cnDay(0, now), Instant.ofEpochMilli(now + DAY).toString()),
                month = PeriodKey(thisMonth, Instant.ofEpochMilli(now + 10 * DAY).toString()),
            )
        }
        val diagnostics = devicesRaw.map { d ->
            Diagnostic(
                deviceId = d.deviceId,
                hostname = d.hostname,
                clientHealth = buildJsonObject {
                    d.health.forEach { (name, st) ->
                        put(name, demoHealthEntry(st, d.agentVersion))
                    }
                },
                clientStatus = JsonPrimitive(d.status),
                wslStatus = d.wsl,
            )
        }
        val limits = listOf(
            LimitProvider(
                provider = "anthropic", planLabel = "Claude Pro",
                accountLabel = "主账户", accountName = "dev", accountEmail = "dev@acme.com",
                windows = listOf(
                    LimitWindow("session", "percentage", "5 小时窗口", usedPercent = rng.randInt(68, 76).toDouble(), resetsAt = utcHour(-rng.randInt(70, 160) * 60_000L, now)),
                    LimitWindow("weekly", "percentage", "7 天窗口", usedPercent = rng.randInt(34, 42).toDouble(), resetsAt = utcHour(-rng.randInt(2, 4) * DAY, now)),
                    LimitWindow("monthly", "percentage", "月度额度", usedPercent = rng.randInt(2, 9).toDouble(), resetsAt = utcHour(-rng.randInt(8, 12) * DAY, now)),
                ),
                device = "MacBook-Pro.local",
            ),
            LimitProvider(
                provider = "openai", planLabel = "API 按量付费",
                accountLabel = "团队账户", accountName = "ops", accountEmail = "ops@acme.com",
                balanceUsd = kotlin.math.round(rng.rand(32.0, 58.0) * 100) / 100.0,
                windows = listOf(
                    LimitWindow("credits", "credits", "预付费额度", remaining = rng.randInt(1800, 4200).toDouble(), limit = 5000.0),
                    LimitWindow("monthly", "spend", "本月花费上限", used = kotlin.math.round(rng.rand(38.0, 92.0) * 100) / 100.0, limit = 120.0, showMeter = false),
                ),
                device = "ubuntu-server",
            ),
        )
        val sessions = (0 until rng.randInt(19, 22)).map { i ->
            val dev = devicesRaw[i % 2]
            val client = CLIENTS[rng.randInt(0, 2)]
            val pool = AFFINITY[client]!!.keys.toList()
            val m1 = pool[rng.randInt(0, pool.lastIndex)]
            val models = mutableMapOf(m1 to rng.randInt(60_000, 400_000).toDouble())
            if (rng.nextDouble() < 0.3) {
                val m2 = pool[rng.randInt(0, pool.lastIndex)]
                if (m2 != m1) models[m2] = rng.randInt(20_000, 120_000).toDouble()
            }
            val tokens = clamp0(rng.rand(0.12, 1.0).pow(2.2) * 900_000) + 12_000
            val startedAgo = rng.randInt(20, 2900) * 60_000L
            val lifeMs = rng.randInt(8, 300) * 60_000L
            SessionRow(
                key = "${dev.deviceId}:$client:sess-${(0x9a000 + i * 7919).toString(16)}",
                deviceId = dev.deviceId, device = dev.hostname, client = client,
                sessionId = "sess-${(0x9a000 + i * 7919).toString(16)}",
                tokens = tokens, costUsd = kotlin.math.round((tokens / 1e6) * 6.4 * 100) / 100.0,
                models = models, project = PROJECTS[rng.randInt(0, 2)],
                startedAt = utcHour(startedAgo + lifeMs, now),
                lastUsedAt = utcHour(startedAgo, now),
            )
        }.sortedByDescending { it.tokens }

        return Overview(
            generatedAt = Instant.ofEpochMilli(now).toString(),
            staleAfterMs = 600_000,
            dashboardTimeZone = demoZone().id,
            features = Features(trendModels = true, activityHourly = true, subscriptions = true, providerStatus = true, historyDaily = true),
            partial = false,
            pendingOutbox = 0,
            snapshotDegraded = false,
            sessionsOmitted = true,
            totals = totals,
            devices = devices,
            trend = trend,
            trendModels = trendModels,
            activity = Activity(
                timeZone = demoZone().id,
                hourly = hourly,
                hourlyDay = cnDay(0, now),
                hourlyToday = HourlyToday(cnDay(0, now), demoZone().id, hourly),
                daily = daily,
                coverage = Coverage(
                    firstSampleAt = utcHour(6 * 3_600_000, now),
                    lastSampleAt = Instant.ofEpochMilli(now).toString(),
                    expectedBuckets = 72,
                    observedBuckets = 70,
                    coveragePercent = 97.2,
                    attributionMode = "delta",
                    devices = devicesRaw.map { d ->
                        CoverageDevice(
                            deviceId = d.deviceId,
                            firstSampleAt = utcHour(8 * 3_600_000, now),
                            lastSampleAt = Instant.ofEpochMilli(now - d.receivedOff).toString(),
                            expectedBuckets = 24,
                            observedBuckets = if (d.stale) 18 else 24,
                            gapCount = if (d.stale) 3 else 0,
                            resetCount = if (d.stale) 1 else 0,
                        )
                    },
                ),
                dailyMixedBasis = true,
            ),
            dashboardPeriod = DashboardPeriod(
                timeZone = demoZone().id,
                today = PeriodKey(cnDay(0, now), Instant.ofEpochMilli(now + DAY).toString()),
                month = PeriodKey(thisMonth, Instant.ofEpochMilli(now + 10 * DAY).toString()),
            ),
            limits = limits,
            sessions = sessions,
            sessionsMeta = SessionsMeta(sessions.size + 3, sessions.size, 3, sessionDetailsIncomplete = true),
            diagnostics = diagnostics,
            periodWindowsByDevice = windows,
        )
    }

    fun subscriptions(rng: Random = Random.Default, now: Long = System.currentTimeMillis()): SubscriptionsPayload {
        fun d(off: Int) = cnDay(off, now)
        return SubscriptionsPayload(
            subscriptions = listOf(
                Subscription("anthropic", "subscription", "Claude Pro", Binding("主账户", "dev@acme.com", "demo-account-key-anthropic"), 2000, "USD", "month", 1, d(214), true, null, listOf(TopUp("top_a1", "额外用量包", 1000, d(11)))),
                Subscription("openai", "topup", "OpenAI API 预付", Binding("团队账户", "ops@acme.com"), null, "USD", topUps = listOf(TopUp("top_b1", "额度充值", 50_000, d(46)), TopUp("top_b2", "额度充值", 25_000, d(9)))),
                Subscription("cursor", "subscription", "Cursor Business", Binding("个人", "dev@acme.com"), 4000, "USD", "month", 3, d(98), true, d(-41), emptyList()),
            ),
            updatedAt = Instant.ofEpochMilli(now).toString(),
        )
    }

    fun providerStatus(overview: Overview, now: Long = System.currentTimeMillis()): ProviderStatusPayload {
        val names = overview.totals.today.clients.keys + overview.totals.today.models.keys
        val catalog = listOf(
            Triple("anthropic", Regex("claude|anthropic|sonnet|opus|haiku", RegexOption.IGNORE_CASE), "Anthropic" to "https://status.claude.com"),
            Triple("openai", Regex("codex|openai|gpt", RegexOption.IGNORE_CASE), "OpenAI" to "https://status.openai.com"),
            Triple("cursor", Regex("^cursor", RegexOption.IGNORE_CASE), "Cursor" to "https://status.cursor.com"),
            Triple("deepseek", Regex("deepseek", RegexOption.IGNORE_CASE), "DeepSeek" to "https://status.deepseek.com"),
            Triple("kimi", Regex("kimi|moonshot", RegexOption.IGNORE_CASE), "Kimi" to "https://status.moonshot.cn"),
            Triple("grok", Regex("grok|xai", RegexOption.IGNORE_CASE), "SpaceXAI API" to "https://status.x.ai"),
            Triple("grok-web", Regex("grok|xai", RegexOption.IGNORE_CASE), "SpaceXAI (Web)" to "https://status.x.ai/grok-com"),
        )
        val iso = Instant.ofEpochMilli(now).toString()
        val providers = catalog.mapNotNull { (id, match, nameUrl) ->
            val observed = names.filter { match.containsMatchIn(it) }.distinct()
            if (observed.isEmpty()) null
            else ProviderCard(id, observed, nameUrl.first, "operational", "运行正常", iso, false, null, nameUrl.second)
        }
        return ProviderStatusPayload(1, providers, false)
    }

    fun historyPage(cursor: String?, limit: Int = 30, rng: Random = Random.Default, now: Long = System.currentTimeMillis()): HistoryPage {
        val hist = buildHistory(rng, now).toMutableList()
        val todayTokens = rng.randInt(3_800_000, 5_200_000).toDouble()
        hist += Hist(
            cnDay(0, now), todayTokens, kotlin.math.round((todayTokens / 1e6) * 6.4 * 100) / 100.0,
            CLIENTS.associateWith { clamp0(todayTokens * (CLIENT_SHARE[it] ?: 0.0)) },
            mapOf("claude-opus-4.1" to clamp0(todayTokens * 0.28), "claude-sonnet-4.5" to clamp0(todayTokens * 0.42), "gpt-5-codex" to clamp0(todayTokens * 0.3)),
        )
        val desc = hist.sortedByDescending { it.day }
        val start = if (cursor.isNullOrBlank()) 0 else desc.indexOfFirst { it.day < cursor }.let { if (it < 0) desc.size else it }
        val page = desc.drop(start).take(limit)
        val more = start + page.size < desc.size
        val items = page.mapIndexed { idx, h ->
            dailySample(h).copy(complete = !(start + idx == 2), coverage = if (start + idx == 2) 41.7 else null)
        }
        return HistoryPage(
            items = items,
            nextCursor = if (more && page.isNotEmpty()) page.last().day else null,
            hasMore = more,
            dayBasis = "device-local",
            dashboardTimeZone = demoZone().id,
            retentionDays = 370,
            mixedTimeZones = true,
        )
    }

    fun updateCheck(now: Long = System.currentTimeMillis()): SystemUpdate {
        val iso = Instant.ofEpochMilli(now).toString()
        return SystemUpdate(
            current = UpdateCurrent("0.1.4", "demo000abcdef"),
            repo = "https://github.com/iroha1145/Cloud-Monitor",
            latestRelease = UpdateRelease(
                tag = "v0.2.0",
                name = "v0.2.0",
                publishedAt = iso,
                htmlUrl = "https://github.com/iroha1145/Cloud-Monitor/releases/tag/v0.2.0",
                notes = "演示数据：假的新版本说明。手机端只检索，不会改服务器。",
            ),
            main = UpdateMain("abcdef1234567890", "abcdef1", "docs: README 增加 LINUX DO 友情链接"),
            releaseAhead = true,
            mainAhead = true,
            updateAvailable = true,
            checkedAt = iso,
            applyEnabled = false,
            job = UpdateJob(state = "idle", message = ""),
        )
    }
}
