package io.github.iroha1145.cloudmonitor.ui.devices

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.github.iroha1145.cloudmonitor.data.Format
import io.github.iroha1145.cloudmonitor.data.deviceOnline
import io.github.iroha1145.cloudmonitor.ui.components.ClientLogo
import io.github.iroha1145.cloudmonitor.ui.components.EmptyHint
import io.github.iroha1145.cloudmonitor.ui.components.Panel
import io.github.iroha1145.cloudmonitor.ui.components.StatusDot
import io.github.iroha1145.cloudmonitor.ui.theme.CmColorsCurrent
import io.github.iroha1145.cloudmonitor.vm.UiState

@Composable
fun DevicesBody(state: UiState) {
    val ov = state.overview ?: return
    val cm = CmColorsCurrent
    val onlineMap = ov.devices.associate { it.deviceId to deviceOnline(it, ov) }
    val online = onlineMap.values.count { it == true }
    val clients = ov.devices.flatMap { it.trackedClients }.toSet().size
    val todaySum = ov.devices.sumOf { it.today.totalTokens }

    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        SumPill("在线 $online / ${ov.devices.size}")
        SumPill("客户端 $clients")
        SumPill("今日 ${Format.fmtCompact(todaySum)}")
    }
    Spacer(Modifier.height(12.dp))
    if (ov.devices.isEmpty()) {
        Panel { EmptyHint("还没有设备数据") }
        return
    }
    ov.devices.forEach { d ->
        val on = onlineMap[d.deviceId]
        val tz = ov.periodWindowsByDevice[d.deviceId]?.timeZone
        val diag = ov.diagnostics.find { it.deviceId == d.deviceId }
        Panel(Modifier.padding(bottom = 12.dp)) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    StatusDot(on)
                    Spacer(Modifier.width(6.dp))
                    Text(
                        when (on) { true -> "在线"; false -> "离线"; null -> "状态未知" },
                        color = cm.ink, fontSize = 12.sp, fontWeight = FontWeight.SemiBold,
                    )
                }
                Text("最近上报 ${Format.relTime(d.receivedAt)}", color = cm.mute, fontSize = 12.sp)
            }
            Spacer(Modifier.height(8.dp))
            Text(d.hostname ?: d.deviceId.take(8), color = cm.ink, fontSize = 18.sp, fontWeight = FontWeight.SemiBold)
            Text(d.deviceId, color = cm.mute, fontSize = 11.sp, fontFamily = FontFamily.Monospace)
            Spacer(Modifier.height(8.dp))
            val plat = listOfNotNull(d.platform, listOfNotNull(d.osName, d.osVersion).joinToString(" ").ifBlank { null }).joinToString(" · ")
            if (plat.isNotBlank()) Text(plat, color = cm.ink2, fontSize = 12.sp)
            val agent = listOfNotNull(d.agentVersion?.let { "agent v${it.removePrefix("v")}" }, d.agentRuntime).joinToString(" · ")
            if (agent.isNotBlank()) Text(agent, color = cm.ink2, fontSize = 12.sp)
            val interval = Format.fmtInterval(d.syncUploadIntervalMs)
            if (interval.isNotEmpty()) Text("同步 $interval", color = cm.ink2, fontSize = 12.sp)
            if (!tz.isNullOrBlank()) Text(tz, color = cm.ink2, fontSize = 12.sp)
            if (d.trackedClients.isNotEmpty()) {
                Spacer(Modifier.height(8.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    d.trackedClients.forEach { c ->
                        Row(
                            Modifier.clip(RoundedCornerShape(999.dp)).background(cm.brand25).padding(horizontal = 8.dp, vertical = 4.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            ClientLogo(c, size = 12.dp)
                            Spacer(Modifier.width(4.dp))
                            Text(c, fontSize = 12.sp, color = cm.ink)
                        }
                    }
                }
            }
            diag?.clientStatus?.let {
                Spacer(Modifier.height(6.dp))
                Text(it, color = cm.mute, fontSize = 12.sp)
            }
            diag?.wslStatus?.let { Text(it, color = cm.mute, fontSize = 12.sp) }
            Spacer(Modifier.height(10.dp))
            Row(Modifier.fillMaxWidth()) {
                DevStat("今日", Format.fmtCompact(d.today.totalTokens), Modifier.weight(1f))
                DevStat("本月", Format.fmtCompact(d.month.totalTokens), Modifier.weight(1f))
                DevStat("累计", Format.fmtCompact(d.allTime.totalTokens), Modifier.weight(1f))
                DevStat("费用", Format.fmtUsd(d.allTime.costUsd), Modifier.weight(1f))
            }
        }
    }
}

@Composable
private fun SumPill(text: String) {
    val cm = CmColorsCurrent
    Box(Modifier.clip(RoundedCornerShape(999.dp)).background(cm.card).padding(horizontal = 10.dp, vertical = 8.dp)) {
        Text(text, color = cm.ink, fontSize = 12.sp, fontWeight = FontWeight.Medium)
    }
}

@Composable
private fun DevStat(label: String, value: String, modifier: Modifier = Modifier) {
    val cm = CmColorsCurrent
    Column(modifier) {
        Text(label, color = cm.mute, fontSize = 11.sp)
        Text(value, color = cm.ink, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
    }
}
