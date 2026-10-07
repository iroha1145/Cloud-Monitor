package io.github.iroha1145.cloudmonitor.ui.quota

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
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
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.progressBarRangeInfo
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.github.iroha1145.cloudmonitor.data.*
import io.github.iroha1145.cloudmonitor.ui.components.ClientLogo
import io.github.iroha1145.cloudmonitor.ui.components.EmptyHint
import io.github.iroha1145.cloudmonitor.ui.components.MeterBar
import io.github.iroha1145.cloudmonitor.ui.components.Panel
import io.github.iroha1145.cloudmonitor.ui.components.PanelHead
import io.github.iroha1145.cloudmonitor.ui.theme.CmColorsCurrent
import io.github.iroha1145.cloudmonitor.ui.theme.EaseSmoothOut
import io.github.iroha1145.cloudmonitor.ui.theme.Motion
import io.github.iroha1145.cloudmonitor.vm.AuxStatus
import io.github.iroha1145.cloudmonitor.vm.UiState
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
            PanelHead("额度概况", "服务商配额和手动登记的账单分别展示")
            Spacer(Modifier.height(14.dp))
            val providers = limits.map { it.provider }.filter { it.isNotBlank() }.toSet().size
            val nearLimit = limits.sumOf { provider -> provider.windows.count { (it.usedPercent ?: -1.0) >= 75.0 } }
            val summary = listOf(
                "已连接服务" to "$providers 个",
                "接近额度上限" to "$nearLimit 个",
                "订阅与充值" to "${subscriptions.size} 项",
            )
            if (fontScale > 1.5f) {
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    summary.forEach { (label, value) -> QuotaMetric(label, value) }
                }
            } else {
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    summary.forEach { (label, value) -> QuotaMetric(label, value, Modifier.weight(1f)) }
                }
            }
        }
        Text("服务商配额", color = cm.ink, fontSize = 16.sp, lineHeight = 22.sp, fontWeight = FontWeight.Medium, modifier = Modifier.semantics { heading() })
        if (limits.isEmpty()) Panel {
            Text("还没有配额数据", color = cm.ink, style = MaterialTheme.typography.titleMedium)
            Text("连接支持配额上报的服务后，将显示可用额度和重置时间。", color = cm.ink2, style = MaterialTheme.typography.bodyMedium)
        }
        else BoxWithConstraints(Modifier.fillMaxWidth()) {
            val columns = if (maxWidth >= 740.dp && fontScale <= 1.35f) 2 else 1
            Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
                limits.mapIndexed { index, provider -> index to provider }.chunked(columns).forEach { group ->
                    Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                        group.forEach { (index, provider) -> Box(Modifier.weight(1f)) { ProviderQuota(provider, overview, zone, index) } }
                        if (group.size < columns) Spacer(Modifier.weight(1f))
                    }
                }
            }
        }
        if (showSubscriptions) {
            Text("订阅与账单", color = cm.ink, fontSize = 16.sp, lineHeight = 22.sp, fontWeight = FontWeight.Medium, modifier = Modifier.semantics { heading() })
            Text("来自已登记的订阅和充值记录。金额不代表实时余额。", color = cm.ink2, fontSize = 12.sp, lineHeight = 18.sp)
            state.subscriptions?.updatedAt?.let { Text("更新于 ${Format.fmtDateTime(it, zone)}", color = cm.ink2, style = MaterialTheme.typography.bodySmall) }
            when {
                state.subsStatus == AuxStatus.Error -> Panel { Text("订阅清单读取失败，稍后刷新重试。", color = cm.crit, style = MaterialTheme.typography.bodyMedium) }
                state.subsStatus == AuxStatus.Loading -> Panel { EmptyHint("正在读取订阅清单…") }
                subscriptions.isEmpty() -> Panel {
                    Text("尚未记录订阅", color = cm.ink, style = MaterialTheme.typography.titleMedium)
                    Text("已有的订阅记录会显示在这里；缺失的价格不会按零元计算。", color = cm.ink2, style = MaterialTheme.typography.bodyMedium)
                }
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
private fun ProviderQuota(provider: LimitProvider, overview: Overview?, zone: String?, cardIndex: Int) {
    val cm = CmColorsCurrent
    val statusText = quotaGroupStatus(provider)
    val balance = providerBalance(provider)
    Panel {
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(34.dp).clip(RoundedCornerShape(8.dp)).background(cm.inset), contentAlignment = Alignment.Center) {
                ClientLogo(provider.provider, size = 24.dp)
            }
            Column(Modifier.weight(1f)) {
                Text(Format.fmtProvider(provider.provider), color = cm.ink, fontSize = 16.sp, lineHeight = 22.sp,
                    fontWeight = FontWeight.SemiBold, modifier = Modifier.semantics { heading() })
                provider.planLabel?.takeIf { it.isNotBlank() }?.let { Text(it, color = cm.ink2, fontSize = 11.sp, lineHeight = 16.sp) }
            }
        }
        Spacer(Modifier.height(12.dp))
        Text(statusText, color = if (statusText == "额度充足" || statusText == "已同步") cm.okInk else cm.warnInk, fontSize = 11.sp, lineHeight = 16.sp)
        val account = listOfNotNull(provider.accountLabel, provider.accountName, provider.accountEmail?.let(Format::maskEmail)).filter { it.isNotBlank() }.distinct().joinToString(" · ")
        Text(account.ifBlank { "账户名称未提供" }, color = cm.ink2, fontSize = 11.sp, lineHeight = 16.sp)
        provider.sourceMessage?.takeIf { it.isNotBlank() }?.let { Text(it, color = cm.warnInk, style = MaterialTheme.typography.bodySmall) }
        if (provider.balanceUsd != null || balance != null) {
            Spacer(Modifier.height(16.dp))
            QuotaMetric("账户余额", provider.balanceUsd?.takeIf { it.isFinite() }?.let(Format::fmtUsd) ?: balance?.let(Format::fmtCompact) ?: "未提供")
        }
        if (provider.windows.isEmpty() && provider.balanceUsd == null && balance == null) {
            Spacer(Modifier.height(16.dp))
            Text("额度数据未提供", color = cm.ink, style = MaterialTheme.typography.bodyMedium)
        }
        provider.windows.forEachIndexed { index, window ->
            Spacer(Modifier.height(13.dp))
            if (index > 0) {
                HorizontalDivider(color = cm.border)
                Spacer(Modifier.height(13.dp))
            }
            QuotaWindow(window, provider, overview?.generatedAt, zone, cardIndex)
        }
        QuotaExtras(provider, zone)
        Spacer(Modifier.height(16.dp))
        HorizontalDivider(color = cm.border)
        Spacer(Modifier.height(12.dp))
        val device = provider.device?.takeIf { it.isNotBlank() }
            ?: overview?.devices?.find { it.deviceId == provider.sourceDeviceId }?.hostname
            ?: provider.sourceDeviceId?.takeIf { it.isNotBlank() }
        Text("来源设备 · ${device ?: "未提供"}", color = cm.ink2, fontSize = 10.sp, lineHeight = 15.sp)
        provider.sourceLabel?.takeIf { it.isNotBlank() }?.let { Text("数据来源 · $it", color = cm.ink2, fontSize = 10.sp, lineHeight = 15.sp) }
        Text("数据时间 · ${Format.fmtDateTime(provider.updatedAt ?: overview?.generatedAt, zone).ifBlank { "未提供" }}", color = cm.ink2, fontSize = 10.sp, lineHeight = 15.sp)
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun QuotaWindow(window: LimitWindow, provider: LimitProvider, generatedAt: String?, zone: String?, cardIndex: Int) {
    val cm = CmColorsCurrent
    val used = window.used?.takeIf { it.isFinite() && it >= 0 }
    val remaining = window.remaining?.takeIf { it.isFinite() && it >= 0 }
    val limit = window.limit?.takeIf { it.isFinite() && it >= 0 }
    val explicitPercent = window.usedPercent?.takeIf { it.isFinite() && it >= 0 }
    val derived = if (used != null && limit != null && limit > 0) used / limit * 100 else null
    val percent = (explicitPercent ?: derived)?.coerceIn(0.0, 100.0)
    val metric = window.metric.orEmpty().lowercase()
    val currency = window.currency ?: if (metric == "spend") "USD" else null
    val color = quotaBarColor(cardIndex, percent)
    val label = window.label ?: window.name ?: window.window ?: window.kind ?: "使用额度"
    val headline = quotaHeadline(window, provider)
    val boundary = quotaBoundaryLabel(window.boundaryKind)
    Column(Modifier.fillMaxWidth().padding(vertical = 5.dp), verticalArrangement = Arrangement.spacedBy(7.dp)) {
        FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(label, color = cm.ink2, fontSize = 12.sp, lineHeight = 18.sp)
            Text(listOf(headline.value, headline.label).filter { it.isNotBlank() }.joinToString(" "),
                color = cm.ink, fontSize = 13.sp, lineHeight = 18.sp, fontWeight = FontWeight.Medium)
        }
        if (window.showMeter && percent != null && metric != "balance") {
            val progress = (percent / 100).toFloat()
            MeterBar(progress, color, cm.border, Modifier.semantics { progressBarRangeInfo = ProgressBarRangeInfo(progress, 0f..1f) })
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
        val boundaryName = if (window.resetsAt.isNullOrBlank()) "期限" else "${boundary}时间"
        Text(when {
            reset == null -> "${boundaryName}未提供"
            reset <= snapshot -> "${boundaryName}已过，等待来源更新 · ${Format.fmtDateTime(window.resetsAt, zone)}"
            else -> "$boundaryName ${Format.fmtReset(window.resetsAt, snapshot)} · ${Format.fmtDateTime(window.resetsAt, zone)}"
        }, color = if (reset != null && reset <= snapshot) cm.warnInk else cm.ink2, style = MaterialTheme.typography.bodySmall)
        window.resetDescription?.takeIf { it.isNotBlank() }?.let { Text(it, color = cm.ink2, style = MaterialTheme.typography.bodySmall) }
        window.detail?.takeIf { it.isNotBlank() }?.let { Text(it, color = cm.ink2, style = MaterialTheme.typography.bodySmall) }
        if (window.stale) Text("此周期数据已过期", color = cm.warnInk, style = MaterialTheme.typography.bodySmall)
        window.sourceMessage?.takeIf { it.isNotBlank() }?.let { Text(it, color = cm.warnInk, style = MaterialTheme.typography.bodySmall) }
        window.sourceLabel?.takeIf { it.isNotBlank() }?.let { Text("来源 · $it", color = cm.ink2, style = MaterialTheme.typography.bodySmall) }
        window.updatedAt?.let { Text("更新于 ${Format.fmtDateTime(it, zone)}", color = cm.ink2, style = MaterialTheme.typography.bodySmall) }
    }
}

@Composable
private fun QuotaExtras(provider: LimitProvider, zone: String?) {
    val cm = CmColorsCurrent
    val action = quotaActionText(provider)
    val reset = provider.resetCredits
    val tranches = balanceTranches(provider)
    val rows = quotaExtraRows(provider, zone)
    var open by rememberSaveable(provider.provider, provider.id, provider.accountKey) { mutableStateOf(false) }
    if (action.isBlank() && reset == null && tranches.isEmpty() && rows.isEmpty()) return
    Column(Modifier.padding(top = 12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        if (action.isNotBlank()) Text(action, color = cm.warnInk, style = MaterialTheme.typography.bodySmall)
        reset?.let { credits ->
            Text("可用重置次数：${credits.availableCount?.let(::quotaNumber) ?: "未提供"}", color = cm.ink, fontWeight = FontWeight.Medium, fontSize = 13.sp)
            credits.nextExpiresAt?.let { Text("最近到期：${Format.fmtDateTime(it, zone).ifBlank { it }}", color = cm.ink2, style = MaterialTheme.typography.bodySmall) }
        }
        if (reset?.grants?.isNotEmpty() == true || tranches.isNotEmpty() || rows.isNotEmpty()) {
            TextButton(onClick = { open = !open }, modifier = Modifier.heightIn(min = 48.dp)) {
                Text(if (open) "收起额度明细" else "查看额度明细", fontSize = 12.sp)
            }
            AnimatedVisibility(
                open,
                enter = fadeIn(tween(Motion.Fast, easing = EaseSmoothOut)) + expandVertically(tween(Motion.Fast, easing = EaseSmoothOut)),
                exit = fadeOut(tween(Motion.Fast, easing = EaseSmoothOut)) + shrinkVertically(tween(Motion.Fast, easing = EaseSmoothOut)),
            ) {
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    reset?.grants?.forEachIndexed { index, grant ->
                        Text(grant.label.ifBlank { "额度 ${index + 1}" }, color = cm.ink, style = MaterialTheme.typography.bodyMedium)
                        Text(buildString {
                            append(grant.resetsLeft?.let { "剩余 ${quotaNumber(it)} 次" } ?: "剩余次数未提供")
                            grant.resetsTotal?.let { append(" / 共 ${quotaNumber(it)} 次") }
                        }, color = cm.ink2, style = MaterialTheme.typography.bodySmall)
                        grant.endsAt?.let { Text("到期：${Format.fmtDateTime(it, zone)}", color = cm.ink2, style = MaterialTheme.typography.bodySmall) }
                        if (grant.clears.isNotEmpty()) Text("可重置：${grant.clears.joinToString("、", transform = ::grantWindowName)}", color = cm.ink2, style = MaterialTheme.typography.bodySmall)
                        if (grant.paused == true) Text("当前暂停使用", color = cm.warnInk, style = MaterialTheme.typography.bodySmall)
                        if (grant.useRequiresLimit == true) Text("达到额度上限后可用", color = cm.ink2, style = MaterialTheme.typography.bodySmall)
                        if (grant.usableNow == false && grant.paused != true) Text("当前不可使用", color = cm.ink2, style = MaterialTheme.typography.bodySmall)
                    }
                    tranches.forEach { tranche ->
                        Text("${quotaBalanceAmount(tranche.amount, tranche.currency, balanceCurrency(provider))} · ${tranche.expiresAt?.let { "到期 ${Format.fmtDateTime(it, zone)}" } ?: "到期时间未提供"}",
                            color = cm.ink2, style = MaterialTheme.typography.bodySmall)
                    }
                    rows.forEach { (label, value) ->
                        Text("$label · $value", color = cm.ink2, style = MaterialTheme.typography.bodySmall)
                    }
                }
            }
        }
    }
}

@Composable
private fun SubscriptionCard(subscription: Subscription) {
    val cm = CmColorsCurrent
    val topup = subscription.kind.equals("topup", true)
    var expanded by rememberSaveable(subscription.id, subscription.planName) { mutableStateOf(false) }
    Panel {
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
            ClientLogo(subscription.provider, size = 24.dp)
            Text(Format.fmtProvider(subscription.provider), color = cm.ink2, fontSize = 12.sp, lineHeight = 18.sp, modifier = Modifier.weight(1f))
        }
        Spacer(Modifier.height(12.dp))
        Text(subscription.planName ?: "未命名订阅", color = cm.ink, fontSize = 16.sp, lineHeight = 22.sp, fontWeight = FontWeight.SemiBold)
        Text(if (topup) "充值台账" else if (subscription.autoRenew) "自动续费" else "手动续费", color = if (!topup && subscription.autoRenew) cm.okInk else cm.ink2, fontSize = 11.sp, lineHeight = 16.sp)
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
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                TextButton(onClick = { expanded = !expanded }, modifier = Modifier.heightIn(min = 48.dp), shape = RoundedCornerShape(6.dp)) {
                    Text(if (expanded) "收起充值明细" else "查看充值明细", fontSize = 12.sp)
                }
            }
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
private fun QuotaMetric(label: String, value: String, modifier: Modifier = Modifier) {
    val cm = CmColorsCurrent
    Column(modifier, verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(label, color = cm.ink2, fontSize = 11.sp, lineHeight = 15.sp)
        Text(value, color = cm.ink, fontSize = 21.sp, lineHeight = 27.sp, fontWeight = FontWeight.SemiBold)
    }
}

private fun percentText(value: Double): String = String.format(Locale.US, "%.1f", value).removeSuffix(".0") + "%"

private fun quotaAmount(value: Double, currency: String?): String {
    if (currency.isNullOrBlank()) return Format.fmtCompact(value)
    return runCatching { NumberFormat.getCurrencyInstance(Locale.SIMPLIFIED_CHINESE).apply { this.currency = Currency.getInstance(currency.uppercase(Locale.US)) }.format(value) }
        .getOrElse { "${currency.uppercase(Locale.US)} ${String.format(Locale.US, "%.2f", value)}" }
}
