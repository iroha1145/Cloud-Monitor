package io.github.iroha1145.cloudmonitor.ui.models

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import io.github.iroha1145.cloudmonitor.data.*
import io.github.iroha1145.cloudmonitor.ui.components.*
import io.github.iroha1145.cloudmonitor.ui.theme.CmColorsCurrent
import io.github.iroha1145.cloudmonitor.vm.Period
import io.github.iroha1145.cloudmonitor.vm.UiState

fun LazyListScope.modelsItems(
    state: UiState,
    colors: Map<String, Color>,
    onPeriod: (Period) -> Unit,
    onMatrixPeriod: (Period) -> Unit,
    onMatrixCost: (Boolean) -> Unit,
) {
    val ov = state.overview ?: return
    val per = ov.totals.period(state.modelPeriod.key)
    item("model-analysis") {
        var query by rememberSaveable { mutableStateOf("") }
        var sortCost by rememberSaveable { mutableStateOf(false) }
        val allModels = remember(per) { modelUsage(per) }
        val visible = remember(allModels, query, sortCost) {
            allModels.filter { it.name.contains(query.trim(), ignoreCase = true) }
                .sortedByDescending { if (sortCost) it.costUsd ?: -1.0 else it.totalTokens }
        }
        val cm = CmColorsCurrent
        Panel(Modifier.padding(bottom = 16.dp)) {
            PanelHead("模型用量", "了解每个模型的消耗与缓存情况", trailing = { PeriodSeg(state.modelPeriod, onPeriod) })
            Spacer(Modifier.height(16.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                Metric("模型数量", allModels.size.toString(), Modifier.weight(1f))
                Metric("模型已归类用量", Format.fmtCompact(allModels.sumOf { it.totalTokens }), Modifier.weight(1f))
            }
            Spacer(Modifier.height(16.dp))
            OutlinedTextField(value = query, onValueChange = { query = it }, singleLine = true,
                label = { Text("搜索模型") }, modifier = Modifier.fillMaxWidth().testTag("model-search"))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                FilterChip(selected = !sortCost, onClick = { sortCost = false }, label = { Text("按用量") }, modifier = Modifier.heightIn(min = 48.dp))
                FilterChip(selected = sortCost, onClick = { sortCost = true }, label = { Text("按费用") }, modifier = Modifier.heightIn(min = 48.dp))
            }
            if (visible.isEmpty()) EmptyHint(if (query.isBlank()) "该周期暂无模型用量" else "没有匹配的模型")
            visible.forEachIndexed { index, entry ->
                val segments = modelBreakdown(per, entry.id)
                val data = entry.components
                Column(Modifier.fillMaxWidth().tipClick(entry.name, listOf(
                    "词元用量" to Format.fmtInt(entry.totalTokens),
                    "费用" to (entry.costUsd?.let(Format::fmtUsd) ?: "未提供"),
                    data.cacheLabel to (data.cacheRate?.let(Format::fmtPct) ?: "未提供"),
                    "构成明细" to if (!data.known) "未提供" else if (data.partial || !data.complete) "部分明细" else "完整",
                ) + segments.map { it.label to Format.fmtInt(it.value) }).padding(vertical = 16.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        Box(Modifier.size(9.dp).clip(CircleShape).background(colors[entry.id] ?: cm.brand))
                        Text(entry.name, Modifier.weight(1f), style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
                    }
                    Spacer(Modifier.height(10.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                        Column(Modifier.weight(1f)) {
                            Text(Format.fmtCompact(entry.totalTokens), style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
                            Text(entry.costUsd?.let(Format::fmtUsd) ?: "费用未提供", color = cm.mute, style = MaterialTheme.typography.bodySmall)
                        }
                        Column(Modifier.weight(1f)) {
                            Text(data.cacheRate?.let(Format::fmtPct) ?: "未提供", color = cm.okInk, style = MaterialTheme.typography.titleLarge)
                            Text(data.cacheLabel, color = cm.mute, style = MaterialTheme.typography.bodySmall)
                        }
                    }
                    Spacer(Modifier.height(12.dp))
                    MixBar(if (segments.isEmpty()) listOf(SEG_UNCLS to entry.totalTokens) else segments.map { it.color to it.value }, Modifier.fillMaxWidth())
                    Spacer(Modifier.height(8.dp))
                    ComponentLegend(segments)
                }
                if (index != visible.lastIndex) HorizontalDivider(color = cm.border)
            }
        }
    }
    val matrixPer = ov.totals.period(state.mxPeriod.key)
    val map = if (state.mxCost) matrixPer.clientModelCosts else matrixPer.clientModels
    val (clients, models) = matrixAxes(map)
    item("model-matrix") {
        Panel(Modifier.padding(bottom = 16.dp)) {
            PanelHead("工具与模型", "查看不同工具的模型使用分布", trailing = { PeriodSeg(state.mxPeriod, onMatrixPeriod) })
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                listOf(false to "词元用量", true to "费用").forEach { (cost, label) ->
                    FilterChip(selected = state.mxCost == cost, onClick = { onMatrixCost(cost) }, label = { Text(label) }, modifier = Modifier.heightIn(min = 48.dp))
                }
            }
            if (clients.isEmpty() || models.isEmpty()) EmptyHint("该周期暂无工具与模型明细")
            else MatrixGrid(clients, models, cost = state.mxCost) { client, model -> map[client]?.get(model) ?: 0.0 }
        }
    }
}
