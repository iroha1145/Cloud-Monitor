package io.github.iroha1145.cloudmonitor.ui.history

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
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
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.github.iroha1145.cloudmonitor.data.*
import io.github.iroha1145.cloudmonitor.ui.PageState
import io.github.iroha1145.cloudmonitor.ui.components.*
import io.github.iroha1145.cloudmonitor.ui.theme.CmColorsCurrent
import io.github.iroha1145.cloudmonitor.ui.theme.EaseSmoothOut
import io.github.iroha1145.cloudmonitor.ui.theme.Motion
import io.github.iroha1145.cloudmonitor.ui.theme.riseIn
import io.github.iroha1145.cloudmonitor.vm.AuxStatus
import io.github.iroha1145.cloudmonitor.vm.UiState
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.time.LocalDate
import java.time.YearMonth
import java.util.Locale

fun LazyListScope.historyItems(
    state: UiState,
    modelColors: Map<String, Color>,
    clientColors: Map<String, Color>,
    onActView: (Int) -> Unit,
    onMore: () -> Unit,
    page: PageState,
) {
    val overview = state.overview ?: return
    val zone = overview.dashboardPeriod?.timeZone ?: overview.dashboardTimeZone
    val today = overview.dashboardPeriod?.today?.key ?: Format.dayKeyTz(System.currentTimeMillis(), zone)
    item("activity") { ActivityCard(overview, today, zone, state.actView, onActView, page) }
    item("sessions") { SessionsCard(overview, zone, today, modelColors, page) }
    val rows = (if (state.history.isNotEmpty()) state.history else overview.activity.daily.map {
        HistoryDay(it.day, it.total, perModel = it.models)
    }).sortedByDescending { it.day }
    item("archive-head") {
        val cm = CmColorsCurrent
        Panel(Modifier.padding(bottom = 16.dp)) {
            PanelHead("日归档", "已加载 ${rows.size} 天 · 保留 ${state.historyRetentionDays} 天")
            Spacer(Modifier.height(8.dp))
            Text(when {
                state.historyFallback -> "日归档接口不可用，当前显示概览中的已上报日期。"
                state.historyDayBasis == "device-local" -> "按设备本地日期归档。"
                else -> "按日期倒序排列，展开查看客户端与模型用量。"
            }, color = cm.ink2, style = MaterialTheme.typography.bodyMedium)
            if (state.historyMixedTz) Text("设备时区不同，同一天的记录按各设备本地日期合并。", color = cm.warnInk, style = MaterialTheme.typography.bodySmall)
            if (state.historyPartial) Text("部分归档不完整。" + state.historyPartialErrors.map(Format::partialErrorText).distinct().joinToString("、"), color = cm.warnInk, style = MaterialTheme.typography.bodySmall)
            if (state.historyStatus == AuxStatus.Error) Text(state.historyError ?: "日归档读取失败", color = cm.crit, style = MaterialTheme.typography.bodyMedium)
        }
    }
    if (rows.isEmpty()) item("archive-empty") {
        Panel { EmptyHint(if (state.historyStatus == AuxStatus.Loading) "正在读取日归档…" else "暂无已上报的日归档") }
    }
    items(rows, key = { "day-${it.day}" }) { day -> DayCard(day, today, clientColors, modelColors) }
    if (state.historyHasMore || state.historyLoading) item("more") {
        TextButton(onClick = onMore, enabled = !state.historyLoading, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
            Text(if (state.historyLoading) "正在加载…" else "加载更早记录")
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ActivityCard(overview: Overview, today: String, zone: String, view: Int, onView: (Int) -> Unit, page: PageState) {
    val cm = CmColorsCurrent
    val daily = overview.activity.daily.associate { it.day to it.total }
    Panel(Modifier.padding(bottom = 16.dp)) {
        PanelHead("活动日历", "时间按 $zone 显示")
        WebSegmentedControl(listOf("今日", "近 12 周", "本月"), view, onView)
        Spacer(Modifier.height(12.dp))
        val selectedDay = page.activityDay.value
        val cells = activityCells(view, today, overview, daily)
        if (cells.isEmpty()) EmptyHint("活动日期未提供，收到有效的数据日期后显示活动。")
        else {
            val maximum = cells.mapNotNull { it.total }.maxOrNull()?.coerceAtLeast(1.0) ?: 1.0
            if (view == 2) {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    listOf("一", "二", "三", "四", "五", "六", "日").forEach { day ->
                        Text(day, color = cm.mute, fontSize = 11.sp, modifier = Modifier.weight(1f), textAlign = androidx.compose.ui.text.style.TextAlign.Center)
                    }
                }
                Spacer(Modifier.height(6.dp))
            }
            ActivityHeat(cells, maximum, view, selectedDay, zone) { day ->
                page.activityDay.value = if (page.activityDay.value == day) "" else day
                page.limit.intValue = 8
            }
            Spacer(Modifier.height(8.dp))
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
                Text(zone, color = cm.mute, fontSize = 11.sp)
                Row(horizontalArrangement = Arrangement.spacedBy(3.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text("少", color = cm.mute, fontSize = 11.sp)
                    (0..4).forEach { level ->
                        Box(Modifier.size(10.dp).clip(RoundedCornerShape(2.dp)).background(if (level == 0) Color.Transparent else cm.activity[level])
                            .border(1.dp, if (level == 0) cm.border else Color.Transparent, RoundedCornerShape(2.dp)))
                    }
                    Text("多", color = cm.mute, fontSize = 11.sp)
                }
            }
            if (selectedDay.isNotBlank()) {
                TextButton(onClick = { page.activityDay.value = "" }, modifier = Modifier.heightIn(min = 48.dp)) {
                    Text("已筛选 $selectedDay，点击清除", fontSize = 12.sp)
                }
            }
            Text("斜线格表示未上报，与零用量分开显示。点击日期筛选会话。", color = cm.ink2, style = MaterialTheme.typography.bodySmall)
        }
        CoverageBlock(overview)
    }
}

private data class ActivityCell(val key: String, val label: String, val day: String?, val total: Double?, val future: Boolean, val column: Int, val row: Int)

private fun activityCells(view: Int, today: String, overview: Overview, daily: Map<String, Double>): List<ActivityCell> {
    val todayDate = runCatching { LocalDate.parse(today) }.getOrNull() ?: return emptyList()
    return when (view) {
        0 -> {
            val current = overview.activity.hourlyToday
            val hourly = when {
                current != null && current.day == today -> current.buckets
                overview.activity.hourlyDay == today -> overview.activity.hourly
                else -> emptyList()
            }
            if (hourly.isEmpty() && overview.features.activityHourly.not() && current == null && overview.activity.hourlyDay != today) emptyList()
            else {
                val byHour = hourly.associate { it.hour to it.total }
                (0..23).map { hour ->
                    ActivityCell("$today-$hour", hour.toString().padStart(2, '0'), null, byHour[hour], false, hour % 6, hour / 6)
                }
            }
        }
        1 -> {
            val monday = todayDate.minusDays((todayDate.dayOfWeek.value - 1).toLong())
            val start = monday.minusWeeks(11)
            (0 until 84).map { index ->
                val day = start.plusDays(index.toLong())
                val key = day.toString()
                ActivityCell(key, "", key, daily[key], day.isAfter(todayDate), index / 7, index % 7)
            }
        }
        else -> {
            val month = runCatching { YearMonth.parse(overview.dashboardPeriod?.month?.key ?: today.take(7)) }.getOrNull() ?: return emptyList()
            val leading = month.atDay(1).dayOfWeek.value - 1
            (0 until leading).map { index -> ActivityCell("pad-$index", "", null, null, false, index % 7, index / 7) } +
                (1..month.lengthOfMonth()).map { dayNumber ->
                    val day = month.atDay(dayNumber)
                    val index = leading + dayNumber - 1
                    ActivityCell(day.toString(), dayNumber.toString(), day.toString(), daily[day.toString()], day.isAfter(todayDate), index % 7, index / 7)
                }
        }
    }
}

@Composable
private fun ActivityHeat(
    cells: List<ActivityCell>,
    maximum: Double,
    view: Int,
    selectedDay: String,
    zone: String,
    onDay: (String) -> Unit,
) {
    val cm = CmColorsCurrent
    val columns = if (view == 0) 6 else 7
    if (view == 1) {
        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            cells.chunked(7).forEach { week ->
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    week.forEach { cell -> ActivityHeatCell(cell, maximum, selectedDay, zone, onDay, Modifier.size(48.dp)) }
                }
            }
        }
    } else {
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            cells.chunked(columns).forEach { row ->
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    row.forEach { cell ->
                        ActivityHeatCell(cell, maximum, selectedDay, zone, onDay, Modifier.weight(1f).heightIn(min = 48.dp))
                    }
                    repeat(columns - row.size) { Spacer(Modifier.weight(1f)) }
                }
            }
        }
    }
}

@Composable
private fun ActivityHeatCell(
    cell: ActivityCell,
    maximum: Double,
    selectedDay: String,
    zone: String,
    onDay: (String) -> Unit,
    modifier: Modifier,
) {
    val cm = CmColorsCurrent
    if (cell.key.startsWith("pad-")) {
        Spacer(modifier)
        return
    }
    val level = activityHeatLevel(cell.total, maximum)
    val bg = when {
        cell.future -> cm.hover
        level == null -> cm.card
        level == 0 -> Color.Transparent
        else -> cm.activity[level]
    }
    val ink = when {
        cell.future -> cm.mute
        level == null -> cm.ink2
        else -> cm.activityInk[level]
    }
    val label = cell.day ?: cell.label
    val description = buildString {
        append(cell.day ?: cell.label)
        append("，")
        append(if (cell.future) "尚未到来" else if (cell.total == null) "未上报用量" else "${Format.fmtInt(cell.total)} 词元")
        if (cell.day != null) append("，点击筛选会话")
    }
    val selected = cell.day != null && cell.day == selectedDay
    Box(
        modifier.riseIn(cell.column + cell.row, cell.key).clip(RoundedCornerShape(6.dp)).background(bg)
            .border(1.dp, if (selected) cm.ink else if (level == 0 || cell.future) cm.border else Color.Transparent, RoundedCornerShape(6.dp))
            .then(if (cell.day != null && !cell.future) Modifier.clickable { onDay(cell.day) } else Modifier)
            .semantics { contentDescription = "$description。时区 $zone" }
            .padding(2.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(cell.label, color = ink, fontSize = 11.sp, maxLines = 1)
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun DayCard(day: HistoryDay, today: String, clientColors: Map<String, Color>, modelColors: Map<String, Color>) {
    val cm = CmColorsCurrent
    var expanded by rememberSaveable(day.day) { mutableStateOf(false) }
    val weekday = Format.dowOfKey(day.day)?.let { listOf("日", "一", "二", "三", "四", "五", "六")[it] }.orEmpty()
    Panel(Modifier.padding(bottom = 12.dp)) {
        Text("${day.day} · 周$weekday${if (day.day == today) " · 今天" else ""}", color = if (day.day == today) cm.brand else cm.ink,
            fontSize = 14.sp, lineHeight = 20.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.semantics { heading() })
        Spacer(Modifier.height(12.dp))
        FlowRow(horizontalArrangement = Arrangement.spacedBy(24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            HistoryMetric("词元用量", Format.fmtCompact(day.tokens))
            HistoryMetric("估算费用", day.costUsd?.let(Format::fmtUsd) ?: "未提供")
            if (day.deviceCount > 0) HistoryMetric("上报设备", "${day.deviceCount} 台")
        }
        val mix = day.perClient.ifEmpty { day.perModel }
        val colors = if (day.perClient.isNotEmpty()) clientColors else modelColors
        if (mix.isNotEmpty()) {
            Spacer(Modifier.height(12.dp))
            MixBar(mix.entries.map { (colors[it.key] ?: OTHER_COLOR) to it.value }, Modifier.fillMaxWidth(), height = 6.dp)
        }
        if (!day.complete || day.coverage != null) {
            Spacer(Modifier.height(8.dp))
            Text(buildList { if (!day.complete) add("数据不完整"); day.coverage?.let { add("采样覆盖率 ${String.format(Locale.US, "%.1f", it)}%") } }.joinToString(" · "),
                color = if (day.complete) cm.ink2 else cm.warnInk, style = MaterialTheme.typography.bodySmall)
        }
        if (expanded) {
            Spacer(Modifier.height(16.dp))
            HistoryBreakdown("客户端用量", day.perClient, clientColors, true)
            Spacer(Modifier.height(16.dp))
            HistoryBreakdown("模型用量", day.perModel, modelColors)
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
            TextButton(onClick = { expanded = !expanded }, modifier = Modifier.heightIn(min = 48.dp), shape = RoundedCornerShape(6.dp)) {
                Text(if (expanded) "收起当天详情" else "查看当天详情", fontSize = 12.sp)
            }
        }
    }
}

@Composable
private fun HistoryBreakdown(title: String, values: Map<String, Double>, colors: Map<String, Color>, logos: Boolean = false) {
    val cm = CmColorsCurrent
    Text(title, style = MaterialTheme.typography.titleSmall, color = cm.ink)
    if (values.isEmpty()) Text("明细未提供", color = cm.ink2, style = MaterialTheme.typography.bodySmall)
    val largeText = LocalDensity.current.fontScale > 1.3f
    values.entries.sortedByDescending { it.value }.forEach { (name, value) ->
        Row(Modifier.fillMaxWidth().padding(vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            if (logos) ClientLogo(name, size = 20.dp)
            else Box(Modifier.padding(top = 5.dp).size(10.dp).clip(RoundedCornerShape(3.dp)).background(colors[name] ?: OTHER_COLOR))
            Column(Modifier.weight(1f)) {
                Text(name, color = cm.ink, fontSize = 13.sp, lineHeight = 19.sp)
                if (largeText) Text(Format.fmtCompact(value), color = cm.ink, fontSize = 13.sp, lineHeight = 19.sp, fontWeight = FontWeight.Medium)
            }
            if (!largeText) Text(Format.fmtCompact(value), color = cm.ink, fontSize = 13.sp, lineHeight = 19.sp, fontWeight = FontWeight.Medium)
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun SessionsCard(overview: Overview, zone: String, today: String, modelColors: Map<String, Color>, page: PageState) {
    val cm = CmColorsCurrent
    var query by page.query
    var client by page.selection
    var onlyToday by page.todayOnly
    var activityDay by page.activityDay
    var limit by page.limit
    var exportStatus by rememberSaveable { mutableStateOf("") }
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    fun sessionDay(session: SessionRow): String? = Format.parseMillis(session.lastUsedAt ?: session.startedAt)?.let { Format.dayKeyTz(it, zone) }
    val clients = listOf("") + overview.sessions.mapNotNull { it.client }.distinct().sorted()
    val resolvedClient = if (client.isBlank() || client in clients) client else ""
    SideEffect { if (resolvedClient != client) client = resolvedClient }
    val filtered = overview.sessions.filter { session ->
        (resolvedClient.isBlank() || session.client == resolvedClient) && (!onlyToday || sessionDay(session) == today) &&
            (activityDay.isBlank() || sessionDay(session) == activityDay) &&
            (query.isBlank() || listOfNotNull(session.sessionId, session.project, session.title, session.client, session.device, session.sessionKind)
                .plus(session.models.keys).any { it.contains(query.trim(), true) })
    }.sortedByDescending { Format.parseMillis(it.lastUsedAt ?: it.startedAt) ?: 0L }
    val latestRows by rememberUpdatedState(filtered)
    val export = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("text/csv")) { uri ->
        if (uri != null) {
            val rows = latestRows
            scope.launch {
                val result = withContext(Dispatchers.IO) {
                    runCatching {
                        val stream = context.contentResolver.openOutputStream(uri) ?: error("文件无法写入")
                        stream.bufferedWriter(Charsets.UTF_8).use { it.write(sessionsCsv(rows, zone)) }
                    }
                }
                exportStatus = if (result.isSuccess) "已导出 ${rows.size} 条会话" else "导出失败，请重试"
            }
        }
    }
    Panel(Modifier.padding(bottom = 16.dp)) {
        PanelHead("会话记录", "当前快照上报 ${overview.sessions.size} 条 · 按最后活动时间排列")
        Spacer(Modifier.height(8.dp))
        if (overview.sessionsOmitted || overview.sessionsMeta.sessionDetailsIncomplete || overview.sessionsMeta.sessionsOmittedCount > 0) {
            Text("当前快照未包含全部会话明细，统计仅涵盖已上报记录。", color = cm.warnInk, style = MaterialTheme.typography.bodySmall)
        }
        WebSearchField(query, { query = it; limit = 8 }, label = "搜索会话、项目或模型", placeholder = "搜索会话、项目或模型…",
            modifier = Modifier.fillMaxWidth().testTag("session-search"))
        WebSegmentedControl(clients.map { it.ifBlank { "所有客户端" } }, clients.indexOf(resolvedClient).coerceAtLeast(0), { client = clients[it]; limit = 8 })
        WebPill("仅今天", selected = onlyToday, onClick = { onlyToday = !onlyToday; limit = 8 })
        if (filtered.isEmpty()) EmptyHint(if (overview.sessions.isEmpty()) "尚未上报会话明细" else "没有符合条件的会话")
        else filtered.take(limit).groupBy { sessionDay(it) }.forEach { (day, sessions) ->
            Spacer(Modifier.height(16.dp))
            Text(if (day == today) "今天 · $day" else day ?: "活动日期未提供", color = cm.brand,
                style = MaterialTheme.typography.titleSmall, modifier = Modifier.semantics { heading() })
            sessions.forEach { session -> key(session.key) { SessionDetail(session, zone, overview.generatedAt, modelColors) } }
        }
        if (filtered.size > limit) TextButton(onClick = { limit += 8 }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp), shape = RoundedCornerShape(6.dp)) { Text("再显示 8 条会话", fontSize = 12.sp) }
        OutlinedButton(onClick = { export.launch("cloud-monitor-sessions-${if (onlyToday) today else "all"}.csv") }, enabled = filtered.isNotEmpty(),
            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp), shape = RoundedCornerShape(6.dp), border = BorderStroke(1.dp, cm.border),
            contentPadding = PaddingValues(horizontal = 12.dp, vertical = 8.dp)) { Text("导出筛选结果（${filtered.size} 条）", fontSize = 12.sp) }
        if (exportStatus.isNotEmpty()) Text(exportStatus, color = cm.ink2, style = MaterialTheme.typography.bodySmall)
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun SessionDetail(session: SessionRow, zone: String, generatedAt: String?, modelColors: Map<String, Color>) {
    val cm = CmColorsCurrent
    var expanded by rememberSaveable(session.key) { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth().padding(vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            ClientLogo(session.client, size = 20.dp)
            Column(Modifier.weight(1f)) {
                Text(sessionTitle(session), color = cm.ink, fontSize = 14.sp,
                    lineHeight = 20.sp, fontWeight = FontWeight.Medium)
                Text("${session.client ?: "客户端未提供"} · ${sessionActivity(session, generatedAt)}",
                    color = cm.ink2, fontSize = 11.sp, lineHeight = 16.sp)
            }
        }
        Text("最后活动 ${Format.fmtDateTime(session.lastUsedAt, zone).ifBlank { "未提供" }}", color = cm.ink2, fontSize = 11.sp, lineHeight = 16.sp)
        if (LocalDensity.current.fontScale > 1.5f) {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                HistoryMetric("词元用量", Format.fmtCompact(session.tokens))
                HistoryMetric("估算费用", session.costUsd?.let(Format::fmtUsd) ?: "未提供")
            }
        } else {
            Row(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                HistoryMetric("词元用量", Format.fmtCompact(session.tokens), Modifier.weight(1f))
                HistoryMetric("估算费用", session.costUsd?.let(Format::fmtUsd) ?: "未提供", Modifier.weight(1f))
            }
        }
        AnimatedVisibility(
            expanded,
            enter = fadeIn(tween(Motion.Fast, easing = EaseSmoothOut)) + expandVertically(tween(Motion.Fast, easing = EaseSmoothOut)),
            exit = fadeOut(tween(Motion.Quick, easing = EaseSmoothOut)) + shrinkVertically(tween(Motion.Quick, easing = EaseSmoothOut)),
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("来源设备 · ${session.device ?: session.deviceId ?: "未提供"}", color = cm.ink2, style = MaterialTheme.typography.bodyMedium)
            session.sessionKind?.takeIf { it.isNotBlank() }?.let { Text("会话类型 · $it", color = cm.ink2, style = MaterialTheme.typography.bodyMedium) }
            Text("活动状态 · ${sessionActivity(session, generatedAt)}", color = cm.ink2, style = MaterialTheme.typography.bodyMedium)
            sessionContext(session)?.let { (used, remaining) ->
                Text("上次上报的上下文 · ${Format.fmtInt(session.contextTokens ?: 0.0)} / ${Format.fmtInt(session.contextWindow ?: 0.0)} 词元 · 已用 $used% · 剩余 $remaining%",
                    color = cm.ink2, style = MaterialTheme.typography.bodySmall)
                Box(Modifier.fillMaxWidth().height(7.dp).clip(RoundedCornerShape(4.dp)).background(cm.inset)) {
                    Box(Modifier.fillMaxWidth(used.coerceIn(0, 100) / 100f).fillMaxHeight().background(cm.brand))
                }
            }
            Text("会话标识 · ${session.sessionId ?: "未提供"}", color = cm.ink2, style = MaterialTheme.typography.bodySmall)
            Text("开始于 ${Format.fmtDateTime(session.startedAt, zone).ifBlank { "未提供" }}", color = cm.ink2, style = MaterialTheme.typography.bodySmall)
            HistoryBreakdown("使用模型", session.models, modelColors)
            }
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
            TextButton(onClick = { expanded = !expanded }, modifier = Modifier.heightIn(min = 48.dp), shape = RoundedCornerShape(6.dp)) {
                Text(if (expanded) "收起会话详情" else "查看会话详情", fontSize = 12.sp)
            }
        }
        HorizontalDivider(color = cm.border)
    }
}

@Composable
private fun HistoryMetric(label: String, value: String, modifier: Modifier = Modifier) {
    val cm = CmColorsCurrent
    Column(modifier, verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(label, color = cm.ink2, fontSize = 11.sp, lineHeight = 15.sp)
        Text(value, color = cm.ink, fontSize = 16.sp, lineHeight = 22.sp, fontWeight = FontWeight.SemiBold)
    }
}

@Composable
private fun CoverageBlock(overview: Overview) {
    val coverage = overview.activity.coverage ?: return
    val cm = CmColorsCurrent
    Spacer(Modifier.height(16.dp))
    coverage.coveragePercent?.let { Text("采样覆盖率 ${String.format(Locale.US, "%.1f", it.coerceIn(0.0, 100.0))}%", color = cm.ink2, style = MaterialTheme.typography.bodySmall) }
    coverage.lastSampleAt?.let { Text("最近采样 ${Format.relTime(it)}", color = cm.ink2, style = MaterialTheme.typography.bodySmall) }
    if (coverage.attributionMode == "delta-low-coverage" || (coverage.coveragePercent?.let { it < 60 } == true)) {
        Text("采样较少，小时分布可能集中在首次采样时段。", color = cm.warnInk, style = MaterialTheme.typography.bodySmall)
    }
    if (overview.activity.dailyMixedBasis) Text("长期日归档包含设备本地日期；跨时区设备的日期范围可能不同。", color = cm.warnInk, style = MaterialTheme.typography.bodySmall)
    var expanded by rememberSaveable { mutableStateOf(false) }
    if (coverage.devices.isNotEmpty()) {
        TextButton(onClick = { expanded = !expanded }, modifier = Modifier.heightIn(min = 48.dp), shape = RoundedCornerShape(6.dp)) { Text(if (expanded) "收起采样详情" else "查看采样详情", fontSize = 12.sp) }
        if (expanded) coverage.devices.forEach { device ->
            val name = overview.devices.find { it.deviceId == device.deviceId }?.hostname ?: device.deviceId
            Text("$name：实到 ${device.observedBuckets} / 期望 ${device.expectedBuckets}，缺口 ${device.gapCount}，计数重置 ${device.resetCount}", color = cm.ink2, style = MaterialTheme.typography.bodySmall)
        }
    }
}

private fun sessionsCsv(rows: List<SessionRow>, zone: String): String {
    fun cell(value: String): String {
        val safe = if (value.trimStart().firstOrNull() in listOf('=', '+', '-', '@', '\t', '\r')) "'$value" else value
        return "\"${safe.replace("\"", "\"\"")}\""
    }
    val lines = mutableListOf(listOf("会话标识", "项目", "客户端", "设备", "开始时间", "最后活动", "时区", "词元用量", "估算费用（美元）", "模型").joinToString(",", transform = ::cell))
    rows.forEach { row ->
        lines += listOf(row.sessionId.orEmpty(), row.project.orEmpty(), row.client.orEmpty(), row.device ?: row.deviceId.orEmpty(),
            Format.fmtDateTime(row.startedAt, zone), Format.fmtDateTime(row.lastUsedAt, zone), zone, row.tokens.toString(), row.costUsd?.toString().orEmpty(),
            row.models.keys.joinToString("; ")).joinToString(",", transform = ::cell)
    }
    return "\uFEFF" + lines.joinToString("\r\n") + "\r\n"
}
