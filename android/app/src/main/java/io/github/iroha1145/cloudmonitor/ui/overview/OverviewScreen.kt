package io.github.iroha1145.cloudmonitor.ui.overview

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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.github.iroha1145.cloudmonitor.data.Format
import io.github.iroha1145.cloudmonitor.data.OTHER_COLOR
import io.github.iroha1145.cloudmonitor.data.Overview
import io.github.iroha1145.cloudmonitor.data.ProviderCard
import io.github.iroha1145.cloudmonitor.data.clientBreakdown
import io.github.iroha1145.cloudmonitor.data.componentBreakdown
import io.github.iroha1145.cloudmonitor.data.deviceOnline
import io.github.iroha1145.cloudmonitor.data.period
import io.github.iroha1145.cloudmonitor.data.rankedNames
import io.github.iroha1145.cloudmonitor.data.trendRows
import io.github.iroha1145.cloudmonitor.ui.components.ClientLogo
import io.github.iroha1145.cloudmonitor.ui.components.CompactNumber
import io.github.iroha1145.cloudmonitor.ui.components.DonutChart
import io.github.iroha1145.cloudmonitor.ui.components.EmptyHint
import io.github.iroha1145.cloudmonitor.ui.components.MatrixGrid
import io.github.iroha1145.cloudmonitor.ui.components.MixBar
import io.github.iroha1145.cloudmonitor.ui.components.Panel
import io.github.iroha1145.cloudmonitor.ui.components.PanelHead
import io.github.iroha1145.cloudmonitor.ui.components.PeriodSeg
import io.github.iroha1145.cloudmonitor.ui.components.StackedTrendChart
import io.github.iroha1145.cloudmonitor.ui.components.StatusDot
import io.github.iroha1145.cloudmonitor.ui.theme.CmColorsCurrent
import io.github.iroha1145.cloudmonitor.vm.Period
import io.github.iroha1145.cloudmonitor.vm.UiState

@Composable
fun OverviewBody(state: UiState, onModelPeriod: (Period) -> Unit, onClientPeriod: (Period) -> Unit, onMxPeriod: (Period) -> Unit, onMxCost: (Boolean) -> Unit) {
    val ov = state.overview ?: return
    val cm = CmColorsCurrent
    val modelColors = io.github.iroha1145.cloudmonitor.data.assignColors(rankedNames(ov.totals.allTime.models.ifEmpty { ov.totals.today.models }))
    val clientColors = io.github.iroha1145.cloudmonitor.data.assignColors(rankedNames(ov.totals.allTime.clients.ifEmpty { ov.totals.today.clients }))

    KpiBlock(ov)
    if (state.providers.isNotEmpty()) {
        Spacer(Modifier.height(12.dp))
        ProviderPanel(state.providers)
    }
    Spacer(Modifier.height(12.dp))
    val rows = trendRows(ov)
    Panel {
        PanelHead("近 30 天趋势", "每日 token 合计")
        Spacer(Modifier.height(12.dp))
        if (rows.none { it.total > 0 }) EmptyHint("暂无趋势数据")
        else {
            val top = rankedNames(rows.fold(mutableMapOf<String, Double>()) { acc, r ->
                r.models.forEach { (k, v) -> acc[k] = (acc[k] ?: 0.0) + v }
                acc
            }).take(8)
            StackedTrendChart(rows, modelColors, top)
        }
    }
    Spacer(Modifier.height(12.dp))
    Panel {
        PanelHead("模型分布", "按 token 占比", trailing = { PeriodSeg(state.modelPeriod, onModelPeriod) })
        Spacer(Modifier.height(12.dp))
        val per = ov.totals.period(state.modelPeriod.key)
        val slices = rankedNames(per.models).map { it to (per.models[it] ?: 0.0) }
        if (slices.isEmpty()) EmptyHint("该周期暂无模型数据")
        else DonutChart(slices, modelColors, per.totalTokens)
    }
    Spacer(Modifier.height(12.dp))
    Panel {
        PanelHead("客户端分布", "条内为真实构成分段", trailing = { PeriodSeg(state.clientPeriod, onClientPeriod) })
        Spacer(Modifier.height(12.dp))
        val per = ov.totals.period(state.clientPeriod.key)
        val names = rankedNames(per.clients)
        if (names.isEmpty()) EmptyHint("该周期暂无客户端数据")
        else {
            val max = names.maxOf { per.clients[it] ?: 0.0 }.coerceAtLeast(1.0)
            names.forEach { name ->
                val total = per.clients[name] ?: 0.0
                val segs = clientBreakdown(per, name)
                Column(Modifier.padding(vertical = 6.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        ClientLogo(name)
                        Spacer(Modifier.width(8.dp))
                        Text(name, color = cm.ink, fontSize = 13.sp, fontWeight = FontWeight.Medium, modifier = Modifier.weight(1f))
                        Text(Format.fmtCompact(total), color = cm.ink, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                    }
                    Spacer(Modifier.height(6.dp))
                    val parts = if (segs.isNotEmpty()) segs.map { it.color to it.value }
                    else listOf((clientColors[name] ?: OTHER_COLOR) to total)
                    Box(Modifier.fillMaxWidth().clip(RoundedCornerShape(999.dp))) {
                        MixBar(parts, Modifier.fillMaxWidth((total / max).toFloat().coerceIn(0.08f, 1f)), height = 10.dp)
                    }
                }
            }
        }
    }
    val mxPer = ov.totals.period(state.mxPeriod.key)
    val mxClients = rankedNames(mxPer.clients).take(8)
    val mxModels = rankedNames(mxPer.models).take(8)
    if (mxClients.isNotEmpty() && mxModels.isNotEmpty()) {
        Spacer(Modifier.height(12.dp))
        Panel {
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
            MatrixGrid(mxClients, mxModels) { c, m ->
                val tokens = mxPer.clientModels[c]?.get(m) ?: 0.0
                if (state.mxCost) tokens / 1e6 * 6.4 else tokens
            }
        }
    }
    val sessions = ov.sessions.sortedByDescending { Format.parseMillis(it.lastUsedAt) ?: 0L }.take(5)
    if (sessions.isNotEmpty()) {
        Spacer(Modifier.height(12.dp))
        Panel {
            PanelHead("会话明细", "最近使用的 ${sessions.size} 条 · 共 ${ov.sessionsMeta.sessionsTotal.coerceAtLeast(ov.sessions.size)} 条")
            Spacer(Modifier.height(8.dp))
            sessions.forEach { s ->
                Row(
                    Modifier
                        .fillMaxWidth()
                        .padding(vertical = 8.dp)
                        .horizontalScroll(rememberScrollState()),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        ClientLogo(s.client)
                        Spacer(Modifier.width(6.dp))
                        Text(s.client ?: "—", color = cm.ink, fontSize = 13.sp, fontWeight = FontWeight.Medium)
                    }
                    Text((s.sessionId ?: "—").take(12), color = cm.mute, fontSize = 12.sp, fontFamily = FontFamily.Monospace)
                    Text(s.models.keys.firstOrNull() ?: "—", color = cm.ink2, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(Format.fmtCompact(s.tokens), color = cm.ink, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                    Text(Format.fmtUsd(s.costUsd), color = cm.mute, fontSize = 12.sp)
                }
            }
        }
    }
}

@Composable
private fun KpiBlock(ov: Overview) {
    val cm = CmColorsCurrent
    val today = ov.totals.today
    val month = ov.totals.month
    val all = ov.totals.allTime
    val (known, segs) = componentBreakdown(today)
    val onlineStates = ov.devices.map { deviceOnline(it, ov) }
    val online = onlineStates.count { it == true }
    val unknown = onlineStates.count { it == null }
    val seen = ov.devices.mapNotNull { Format.parseMillis(it.receivedAt) }.maxOrNull()

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
        if (segs.isNotEmpty()) MixBar(segs.map { it.color to it.value }, Modifier.fillMaxWidth(), height = 10.dp)
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
        Spacer(Modifier.height(10.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            StatusDot(online > 0, unknown = online == 0 && unknown == ov.devices.size)
            Spacer(Modifier.width(8.dp))
            Text(if (online > 0) "在线" else if (onlineStates.any { it == false }) "离线" else "状态未知", color = cm.ink, fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.width(10.dp))
            Text(
                if (seen != null) "${if (online > 0) "最近上报" else "最后上报"} ${Format.relTime(ov.devices.maxByOrNull { Format.parseMillis(it.receivedAt) ?: 0L }?.receivedAt)}"
                else "暂无设备上报",
                color = cm.mute,
                fontSize = 12.sp,
            )
        }
        Spacer(Modifier.height(6.dp))
        Text("在线设备 $online / ${ov.devices.size} 台" + if (unknown > 0) "（${unknown} 台状态未知）" else "", color = cm.mute, fontSize = 12.sp)
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
private fun ProviderPanel(providers: List<ProviderCard>) {
    val cm = CmColorsCurrent
    Panel {
        PanelHead("提供商状态", "今日有上报的提供商 · 来自各官方公开状态页")
        Spacer(Modifier.height(10.dp))
        providers.forEach { p ->
            Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                ClientLogo(p.provider)
                Spacer(Modifier.width(10.dp))
                Column(Modifier.weight(1f)) {
                    Text(p.name.ifBlank { Format.fmtProvider(p.provider) }, color = cm.ink, fontWeight = FontWeight.Medium)
                    Text(p.description?.ifBlank { p.status } ?: p.status, color = cm.mute, fontSize = 12.sp)
                }
                val ok = p.status == "operational" && p.errorCode == null
                Box(
                    Modifier
                        .clip(RoundedCornerShape(999.dp))
                        .background(if (ok) cm.okBg else cm.warnBg)
                        .padding(horizontal = 8.dp, vertical = 3.dp),
                ) {
                    Text(if (ok) "正常" else p.status, color = if (ok) cm.okInk else cm.warnInk, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
                }
            }
        }
    }
}
