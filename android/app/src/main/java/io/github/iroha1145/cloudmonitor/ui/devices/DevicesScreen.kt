package io.github.iroha1145.cloudmonitor.ui.devices

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.github.iroha1145.cloudmonitor.data.*
import io.github.iroha1145.cloudmonitor.ui.AppIcons
import io.github.iroha1145.cloudmonitor.ui.PageState
import io.github.iroha1145.cloudmonitor.ui.components.ClientLogo
import io.github.iroha1145.cloudmonitor.ui.components.Panel
import io.github.iroha1145.cloudmonitor.ui.components.StatusDot
import io.github.iroha1145.cloudmonitor.ui.components.WebSearchField
import io.github.iroha1145.cloudmonitor.ui.components.WebSegmentedControl
import io.github.iroha1145.cloudmonitor.ui.theme.CmColorsCurrent
import io.github.iroha1145.cloudmonitor.vm.UiState

fun LazyListScope.devicesItems(state: UiState, page: PageState) {
    val overview = state.overview ?: return
    item("devices") { DevicesContent(overview, page) }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun DevicesContent(overview: Overview, page: PageState) {
    val cm = CmColorsCurrent
    var query by page.query
    var filter by page.selection
    val onlineMap = overview.devices.associate { it.deviceId to deviceOnline(it, overview) }
    val online = onlineMap.values.count { it == true }
    val clients = overview.devices.flatMap { it.trackedClients }.toSet().size
    val visible = overview.devices.filter { device ->
        val matches = listOf(device.hostname, device.deviceId, device.platform, device.osName)
            .plus(device.trackedClients).filterNotNull().any { it.contains(query.trim(), ignoreCase = true) }
        matches && when (filter) {
            "在线" -> onlineMap[device.deviceId] == true
            "离线" -> onlineMap[device.deviceId] == false
            "未知" -> onlineMap[device.deviceId] == null
            else -> true
        }
    }
    Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Panel {
            Text("设备概况", style = MaterialTheme.typography.titleMedium, color = cm.ink, modifier = Modifier.semantics { heading() })
            Spacer(Modifier.height(14.dp))
            DeviceMetrics(listOf("在线设备" to "$online / ${overview.devices.size}", "已跟踪客户端" to "$clients 种",
                "今日词元" to Format.fmtCompact(overview.devices.sumOf { it.today.totalTokens })), summary = true)
        }
        if (overview.devices.isEmpty()) {
            Panel {
                Text("还没有设备上报", style = MaterialTheme.typography.titleLarge, color = cm.ink)
                Spacer(Modifier.height(8.dp))
                Text("在用量监控（Token Monitor）的设置中开启多设备同步，填入面板地址和服务端同步密钥。完成首次上传后，设备会显示在这里。", color = cm.ink2, style = MaterialTheme.typography.bodyMedium)
            }
        } else {
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                WebSearchField(query, { query = it }, label = "搜索设备", placeholder = "名称、系统或客户端",
                    modifier = Modifier.fillMaxWidth().testTag("device-search"))
                val filters = listOf("全部", "在线", "离线", "未知")
                WebSegmentedControl(filters, filters.indexOf(filter).coerceAtLeast(0), { filter = filters[it] })
                Text("${visible.size} 台设备", color = cm.ink2, fontSize = 11.sp, lineHeight = 16.sp)
            }
            if (visible.isEmpty()) {
                Panel {
                    Text("没有符合条件的设备", color = cm.ink, style = MaterialTheme.typography.titleMedium)
                    TextButton(onClick = { query = ""; filter = "全部" }, modifier = Modifier.heightIn(min = 48.dp)) { Text("清除筛选") }
                }
            } else {
                val fontScale = LocalDensity.current.fontScale
                BoxWithConstraints(Modifier.fillMaxWidth()) {
                    val columns = if (maxWidth >= 740.dp && fontScale <= 1.35f) 2 else 1
                    Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
                        visible.chunked(columns).forEach { group ->
                            Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                                group.forEach { device ->
                                    key(device.deviceId) {
                                        Box(Modifier.weight(1f)) { DeviceCard(device, overview, onlineMap[device.deviceId]) }
                                    }
                                }
                                if (group.size < columns) Spacer(Modifier.weight(1f))
                            }
                        }
                    }
                }
            }
            Text("状态按最近上报与上传间隔判断。离线设备的历史用量仍会保留。", color = cm.ink2, style = MaterialTheme.typography.bodySmall)
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun DeviceCard(device: Device, overview: Overview, online: Boolean?) {
    val cm = CmColorsCurrent
    var expanded by rememberSaveable(device.deviceId) { mutableStateOf(false) }
    val diagnostics = overview.diagnostics.find { it.deviceId == device.deviceId }
    val tools = healthTools(diagnostics)
    val zone = overview.periodWindowsByDevice[device.deviceId]?.timeZone
    val status = when (online) { true -> "在线"; false -> "离线"; null -> "状态未知" }
    val platform = device.osName?.takeIf { it.isNotBlank() } ?: when (device.platform) {
        "darwin" -> "macOS"; "win32" -> "Windows"; "linux" -> "Linux"; else -> device.platform ?: "系统未提供"
    }
    Panel {
        FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                StatusDot(online)
                Spacer(Modifier.width(7.dp))
                Text(status, color = when (online) { true -> cm.okInk; false -> cm.crit; null -> cm.ink2 }, fontSize = 11.sp, lineHeight = 15.sp)
            }
            Text("最近上报 ${Format.relTime(device.receivedAt).ifBlank { "未提供" }}", color = cm.ink2, fontSize = 11.sp, lineHeight = 15.sp)
        }
        Spacer(Modifier.height(13.dp))
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Box(Modifier.size(35.dp).clip(RoundedCornerShape(8.dp)).background(cm.inset), contentAlignment = Alignment.Center) {
                Icon(AppIcons.Computer, null, tint = cm.ink2, modifier = Modifier.size(21.dp))
            }
            Column(Modifier.weight(1f)) {
                Text(device.hostname?.takeIf { it.isNotBlank() } ?: "未命名设备", color = cm.ink,
                    fontSize = 16.sp, lineHeight = 22.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.semantics { heading() })
                Text(listOfNotNull(platform, device.osVersion).joinToString(" "), color = cm.ink2, fontSize = 11.sp, lineHeight = 16.sp)
            }
        }
        Spacer(Modifier.height(16.dp))
        Text("客户端与健康状态", color = cm.ink2, fontSize = 11.sp, lineHeight = 16.sp)
        Spacer(Modifier.height(8.dp))
        if (tools.isEmpty() && device.trackedClients.isEmpty()) {
            Text("客户端信息未提供", color = cm.ink2, style = MaterialTheme.typography.bodyMedium)
        }
        val healthNames = tools.map { it.name.lowercase() }.toSet()
        tools.forEachIndexed { index, tool ->
            if (index > 0) Spacer(Modifier.height(6.dp))
            Row(Modifier.fillMaxWidth().heightIn(min = 34.dp).border(1.dp, cm.border, RoundedCornerShape(6.dp))
                .padding(horizontal = 7.dp, vertical = 5.dp), verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                ClientLogo(tool.name, size = 18.dp)
                Column(Modifier.weight(1f)) {
                    Text(tool.name, color = cm.ink, fontSize = 12.sp, lineHeight = 16.sp, fontWeight = FontWeight.Medium)
                    tool.version?.let { Text("v${it.removePrefix("v")}", color = cm.ink2, fontSize = 10.sp, lineHeight = 14.sp) }
                    if (expanded) Text("上报状态：${tool.statusText}", color = cm.ink2, style = MaterialTheme.typography.bodySmall)
                }
                Text(healthLabel(tool.level), color = when (tool.level) { "ok" -> cm.okInk; "warn" -> cm.warnInk; "crit" -> cm.crit; else -> cm.ink2 },
                    fontSize = 10.sp, lineHeight = 14.sp)
            }
        }
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            device.trackedClients.filter { it.lowercase() !in healthNames }.forEach { client ->
                Row(Modifier.border(1.dp, cm.border, RoundedCornerShape(6.dp)).padding(horizontal = 7.dp, vertical = 5.dp), verticalAlignment = Alignment.CenterVertically) {
                    ClientLogo(client, size = 18.dp)
                    Spacer(Modifier.width(6.dp))
                    Text(client, color = cm.ink, fontSize = 12.sp, lineHeight = 16.sp)
                }
            }
        }
        Spacer(Modifier.height(16.dp))
        HorizontalDivider(color = cm.border)
        Spacer(Modifier.height(13.dp))
        DeviceMetrics(listOf("今日词元" to Format.fmtCompact(device.today.totalTokens), "本月词元" to Format.fmtCompact(device.month.totalTokens),
            "累计词元" to Format.fmtCompact(device.allTime.totalTokens), "累计估算费用" to Format.fmtUsd(device.allTime.costUsd)))
        if (expanded) {
            Spacer(Modifier.height(20.dp))
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                DeviceDetail("设备标识", device.deviceId.ifBlank { "未提供" })
                DeviceDetail("最近上报", Format.fmtDateTime(device.receivedAt, zone).ifBlank { "未提供" })
                DeviceDetail("采集程序", device.agentVersion?.let { "v${it.removePrefix("v")}" } ?: "版本未提供")
                device.agentRuntime?.let { DeviceDetail("运行方式", when (it) { "desktop" -> "桌面程序"; "widget" -> "桌面组件"; "service" -> "后台服务"; "daemon" -> "后台进程"; "cli" -> "命令行"; else -> it }) }
                DeviceDetail("同步频率", Format.fmtInterval(device.syncUploadIntervalMs).ifBlank { "未提供" })
                DeviceDetail("统计时区", zone ?: "未提供")
                DeviceDetail("采集能力", listOf(if (device.projectsEnabled) "项目统计已开启" else "项目统计未开启", if (device.historyAvailable) "包含历史数据" else "暂无历史数据").joinToString(" · "))
                diagnostics?.clientStatus?.let { raw -> shortStatusText(raw).takeIf { it.isNotBlank() }?.let { DeviceDetail("诊断信息", it) } }
                if (isWindowsPlatform(device.platform, device.osName)) diagnostics?.wslStatus?.let { DeviceDetail("Linux 子系统（WSL）", it) }
            }
        }
        Spacer(Modifier.height(13.dp))
        HorizontalDivider(color = cm.border)
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
            TextButton(onClick = { expanded = !expanded }, modifier = Modifier.heightIn(min = 48.dp), shape = RoundedCornerShape(6.dp)) {
                Text(if (expanded) "收起设备详情" else "查看设备详情", fontSize = 12.sp)
            }
        }
    }
}

@Composable
private fun DeviceMetrics(values: List<Pair<String, String>>, summary: Boolean = false) {
    val cm = CmColorsCurrent
    val fontScale = LocalDensity.current.fontScale
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val columns = if (fontScale > 1.5f || maxWidth < 260.dp) 1 else if (summary && maxWidth >= 300.dp) 3 else 2
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            values.chunked(columns).forEach { row ->
                Row(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                    row.forEach { (label, value) ->
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            Text(label, color = cm.ink2, fontSize = 11.sp, lineHeight = 15.sp)
                            Text(value, color = cm.ink, fontSize = if (summary) 21.sp else 17.sp,
                                lineHeight = if (summary) 27.sp else 23.sp, fontWeight = FontWeight.SemiBold)
                        }
                    }
                    repeat(columns - row.size) { Spacer(Modifier.weight(1f)) }
                }
            }
        }
    }
}

@Composable
private fun DeviceDetail(label: String, value: String) {
    val cm = CmColorsCurrent
    Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Text(label, color = cm.ink2, style = MaterialTheme.typography.labelMedium)
        Text(value, color = cm.ink, style = MaterialTheme.typography.bodyMedium)
    }
}
