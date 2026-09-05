package io.github.iroha1145.cloudmonitor.vm

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import io.github.iroha1145.cloudmonitor.platform.LocalNetworkAccess
import io.github.iroha1145.cloudmonitor.data.ApiException
import io.github.iroha1145.cloudmonitor.data.DemoCatalog
import io.github.iroha1145.cloudmonitor.data.HistoryDay
import io.github.iroha1145.cloudmonitor.data.HubClient
import io.github.iroha1145.cloudmonitor.data.Overview
import io.github.iroha1145.cloudmonitor.data.ProviderCard
import io.github.iroha1145.cloudmonitor.data.SessionStore
import io.github.iroha1145.cloudmonitor.data.ColorRegistry
import io.github.iroha1145.cloudmonitor.data.SubscriptionsPayload
import io.github.iroha1145.cloudmonitor.data.SystemUpdate
import io.github.iroha1145.cloudmonitor.data.rankedNames
import io.github.iroha1145.cloudmonitor.data.trendRows
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlin.random.Random

private const val POLL_MS = 5 * 60 * 1000L
private const val HISTORY_RETRY_MS = 60_000L

enum class AppTab { Overview, Devices, Models, Quota, History }
enum class Period(val key: String, val label: String) {
    Today("today", "今日"),
    Month("month", "本月"),
    AllTime("allTime", "累计"),
}
enum class AuxStatus { Idle, Loading, Ready, Empty, Error, Unsupported }

data class UiState(
    val signedIn: Boolean = false,
    val demo: Boolean = false,
    val hubUrl: String = "",
    val token: String = "",
    val encryptionAvailable: Boolean = true,
    val sessionWarning: String? = null,
    val dark: Boolean? = null,
    val tab: AppTab = AppTab.Overview,
    val loading: Boolean = false,
    val refreshing: Boolean = false,
    val error: String? = null,
    val gateError: String? = null,
    val toast: String? = null,
    val staleData: Boolean = false,
    val overview: Overview? = null,
    val providers: List<ProviderCard> = emptyList(),
    val providersStatus: AuxStatus = AuxStatus.Idle,
    val providersPartial: Boolean = false,
    val providersPartialErrors: List<String> = emptyList(),
    val subscriptions: SubscriptionsPayload? = null,
    val subsStatus: AuxStatus = AuxStatus.Idle,
    val history: List<HistoryDay> = emptyList(),
    val historyCursor: String? = null,
    val historyHasMore: Boolean = false,
    val historyLoading: Boolean = false,
    val historyStatus: AuxStatus = AuxStatus.Idle,
    val historyError: String? = null,
    val historyFallback: Boolean = false,
    val historyDayBasis: String? = null,
    val historyMixedTz: Boolean = false,
    val historyPartial: Boolean = false,
    val historyPartialErrors: List<String> = emptyList(),
    val historyRetentionDays: Int = 370,
    val modelPeriod: Period = Period.Today,
    val clientPeriod: Period = Period.Today,
    val mxPeriod: Period = Period.Today,
    val mxCost: Boolean = false,
    val actView: Int = 2,
    val lastUpdated: Long? = null,
    val showUpdate: Boolean = false,
    val update: SystemUpdate? = null,
    val updateLoading: Boolean = false,
    val updateError: String? = null,
) {
    override fun toString(): String {
        val tokenMark = if (token.isBlank()) "" else "•••"
        return "UiState(signedIn=$signedIn, demo=$demo, hubUrl=$hubUrl, token=$tokenMark, tab=$tab, loading=$loading)"
    }
}

class AppViewModel(app: Application) : AndroidViewModel(app) {
    private val store = SessionStore(app)
    private val hub = HubClient(beforeRequest = { url -> LocalNetworkAccess.ensureAccess(app, url) })
    private var poll: Job? = null
    private var dataJob: Job? = null
    private var historyJob: Job? = null
    private var historyRetryJob: Job? = null
    private var updateJob: Job? = null
    private var toastJob: Job? = null
    private var sessionGen = 0
    private var demoRng = Random.Default
    private var sessionToken: String = ""
    private val foreground = MutableStateFlow(true)
    private val modelPalette = ColorRegistry()
    private val clientPalette = ColorRegistry()

    private val _bootstrapped = MutableStateFlow(false)
    val bootstrapped: StateFlow<Boolean> = _bootstrapped

    private val _state = MutableStateFlow(UiState())
    val state: StateFlow<UiState> = _state

    init {
        viewModelScope.launch {
            withContext(Dispatchers.IO) { store.ensureSecrets() }
            if (sessionGen != 0) {
                _bootstrapped.value = true
                return@launch
            }
            sessionToken = if (store.signedIn && !store.demo) store.token else ""
            _state.update {
                it.copy(
                    signedIn = store.signedIn,
                    demo = store.demo,
                    hubUrl = store.hubUrl,
                    encryptionAvailable = store.encryptionAvailable,
                    dark = when (store.darkOverride) {
                        "dark" -> true
                        "light" -> false
                        else -> null
                    },
                )
            }
            _bootstrapped.value = true
            if (store.signedIn && sessionGen == 0) {
                refresh(initial = true)
                if (!store.demo) startPoll()
            }
        }
    }

    fun onUrl(v: String) = _state.update { it.copy(hubUrl = v) }
    fun onToken(v: String) = _state.update { it.copy(token = v) }
    fun selectTab(t: AppTab) = _state.update { it.copy(tab = t) }
    fun setModelPeriod(p: Period) = _state.update { it.copy(modelPeriod = p) }
    fun setClientPeriod(p: Period) = _state.update { it.copy(clientPeriod = p) }
    fun setMxPeriod(p: Period) = _state.update { it.copy(mxPeriod = p) }
    fun setMxCost(v: Boolean) = _state.update { it.copy(mxCost = v) }
    fun setActView(v: Int) = _state.update { it.copy(actView = v) }
    fun dismissToast() = _state.update { it.copy(toast = null) }
    fun closeUpdate() = _state.update { it.copy(showUpdate = false, updateError = null) }

    /** 前后台切换（对齐网页 document.hidden：后台暂停轮询，回前台数据过期则立即补一拍）。 */
    fun setForeground(v: Boolean) {
        foreground.value = v
        if (!v) return
        val s = _state.value
        val stale = s.lastUpdated == null || System.currentTimeMillis() - s.lastUpdated > POLL_MS
        if (s.signedIn && !s.demo && stale && !s.loading && !s.refreshing) refresh()
    }

    fun toggleDark(systemDark: Boolean) {
        val cur = _state.value.dark ?: systemDark
        val next = !cur
        store.darkOverride = if (next) "dark" else "light"
        _state.update { it.copy(dark = next) }
    }

    fun enterDemo() {
        bumpSession()
        demoRng = Random.Default
        sessionToken = ""
        _state.update {
            it.copy(
                signedIn = true,
                demo = true,
                token = "",
                gateError = null,
                error = null,
                sessionWarning = null,
                tab = AppTab.Overview,
                staleData = false,
            )
        }
        viewModelScope.launch(Dispatchers.IO) { store.persistSession(demoMode = true, accessToken = "") }
        refresh(initial = true)
        poll?.cancel()
    }

    fun login() {
        val url = _state.value.hubUrl.trim()
        val token = _state.value.token.trim()
        if (url.isEmpty()) {
            _state.update { it.copy(gateError = "请填写面板地址") }
            return
        }
        if (token.isEmpty()) {
            _state.update { it.copy(gateError = "请填写访问密钥") }
            return
        }
        bumpSession()
        val gen = sessionGen
        dataJob = viewModelScope.launch {
            _state.update { it.copy(loading = true, gateError = null) }
            try {
                withContext(Dispatchers.IO) { store.ensureSecrets() }
                if (!sameSession(gen)) return@launch
                val ov = withContext(Dispatchers.IO) { hub.overview(url, token) }
                if (!sameSession(gen)) return@launch
                sessionToken = token
                withContext(Dispatchers.IO) {
                    store.hubUrl = HubClient.normalizeBase(url)
                    store.persistSession(demoMode = false, accessToken = token)
                }
                if (!sameSession(gen)) return@launch
                val warn = if (store.encryptionAvailable) null else "系统密钥库不可用，本次不会记住密钥"
                _state.update {
                    it.copy(
                        signedIn = true,
                        demo = false,
                        hubUrl = store.hubUrl,
                        token = "",
                        loading = false,
                        overview = ov,
                        lastUpdated = System.currentTimeMillis(),
                        tab = AppTab.Overview,
                        sessionWarning = warn,
                        staleData = false,
                        error = null,
                    )
                }
                loadAux(store.hubUrl, token, ov, gen)
                if (alive(gen)) startPoll()
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiException) {
                if (!sameSession(gen)) return@launch
                _state.update { it.copy(loading = false, gateError = gateMessage(e)) }
            } catch (e: Exception) {
                if (!sameSession(gen)) return@launch
                _state.update { it.copy(loading = false, gateError = e.message ?: "登录失败") }
            }
        }
    }

    fun logout() {
        applyLoggedOut()
        dataJob?.cancel()
        dataJob = null
    }

    fun refresh(initial: Boolean = false) {
        val s = _state.value
        if (!s.signedIn) return
        val gen = sessionGen
        val demo = s.demo
        val url = s.hubUrl
        val token = sessionToken
        dataJob?.cancel()
        historyJob?.cancel()
        dataJob = viewModelScope.launch {
            _state.update { it.copy(refreshing = !initial, loading = initial, error = null) }
            try {
                if (demo) {
                    val ov = DemoCatalog.overview(demoRng)
                    if (!alive(gen)) return@launch
                    applyHistoryPage(DemoCatalog.historyPage(null, rng = demoRng), replace = true, fallback = false)
                    _state.update {
                        it.copy(
                            overview = ov,
                            providers = DemoCatalog.providerStatus(ov).providers,
                            providersStatus = AuxStatus.Ready,
                            providersPartial = false,
                            providersPartialErrors = emptyList(),
                            subscriptions = DemoCatalog.subscriptions(demoRng),
                            subsStatus = AuxStatus.Ready,
                            loading = false,
                            refreshing = false,
                            lastUpdated = System.currentTimeMillis(),
                            staleData = false,
                        )
                    }
                    if (!initial) toast("已重新生成演示数据")
                } else {
                    val ov = withContext(Dispatchers.IO) { hub.overview(url, token) }
                    if (!alive(gen)) return@launch
                    _state.update {
                        it.copy(
                            overview = ov,
                            loading = false,
                            refreshing = false,
                            lastUpdated = System.currentTimeMillis(),
                            staleData = false,
                        )
                    }
                    loadAux(url, token, ov, gen)
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiException) {
                if (!alive(gen)) return@launch
                if (e.status == 401 || e.status == 403) {
                    applyLoggedOut(gateMessage(e))
                } else {
                    _state.update {
                        it.copy(
                            loading = false,
                            refreshing = false,
                            error = e.message,
                            staleData = it.overview != null,
                        )
                    }
                    if (_state.value.overview != null) toast("${e.message}，显示上一份数据")
                }
            } catch (e: Exception) {
                if (!alive(gen)) return@launch
                _state.update {
                    it.copy(
                        loading = false,
                        refreshing = false,
                        error = e.message ?: "刷新失败",
                        staleData = it.overview != null,
                    )
                }
            }
        }
    }

    fun loadMoreHistory() {
        val s = _state.value
        if (!s.signedIn || s.historyLoading || !s.historyHasMore || s.historyFallback) return
        val gen = sessionGen
        val demo = s.demo
        val url = s.hubUrl
        val token = sessionToken
        val cursor = s.historyCursor
        historyJob?.cancel()
        _state.update { it.copy(historyLoading = true, historyError = null) }
        historyJob = viewModelScope.launch {
            try {
                val page = if (demo) {
                    DemoCatalog.historyPage(cursor, rng = demoRng)
                } else {
                    withContext(Dispatchers.IO) { hub.historyDaily(url, token, cursor) }
                }
                if (!alive(gen)) return@launch
                applyHistoryPage(page, replace = false, fallback = false)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (!alive(gen)) return@launch
                _state.update {
                    it.copy(
                        historyLoading = false,
                        historyStatus = AuxStatus.Error,
                        historyError = e.message ?: "加载更早记录失败",
                    )
                }
            }
        }
    }

    fun openUpdate() {
        val s = _state.value
        if (!s.signedIn) return
        val gen = sessionGen
        val demo = s.demo
        val url = s.hubUrl
        val token = sessionToken
        _state.update { it.copy(showUpdate = true, updateLoading = true, updateError = null) }
        updateJob?.cancel()
        updateJob = viewModelScope.launch {
            try {
                val data = if (demo) {
                    DemoCatalog.updateCheck()
                } else {
                    withContext(Dispatchers.IO) { hub.systemUpdate(url, token, refresh = true) }
                }
                if (!alive(gen)) return@launch
                _state.update { it.copy(update = data, updateLoading = false, updateError = null) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (!alive(gen)) return@launch
                _state.update {
                    it.copy(
                        updateLoading = false,
                        updateError = e.message ?: "检索失败",
                    )
                }
            }
        }
    }

    private fun sameSession(gen: Int): Boolean = gen == sessionGen
    private fun alive(gen: Int): Boolean = sameSession(gen) && _state.value.signedIn

    private fun bumpSession() {
        sessionGen++
        dataJob?.cancel()
        historyJob?.cancel()
        historyRetryJob?.cancel()
        updateJob?.cancel()
        poll?.cancel()
        dataJob = null
        historyJob = null
        historyRetryJob = null
        updateJob = null
        modelPalette.reset()
        clientPalette.reset()
    }

    private fun applyLoggedOut(gateError: String? = null) {
        bumpSession()
        sessionToken = ""
        store.markSignedOut()
        viewModelScope.launch(Dispatchers.IO) { store.clearToken() }
        _state.update {
            UiState(
                signedIn = false,
                hubUrl = store.hubUrl,
                encryptionAvailable = store.encryptionAvailable,
                dark = it.dark,
                gateError = gateError,
            )
        }
    }

    private fun gateMessage(e: ApiException): String = when {
        e.status == 401 -> "密钥不正确，请重新输入。"
        e.status == 403 -> "没有访问权限。"
        e.status == 500 && e.message.contains(Regex("密钥|token", RegexOption.IGNORE_CASE)) ->
            "服务器访问令牌未配置，请先在后端设置 ACCESS_TOKEN。"
        else -> e.message
    }

    private suspend fun loadAux(url: String, token: String, ov: Overview, gen: Int) {
        val failed = mutableListOf<String>()
        if (!ov.features.providerStatus) {
            if (!alive(gen)) return
            _state.update {
                it.copy(
                    providers = emptyList(),
                    providersStatus = AuxStatus.Unsupported,
                    providersPartial = false,
                    providersPartialErrors = emptyList(),
                )
            }
        } else {
            try {
                val pv = withContext(Dispatchers.IO) { hub.providerStatus(url, token) }
                if (!alive(gen)) return
                _state.update {
                    it.copy(
                        providers = pv.providers,
                        providersStatus = if (pv.providers.isEmpty()) AuxStatus.Empty else AuxStatus.Ready,
                        providersPartial = pv.partial,
                        providersPartialErrors = pv.errors,
                    )
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiException) {
                if (!alive(gen)) return
                if (e.status == 401 || e.status == 403) {
                    applyLoggedOut(gateMessage(e))
                    return
                }
                val st = if (e.status == 404) AuxStatus.Unsupported else AuxStatus.Error
                _state.update { it.copy(providers = emptyList(), providersStatus = st) }
                if (st == AuxStatus.Error) failed += "提供商状态"
            } catch (_: Exception) {
                if (!alive(gen)) return
                _state.update { it.copy(providers = emptyList(), providersStatus = AuxStatus.Error) }
                failed += "提供商状态"
            }
        }

        if (!ov.features.subscriptions) {
            if (!alive(gen)) return
            _state.update { it.copy(subscriptions = null, subsStatus = AuxStatus.Unsupported) }
        } else {
            try {
                val sub = withContext(Dispatchers.IO) { hub.subscriptions(url, token) }
                if (!alive(gen)) return
                val empty = sub.subscriptions.isEmpty()
                _state.update {
                    it.copy(
                        subscriptions = sub,
                        subsStatus = if (empty) AuxStatus.Empty else AuxStatus.Ready,
                    )
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiException) {
                if (!alive(gen)) return
                if (e.status == 401 || e.status == 403) {
                    applyLoggedOut(gateMessage(e))
                    return
                }
                val st = if (e.status == 404) AuxStatus.Unsupported else AuxStatus.Error
                _state.update { it.copy(subscriptions = null, subsStatus = st) }
                if (st == AuxStatus.Error) failed += "订阅清单"
            } catch (_: Exception) {
                if (!alive(gen)) return
                _state.update { it.copy(subscriptions = null, subsStatus = AuxStatus.Error) }
                failed += "订阅清单"
            }
        }

        if (!ov.features.historyDaily) {
            if (!alive(gen)) return
            applyFallbackHistory(ov, "overview")
        } else {
            try {
                val hist = withContext(Dispatchers.IO) { hub.historyDaily(url, token, null) }
                if (!alive(gen)) return
                applyHistoryPage(hist, replace = true, fallback = false)
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiException) {
                if (!alive(gen)) return
                if (e.status == 401 || e.status == 403) {
                    applyLoggedOut(gateMessage(e))
                    return
                }
                if (e.status == 404) {
                    applyFallbackHistory(ov, "unsupported")
                } else {
                    applyFallbackHistory(ov, e.message)
                    failed += "日归档"
                    scheduleHistoryRetry(url, token, gen)
                }
            } catch (e: Exception) {
                if (!alive(gen)) return
                applyFallbackHistory(ov, e.message ?: "日归档加载失败")
                failed += "日归档"
                scheduleHistoryRetry(url, token, gen)
            }
        }
        if (failed.isNotEmpty() && alive(gen)) toast("部分数据暂不可用（${failed.joinToString("、")}）")
    }

    private fun applyHistoryPage(
        page: io.github.iroha1145.cloudmonitor.data.HistoryPage,
        replace: Boolean,
        fallback: Boolean,
    ) {
        _state.update {
            val items = mergeHistoryDays(if (replace) emptyList() else it.history, page.items)
            it.copy(
                history = items,
                historyCursor = page.nextCursor,
                historyHasMore = page.hasMore && !fallback,
                historyLoading = false,
                historyStatus = if (items.isEmpty()) AuxStatus.Empty else AuxStatus.Ready,
                historyError = null,
                historyFallback = fallback,
                historyDayBasis = page.dayBasis,
                historyMixedTz = page.mixedTimeZones,
                historyPartial = page.partial,
                historyPartialErrors = page.partialErrors,
                historyRetentionDays = page.retentionDays ?: 370,
            )
        }
    }

    private fun applyFallbackHistory(ov: Overview, reason: String) {
        val rows = ov.activity.daily.sortedByDescending { it.day }.map {
            HistoryDay(it.day, it.total, perModel = it.models)
        }
        _state.update {
            it.copy(
                history = mergeHistoryDays(emptyList(), rows),
                historyCursor = null,
                historyHasMore = false,
                historyLoading = false,
                historyStatus = if (reason == "unsupported" || reason == "overview") {
                    if (rows.isEmpty()) AuxStatus.Empty else AuxStatus.Unsupported
                } else AuxStatus.Error,
                historyError = if (reason == "unsupported" || reason == "overview") null else reason,
                historyFallback = true,
                historyDayBasis = null,
                historyMixedTz = false,
                historyPartial = false,
                historyPartialErrors = emptyList(),
            )
        }
    }

    private fun toast(msg: String) {
        toastJob?.cancel()
        _state.update { it.copy(toast = msg) }
        toastJob = viewModelScope.launch {
            delay(2600)
            _state.update { if (it.toast == msg) it.copy(toast = null) else it }
        }
    }

    private fun startPoll() {
        poll?.cancel()
        poll = viewModelScope.launch {
            while (isActive) {
                delay(POLL_MS)
                // 后台时挂起，回前台再补这一拍（省电省流量，对齐网页隐藏页暂停轮询）
                foreground.first { it }
                val s = _state.value
                if (!isActive || !s.signedIn || s.demo) continue
                // setForeground 的补拍刚刷过就跳过本轮，避免连发两次
                if (s.lastUpdated != null && System.currentTimeMillis() - s.lastUpdated < 30_000) continue
                refresh()
            }
        }
    }

    /** 首页日归档加载失败后 60s 自动重试（对齐网页 HISTORY_RETRY_MS），成功即恢复正常分页。 */
    private fun scheduleHistoryRetry(url: String, token: String, gen: Int) {
        historyRetryJob?.cancel()
        historyRetryJob = viewModelScope.launch {
            delay(HISTORY_RETRY_MS)
            if (!alive(gen) || _state.value.demo) return@launch
            if (_state.value.historyStatus != AuxStatus.Error) return@launch
            try {
                val hist = withContext(Dispatchers.IO) { hub.historyDaily(url, token, null) }
                if (!alive(gen)) return@launch
                applyHistoryPage(hist, replace = true, fallback = false)
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                if (alive(gen)) scheduleHistoryRetry(url, token, gen)
            }
        }
    }

    /** 模型配色：先按累计用量排名铺排，再补齐其余来源出现过的名字；同名恒同色。 */
    fun modelColors(): Map<String, androidx.compose.ui.graphics.Color> {
        val ov = _state.value.overview ?: return modelPalette.snapshot()
        modelPalette.seed(rankedNames(ov.totals.allTime.models.ifEmpty { ov.totals.today.models }))
        modelPalette.seed(ov.totals.today.models.keys)
        modelPalette.seed(ov.totals.month.models.keys)
        ov.trendModels.forEach { modelPalette.seed(it.models.keys) }
        _state.value.history.forEach { modelPalette.seed(it.perModel.keys) }
        return modelPalette.snapshot()
    }

    fun clientColors(): Map<String, androidx.compose.ui.graphics.Color> {
        val ov = _state.value.overview ?: return clientPalette.snapshot()
        clientPalette.seed(rankedNames(ov.totals.allTime.clients.ifEmpty { ov.totals.today.clients }))
        clientPalette.seed(ov.totals.today.clients.keys)
        clientPalette.seed(ov.totals.month.clients.keys)
        _state.value.history.forEach { clientPalette.seed(it.perClient.keys) }
        return clientPalette.snapshot()
    }

    fun trend() = _state.value.overview?.let { trendRows(it) }.orEmpty()

    companion object {
        internal fun mergeHistoryDays(existing: List<HistoryDay>, incoming: List<HistoryDay>): List<HistoryDay> {
            if (incoming.isEmpty()) return existing
            val byDay = LinkedHashMap<String, HistoryDay>()
            existing.forEach { d -> if (d.day.isNotBlank()) byDay.putIfAbsent(d.day, d) }
            incoming.forEach { d ->
                if (d.day.isBlank()) return@forEach
                byDay.putIfAbsent(d.day, d)
            }
            return byDay.values.toList()
        }
    }
}
