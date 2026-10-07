@file:OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)

package io.github.iroha1145.cloudmonitor.ui.overview

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.shape.CircleShape
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
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.github.iroha1145.cloudmonitor.data.*
import io.github.iroha1145.cloudmonitor.ui.AppIcons
import io.github.iroha1145.cloudmonitor.ui.openHttpUrl
import io.github.iroha1145.cloudmonitor.ui.components.*
import io.github.iroha1145.cloudmonitor.ui.theme.CmColorsCurrent
import io.github.iroha1145.cloudmonitor.ui.theme.EaseSmoothOut
import io.github.iroha1145.cloudmonitor.ui.theme.LocalReducedMotion
import io.github.iroha1145.cloudmonitor.ui.theme.Motion
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
        val series = remember(ov, state.history) { analyzeTrend(ov, state.history) }
        val rows = remember(series, days) { trendWindow(series, days) }
        val summary = remember(rows) { summarizeTrend(rows) }
        val selected = rows.firstOrNull { it.day == page.trendDay.value }
        Panel(Modifier.padding(bottom = 16.dp)) {
            PanelHead("用量趋势", "沿着曲线，查看每一天的花费与缓存", trailing = {
                WebSegments(listOf("7 天", "30 天"), if (days == 7) 0 else 1,
                    { days = if (it == 0) 7 else 30 }, tags = listOf("trend-7", "trend-30"))
            })
            Spacer(Modifier.height(16.dp))
            BoxWithConstraints(Modifier.fillMaxWidth()) {
                val columns = if (LocalDensity.current.fontScale > 1.4f || maxWidth < 280.dp) 2 else 3
                val dayParts = selected?.components
                val metrics: List<@Composable (Modifier) -> Unit> = listOf(
                    { m -> TrendMetric(if (selected != null) "当天词元" else "区间词元", Format.fmtCompact(selected?.total ?: summary.tokenTotal), if (selected != null) selected.day else "${rows.size} 天已记录", SEG_INPUT, m) },
                    { m -> TrendMetric(
                        if (selected != null) "当天花费" else if (summary.hasCost && !summary.allCosts) "已知花费" else "区间花费",
                        (selected?.costUsd ?: summary.costTotal)?.let(Format::fmtUsd) ?: "未提供",
                        "美元（USD）", SEG_OUTPUT, m) },
                    { m -> TrendMetric(
                        dayParts?.cacheLabel ?: summary.cacheLabel,
                        (dayParts?.cacheRate ?: summary.cacheRate)?.let(Format::fmtPct) ?: "未提供",
                        if (selected != null) "缓存读取 ÷ 总词元" else if (summary.cacheSkippedDays > 0) { if (summary.cacheDays > 0) "仅统计 ${summary.cacheDays}/${rows.size} 天" else "暂无缓存明细" } else "缓存读取 ÷ 总词元",
                        SEG_CACHE_READ, m) },
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
    item("overview-models") {
        val per = ov.totals.period(Period.valueOf(page.summaryPeriod.value).key)
        val entries = modelUsage(per).take(5)
        var selectedModel by remember { mutableStateOf<io.github.iroha1145.cloudmonitor.data.UsageEntity?>(null) }
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
                    TextButton(onClick = { selectedModel = entry }, modifier = Modifier.heightIn(min = 48.dp)) { Text("用量组成", fontSize = 12.sp) }
                }
            }
            if (entries.isEmpty()) EmptyHint("该周期暂无模型数据")
            ModelDetailDialog(selectedModel) { selectedModel = null }
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
                    "词元用量" to Format.fmtInt(session.tokens), "费用" to (session.costUsd?.let(Format::fmtUsd) ?: "未提供"))).padding(vertical = 12.dp)) {
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
        Row(Modifier.fillMaxWidth().padding(bottom = 12.dp), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween) {
            PeriodSeg(selected) { periodName = it.name }
            ExportModelsButton(per, selected.label)
        }
        val shape = RoundedCornerShape(16.dp)
        Column(Modifier.fillMaxWidth().clip(shape).background(cm.card).border(1.dp, cm.border, shape)) {
            val online = ov.devices.count { deviceOnline(it, ov) }
            val figures = listOf(
                LedgerFigure(
                    label = "总用量",
                    aside = "词元（Tokens）",
                    number = Format.compactParts(per.totalTokens).n,
                    unit = Format.compactParts(per.totalTokens).u,
                    note = "${Format.fmtInt(per.totalTokens)} · 所有模型与客户端",
                    duration = Motion.TickerLedger,
                    stagger = Motion.TickerStaggerTight,
                    lead = true,
                ),
                LedgerFigure(
                    label = "使用费用",
                    prefix = if (periodCost(per) != null) "$" else "",
                    number = periodCost(per)?.let { Format.fmtUsd(it).removePrefix("$") } ?: "未提供",
                    note = "按上报价格统计",
                    duration = Motion.TickerLedger,
                    stagger = Motion.TickerStaggerTight,
                ),
                LedgerFigure(
                    label = components.cacheLabel,
                    help = true,
                    number = components.cacheRate?.let { Format.fmtPct(it).removeSuffix("%") } ?: "未提供",
                    unit = if (components.cacheRate != null) "%" else "",
                    note = if (components.cacheReadKnown) "${Format.fmtCompact(components.cacheRead)} 缓存读取" else "等待来源提供缓存数据",
                    noteOk = components.cacheReadKnown,
                    duration = Motion.TickerLedger,
                    stagger = Motion.TickerStagger,
                ),
                LedgerFigure(
                    label = "在线设备",
                    number = online.toString(),
                    denominator = " / ${ov.devices.size}",
                    note = if (online > 0) "设备正在同步" else "暂无在线设备",
                    syncDot = online > 0,
                    duration = Motion.TickerOnline,
                    stagger = Motion.TickerStagger,
                ),
            )
            figures.chunked(2).forEachIndexed { index, group ->
                if (index > 0) HorizontalDivider(color = cm.border)
                Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min)) {
                    group.forEachIndexed { col, figure ->
                        if (col > 0) VerticalDivider(color = cm.border)
                        LedgerCell(figure, Modifier.weight(1f))
                    }
                }
            }
            LedgerComposition(components, per.totalTokens)
        }
    }
}

private data class LedgerFigure(
    val label: String,
    val aside: String = "",
    val help: Boolean = false,
    val prefix: String = "",
    val number: String,
    val unit: String = "",
    val denominator: String = "",
    val note: String,
    val noteOk: Boolean = false,
    val syncDot: Boolean = false,
    val duration: Int,
    val stagger: Int,
    val lead: Boolean = false,
)

@Composable
private fun LedgerCell(figure: LedgerFigure, modifier: Modifier) {
    val cm = CmColorsCurrent
    val numberStyle = MaterialTheme.typography.headlineMedium.copy(
        fontSize = if (figure.lead) 32.sp else 26.sp,
        lineHeight = if (figure.lead) 36.sp else 30.sp,
        letterSpacing = (-0.8).sp,
        fontWeight = FontWeight.Medium,
    )
    Column(modifier.padding(horizontal = 16.dp, vertical = 14.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(figure.label, color = cm.ink2, fontSize = 12.sp)
            if (figure.aside.isNotEmpty()) Text(figure.aside, color = cm.mute, fontSize = 11.sp)
            if (figure.help) Text("?", color = cm.mute, fontSize = 11.sp,
                modifier = Modifier.size(16.dp).border(1.dp, cm.border, CircleShape), textAlign = androidx.compose.ui.text.style.TextAlign.Center)
        }
        Row(Modifier.padding(top = 10.dp), verticalAlignment = Alignment.Bottom) {
            if (figure.prefix.isNotEmpty()) Text(figure.prefix, color = cm.ink2, fontSize = 13.sp, fontWeight = FontWeight.Medium,
                modifier = Modifier.padding(end = 2.dp, bottom = 4.dp))
            NumberTicker(figure.number, cm.ink, numberStyle, durationMillis = figure.duration, staggerMillis = figure.stagger)
            if (figure.unit.isNotEmpty()) Text(figure.unit, color = cm.ink2, fontSize = 13.sp, fontWeight = FontWeight.Medium,
                modifier = Modifier.padding(start = 2.dp, bottom = 4.dp))
            if (figure.denominator.isNotEmpty()) Text(figure.denominator, color = cm.mute, fontSize = 16.sp,
                modifier = Modifier.padding(start = 4.dp, bottom = 2.dp))
        }
        Row(Modifier.padding(top = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            if (figure.syncDot) Box(Modifier.size(6.dp).background(cm.ok, CircleShape))
            LedgerNote(figure.note, if (figure.noteOk) cm.okInk else cm.mute, Modifier.weight(1f))
        }
    }
}

/** The phrase after the separator wraps as a whole, the way CSS text-wrap: pretty avoids a one-character last line. */
@Composable
private fun LedgerNote(text: String, color: Color, modifier: Modifier = Modifier) {
    val pieces = text.split(" · ", limit = 2)
    if (pieces.size < 2) {
        Text(text, modifier, color = color, fontSize = 11.sp, lineHeight = 16.sp)
        return
    }
    FlowRow(modifier) {
        Text("${pieces[0]} · ", color = color, fontSize = 11.sp, lineHeight = 16.sp, softWrap = false)
        Text(pieces[1], color = color, fontSize = 11.sp, lineHeight = 16.sp, softWrap = false, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
private fun LedgerComposition(parts: io.github.iroha1145.cloudmonitor.data.UsageComponents, total: Double) {
    val cm = CmColorsCurrent
    val order = listOf(
        Triple("cacheRead", "缓存读取", SEG_CACHE_READ) to parts.cacheRead,
        Triple("input", "非缓存输入", SEG_INPUT) to parts.input,
        Triple("output", "输出", SEG_OUTPUT) to parts.output,
        Triple("cacheWrite", "缓存写入", SEG_CACHE_WRITE) to parts.cacheWrite,
        Triple("unclassified", "未分类", SEG_UNCLS) to parts.unclassified,
    )
    val sum = order.sumOf { it.second }.coerceAtLeast(0.0)
    val note = when {
        total == 0.0 -> "这个周期还没有上报用量。"
        parts.known && !parts.complete -> "组成与总量不一致，暂不计算缓存占比。"
        parts.partial -> "保留已知缓存，未识别用量单独列出。"
        else -> "所有已上报用量均已完成分类。"
    }
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 16.dp)) {
        HorizontalDivider(color = cm.border)
        Spacer(Modifier.height(16.dp))
        Text("用量组成", color = cm.ink, fontSize = 14.sp, fontWeight = FontWeight.Medium)
        Text(note, color = cm.mute, fontSize = 12.sp, modifier = Modifier.padding(top = 4.dp, bottom = 12.dp))
        if (parts.complete && sum > 0) {
            Row(Modifier.fillMaxWidth().height(12.dp).clip(RoundedCornerShape(6.dp)), horizontalArrangement = Arrangement.spacedBy(2.dp)) {
                order.filter { it.second > 0 }.forEach { (meta, value) ->
                    Box(Modifier.weight(value.toFloat().coerceAtLeast(0.001f)).fillMaxHeight().background(meta.third))
                }
            }
        }
        order.forEach { (meta, value) ->
            val share = if (parts.known && parts.complete && sum > 0) Format.fmtPct(value / sum) else "未提供"
            Row(Modifier.fillMaxWidth().padding(top = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(8.dp).clip(CircleShape).background(meta.third))
                Text(meta.second, Modifier.padding(start = 8.dp).weight(1f), color = cm.ink2, fontSize = 13.sp)
                Text(Format.fmtCompact(value), color = cm.ink, fontSize = 16.sp, fontWeight = FontWeight.Medium)
                Text(share, Modifier.padding(start = 12.dp).widthIn(min = 52.dp), color = cm.mute, fontSize = 12.sp)
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
        PopValue(value, CmColorsCurrent.ink, MaterialTheme.typography.titleMedium.copy(fontSize = 18.sp, fontWeight = FontWeight.Medium, letterSpacing = (-.5).sp),
            Modifier.padding(top = 5.dp, bottom = 4.dp))
        Text(note, color = CmColorsCurrent.mute, fontSize = 10.sp, lineHeight = 15.sp)
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
