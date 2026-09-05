package io.github.iroha1145.cloudmonitor.ui.overview

import androidx.compose.foundation.clickable
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.github.iroha1145.cloudmonitor.data.*
import io.github.iroha1145.cloudmonitor.ui.AppIcons
import io.github.iroha1145.cloudmonitor.ui.openHttpUrl
import io.github.iroha1145.cloudmonitor.ui.components.*
import io.github.iroha1145.cloudmonitor.ui.theme.CmColorsCurrent
import io.github.iroha1145.cloudmonitor.vm.AuxStatus
import io.github.iroha1145.cloudmonitor.vm.Period
import io.github.iroha1145.cloudmonitor.vm.UiState

@Suppress("UNUSED_PARAMETER")
fun LazyListScope.overviewItems(
    state: UiState,
    modelColors: Map<String, Color>,
    onModelPeriod: (Period) -> Unit,
    onClientPeriod: (Period) -> Unit,
    onMxPeriod: (Period) -> Unit,
    onMxCost: (Boolean) -> Unit,
) {
    val ov = state.overview ?: return
    item("summary") { SummaryPanel(state) }
    item("trend") {
        var days by rememberSaveable { mutableIntStateOf(7) }
        val rows = remember(ov, state.history, days) { analyzeTrend(ov, state.history).takeLast(days) }
        val summary = remember(rows) { summarizeTrend(rows) }
        val cm = CmColorsCurrent
        Panel(Modifier.padding(bottom = 16.dp)) {
            PanelHead("每日趋势", "每日实际用量与费用")
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                listOf(7, 30).forEach { n ->
                    FilterChip(selected = days == n, onClick = { days = n }, label = { Text("近 $n 天") },
                        modifier = Modifier.heightIn(min = 48.dp).testTag("trend-$n"))
                }
            }
            AdaptiveMetrics {
                Metric("词元用量", Format.fmtCompact(summary.tokenTotal), Modifier.weight(1f))
                Metric("${if (summary.partialCache) "已识别" else ""}缓存占比", summary.cacheRate?.let { Format.fmtPct(it) } ?: "未提供", Modifier.weight(1f),
                    note = if (summary.cacheSkippedDays > 0) {
                        if (summary.cacheDays > 0) "仅统计 ${summary.cacheDays}/${rows.size} 天" else "暂无缓存明细"
                    } else "缓存读取 ÷ 总词元", color = cm.okInk)
            }
            Spacer(Modifier.height(18.dp))
            if (rows.isEmpty()) EmptyHint("暂无每日趋势数据")
            else StackedTrendChart(rows, modelColors, emptyList())
            if (summary.cacheSkippedDays > 0) Text("缺少缓存明细的日期不参与缓存占比计算。", color = cm.mute,
                style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 8.dp))
        }
    }
    item("clients") {
        val per = ov.totals.period(state.clientPeriod.key)
        val clients = clientUsage(per)
        Panel(Modifier.padding(bottom = 16.dp)) {
            PanelHead("客户端用量", "按用量排序", trailing = { PeriodSeg(state.clientPeriod, onClientPeriod) })
            Spacer(Modifier.height(8.dp))
            if (clients.isEmpty()) EmptyHint("该周期暂无客户端数据")
            clients.forEach { entry ->
                val segments = clientBreakdown(per, entry.id)
                Column(Modifier.fillMaxWidth().tipClick(entry.name, listOf("词元用量" to Format.fmtInt(entry.totalTokens),
                    "费用" to (entry.costUsd?.let(Format::fmtUsd) ?: "未提供"), entry.components.cacheLabel to (entry.components.cacheRate?.let(Format::fmtPct) ?: "未提供")))
                    .padding(vertical = 12.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        ClientLogo(entry.name, 22.dp)
                        Text(entry.name, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium)
                        Text(Format.fmtCompact(entry.totalTokens), style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                    }
                    Spacer(Modifier.height(8.dp))
                    MixBar(if (segments.isEmpty()) listOf(SEG_UNCLS to entry.totalTokens) else segments.map { it.color to it.value }, Modifier.fillMaxWidth())
                    Text(entry.costUsd?.let(Format::fmtUsd) ?: "费用未提供", color = CmColorsCurrent.mute,
                        style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 6.dp))
                }
            }
        }
    }
    when (state.providersStatus) {
        AuxStatus.Error -> item("provider-error") { Panel(Modifier.padding(bottom = 16.dp)) { Text("提供商状态暂不可用", color = CmColorsCurrent.warnInk) } }
        AuxStatus.Ready, AuxStatus.Loading -> if (state.providers.isNotEmpty() || state.providersPartial) {
            item("providers") { Box(Modifier.padding(bottom = 16.dp)) { ProviderPanel(state.providers, state.providersPartial, state.providersPartialErrors) } }
        }
        else -> Unit
    }
    val sessions = ov.sessions.sortedByDescending { Format.parseMillis(it.lastUsedAt) ?: 0L }.take(5)
    if (sessions.isNotEmpty()) item("sessions") {
        Panel(Modifier.padding(bottom = 16.dp)) {
            PanelHead("最近会话", "最近使用的 ${sessions.size} 条")
            sessions.forEach { session ->
                Column(Modifier.fillMaxWidth().heightIn(min = 48.dp).tipClick(session.client ?: "会话", listOf(
                    "会话" to (session.sessionId ?: "未提供"), "项目" to (session.project ?: "未提供"),
                    "设备" to (session.device ?: "未提供"), "模型" to session.models.keys.joinToString("、"),
                    "词元用量" to Format.fmtInt(session.tokens), "费用" to Format.fmtUsd(session.costUsd))).padding(vertical = 12.dp)) {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                        ClientLogo(session.client, 20.dp)
                        Text(session.client ?: "未知客户端", Modifier.weight(1f), fontWeight = FontWeight.Medium)
                        Text(Format.fmtCompact(session.tokens), style = MaterialTheme.typography.bodyMedium)
                    }
                    Text(listOfNotNull(session.project, session.device, Format.relTime(session.lastUsedAt)).joinToString(" · "),
                        color = CmColorsCurrent.mute, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 4.dp))
                }
            }
            if (sessionsDetailsIncomplete(ov)) Text("部分会话明细未完整返回。", color = CmColorsCurrent.warnInk, style = MaterialTheme.typography.bodySmall)
        }
    }
}

@Composable
private fun SummaryPanel(state: UiState) {
    val ov = state.overview ?: return
    var periodName by rememberSaveable { mutableStateOf(Period.Today.name) }
    val selected = Period.valueOf(periodName)
    val per = ov.totals.period(selected.key)
    val components = usageComponents(per)
    val segments = componentBreakdown(per).second
    val cm = CmColorsCurrent
    val (connection, healthy) = connBanner(ov, state.demo, state.staleData)
    Panel(Modifier.padding(bottom = 16.dp).testTag("usage-summary")) {
        PanelHead("用量概览", "掌握每一次调用", trailing = { PeriodSeg(selected) { periodName = it.name } })
        Spacer(Modifier.height(16.dp))
        AdaptiveMetrics {
            Metric("${selected.label}词元", Format.fmtCompact(per.totalTokens), Modifier.weight(1f), "计量单位：词元（Token）")
            Metric("${selected.label}费用", periodCost(per)?.let(Format::fmtUsd) ?: "未提供", Modifier.weight(1f))
        }
        Spacer(Modifier.height(20.dp))
        MixBar(segments.map { it.color to it.value }, Modifier.fillMaxWidth(), height = 10.dp)
        Spacer(Modifier.height(12.dp))
        ComponentLegend(segments)
        if (components.partial && per.totalTokens > 0) Text("部分用量缺少构成明细，已保留在未分类用量中。", color = cm.mute,
            style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 10.dp))
        HorizontalDivider(Modifier.padding(vertical = 16.dp), color = cm.border)
        AdaptiveMetrics {
            Metric(components.cacheLabel, components.cacheRate?.let(Format::fmtPct) ?: "未提供", Modifier.weight(1f), color = cm.okInk)
            Metric("在线设备", "${ov.devices.count { deviceOnline(it, ov) == true }} / ${ov.devices.size}", Modifier.weight(1f))
        }
        Text(connection, color = if (healthy) cm.okInk else cm.warnInk, style = MaterialTheme.typography.bodySmall,
            modifier = Modifier.padding(top = 12.dp))
    }
}

@Composable
private fun AdaptiveMetrics(content: @Composable RowScope.() -> Unit) {
    // Metrics may wrap their values; no fixed card height or clipped scalable text.
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(16.dp), content = content)
}
@Composable
private fun ProviderPanel(providers: List<ProviderCard>, partial: Boolean, errors: List<String>) {
    val cm = CmColorsCurrent
    val context = LocalContext.current
    Panel {
        PanelHead("提供商状态", "今日有上报的提供商 · 来自各官方公开状态页")
        Spacer(Modifier.height(10.dp))
        if (partial) {
            val extra = errors.map { Format.pvErrorText(it).ifBlank { it } }.filter { it.isNotBlank() }
            Text(
                "部分提供商状态来源暂不可用" + if (extra.isNotEmpty()) "（${extra.joinToString("、")}）" else "",
                color = cm.warnInk,
                fontSize = 12.sp,
                modifier = Modifier.padding(bottom = 8.dp),
            )
        }
        providers.forEach { p ->
            val unavailable = p.status == "unknown" && !p.errorCode.isNullOrBlank()
            // 对齐网页 PV_STATUS 四档语义色：operational=ok / outage=crit / 无错误的 unknown=灰 / 其余=warn
            val level = when {
                unavailable -> "warn"
                p.status == "operational" && p.errorCode == null -> "ok"
                p.status == "outage" || p.status == "partial_outage" || p.status == "major_outage" -> "crit"
                p.status == "unknown" || p.status.isBlank() -> "mute"
                else -> "warn"
            }
            val label = when {
                unavailable -> "状态页暂不可用"
                p.status == "degraded" -> "部分降级"
                p.status == "outage" -> "服务中断"
                p.status == "unknown" || p.status.isBlank() -> "状态未知"
                else -> Format.fmtStatusLabel(p.status)
            }
            val desc = when {
                unavailable -> Format.pvErrorText(p.errorCode).ifBlank { p.errorCode.orEmpty() }
                else -> Format.fmtStatusLine(p.status, p.description)
            } + if (p.stale) " · 缓存数据" else ""
            val name = Format.pvNameOverride(p.provider, p.name.ifBlank { Format.fmtProvider(p.provider) })
            val url = Format.safeHttpUrl(p.url)
            Row(
                Modifier
                    .fillMaxWidth()
                    .padding(vertical = 8.dp)
                    .then(
                        if (url != null) Modifier.clickable { context.openHttpUrl(url) } else Modifier,
                    ),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                ClientLogo(p.provider)
                Spacer(Modifier.width(10.dp))
                Column(Modifier.weight(1f)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(name, color = cm.ink, fontWeight = FontWeight.Medium)
                        if (url != null) {
                            Spacer(Modifier.width(4.dp))
                            Icon(AppIcons.OpenInNew, "打开状态页", tint = cm.mute, modifier = Modifier.size(14.dp))
                        }
                    }
                    Text(desc, color = cm.mute, fontSize = 12.sp)
                    p.checkedAt?.let { Text("检测于 ${Format.relTime(it)}", color = cm.mute, fontSize = 11.sp) }
                }
                val badgeBg = when (level) {
                    "ok" -> cm.okBg
                    "crit" -> cm.critBg
                    "mute" -> cm.canvas
                    else -> cm.warnBg
                }
                val badgeInk = when (level) {
                    "ok" -> cm.okInk
                    "crit" -> cm.crit
                    "mute" -> cm.mute
                    else -> cm.warnInk
                }
                Box(
                    Modifier
                        .clip(RoundedCornerShape(999.dp))
                        .background(badgeBg)
                        .padding(horizontal = 8.dp, vertical = 3.dp),
                ) {
                    Text(label, color = badgeInk, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
                }
            }
        }
    }
}
