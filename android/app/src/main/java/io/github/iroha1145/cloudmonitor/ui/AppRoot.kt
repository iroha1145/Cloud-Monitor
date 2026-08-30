package io.github.iroha1145.cloudmonitor.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.AccountBalanceWallet
import androidx.compose.material.icons.outlined.Computer
import androidx.compose.material.icons.outlined.DarkMode
import androidx.compose.material.icons.outlined.GridView
import androidx.compose.material.icons.outlined.History
import androidx.compose.material.icons.outlined.LightMode
import androidx.compose.material.icons.outlined.Logout
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.iroha1145.cloudmonitor.ui.devices.DevicesBody
import io.github.iroha1145.cloudmonitor.ui.gate.GateScreen
import io.github.iroha1145.cloudmonitor.ui.history.HistoryBody
import io.github.iroha1145.cloudmonitor.ui.overview.OverviewBody
import io.github.iroha1145.cloudmonitor.ui.quota.QuotaBody
import io.github.iroha1145.cloudmonitor.ui.theme.CloudMonitorTheme
import io.github.iroha1145.cloudmonitor.ui.theme.CmColorsCurrent
import io.github.iroha1145.cloudmonitor.vm.AppTab
import io.github.iroha1145.cloudmonitor.vm.AppViewModel

private data class TabSpec(val tab: AppTab, val label: String, val icon: ImageVector)

private val TABS = listOf(
    TabSpec(AppTab.Overview, "概览", Icons.Outlined.GridView),
    TabSpec(AppTab.Devices, "设备", Icons.Outlined.Computer),
    TabSpec(AppTab.Quota, "配额", Icons.Outlined.AccountBalanceWallet),
    TabSpec(AppTab.History, "历史", Icons.Outlined.History),
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AppRoot(vm: AppViewModel) {
    val state by vm.state.collectAsStateWithLifecycle()
    val systemDark = isSystemInDarkTheme()
    val dark = state.dark ?: systemDark
    CloudMonitorTheme(darkTheme = dark) {
        if (!state.signedIn) {
            GateScreen(
                state = state,
                dark = dark,
                onUrl = vm::onUrl,
                onToken = vm::onToken,
                onLogin = vm::login,
                onDemo = vm::enterDemo,
                onToggleDark = { vm.toggleDark(systemDark) },
            )
        } else {
            val cm = CmColorsCurrent
            val titles = mapOf(
                AppTab.Overview to ("概览" to "CLOUD MONITOR · 实时用量全景"),
                AppTab.Devices to ("设备" to "DEVICES · 上报设备与健康度"),
                AppTab.Quota to ("配额与订阅" to "ACCOUNTS · 配额窗口与订阅清单"),
                AppTab.History to ("历史" to "HISTORY · 活动热力与日归档"),
            )
            Scaffold(
                containerColor = cm.canvas,
                topBar = {
                    Column(
                        Modifier
                            .fillMaxWidth()
                            .background(cm.canvas.copy(alpha = 0.94f))
                            .padding(horizontal = 16.dp, vertical = 10.dp),
                    ) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) {
                                val t = titles[state.tab]!!
                                Text(t.first, color = cm.ink, fontSize = 22.sp, fontWeight = FontWeight.SemiBold)
                                Text(t.second, color = cm.mute, fontSize = 11.sp)
                            }
                            if (state.demo) {
                                Text(
                                    "演示数据",
                                    color = cm.brand,
                                    fontSize = 11.sp,
                                    fontWeight = FontWeight.SemiBold,
                                    modifier = Modifier
                                        .clip(RoundedCornerShape(999.dp))
                                        .background(cm.brand50)
                                        .padding(horizontal = 8.dp, vertical = 4.dp),
                                )
                                Spacer(Modifier.width(4.dp))
                            }
                            IconButton({ vm.toggleDark(systemDark) }) {
                                Icon(if (dark) Icons.Outlined.LightMode else Icons.Outlined.DarkMode, "夜间模式", tint = cm.ink2)
                            }
                            IconButton({ vm.refresh() }) {
                                if (state.refreshing) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = cm.brand)
                                else Icon(Icons.Outlined.Refresh, "刷新", tint = cm.ink2)
                            }
                            IconButton(vm::logout) {
                                Icon(Icons.Outlined.Logout, "退出", tint = cm.ink2)
                            }
                        }
                        state.error?.let {
                            Text(it, color = cm.crit, fontSize = 12.sp, modifier = Modifier.padding(top = 4.dp))
                        }
                    }
                },
                bottomBar = {
                    NavigationBar(containerColor = cm.card, contentColor = cm.ink) {
                        TABS.forEach { spec ->
                            NavigationBarItem(
                                selected = state.tab == spec.tab,
                                onClick = { vm.selectTab(spec.tab) },
                                icon = { Icon(spec.icon, spec.label) },
                                label = { Text(spec.label) },
                                colors = NavigationBarItemDefaults.colors(
                                    selectedIconColor = cm.brand,
                                    selectedTextColor = cm.brand,
                                    indicatorColor = cm.brand50,
                                    unselectedIconColor = cm.mute,
                                    unselectedTextColor = cm.mute,
                                ),
                            )
                        }
                    }
                },
            ) { padding: PaddingValues ->
                Box(Modifier.fillMaxSize().padding(padding)) {
                    if (state.loading && state.overview == null) {
                        CircularProgressIndicator(Modifier.align(Alignment.Center), color = cm.brand)
                    } else {
                        Column(
                            Modifier
                                .fillMaxSize()
                                .verticalScroll(rememberScrollState())
                                .padding(16.dp),
                        ) {
                            when (state.tab) {
                                AppTab.Overview -> OverviewBody(
                                    state,
                                    vm::setModelPeriod,
                                    vm::setClientPeriod,
                                    vm::setMxPeriod,
                                    vm::setMxCost,
                                )
                                AppTab.Devices -> DevicesBody(state)
                                AppTab.Quota -> QuotaBody(state)
                                AppTab.History -> HistoryBody(state, vm::setActView, vm::loadMoreHistory)
                            }
                        }
                    }
                }
            }
        }
    }
}
