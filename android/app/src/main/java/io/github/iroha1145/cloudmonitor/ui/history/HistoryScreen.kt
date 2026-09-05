package io.github.iroha1145.cloudmonitor.ui.history

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
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
import io.github.iroha1145.cloudmonitor.data.*
import io.github.iroha1145.cloudmonitor.ui.PageState
import io.github.iroha1145.cloudmonitor.ui.components.*
import io.github.iroha1145.cloudmonitor.ui.theme.CmColorsCurrent
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
    item("activity") { ActivityCard(overview, today, zone, state.actView, onActView) }
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
private fun ActivityCard(overview: Overview, today: String, zone: String, view: Int, onView: (Int) -> Unit) {
    val cm = CmColorsCurrent
    val daily = overview.activity.daily.associate { it.day to it.total }
    Panel(Modifier.padding(bottom = 16.dp)) {
        PanelHead("活动日历", "时间按 $zone 显示")
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            listOf("今日", "近 12 周", "本月").forEachIndexed { index, label ->
                FilterChip(selected = view == index, onClick = { onView(index) }, label = { Text(label) }, modifier = Modifier.heightIn(min = 48.dp))
            }
        }
        Spacer(Modifier.height(12.dp))
        when (view) {
            0 -> {
                val current = overview.activity.hourlyToday
                val hourly = when {
                    current != null && current.day == today -> current.buckets
                    overview.activity.hourlyDay == today -> overview.activity.hourly
                    else -> emptyList()
                }
                if (hourly.isEmpty()) EmptyHint("今日小时分布尚未提供")
                else {
                    val byHour = hourly.associate { it.hour to it.total }
                    ActivityTiles((0..23).map { "${it}时" to byHour[it] })
                    Text("按上报采样归属到小时；空白数据以“—”标记。", color = cm.ink2, style = MaterialTheme.typography.bodySmall)
                }
            }
            1 -> {
                val date = runCatching { LocalDate.parse(today) }.getOrNull()
                if (date != null) {
                    val monday = date.minusDays((date.dayOfWeek.value - 1).toLong())
                    val weeks = (11 downTo 0).map { offset ->
                        val start = monday.minusWeeks(offset.toLong())
                        val reported = (0..6).mapNotNull { day -> daily[start.plusDays(day.toLong()).toString()] }
                        "${start.monthValue}/${start.dayOfMonth}" to reported.takeIf { it.isNotEmpty() }?.sum()
                    }
                    ActivityTiles(weeks)
                    Text("每格为该周已上报日期的合计；缺失日期不补为零。", color = cm.ink2, style = MaterialTheme.typography.bodySmall)
                }
            }
            else -> {
                val month = runCatching { YearMonth.parse(overview.dashboardPeriod?.month?.key ?: today.take(7)) }.getOrNull()
                if (month != null) {
                    val days = (1..month.lengthOfMonth()).map { day -> "$day 日" to daily[month.atDay(day).toString()] }
                    ActivityTiles(days)
                    val reported = days.mapNotNull { it.second }
                    Spacer(Modifier.height(12.dp))
                    Text("${month.monthValue} 月已上报 ${reported.size} 天 · 合计 ${Format.fmtCompact(reported.sum())} 词元", color = cm.ink, style = MaterialTheme.typography.bodyMedium)
                    Text("“—”表示未提供记录，也可能是尚未到达的日期。", color = cm.ink2, style = MaterialTheme.typography.bodySmall)
                }
            }
        }
        CoverageBlock(overview)
    }
}

@Composable
private fun ActivityTiles(values: List<Pair<String, Double?>>) {
    val cm = CmColorsCurrent
    val fontScale = LocalDensity.current.fontScale
    val max = values.mapNotNull { it.second }.maxOrNull()?.coerceAtLeast(1.0) ?: 1.0
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val columns = (maxWidth.value / (72 * fontScale)).toInt().coerceIn(2, 7)
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            values.chunked(columns).forEach { row ->
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    row.forEach { (label, value) ->
                        val strength = if (value == null || value <= 0) 0f else (value / max).toFloat().coerceIn(0.15f, 1f)
                        Column(Modifier.weight(1f).heightIn(min = 64.dp).clip(RoundedCornerShape(10.dp))
                            .background(if (value == null) cm.canvas else cm.brand.copy(alpha = 0.06f + strength * 0.14f))
                            .semantics(mergeDescendants = true) { contentDescription = "$label，${value?.let { "${Format.fmtInt(it)} 词元" } ?: "数据未提供"}" }
                            .padding(horizontal = 7.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            Text(label, color = cm.ink2, style = MaterialTheme.typography.labelSmall)
                            Text(value?.let { Format.fmtCompact(it, tight = true) } ?: "—", color = cm.ink,
                                style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold)
                        }
                    }
                    repeat(columns - row.size) { Spacer(Modifier.weight(1f)) }
                }
            }
        }
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
            style = MaterialTheme.typography.titleMedium, modifier = Modifier.semantics { heading() })
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
        TextButton(onClick = { expanded = !expanded }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
            Text(if (expanded) "收起当天详情" else "查看当天详情")
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
        Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            if (logos) ClientLogo(name, size = 20.dp)
            else Box(Modifier.padding(top = 5.dp).size(10.dp).clip(RoundedCornerShape(3.dp)).background(colors[name] ?: OTHER_COLOR))
            Column(Modifier.weight(1f)) {
                Text(name, color = cm.ink, style = MaterialTheme.typography.bodyMedium)
                if (largeText) Text(Format.fmtCompact(value), color = cm.ink, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium)
            }
            if (!largeText) Text(Format.fmtCompact(value), color = cm.ink, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium)
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
    var limit by page.limit
    var exportStatus by rememberSaveable { mutableStateOf("") }
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    fun sessionDay(session: SessionRow): String? = Format.parseMillis(session.lastUsedAt ?: session.startedAt)?.let { Format.dayKeyTz(it, zone) }
    val filtered = overview.sessions.filter { session ->
        (client.isBlank() || session.client == client) && (!onlyToday || sessionDay(session) == today) &&
            (query.isBlank() || listOfNotNull(session.sessionId, session.project, session.client, session.device).plus(session.models.keys).any { it.contains(query.trim(), true) })
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
        OutlinedTextField(query, { query = it; limit = 8 }, Modifier.fillMaxWidth().testTag("session-search"), label = { Text("搜索会话、项目或模型") },
            singleLine = true, shape = RoundedCornerShape(12.dp))
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            FilterChip(selected = onlyToday, onClick = { onlyToday = !onlyToday; limit = 8 }, label = { Text("仅今天") }, modifier = Modifier.heightIn(min = 48.dp))
            FilterChip(selected = client.isBlank(), onClick = { client = ""; limit = 8 }, label = { Text("所有客户端") }, modifier = Modifier.heightIn(min = 48.dp))
            overview.sessions.mapNotNull { it.client }.distinct().sorted().forEach { name ->
                FilterChip(selected = client == name, onClick = { client = name; limit = 8 }, label = { Text(name) }, modifier = Modifier.heightIn(min = 48.dp))
            }
        }
        if (filtered.isEmpty()) EmptyHint(if (overview.sessions.isEmpty()) "尚未上报会话明细" else "没有符合条件的会话")
        else filtered.take(limit).groupBy { sessionDay(it) }.forEach { (day, sessions) ->
            Spacer(Modifier.height(16.dp))
            Text(if (day == today) "今天 · $day" else day ?: "活动日期未提供", color = cm.brand,
                style = MaterialTheme.typography.titleSmall, modifier = Modifier.semantics { heading() })
            sessions.forEach { session -> key(session.key) { SessionDetail(session, zone, modelColors) } }
        }
        if (filtered.size > limit) TextButton(onClick = { limit += 8 }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("再显示 8 条会话") }
        OutlinedButton(onClick = { export.launch("cloud-monitor-sessions-${if (onlyToday) today else "all"}.csv") }, enabled = filtered.isNotEmpty(),
            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp), contentPadding = PaddingValues(12.dp)) { Text("导出筛选结果（${filtered.size} 条）") }
        if (exportStatus.isNotEmpty()) Text(exportStatus, color = cm.ink2, style = MaterialTheme.typography.bodySmall)
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun SessionDetail(session: SessionRow, zone: String, modelColors: Map<String, Color>) {
    val cm = CmColorsCurrent
    var expanded by rememberSaveable(session.key) { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth().padding(vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            ClientLogo(session.client, size = 24.dp)
            Column(Modifier.weight(1f)) {
                Text(session.project?.takeIf { it.isNotBlank() } ?: session.sessionId?.take(24) ?: "未命名会话", color = cm.ink, style = MaterialTheme.typography.titleSmall)
                Text(session.client ?: "客户端未提供", color = cm.ink2, style = MaterialTheme.typography.bodySmall)
            }
        }
        Text("最后活动 ${Format.fmtDateTime(session.lastUsedAt, zone).ifBlank { "未提供" }}", color = cm.ink2, style = MaterialTheme.typography.bodySmall)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            HistoryMetric("词元用量", Format.fmtCompact(session.tokens))
            HistoryMetric("估算费用", Format.fmtUsd(session.costUsd))
        }
        if (expanded) {
            Text("来源设备 · ${session.device ?: session.deviceId ?: "未提供"}", color = cm.ink2, style = MaterialTheme.typography.bodyMedium)
            Text("会话标识 · ${session.sessionId ?: "未提供"}", color = cm.ink2, style = MaterialTheme.typography.bodySmall)
            Text("开始于 ${Format.fmtDateTime(session.startedAt, zone).ifBlank { "未提供" }}", color = cm.ink2, style = MaterialTheme.typography.bodySmall)
            HistoryBreakdown("使用模型", session.models, modelColors)
        }
        TextButton(onClick = { expanded = !expanded }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text(if (expanded) "收起会话详情" else "查看会话详情") }
        HorizontalDivider(color = cm.border)
    }
}

@Composable
private fun HistoryMetric(label: String, value: String) {
    val cm = CmColorsCurrent
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(label, color = cm.ink2, style = MaterialTheme.typography.bodySmall)
        Text(value, color = cm.ink, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
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
        TextButton(onClick = { expanded = !expanded }, modifier = Modifier.heightIn(min = 48.dp)) { Text(if (expanded) "收起采样详情" else "查看采样详情") }
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
            Format.fmtDateTime(row.startedAt, zone), Format.fmtDateTime(row.lastUsedAt, zone), zone, row.tokens.toString(), row.costUsd.toString(),
            row.models.keys.joinToString("; ")).joinToString(",", transform = ::cell)
    }
    return "\uFEFF" + lines.joinToString("\r\n") + "\r\n"
}
