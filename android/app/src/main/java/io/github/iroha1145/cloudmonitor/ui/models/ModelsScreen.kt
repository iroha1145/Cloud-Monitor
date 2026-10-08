package io.github.iroha1145.cloudmonitor.ui.models

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.RoundRect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.clipPath
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.github.iroha1145.cloudmonitor.data.*
import io.github.iroha1145.cloudmonitor.ui.components.*
import io.github.iroha1145.cloudmonitor.ui.PageState
import io.github.iroha1145.cloudmonitor.ui.theme.CmColorsCurrent
import io.github.iroha1145.cloudmonitor.vm.ModelsPage
import io.github.iroha1145.cloudmonitor.vm.Period

private enum class PanelBand { Top, Mid, Bottom, Only }

fun LazyListScope.modelsItems(
    state: ModelsPage,
    colors: Map<String, Color>,
    onPeriod: (Period) -> Unit,
    onMatrixPeriod: (Period) -> Unit,
    onMatrixCost: (Boolean) -> Unit,
    onOpenModel: (UsageEntity) -> Unit,
    page: PageState,
) {
    val ov = state.overview ?: return
    val per = ov.totals.period(state.modelPeriod.key)
    val allModels = modelUsage(per)
    val providers = listOf("全部") + allModels.map { it.provider }.filter { it.isNotBlank() }.distinct()
    val provider = page.modelProvider.value.takeIf { it in providers } ?: "全部"
    val sortMode = page.modelSort.intValue
    val query = page.query.value
    val visible = allModels.filter {
        it.name.contains(query.trim(), ignoreCase = true) && (provider == "全部" || it.provider == provider)
    }.sortedByDescending {
        when (sortMode) {
            1 -> it.components.cacheRate ?: -1.0
            2 -> it.costUsd ?: -1.0
            else -> it.totalTokens
        }
    }
    val keys = stableRowKeys(visible.map { it.id }, "model")
    item("model-head") {
        SideEffect {
            if (page.modelProvider.value !in providers) page.modelProvider.value = "全部"
        }
        ModelAnalysisHead(
            state = state,
            per = per,
            allModels = allModels,
            providers = providers,
            provider = provider,
            sortMode = sortMode,
            query = query,
            showEmpty = visible.isEmpty(),
            onPeriod = onPeriod,
            page = page,
            band = if (visible.isEmpty()) PanelBand.Only else PanelBand.Top,
        )
        if (visible.isEmpty()) Spacer(Modifier.height(16.dp))
    }
    items(visible.size, key = { keys[it] }) { index ->
        val entry = visible[index]
        ModelUsageRow(
            entry = entry,
            per = per,
            color = colors[entry.id],
            last = index == visible.lastIndex,
            onOpen = { onOpenModel(entry) },
        )
    }
    if (visible.isNotEmpty()) item("model-tail") {
        Box(Modifier.panelBand(PanelBand.Bottom).fillMaxWidth().height(16.dp))
        Spacer(Modifier.height(16.dp))
    }
    val matrixPer = ov.totals.period(state.mxPeriod.key)
    val map = if (state.mxCost) matrixPer.clientModelCosts else matrixPer.clientModels
    val (clients, models) = matrixAxes(map)
    item("model-matrix") {
        Panel(Modifier.padding(bottom = 16.dp)) {
            PanelHead("客户端 × 模型", "每个客户端用了哪些模型", trailing = { PeriodSeg(state.mxPeriod, onMatrixPeriod) })
            WebSegmentedControl(listOf("词元用量", "费用"), if (state.mxCost) 1 else 0, { onMatrixCost(it == 1) })
            if (clients.isEmpty() || models.isEmpty()) EmptyHint("该周期暂无工具与模型明细")
            else MatrixGrid(clients, models, cost = state.mxCost) { client, model -> map[client]?.get(model) ?: 0.0 }
        }
    }
}

@Composable
private fun ModelAnalysisHead(
    state: ModelsPage,
    per: PeriodTotals,
    allModels: List<UsageEntity>,
    providers: List<String>,
    provider: String,
    sortMode: Int,
    query: String,
    showEmpty: Boolean,
    onPeriod: (Period) -> Unit,
    page: PageState,
    band: PanelBand,
) {
    Column(
        Modifier.panelBand(band).padding(horizontal = 16.dp).padding(
            top = 16.dp,
            bottom = if (band == PanelBand.Only) 16.dp else 0.dp,
        ),
    ) {
        Row(Modifier.fillMaxWidth().padding(bottom = 12.dp), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            PeriodSeg(state.modelPeriod, onPeriod)
            ExportModelsButton(per, state.modelPeriod.label)
        }
        PanelHead("模型用量", "按总用量排序，展开查看每个模型的组成")
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
        WebSearchField(
            value = query,
            onValueChange = { page.query.value = it },
            label = "搜索模型",
            placeholder = "搜索模型名称…",
            modifier = Modifier.fillMaxWidth().testTag("model-search"),
        )
        WebSegmentedControl(providers, providers.indexOf(provider).coerceAtLeast(0), { page.modelProvider.value = providers[it] })
        WebSegmentedControl(listOf("按总用量", "按缓存占比", "按费用"), sortMode, { page.modelSort.intValue = it })
        if (showEmpty) EmptyHint(if (query.isBlank()) "该周期暂无模型用量" else "没有匹配的模型")
    }
}

@Composable
private fun ModelUsageRow(
    entry: UsageEntity,
    per: PeriodTotals,
    color: Color?,
    last: Boolean,
    onOpen: () -> Unit,
) {
    val cm = CmColorsCurrent
    val segments = modelBreakdown(per, entry.id)
    val data = entry.components
    val cacheValue = data.cacheRate?.let(Format::fmtPct) ?: "未提供"
    val tipRows = buildList {
        add("词元用量" to Format.fmtInt(entry.totalTokens))
        add("费用" to (entry.costUsd?.let(Format::fmtUsd) ?: "未提供"))
        add(data.cacheLabel to cacheValue)
        add("构成明细" to if (!data.known) "未提供" else if (data.partial || !data.complete) "部分明细" else "完整")
        if (data.known && !data.complete) add("说明" to "组成与总量不一致，暂不计算比例。")
        addAll(segments.map { it.label to Format.fmtInt(it.value) })
    }
    Column(Modifier.panelBand(PanelBand.Mid).padding(horizontal = 16.dp)) {
        Column(Modifier.fillMaxWidth().tipClick(entry.name, tipRows).padding(vertical = 17.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Box(Modifier.size(9.dp).clip(CircleShape).background(color ?: cm.brand))
                Column(Modifier.weight(1f)) {
                    Text(entry.name, color = cm.ink, fontSize = 13.sp, lineHeight = 18.sp, fontWeight = FontWeight.Medium)
                    Text(entry.provider, color = cm.mute, fontSize = 11.sp)
                }
            }
            Spacer(Modifier.height(12.dp))
            val readValue = if (data.cacheReadKnown) Format.fmtCompact(data.cacheRead) else "未提供"
            val wide = LocalDensity.current.fontScale <= 1.5f
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                if (wide) {
                    Row(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                        ModelMetric("词元用量", Format.fmtCompact(entry.totalTokens), Modifier.weight(1f))
                        ModelMetric("估算费用", entry.costUsd?.let(Format::fmtUsd) ?: "未提供", Modifier.weight(1f))
                    }
                    Row(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                        ModelMetric("缓存读取", readValue, Modifier.weight(1f))
                        CacheRateMetric(data, cacheValue, segments, Modifier.weight(1f))
                    }
                } else {
                    ModelMetric("词元用量", Format.fmtCompact(entry.totalTokens))
                    ModelMetric("估算费用", entry.costUsd?.let(Format::fmtUsd) ?: "未提供")
                    ModelMetric("缓存读取", readValue)
                    CacheRateMetric(data, cacheValue, segments, Modifier.fillMaxWidth())
                }
            }
            TextButton(onClick = onOpen, modifier = Modifier.heightIn(min = 48.dp)) { Text("用量组成", fontSize = 12.sp) }
            Spacer(Modifier.height(8.dp))
            ComponentLegend(segments)
        }
        if (!last) HorizontalDivider(color = cm.border)
    }
}

@Composable
private fun Modifier.panelBand(band: PanelBand): Modifier {
    val card = CmColorsCurrent.card
    val line = CmColorsCurrent.border
    return drawBehind {
    val stroke = 1.dp.toPx()
    val radius = 16.dp.toPx()
    val half = stroke / 2f
    val top = band == PanelBand.Top || band == PanelBand.Only
    val bottom = band == PanelBand.Bottom || band == PanelBand.Only
    val path = Path().apply {
        val rect = Rect(0f, 0f, size.width, size.height)
        val corner = CornerRadius(radius, radius)
        val none = CornerRadius.Zero
        addRoundRect(RoundRect(
            rect,
            topLeft = if (top) corner else none,
            topRight = if (top) corner else none,
            bottomRight = if (bottom) corner else none,
            bottomLeft = if (bottom) corner else none,
        ))
    }
    clipPath(path) { drawRect(card) }
    val topInset = if (top) radius else -half
    val bottomInset = if (bottom) radius else -half
    drawLine(line, Offset(half, topInset), Offset(half, size.height - bottomInset), stroke)
    drawLine(line, Offset(size.width - half, topInset), Offset(size.width - half, size.height - bottomInset), stroke)
    if (top) {
        drawLine(line, Offset(radius, half), Offset(size.width - radius, half), stroke)
        val arc = Size(radius * 2, radius * 2)
        drawArc(line, 180f, 90f, false, Offset(0f, 0f), arc, style = Stroke(stroke))
        drawArc(line, 270f, 90f, false, Offset(size.width - radius * 2, 0f), arc, style = Stroke(stroke))
    }
    if (bottom) {
        drawLine(line, Offset(radius, size.height - half), Offset(size.width - radius, size.height - half), stroke)
        val arc = Size(radius * 2, radius * 2)
        drawArc(line, 90f, 90f, false, Offset(0f, size.height - radius * 2), arc, style = Stroke(stroke))
        drawArc(line, 0f, 90f, false, Offset(size.width - radius * 2, size.height - radius * 2), arc, style = Stroke(stroke))
    }
    }
}

private fun stableRowKeys(ids: List<String>, prefix: String): List<String> {
    val seen = HashMap<String, Int>()
    return ids.map { id ->
        val base = "$prefix:${id.ifBlank { "blank" }}"
        val count = (seen[base] ?: 0) + 1
        seen[base] = count
        if (count == 1) base else "$base#$count"
    }
}

@Composable
private fun ModelMetric(label: String, value: String, modifier: Modifier = Modifier, summary: Boolean = false, color: Color = CmColorsCurrent.ink) {
    Column(modifier, verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(label, color = CmColorsCurrent.ink2, fontSize = 11.sp, lineHeight = 15.sp)
        Text(value, color = color, fontSize = if (summary) 21.sp else 14.sp,
            lineHeight = if (summary) 27.sp else 20.sp, fontWeight = FontWeight.Medium)
    }
}

/** Bar, percentage, then the partial caption, in the same order as the web cache cell. */
@Composable
private fun CacheRateMetric(
    data: io.github.iroha1145.cloudmonitor.data.UsageComponents,
    value: String,
    segments: List<io.github.iroha1145.cloudmonitor.data.TokenSeg>,
    modifier: Modifier = Modifier,
) {
    val cm = CmColorsCurrent
    Column(modifier, verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text("缓存占比", color = cm.ink2, fontSize = 11.sp, lineHeight = 15.sp)
        if (data.complete) {
            MixBar(if (segments.isEmpty()) listOf(SEG_UNCLS to 1.0) else segments.map { it.color to it.value }, Modifier.fillMaxWidth(), height = 10.dp)
        } else {
            IncompleteTrack(Modifier.fillMaxWidth())
        }
        Text(value, color = if (data.cacheRate != null) cm.okInk else cm.ink, fontSize = 14.sp, lineHeight = 20.sp, fontWeight = FontWeight.Medium)
        if (data.partial) {
            Text(if (data.cacheReadKnown) "已识别部分" else "组成未知", color = cm.mute, fontSize = 11.sp, lineHeight = 16.sp)
        }
    }
}
