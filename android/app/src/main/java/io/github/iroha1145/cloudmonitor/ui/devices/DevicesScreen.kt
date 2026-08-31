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
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
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
import io.github.iroha1145.cloudmonitor.data.healthBarWidth
import io.github.iroha1145.cloudmonitor.data.healthLabel
import io.github.iroha1145.cloudmonitor.data.healthTools
import io.github.iroha1145.cloudmonitor.data.isWindowsPlatform
import io.github.iroha1145.cloudmonitor.data.shortStatusText
import io.github.iroha1145.cloudmonitor.ui.AppIcons
import io.github.iroha1145.cloudmonitor.ui.components.ClientLogo
import io.github.iroha1145.cloudmonitor.ui.components.Panel
import io.github.iroha1145.cloudmonitor.ui.components.StatusDot
import io.github.iroha1145.cloudmonitor.ui.theme.CmColorsCurrent
import io.github.iroha1145.cloudmonitor.ui.theme.riseIn
import io.github.iroha1145.cloudmonitor.vm.UiState

fun LazyListScope.devicesItems(state: UiState) {
    val ov = state.overview ?: return
    val onlineMap = ov.devices.associate { it.deviceId to deviceOnline(it, ov) }
    val online = onlineMap.values.count { it == true }
    val clients = ov.devices.flatMap { it.trackedClients }.toSet().size
    val todaySum = ov.devices.sumOf { it.today.totalTokens }

    item("sum") {
        Column(Modifier.padding(bottom = 12.dp).riseIn(0), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                SumPill("在线 $online / ${ov.devices.size}", Modifier.weight(1f))
                SumPill("客户端 $clients", Modifier.weight(1f))
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                SumPill("今日 ${Format.fmtCompact(todaySum)}", Modifier.weight(1f))
                SumPill("离线由上传间隔判定", Modifier.weight(1f))
            }
        }
    }
    if (ov.devices.isEmpty()) {
        item("empty") {
            Panel(Modifier.riseIn(1)) {
                val cm = CmColorsCurrent
                Column(Modifier.fillMaxWidth().padding(vertical = 12.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    Icon(AppIcons.CloudPulse, null, tint = cm.brand, modifier = Modifier.size(36.dp))
                    Spacer(Modifier.height(10.dp))
                    Text("还没有设备数据", color = cm.ink, fontSize = 18.sp, fontWeight = FontWeight.SemiBold)
                    Spacer(Modifier.height(8.dp))
                    Text(
                        "在本机 token-monitor 设置里启用多设备同步（Multi-device sync）：",
                        color = cm.mute,
                        fontSize = 13.sp,
                    )
                    Spacer(Modifier.height(12.dp))
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                        StepRow("1", "hub 地址填本服务器地址")
                        StepRow("2", "密钥填服务端配置的 TOKEN_MONITOR_SECRET")
                        StepRow("3", "桌面 Widget 按其设置的实时/10/20/30 分钟节奏上传；Headless Agent 通常为 5 分钟。App 每 5 分钟刷新一次。")
                    }
                }
            }
        }
        return
    }
    itemsIndexed(ov.devices, key = { _, d -> d.deviceId }) { index, d ->
        val cm = CmColorsCurrent
        val on = onlineMap[d.deviceId]
        val tz = ov.periodWindowsByDevice[d.deviceId]?.timeZone
        val diag = ov.diagnostics.find { it.deviceId == d.deviceId }
        Panel(Modifier.padding(bottom = 12.dp).riseIn(index + 1)) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    StatusDot(on, pulse = on == true)
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
            val badges = buildList {
                if (d.projectsEnabled) add("项目统计")
                if (d.historyAvailable) add("历史数据")
            }
            if (badges.isNotEmpty()) {
                Spacer(Modifier.height(8.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    badges.forEach { b ->
                        Text(
                            b,
                            color = cm.brand,
                            fontSize = 11.sp,
                            fontWeight = FontWeight.SemiBold,
                            modifier = Modifier.clip(RoundedCornerShape(999.dp)).background(cm.brand50).padding(horizontal = 8.dp, vertical = 3.dp),
                        )
                    }
                }
            }
            val tools = healthTools(diag)
            if (tools.isNotEmpty()) {
                Spacer(Modifier.height(10.dp))
                tools.forEach { t ->
                    val barColor = when (t.level) {
                        "ok" -> cm.ok
                        "warn" -> cm.warn
                        "crit" -> cm.crit
                        else -> cm.mute
                    }
                    Column(Modifier.padding(vertical = 4.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            ClientLogo(t.name, size = 12.dp)
                            Spacer(Modifier.width(6.dp))
                            Text(t.name + (t.version?.let { " v$it" } ?: ""), color = cm.ink, fontSize = 12.sp, modifier = Modifier.weight(1f))
                            Text(healthLabel(t.level), color = barColor, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
                        }
                        Spacer(Modifier.height(4.dp))
                        Box(Modifier.fillMaxWidth().height(4.dp).clip(RoundedCornerShape(99.dp)).background(cm.brand25)) {
                            Box(
                                Modifier
                                    .fillMaxWidth(healthBarWidth(t.level))
                                    .height(4.dp)
                                    .background(barColor, RoundedCornerShape(99.dp)),
                            )
                        }
                    }
                }
            }
            diag?.clientStatus?.let { raw ->
                val text = shortStatusText(raw)
                if (text.isNotBlank()) {
                    Spacer(Modifier.height(6.dp))
                    Text(text, color = cm.mute, fontSize = 12.sp)
                }
            }
            if (isWindowsPlatform(d.platform, d.osName)) {
                diag?.wslStatus?.let { Text("WSL $it", color = cm.mute, fontSize = 12.sp) }
            }
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
private fun StepRow(n: String, text: String) {
    val cm = CmColorsCurrent
    Row(verticalAlignment = Alignment.Top) {
        Text(
            n,
            color = cm.brand,
            fontSize = 12.sp,
            fontWeight = FontWeight.Bold,
            modifier = Modifier.clip(RoundedCornerShape(99.dp)).background(cm.brand50).padding(horizontal = 8.dp, vertical = 2.dp),
        )
        Spacer(Modifier.width(8.dp))
        Text(text, color = cm.ink2, fontSize = 13.sp, modifier = Modifier.weight(1f))
    }
}

@Composable
private fun SumPill(text: String, modifier: Modifier = Modifier) {
    val cm = CmColorsCurrent
    Box(modifier.clip(RoundedCornerShape(999.dp)).background(cm.card).padding(horizontal = 10.dp, vertical = 8.dp)) {
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
