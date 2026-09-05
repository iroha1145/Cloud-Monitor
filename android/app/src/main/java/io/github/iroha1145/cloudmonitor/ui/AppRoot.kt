package io.github.iroha1145.cloudmonitor.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.background
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.RoundedCornerShape
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
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

private data class TabSpec(val tab: AppTab, val label: String, val title: String, val description: String, val icon: ImageVector)
private val TABS = listOf(
    TabSpec(AppTab.Overview, "总览", "总览", "所有用量，汇聚一处。", AppIcons.GridView),
    TabSpec(AppTab.Models, "模型", "模型分析", "找到最适合你的模型，理解每一份用量。", AppIcons.Models),
    TabSpec(AppTab.Devices, "设备", "设备", "随时了解各台设备的用量与同步状态。", AppIcons.Computer),
    TabSpec(AppTab.Quota, "配额", "配额与订阅", "额度还有多少，下一次何时续费。", AppIcons.AccountBalanceWallet),
    TabSpec(AppTab.History, "历史", "历史记录", "把每一次使用，放回时间里。", AppIcons.History),
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
                val current = TABS.first { it.tab == state.tab }
                var menu by remember { mutableStateOf(false) }
                var navMenu by remember { mutableStateOf(false) }
                var logout by rememberSaveable { mutableStateOf(false) }
                val saveable = rememberSaveableStateHolder()
                // At the home destination the system owns Back, including its predictive animation.
                BackHandler(enabled = state.tab != AppTab.Overview && !tip.visible && !state.showUpdate && !logout && !menu && !navMenu) {
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
                        // Match the mobile website, including phones held in landscape.
                        val shortLandscape = maxWidth <= 960.dp && maxHeight <= 500.dp
                        val rail = maxWidth > 760.dp && !shortLandscape
                        Scaffold(
                            modifier = Modifier.fillMaxSize(),
                            containerColor = cm.canvas,
                            contentWindowInsets = WindowInsets.safeDrawing,
                            topBar = {
                                Column(Modifier.background(cm.card)
                                    .windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Top + WindowInsetsSides.Horizontal))) {
                                    Row(Modifier.fillMaxWidth().heightIn(min = 64.dp).padding(horizontal = 10.dp, vertical = 8.dp),
                                        verticalAlignment = Alignment.CenterVertically) {
                                        Box {
                                            IconButton(onClick = { navMenu = true }, modifier = Modifier.size(48.dp).semantics { contentDescription = "打开导航" }) {
                                                Canvas(Modifier.size(19.dp)) {
                                                    listOf(.25f, .5f, .75f).forEach { y ->
                                                        drawLine(cm.ink2, Offset(size.width * .12f, size.height * y),
                                                            Offset(size.width * .88f, size.height * y), 1.7.dp.toPx(), StrokeCap.Round)
                                                    }
                                                }
                                            }
                                            DropdownMenu(expanded = navMenu, onDismissRequest = { navMenu = false }) {
                                                Text("Cloud Monitor", Modifier.padding(horizontal = 16.dp, vertical = 10.dp),
                                                    fontWeight = FontWeight.SemiBold, color = cm.ink)
                                                TABS.forEach { spec ->
                                                    DropdownMenuItem(text = { Text(spec.title) }, leadingIcon = { Icon(spec.icon, null) },
                                                        onClick = { navMenu = false; vm.selectTab(spec.tab) })
                                                }
                                            }
                                        }
                                        Row(Modifier.weight(1f), horizontalArrangement = Arrangement.spacedBy(6.dp),
                                            verticalAlignment = Alignment.CenterVertically) {
                                            Text(current.title, color = cm.ink, fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
                                                maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                                            if (state.demo) Text("演示", color = cm.mute, fontSize = 9.sp,
                                                modifier = Modifier.background(cm.inset, RoundedCornerShape(4.dp)).padding(horizontal = 5.dp, vertical = 3.dp))
                                        }
                                        IconButton(onClick = { vm.toggleDark(systemDark) }, modifier = Modifier.size(48.dp).testTag("theme-toggle")) {
                                            Icon(if (dark) AppIcons.LightMode else AppIcons.DarkMode,
                                                if (dark) "切换浅色外观" else "切换深色外观", Modifier.size(18.dp), tint = cm.ink2)
                                        }
                                        Box {
                                            IconButton(onClick = { menu = true }, modifier = Modifier.size(48.dp).testTag("settings")) {
                                                Icon(AppIcons.More, "更多选项", Modifier.size(19.dp), tint = cm.ink2)
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
                                    }
                                    HorizontalDivider(color = cm.border)
                                }
                            },
                            bottomBar = {
                                if (!rail) Column(Modifier.background(cm.card).testTag("bottom-navigation")) {
                                    HorizontalDivider(color = cm.borderStrong)
                                    Row(Modifier.fillMaxWidth()
                                        .windowInsetsPadding(WindowInsets.navigationBars.only(WindowInsetsSides.Bottom + WindowInsetsSides.Horizontal))
                                        .padding(horizontal = 5.dp, vertical = if (shortLandscape) 3.dp else 5.dp).selectableGroup()) {
                                        TABS.forEach { spec ->
                                            WebNavItem(spec, state.tab == spec.tab, { vm.selectTab(spec.tab) },
                                                Modifier.weight(1f), horizontal = shortLandscape)
                                        }
                                    }
                                }
                            },
                            snackbarHost = { SnackbarHost(snackbars) },
                        ) { padding ->
                            Row(Modifier.fillMaxSize().padding(padding).consumeWindowInsets(padding)) {
                                if (rail) Column(Modifier.width(184.dp).fillMaxHeight().background(cm.sidebar)
                                    .verticalScroll(rememberScrollState()).testTag("navigation-rail").padding(12.dp).selectableGroup(),
                                    verticalArrangement = Arrangement.spacedBy(5.dp)) {
                                    Text("工作空间", color = cm.mute, style = MaterialTheme.typography.labelSmall,
                                        modifier = Modifier.padding(horizontal = 10.dp, vertical = 14.dp))
                                    TABS.forEach { spec ->
                                        WebNavItem(spec, state.tab == spec.tab, { vm.selectTab(spec.tab) },
                                            Modifier.fillMaxWidth(), horizontal = true, fullTitle = true)
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
                                            contentPadding = PaddingValues(horizontal = if (rail) 24.dp else 16.dp),
                                        ) {
                                            item("connection") {
                                                Column(Modifier.fillMaxWidth().padding(top = 23.dp, bottom = 20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                                                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(7.dp)) {
                                                            Box(Modifier.size(15.dp, 2.dp).background(cm.brand))
                                                            Text(if (state.tab == AppTab.Overview) "你的用量工作台" else current.title,
                                                                color = cm.mute, style = MaterialTheme.typography.labelSmall)
                                                        }
                                                        Text(if (state.tab == AppTab.Overview) "用量，一目了然。" else current.title,
                                                            color = cm.ink, style = MaterialTheme.typography.headlineLarge,
                                                            modifier = Modifier.semantics { heading() })
                                                        Text(current.description, color = cm.ink2, fontSize = 12.sp, lineHeight = 20.sp)
                                                    }
                                                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically,
                                                        horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                                                        Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically,
                                                            horizontalArrangement = Arrangement.spacedBy(7.dp)) {
                                                            StatusDot(ok = state.error == null, unknown = state.lastUpdated == null && !state.demo)
                                                            Text(if (state.demo) "示例数据" else state.lastUpdated?.let { "更新于 ${Format.fmtClock(it)}" } ?: "正在连接服务器",
                                                                color = cm.mute, style = MaterialTheme.typography.bodySmall)
                                                        }
                                                        WebActionButton(if (state.refreshing) "刷新中" else "刷新数据", vm::refresh,
                                                            Modifier.testTag("refresh"), enabled = !state.refreshing, icon = AppIcons.Refresh, loading = state.refreshing)
                                                    }
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

@Composable
private fun WebNavItem(
    spec: TabSpec,
    selected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    horizontal: Boolean = false,
    fullTitle: Boolean = false,
) {
    val cm = CmColorsCurrent
    val color = if (selected) cm.navInk else cm.ink2
    val label = if (fullTitle) spec.title else spec.label
    val itemModifier = modifier.clip(RoundedCornerShape(8.dp))
        .background(if (selected) cm.navActive else Color.Transparent)
        .selectable(selected, role = Role.Tab, onClick = onClick)
        .testTag("nav-${spec.tab}").heightIn(min = if (horizontal) 48.dp else 52.dp)
        .padding(horizontal = if (fullTitle) 10.dp else 2.dp, vertical = 5.dp)
    if (horizontal) {
        Row(itemModifier, verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = if (fullTitle) Arrangement.spacedBy(10.dp) else Arrangement.spacedBy(5.dp, Alignment.CenterHorizontally)) {
            Icon(spec.icon, null, Modifier.size(18.dp), tint = color)
            Text(label, color = color, fontSize = if (fullTitle) 13.sp else 11.sp,
                fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Medium,
                lineHeight = if (fullTitle) 18.sp else 14.sp)
        }
    } else {
        Column(itemModifier, horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(4.dp, Alignment.CenterVertically)) {
            Icon(spec.icon, null, Modifier.size(19.dp), tint = color)
            Text(label, color = color, fontSize = 11.sp, lineHeight = 14.sp,
                fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Medium)
        }
    }
}
