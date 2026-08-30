package io.github.iroha1145.cloudmonitor.data

import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.buildClassSerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonEncoder
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonPrimitive

object TokenMapSerializer : KSerializer<Map<String, Double>> {
    override val descriptor = buildClassSerialDescriptor("TokenMap")

    override fun serialize(encoder: Encoder, value: Map<String, Double>) {
        val json = encoder as JsonEncoder
        json.encodeJsonElement(JsonObject(value.mapValues { JsonPrimitive(it.value) }))
    }

    override fun deserialize(decoder: Decoder): Map<String, Double> {
        val el = (decoder as JsonDecoder).decodeJsonElement()
        if (el is JsonNull) return emptyMap()
        val obj = el as? JsonObject ?: return emptyMap()
        return obj.mapNotNull { (k, v) ->
            val n = when (v) {
                is JsonPrimitive -> v.doubleOrNull
                is JsonObject -> v["tokens"]?.jsonPrimitive?.doubleOrNull
                    ?: v["totalTokens"]?.jsonPrimitive?.doubleOrNull
                    ?: v["total"]?.jsonPrimitive?.doubleOrNull
                else -> null
            }
            if (n != null) k to n else null
        }.toMap()
    }
}

object NestedTokenMapSerializer : KSerializer<Map<String, Map<String, Double>>> {
    override val descriptor = buildClassSerialDescriptor("NestedTokenMap")

    override fun serialize(encoder: Encoder, value: Map<String, Map<String, Double>>) {
        val json = encoder as JsonEncoder
        json.encodeJsonElement(
            JsonObject(
                value.mapValues { (_, inner) ->
                    JsonObject(inner.mapValues { JsonPrimitive(it.value) })
                },
            ),
        )
    }

    override fun deserialize(decoder: Decoder): Map<String, Map<String, Double>> {
        val el = (decoder as JsonDecoder).decodeJsonElement()
        if (el is JsonNull) return emptyMap()
        val obj = el as? JsonObject ?: return emptyMap()
        return obj.mapNotNull { (k, v) ->
            val inner = v as? JsonObject ?: return@mapNotNull null
            k to inner.mapNotNull { (ik, iv) ->
                val n = when (iv) {
                    is JsonPrimitive -> iv.doubleOrNull
                    is JsonObject -> iv["tokens"]?.jsonPrimitive?.doubleOrNull
                    else -> null
                }
                if (n != null) ik to n else null
            }.toMap()
        }.toMap()
    }
}

@Serializable
data class Capabilities(
    val tokenComponents: Boolean = false,
)

@Serializable
data class PeriodTotals(
    val capabilities: Capabilities = Capabilities(),
    val totalTokens: Double = 0.0,
    val costUsd: Double = 0.0,
    val cacheReadTokens: Double = 0.0,
    val cacheWriteTokens: Double = 0.0,
    val outputTokens: Double = 0.0,
    val unclassifiedTokens: Double = 0.0,
    val timedTokens: Double = 0.0,
    val timedOutputTokens: Double = 0.0,
    val timedDurationMs: Double = 0.0,
    @Serializable(with = TokenMapSerializer::class)
    val clients: Map<String, Double> = emptyMap(),
    @Serializable(with = TokenMapSerializer::class)
    val clientCosts: Map<String, Double> = emptyMap(),
    @Serializable(with = TokenMapSerializer::class)
    val clientCacheReads: Map<String, Double> = emptyMap(),
    @Serializable(with = TokenMapSerializer::class)
    val clientCacheWrites: Map<String, Double> = emptyMap(),
    @Serializable(with = TokenMapSerializer::class)
    val clientOutputs: Map<String, Double> = emptyMap(),
    @Serializable(with = TokenMapSerializer::class)
    val clientUnclassifiedTokens: Map<String, Double> = emptyMap(),
    @Serializable(with = TokenMapSerializer::class)
    val models: Map<String, Double> = emptyMap(),
    @Serializable(with = TokenMapSerializer::class)
    val modelCosts: Map<String, Double> = emptyMap(),
    @Serializable(with = TokenMapSerializer::class)
    val modelCacheReads: Map<String, Double> = emptyMap(),
    @Serializable(with = TokenMapSerializer::class)
    val modelCacheWrites: Map<String, Double> = emptyMap(),
    @Serializable(with = TokenMapSerializer::class)
    val modelOutputs: Map<String, Double> = emptyMap(),
    @Serializable(with = TokenMapSerializer::class)
    val modelUnclassifiedTokens: Map<String, Double> = emptyMap(),
    @Serializable(with = NestedTokenMapSerializer::class)
    val clientModels: Map<String, Map<String, Double>> = emptyMap(),
)

@Serializable
data class Totals(
    val today: PeriodTotals = PeriodTotals(),
    val month: PeriodTotals = PeriodTotals(),
    val allTime: PeriodTotals = PeriodTotals(),
)

fun Totals.period(key: String): PeriodTotals = when (key) {
    "month" -> month
    "allTime" -> allTime
    else -> today
}

@Serializable
data class Device(
    val deviceId: String = "",
    val hostname: String? = null,
    val platform: String? = null,
    val osName: String? = null,
    val osVersion: String? = null,
    val agentVersion: String? = null,
    val agentRuntime: String? = null,
    val receivedAt: String? = null,
    val updatedAt: String? = null,
    val stale: Boolean? = null,
    val ageMs: Double? = null,
    val syncUploadIntervalMs: Double = 0.0,
    val trackedClients: List<String> = emptyList(),
    val today: PeriodTotals = PeriodTotals(),
    val month: PeriodTotals = PeriodTotals(),
    val allTime: PeriodTotals = PeriodTotals(),
    val projectsEnabled: Boolean = false,
    val historyAvailable: Boolean = false,
)

@Serializable
data class TrendPoint(
    val day: String = "",
    val total: Double = 0.0,
)

@Serializable
data class TrendModelsPoint(
    val day: String = "",
    val total: Double = 0.0,
    @Serializable(with = TokenMapSerializer::class)
    val models: Map<String, Double> = emptyMap(),
)

@Serializable
data class HourBucket(
    val hour: Int = 0,
    val total: Double = 0.0,
)

@Serializable
data class HourlyToday(
    val day: String? = null,
    @SerialName("time_zone") val timeZone: String? = null,
    val buckets: List<HourBucket> = emptyList(),
)

@Serializable
data class DailyPoint(
    val day: String = "",
    val total: Double = 0.0,
    @Serializable(with = TokenMapSerializer::class)
    val models: Map<String, Double> = emptyMap(),
)

@Serializable
data class CoverageDevice(
    @SerialName("device_id") val deviceId: String = "",
    @SerialName("first_sample_at") val firstSampleAt: String? = null,
    @SerialName("last_sample_at") val lastSampleAt: String? = null,
    @SerialName("expected_buckets") val expectedBuckets: Int = 0,
    @SerialName("observed_buckets") val observedBuckets: Int = 0,
    @SerialName("gap_count") val gapCount: Int = 0,
    @SerialName("reset_count") val resetCount: Int = 0,
)

@Serializable
data class Coverage(
    @SerialName("first_sample_at") val firstSampleAt: String? = null,
    @SerialName("last_sample_at") val lastSampleAt: String? = null,
    @SerialName("expected_buckets") val expectedBuckets: Int = 0,
    @SerialName("observed_buckets") val observedBuckets: Int = 0,
    @SerialName("coverage_percent") val coveragePercent: Double? = null,
    @SerialName("attribution_mode") val attributionMode: String? = null,
    val devices: List<CoverageDevice> = emptyList(),
)

@Serializable
data class Activity(
    @SerialName("time_zone") val timeZone: String? = null,
    val hourly: List<HourBucket> = emptyList(),
    @SerialName("hourly_day") val hourlyDay: String? = null,
    @SerialName("hourly_today") val hourlyToday: HourlyToday? = null,
    val daily: List<DailyPoint> = emptyList(),
    val coverage: Coverage? = null,
)

@Serializable
data class PeriodKey(
    val key: String? = null,
    val endsAt: String? = null,
)

@Serializable
data class DeviceWindows(
    val timeZone: String? = null,
    val today: PeriodKey? = null,
    val month: PeriodKey? = null,
)

@Serializable
data class DashboardPeriod(
    @SerialName("time_zone") val timeZone: String? = null,
    val today: PeriodKey? = null,
    val month: PeriodKey? = null,
)

@Serializable
data class LimitWindow(
    val kind: String? = null,
    val metric: String? = null,
    val label: String? = null,
    val usedPercent: Double? = null,
    val remaining: Double? = null,
    val used: Double? = null,
    val limit: Double? = null,
    val resetsAt: String? = null,
    val showMeter: Boolean = true,
)

@Serializable
data class LimitProvider(
    val provider: String = "",
    val planLabel: String? = null,
    val accountLabel: String? = null,
    val accountName: String? = null,
    val accountEmail: String? = null,
    val balanceUsd: Double? = null,
    val windows: List<LimitWindow> = emptyList(),
    val device: String? = null,
)

@Serializable
data class SessionRow(
    val key: String = "",
    val deviceId: String? = null,
    val device: String? = null,
    val client: String? = null,
    val sessionId: String? = null,
    val tokens: Double = 0.0,
    val costUsd: Double = 0.0,
    @Serializable(with = TokenMapSerializer::class)
    val models: Map<String, Double> = emptyMap(),
    val project: String? = null,
    val startedAt: String? = null,
    val lastUsedAt: String? = null,
)

@Serializable
data class SessionsMeta(
    @SerialName("sessions_total") val sessionsTotal: Int = 0,
    @SerialName("sessions_returned") val sessionsReturned: Int = 0,
    @SerialName("sessions_omitted_count") val sessionsOmittedCount: Int = 0,
)

@Serializable
data class Diagnostic(
    val deviceId: String = "",
    val hostname: String? = null,
    val clientHealth: JsonObject? = null,
    val clientStatus: String? = null,
    val wslStatus: String? = null,
)

@Serializable
data class Features(
    @SerialName("trend_models") val trendModels: Boolean = false,
    @SerialName("activity_hourly") val activityHourly: Boolean = false,
    val subscriptions: Boolean = false,
    @SerialName("provider_status") val providerStatus: Boolean = false,
    @SerialName("history_daily") val historyDaily: Boolean = false,
)

@Serializable
data class Overview(
    @SerialName("overview_schema_version") val overviewSchemaVersion: Int = 2,
    @SerialName("generated_at") val generatedAt: String? = null,
    val staleAfterMs: Long = 600_000,
    @SerialName("dashboard_time_zone") val dashboardTimeZone: String = "UTC",
    val features: Features = Features(),
    val partial: Boolean = false,
    val totals: Totals = Totals(),
    val devices: List<Device> = emptyList(),
    val trend: List<TrendPoint> = emptyList(),
    @SerialName("trend_models") val trendModels: List<TrendModelsPoint> = emptyList(),
    val activity: Activity = Activity(),
    @SerialName("dashboard_period") val dashboardPeriod: DashboardPeriod? = null,
    val limits: List<LimitProvider> = emptyList(),
    val sessions: List<SessionRow> = emptyList(),
    @SerialName("sessions_meta") val sessionsMeta: SessionsMeta = SessionsMeta(),
    val diagnostics: List<Diagnostic> = emptyList(),
    @SerialName("period_windows_by_device")
    val periodWindowsByDevice: Map<String, DeviceWindows> = emptyMap(),
)

@Serializable
data class Binding(
    val profileName: String? = null,
    val accountEmail: String? = null,
    val accountKey: String? = null,
)

@Serializable
data class TopUp(
    val id: String? = null,
    val label: String? = null,
    val amountMinor: Long? = null,
    val date: String? = null,
)

@Serializable
data class Subscription(
    val provider: String = "",
    val kind: String? = null,
    val planName: String? = null,
    val binding: Binding? = null,
    val amountMinor: Long? = null,
    val currency: String? = null,
    val interval: String? = null,
    val intervalCount: Int = 1,
    val startDate: String? = null,
    val autoRenew: Boolean = false,
    val nextRenewalOverride: String? = null,
    val topUps: List<TopUp> = emptyList(),
)

@Serializable
data class SubscriptionsPayload(
    val subscriptions: List<Subscription> = emptyList(),
    @SerialName("updated_at") val updatedAt: String? = null,
)

@Serializable
data class ProviderCard(
    val provider: String = "",
    @SerialName("observed_as") val observedAs: List<String> = emptyList(),
    val name: String = "",
    val status: String = "",
    val description: String? = null,
    @SerialName("checked_at") val checkedAt: String? = null,
    val stale: Boolean = false,
    @SerialName("error_code") val errorCode: String? = null,
    val url: String? = null,
)

@Serializable
data class ProviderStatusPayload(
    @SerialName("schema_version") val schemaVersion: Int = 1,
    val providers: List<ProviderCard> = emptyList(),
    val partial: Boolean = false,
)

@Serializable
data class HistoryDay(
    val day: String = "",
    val tokens: Double = 0.0,
    val costUsd: Double? = null,
    @Serializable(with = TokenMapSerializer::class)
    val perClient: Map<String, Double> = emptyMap(),
    @Serializable(with = TokenMapSerializer::class)
    val perModel: Map<String, Double> = emptyMap(),
    val deviceCount: Int = 0,
    val complete: Boolean = true,
    val coverage: Double? = null,
)

@Serializable
data class HistoryPage(
    val items: List<HistoryDay> = emptyList(),
    @SerialName("next_cursor") val nextCursor: String? = null,
    @SerialName("has_more") val hasMore: Boolean = false,
    @SerialName("day_basis") val dayBasis: String? = null,
    @SerialName("dashboard_time_zone") val dashboardTimeZone: String? = null,
    @SerialName("retention_days") val retentionDays: Int? = null,
)

class ApiException(val status: Int, override val message: String) : RuntimeException(message)
