package io.github.iroha1145.cloudmonitor.ui

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.SizeTransform
import androidx.compose.animation.core.tween
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarDefaults
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.iroha1145.cloudmonitor.data.Format
import io.github.iroha1145.cloudmonitor.ui.components.FloatTipController
import io.github.iroha1145.cloudmonitor.ui.components.FloatTipHost
import io.github.iroha1145.cloudmonitor.ui.components.LocalFloatTip
import io.github.iroha1145.cloudmonitor.ui.components.ShimmerPanel
import io.github.iroha1145.cloudmonitor.ui.components.ToastBanner
import io.github.iroha1145.cloudmonitor.ui.devices.devicesItems
import io.github.iroha1145.cloudmonitor.ui.gate.GateScreen
import io.github.iroha1145.cloudmonitor.ui.history.historyItems
import io.github.iroha1145.cloudmonitor.ui.overview.overviewItems
import io.github.iroha1145.cloudmonitor.ui.quota.quotaItems
import io.github.iroha1145.cloudmonitor.ui.theme.CloudMonitorTheme
import io.github.iroha1145.cloudmonitor.ui.theme.CmColorsCurrent
import io.github.iroha1145.cloudmonitor.ui.theme.LocalReducedMotion
import io.github.iroha1145.cloudmonitor.ui.theme.Motion
import io.github.iroha1145.cloudmonitor.ui.theme.rememberReducedMotion
import io.github.iroha1145.cloudmonitor.ui.theme.rememberSpin
import io.github.iroha1145.cloudmonitor.ui.update.UpdateDialog
import io.github.iroha1145.cloudmonitor.vm.AppTab
import io.github.iroha1145.cloudmonitor.vm.AppViewModel

private data class TabSpec(val tab: AppTab, val label: String, val icon: ImageVector)

private val TABS = listOf(
    TabSpec(AppTab.Overview, "概览", AppIcons.GridView),
    TabSpec(AppTab.Devices, "设备", AppIcons.Computer),
    TabSpec(AppTab.Quota, "配额", AppIcons.AccountBalanceWallet),
    TabSpec(AppTab.History, "历史", AppIcons.History),
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AppRoot(vm: AppViewModel) {
    val state by vm.state.collectAsStateWithLifecycle()
    val systemDark = isSystemInDarkTheme()
    val dark = state.dark ?: systemDark
    val reduced = rememberReducedMotion()
    val tip = remember { FloatTipController() }
    val haptic = LocalHapticFeedback.current
    val statusInset = statusBarInsetDp()
    CloudMonitorTheme(darkTheme = dark) {
        ApplyEdgeToEdge(dark)
        CompositionLocalProvider(
            LocalReducedMotion provides reduced,
            LocalFloatTip provides tip,
        ) {
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
                    AppTab.Overview to ("概览" to "实时用量全景"),
                    AppTab.Devices to ("设备" to "上报设备与健康度"),
                    AppTab.Quota to ("配额与订阅" to "配额窗口与订阅清单"),
                    AppTab.History to ("历史" to "活动热力与日归档"),
                )
                if (state.showUpdate) {
                    UpdateDialog(
                        demo = state.demo,
                        loading = state.updateLoading,
                        error = state.updateError,
                        data = state.update,
                        onDismiss = vm::closeUpdate,
                    )
                }
                Scaffold(
                    modifier = Modifier
                        .fillMaxSize()
                        .windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Horizontal)),
                    containerColor = cm.canvas,
                    contentWindowInsets = WindowInsets(0, 0, 0, 0),
                    topBar = {
                        // 背景铺进状态栏；文字/图标用 inset 让开时钟与电量（官方 edge-to-edge）。
                        Column(
                            Modifier
                                .fillMaxWidth()
                                .background(cm.canvas.copy(alpha = 0.94f))
                                .padding(top = statusInset)
                                .padding(horizontal = 16.dp, vertical = 10.dp),
                        ) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Column(Modifier.weight(1f)) {
                                    val t = titles[state.tab]!!
                                    Text(
                                        t.first,
                                        color = cm.ink,
                                        fontSize = 22.sp,
                                        fontWeight = FontWeight.SemiBold,
                                        modifier = Modifier.semantics { heading() },
                                    )
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
                                IconButton({
                                    haptic.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                                    vm.toggleDark(systemDark)
                                }) {
                                    Icon(if (dark) AppIcons.LightMode else AppIcons.DarkMode, "夜间模式", tint = cm.ink2)
                                }
                                IconButton({
                                    haptic.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                                    vm.openUpdate()
                                }) {
                                    Icon(AppIcons.SystemUpdate, "检索更新", tint = if (state.update?.updateAvailable == true) cm.brand else cm.ink2)
                                }
                                val spin = rememberSpin(state.refreshing)
                                IconButton({
                                    haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                                    vm.refresh()
                                }) {
                                    Icon(
                                        AppIcons.Refresh,
                                        "刷新",
                                        tint = cm.ink2,
                                        modifier = Modifier.graphicsLayer { rotationZ = spin },
                                    )
                                }
                                IconButton({ vm.logout() }) {
                                    Icon(
                                        AppIcons.Logout,
                                        if (state.demo) "退出演示" else "更换密钥",
                                        tint = cm.ink2,
                                    )
                                }
                            }
                            Row(Modifier.padding(top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                                val updated = state.lastUpdated?.let { "更新于 ${Format.fmtClock(it)}" } ?: "尚未刷新"
                                Text(updated, color = cm.mute, fontSize = 11.sp)
                                Text("  ·  ", color = cm.mute, fontSize = 11.sp)
                                Text(
                                    if (state.demo) "演示数据 · 点刷新重新生成" else "每 5 分钟自动刷新",
                                    color = cm.mute,
                                    fontSize = 11.sp,
                                )
                            }
                            state.sessionWarning?.let {
                                Text(it, color = cm.warnInk, fontSize = 12.sp, modifier = Modifier.padding(top = 4.dp))
                            }
                            state.error?.let {
                                Text(it, color = cm.crit, fontSize = 12.sp, modifier = Modifier.padding(top = 4.dp))
                            }
                        }
                    },
                    bottomBar = {
                        NavigationBar(
                            windowInsets = NavigationBarDefaults.windowInsets,
                            containerColor = cm.card,
                            contentColor = cm.ink,
                            tonalElevation = 0.dp,
                        ) {
                            TABS.forEach { spec ->
                                NavigationBarItem(
                                    selected = state.tab == spec.tab,
                                    onClick = {
                                        haptic.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                                        vm.selectTab(spec.tab)
                                    },
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
                    Box(
                        Modifier
                            .fillMaxSize()
                            .padding(padding)
                            .clipToBounds(),
                    ) {
                        PullToRefreshBox(
                            isRefreshing = state.refreshing,
                            onRefresh = {
                                haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                                vm.refresh()
                            },
                            modifier = Modifier.fillMaxSize(),
                        ) {
                            if (state.loading && state.overview == null) {
                                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                                    ShimmerPanel(110.dp)
                                    ShimmerPanel(110.dp)
                                    ShimmerPanel(160.dp)
                                    ShimmerPanel(160.dp)
                                }
                            } else {
                                AnimatedContent(
                                    targetState = state.tab,
                                    transitionSpec = {
                                        if (reduced) {
                                            EnterTransition.None togetherWith ExitTransition.None
                                        } else {
                                            val forward = targetState.ordinal >= initialState.ordinal
                                            (slideInHorizontally(tween(Motion.Fast)) { if (forward) it / 14 else -it / 14 } togetherWith
                                                ExitTransition.None)
                                                .using(SizeTransform(clip = false))
                                        }
                                    },
                                    label = "tab",
                                ) { tab ->
                                    val listState = rememberLazyListState()
                                    val nearEnd by remember {
                                        derivedStateOf {
                                            val info = listState.layoutInfo
                                            val last = info.visibleItemsInfo.lastOrNull()?.index ?: 0
                                            info.totalItemsCount > 0 && last >= info.totalItemsCount - 4
                                        }
                                    }
                                    LaunchedEffect(nearEnd, tab) {
                                        if (tab == AppTab.History && nearEnd) vm.loadMoreHistory()
                                    }
                                    LazyColumn(
                                        state = listState,
                                        modifier = Modifier.fillMaxSize(),
                                        contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 16.dp, bottom = 28.dp),
                                    ) {
                                        when (tab) {
                                            AppTab.Overview -> overviewItems(
                                                state,
                                                vm::setModelPeriod,
                                                vm::setClientPeriod,
                                                vm::setMxPeriod,
                                                vm::setMxCost,
                                            )
                                            AppTab.Devices -> devicesItems(state)
                                            AppTab.Quota -> quotaItems(state)
                                            AppTab.History -> historyItems(state, vm::setActView, vm::loadMoreHistory)
                                        }
                                        item("bottom-space") { Spacer(Modifier.height(24.dp)) }
                                    }
                                }
                            }
                        }
                        ToastBanner(state.toast)
                        FloatTipHost(tip)
                    }
                }
            }
        }
    }
}
