package io.github.iroha1145.cloudmonitor.data

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import java.util.Locale
import kotlin.math.abs

data class QuotaHeadline(val value: String, val label: String)

data class BalanceTranche(val amount: Double, val currency: String?, val expiresAt: String?)

data class BalanceDetails(
    val requestCount: Double? = null,
    val quotaGroup: String? = null,
    val monthSpend: Double? = null,
    val allTimeSpend: Double? = null,
    val expiresAt: String? = null,
    val currency: String? = null,
)

private val GRANT_WINDOWS = mapOf(
    "five_hour" to "5 小时窗口",
    "seven_day" to "7 天窗口",
    "seven_day_overage_included" to "Fable 周额度",
    "seven_day_opus" to "Opus 周额度",
    "seven_day_sonnet" to "Sonnet 周额度",
    "seven_day_oauth_apps" to "已授权应用周额度",
    "seven_day_cowork" to "Cowork 周额度",
)

private val ADAPTER_NAMES = mapOf(
    "newapi-account" to "New API 账户",
    "newapi-token" to "New API 密钥",
    "sub2api" to "Sub2API",
    "custom" to "自定义接口",
)

private val PERIOD_NAMES = mapOf(
    "today" to "今日",
    "week" to "本周",
    "month" to "本月",
    "allTime" to "累计",
)

fun quotaNumber(value: Double): String {
    if (!value.isFinite()) return "未提供"
    val rounded = kotlin.math.round(value * 100.0) / 100.0
    val text = if (abs(rounded - rounded.toLong()) < 0.001) {
        Format.fmtInt(rounded)
    } else {
        String.format(Locale.US, "%,.2f", rounded).replace(Regex("""0+$"""), "").replace(Regex("""\.$"""), "")
    }
    return text
}

fun quotaMoney(value: Double, currency: String): String {
    val code = currency.uppercase(Locale.US)
    if (code == "USD") return Format.fmtUsd(value)
    if (code == "CNY" || code == "CNH") {
        if (!value.isFinite()) return "未提供"
        val sign = if (value < 0) "-" else ""
        return sign + "¥" + String.format(Locale.US, "%,.2f", abs(value))
    }
    return runCatching {
        java.text.NumberFormat.getCurrencyInstance(Locale.SIMPLIFIED_CHINESE).apply {
            this.currency = java.util.Currency.getInstance(code)
        }.format(value)
    }.getOrElse { "$code ${quotaNumber(value)}" }
}

fun quotaPercent(window: LimitWindow): Double? {
    val explicit = window.usedPercent?.takeIf { it.isFinite() && it >= 0.0 }
    if (explicit != null) return explicit.coerceIn(0.0, 100.0)
    val used = window.used
    val limit = window.limit
    if (used != null && limit != null && used.isFinite() && limit.isFinite() && limit > 0.0) {
        return (used / limit * 100.0).coerceIn(0.0, 100.0)
    }
    return null
}

fun quotaAmount(value: Double, window: LimitWindow, provider: String): String {
    val currency = window.currency?.uppercase(Locale.US)
    if (currency == "CREDITS") return quotaNumber(value)
    if (!currency.isNullOrBlank()) return quotaMoney(value, currency)
    val metric = window.metric.orEmpty()
    if (metric == "spend" || metric == "credits") return "${quotaNumber(value)}（单位未提供）"
    if (provider == "zai" || provider == "zaiteam") {
        if (window.kind == "daily" || (window.kind == "billing" && !window.limitId.isNullOrBlank())) {
            return "${quotaNumber(value)} 词元"
        }
    }
    return quotaNumber(value)
}

fun quotaBalanceAmount(value: Double, currency: String?, fallbackCurrency: String?): String {
    val code = currency ?: fallbackCurrency
    if (code.isNullOrBlank()) return "${quotaNumber(value)}（单位未提供）"
    return if (code.equals("CREDITS", true)) quotaNumber(value) else quotaMoney(value, code)
}

fun providerBalance(provider: LimitProvider): Double? = when (val raw = provider.balance) {
    is JsonPrimitive -> raw.doubleOrNull?.takeIf { it.isFinite() }
    is JsonObject -> listOf("remaining", "total", "value", "amount").firstNotNullOfOrNull { key ->
        (raw[key] as? JsonPrimitive)?.doubleOrNull?.takeIf { it.isFinite() }
    }
    else -> null
}

fun balanceCurrency(provider: LimitProvider): String? {
    val raw = provider.balance as? JsonObject ?: return null
    return (raw["currency"] as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotBlank() }
}

fun balanceTranches(provider: LimitProvider): List<BalanceTranche> {
    val raw = provider.balance as? JsonObject ?: return emptyList()
    val list = raw["tranches"] as? kotlinx.serialization.json.JsonArray ?: return emptyList()
    return list.mapNotNull { item ->
        val row = item as? JsonObject ?: return@mapNotNull null
        val amount = (row["amount"] as? JsonPrimitive)?.doubleOrNull?.takeIf { it.isFinite() } ?: return@mapNotNull null
        BalanceTranche(
            amount,
            (row["currency"] as? JsonPrimitive)?.contentOrNull,
            (row["expiresAt"] as? JsonPrimitive)?.contentOrNull,
        )
    }
}

fun balanceDetails(provider: LimitProvider): BalanceDetails? {
    val raw = provider.balance as? JsonObject ?: return null
    fun num(key: String) = (raw[key] as? JsonPrimitive)?.doubleOrNull?.takeIf { it.isFinite() }
    fun text(key: String) = (raw[key] as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotBlank() }
    val details = BalanceDetails(
        requestCount = num("requestCount"),
        quotaGroup = text("quotaGroup"),
        monthSpend = num("monthSpend"),
        allTimeSpend = num("allTimeSpend"),
        expiresAt = text("expiresAt"),
        currency = text("currency"),
    )
    return details.takeIf {
        it.requestCount != null || it.quotaGroup != null || it.monthSpend != null || it.allTimeSpend != null || it.expiresAt != null
    }
}

fun quotaHeadline(window: LimitWindow, provider: LimitProvider): QuotaHeadline {
    val percent = quotaPercent(window)
    val balance = providerBalance(provider)
    val metric = window.metric.orEmpty()
    if (metric == "balance") {
        val value = provider.balanceUsd?.takeIf { it.isFinite() }?.let { quotaMoney(it, "USD") }
            ?: balance?.let { quotaBalanceAmount(it, balanceCurrency(provider), window.currency) }
            ?: "未提供"
        return QuotaHeadline(value, "")
    }
    if (metric == "credits" && window.remaining != null) {
        val label = if (window.currency.equals("CREDITS", true)) "剩余点数" else "剩余"
        return QuotaHeadline(quotaAmount(window.remaining, window, provider.provider), label)
    }
    if (metric == "spend" && window.used != null) {
        return QuotaHeadline(quotaAmount(window.used, window, provider.provider), "已用")
    }
    if (percent != null) return QuotaHeadline("${quotaNumber(percent)}%", "已用")
    if (window.remaining != null) return QuotaHeadline(quotaAmount(window.remaining, window, provider.provider), "剩余")
    if (window.used != null) return QuotaHeadline(quotaAmount(window.used, window, provider.provider), "已用")
    if (provider.balanceUsd != null) return QuotaHeadline(quotaMoney(provider.balanceUsd, "USD"), "余额")
    return QuotaHeadline("未提供", "")
}

fun quotaBoundaryLabel(boundaryKind: String?): String = when (boundaryKind) {
    "expiry" -> "到期"
    "mixed" -> "变化"
    else -> "重置"
}

fun quotaActionText(provider: LimitProvider): String = when (provider.actionRequired) {
    null, "" -> ""
    "accountVerification" -> "需要在 ${Format.fmtProvider(provider.provider)} 中完成账户验证。"
    "appSessionEncrypted" -> "应用会话已加密，请在原应用中检查登录状态。"
    else -> "需要在原服务中处理账户状态。"
}

fun grantWindowName(id: String): String = GRANT_WINDOWS[id] ?: id.replace('_', ' ')

fun quotaExtraRows(provider: LimitProvider, zone: String?): List<Pair<String, String>> {
    val usage = provider.usageSummary
    val balance = balanceDetails(provider)
    val rows = mutableListOf<Pair<String, String>>()
    if (!usage?.period.isNullOrBlank()) {
        rows += "统计周期" to (PERIOD_NAMES[usage.period] ?: usage.period)
    }
    provider.adapterId?.takeIf { it.isNotBlank() }?.let { id ->
        rows += "接口来源" to (ADAPTER_NAMES[id] ?: id)
    }
    fun addCount(label: String, value: Double?) {
        if (value != null && value.isFinite()) rows += label to quotaNumber(value)
    }
    fun money(amount: Double): String {
        val currency = balance?.currency ?: balanceCurrency(provider)
        return if (currency.isNullOrBlank()) "${quotaNumber(amount)}（单位未提供）" else quotaBalanceAmount(amount, currency, null)
    }
    addCount("请求次数", usage?.requests ?: balance?.requestCount)
    addCount("今日词元", usage?.todayTokens)
    addCount("本周词元", usage?.weekTokens)
    addCount("累计词元", usage?.totalTokens)
    addCount("输入词元", usage?.inputTokens)
    addCount("输出词元", usage?.outputTokens)
    addCount("缓存读取", usage?.cacheReadTokens)
    addCount("缓存写入", usage?.cacheCreationTokens)
    usage?.averageDurationMs?.takeIf { it.isFinite() }?.let { rows += "平均响应" to "${quotaNumber(it)} 毫秒" }
    usage?.standardCost?.takeIf { it.isFinite() }?.let { rows += "标准估算费用" to money(it) }
    usage?.actualCost?.takeIf { it.isFinite() }?.let { rows += "实际费用" to money(it) }
    balance?.monthSpend?.let { rows += "本月支出" to money(it) }
    balance?.allTimeSpend?.let { rows += "累计支出" to money(it) }
    balance?.quotaGroup?.let { rows += "额度组" to it }
    balance?.expiresAt?.let { rows += "账户额度到期" to Format.fmtDateTime(it, zone).ifBlank { it } }
    return rows
}

fun quotaGroupStatus(provider: LimitProvider): String {
    if (provider.stale || provider.windows.any { it.stale }) return "数据已过期"
    if (!provider.actionRequired.isNullOrBlank()) return "需要处理"
    val status = provider.sourceStatus ?: provider.status
    val known = mapOf(
        "unauthorized" to "授权失效",
        "error" to "读取失败",
        "rateLimited" to "已达速率限制",
        "sourceRateLimited" to "状态源限流",
        "unavailable" to "来源暂不可用",
    )
    if (!status.isNullOrBlank() && status != "ok" && status != "disabled" && status != "notConfigured") {
        return known[status] ?: "等待同步"
    }
    val empty = provider.windows.all { window ->
        quotaPercent(window) == null && provider.balanceUsd == null && providerBalance(provider) == null &&
            window.remaining == null && window.used == null
    } && provider.windows.isNotEmpty()
    if (provider.windows.isEmpty() && provider.balanceUsd == null && providerBalance(provider) == null) return "数据待更新"
    if (empty && provider.balanceUsd == null && providerBalance(provider) == null) return "数据待更新"
    if (provider.windows.any { (quotaPercent(it) ?: -1.0) >= 75.0 || it.remaining == 0.0 }) return "额度留意"
    return if (provider.windows.any { quotaPercent(it) != null }) "额度充足" else "已同步"
}
