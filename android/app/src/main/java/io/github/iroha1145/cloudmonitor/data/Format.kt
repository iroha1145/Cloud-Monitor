package io.github.iroha1145.cloudmonitor.data

import java.text.NumberFormat
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.roundToInt
import kotlin.math.roundToLong

object Format {
    private val nf: NumberFormat = NumberFormat.getInstance(Locale.SIMPLIFIED_CHINESE).apply {
        maximumFractionDigits = 0
    }

    fun fmtInt(v: Double): String = nf.format(v.roundToLong())

    data class Compact(val n: String, val u: String)

    fun compactParts(raw: Double, tight: Boolean = false): Compact {
        val v = if (raw.isFinite()) raw else 0.0
        if (v >= 1e8) {
            val y = v / 1e8
            val rawN = if (tight) {
                when {
                    y >= 100 -> String.format(Locale.US, "%.0f", y)
                    y >= 10 -> String.format(Locale.US, "%.1f", y)
                    else -> String.format(Locale.US, "%.2f", y)
                }
            } else {
                String.format(Locale.US, "%.2f", y)
            }
            val n = rawN.replace(Regex("""(\.\d*?)0+$"""), "$1").replace(Regex("""\.$"""), "")
            return Compact(n, "亿")
        }
        if (v >= 1e4) {
            val w = v / 1e4
            val rawN = if (tight && w >= 1000) {
                String.format(Locale.US, "%.0f", w)
            } else {
                String.format(Locale.US, "%.1f", w)
            }
            return Compact(rawN.replace(Regex("""\.0$"""), ""), "万")
        }
        return Compact(fmtInt(v), "")
    }

    fun fmtCompact(v: Double, tight: Boolean = false): String {
        val p = compactParts(v, tight)
        return p.n + p.u
    }

    fun fmtUsd(v: Double): String {
        if (v == 0.0) return "$0.00"
        if (abs(v) < 0.01) return "$" + String.format(Locale.US, "%.4f", v)
        return "$" + String.format(Locale.US, "%.2f", v)
    }

    fun fmtPct(ratio: Double): String {
        if (!ratio.isFinite()) return "—"
        val pct = ratio * 100
        if (pct > 0 && pct < 0.1) return "<0.1%"
        val n = (kotlin.math.round(pct * 10) / 10.0)
        val s = String.format(Locale.US, "%.1f", n).replace(Regex("""\.0$"""), "")
        return "$s%"
    }

    fun pct1(v: Double, total: Double): String =
        if (total > 0) String.format(Locale.US, "%.1f%%", v / total * 100) else "0.0%"

    fun relTime(iso: String?, now: Long = System.currentTimeMillis()): String {
        val t = parseMillis(iso) ?: return iso.orEmpty()
        val diff = now - t
        return when {
            diff < 45_000 -> "刚刚"
            diff < 3_600_000 -> "${max(1, (diff / 60_000.0).roundToInt())} 分钟前"
            diff < 86_400_000 -> "${(diff / 3_600_000.0).roundToInt()} 小时前"
            diff < 7 * 86_400_000L -> "${(diff / 86_400_000.0).roundToInt()} 天前"
            else -> {
                val d = Instant.ofEpochMilli(t).atZone(ZoneId.systemDefault())
                "${d.monthValue}月${d.dayOfMonth}日"
            }
        }
    }

    fun fmtInterval(ms: Double): String {
        val n = ms.toLong()
        if (n <= 0) return ""
        if (n % 3_600_000L == 0L) return "每 ${n / 3_600_000L} 小时"
        if (n % 60_000L == 0L) return "每 ${n / 60_000L} 分钟"
        if (n >= 60_000L) return "每 ${String.format(Locale.US, "%.1f", n / 60_000.0)} 分钟"
        if (n >= 1000L) return "每 ${n / 1000L} 秒"
        return "每 ${n} 毫秒"
    }

    fun fmtDuration(ms: Long): String {
        if (ms <= 0) return "—"
        val sec = max(1, (ms / 1000.0).roundToInt())
        if (sec < 60) return "$sec 秒"
        val min = sec / 60
        if (min < 60) return "$min 分钟"
        val h = min / 60
        val parts = mutableListOf<String>()
        if (h >= 24) parts += "${h / 24} 天"
        if (h % 24 != 0) parts += "${h % 24} 小时"
        if (h < 24 && min % 60 != 0) parts += "${min % 60} 分钟"
        return parts.joinToString(" ").ifEmpty { "—" }
    }

    fun fmtTimedMs(ms: Double): String {
        if (ms <= 0) return ""
        if (ms < 3_600_000) return "${max(1, (ms / 60_000.0).roundToInt())} 分钟"
        val h = ms / 3_600_000.0
        return if (h >= 10) "${h.roundToInt()} 小时"
        else "${String.format(Locale.US, "%.1f", h).replace(Regex("""\.0$"""), "")} 小时"
    }

    fun fmtReset(iso: String?, now: Long = System.currentTimeMillis()): String {
        val t = parseMillis(iso) ?: return ""
        val diff = t - now
        return when {
            diff <= 0 -> "即将重置"
            diff < 3_600_000 -> "${max(1, (diff / 60_000.0).roundToInt())} 分钟后重置"
            diff < 86_400_000 -> "${(diff / 3_600_000.0).roundToInt()} 小时后重置"
            else -> "${(diff / 86_400_000.0).roundToInt()} 天后重置"
        }
    }

    private val ccy = mapOf(
        "USD" to "$", "CNY" to "¥", "CNH" to "¥", "EUR" to "€", "GBP" to "£",
        "JPY" to "JP¥", "HKD" to "HK$", "TWD" to "NT$", "KRW" to "₩",
        "SGD" to "S$", "AUD" to "A$", "CAD" to "C$",
    )

    fun fmtMoney(amountMinor: Long?, currency: String?): String {
        val v = (amountMinor ?: 0) / 100.0
        val code = currency.orEmpty().uppercase(Locale.US)
        val sym = ccy[code] ?: if (code.isNotEmpty()) "$code " else ""
        return sym + String.format(Locale.US, "%.2f", v)
    }

    fun fmtProvider(raw: String?): String {
        val s = raw.orEmpty()
        if (s.isEmpty()) return "—"
        return PROVIDER_NAMES[s.lowercase(Locale.US)]
            ?: (s.replaceFirstChar { if (it.isLowerCase()) it.titlecase(Locale.US) else it.toString() })
    }

    fun maskEmail(v: String?): String {
        val s = v.orEmpty()
        val at = s.indexOf('@')
        if (at <= 0) return s
        val local = s.substring(0, at)
        return local.take(minOf(2, local.length)) + "***" + s.substring(at)
    }

    fun parseMillis(iso: String?): Long? {
        if (iso.isNullOrBlank()) return null
        return try {
            Instant.parse(iso).toEpochMilli()
        } catch (_: Exception) {
            try {
                ZonedDateTime.parse(iso, DateTimeFormatter.ISO_DATE_TIME).toInstant().toEpochMilli()
            } catch (_: Exception) {
                null
            }
        }
    }

    fun pad2(n: Int): String = n.toString().padStart(2, '0')

    fun keyAdd(key: String, off: Int): String {
        val parts = key.split("-")
        if (parts.size < 3) return key
        val d = LocalDate.of(parts[0].toInt(), parts[1].toInt(), parts[2].toInt()).plusDays(off.toLong())
        return "%04d-%02d-%02d".format(d.year, d.monthValue, d.dayOfMonth)
    }

    fun dowOfKey(key: String): Int? = try {
        val parts = key.split("-")
        val iso = LocalDate.of(parts[0].toInt(), parts[1].toInt(), parts[2].toInt()).dayOfWeek.value
        if (iso == 7) 0 else iso
    } catch (_: Exception) {
        null
    }

    fun dayKeyTz(now: Long, tz: String): String {
        val zone = try {
            ZoneId.of(tz)
        } catch (_: Exception) {
            ZoneId.of("UTC")
        }
        val d = Instant.ofEpochMilli(now).atZone(zone)
        return "%04d-%02d-%02d".format(d.year, d.monthValue, d.dayOfMonth)
    }

    fun fmtStatusLabel(status: String?): String {
        return when (status.orEmpty().lowercase(Locale.US)) {
            "operational" -> "正常"
            "degraded_performance", "degraded" -> "性能下降"
            "partial_outage" -> "部分故障"
            "major_outage" -> "严重故障"
            "maintenance", "under_maintenance" -> "维护中"
            "unknown", "" -> "未知"
            else -> status.orEmpty()
        }
    }

    fun fmtStatusLine(status: String?, description: String?): String {
        val label = fmtStatusLabel(status)
        val desc = description?.trim().orEmpty()
        if (desc.isEmpty()) return label
        val generic = desc.equals("all systems operational", ignoreCase = true) ||
            desc.equals(status, ignoreCase = true)
        return if (generic) label else "$label · $desc"
    }

    fun fmtClock(millis: Long): String {
        val d = Instant.ofEpochMilli(millis).atZone(ZoneId.systemDefault())
        return "%02d:%02d".format(d.hour, d.minute)
    }

    fun fmtDateTime(iso: String?): String {
        val t = parseMillis(iso) ?: return iso.orEmpty()
        val d = Instant.ofEpochMilli(t).atZone(ZoneId.systemDefault())
        return "%04d-%02d-%02d %02d:%02d".format(d.year, d.monthValue, d.dayOfMonth, d.hour, d.minute)
    }

    fun truncateKey(v: String?): String {
        val s = v.orEmpty()
        if (s.isEmpty()) return ""
        return if (s.length > 8) s.take(6) + "…" else s
    }

    fun attributionMode(raw: String?): String = when (raw) {
        "delta" -> "增量归属"
        "delta-low-coverage" -> "增量归属（低覆盖）"
        "delta-with-reset" -> "增量归属（含计数重置）"
        "none" -> "无归属"
        else -> raw.orEmpty()
    }

    fun pvErrorText(code: String?): String = when (code.orEmpty()) {
        "timeout" -> "状态页请求超时"
        "http_status" -> "状态页返回异常"
        "invalid_json" -> "状态页响应无法解析"
        "network" -> "状态页网络错误"
        "stats_unavailable" -> "用量来源暂不可用"
        "subscriptions_unavailable" -> "订阅来源暂不可用"
        else -> code.orEmpty()
    }

    fun pvNameOverride(provider: String?, fallback: String): String {
        return when (provider.orEmpty().lowercase(Locale.US)) {
            "grok", "xai" -> "SpaceXAI API"
            "grok-web" -> "SpaceXAI (Web)"
            else -> fallback
        }
    }

    fun safeHttpUrl(raw: String?): String? {
        val u = raw.orEmpty().trim()
        return if (u.startsWith("https://", true) || u.startsWith("http://", true)) u else null
    }

    fun billingInterval(interval: String?, count: Int): String {
        val unit = when (interval.orEmpty().lowercase(Locale.US)) {
            "day", "daily" -> "天"
            "week", "weekly" -> "周"
            "year", "yearly", "annual" -> "年"
            else -> "个月"
        }
        val n = max(1, count)
        return if (n > 1) "每 $n $unit" else "每$unit"
    }
}

val PROVIDER_NAMES = mapOf(
    "anthropic" to "Anthropic",
    "openai" to "OpenAI",
    "cursor" to "Cursor",
    "google" to "Google",
    "gemini" to "Gemini",
    "github" to "GitHub",
    "copilot" to "Copilot",
    "zhipu" to "智谱",
    "moonshot" to "Moonshot",
    "kimi" to "Kimi",
    "deepseek" to "DeepSeek",
    "grok" to "SpaceXAI",
    "xai" to "SpaceXAI",
    "grok-web" to "SpaceXAI (Web)",
)
