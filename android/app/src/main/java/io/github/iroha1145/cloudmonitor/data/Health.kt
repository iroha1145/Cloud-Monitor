package io.github.iroha1145.cloudmonitor.data

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull

data class HealthTool(
    val name: String,
    val level: String,
    val statusText: String,
    val version: String?,
)

private val HEALTH_LEVEL = mapOf(
    "active" to "ok",
    "direct" to "ok",
    "detected" to "ok",
    "healthy" to "ok",
    "operational" to "ok",
    "ok" to "ok",
    "ready" to "ok",
    "normal" to "ok",
    "waiting" to "warn",
    "warning" to "warn",
    "stale" to "warn",
    "degraded" to "warn",
    "partial" to "warn",
    "no-data" to "warn",
    "missing" to "crit",
    "error" to "crit",
    "failed" to "crit",
    "unhealthy" to "crit",
    "critical" to "crit",
    "not-running" to "crit",
    "stopped" to "crit",
    "crashed" to "crit",
    "disabled" to "mute",
    "not-installed" to "mute",
    "unknown" to "mute",
)

fun healthLevel(raw: String?): String {
    val key = raw.orEmpty().trim().lowercase().ifEmpty { "unknown" }
    return HEALTH_LEVEL[key] ?: "mute"
}

fun healthLabel(level: String): String = when (level) {
    "ok" -> "健康"
    "warn" -> "警告"
    "crit" -> "异常"
    else -> "未知"
}

fun healthBarWidth(level: String): Float = when (level) {
    "ok" -> 1f
    "warn" -> 0.62f
    "crit" -> 0.28f
    else -> 0.45f
}

fun healthTools(diag: Diagnostic?): List<HealthTool> {
    if (diag == null) return emptyList()
    return healthEntries(diag.clientHealth).map { (name, value) ->
        val st = diagnosticState(name, value, diag)
        HealthTool(
            name = name,
            level = healthLevel(st),
            statusText = shortStatusText(st).ifEmpty { "状态未知" },
            version = versionOf(value),
        )
    }
}

fun healthEntries(ch: JsonElement?): List<Pair<String, JsonElement?>> {
    if (ch == null) return emptyList()
    if (ch is JsonArray) {
        return ch.mapNotNull { item ->
            val obj = item as? JsonObject ?: return@mapNotNull null
            val name = obj.string("client") ?: obj.string("name") ?: obj.string("id")
            if (name.isNullOrBlank()) null else name to item
        }
    }
    val obj = ch as? JsonObject ?: return emptyList()
    val source = (obj["clients"] as? JsonObject) ?: obj
    return source.entries
        .filter { it.key !in setOf("version", "observedAt", "clients") }
        .map { it.key to it.value }
}

private fun diagnosticState(@Suppress("UNUSED_PARAMETER") name: String, value: JsonElement?, @Suppress("UNUSED_PARAMETER") diag: Diagnostic): String {
    val obj = value as? JsonObject
    if (obj == null) return shortStatusText(value).ifEmpty { "unknown" }
    val candidates = listOf(
        obj.string("status"),
        obj.string("health"),
        obj.string("state"),
        (obj["collection"] as? JsonObject)?.string("state"),
        (obj["source"] as? JsonObject)?.string("state"),
        (obj["data"] as? JsonObject)?.string("state"),
    )
    val found = candidates.firstOrNull { !it.isNullOrBlank() }
    if (found != null) return found
    val healthy = (obj["healthy"] as? JsonPrimitive)?.booleanOrNull
    return when (healthy) {
        true -> "healthy"
        false -> "unhealthy"
        null -> "unknown"
    }
}

fun shortStatusText(v: Any?): String {
    if (v == null) return ""
    if (v is String) return v
    if (v is JsonPrimitive) return v.contentOrNull.orEmpty()
    if (v is JsonObject) {
        return v.entries.take(4).joinToString(" · ") { (k, x) ->
            val inner = when (x) {
                is JsonPrimitive -> x.content
                else -> x.toString()
            }
            "$k: $inner"
        }
    }
    if (v is JsonArray) return v.joinToString(" · ") { shortStatusText(it) }
    return v.toString()
}

private fun versionOf(value: JsonElement?): String? {
    val obj = value as? JsonObject ?: return null
    val raw = obj.string("version") ?: obj.string("agentVersion") ?: obj.string("v")
    return raw?.removePrefix("v")?.ifBlank { null }
}

private fun JsonObject.string(key: String): String? =
    (this[key] as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotBlank() }
