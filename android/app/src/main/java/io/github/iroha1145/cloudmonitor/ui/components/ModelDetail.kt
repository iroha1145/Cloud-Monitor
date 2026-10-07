package io.github.iroha1145.cloudmonitor.ui.components

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import io.github.iroha1145.cloudmonitor.data.Format
import io.github.iroha1145.cloudmonitor.data.PeriodTotals
import io.github.iroha1145.cloudmonitor.data.UsageEntity
import io.github.iroha1145.cloudmonitor.data.componentSegments
import io.github.iroha1145.cloudmonitor.data.modelUsage
import io.github.iroha1145.cloudmonitor.data.modelsCsv
import io.github.iroha1145.cloudmonitor.ui.theme.CmColorsCurrent
import io.github.iroha1145.cloudmonitor.ui.theme.EaseSmoothOut
import io.github.iroha1145.cloudmonitor.ui.theme.LocalReducedMotion
import io.github.iroha1145.cloudmonitor.ui.theme.Motion
import io.github.iroha1145.cloudmonitor.ui.theme.modalEnter
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

@Composable
fun ExportModelsButton(period: PeriodTotals, periodLabel: String, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val cm = CmColorsCurrent
    val scope = rememberCoroutineScope()
    var status by remember { mutableStateOf("") }
    val models = remember(period, periodLabel) { modelUsage(period) }
    val latest by rememberUpdatedState(models to periodLabel)
    val export = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("text/csv")) { uri ->
        if (uri == null) return@rememberLauncherForActivityResult
        val (rows, label) = latest
        scope.launch {
            val result = withContext(Dispatchers.IO) {
                runCatching {
                    val stream = context.contentResolver.openOutputStream(uri) ?: error("文件无法写入")
                    stream.bufferedWriter(Charsets.UTF_8).use { it.write(modelsCsv(label, rows)) }
                }
            }
            status = if (result.isSuccess) "模型用量表已导出。" else "导出失败，请重试"
        }
    }
    Column(modifier) {
        TextButton(onClick = { export.launch("cloud-monitor-models.csv") }, enabled = models.isNotEmpty(), modifier = Modifier.heightIn(min = 44.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(7.dp),
                modifier = Modifier.border(1.dp, cm.border, RoundedCornerShape(999.dp)).padding(horizontal = 14.dp, vertical = 8.dp)) {
                Icon(io.github.iroha1145.cloudmonitor.ui.AppIcons.Download, null, Modifier.size(14.dp), tint = cm.mute)
                Text("导出数据", fontSize = 13.sp, fontWeight = FontWeight.Medium, color = cm.ink)
            }
        }
        if (status.isNotEmpty()) Text(status, color = cm.ink2, fontSize = 11.sp)
    }
}

@Composable
fun ModelDetailDialog(model: UsageEntity?, onDismiss: () -> Unit) {
    if (model == null) return
    val cm = CmColorsCurrent
    val segments = componentSegments(model.components)
    val reduced = LocalReducedMotion.current
    val sweep = remember(model.id) { Animatable(if (reduced) 1f else 0f) }
    LaunchedEffect(model.id) {
        if (reduced) sweep.snapTo(1f)
        else {
            sweep.snapTo(0f)
            sweep.animateTo(1f, tween(Motion.VerySlow, easing = EaseSmoothOut))
        }
    }
    Dialog(onDismissRequest = onDismiss) {
        Surface(Modifier.modalEnter(model.id).fillMaxWidth(), shape = RoundedCornerShape(12.dp), color = cm.card) {
            Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(model.name, color = cm.ink, fontSize = 18.sp, fontWeight = FontWeight.SemiBold)
                Text("总用量 ${Format.fmtCompact(model.totalTokens)}", color = cm.ink2, fontSize = 13.sp)
                Text("使用费用 ${model.costUsd?.let(Format::fmtUsd) ?: "未提供"}", color = cm.ink2, fontSize = 13.sp)
                Box(Modifier.size(160.dp).align(Alignment.CenterHorizontally), contentAlignment = Alignment.Center) {
                    Canvas(Modifier.fillMaxWidth().padding(8.dp)) {
                        val stroke = 16.dp.toPx()
                        val total = segments.sumOf { it.value }.coerceAtLeast(1.0)
                        var angle = -90f
                        val budget = 360f * sweep.value
                        if (segments.isEmpty()) {
                            drawArc(cm.border, -90f, budget, false, style = androidx.compose.ui.graphics.drawscope.Stroke(stroke))
                        }
                        segments.forEach { part ->
                            val sweepAngle = (part.value / total * 360).toFloat()
                            val shown = sweepAngle.coerceAtMost((budget - (angle + 90f)).coerceAtLeast(0f))
                            if (shown > 0f) drawArc(part.color, angle, (shown - 2f).coerceAtLeast(0f), false, style = androidx.compose.ui.graphics.drawscope.Stroke(stroke))
                            angle += sweepAngle
                        }
                    }
                    Text(model.components.cacheRate?.let(Format::fmtPct) ?: "未提供", color = cm.ink, fontWeight = FontWeight.SemiBold)
                }
                segments.forEach { part ->
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Box(Modifier.size(8.dp).clip(RoundedCornerShape(2.dp)).background(part.color))
                        Text(part.label, Modifier.weight(1f), color = cm.ink2, fontSize = 12.sp)
                        Text(Format.fmtCompact(part.value), color = cm.ink, fontSize = 12.sp)
                    }
                }
                Text(
                    if (model.components.partial) "部分组成尚未识别，已保留可确认的缓存计数。"
                    else "该模型用量组成完整。缓存占比按缓存读取量除以总用量计算。",
                    color = cm.ink2, fontSize = 12.sp,
                )
                TextButton(onClick = onDismiss, modifier = Modifier.align(Alignment.End)) { Text("关闭") }
            }
        }
    }
}

fun Modifier.modelClick(onClick: () -> Unit): Modifier = clickable(onClick = onClick)
