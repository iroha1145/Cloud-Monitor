@file:OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)

package io.github.iroha1145.cloudmonitor.ui.components

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.border
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.github.iroha1145.cloudmonitor.data.*
import io.github.iroha1145.cloudmonitor.ui.theme.CmColorsCurrent
import kotlin.math.roundToInt

/** The mobile HTML's inset line chart; displayed values always come from daily records. */
@Composable
fun DailyTrendChart(rows: List<TrendRow>, page: io.github.iroha1145.cloudmonitor.ui.PageState, modifier: Modifier = Modifier) {
    if (rows.isEmpty()) return
    val cm = CmColorsCurrent
    var metric by page.trendMetric
    var selectedDay by page.trendDay
    val selected = rows.indexOfFirst { it.day == selectedDay }.takeIf { it >= 0 } ?: rows.lastIndex
    val row = rows[selected]
    val summary = remember(rows) { summarizeTrend(rows) }
    val cost = metric == "cost" && summary.hasCost
    val color = if (cost) Color(0xFFF09A2F) else Color(0xFF3D9AFF)
    val tip = LocalFloatTip.current
    val dates = remember(rows) { rows.map { java.time.LocalDate.parse(it.day).toEpochDay() } }
    val first = dates.first()
    val span = (dates.last() - first).coerceAtLeast(1)
    val values = rows.map { if (cost) it.costUsd ?: 0.0 else it.total }
    val canDraw = rows.size >= 2 && (!cost || summary.allCosts)
    val min = values.minOrNull() ?: 0.0
    val max = values.maxOrNull() ?: 0.0
    val range = (max - min).coerceAtLeast(max * .1).coerceAtLeast(1.0)
    fun shortDay(day: String) = "${day.substring(5, 7).toInt()}/${day.takeLast(2).toInt()}"
    fun showDetails(item: TrendRow) {
        val data = item.components
        tip.show(item.day, listOf(
            "全部词元" to Format.fmtInt(item.total),
            "当天花费" to (item.costUsd?.let(Format::fmtUsd) ?: "未提供"),
            (data?.cacheLabel ?: "缓存占比") to (data?.cacheRate?.let(Format::fmtPct) ?: "未提供"),
            "缓存读取" to if (data?.cacheReadKnown == true) Format.fmtInt(data.cacheRead) else "未提供",
            "非缓存输入" to if (data?.inputKnown == true) Format.fmtInt(data.input) else "未提供",
            "输出" to if (data?.outputKnown == true) Format.fmtInt(data.output) else "未提供",
            "缓存写入" to if (data?.cacheWriteKnown == true) Format.fmtInt(data.cacheWrite) else "未提供",
            "未分类" to (data?.let { Format.fmtInt(it.unclassified) } ?: "未提供")))
    }
    Column(modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(cm.inset)
        .border(1.dp, cm.border, RoundedCornerShape(10.dp))) {
        FlowRow(Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 5.dp),
            horizontalArrangement = Arrangement.SpaceBetween, verticalArrangement = Arrangement.spacedBy(4.dp),
            itemVerticalAlignment = Alignment.CenterVertically) {
            Text("${shortDay(rows.first().day)} — ${shortDay(rows.last().day)}", color = cm.mute,
                fontSize = 11.sp, modifier = Modifier.padding(end = 8.dp))
            WebSegments(listOf("词元用量", "使用费用"), if (cost) 1 else 0,
                { metric = if (it == 1) "cost" else "tokens" }, tags = listOf("trend-tokens", "trend-cost"),
                enabled = listOf(true, summary.hasCost))
        }
        HorizontalDivider(color = cm.border)
        Box(Modifier.fillMaxWidth().height(260.dp).padding(horizontal = 12.dp)) {
            Canvas(Modifier.fillMaxSize().testTag("trend-chart")
                .pointerInput(rows, cost) {
                    fun nearest(x: Float): Int {
                        val progress = ((x / size.width - .025f) / .95f).coerceIn(0f, 1f)
                        val day = first + progress * span
                        return dates.indices.minBy { kotlin.math.abs(dates[it] - day) }
                    }
                    detectTapGestures { point ->
                        val index = nearest(point.x)
                        selectedDay = rows[index].day
                        showDetails(rows[index])
                    }
                }.pointerInput(rows, cost) {
                    fun select(x: Float) {
                        val progress = ((x / size.width - .025f) / .95f).coerceIn(0f, 1f)
                        val day = first + progress * span
                        selectedDay = rows[dates.indices.minBy { kotlin.math.abs(dates[it] - day) }].day
                    }
                    detectHorizontalDragGestures(onDragStart = { select(it.x) }) { change, _ ->
                        change.consume(); select(change.position.x)
                    }
                }.semantics {
                    contentDescription = "每日趋势折线图"
                    stateDescription = "${row.day}，${Format.fmtCompact(row.total)}词元，${row.costUsd?.let(Format::fmtUsd) ?: "费用未提供"}"
                    progressBarRangeInfo = ProgressBarRangeInfo(selected.toFloat(), 0f..rows.lastIndex.toFloat(), (rows.size - 2).coerceAtLeast(0))
                    setProgress { value -> selectedDay = rows[value.roundToInt().coerceIn(rows.indices)].day; true }
                    customActions = listOf(CustomAccessibilityAction("查看当日明细") { showDetails(row); true })
                }) {
                val left = size.width * .025f
                val plotWidth = size.width * .95f
                val top = 38.dp.toPx()
                val bottom = size.height - 24.dp.toPx()
                fun x(index: Int) = left + ((dates[index] - first).toDouble() / span * plotWidth).toFloat()
                fun y(value: Double) = bottom - ((value - min) / range * (bottom - top)).toFloat()
                drawLine(cm.border.copy(alpha = .55f), Offset(left, bottom + 10.dp.toPx()), Offset(left + plotWidth, bottom + 10.dp.toPx()), 1.dp.toPx())
                if (canDraw) {
                    val path = Path()
                    path.moveTo(x(0), y(values[0]))
                    // Same Catmull-Rom samples as InsightTrend.tsx, clamped at zero.
                    for (i in 0 until rows.lastIndex) {
                        val p0 = values[(i - 1).coerceAtLeast(0)]
                        val p1 = values[i]
                        val p2 = values[i + 1]
                        val p3 = values[(i + 2).coerceAtMost(rows.lastIndex)]
                        for (sample in 1..9) {
                            val t = sample / 9.0
                            val value = (.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t)).coerceAtLeast(0.0)
                            path.lineTo(x(i) + (x(i + 1) - x(i)) * t.toFloat(), y(value).coerceIn(8.dp.toPx(), bottom))
                        }
                    }
                    drawLine(color.copy(alpha = .2f), Offset(left, y(values.last())), Offset(left + plotWidth, y(values.last())), 1.dp.toPx(), pathEffect = PathEffect.dashPathEffect(floatArrayOf(4.dp.toPx(), 4.dp.toPx())))
                    drawPath(path, color, style = Stroke(2.25.dp.toPx(), cap = StrokeCap.Round, join = StrokeJoin.Round))
                    drawCircle(cm.card, 5.dp.toPx(), Offset(x(rows.lastIndex), y(values.last())))
                    drawCircle(color, 3.dp.toPx(), Offset(x(rows.lastIndex), y(values.last())))
                }
                if (selectedDay.isNotBlank()) {
                    drawLine(cm.ink.copy(alpha = .25f), Offset(x(selected), 16.dp.toPx()), Offset(x(selected), bottom), 1.dp.toPx())
                    if (!cost || row.costUsd != null) drawCircle(color, 4.dp.toPx(), Offset(x(selected), y(values[selected])))
                }
            }
            if (!canDraw) Column(Modifier.align(Alignment.Center).padding(16.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                Text(if (cost && !summary.allCosts) "部分日期费用未提供" else "已记录 1 天", fontSize = 13.sp, color = cm.ink)
                Text("点按日期位置可查看已有明细", fontSize = 11.sp, color = cm.mute, modifier = Modifier.padding(top = 8.dp))
            }
            if (selectedDay.isNotBlank()) Text("${shortDay(row.day)} · ${if (cost) row.costUsd?.let(Format::fmtUsd) ?: "未提供" else Format.fmtCompact(row.total)}",
                fontSize = 11.sp, color = cm.ink, modifier = Modifier.align(Alignment.TopStart).padding(top = 10.dp).testTag("trend-selection"))
        }
        Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, bottom = 10.dp), horizontalArrangement = Arrangement.SpaceBetween) {
            Text(shortDay(rows.first().day), color = cm.mute, fontSize = 10.sp)
            Text(shortDay(java.time.LocalDate.ofEpochDay(first + span / 2).toString()), color = cm.mute, fontSize = 10.sp)
            Text(shortDay(rows.last().day), color = cm.mute, fontSize = 10.sp)
        }
        HorizontalDivider(color = cm.border)
        FlowRow(Modifier.fillMaxWidth().padding(horizontal = 8.dp), horizontalArrangement = Arrangement.SpaceBetween,
            itemVerticalAlignment = Alignment.CenterVertically) {
            Text("点按或拖动，查看当天明细", color = cm.mute, fontSize = 10.sp)
            Row(verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = { selectedDay = rows[selected - 1].day }, enabled = selected > 0, modifier = Modifier.size(48.dp).testTag("trend-previous")) {
                    Icon(io.github.iroha1145.cloudmonitor.ui.AppIcons.ChevronLeft, "查看前一天记录", modifier = Modifier.size(16.dp), tint = if (selected > 0) cm.mute else cm.mute.copy(alpha = .3f))
                }
                Box(Modifier.sizeIn(minWidth = 48.dp, minHeight = 48.dp).clickable(role = Role.Button, onClickLabel = "查看当日明细") { showDetails(row) }
                    .testTag("trend-details").semantics { contentDescription = "查看当日明细，${row.day}" }.padding(horizontal = 2.dp), contentAlignment = Alignment.Center) {
                    Text(shortDay(row.day), fontSize = 11.sp, color = cm.mute)
                }
                IconButton(onClick = { selectedDay = rows[selected + 1].day }, enabled = selected < rows.lastIndex, modifier = Modifier.size(48.dp).testTag("trend-next")) {
                    Icon(io.github.iroha1145.cloudmonitor.ui.AppIcons.ChevronRight, "查看后一天记录", modifier = Modifier.size(16.dp), tint = if (selected < rows.lastIndex) cm.mute else cm.mute.copy(alpha = .3f))
                }
            }
        }
    }
}

@Composable
fun QuotaRing(remainPct: Float, level: String, modifier: Modifier = Modifier) {
    val cm = CmColorsCurrent
    val color = when (level) { "crit" -> cm.crit; "warn" -> cm.warn; else -> cm.ok }
    Box(modifier.size(64.dp).semantics { contentDescription = "剩余额度 ${(remainPct * 100).roundToInt()}%" }, contentAlignment = Alignment.Center) {
        Canvas(Modifier.fillMaxSize()) {
            val stroke = Stroke(5.dp.toPx(), cap = StrokeCap.Round)
            val inset = stroke.width / 2
            val arc = Size(size.width - stroke.width, size.height - stroke.width)
            drawArc(cm.border, -90f, 360f, false, Offset(inset, inset), arc, style = stroke)
            drawArc(color, -90f, 360f * remainPct.coerceIn(0f, 1f), false, Offset(inset, inset), arc, style = stroke)
        }
        // The adjacent text carries the value at large font scales without squeezing it inside the ring.
    }
}

@Composable
fun HeatCells(values: List<Pair<String, Double>>, columns: Int, showLabel: Boolean, leading: Int = 0) {
    val cm = CmColorsCurrent
    val max = values.maxOfOrNull { it.second }?.coerceAtLeast(1.0) ?: 1.0
    val padded = List(leading.coerceAtLeast(0)) { "" to -1.0 } + values
    val tip = LocalFloatTip.current
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val cellSize = ((maxWidth - 4.dp * (columns - 1)) / columns).coerceAtLeast(48.dp)
        Column(Modifier.horizontalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            padded.chunked(columns).forEach { row ->
                Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    row.forEach { (label, value) ->
                        if (value < 0) Spacer(Modifier.size(cellSize))
                        else {
                            val level = hmLevel(value, max).coerceIn(cm.hm.indices)
                            Box(Modifier.size(cellSize).clip(RoundedCornerShape(8.dp)).background(cm.hm[level])
                                .clickable(role = Role.Button, onClickLabel = "查看用量") { tip.show(label, listOf("词元用量" to Format.fmtInt(value))) }
                                .semantics { contentDescription = "$label，${Format.fmtCompact(value)}词元" }, contentAlignment = Alignment.Center) {
                                if (showLabel) Text(label, color = if (cm.hm[level].luminance() > 0.179f) Color.Black else Color.White,
                                    style = MaterialTheme.typography.labelSmall, modifier = Modifier.clearAndSetSemantics {})
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
fun SparkBars(values: List<Pair<String, Double>>, modifier: Modifier = Modifier) {
    val max = values.maxOfOrNull { it.second }?.coerceAtLeast(1.0) ?: 1.0
    val cm = CmColorsCurrent
    val tip = LocalFloatTip.current
    Row(modifier.fillMaxWidth().heightIn(min = 48.dp).horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        values.forEach { (day, value) ->
            Box(Modifier.width(48.dp).height(48.dp).clickable(role = Role.Button) { tip.show(day, listOf("词元用量" to Format.fmtInt(value))) }
                .semantics { contentDescription = "$day，${Format.fmtCompact(value)}词元" }, contentAlignment = Alignment.BottomCenter) {
                Box(Modifier.fillMaxWidth().fillMaxHeight((value / max).toFloat().coerceIn(.02f, 1f)).clip(RoundedCornerShape(4.dp))
                    .background(if (value <= 0) cm.border else cm.brand))
            }
        }
    }
}

@Composable
fun MatrixGrid(rows: List<String>, cols: List<String>, modifier: Modifier = Modifier, cost: Boolean = false, valueAt: (String, String) -> Double) {
    val cm = CmColorsCurrent
    val tip = LocalFloatTip.current
    val max = rows.maxOfOrNull { row -> cols.maxOfOrNull { valueAt(row, it) } ?: 0.0 }?.coerceAtLeast(1.0) ?: 1.0
    Column(modifier) {
        Text("横向滑动查看全部模型，轻触色块查看详情。", color = cm.mute, style = MaterialTheme.typography.bodySmall)
        Spacer(Modifier.height(12.dp))
        Column(Modifier.horizontalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.Bottom) {
                Text("客户端", Modifier.width(110.dp), style = MaterialTheme.typography.labelMedium, color = cm.mute)
                cols.forEach { Text(it, Modifier.width(112.dp), style = MaterialTheme.typography.labelMedium, color = cm.mute) }
            }
            rows.forEach { row ->
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(row, Modifier.width(110.dp), style = MaterialTheme.typography.bodySmall)
                    cols.forEach { column ->
                        val value = valueAt(row, column)
                        val level = hmLevel(value, max).coerceIn(cm.hm.indices)
                        val formatted = if (cost) Format.fmtUsd(value) else Format.fmtCompact(value)
                        Box(Modifier.width(112.dp).heightIn(min = 56.dp).clip(RoundedCornerShape(10.dp)).background(cm.hm[level])
                            .clickable(role = Role.Button) { tip.show("$row · $column", listOf((if (cost) "费用" else "词元用量") to if (cost) Format.fmtUsd(value) else Format.fmtInt(value))) }
                            .semantics { contentDescription = "$row，$column，$formatted" }.padding(10.dp), contentAlignment = Alignment.Center) {
                            Text(formatted, color = if (cm.hm[level].luminance() > 0.179f) Color.Black else Color.White, style = MaterialTheme.typography.bodySmall,
                                modifier = Modifier.clearAndSetSemantics {})
                        }
                    }
                }
            }
        }
    }
}
