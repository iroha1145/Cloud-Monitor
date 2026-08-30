package io.github.iroha1145.cloudmonitor.ui.components

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
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
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.github.iroha1145.cloudmonitor.data.Format
import io.github.iroha1145.cloudmonitor.data.OTHER_COLOR
import io.github.iroha1145.cloudmonitor.data.TrendRow
import io.github.iroha1145.cloudmonitor.data.hmLevel
import io.github.iroha1145.cloudmonitor.ui.theme.CmColorsCurrent
import kotlin.math.min

@Composable
fun StackedTrendChart(
    rows: List<TrendRow>,
    colors: Map<String, Color>,
    topModels: List<String>,
    modifier: Modifier = Modifier,
) {
    val max = rows.maxOfOrNull { it.total }?.coerceAtLeast(1.0) ?: 1.0
    Column(modifier) {
        if (topModels.isNotEmpty()) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                topModels.take(6).forEach { name ->
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
                    Modifier.weight(1f).fillMaxHeight(),
                    verticalArrangement = Arrangement.Bottom,
                ) {
                    val hFrac = (row.total / max).toFloat().coerceIn(0f, 1f)
                    Column(
                        Modifier.fillMaxWidth().fillMaxHeight(hFrac.coerceAtLeast(0.02f)),
                        verticalArrangement = Arrangement.Bottom,
                    ) {
                        val segs = buildList {
                            var used = 0.0
                            topModels.forEach { m ->
                                val v = row.models[m] ?: 0.0
                                if (v > 0) {
                                    add(colors[m] ?: OTHER_COLOR to v)
                                    used += v
                                }
                            }
                            val rest = row.total - used
                            if (rest > 1) add(OTHER_COLOR to rest)
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
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text(rows.firstOrNull()?.day.orEmpty().drop(5), fontSize = 10.sp, color = CmColorsCurrent.mute)
            Text(rows.lastOrNull()?.day.orEmpty().drop(5), fontSize = 10.sp, color = CmColorsCurrent.mute)
        }
    }
}

@Composable
fun DonutChart(
    slices: List<Pair<String, Double>>,
    colors: Map<String, Color>,
    total: Double,
    modifier: Modifier = Modifier,
) {
    val cm = CmColorsCurrent
    val sum = slices.sumOf { it.second }.coerceAtLeast(1.0)
    Row(modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(132.dp), contentAlignment = Alignment.Center) {
            Canvas(Modifier.fillMaxSize()) {
                val stroke = Stroke(width = size.minDimension * 0.18f, cap = StrokeCap.Butt)
                val inset = stroke.width / 2
                val arcSize = Size(size.width - stroke.width, size.height - stroke.width)
                var start = -90f
                slices.forEach { (name, v) ->
                    val sweep = (v / sum * 360.0).toFloat()
                    drawArc(
                        color = colors[name] ?: OTHER_COLOR,
                        startAngle = start,
                        sweepAngle = sweep - 1.2f,
                        useCenter = false,
                        topLeft = Offset(inset, inset),
                        size = arcSize,
                        style = stroke,
                    )
                    start += sweep
                }
            }
            CompactNumber(total, size = 18.sp, tight = true)
        }
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            slices.take(6).forEach { (name, v) ->
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.size(8.dp).clip(CircleShape).background(colors[name] ?: OTHER_COLOR))
                    Spacer(Modifier.width(6.dp))
                    Column(Modifier.weight(1f)) {
                        Text(name, fontSize = 12.sp, color = cm.ink, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text("${Format.fmtCompact(v)} · ${Format.pct1(v, sum)}", fontSize = 11.sp, color = cm.mute)
                    }
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
    Box(modifier.size(56.dp), contentAlignment = Alignment.Center) {
        Canvas(Modifier.fillMaxSize()) {
            val stroke = Stroke(width = 6.dp.toPx(), cap = StrokeCap.Round)
            val inset = stroke.width / 2
            val arcSize = Size(size.width - stroke.width, size.height - stroke.width)
            drawArc(cm.border, -90f, 360f, false, Offset(inset, inset), arcSize, style = stroke)
            drawArc(color, -90f, 360f * remainPct.coerceIn(0f, 1f), false, Offset(inset, inset), arcSize, style = stroke)
        }
        Text("${(remainPct * 100).toInt()}%", fontSize = 12.sp, fontWeight = FontWeight.SemiBold, color = cm.ink)
    }
}

@Composable
fun HeatCells(values: List<Pair<String, Double>>, columns: Int, showLabel: Boolean) {
    val cm = CmColorsCurrent
    val max = values.maxOfOrNull { it.second }?.coerceAtLeast(1.0) ?: 1.0
    val rows = (values.size + columns - 1) / columns
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        repeat(rows) { r ->
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                repeat(columns) { c ->
                    val i = r * columns + c
                    if (i >= values.size) {
                        Spacer(Modifier.weight(1f).aspectRatio(1f))
                    } else {
                        val lv = hmLevel(values[i].second, max)
                        Box(
                            Modifier
                                .weight(1f)
                                .aspectRatio(1f)
                                .clip(RoundedCornerShape(6.dp))
                                .background(cm.hm[min(lv, cm.hm.lastIndex)]),
                            contentAlignment = Alignment.Center,
                        ) {
                            if (showLabel) {
                                val fg = if (lv >= 4) Color.White else cm.ink
                                Text(values[i].first, fontSize = 10.sp, color = fg)
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
fun MatrixGrid(
    rows: List<String>,
    cols: List<String>,
    valueAt: (String, String) -> Double,
    modifier: Modifier = Modifier,
) {
    val cm = CmColorsCurrent
    val max = rows.maxOfOrNull { r -> cols.maxOfOrNull { c -> valueAt(r, c) } ?: 0.0 }?.coerceAtLeast(1.0) ?: 1.0
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
                            .background(cm.hm[min(lv, cm.hm.lastIndex)]),
                    )
                }
            }
        }
    }
}
