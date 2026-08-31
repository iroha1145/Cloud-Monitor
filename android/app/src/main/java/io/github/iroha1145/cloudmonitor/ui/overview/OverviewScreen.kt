package io.github.iroha1145.cloudmonitor.ui.overview

import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.github.iroha1145.cloudmonitor.data.Format
import io.github.iroha1145.cloudmonitor.data.Overview
import io.github.iroha1145.cloudmonitor.data.ProviderCard
import io.github.iroha1145.cloudmonitor.data.SEG_CACHE_READ
import io.github.iroha1145.cloudmonitor.data.cacheHitRate
import io.github.iroha1145.cloudmonitor.data.clientBreakdown
import io.github.iroha1145.cloudmonitor.data.componentBreakdown
import io.github.iroha1145.cloudmonitor.data.componentsComplete
import io.github.iroha1145.cloudmonitor.data.connBanner
import io.github.iroha1145.cloudmonitor.data.deviceOnline
import io.github.iroha1145.cloudmonitor.data.matrixAxes
import io.github.iroha1145.cloudmonitor.data.period
import io.github.iroha1145.cloudmonitor.data.rankedNames
import io.github.iroha1145.cloudmonitor.data.sessionsDetailsIncomplete
import io.github.iroha1145.cloudmonitor.data.trendRows
import io.github.iroha1145.cloudmonitor.ui.AppIcons
import io.github.iroha1145.cloudmonitor.ui.openHttpUrl
import io.github.iroha1145.cloudmonitor.ui.components.ClientLogo
import io.github.iroha1145.cloudmonitor.ui.components.CompactNumber
import io.github.iroha1145.cloudmonitor.ui.components.ConnFlowTrack
import io.github.iroha1145.cloudmonitor.ui.components.DonutChart
import io.github.iroha1145.cloudmonitor.ui.components.EmptyHint
import io.github.iroha1145.cloudmonitor.ui.components.MatrixGrid
import io.github.iroha1145.cloudmonitor.ui.components.MixBar
import io.github.iroha1145.cloudmonitor.ui.components.Panel
import io.github.iroha1145.cloudmonitor.ui.components.PanelHead
import io.github.iroha1145.cloudmonitor.ui.components.PeriodSeg
import io.github.iroha1145.cloudmonitor.ui.components.StackedTrendChart
import io.github.iroha1145.cloudmonitor.ui.components.StatusDot
import io.github.iroha1145.cloudmonitor.ui.components.tipClick
import io.github.iroha1145.cloudmonitor.ui.theme.CmColorsCurrent
import io.github.iroha1145.cloudmonitor.ui.theme.riseIn
import io.github.iroha1145.cloudmonitor.vm.AuxStatus
import io.github.iroha1145.cloudmonitor.vm.Period
import io.github.iroha1145.cloudmonitor.vm.UiState

fun LazyListScope.overviewItems(
    state: UiState,
    modelColors: Map<String, Color>,
    onModelPeriod: (Period) -> Unit,
    onClientPeriod: (Period) -> Unit,
    onMxPeriod: (Period) -> Unit,
    onMxCost: (Boolean) -> Unit,
) {
    val ov = state.overview ?: return

    item("kpi") {
        Column(Modifier.padding(bottom = 12.dp).riseIn(0)) { KpiBlock(ov, state.demo, state.staleData) }
    }
    when (state.providersStatus) {
        AuxStatus.Unsupported, AuxStatus.Empty, AuxStatus.Idle -> Unit
        AuxStatus.Error -> item("providers") {
            Box(Modifier.padding(bottom = 12.dp).riseIn(1)) {
                Panel { Text("状态页暂不可用", color = CmColorsCurrent.crit, fontSize = 13.sp) }
            }
        }
        AuxStatus.Loading, AuxStatus.Ready -> if (state.providers.isNotEmpty() || state.providersPartial) {
            item("providers") {
                Box(Modifier.padding(bottom = 12.dp).riseIn(1)) {
                    ProviderPanel(state.providers, state.providersPartial, state.providersPartialErrors)
                }
            }
        }
    }
    val rows = trendRows(ov)
    item("trend") {
        Panel(Modifier.padding(bottom = 12.dp).riseIn(2)) {
            PanelHead("近 30 天趋势", "每日 token 合计")
            Spacer(Modifier.height(12.dp))
            if (rows.none { it.total > 0 }) EmptyHint("暂无趋势数据")
            else {
                val top = rankedNames(rows.fold(mutableMapOf<String, Double>()) { acc, r ->
                    r.models.forEach { (k, v) -> acc[k] = (acc[k] ?: 0.0) + v }
                    acc
                }).take(8)
                StackedTrendChart(rows, modelColors, top)
                var table by remember { mutableStateOf(false) }
                TextButton(onClick = { table = !table }) {
                    Text(if (table) "收起数据表" else "查看数据表", fontSize = 12.sp)
                }
                if (table) {
                    // 对齐网页数据表：完整 30 天 · 精确整数
                    Column(Modifier.animateContentSize(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        rows.asReversed().forEach { r ->
                            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                                Text(r.day, color = CmColorsCurrent.mute, fontSize = 12.sp)
                                Text(Format.fmtInt(r.total), color = CmColorsCurrent.ink, fontSize = 12.sp, fontWeight = FontWeight.Medium)
                            }
                        }
                    }
                }
            }
        }
    }
    item("models") {
        Panel(Modifier.padding(bottom = 12.dp).riseIn(3)) {
            PanelHead("模型分布", "按 token 占比", trailing = { PeriodSeg(state.modelPeriod, onModelPeriod) })
            Spacer(Modifier.height(12.dp))
            val per = ov.totals.period(state.modelPeriod.key)
            val slices = rankedNames(per.models).map { it to (per.models[it] ?: 0.0) }
            if (slices.isEmpty()) EmptyHint("该周期暂无模型数据")
            else {
                val rates = slices.associate { (name, _) -> name to cacheHitRate(per, name) }
                DonutChart(
                    slices,
                    modelColors,
                    per.totalTokens,
                    centerSub = "${state.modelPeriod.label} tokens",
                    costs = per.modelCosts,
                    cacheRates = rates,
                )
            }
        }
    }
    item("clients") {
        val cm = CmColorsCurrent
        Panel(Modifier.padding(bottom = 12.dp).riseIn(4)) {
            val per = ov.totals.period(state.clientPeriod.key)
            val names = rankedNames(per.clients)
            val anyKnown = names.any { clientBreakdown(per, it).isNotEmpty() }
            val sub = when {
                anyKnown -> "条内为真实构成分段"
                per.capabilities.tokenComponents -> "构成来源未知，显示总量"
                else -> "后端未提供真实构成"
            }
            PanelHead("客户端分布", sub, trailing = { PeriodSeg(state.clientPeriod, onClientPeriod) })
            Spacer(Modifier.height(12.dp))
            if (names.isEmpty()) EmptyHint("该周期暂无客户端数据")
            else {
                val max = names.maxOf { per.clients[it] ?: 0.0 }.coerceAtLeast(1.0)
                names.forEach { name ->
                    val total = per.clients[name] ?: 0.0
                    val segs = clientBreakdown(per, name)
                    val cost = per.clientCosts[name]
                    Column(
                        Modifier
                            .padding(vertical = 6.dp)
                            .tipClick(
                                name,
                                listOf(
                                    "tokens" to Format.fmtCompact(total),
                                    "费用" to (cost?.let { Format.fmtUsd(it) } ?: "—"),
                                ),
                            ),
                    ) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            ClientLogo(name)
                            Spacer(Modifier.width(8.dp))
                            Text(name, color = cm.ink, fontSize = 13.sp, fontWeight = FontWeight.Medium, modifier = Modifier.weight(1f))
                            Column(horizontalAlignment = Alignment.End) {
                                Text(Format.fmtCompact(total), color = cm.ink, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                                if (cost != null) Text(Format.fmtUsd(cost), color = cm.mute, fontSize = 11.sp)
                            }
                        }
                        Spacer(Modifier.height(6.dp))
                        // 对齐网页：构成未知的客户端条统一用缓存读紫（seg-cacher），不用客户端调色板色
                        val parts = if (segs.isNotEmpty()) segs.map { it.color to it.value }
                        else listOf(SEG_CACHE_READ to total)
                        Box(Modifier.fillMaxWidth().clip(RoundedCornerShape(999.dp))) {
                            MixBar(
                                parts,
                                Modifier.fillMaxWidth((total / max).toFloat().coerceIn(0.08f, 1f)),
                                height = 10.dp,
                                grow = true,
                                growKey = name to state.clientPeriod,
                            )
                        }
                    }
                }
                if (per.capabilities.tokenComponents && names.any { clientBreakdown(per, it).isEmpty() && (per.clients[it] ?: 0.0) > 0 }) {
                    Spacer(Modifier.height(6.dp))
                    Text("部分客户端缺少真实构成，条内显示总量。", color = cm.warnInk, fontSize = 11.sp)
                }
            }
        }
    }
    val mxPer = ov.totals.period(state.mxPeriod.key)
    val tokenAxes = matrixAxes(mxPer.clientModels)
    val costAxes = matrixAxes(mxPer.clientModelCosts)
    val hasTokenMatrix = tokenAxes.first.isNotEmpty() && tokenAxes.second.isNotEmpty()
    val hasCostMatrix = costAxes.first.isNotEmpty() && costAxes.second.isNotEmpty()
    if (hasTokenMatrix || hasCostMatrix) {
        val mxMap = if (state.mxCost) mxPer.clientModelCosts else mxPer.clientModels
        val (mxClients, mxModels) = if (state.mxCost) costAxes else tokenAxes
        item("matrix") {
            val cm = CmColorsCurrent
            Panel(Modifier.padding(bottom = 12.dp).riseIn(5)) {
                PanelHead("工具 × 模型矩阵", "色阶 = ${if (state.mxCost) "费用" else "tokens"}")
                Spacer(Modifier.height(8.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                    PeriodSeg(state.mxPeriod, onMxPeriod)
                    Row(
                        Modifier.clip(RoundedCornerShape(999.dp)).background(cm.brand25).padding(3.dp),
                        horizontalArrangement = Arrangement.spacedBy(2.dp),
                    ) {
                        listOf(false to "Tokens", true to "费用").forEach { (cost, label) ->
                            val on = state.mxCost == cost
                            Text(
                                label,
                                color = if (on) cm.ink else cm.mute,
                                fontSize = 12.sp,
                                fontWeight = if (on) FontWeight.SemiBold else FontWeight.Medium,
                                modifier = Modifier
                                    .clip(RoundedCornerShape(999.dp))
                                    .background(if (on) cm.card else Color.Transparent)
                                    .clickable { onMxCost(cost) }
                                    .padding(horizontal = 10.dp, vertical = 6.dp),
                            )
                        }
                    }
                }
                Spacer(Modifier.height(10.dp))
                if (mxClients.isEmpty() || mxModels.isEmpty()) {
                    EmptyHint(if (state.mxCost) "该周期暂无费用数据" else "该周期暂无矩阵数据")
                } else {
                    MatrixGrid(mxClients, mxModels, cost = state.mxCost) { c, m ->
                        mxMap[c]?.get(m) ?: 0.0
                    }
                }
            }
        }
    }
    val sessions = ov.sessions.sortedByDescending { Format.parseMillis(it.lastUsedAt) ?: 0L }.take(5)
    if (sessions.isNotEmpty()) {
        item("sessions") {
            val cm = CmColorsCurrent
            Panel(Modifier.padding(bottom = 12.dp).riseIn(6)) {
                PanelHead("会话明细", "最近使用的 ${sessions.size} 条 · 共 ${ov.sessionsMeta.sessionsTotal.coerceAtLeast(ov.sessions.size)} 条")
                Spacer(Modifier.height(8.dp))
                sessions.forEach { s ->
                    val start = Format.parseMillis(s.startedAt)
                    val end = Format.parseMillis(s.lastUsedAt)
                    val dur = if (start != null && end != null && end >= start) Format.fmtDuration(end - start) else "—"
                    Column(Modifier.padding(vertical = 8.dp)) {
                        Row(
                            Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(12.dp),
                        ) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                ClientLogo(s.client)
                                Spacer(Modifier.width(6.dp))
                                Text(s.client ?: "—", color = cm.ink, fontSize = 13.sp, fontWeight = FontWeight.Medium)
                            }
                            Text((s.sessionId ?: "—").take(12), color = cm.mute, fontSize = 12.sp, fontFamily = FontFamily.Monospace)
                            // 对齐网页：最多显示 2 个模型，超出以 +N 汇总
                            val modelNames = s.models.keys.toList()
                            val modelText = when {
                                modelNames.isEmpty() -> "—"
                                modelNames.size <= 2 -> modelNames.joinToString("、")
                                else -> modelNames.take(2).joinToString("、") + " +${modelNames.size - 2}"
                            }
                            Text(modelText, color = cm.ink2, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text(Format.fmtCompact(s.tokens), color = cm.ink, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                            Text(Format.fmtUsd(s.costUsd), color = cm.mute, fontSize = 12.sp)
                        }
                        Spacer(Modifier.height(4.dp))
                        Text(
                            listOf(
                                s.project?.ifBlank { null } ?: "—",
                                dur,
                                "最近 ${Format.relTime(s.lastUsedAt)}",
                                s.device ?: "—",
                            ).joinToString("  ·  "),
                            color = cm.mute,
                            fontSize = 11.sp,
                            maxLines = 2,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
                if (sessionsDetailsIncomplete(ov)) {
                    val n = ov.sessionsMeta.sessionsOmittedCount
                    Text(
                        if (n > 0) "另有 $n 条会话明细未完整返回。" else "部分会话明细未完整返回。",
                        color = cm.warnInk,
                        fontSize = 11.sp,
                    )
                }
            }
        }
    }
}

@Composable
private fun KpiBlock(ov: Overview, demo: Boolean, stale: Boolean) {
    val cm = CmColorsCurrent
    val today = ov.totals.today
    val month = ov.totals.month
    val all = ov.totals.allTime
    val (known, segs) = componentBreakdown(today)
    val complete = componentsComplete(today, segs)
    val onlineStates = ov.devices.map { deviceOnline(it, ov) }
    val online = onlineStates.count { it == true }
    val unknown = onlineStates.count { it == null }
    val seen = ov.devices.maxByOrNull { Format.parseMillis(it.receivedAt) ?: 0L }?.receivedAt
    val (banner, bannerOk) = connBanner(ov, demo, stale)

    Panel {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text("今日 Tokens", color = cm.mute, fontSize = 13.sp)
            Text("⚡", fontSize = 14.sp)
        }
        Spacer(Modifier.height(4.dp))
        CompactNumber(today.totalTokens)
        val timed = if (today.timedTokens > 0)
            "计时 ${Format.fmtCompact(today.timedTokens)} tokens" + if (today.timedDurationMs > 0) " / ${Format.fmtTimedMs(today.timedDurationMs)}" else ""
        else "今日暂无计时用量"
        Text(timed, color = cm.mute, fontSize = 12.sp)
        Spacer(Modifier.height(10.dp))
        if (segs.isNotEmpty()) MixBar(segs.map { it.color to it.value }, Modifier.fillMaxWidth(), height = 10.dp, grow = true, growKey = today.totalTokens)
        Spacer(Modifier.height(8.dp))
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            segs.chunked(2).forEach { row ->
                Row(Modifier.fillMaxWidth()) {
                    row.forEach { s ->
                        Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically) {
                            Box(Modifier.padding(end = 6.dp).clip(RoundedCornerShape(99.dp)).background(s.color).padding(4.dp))
                            Text("${s.label}  ", color = cm.mute, fontSize = 11.sp)
                            Text(Format.fmtCompact(s.value), color = cm.ink, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
                        }
                    }
                }
            }
        }
        if (!known && today.totalTokens > 0) {
            Spacer(Modifier.height(6.dp))
            Text("后端未提供精确 Token 组成，未将剩余量猜作非缓存输入。", color = cm.warnInk, fontSize = 11.sp)
        } else if (known && !complete) {
            Spacer(Modifier.height(6.dp))
            Text("Token 组件之和与总量不一致，请以总量为准。", color = cm.warnInk, fontSize = 11.sp)
        }
    }
    Spacer(Modifier.height(12.dp))
    Panel {
        Text("费用概览", color = cm.mute, fontSize = 13.sp)
        Spacer(Modifier.height(4.dp))
        Row(verticalAlignment = Alignment.Bottom) {
            Text(Format.fmtUsd(today.costUsd), color = cm.ink, fontSize = 32.sp, fontWeight = FontWeight.SemiBold)
            Text("  今日", color = cm.mute, fontSize = 13.sp, modifier = Modifier.padding(bottom = 6.dp))
        }
        Spacer(Modifier.height(10.dp))
        KpiRow("本月成本", Format.fmtUsd(month.costUsd))
        KpiRow("本月 Tokens", Format.fmtCompact(month.totalTokens))
        KpiRow("历史累计", Format.fmtCompact(all.totalTokens))
    }
    Spacer(Modifier.height(12.dp))
    Panel {
        Text("连接状态", color = cm.mute, fontSize = 13.sp)
        Spacer(Modifier.height(4.dp))
        Text(banner, color = if (bannerOk) cm.okInk else cm.warnInk, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
        Spacer(Modifier.height(10.dp))
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Icon(AppIcons.Terminal, null, tint = cm.ink2, modifier = Modifier.size(22.dp))
            ConnFlowTrack(online > 0, Modifier.weight(1f))
            Icon(AppIcons.Cloud, null, tint = cm.ink2, modifier = Modifier.size(22.dp))
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text("AGENT", color = cm.mute, fontSize = 9.sp, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace)
            Text("CLOUD", color = cm.mute, fontSize = 9.sp, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace)
        }
        Spacer(Modifier.height(10.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            StatusDot(online > 0, unknown = online == 0 && unknown == ov.devices.size, pulse = online > 0)
            Spacer(Modifier.width(8.dp))
            Text(if (online > 0) "在线" else if (onlineStates.any { it == false }) "离线" else "状态未知", color = cm.ink, fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.width(10.dp))
            Text(
                if (seen != null) "${if (online > 0) "最近上报" else "最后上报"} ${Format.relTime(seen)}"
                else "暂无设备上报",
                color = cm.mute,
                fontSize = 12.sp,
            )
        }
        Spacer(Modifier.height(6.dp))
        Text("在线设备 $online / ${ov.devices.size} 台" + if (unknown > 0) "（${unknown} 台状态未知）" else "", color = cm.mute, fontSize = 12.sp)
        ov.lastSnapshotError?.let {
            Spacer(Modifier.height(4.dp))
            Text("最近快照错误：$it", color = cm.warnInk, fontSize = 11.sp)
        }
    }
}

@Composable
private fun KpiRow(label: String, value: String) {
    val cm = CmColorsCurrent
    Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), horizontalArrangement = Arrangement.SpaceBetween) {
        Text(label, color = cm.mute, fontSize = 13.sp)
        Text(value, color = cm.ink, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
    }
}

@Composable
private fun ProviderPanel(providers: List<ProviderCard>, partial: Boolean, errors: List<String>) {
    val cm = CmColorsCurrent
    val context = LocalContext.current
    Panel {
        PanelHead("提供商状态", "今日有上报的提供商 · 来自各官方公开状态页")
        Spacer(Modifier.height(10.dp))
        if (partial) {
            val extra = errors.map { Format.pvErrorText(it).ifBlank { it } }.filter { it.isNotBlank() }
            Text(
                "部分提供商状态来源暂不可用" + if (extra.isNotEmpty()) "（${extra.joinToString("、")}）" else "",
                color = cm.warnInk,
                fontSize = 12.sp,
                modifier = Modifier.padding(bottom = 8.dp),
            )
        }
        providers.forEach { p ->
            val unavailable = p.status == "unknown" && !p.errorCode.isNullOrBlank()
            // 对齐网页 PV_STATUS 四档语义色：operational=ok / outage=crit / 无错误的 unknown=灰 / 其余=warn
            val level = when {
                unavailable -> "warn"
                p.status == "operational" && p.errorCode == null -> "ok"
                p.status == "outage" || p.status == "partial_outage" || p.status == "major_outage" -> "crit"
                p.status == "unknown" || p.status.isBlank() -> "mute"
                else -> "warn"
            }
            val label = when {
                unavailable -> "状态页暂不可用"
                p.status == "degraded" -> "部分降级"
                p.status == "outage" -> "服务中断"
                p.status == "unknown" || p.status.isBlank() -> "状态未知"
                else -> Format.fmtStatusLabel(p.status)
            }
            val desc = when {
                unavailable -> Format.pvErrorText(p.errorCode).ifBlank { p.errorCode.orEmpty() }
                else -> Format.fmtStatusLine(p.status, p.description)
            } + if (p.stale) " · 缓存数据" else ""
            val name = Format.pvNameOverride(p.provider, p.name.ifBlank { Format.fmtProvider(p.provider) })
            val url = Format.safeHttpUrl(p.url)
            Row(
                Modifier
                    .fillMaxWidth()
                    .padding(vertical = 8.dp)
                    .then(
                        if (url != null) Modifier.clickable { context.openHttpUrl(url) } else Modifier,
                    ),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                ClientLogo(p.provider)
                Spacer(Modifier.width(10.dp))
                Column(Modifier.weight(1f)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(name, color = cm.ink, fontWeight = FontWeight.Medium)
                        if (url != null) {
                            Spacer(Modifier.width(4.dp))
                            Icon(AppIcons.OpenInNew, "打开状态页", tint = cm.mute, modifier = Modifier.size(14.dp))
                        }
                    }
                    Text(desc, color = cm.mute, fontSize = 12.sp)
                    p.checkedAt?.let { Text("检测于 ${Format.relTime(it)}", color = cm.mute, fontSize = 11.sp) }
                }
                val badgeBg = when (level) {
                    "ok" -> cm.okBg
                    "crit" -> cm.critBg
                    "mute" -> cm.canvas
                    else -> cm.warnBg
                }
                val badgeInk = when (level) {
                    "ok" -> cm.okInk
                    "crit" -> cm.crit
                    "mute" -> cm.mute
                    else -> cm.warnInk
                }
                Box(
                    Modifier
                        .clip(RoundedCornerShape(999.dp))
                        .background(badgeBg)
                        .padding(horizontal = 8.dp, vertical = 3.dp),
                ) {
                    Text(label, color = badgeInk, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
                }
            }
        }
    }
}
