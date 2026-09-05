package io.github.iroha1145.cloudmonitor.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.*
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.iroha1145.cloudmonitor.BuildConfig
import io.github.iroha1145.cloudmonitor.data.Format
import io.github.iroha1145.cloudmonitor.ui.components.*
import io.github.iroha1145.cloudmonitor.ui.devices.devicesItems
import io.github.iroha1145.cloudmonitor.ui.gate.GateScreen
import io.github.iroha1145.cloudmonitor.ui.history.historyItems
import io.github.iroha1145.cloudmonitor.ui.models.modelsItems
import io.github.iroha1145.cloudmonitor.ui.overview.overviewItems
import io.github.iroha1145.cloudmonitor.ui.quota.quotaItems
import io.github.iroha1145.cloudmonitor.ui.theme.*
import io.github.iroha1145.cloudmonitor.ui.update.UpdateDialog
import io.github.iroha1145.cloudmonitor.vm.AppTab
import io.github.iroha1145.cloudmonitor.vm.AppViewModel

private data class TabSpec(val tab: AppTab, val label: String, val icon: ImageVector)
private val TABS = listOf(
    TabSpec(AppTab.Overview, "总览", AppIcons.GridView),
    TabSpec(AppTab.Devices, "设备", AppIcons.Computer),
    TabSpec(AppTab.Models, "模型", AppIcons.Models),
    TabSpec(AppTab.Quota, "额度", AppIcons.AccountBalanceWallet),
    TabSpec(AppTab.History, "历史", AppIcons.History),
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AppRoot(vm: AppViewModel) {
    val state by vm.state.collectAsStateWithLifecycle()
    val owner = LocalLifecycleOwner.current
    DisposableEffect(owner) {
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_START -> vm.setForeground(true)
                Lifecycle.Event.ON_STOP -> vm.setForeground(false)
                else -> Unit
            }
        }
        owner.lifecycle.addObserver(observer)
        onDispose { owner.lifecycle.removeObserver(observer) }
    }
    val systemDark = isSystemInDarkTheme()
    val dark = state.dark ?: systemDark
    val reduced = rememberReducedMotion()
    val tip = remember { FloatTipController() }
    CloudMonitorTheme(darkTheme = dark) {
        ApplyEdgeToEdge(dark)
        SecureScreen(enabled = !state.signedIn)
        CompositionLocalProvider(LocalReducedMotion provides reduced, LocalFloatTip provides tip) {
            if (!state.signedIn) {
                GateScreen(state, dark, vm::onUrl, vm::onToken, vm::login, vm::enterDemo) {
                    vm.toggleDark(systemDark)
                }
            } else {
                val cm = CmColorsCurrent
                var menu by remember { mutableStateOf(false) }
                var logout by rememberSaveable { mutableStateOf(false) }
                val saveable = rememberSaveableStateHolder()
                // At the home destination the system owns Back, including its predictive animation.
                BackHandler(enabled = state.tab != AppTab.Overview && !tip.visible && !state.showUpdate && !logout && !menu) {
                    vm.selectTab(AppTab.Overview)
                }
                LaunchedEffect(state.tab) { tip.hide() }
                val snackbars = remember { SnackbarHostState() }
                LaunchedEffect(state.toast) {
                    state.toast?.let { snackbars.showSnackbar(it); vm.dismissToast() }
                }
                saveable.SaveableStateProvider(state.tab.name) {
                    val listState = rememberLazyListState()
                    // Keep page choices outside lazy items, whose saved state may be discarded off screen.
                    val page = rememberSaveable(saver = PageState.Saver) {
                        PageState(selection = if (state.tab == AppTab.History) "" else "全部")
                    }
                    BoxWithConstraints(Modifier.fillMaxSize()) {
                        val rail = maxWidth >= 600.dp
                        Scaffold(
                            modifier = Modifier.fillMaxSize(),
                            containerColor = cm.canvas,
                            contentWindowInsets = WindowInsets.safeDrawing,
                            topBar = {
                                TopAppBar(
                                    title = {
                                        Column {
                                            Text(TABS.first { it.tab == state.tab }.label, fontWeight = FontWeight.SemiBold,
                                                modifier = Modifier.semantics { heading() })
                                            Text("用量工作台", style = MaterialTheme.typography.labelSmall, color = cm.mute)
                                        }
                                    },
                                    colors = TopAppBarDefaults.topAppBarColors(containerColor = cm.canvas),
                                    actions = {
                                        IconButton(onClick = vm::refresh, enabled = !state.refreshing, modifier = Modifier.testTag("refresh")) {
                                            if (state.refreshing) CircularProgressIndicator(Modifier.size(22.dp), strokeWidth = 2.dp)
                                            else Icon(AppIcons.Refresh, "刷新数据")
                                        }
                                        Box {
                                            IconButton(onClick = { menu = true }, modifier = Modifier.testTag("settings")) {
                                                Icon(AppIcons.More, "更多选项")
                                            }
                                            DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                                                DropdownMenuItem(text = { Text(if (dark) "切换浅色外观" else "切换深色外观") },
                                                    leadingIcon = { Icon(if (dark) AppIcons.LightMode else AppIcons.DarkMode, null) },
                                                    onClick = { menu = false; vm.toggleDark(systemDark) })
                                                DropdownMenuItem(text = { Text("检查服务器更新") }, leadingIcon = { Icon(AppIcons.SystemUpdate, null) },
                                                    onClick = { menu = false; vm.openUpdate() })
                                                HorizontalDivider()
                                                DropdownMenuItem(text = { Text(if (state.demo) "退出演示" else "断开连接") },
                                                    leadingIcon = { Icon(AppIcons.Logout, null) }, onClick = { menu = false; logout = true })
                                                Text("应用 ${BuildConfig.VERSION_NAME}", Modifier.padding(16.dp), color = cm.mute,
                                                    style = MaterialTheme.typography.labelSmall)
                                            }
                                        }
                                    },
                                )
                            },
                            bottomBar = {
                                if (!rail) NavigationBar(containerColor = cm.card, tonalElevation = 0.dp, modifier = Modifier.testTag("bottom-navigation")) {
                                    TABS.forEach { spec ->
                                        NavigationBarItem(selected = state.tab == spec.tab,
                                            onClick = { vm.selectTab(spec.tab) },
                                            icon = { Icon(spec.icon, null) }, label = { Text(spec.label) },
                                            modifier = Modifier.testTag("nav-${spec.tab}"),
                                            colors = NavigationBarItemDefaults.colors(selectedIconColor = cm.brand,
                                                selectedTextColor = cm.brand, indicatorColor = cm.brand50))
                                    }
                                }
                            },
                            snackbarHost = { SnackbarHost(snackbars) },
                        ) { padding ->
                            Row(Modifier.fillMaxSize().padding(padding).consumeWindowInsets(padding)) {
                                if (rail) NavigationRail(containerColor = cm.canvas, windowInsets = WindowInsets(0,0,0,0),
                                    modifier = Modifier.fillMaxHeight().verticalScroll(rememberScrollState()).testTag("navigation-rail")) {
                                    TABS.forEach { spec ->
                                        NavigationRailItem(selected = state.tab == spec.tab,
                                            onClick = { vm.selectTab(spec.tab) }, icon = { Icon(spec.icon, null) },
                                            label = { Text(spec.label) }, modifier = Modifier.testTag("nav-${spec.tab}"))
                                    }
                                }
                                PullToRefreshBox(isRefreshing = state.refreshing, onRefresh = vm::refresh, modifier = Modifier.weight(1f)) {
                                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.TopCenter) {
                                        val nearEnd by remember {
                                            derivedStateOf {
                                                val info = listState.layoutInfo
                                                info.totalItemsCount > 0 && (info.visibleItemsInfo.lastOrNull()?.index ?: 0) >= info.totalItemsCount - 3
                                            }
                                        }
                                        LaunchedEffect(nearEnd, state.tab) {
                                            if (state.tab == AppTab.History && nearEnd) vm.loadMoreHistory()
                                        }
                                        LazyColumn(state = listState,
                                            modifier = Modifier.widthIn(max = 1200.dp).fillMaxSize().testTag("screen-${state.tab}"),
                                            contentPadding = PaddingValues(horizontal = if (rail) 24.dp else 16.dp, vertical = 12.dp),
                                        ) {
                                            item("connection") {
                                                Column(Modifier.fillMaxWidth().padding(bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                                    Text(if (state.demo) "演示模式 · 数据仅供体验" else state.lastUpdated?.let { "更新于 ${Format.fmtClock(it)} · 每 5 分钟刷新" } ?: "正在连接服务器",
                                                        color = cm.mute, style = MaterialTheme.typography.bodySmall)
                                                    state.sessionWarning?.let { Text(it, color = cm.warnInk, style = MaterialTheme.typography.bodySmall) }
                                                    state.error?.let { Text(it, color = cm.crit, style = MaterialTheme.typography.bodySmall) }
                                                }
                                            }
                                            if (state.loading && state.overview == null) {
                                                items(3) { ShimmerPanel(); Spacer(Modifier.height(12.dp)) }
                                            } else when (state.tab) {
                                                AppTab.Overview -> overviewItems(state, vm.modelColors(), vm::setModelPeriod, vm::setClientPeriod, vm::setMxPeriod, vm::setMxCost, page)
                                                AppTab.Devices -> devicesItems(state, page)
                                                AppTab.Models -> modelsItems(state, vm.modelColors(), vm::setModelPeriod, vm::setMxPeriod, vm::setMxCost, page)
                                                AppTab.Quota -> quotaItems(state)
                                                AppTab.History -> historyItems(state, vm.modelColors(), vm.clientColors(), vm::setActView, vm::loadMoreHistory, page)
                                            }
                                            item("end") { Spacer(Modifier.height(24.dp)) }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                FloatTipHost(tip)
                if (state.showUpdate) UpdateDialog(state.demo, state.updateLoading, state.updateError, state.update, vm::closeUpdate)
                if (logout) AlertDialog(onDismissRequest = { logout = false },
                    title = { Text(if (state.demo) "退出演示？" else "断开服务器连接？") },
                    text = { Text(if (state.demo) "退出后可连接自己的服务器。" else "本机保存的访问密钥将被清除，服务器上的数据会保留。") },
                    confirmButton = { TextButton(onClick = { logout = false; vm.logout() }) { Text("确认退出") } },
                    dismissButton = { TextButton(onClick = { logout = false }) { Text("取消") } })
            }
        }
    }
}
