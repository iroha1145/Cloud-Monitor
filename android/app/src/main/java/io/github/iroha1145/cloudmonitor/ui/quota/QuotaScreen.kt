package io.github.iroha1145.cloudmonitor.ui.quota

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import io.github.iroha1145.cloudmonitor.data.*
import io.github.iroha1145.cloudmonitor.ui.components.ClientLogo
import io.github.iroha1145.cloudmonitor.ui.components.EmptyHint
import io.github.iroha1145.cloudmonitor.ui.components.Panel
import io.github.iroha1145.cloudmonitor.ui.components.PanelHead
import io.github.iroha1145.cloudmonitor.ui.theme.CmColorsCurrent
import io.github.iroha1145.cloudmonitor.vm.AuxStatus
import io.github.iroha1145.cloudmonitor.vm.UiState
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull
import java.text.NumberFormat
import java.util.Currency
import java.util.Locale

fun LazyListScope.quotaItems(state: UiState) {
    item("quota") { QuotaContent(state) }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun QuotaContent(state: UiState) {
    val cm = CmColorsCurrent
    val overview = state.overview
    val limits = overview?.limits.orEmpty()
    val showSubscriptions = state.subsStatus != AuxStatus.Unsupported && overview?.features?.subscriptions != false
    val subscriptions = if (showSubscriptions) state.subscriptions?.subscriptions.orEmpty() else emptyList()
    val zone = overview?.dashboardPeriod?.timeZone ?: overview?.dashboardTimeZone
    val fontScale = LocalDensity.current.fontScale
    Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Panel {
            PanelHead("额度与账单", "服务商配额和手动登记的账单分别展示")
            Spacer(Modifier.height(16.dp))
            FlowRow(horizontalArrangement = Arrangement.spacedBy(28.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                QuotaMetric("配额账户", "${limits.size} 个")
                QuotaMetric("配额周期", "${limits.sumOf { it.windows.size }} 个")
                QuotaMetric("订阅与充值", "${subscriptions.size} 项")
            }
        }
        Text("服务商配额", color = cm.ink, style = MaterialTheme.typography.titleLarge, modifier = Modifier.semantics { heading() })
        if (limits.isEmpty()) Panel { EmptyHint("尚未上报服务商配额") }
        else BoxWithConstraints(Modifier.fillMaxWidth()) {
            val columns = if (maxWidth >= 740.dp && fontScale <= 1.35f) 2 else 1
            Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
                limits.chunked(columns).forEach { group ->
                    Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                        group.forEach { provider -> Box(Modifier.weight(1f)) { ProviderQuota(provider, overview, zone) } }
                        if (group.size < columns) Spacer(Modifier.weight(1f))
                    }
                }
            }
        }
        if (showSubscriptions) {
            Text("订阅与账单", color = cm.ink, style = MaterialTheme.typography.titleLarge, modifier = Modifier.semantics { heading() })
            Text("来自已登记的订阅和充值记录。金额不代表实时余额。", color = cm.ink2, style = MaterialTheme.typography.bodyMedium)
            state.subscriptions?.updatedAt?.let { Text("更新于 ${Format.fmtDateTime(it, zone)}", color = cm.ink2, style = MaterialTheme.typography.bodySmall) }
            when {
                state.subsStatus == AuxStatus.Error -> Panel { Text("订阅清单读取失败，稍后刷新重试。", color = cm.crit, style = MaterialTheme.typography.bodyMedium) }
                state.subsStatus == AuxStatus.Loading -> Panel { EmptyHint("正在读取订阅清单…") }
                subscriptions.isEmpty() -> Panel { EmptyHint("尚未登记订阅或充值") }
                else -> BoxWithConstraints(Modifier.fillMaxWidth()) {
                    val columns = if (maxWidth >= 740.dp && fontScale <= 1.35f) 2 else 1
                    Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
                        subscriptions.chunked(columns).forEach { group ->
                            Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                                group.forEach { subscription -> Box(Modifier.weight(1f)) { SubscriptionCard(subscription) } }
                                if (group.size < columns) Spacer(Modifier.weight(1f))
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun ProviderQuota(provider: LimitProvider, overview: Overview?, zone: String?) {
    val cm = CmColorsCurrent
    val status = provider.sourceStatus ?: provider.status
    val stale = provider.stale || provider.windows.any { it.stale }
    val statusText = when {
        stale -> "数据已过期"
        status == "ok" -> "已同步"
        status == "unauthorized" -> "授权失效"
        status == "error" -> "读取失败"
        else -> "同步状态未知"
    }
    val balance = when (val raw = provider.balance) {
        is JsonPrimitive -> raw.doubleOrNull
        is JsonObject -> listOf("remaining", "total", "value", "amount").firstNotNullOfOrNull { (raw[it] as? JsonPrimitive)?.doubleOrNull }
        else -> null
    }?.takeIf { it.isFinite() }
    Panel {
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
            ClientLogo(provider.provider, size = 32.dp)
            Column(Modifier.weight(1f)) {
                Text(Format.fmtProvider(provider.provider), color = cm.ink, style = MaterialTheme.typography.titleLarge, modifier = Modifier.semantics { heading() })
                provider.planLabel?.takeIf { it.isNotBlank() }?.let { Text(it, color = cm.ink2, style = MaterialTheme.typography.bodyMedium) }
            }
        }
        Spacer(Modifier.height(12.dp))
        Text(statusText, color = if (status == "ok" && !stale) cm.okInk else cm.warnInk, style = MaterialTheme.typography.labelLarge)
        val account = listOfNotNull(provider.accountLabel, provider.accountName, provider.accountEmail?.let(Format::maskEmail)).filter { it.isNotBlank() }.distinct().joinToString(" · ")
        Text(account.ifBlank { "账户名称未提供" }, color = cm.ink2, style = MaterialTheme.typography.bodyMedium)
        provider.sourceMessage?.takeIf { it.isNotBlank() }?.let { Text(it, color = cm.warnInk, style = MaterialTheme.typography.bodySmall) }
        if (provider.balanceUsd != null || balance != null) {
            Spacer(Modifier.height(16.dp))
            QuotaMetric("账户余额", provider.balanceUsd?.takeIf { it.isFinite() }?.let(Format::fmtUsd) ?: balance?.let(Format::fmtCompact) ?: "未提供")
        }
        if (provider.windows.isEmpty() && provider.balanceUsd == null && balance == null) {
            Spacer(Modifier.height(16.dp))
            Text("额度数据未提供", color = cm.ink, style = MaterialTheme.typography.bodyMedium)
        }
        provider.windows.forEach { window ->
            Spacer(Modifier.height(16.dp))
            QuotaWindow(window, overview?.generatedAt, zone)
        }
        Spacer(Modifier.height(16.dp))
        HorizontalDivider(color = cm.border)
        Spacer(Modifier.height(12.dp))
        val device = provider.device?.takeIf { it.isNotBlank() }
            ?: overview?.devices?.find { it.deviceId == provider.sourceDeviceId }?.hostname
            ?: provider.sourceDeviceId?.takeIf { it.isNotBlank() }
        Text("来源设备 · ${device ?: "未提供"}", color = cm.ink2, style = MaterialTheme.typography.bodySmall)
        provider.sourceLabel?.takeIf { it.isNotBlank() }?.let { Text("数据来源 · $it", color = cm.ink2, style = MaterialTheme.typography.bodySmall) }
        Text("数据时间 · ${Format.fmtDateTime(provider.updatedAt ?: overview?.generatedAt, zone).ifBlank { "未提供" }}", color = cm.ink2, style = MaterialTheme.typography.bodySmall)
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun QuotaWindow(window: LimitWindow, generatedAt: String?, zone: String?) {
    val cm = CmColorsCurrent
    val used = window.used?.takeIf { it.isFinite() && it >= 0 }
    val remaining = window.remaining?.takeIf { it.isFinite() && it >= 0 }
    val limit = window.limit?.takeIf { it.isFinite() && it >= 0 }
    val explicitPercent = window.usedPercent?.takeIf { it.isFinite() && it >= 0 }
    val derived = if (used != null && limit != null && limit > 0) used / limit * 100 else null
    val percent = (explicitPercent ?: derived)?.coerceIn(0.0, 100.0)
    val metric = window.metric.orEmpty().lowercase()
    val currency = window.currency ?: if (metric == "spend") "USD" else null
    val color = when { percent == null -> cm.ink2; percent >= 90 -> cm.crit; percent >= 75 -> cm.warnInk; else -> cm.brand }
    val label = window.label ?: window.name ?: window.window ?: window.kind ?: "使用额度"
    val headline = when {
        explicitPercent != null -> "已用 ${percentText(explicitPercent)}"
        remaining != null -> "剩余 ${quotaAmount(remaining, currency)}"
        used != null -> "已用 ${quotaAmount(used, currency)}"
        else -> "用量未提供"
    }
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(cm.canvas).padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(label, color = cm.ink2, style = MaterialTheme.typography.labelLarge)
        Text(headline, color = cm.ink, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
        if (window.showMeter && percent != null && metric != "balance") {
            LinearProgressIndicator(progress = { (percent / 100).toFloat() }, modifier = Modifier.fillMaxWidth().height(6.dp),
                color = color, trackColor = cm.border)
        }
        FlowRow(horizontalArrangement = Arrangement.spacedBy(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            if (explicitPercent != null) Text("剩余 ${percentText(100.0 - explicitPercent.coerceIn(0.0, 100.0))}", color = cm.ink2, style = MaterialTheme.typography.bodySmall)
            used?.let { Text("已用 ${quotaAmount(it, currency)}", color = cm.ink2, style = MaterialTheme.typography.bodySmall) }
            remaining?.let { Text("剩余 ${quotaAmount(it, currency)}", color = cm.ink2, style = MaterialTheme.typography.bodySmall) }
            limit?.let { Text("上限 ${quotaAmount(it, currency)}", color = cm.ink2, style = MaterialTheme.typography.bodySmall) }
        }
        if (explicitPercent == null && derived != null) Text("已用比例 ${percentText(derived)}，按已用额度与上限计算。", color = cm.ink2, style = MaterialTheme.typography.bodySmall)
        val reset = Format.parseMillis(window.resetsAt)
        val snapshot = Format.parseMillis(generatedAt) ?: System.currentTimeMillis()
        Text(when {
            reset == null -> "重置时间未提供"
            reset <= snapshot -> "重置时间已过，等待来源更新 · ${Format.fmtDateTime(window.resetsAt, zone)}"
            else -> "${Format.fmtReset(window.resetsAt, snapshot)} · ${Format.fmtDateTime(window.resetsAt, zone)}"
        }, color = if (reset != null && reset <= snapshot) cm.warnInk else cm.ink2, style = MaterialTheme.typography.bodySmall)
        if (window.stale) Text("此周期数据已过期", color = cm.warnInk, style = MaterialTheme.typography.bodySmall)
        window.sourceMessage?.takeIf { it.isNotBlank() }?.let { Text(it, color = cm.warnInk, style = MaterialTheme.typography.bodySmall) }
        window.sourceLabel?.takeIf { it.isNotBlank() }?.let { Text("来源 · $it", color = cm.ink2, style = MaterialTheme.typography.bodySmall) }
        window.updatedAt?.let { Text("更新于 ${Format.fmtDateTime(it, zone)}", color = cm.ink2, style = MaterialTheme.typography.bodySmall) }
    }
}

@Composable
private fun SubscriptionCard(subscription: Subscription) {
    val cm = CmColorsCurrent
    val topup = subscription.kind.equals("topup", true)
    var expanded by rememberSaveable(subscription.id, subscription.planName) { mutableStateOf(false) }
    Panel {
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
            ClientLogo(subscription.provider, size = 28.dp)
            Text(Format.fmtProvider(subscription.provider), color = cm.ink2, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
        }
        Spacer(Modifier.height(12.dp))
        Text(subscription.planName ?: "未命名订阅", color = cm.ink, style = MaterialTheme.typography.titleLarge)
        Text(if (topup) "充值台账" else if (subscription.autoRenew) "自动续费" else "手动续费", color = if (!topup && subscription.autoRenew) cm.okInk else cm.ink2, style = MaterialTheme.typography.labelLarge)
        Spacer(Modifier.height(16.dp))
        val knownTopups = subscription.topUps.mapNotNull { it.amountMinor }
        val allTopupsKnown = knownTopups.size == subscription.topUps.size
        val value = if (topup) {
            if (allTopupsKnown && knownTopups.isNotEmpty()) Format.fmtMoney(knownTopups.sum(), subscription.currency) else "未提供"
        } else subscription.amountMinor?.let { Format.fmtMoney(it, subscription.currency) } ?: "未提供"
        QuotaMetric(if (topup) "累计充值" else "订阅费用", value)
        if (!topup) Text(Format.billingInterval(subscription.interval, subscription.intervalCount), color = cm.ink2, style = MaterialTheme.typography.bodyMedium)
        Spacer(Modifier.height(12.dp))
        if (topup) {
            Text("充值记录 ${subscription.topUps.size} 笔", color = cm.ink2, style = MaterialTheme.typography.bodyMedium)
            subscription.topUps.mapNotNull { it.date }.maxOrNull()?.let { Text("最近充值 ${it.take(10)}", color = cm.ink2, style = MaterialTheme.typography.bodySmall) }
            if (!allTopupsKnown) Text("部分充值金额缺失，暂不显示累计金额。", color = cm.warnInk, style = MaterialTheme.typography.bodySmall)
        } else {
            Text("开始日期 · ${subscription.startDate?.take(10) ?: "未提供"}", color = cm.ink2, style = MaterialTheme.typography.bodySmall)
            Text("下次续费 · ${subscription.nextRenewalOverride?.take(10) ?: "未提供"}", color = cm.ink2, style = MaterialTheme.typography.bodySmall)
        }
        subscription.endDate?.let { Text("结束日期 · ${it.take(10)}", color = cm.ink2, style = MaterialTheme.typography.bodySmall) }
        val binding = listOfNotNull(subscription.binding?.profileName, subscription.binding?.accountEmail?.let(Format::maskEmail), subscription.binding?.accountKey?.let(Format::truncateKey)).filter { it.isNotBlank() }.joinToString(" · ")
        if (binding.isNotBlank()) Text("绑定账户 · $binding", color = cm.ink2, style = MaterialTheme.typography.bodySmall)
        subscription.note?.takeIf { it.isNotBlank() }?.let { Text("备注 · $it", color = cm.ink2, style = MaterialTheme.typography.bodySmall) }
        if (subscription.topUps.isNotEmpty()) {
            TextButton(onClick = { expanded = !expanded }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text(if (expanded) "收起充值明细" else "查看充值明细") }
            if (expanded) subscription.topUps.forEach { record ->
                HorizontalDivider(color = cm.border)
                Column(Modifier.padding(vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(record.label ?: if (topup) "充值" else "加购", color = cm.ink, style = MaterialTheme.typography.bodyMedium)
                    Text(record.amountMinor?.let { Format.fmtMoney(it, subscription.currency) } ?: "金额未提供", color = cm.ink, style = MaterialTheme.typography.titleSmall)
                    Text(record.date?.take(10) ?: "日期未提供", color = cm.ink2, style = MaterialTheme.typography.bodySmall)
                }
            }
        }
    }
}

@Composable
private fun QuotaMetric(label: String, value: String) {
    val cm = CmColorsCurrent
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(label, color = cm.ink2, style = MaterialTheme.typography.bodySmall)
        Text(value, color = cm.ink, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
    }
}

private fun percentText(value: Double): String = String.format(Locale.US, "%.1f", value).removeSuffix(".0") + "%"

private fun quotaAmount(value: Double, currency: String?): String {
    if (currency.isNullOrBlank()) return Format.fmtCompact(value)
    return runCatching { NumberFormat.getCurrencyInstance(Locale.SIMPLIFIED_CHINESE).apply { this.currency = Currency.getInstance(currency.uppercase(Locale.US)) }.format(value) }
        .getOrElse { "${currency.uppercase(Locale.US)} ${String.format(Locale.US, "%.2f", value)}" }
}
