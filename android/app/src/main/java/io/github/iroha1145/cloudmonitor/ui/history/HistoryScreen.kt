package io.github.iroha1145.cloudmonitor.ui.history

import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.github.iroha1145.cloudmonitor.data.Format
import io.github.iroha1145.cloudmonitor.data.HistoryDay
import io.github.iroha1145.cloudmonitor.data.OTHER_COLOR
import io.github.iroha1145.cloudmonitor.data.assignColors
import io.github.iroha1145.cloudmonitor.data.hourlyBuckets
import io.github.iroha1145.cloudmonitor.ui.components.EmptyHint
import io.github.iroha1145.cloudmonitor.ui.components.HeatCells
import io.github.iroha1145.cloudmonitor.ui.components.MixBar
import io.github.iroha1145.cloudmonitor.ui.components.Panel
import io.github.iroha1145.cloudmonitor.ui.components.PanelHead
import io.github.iroha1145.cloudmonitor.ui.components.SparkBars
import io.github.iroha1145.cloudmonitor.ui.theme.CmColorsCurrent
import io.github.iroha1145.cloudmonitor.ui.theme.riseIn
import io.github.iroha1145.cloudmonitor.vm.AuxStatus
import io.github.iroha1145.cloudmonitor.vm.UiState
import java.time.YearMonth
import kotlin.math.abs
import kotlin.math.roundToInt

private val DOW = listOf("日", "一", "二", "三", "四", "五", "六")
private val DOW_MON = listOf("一", "二", "三", "四", "五", "六", "日")

fun LazyListScope.historyItems(state: UiState, onActView: (Int) -> Unit, onMore: () -> Unit) {
    val ov = state.overview ?: return
    val tz = ov.dashboardPeriod?.timeZone ?: ov.dashboardTimeZone
    val today = ov.dashboardPeriod?.today?.key ?: Format.dayKeyTz(System.currentTimeMillis(), tz)
    item("heat") {
        val cm = CmColorsCurrent
        val haptic = LocalHapticFeedback.current
        Panel(Modifier.padding(bottom = 12.dp).riseIn(0).animateContentSize()) {
            PanelHead("活动热力图", "时区 $tz")
            Spacer(Modifier.height(8.dp))
            Row(
                Modifier
                    .clip(RoundedCornerShape(999.dp))
                    .background(cm.brand25)
                    .padding(3.dp)
                    .selectableGroup(),
                horizontalArrangement = Arrangement.spacedBy(2.dp),
            ) {
                listOf("日", "周", "月").forEachIndexed { i, label ->
                    val on = state.actView == i
                    Text(
                        label,
                        color = if (on) cm.ink else cm.mute,
                        fontSize = 12.sp,
                        fontWeight = if (on) FontWeight.SemiBold else FontWeight.Medium,
                        modifier = Modifier
                            .clip(RoundedCornerShape(999.dp))
                            .background(if (on) cm.card else androidx.compose.ui.graphics.Color.Transparent)
                            .selectable(
                                selected = on,
                                role = Role.Tab,
                                onClick = {
                                    haptic.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                                    onActView(i)
                                },
                            )
                            .padding(horizontal = 12.dp, vertical = 6.dp),
                    )
                }
            }
            Spacer(Modifier.height(8.dp))
            val map = ov.activity.daily.associate { it.day to it.total }
            when (state.actView) {
                0 -> {
                    val buckets = hourlyBuckets(ov)
                    val byHour = (0 until 24).map { h ->
                        h.toString() to (buckets.find { it.hour == h }?.total ?: 0.0)
                    }
                    HeatCells(byHour, columns = 6, showLabel = true)
                }
                1 -> {
                    val dow = ((Format.dowOfKey(today) ?: 0) + 6) % 7
                    val monday = Format.keyAdd(today, -dow)
                    val start = Format.keyAdd(monday, -7 * 11)
                    val cells = (0 until 12 * 7).map { i ->
                        val day = Format.keyAdd(start, i)
                        day.takeLast(5) to if (day > today) 0.0 else (map[day] ?: 0.0)
                    }
                    HeatCells(cells, columns = 7, showLabel = false)
                }
                else -> MonthSummary(today, ov.dashboardPeriod?.month?.key, map)
            }
            CoverageBlock(ov)
        }
    }
    val rows = if (state.history.isNotEmpty()) state.history
    else ov.activity.daily.sortedByDescending { it.day }.map {
        HistoryDay(it.day, it.total, perModel = it.models)
    }
    item("archive-head") {
        val cm = CmColorsCurrent
        Panel(Modifier.padding(bottom = 8.dp).riseIn(1)) {
            val sub = buildString {
                when {
                    state.historyFallback -> append("按日期倒序 · 共 ${rows.size} 天 · 保留 ${state.historyRetentionDays} 天（服务端分页接口不可用，显示概览内嵌数据）")
                    state.historyStatus == AuxStatus.Error -> append(state.historyError ?: "日归档加载失败")
                    else -> {
                        append("按日期倒序 · 已加载 ${rows.size} 天 · 保留 ${state.historyRetentionDays} 天")
                        if (state.historyDayBasis == "device-local") append(" · 日口径：设备本地日")
                        if (state.historyMixedTz) append("（设备时区不一致，按各设备本地日聚合）")
                        if (state.historyPartial) append(" · 部分日期数据不完整")
                    }
                }
            }
            PanelHead("日归档", sub)
            if (state.historyStatus == AuxStatus.Error) {
                Spacer(Modifier.height(8.dp))
                Text(state.historyError ?: "日归档暂不可用", color = cm.crit, fontSize = 13.sp)
            }
        }
    }
    if (rows.isEmpty() && state.historyStatus != AuxStatus.Error) {
        item("archive-empty") { Panel { EmptyHint("暂无历史") } }
    }
    items(rows, key = { it.day }) { row ->
        val cm = CmColorsCurrent
        val dow = Format.dowOfKey(row.day)?.let { DOW[it] } ?: ""
        Panel(Modifier.padding(bottom = 8.dp)) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                Text("${row.day} 周$dow" + if (row.day == today) " · 今天" else "", color = cm.ink, fontWeight = FontWeight.Medium)
                Text(Format.fmtCompact(row.tokens), color = cm.ink, fontWeight = FontWeight.SemiBold)
            }
            row.costUsd?.let { Text(Format.fmtUsd(it), color = cm.mute, fontSize = 12.sp) }
            val mix = row.perClient.ifEmpty { row.perModel }
            if (mix.isNotEmpty()) {
                Spacer(Modifier.height(6.dp))
                val colors = assignColors(mix.keys.toList())
                MixBar(mix.entries.map { (colors[it.key] ?: OTHER_COLOR) to it.value }, Modifier.fillMaxWidth(), height = 6.dp)
            }
            val notes = buildList {
                if (!row.complete) add("数据不完整")
                row.coverage?.let { add("当天覆盖率 ${String.format("%.1f", it)}%") }
            }
            if (notes.isNotEmpty()) Text(notes.joinToString(" · "), color = cm.warnInk, fontSize = 11.sp)
        }
    }
    if (state.historyHasMore || state.historyLoading) {
        item("more") {
            TextButton(onClick = onMore, modifier = Modifier.fillMaxWidth()) {
                Text(if (state.historyLoading) "加载中…" else "加载更早记录")
            }
        }
    }
}

@androidx.compose.runtime.Composable
private fun MonthSummary(today: String, monthKeyRaw: String?, map: Map<String, Double>) {
    val cm = CmColorsCurrent
    val monthKey = monthKeyRaw ?: today.take(7)
    val y = monthKey.take(4).toInt()
    val m = monthKey.takeLast(2).toInt()
    val daysIn = YearMonth.of(y, m).lengthOfMonth()
    val lead = ((Format.dowOfKey("$monthKey-01") ?: 0) + 6) % 7
    val cells = (1..daysIn).map { d ->
        val key = "%04d-%02d-%02d".format(y, m, d)
        d.toString() to (map[key] ?: 0.0)
    }
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
        DOW_MON.forEach { Text(it, color = cm.mute, fontSize = 10.sp, modifier = Modifier.weight(1f)) }
    }
    Spacer(Modifier.height(4.dp))
    HeatCells(cells, columns = 7, showLabel = true, leading = lead)
    val total = cells.sumOf { it.second }
    val active = cells.count { it.second > 0 }
    val best = cells.maxByOrNull { it.second }?.takeIf { it.second > 0 }
    val avg = if (active > 0) (total / active).roundToInt().toDouble() else 0.0
    val last7 = (6 downTo 0).map { i ->
        val day = Format.keyAdd(today, -i)
        day to (map[day] ?: 0.0)
    }
    val sum7 = last7.sumOf { it.second }
    val dow = ((Format.dowOfKey(today) ?: 0) + 6) % 7
    var wkThis = 0.0
    var wkPrev = 0.0
    for (i in 0..dow) {
        wkThis += map[Format.keyAdd(today, -(dow - i))] ?: 0.0
        wkPrev += map[Format.keyAdd(today, -(dow + 7 - i))] ?: 0.0
    }
    val wowPct = if (wkPrev > 0) ((wkThis - wkPrev) / wkPrev) * 100 else null
    Spacer(Modifier.height(12.dp))
    Text("${m} 月摘要", color = cm.ink, fontWeight = FontWeight.SemiBold)
    Spacer(Modifier.height(8.dp))
    Row(Modifier.fillMaxWidth()) {
        SumCell("本月总量", Format.fmtCompact(total), Modifier.weight(1f))
        SumCell("活跃天数", "$active 天", Modifier.weight(1f))
        SumCell("最高单日", best?.let { "${Format.fmtCompact(it.second)} · ${m}月${it.first}日" } ?: "—", Modifier.weight(1f))
    }
    Spacer(Modifier.height(8.dp))
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
        Column {
            Text("日均 tokens", color = cm.mute, fontSize = 11.sp)
            Text(Format.fmtCompact(avg), color = cm.ink, fontWeight = FontWeight.SemiBold)
            Text("按活跃天", color = cm.mute, fontSize = 10.sp)
        }
        if (wowPct != null) {
            val up = wowPct >= 0
            val absv = abs(wowPct)
            val shown = if (absv >= 100) absv.roundToInt().toString() else String.format("%.1f", absv)
            Text(
                "${if (up) "↑" else "↓"} $shown% 周环比",
                color = if (up) cm.okInk else cm.crit,
                fontWeight = FontWeight.SemiBold,
                fontSize = 13.sp,
            )
        }
    }
    Spacer(Modifier.height(10.dp))
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
        Text("近 7 天趋势", color = cm.mute, fontSize = 12.sp)
        Text("合计 ${Format.fmtCompact(sum7)}", color = cm.ink, fontSize = 12.sp, fontWeight = FontWeight.Medium)
    }
    Spacer(Modifier.height(6.dp))
    SparkBars(last7)
}

@androidx.compose.runtime.Composable
private fun SumCell(label: String, value: String, modifier: Modifier) {
    val cm = CmColorsCurrent
    Column(modifier) {
        Text(label, color = cm.mute, fontSize = 11.sp)
        Text(value, color = cm.ink, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
    }
}

@androidx.compose.runtime.Composable
private fun CoverageBlock(ov: io.github.iroha1145.cloudmonitor.data.Overview) {
    val cov = ov.activity.coverage ?: return
    val cm = CmColorsCurrent
    val act = ov.activity
    val parts = mutableListOf<String>()
    parts += "时区 ${act.timeZone ?: ov.dashboardTimeZone}"
    cov.coveragePercent?.let { parts += "采样覆盖率 ${"%.1f".format(it.coerceIn(0.0, 100.0))}%" }
    cov.firstSampleAt?.let { parts += "首次采样 ${Format.relTime(it)}" }
    cov.lastSampleAt?.let { parts += "最近采样 ${Format.relTime(it)}" }
    cov.attributionMode?.let { parts += "归属模式 ${Format.attributionMode(it)}" }
    if (act.dailyMixedBasis) parts += "长期日归档 混合日期口径"
    Spacer(Modifier.height(10.dp))
    Text(parts.joinToString(" · "), color = cm.mute, fontSize = 12.sp)
    if (cov.devices.isNotEmpty()) {
        Spacer(Modifier.height(6.dp))
        val names = ov.devices.associate { it.deviceId to (it.hostname ?: it.deviceId) }
        Text(
            "逐设备采样（期望/实到）· " + cov.devices.joinToString("  ") { dv ->
                val extra = buildList {
                    if (dv.gapCount > 0) add("缺口 ${dv.gapCount}")
                    if (dv.resetCount > 0) add("重置 ${dv.resetCount}")
                }
                "${names[dv.deviceId] ?: dv.deviceId} ${dv.observedBuckets}/${dv.expectedBuckets}" +
                    if (extra.isNotEmpty()) " · ${extra.joinToString(" · ")}" else ""
            },
            color = cm.ink2,
            fontSize = 11.sp,
        )
    }
    val low = cov.attributionMode == "delta-low-coverage" ||
        (cov.coveragePercent != null && cov.coveragePercent < 60)
    val warnings = buildList {
        if (low) add("小时分布为采样增量归属，可能集中在首次采样时段。")
        if (act.dailyMixedBasis) add("七天前数据来自设备本地日锚点；跨时区设备的长期日历不可视为统一仪表盘日。")
    }
    if (warnings.isNotEmpty()) {
        Spacer(Modifier.height(6.dp))
        Text(warnings.joinToString(" "), color = cm.warnInk, fontSize = 11.sp)
    }
}
