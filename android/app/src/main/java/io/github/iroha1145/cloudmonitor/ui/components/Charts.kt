@file:OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)

package io.github.iroha1145.cloudmonitor.ui.components

import androidx.compose.foundation.Canvas
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
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import io.github.iroha1145.cloudmonitor.data.*
import io.github.iroha1145.cloudmonitor.ui.theme.CmColorsCurrent
import kotlin.math.roundToInt

private fun dailySegments(row: TrendRow): List<TokenSeg> {
    val data = row.components
    if (data == null || !data.known) return listOf(TokenSeg("unclassified", "未分类", SEG_UNCLS, row.total))
    return listOf(TokenSeg("input", "非缓存输入", SEG_INPUT, data.input), TokenSeg("output", "输出", SEG_OUTPUT, data.output),
        TokenSeg("cacheRead", "缓存读取", SEG_CACHE_READ, data.cacheRead), TokenSeg("cacheWrite", "缓存写入", SEG_CACHE_WRITE, data.cacheWrite),
        TokenSeg("unclassified", "未分类", SEG_UNCLS, data.unclassified)).filter { it.value > 0 }
}

/** A single touch surface lets a finger follow daily values without tiny bar targets. */
@Suppress("UNUSED_PARAMETER")
@Composable
fun StackedTrendChart(rows: List<TrendRow>, colors: Map<String, Color>, topModels: List<String>, modifier: Modifier = Modifier) {
    if (rows.isEmpty()) return
    val cm = CmColorsCurrent
    var selectedDay by rememberSaveable { mutableStateOf(rows.last().day) }
    val selected = rows.indexOfFirst { it.day == selectedDay }.takeIf { it >= 0 } ?: rows.lastIndex
    val row = rows[selected]
    val maximum = rows.maxOf { it.total }.coerceAtLeast(1.0)
    val tip = LocalFloatTip.current
    Column(modifier) {
        Canvas(Modifier.fillMaxWidth().height(170.dp).testTag("trend-chart")
            .pointerInput(rows) {
                detectTapGestures { point -> selectedDay = rows[(point.x / size.width * rows.size).toInt().coerceIn(rows.indices)].day }
            }.pointerInput(rows) {
                detectHorizontalDragGestures(onDragStart = { point -> selectedDay = rows[(point.x / size.width * rows.size).toInt().coerceIn(rows.indices)].day }) { change, _ ->
                    change.consume()
                    selectedDay = rows[(change.position.x / size.width * rows.size).toInt().coerceIn(rows.indices)].day
                }
            }.clearAndSetSemantics { contentDescription = "每日用量堆积图，使用下方日期滑块查看详情" }) {
            val cell = size.width / rows.size
            val gap = (cell * 0.25f).coerceAtMost(7.dp.toPx())
            repeat(4) { line ->
                val y = size.height * line / 3
                drawLine(cm.border, Offset(0f, y), Offset(size.width, y), 1.dp.toPx())
            }
            rows.forEachIndexed { index, item ->
                var bottom = size.height
                dailySegments(item).forEach { segment ->
                    val height = (segment.value / maximum * size.height).toFloat()
                    if (height > 0f) drawRect(segment.color, Offset(index * cell + gap / 2, bottom - height), Size(cell - gap, height))
                    bottom -= height
                }
            }
            val x = (selected + .5f) * cell
            drawLine(cm.ink.copy(alpha = .65f), Offset(x, 0f), Offset(x, size.height), 1.5.dp.toPx())
        }
        Row(Modifier.fillMaxWidth().padding(top = 8.dp), horizontalArrangement = Arrangement.SpaceBetween) {
            Text(rows.first().day.drop(5), color = cm.mute, style = MaterialTheme.typography.labelSmall)
            Text(rows.last().day.drop(5), color = cm.mute, style = MaterialTheme.typography.labelSmall)
        }
        if (rows.size > 1) Slider(value = selected.toFloat(), onValueChange = { selectedDay = rows[it.roundToInt().coerceIn(rows.indices)].day },
            valueRange = 0f..rows.lastIndex.toFloat(), steps = (rows.size - 2).coerceAtLeast(0),
            modifier = Modifier.fillMaxWidth().testTag("trend-slider").semantics {
                contentDescription = "选择趋势日期"
                stateDescription = "${row.day}，${Format.fmtCompact(row.total)}词元"
            })
        Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(cm.canvas).padding(14.dp).testTag("trend-selection"),
            verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(row.day, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
            Text("${Format.fmtCompact(row.total)} 词元 · ${row.costUsd?.let(Format::fmtUsd) ?: "费用未提供"}", style = MaterialTheme.typography.bodyMedium)
            Text("${row.components?.cacheLabel ?: "缓存占比"} ${row.components?.cacheRate?.let(Format::fmtPct) ?: "未提供"}",
                color = cm.okInk, style = MaterialTheme.typography.bodySmall)
            ComponentLegend(dailySegments(row))
            TextButton(onClick = {
                val data = row.components
                tip.show(row.day, listOf("全部词元" to Format.fmtInt(row.total), "费用" to (row.costUsd?.let(Format::fmtUsd) ?: "未提供"),
                    "非缓存输入" to if (data?.inputKnown == true) Format.fmtInt(data.input) else "未提供",
                    "输出" to if (data?.outputKnown == true) Format.fmtInt(data.output) else "未提供",
                    "缓存读取" to if (data?.cacheReadKnown == true) Format.fmtInt(data.cacheRead) else "未提供",
                    "缓存写入" to if (data?.cacheWriteKnown == true) Format.fmtInt(data.cacheWrite) else "未提供"))
            }, contentPadding = PaddingValues(horizontal = 0.dp), modifier = Modifier.heightIn(min = 48.dp)) { Text("查看当日明细") }
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
