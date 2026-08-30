package io.github.iroha1145.cloudmonitor.ui.history

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.github.iroha1145.cloudmonitor.data.Format
import io.github.iroha1145.cloudmonitor.data.hourlyBuckets
import io.github.iroha1145.cloudmonitor.ui.components.EmptyHint
import io.github.iroha1145.cloudmonitor.ui.components.HeatCells
import io.github.iroha1145.cloudmonitor.ui.components.MixBar
import io.github.iroha1145.cloudmonitor.ui.components.Panel
import io.github.iroha1145.cloudmonitor.ui.components.PanelHead
import io.github.iroha1145.cloudmonitor.ui.theme.CmColorsCurrent
import io.github.iroha1145.cloudmonitor.vm.UiState

private val DOW = listOf("日", "一", "二", "三", "四", "五", "六")

fun LazyListScope.historyItems(state: UiState, onActView: (Int) -> Unit, onMore: () -> Unit) {
    val ov = state.overview ?: return
    val tz = ov.dashboardPeriod?.timeZone ?: ov.dashboardTimeZone
    val today = ov.dashboardPeriod?.today?.key ?: Format.dayKeyTz(System.currentTimeMillis(), tz)
    item("heat") {
    val cm = CmColorsCurrent
    Panel(Modifier.padding(bottom = 12.dp)) {
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
                        .selectable(selected = on, role = Role.Tab, onClick = { onActView(i) })
                        .padding(horizontal = 12.dp, vertical = 6.dp),
                )
            }
        }
        Spacer(Modifier.height(8.dp))
        when (state.actView) {
            0 -> {
                val buckets = hourlyBuckets(ov)
                val byHour = (0 until 24).map { h ->
                    h.toString() to (buckets.find { it.hour == h }?.total ?: 0.0)
                }
                HeatCells(byHour, columns = 6, showLabel = true)
            }
            1 -> {
                val map = ov.activity.daily.associate { it.day to it.total }
                val dow = ((Format.dowOfKey(today) ?: 0) + 6) % 7
                val monday = Format.keyAdd(today, -dow)
                val start = Format.keyAdd(monday, -7 * 11)
                val cells = (0 until 12 * 7).map { i ->
                    val day = Format.keyAdd(start, i)
                    day.takeLast(5) to if (day > today) 0.0 else (map[day] ?: 0.0)
                }
                HeatCells(cells, columns = 7, showLabel = false)
            }
            else -> {
                val map = ov.activity.daily.associate { it.day to it.total }
                val monthKey = ov.dashboardPeriod?.month?.key ?: today.take(7)
                val y = monthKey.take(4).toInt()
                val m = monthKey.takeLast(2).toInt()
                val daysIn = java.time.YearMonth.of(y, m).lengthOfMonth()
                val cells = (1..daysIn).map { d ->
                    val key = "%04d-%02d-%02d".format(y, m, d)
                    d.toString() to (map[key] ?: 0.0)
                }
                HeatCells(cells, columns = 7, showLabel = true)
                val total = cells.sumOf { it.second }
                val active = cells.count { it.second > 0 }
                Spacer(Modifier.height(12.dp))
                Text("${m} 月摘要", color = cm.ink, fontWeight = FontWeight.SemiBold)
                Text("本月总量 ${Format.fmtCompact(total)} · 活跃 $active 天", color = cm.mute, fontSize = 12.sp)
            }
        }
        ov.activity.coverage?.coveragePercent?.let {
            Spacer(Modifier.height(8.dp))
            Text("采样覆盖率 ${String.format("%.1f", it)}%", color = cm.mute, fontSize = 12.sp)
        }
    }
    }
    item("archive") {
    val cm = CmColorsCurrent
    Panel {
        PanelHead("日归档", "最多保留 ${370} 天")
        Spacer(Modifier.height(8.dp))
        val rows = if (state.history.isNotEmpty()) state.history
        else ov.activity.daily.sortedByDescending { it.day }.map {
            io.github.iroha1145.cloudmonitor.data.HistoryDay(it.day, it.total, perModel = it.models)
        }
        if (rows.isEmpty()) EmptyHint("暂无历史")
        else rows.forEach { row ->
            val dow = Format.dowOfKey(row.day)?.let { DOW[it] } ?: ""
            Column(Modifier.padding(vertical = 8.dp)) {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                    Text("${row.day} 周$dow" + if (row.day == today) " · 今天" else "", color = cm.ink, fontWeight = FontWeight.Medium)
                    Text(Format.fmtCompact(row.tokens), color = cm.ink, fontWeight = FontWeight.SemiBold)
                }
                row.costUsd?.let { Text(Format.fmtUsd(it), color = cm.mute, fontSize = 12.sp) }
                val mix = row.perClient.ifEmpty { row.perModel }
                if (mix.isNotEmpty()) {
                    Spacer(Modifier.height(6.dp))
                    val colors = io.github.iroha1145.cloudmonitor.data.assignColors(mix.keys.toList())
                    MixBar(mix.entries.map { (colors[it.key] ?: io.github.iroha1145.cloudmonitor.data.OTHER_COLOR) to it.value }, Modifier.fillMaxWidth(), height = 6.dp)
                }
                if (!row.complete) Text("数据不完整", color = cm.warnInk, fontSize = 11.sp)
            }
        }
        if (state.historyHasMore) {
            TextButton(onClick = onMore, modifier = Modifier.align(Alignment.CenterHorizontally)) {
                Text(if (state.historyLoading) "加载中…" else "加载更多")
            }
        }
    }
    }
}
