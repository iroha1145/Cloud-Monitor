package io.github.iroha1145.cloudmonitor.ui.models

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.github.iroha1145.cloudmonitor.data.*
import io.github.iroha1145.cloudmonitor.ui.components.*
import io.github.iroha1145.cloudmonitor.ui.PageState
import io.github.iroha1145.cloudmonitor.ui.theme.CmColorsCurrent
import io.github.iroha1145.cloudmonitor.vm.Period
import io.github.iroha1145.cloudmonitor.vm.UiState

fun LazyListScope.modelsItems(
    state: UiState,
    colors: Map<String, Color>,
    onPeriod: (Period) -> Unit,
    onMatrixPeriod: (Period) -> Unit,
    onMatrixCost: (Boolean) -> Unit,
    page: PageState,
) {
    val ov = state.overview ?: return
    val per = ov.totals.period(state.modelPeriod.key)
    item("model-analysis") {
        var query by page.query
        var sortCost by page.sortCost
        val allModels = remember(per) { modelUsage(per) }
        val visible = remember(allModels, query, sortCost) {
            allModels.filter { it.name.contains(query.trim(), ignoreCase = true) }
                .sortedByDescending { if (sortCost) it.costUsd ?: -1.0 else it.totalTokens }
        }
        val cm = CmColorsCurrent
        Panel(Modifier.padding(bottom = 16.dp)) {
            PanelHead("模型用量", "了解每个模型的消耗与缓存情况", trailing = { PeriodSeg(state.modelPeriod, onPeriod) })
            Spacer(Modifier.height(14.dp))
            if (LocalDensity.current.fontScale > 1.5f) {
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    ModelMetric("模型数量", allModels.size.toString(), summary = true)
                    ModelMetric("模型已归类用量", Format.fmtCompact(allModels.sumOf { it.totalTokens }), summary = true)
                }
            } else {
                Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                    ModelMetric("模型数量", allModels.size.toString(), Modifier.weight(1f), summary = true)
                    ModelMetric("模型已归类用量", Format.fmtCompact(allModels.sumOf { it.totalTokens }), Modifier.weight(1f), summary = true)
                }
            }
            Spacer(Modifier.height(14.dp))
            WebSearchField(value = query, onValueChange = { query = it }, label = "搜索模型", placeholder = "搜索模型…",
                modifier = Modifier.fillMaxWidth().testTag("model-search"))
            WebSegmentedControl(listOf("按用量", "按费用"), if (sortCost) 1 else 0, { sortCost = it == 1 })
            if (visible.isEmpty()) EmptyHint(if (query.isBlank()) "该周期暂无模型用量" else "没有匹配的模型")
            visible.forEachIndexed { index, entry ->
                val segments = modelBreakdown(per, entry.id)
                val data = entry.components
                Column(Modifier.fillMaxWidth().tipClick(entry.name, listOf(
                    "词元用量" to Format.fmtInt(entry.totalTokens),
                    "费用" to (entry.costUsd?.let(Format::fmtUsd) ?: "未提供"),
                    data.cacheLabel to (data.cacheRate?.let(Format::fmtPct) ?: "未提供"),
                    "构成明细" to if (!data.known) "未提供" else if (data.partial || !data.complete) "部分明细" else "完整",
                ) + segments.map { it.label to Format.fmtInt(it.value) }).padding(vertical = 17.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        Box(Modifier.size(9.dp).clip(CircleShape).background(colors[entry.id] ?: cm.brand))
                        Text(entry.name, Modifier.weight(1f), color = cm.ink, fontSize = 13.sp, lineHeight = 18.sp, fontWeight = FontWeight.SemiBold)
                    }
                    Spacer(Modifier.height(12.dp))
                    val metrics = listOf(
                        "词元用量" to Format.fmtCompact(entry.totalTokens),
                        "估算费用" to (entry.costUsd?.let(Format::fmtUsd) ?: "未提供"),
                        "缓存读取" to if (data.cacheReadKnown) Format.fmtCompact(data.cacheRead) else "未提供",
                        data.cacheLabel to (data.cacheRate?.let(Format::fmtPct) ?: "未提供"),
                    )
                    val columns = if (LocalDensity.current.fontScale > 1.5f) 1 else 2
                    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        metrics.chunked(columns).forEach { row ->
                            Row(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                                row.forEach { (label, value) ->
                                    ModelMetric(label, value, Modifier.weight(1f),
                                        color = if (label == data.cacheLabel && data.cacheRate != null) cm.okInk else cm.ink)
                                }
                            }
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
            WebSegmentedControl(listOf("词元用量", "费用"), if (state.mxCost) 1 else 0, { onMatrixCost(it == 1) })
            if (clients.isEmpty() || models.isEmpty()) EmptyHint("该周期暂无工具与模型明细")
            else MatrixGrid(clients, models, cost = state.mxCost) { client, model -> map[client]?.get(model) ?: 0.0 }
        }
    }
}

@Composable
private fun ModelMetric(label: String, value: String, modifier: Modifier = Modifier, summary: Boolean = false, color: Color = CmColorsCurrent.ink) {
    Column(modifier, verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(label, color = CmColorsCurrent.ink2, fontSize = 11.sp, lineHeight = 15.sp)
        Text(value, color = color, fontSize = if (summary) 21.sp else 14.sp,
            lineHeight = if (summary) 27.sp else 20.sp, fontWeight = FontWeight.SemiBold)
    }
}
