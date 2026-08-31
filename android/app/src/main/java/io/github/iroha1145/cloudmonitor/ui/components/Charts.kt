@file:OptIn(
    androidx.compose.foundation.ExperimentalFoundationApi::class,
    androidx.compose.foundation.layout.ExperimentalLayoutApi::class,
)

package io.github.iroha1145.cloudmonitor.ui.components

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.github.iroha1145.cloudmonitor.data.Format
import io.github.iroha1145.cloudmonitor.data.OTHER_COLOR
import io.github.iroha1145.cloudmonitor.data.TrendRow
import io.github.iroha1145.cloudmonitor.data.hmLevel
import io.github.iroha1145.cloudmonitor.ui.theme.CmColorsCurrent
import io.github.iroha1145.cloudmonitor.ui.theme.rememberGrow
import kotlin.math.atan2
import kotlin.math.min

@Composable
fun StackedTrendChart(
    rows: List<TrendRow>,
    colors: Map<String, Color>,
    topModels: List<String>,
    modifier: Modifier = Modifier,
) {
    val max = rows.maxOfOrNull { it.total }?.coerceAtLeast(1.0) ?: 1.0
    val grow = rememberGrow(rows.size to topModels.joinToString())
    val tip = LocalFloatTip.current
    Column(modifier) {
        if (topModels.isNotEmpty()) {
            // 对齐网页 trend-legend：完整图例，放不下换行
            FlowRow(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                topModels.forEach { name ->
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Box(Modifier.size(8.dp).clip(CircleShape).background(colors[name] ?: OTHER_COLOR))
                        Spacer(Modifier.width(4.dp))
                        Text(name, fontSize = 11.sp, color = CmColorsCurrent.mute, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
            Spacer(Modifier.height(10.dp))
        }
        Row(
            Modifier.fillMaxWidth().height(148.dp),
            horizontalArrangement = Arrangement.spacedBy(3.dp),
            verticalAlignment = Alignment.Bottom,
        ) {
            rows.forEach { row ->
                Column(
                    Modifier
                        .weight(1f)
                        .fillMaxHeight()
                        .onWindowPress(row.day, row.total) { pos ->
                            tip.show(row.day, listOf("合计" to Format.fmtCompact(row.total)), pos)
                        },
                    verticalArrangement = Arrangement.Bottom,
                ) {
                    val hFrac = (row.total / max).toFloat().coerceIn(0f, 1f) * grow
                    Column(
                        Modifier
                            .fillMaxWidth()
                            .fillMaxHeight(hFrac.coerceAtLeast(0.02f))
                            .graphicsLayer { transformOrigin = androidx.compose.ui.graphics.TransformOrigin(0.5f, 1f) },
                        verticalArrangement = Arrangement.Bottom,
                    ) {
                        val segs = buildList<Pair<Color, Double>> {
                            var used = 0.0
                            topModels.forEach { m ->
                                val v = row.models[m] ?: 0.0
                                if (v > 0) {
                                    add(Pair(colors[m] ?: OTHER_COLOR, v))
                                    used += v
                                }
                            }
                            val rest = row.total - used
                            if (rest > 1) add(Pair(OTHER_COLOR, rest))
                        }
                        val sum = segs.sumOf { it.second }.coerceAtLeast(1.0)
                        segs.asReversed().forEach { (c, v) ->
                            Box(
                                Modifier
                                    .fillMaxWidth()
                                    .weight((v / sum).toFloat().coerceAtLeast(0.0001f))
                                    .background(c, RoundedCornerShape(2.dp)),
                            )
                        }
                    }
                }
            }
        }
        Spacer(Modifier.height(6.dp))
        // 对齐网页 x 轴：首/中/末多点日期标注
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            val marks = buildList {
                add(rows.firstOrNull()?.day.orEmpty())
                if (rows.size >= 15) add(rows[rows.size / 3].day)
                if (rows.size >= 15) add(rows[rows.size * 2 / 3].day)
                add(rows.lastOrNull()?.day.orEmpty())
            }
            marks.forEach { Text(it.drop(5), fontSize = 10.sp, color = CmColorsCurrent.mute) }
        }
    }
}

@Composable
fun DonutChart(
    slices: List<Pair<String, Double>>,
    colors: Map<String, Color>,
    total: Double,
    modifier: Modifier = Modifier,
    centerSub: String? = null,
    costs: Map<String, Double> = emptyMap(),
    cacheRates: Map<String, Double?> = emptyMap(),
) {
    val cm = CmColorsCurrent
    val sum = slices.sumOf { it.second }.coerceAtLeast(1.0)
    val grow = rememberGrow(slices.joinToString { it.first } to total)
    val tip = LocalFloatTip.current
    var expanded by remember { mutableStateOf(false) }
    // 对齐网页：超过 8 个模型时收起，平铺前 6 行
    val visible = if (slices.size > 8 && !expanded) slices.take(6) else slices
    val hidden = (slices.size - visible.size).coerceAtLeast(0)

    fun tipRows(name: String, v: Double): List<Pair<String, String>> {
        val rows = mutableListOf(
            "tokens" to Format.fmtInt(v),
            "占比" to Format.pct1(v, sum),
            "模型使用费用" to (costs[name]?.let { Format.fmtUsd(it) } ?: "—"),
        )
        cacheRates[name]?.let { rows += "缓存率" to Format.fmtPct(it) }
        return rows
    }

    Row(modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(132.dp), contentAlignment = Alignment.Center) {
            var donutLayout by remember { mutableStateOf<LayoutCoordinates?>(null) }
            Canvas(
                Modifier
                    .fillMaxSize()
                    .onGloballyPositioned { donutLayout = it }
                    .pointerInput(slices, grow) {
                        fun openAt(offset: Offset) {
                            val cx = size.width / 2f
                            val cy = size.height / 2f
                            var deg = Math.toDegrees(
                                atan2((offset.y - cy).toDouble(), (offset.x - cx).toDouble()),
                            )
                            deg = (deg + 90.0 + 360.0) % 360.0
                            var start = 0.0
                            slices.forEach { (name, v) ->
                                val sweep = v / sum * 360.0 * grow
                                if (deg >= start && deg < start + sweep) {
                                    tip.show(name, tipRows(name, v), donutLayout.toWindow(offset))
                                    return
                                }
                                start += sweep
                            }
                        }
                        detectTapGestures(
                            onTap = { openAt(it) },
                            onLongPress = { openAt(it) },
                        )
                    },
            ) {
                val stroke = Stroke(width = size.minDimension * 0.18f, cap = StrokeCap.Butt)
                val inset = stroke.width / 2
                val arcSize = Size(size.width - stroke.width, size.height - stroke.width)
                var start = -90f
                slices.forEach { (name, v) ->
                    val sweep = (v / sum * 360.0 * grow).toFloat()
                    drawArc(
                        color = colors[name] ?: OTHER_COLOR,
                        startAngle = start,
                        sweepAngle = (sweep - 1.2f).coerceAtLeast(0f),
                        useCenter = false,
                        topLeft = Offset(inset, inset),
                        size = arcSize,
                        style = stroke,
                    )
                    start += sweep
                }
            }
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                CompactNumber(total, size = 18.sp, tight = true)
                if (centerSub != null) {
                    Text(centerSub, fontSize = 10.sp, color = cm.mute)
                }
            }
        }
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            visible.forEach { (name, v) ->
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier.tipClick(name, tipRows(name, v)),
                ) {
                    Box(Modifier.size(8.dp).clip(CircleShape).background(colors[name] ?: OTHER_COLOR))
                    Spacer(Modifier.width(6.dp))
                    Column(Modifier.weight(1f)) {
                        Text(name, fontSize = 12.sp, color = cm.ink, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text("${Format.fmtCompact(v)} · ${Format.pct1(v, sum)}", fontSize = 11.sp, color = cm.mute)
                    }
                }
            }
            if (hidden > 0) {
                TextButton(onClick = { expanded = true }) {
                    Text("展开其余 $hidden 个模型", fontSize = 12.sp)
                }
            } else if (slices.size > 8 && expanded) {
                TextButton(onClick = { expanded = false }) {
                    Text("收起模型列表", fontSize = 12.sp)
                }
            }
        }
    }
}

@Composable
fun QuotaRing(remainPct: Float, level: String, modifier: Modifier = Modifier) {
    val cm = CmColorsCurrent
    val color = when (level) {
        "crit" -> cm.crit
        "warn" -> cm.warn
        else -> cm.ok
    }
    val grow = rememberGrow(remainPct to level)
    Box(modifier.size(56.dp), contentAlignment = Alignment.Center) {
        Canvas(Modifier.fillMaxSize()) {
            val stroke = Stroke(width = 6.dp.toPx(), cap = StrokeCap.Round)
            val inset = stroke.width / 2
            val arcSize = Size(size.width - stroke.width, size.height - stroke.width)
            drawArc(cm.border, -90f, 360f, false, Offset(inset, inset), arcSize, style = stroke)
            drawArc(
                color,
                -90f,
                360f * remainPct.coerceIn(0f, 1f) * grow,
                false,
                Offset(inset, inset),
                arcSize,
                style = stroke,
            )
        }
        Text("${(remainPct * 100).toInt()}%", fontSize = 12.sp, fontWeight = FontWeight.SemiBold, color = cm.ink)
    }
}

@Composable
fun HeatCells(
    values: List<Pair<String, Double>>,
    columns: Int,
    showLabel: Boolean,
    leading: Int = 0,
) {
    val cm = CmColorsCurrent
    val max = values.maxOfOrNull { it.second }?.coerceAtLeast(1.0) ?: 1.0
    val padded = List(leading) { "" to -1.0 } + values
    val rows = (padded.size + columns - 1) / columns
    val tip = LocalFloatTip.current
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        repeat(rows) { r ->
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                repeat(columns) { c ->
                    val i = r * columns + c
                    if (i >= padded.size) {
                        Spacer(Modifier.weight(1f).aspectRatio(1f))
                    } else {
                        val (label, v) = padded[i]
                        if (v < 0) {
                            Spacer(Modifier.weight(1f).aspectRatio(1f))
                        } else {
                            val lv = hmLevel(v, max)
                            Box(
                                Modifier
                                    .weight(1f)
                                    .aspectRatio(1f)
                                    .clip(RoundedCornerShape(6.dp))
                                    .background(cm.hm[min(lv, cm.hm.lastIndex)])
                                    .onWindowPress(label, v) { pos ->
                                        tip.show(label, listOf("tokens" to Format.fmtCompact(v)), pos)
                                    },
                                contentAlignment = Alignment.Center,
                            ) {
                                if (showLabel) {
                                    val fg = if (lv >= 4) Color.White else cm.ink
                                    Text(label, fontSize = 10.sp, color = fg)
                                }
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
    val grow = rememberGrow(values.joinToString { it.first })
    Row(
        modifier.fillMaxWidth().height(36.dp),
        horizontalArrangement = Arrangement.spacedBy(3.dp),
        verticalAlignment = Alignment.Bottom,
    ) {
        values.forEach { (day, v) ->
            val h = ((v / max).toFloat() * grow).coerceIn(if (v <= 0) 0.08f else 0.12f, 1f)
            Box(
                Modifier
                    .weight(1f)
                    .fillMaxHeight(h)
                    .clip(RoundedCornerShape(2.dp))
                    .background(if (v <= 0) cm.border else cm.brand)
                    .onWindowPress(day, v) { pos ->
                        tip.show(day, listOf("tokens" to Format.fmtCompact(v)), pos)
                    },
            )
        }
    }
}

@Composable
fun MatrixGrid(
    rows: List<String>,
    cols: List<String>,
    modifier: Modifier = Modifier,
    cost: Boolean = false,
    valueAt: (String, String) -> Double,
) {
    val cm = CmColorsCurrent
    val max = rows.maxOfOrNull { r -> cols.maxOfOrNull { c -> valueAt(r, c) } ?: 0.0 }?.coerceAtLeast(1.0) ?: 1.0
    val tip = LocalFloatTip.current
    Column(modifier) {
        Row(Modifier.fillMaxWidth()) {
            Spacer(Modifier.width(52.dp))
            cols.forEach { c ->
                Text(
                    c.take(8),
                    Modifier.weight(1f),
                    fontSize = 9.sp,
                    color = cm.mute,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        Spacer(Modifier.height(4.dp))
        rows.forEach { r ->
            Row(Modifier.fillMaxWidth().padding(vertical = 2.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(r, Modifier.width(52.dp), fontSize = 11.sp, color = cm.ink, maxLines = 1, overflow = TextOverflow.Ellipsis)
                cols.forEach { c ->
                    val v = valueAt(r, c)
                    val lv = hmLevel(v, max)
                    Box(
                        Modifier
                            .weight(1f)
                            .padding(2.dp)
                            .aspectRatio(1f)
                            .clip(RoundedCornerShape(6.dp))
                            .background(cm.hm[min(lv, cm.hm.lastIndex)])
                            .onWindowPress("$r|$c|$v|$cost") { pos ->
                                tip.show(
                                    "$r × $c",
                                    listOf((if (cost) "费用" else "tokens") to if (cost) Format.fmtUsd(v) else Format.fmtCompact(v)),
                                    pos,
                                )
                            },
                    )
                }
            }
        }
    }
}
