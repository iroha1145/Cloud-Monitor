package io.github.iroha1145.cloudmonitor.data

import kotlinx.serialization.KSerializer
import kotlinx.serialization.descriptors.buildClassSerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.*
import kotlin.math.abs
import kotlin.math.max

/** Availability belongs to each field, not to the entire reported period. */
data class UsageComponents(
    val input: Double = 0.0,
    val output: Double = 0.0,
    val cacheRead: Double = 0.0,
    val cacheWrite: Double = 0.0,
    val unclassified: Double = 0.0,
    val known: Boolean = false,
    /** Arithmetic closure; this does not mean all tokens are classified. */
    val complete: Boolean = false,
    val partial: Boolean = false,
    val inputKnown: Boolean = false,
    val outputKnown: Boolean = false,
    val cacheReadKnown: Boolean = false,
    val cacheWriteKnown: Boolean = false,
    val cacheRate: Double? = null,
) {
    val cacheLabel: String get() = if (partial) "已识别缓存占比" else "缓存占比"
}

data class UsageEntity(
    val id: String,
    val name: String,
    val totalTokens: Double,
    val costUsd: Double?,
    val components: UsageComponents,
    val provider: String = "other",
)

data class TrendRow(
    val day: String,
    val total: Double,
    val models: Map<String, Double> = emptyMap(),
    val costUsd: Double? = null,
    val components: UsageComponents? = null,
    val zeroUsageConfirmed: Boolean = false,
) {
    val totalTokens: Double get() = total
}

data class TrendSummary(
    val tokenTotal: Double,
    val hasCost: Boolean,
    val allCosts: Boolean,
    val costTotal: Double?,
    val cacheDays: Int,
    val cacheSkippedDays: Int,
    val cacheTokenTotal: Double,
    val cacheTotal: Double?,
    val cacheRate: Double?,
    val partialCache: Boolean,
) {
    val cacheLabel: String get() = if (partialCache) "已识别缓存占比" else "缓存占比"
}

internal fun JsonElement?.usageNumber(): Double? =
    (this as? JsonPrimitive)?.takeUnless { it.isString }?.doubleOrNull?.takeIf { it.isFinite() }

private fun JsonElement?.counter(): Double? = usageNumber()?.takeIf { it >= 0 }
private fun JsonElement?.record(): JsonObject = this as? JsonObject ?: JsonObject(emptyMap())
private fun JsonElement?.flag(): Boolean? = (this as? JsonPrimitive)?.booleanOrNull
private fun JsonElement?.text(): String = (this as? JsonPrimitive)?.contentOrNull.orEmpty()
private fun count(value: JsonElement?): Double = value.counter() ?: 0.0
private fun validCounter(value: Double): Boolean = value.isFinite() && value >= 0
private val componentFields = listOf("outputTokens", "cacheReadTokens", "cacheWriteTokens", "unclassifiedTokens")

/** Same normalization as hub/dashboard/src/data.ts; daily zero preservation is opt-in. */
private fun normalizeComponents(
    source: JsonObject,
    entityType: String? = null,
    entityId: String? = null,
    preserveExplicitCacheZero: Boolean = false,
): UsageComponents {
    val entity = entityType != null
    val id = entityId.orEmpty()
    val prefix = entityType.orEmpty()
    val rawTotal = if (entity) source[prefix + "s"].record()[id] else source["totalTokens"]
    val total = count(rawTotal)
    val capable = source["capabilities"].record()["tokenComponents"].flag() == true ||
        (!entity && source["tokenComponentsAvailable"].flag() == true)
    val raw = if (entity) listOf("Outputs", "CacheReads", "CacheWrites", "UnclassifiedTokens")
        .map { source[prefix + it].record()[id] } else componentFields.map { source[it] }
    val unknown = UsageComponents(unclassified = total, partial = total > 0)
    if (rawTotal.counter() == 0.0 && raw.all { it.counter() == 0.0 }) {
        return unknown.copy(
            known = true, complete = true,
            partial = !entity && source["componentsPartial"].flag() == true,
            inputKnown = true, outputKnown = true, cacheReadKnown = true, cacheWriteKnown = true,
        )
    }
    if (total <= 0 || raw.none { it.counter() != null }) return unknown
    val coverageKnown = if (entity) source[prefix + "UnclassifiedTokens"] is JsonObject &&
        (raw[3] == null || raw[3].counter() != null) else raw[3].counter() != null
    val output = count(raw[0])
    val cacheRead = count(raw[1])
    val cacheWrite = count(raw[2])
    val classified = output + cacheRead + cacheWrite
    val remainder = max(0.0, total - classified)
    val canInferInput = capable || coverageKnown
    val unclassified = if (canInferInput) count(raw[3]) else max(count(raw[3]), remainder)
    val input = if (canInferInput) max(0.0, remainder - unclassified) else 0.0
    val explicitCacheZero = !entity && preserveExplicitCacheZero && raw[1].counter() == 0.0
    if (classified + input <= 0 && !explicitCacheZero) return unknown
    val complete = abs(input + classified + unclassified - total) <= max(1.0, total * 0.01)
    val partial = unclassified > 0 || !canInferInput || !complete ||
        (!entity && source["componentsPartial"].flag() == true)
    fun fieldKnown(index: Int, suffix: String): Boolean = raw[index].counter() != null ||
        (entity && !partial && source[prefix + suffix] is JsonObject && raw[index] == null)
    val cacheReadKnown = fieldKnown(1, "CacheReads")
    return UsageComponents(
        input, output, cacheRead, cacheWrite, unclassified, known = true, complete = complete,
        partial = partial, inputKnown = canInferInput && (input > 0 || !partial),
        outputKnown = fieldKnown(0, "Outputs"), cacheReadKnown = cacheReadKnown,
        cacheWriteKnown = fieldKnown(2, "CacheWrites"),
        cacheRate = if (cacheReadKnown && complete && cacheRead <= total) cacheRead / total else null,
    )
}

fun usageComponents(period: PeriodTotals, entityType: String? = null, entityId: String? = null): UsageComponents =
    normalizeComponents(periodSource(period), entityType, entityId)

fun periodCost(period: PeriodTotals): Double? = periodSource(period)["costUsd"].usageNumber()

private fun entities(period: PeriodTotals, kind: String): List<UsageEntity> {
    val source = periodSource(period)
    return source[kind + "s"].record().mapNotNull { (id, raw) ->
        val total = raw.counter()?.takeIf { it > 0 } ?: return@mapNotNull null
        UsageEntity(
            id = id,
            name = if (kind == "client") when (id) {
                "codex" -> "Codex"
                "claude" -> "Claude Code"
                "cursor" -> "Cursor"
                else -> id
            } else id,
            totalTokens = total,
            costUsd = source[kind + "Costs"].record()[id].usageNumber(),
            components = normalizeComponents(source, kind, id),
            provider = usageProvider(id),
        )
    }.sortedByDescending { it.totalTokens }
}

fun modelUsage(period: PeriodTotals): List<UsageEntity> = entities(period, "model")
fun clientUsage(period: PeriodTotals): List<UsageEntity> = entities(period, "client")

private fun usageProvider(id: String): String {
    val name = id.lowercase()
    return when {
        listOf("claude", "opus", "sonnet", "haiku", "anthropic").any { it in name } -> "anthropic"
        listOf("gpt", "codex", "openai").any { it in name } -> "openai"
        "cursor" in name -> "cursor"
        "gemini" in name || "google" in name -> "google"
        "deepseek" in name -> "deepseek"
        "grok" in name || "xai" in name -> "xai"
        "kimi" in name || "moonshot" in name -> "kimi"
        else -> "other"
    }
}

private fun normalizedDay(day: String, source: JsonObject, models: Map<String, Double>): TrendRow {
    val counters = componentFields.map { source[it] }
    val hasComponents = counters.any { it.counter() != null }
    val validComponents = counters.all { it == null || it is JsonNull || it.counter() != null }
    return TrendRow(
        day = day,
        total = count(source["totalTokens"]),
        models = models.filterValues(::validCounter),
        costUsd = source["costUsd"].usageNumber(),
        components = if (hasComponents && validComponents)
            normalizeComponents(source, preserveExplicitCacheZero = true) else null,
        zeroUsageConfirmed = source["totalTokens"].counter() == 0.0 &&
            counters.all { it == null || it is JsonNull || it.counter() == 0.0 },
    )
}

/** Only reported trend days participate. Auxiliary history must be the same day's same total. */
fun analyzeTrend(overview: Overview, history: List<HistoryDay> = emptyList()): List<TrendRow> {
    val archives = history.associateBy { it.day }
    val modelDays = overview.trendModels.associateBy { it.day }
    return overview.trend.filter { it.day.isNotBlank() }.map { point ->
        val own = trendSource(point)
        val archive = archives[point.day]?.let(::historySource)
        val matches = own["total"].counter() != null && archive?.get("tokens").counter() != null &&
            own["total"].counter() == archive?.get("tokens").counter()
        val daily = buildJsonObject {
            if (matches) archive!!.forEach { (key, value) -> put(key, value) }
            own.forEach { (key, value) -> put(key, value) } // Explicit null blocks archive fallback, just as in the web adapter.
            put("totalTokens", own["total"] ?: JsonNull)
            if (own["costUsd"].usageNumber() == null && matches) {
                archive!!["costUsd"]?.let { put("costUsd", it) }
            }
        }
        val models = modelDays[point.day]?.models ?: if (matches)
            tokenMap(archive!!["perModel"]) else emptyMap()
        normalizedDay(point.day, daily, models)
    }.sortedBy { it.day }
}

fun dailyUsage(day: HistoryDay): TrendRow {
    val source = historySource(day)
    return normalizedDay(day.day, buildJsonObject {
        source.forEach { (key, value) -> put(key, value) }
        put("totalTokens", source["tokens"] ?: JsonNull)
    }, day.perModel)
}

/** Ratio of sums over the same valid days, never an average of daily percentages. */
fun summarizeTrend(rows: List<TrendRow>): TrendSummary {
    val eligible = rows.filter { row ->
        val parts = row.components
        if (row.total == 0.0 && row.zeroUsageConfirmed) true
        else if (!validCounter(row.total) || parts == null || !parts.known ||
            !parts.cacheReadKnown || !parts.complete || !validCounter(parts.cacheRead) ||
            parts.cacheRead > row.total) false
        else if (row.total == 0.0)
            listOf(parts.input, parts.output, parts.cacheRead, parts.cacheWrite, parts.unclassified).all { it == 0.0 }
        else parts.cacheRate?.let { it.isFinite() && it in 0.0..1.0 } == true
    }
    val cacheTokenTotal = eligible.sumOf { it.total }
    val cacheTotal = eligible.takeIf { it.isNotEmpty() }?.sumOf {
        if (it.total == 0.0) 0.0 else it.components!!.cacheRead
    }?.takeIf { validCounter(it) && validCounter(cacheTokenTotal) && it <= cacheTokenTotal }
    val costs = rows.mapNotNull { it.costUsd?.takeIf(Double::isFinite) }
    return TrendSummary(
        tokenTotal = rows.sumOf { if (validCounter(it.total)) it.total else 0.0 },
        hasCost = costs.isNotEmpty(), allCosts = rows.isNotEmpty() && costs.size == rows.size,
        costTotal = costs.takeIf { it.isNotEmpty() }?.sum()?.takeIf(Double::isFinite),
        cacheDays = eligible.size, cacheSkippedDays = rows.size - eligible.size,
        cacheTokenTotal = cacheTokenTotal, cacheTotal = cacheTotal,
        cacheRate = if (cacheTotal != null && cacheTokenTotal > 0) cacheTotal / cacheTokenTotal else null,
        partialCache = eligible.any { it.components?.partial == true },
    )
}

internal fun tokenMap(source: JsonElement?): Map<String, Double> = source.record().mapNotNull { (key, raw) ->
    val number = when (raw) {
        is JsonObject -> sequenceOf("tokens", "totalTokens", "total").mapNotNull { raw[it].usageNumber() }.firstOrNull()
        else -> raw.usageNumber()
    }
    number?.let { key to it }
}.toMap()

private fun nestedMap(source: JsonElement?): Map<String, Map<String, Double>> =
    source.record().filterValues { it is JsonObject }.mapValues { tokenMap(it.value) }

private fun numberMap(values: Map<String, Double>): JsonObject =
    JsonObject(values.filterValues(Double::isFinite).mapValues { JsonPrimitive(it.value) })

/** Synthetic records omit unreported defaults; network records retain their exact original keys. */
internal fun periodSource(period: PeriodTotals): JsonObject = period.rawUsage ?: buildJsonObject {
    put("capabilities", buildJsonObject { put("tokenComponents", period.capabilities.tokenComponents) })
    if (period.totalTokens.isFinite()) put("totalTokens", period.totalTokens)
    if (period.costUsd.isFinite()) put("costUsd", period.costUsd)
    val capable = period.capabilities.tokenComponents
    mapOf(
        "outputTokens" to period.outputTokens, "cacheReadTokens" to period.cacheReadTokens,
        "cacheWriteTokens" to period.cacheWriteTokens, "unclassifiedTokens" to period.unclassifiedTokens,
    ).forEach { (key, value) -> if (value.isFinite() && (capable || value != 0.0)) put(key, value) }
    mapOf(
        "timedTokens" to period.timedTokens, "timedOutputTokens" to period.timedOutputTokens,
        "timedDurationMs" to period.timedDurationMs,
    ).forEach { (key, value) -> if (value.isFinite()) put(key, value) }
    mapOf(
        "clients" to period.clients, "clientCosts" to period.clientCosts,
        "clientCacheReads" to period.clientCacheReads, "clientCacheWrites" to period.clientCacheWrites,
        "clientOutputs" to period.clientOutputs, "clientUnclassifiedTokens" to period.clientUnclassifiedTokens,
        "models" to period.models, "modelCosts" to period.modelCosts,
        "modelCacheReads" to period.modelCacheReads, "modelCacheWrites" to period.modelCacheWrites,
        "modelOutputs" to period.modelOutputs, "modelUnclassifiedTokens" to period.modelUnclassifiedTokens,
    ).forEach { (key, value) -> if (value.isNotEmpty() || capable) put(key, numberMap(value)) }
    if (period.clientModels.isNotEmpty()) put("clientModels", JsonObject(period.clientModels.mapValues { numberMap(it.value) }))
    if (period.clientModelCosts.isNotEmpty()) put("clientModelCosts", JsonObject(period.clientModelCosts.mapValues { numberMap(it.value) }))
}

private fun JsonObjectBuilder.dailyFields(
    costUsd: Double?, output: Double?, read: Double?, write: Double?, unclassified: Double?,
    available: Boolean?, partial: Boolean?,
) {
    mapOf("costUsd" to costUsd, "outputTokens" to output, "cacheReadTokens" to read,
        "cacheWriteTokens" to write, "unclassifiedTokens" to unclassified).forEach { (key, value) ->
        value?.let { put(key, JsonPrimitive(it)) }
    }
    available?.let { put("tokenComponentsAvailable", it) }
    partial?.let { put("componentsPartial", it) }
}

internal fun trendSource(point: TrendPoint): JsonObject = point.rawUsage ?: buildJsonObject {
    put("day", point.day)
    put("total", point.total)
    dailyFields(point.costUsd, point.outputTokens, point.cacheReadTokens, point.cacheWriteTokens,
        point.unclassifiedTokens, point.tokenComponentsAvailable, point.componentsPartial)
}

internal fun historySource(day: HistoryDay): JsonObject = day.rawUsage ?: buildJsonObject {
    put("day", day.day)
    put("tokens", day.tokens)
    put("perClient", numberMap(day.perClient))
    put("perModel", numberMap(day.perModel))
    put("deviceCount", day.deviceCount)
    put("complete", day.complete)
    day.coverage?.let { put("coverage", it) }
    dailyFields(day.costUsd, day.outputTokens, day.cacheReadTokens, day.cacheWriteTokens,
        day.unclassifiedTokens, day.tokenComponentsAvailable, day.componentsPartial)
}

abstract class UsageJsonSerializer<T>(name: String) : KSerializer<T> {
    override val descriptor = buildClassSerialDescriptor(name)
    protected abstract fun read(source: JsonObject): T
    protected abstract fun write(value: T): JsonObject
    override fun deserialize(decoder: Decoder): T = read((decoder as JsonDecoder).decodeJsonElement().record())
    override fun serialize(encoder: Encoder, value: T) = (encoder as JsonEncoder).encodeJsonElement(write(value))
}

object PeriodTotalsSerializer : UsageJsonSerializer<PeriodTotals>("PeriodTotals") {
    override fun read(source: JsonObject) = PeriodTotals(
        capabilities = Capabilities(source["capabilities"].record()["tokenComponents"].flag() == true),
        totalTokens = count(source["totalTokens"]), costUsd = source["costUsd"].usageNumber() ?: 0.0,
        cacheReadTokens = count(source["cacheReadTokens"]), cacheWriteTokens = count(source["cacheWriteTokens"]),
        outputTokens = count(source["outputTokens"]), unclassifiedTokens = count(source["unclassifiedTokens"]),
        timedTokens = count(source["timedTokens"]), timedOutputTokens = count(source["timedOutputTokens"]),
        timedDurationMs = count(source["timedDurationMs"]),
        clients = tokenMap(source["clients"]), clientCosts = tokenMap(source["clientCosts"]),
        clientCacheReads = tokenMap(source["clientCacheReads"]), clientCacheWrites = tokenMap(source["clientCacheWrites"]),
        clientOutputs = tokenMap(source["clientOutputs"]), clientUnclassifiedTokens = tokenMap(source["clientUnclassifiedTokens"]),
        models = tokenMap(source["models"]), modelCosts = tokenMap(source["modelCosts"]),
        modelCacheReads = tokenMap(source["modelCacheReads"]), modelCacheWrites = tokenMap(source["modelCacheWrites"]),
        modelOutputs = tokenMap(source["modelOutputs"]), modelUnclassifiedTokens = tokenMap(source["modelUnclassifiedTokens"]),
        clientModels = nestedMap(source["clientModels"]), clientModelCosts = nestedMap(source["clientModelCosts"]),
        rawUsage = source,
    )
    override fun write(value: PeriodTotals) = periodSource(value)
}

object TrendPointSerializer : UsageJsonSerializer<TrendPoint>("TrendPoint") {
    override fun read(source: JsonObject) = TrendPoint(
        day = source["day"].text(), total = count(source["total"]), costUsd = source["costUsd"].usageNumber(),
        outputTokens = source["outputTokens"].usageNumber(), cacheReadTokens = source["cacheReadTokens"].usageNumber(),
        cacheWriteTokens = source["cacheWriteTokens"].usageNumber(), unclassifiedTokens = source["unclassifiedTokens"].usageNumber(),
        tokenComponentsAvailable = source["tokenComponentsAvailable"].flag(), componentsPartial = source["componentsPartial"].flag(),
        rawUsage = source,
    )
    override fun write(value: TrendPoint) = trendSource(value)
}

object HistoryDaySerializer : UsageJsonSerializer<HistoryDay>("HistoryDay") {
    override fun read(source: JsonObject) = HistoryDay(
        day = source["day"].text(), tokens = count(source["tokens"]), costUsd = source["costUsd"].usageNumber(),
        perClient = tokenMap(source["perClient"]), perModel = tokenMap(source["perModel"]),
        deviceCount = count(source["deviceCount"]).toInt(), complete = source["complete"].flag() != false,
        coverage = source["coverage"].usageNumber(),
        outputTokens = source["outputTokens"].usageNumber(), cacheReadTokens = source["cacheReadTokens"].usageNumber(),
        cacheWriteTokens = source["cacheWriteTokens"].usageNumber(), unclassifiedTokens = source["unclassifiedTokens"].usageNumber(),
        tokenComponentsAvailable = source["tokenComponentsAvailable"].flag(), componentsPartial = source["componentsPartial"].flag(),
        rawUsage = source,
    )
    override fun write(value: HistoryDay) = historySource(value)
}
