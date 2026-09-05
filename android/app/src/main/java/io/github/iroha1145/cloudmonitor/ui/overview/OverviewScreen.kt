@file:OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)

package io.github.iroha1145.cloudmonitor.ui.overview

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
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
import io.github.iroha1145.cloudmonitor.ui.PageState

@Suppress("UNUSED_PARAMETER")
fun LazyListScope.overviewItems(
    state: UiState,
    modelColors: Map<String, Color>,
    onModelPeriod: (Period) -> Unit,
    onClientPeriod: (Period) -> Unit,
    onMxPeriod: (Period) -> Unit,
    onMxCost: (Boolean) -> Unit,
    page: PageState,
) {
    val ov = state.overview ?: return
    item("summary") { SummaryPanel(state, page) }
    item("trend") {
        var days by page.trendDays
        val rows = remember(ov, state.history, days) { trendWindow(analyzeTrend(ov, state.history), days) }
        val summary = remember(rows) { summarizeTrend(rows) }
        Panel(Modifier.padding(bottom = 16.dp)) {
            PanelHead("用量趋势", "沿着曲线，查看每一天的花费与缓存", trailing = {
                WebSegments(listOf("7 天", "30 天"), if (days == 7) 0 else 1,
                    { days = if (it == 0) 7 else 30 }, tags = listOf("trend-7", "trend-30"))
            })
            Spacer(Modifier.height(16.dp))
            BoxWithConstraints(Modifier.fillMaxWidth()) {
                val columns = if (LocalDensity.current.fontScale > 1.4f || maxWidth < 280.dp) 2 else 3
                val metrics: List<@Composable (Modifier) -> Unit> = listOf(
                    { m -> TrendMetric("区间词元", Format.fmtCompact(summary.tokenTotal), "${rows.size} 天已记录", SEG_INPUT, m) },
                    { m -> TrendMetric(if (summary.hasCost && !summary.allCosts) "已知花费" else "区间花费", summary.costTotal?.let(Format::fmtUsd) ?: "未提供", "美元（USD）", SEG_OUTPUT, m) },
                    { m -> TrendMetric(summary.cacheLabel, summary.cacheRate?.let(Format::fmtPct) ?: "未提供",
                        if (summary.cacheSkippedDays > 0) { if (summary.cacheDays > 0) "仅统计 ${summary.cacheDays}/${rows.size} 天" else "暂无缓存明细" } else "缓存读取 ÷ 总词元", SEG_CACHE_READ, m) },
                )
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    metrics.chunked(columns).forEach { group -> Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        group.forEach { it(Modifier.weight(1f)) }
                        repeat(columns - group.size) { Spacer(Modifier.weight(1f)) }
                    } }
                }
            }
            Spacer(Modifier.height(16.dp))
            if (rows.isEmpty()) EmptyHint("暂无每日趋势数据") else DailyTrendChart(rows, page)
        }
    }
    item("composition") { CompositionPanel(ov.totals.period(Period.valueOf(page.summaryPeriod.value).key)) }
    item("overview-models") {
        val per = ov.totals.period(Period.valueOf(page.summaryPeriod.value).key)
        val entries = modelUsage(per).take(5)
        Panel(Modifier.padding(bottom = 16.dp)) {
            PanelHead("模型用量", "用量、缓存与费用，在同一处比较")
            entries.forEachIndexed { index, entry ->
                if (index > 0) HorizontalDivider(color = CmColorsCurrent.border)
                Column(Modifier.fillMaxWidth().tipClick(entry.name, listOf("总用量" to Format.fmtInt(entry.totalTokens),
                    "费用" to (entry.costUsd?.let(Format::fmtUsd) ?: "未提供"), entry.components.cacheLabel to (entry.components.cacheRate?.let(Format::fmtPct) ?: "未提供")))
                    .padding(vertical = 16.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        ClientLogo(entry.provider, 22.dp)
                        Text(entry.name, fontWeight = FontWeight.SemiBold, fontSize = 14.sp, modifier = Modifier.weight(1f))
                        Icon(AppIcons.ChevronRight, null, tint = CmColorsCurrent.mute, modifier = Modifier.size(16.dp))
                    }
                    Spacer(Modifier.height(12.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        TrendMetric("总用量", Format.fmtCompact(entry.totalTokens), "词元（Tokens）", null, Modifier.weight(1f))
                        TrendMetric("费用", entry.costUsd?.let(Format::fmtUsd) ?: "未提供", "美元（USD）", null, Modifier.weight(1f))
                    }
                    Spacer(Modifier.height(10.dp))
                    MixBar(modelBreakdown(per, entry.id).map { it.color to it.value }, Modifier.fillMaxWidth(), height = 6.dp)
                    Text("${entry.components.cacheLabel} ${entry.components.cacheRate?.let(Format::fmtPct) ?: "未提供"}", fontSize = 11.sp,
                        color = CmColorsCurrent.mute, modifier = Modifier.padding(top = 8.dp))
                }
            }
            if (entries.isEmpty()) EmptyHint("该周期暂无模型数据")
        }
    }
    item("clients") {
        val per = ov.totals.period(state.clientPeriod.key)
        val clients = clientUsage(per)
        Panel(Modifier.padding(bottom = 16.dp)) {
            PanelHead("客户端分布", "了解用量从哪里来", trailing = { PeriodSeg(state.clientPeriod, onClientPeriod) })
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
private fun SummaryPanel(state: UiState, page: PageState) {
    val ov = state.overview ?: return
    var periodName by page.summaryPeriod
    val selected = Period.valueOf(periodName)
    val per = ov.totals.period(selected.key)
    val components = usageComponents(per)
    val cm = CmColorsCurrent
    Column(Modifier.padding(bottom = 16.dp).testTag("usage-summary")) {
        FlowRow(Modifier.fillMaxWidth().padding(bottom = 12.dp), itemVerticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            PeriodSeg(selected) { periodName = it.name }
            Text(java.time.LocalDate.now().let { when (selected) {
                Period.Today -> "${it.monthValue}月${it.dayOfMonth}日"
                Period.Month -> "${it.year}年${it.monthValue}月"
                else -> "全部历史记录"
            } }, fontSize = 11.sp, color = cm.mute)
        }
        val shape = RoundedCornerShape(10.dp)
        Column(Modifier.fillMaxWidth().clip(shape).background(cm.card).border(1.dp, cm.border, shape)) {
            val stats: List<@Composable (Modifier) -> Unit> = listOf(
                { m -> StatCell("总用量", Format.fmtCompact(per.totalTokens), "所有模型与客户端", AppIcons.Bolt, SEG_INPUT,
                    analyzeTrend(ov, state.history).takeLast(14).map { it.total }, m) },
                { m -> StatCell("使用费用", periodCost(per)?.let(Format::fmtUsd) ?: "未提供", "按上报价格统计", AppIcons.AccountBalanceWallet, SEG_OUTPUT,
                    analyzeTrend(ov, state.history).takeLast(14).takeIf { it.all { row -> row.costUsd != null } }?.map { it.costUsd!! }.orEmpty(), m) },
                { m -> StatCell(components.cacheLabel, components.cacheRate?.let(Format::fmtPct) ?: "未提供",
                    if (components.cacheReadKnown) "${Format.fmtCompact(components.cacheRead)} 缓存读取" else "等待来源提供缓存数据", AppIcons.Database, SEG_CACHE_READ, emptyList(), m) },
                { m -> StatCell("在线设备", "${ov.devices.count { deviceOnline(it, ov) == true }} / ${ov.devices.size}",
                    connBanner(ov, state.demo, state.staleData).first, AppIcons.Computer, SEG_CACHE_WRITE, emptyList(), m) },
            )
            val oneColumn = LocalDensity.current.fontScale > 1.6f
            stats.chunked(if (oneColumn) 1 else 2).forEachIndexed { index, group ->
                if (index > 0) HorizontalDivider(color = cm.border)
                Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min)) {
                    group.forEachIndexed { col, stat ->
                        if (col > 0) VerticalDivider(color = cm.border)
                        stat(Modifier.weight(1f))
                    }
                }
            }
        }
    }
}

@Composable
private fun StatCell(label: String, value: String, note: String, icon: androidx.compose.ui.graphics.vector.ImageVector,
    color: Color, spark: List<Double>, modifier: Modifier) {
    val cm = CmColorsCurrent
    Column(modifier.padding(horizontal = 13.dp).padding(bottom = 14.dp)) {
        Box(Modifier.width(26.dp).height(2.dp).background(color))
        Row(Modifier.padding(top = 14.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
            Icon(icon, null, tint = color, modifier = Modifier.size(14.dp))
            Text(label, color = cm.ink2, fontSize = 11.sp)
        }
        Text(value, fontSize = 29.sp, lineHeight = 36.sp, letterSpacing = (-.7).sp, fontWeight = FontWeight.SemiBold,
            modifier = Modifier.padding(top = 8.dp, bottom = 10.dp), color = cm.ink)
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
            Text(note, color = if (label.contains("缓存")) cm.okInk else cm.mute, fontSize = 10.sp, lineHeight = 16.sp, modifier = Modifier.weight(1f))
            if (spark.size >= 2 && LocalDensity.current.fontScale < 1.5f) Canvas(Modifier.width(52.dp).height(20.dp)) {
                val low = spark.minOrNull() ?: 0.0
                val range = ((spark.maxOrNull() ?: 1.0) - low).coerceAtLeast(1.0)
                val path = androidx.compose.ui.graphics.Path()
                spark.forEachIndexed { i, v ->
                    val x = i.toFloat() / spark.lastIndex * size.width
                    val y = size.height - 3.dp.toPx() - ((v - low) / range * (size.height - 6.dp.toPx())).toFloat()
                    if (i == 0) path.moveTo(x, y) else path.lineTo(x, y)
                }
                drawPath(path, color.copy(alpha = .7f), style = androidx.compose.ui.graphics.drawscope.Stroke(1.dp.toPx()))
            }
        }
    }
}

@Composable
private fun TrendMetric(label: String, value: String, note: String, dot: Color?, modifier: Modifier = Modifier) {
    Column(modifier) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            if (dot != null) Box(Modifier.size(6.dp).clip(RoundedCornerShape(3.dp)).background(dot))
            Text(label, color = CmColorsCurrent.mute, fontSize = 11.sp, lineHeight = 16.sp)
        }
        Text(value, color = CmColorsCurrent.ink, fontSize = 18.sp, fontWeight = FontWeight.SemiBold, letterSpacing = (-.5).sp,
            modifier = Modifier.padding(top = 5.dp, bottom = 4.dp))
        Text(note, color = CmColorsCurrent.mute, fontSize = 10.sp, lineHeight = 15.sp)
    }
}

@Composable
private fun CompositionPanel(per: PeriodTotals) {
    val cm = CmColorsCurrent
    val data = usageComponents(per)
    val segments = componentBreakdown(per).second.sortedBy {
        listOf("cacheRead", "input", "output", "cacheWrite", "unclassified").indexOf(it.key)
    }
    Panel(Modifier.padding(bottom = 16.dp)) {
        PanelHead("用量组成", "缓存，让每次调用更轻盈")
        Row(Modifier.fillMaxWidth().padding(vertical = 18.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(data.cacheLabel, color = cm.mute, fontSize = 11.sp)
                Text(data.cacheRate?.let(Format::fmtPct) ?: "未提供", fontSize = 32.sp, fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.padding(vertical = 8.dp))
                Text(if (data.cacheReadKnown) "${Format.fmtCompact(data.cacheRead)} 缓存读取" else "来源未提供缓存明细", fontSize = 10.sp, color = cm.mute)
            }
            if (LocalDensity.current.fontScale < 1.8f) Box(Modifier.size(94.dp), contentAlignment = Alignment.Center) {
                Canvas(Modifier.fillMaxSize().padding(6.dp)) {
                    val width = 9.dp.toPx()
                    val total = segments.sumOf { it.value }.coerceAtLeast(1.0)
                    var angle = -90f
                    if (segments.isEmpty()) drawArc(cm.border, angle, 360f, false, style = androidx.compose.ui.graphics.drawscope.Stroke(width))
                    segments.forEach { part ->
                        val sweep = (part.value / total * 360).toFloat()
                        drawArc(part.color, angle, (sweep - 1.4f).coerceAtLeast(0f), false, style = androidx.compose.ui.graphics.drawscope.Stroke(width))
                        angle += sweep
                    }
                }
                Icon(AppIcons.Bolt, null, tint = cm.brand, modifier = Modifier.size(28.dp))
            }
        }
        segments.forEach { part -> Row(Modifier.fillMaxWidth().heightIn(min = 48.dp)
            .tipClick(part.label, listOf("词元用量" to Format.fmtInt(part.value))), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Box(Modifier.size(6.dp).clip(RoundedCornerShape(3.dp)).background(part.color))
            Text(part.label, Modifier.weight(1f), fontSize = 12.sp, color = cm.ink2)
            Text(Format.fmtCompact(part.value), fontSize = 12.sp, fontWeight = FontWeight.Medium)
            Text(if (data.complete && per.totalTokens > 0) Format.fmtPct(part.value / per.totalTokens) else "—", fontSize = 10.sp, color = cm.mute, modifier = Modifier.widthIn(min = 40.dp))
        } }
        if (data.partial) Text("保留已知缓存，未识别用量单独列出。", color = cm.mute, fontSize = 11.sp, modifier = Modifier.padding(top = 10.dp))
    }
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
