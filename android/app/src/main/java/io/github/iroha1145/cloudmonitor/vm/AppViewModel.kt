package io.github.iroha1145.cloudmonitor.vm

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import io.github.iroha1145.cloudmonitor.data.ApiException
import io.github.iroha1145.cloudmonitor.data.DemoCatalog
import io.github.iroha1145.cloudmonitor.data.HistoryDay
import io.github.iroha1145.cloudmonitor.data.HubClient
import io.github.iroha1145.cloudmonitor.data.Overview
import io.github.iroha1145.cloudmonitor.data.ProviderCard
import io.github.iroha1145.cloudmonitor.data.SessionStore
import io.github.iroha1145.cloudmonitor.data.SubscriptionsPayload
import io.github.iroha1145.cloudmonitor.data.SystemUpdate
import io.github.iroha1145.cloudmonitor.data.assignColors
import io.github.iroha1145.cloudmonitor.data.rankedNames
import io.github.iroha1145.cloudmonitor.data.trendRows
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlin.random.Random

enum class AppTab { Overview, Devices, Quota, History }
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
)

class AppViewModel(app: Application) : AndroidViewModel(app) {
    private val store = SessionStore(app)
    private val hub = HubClient()
    private var poll: Job? = null
    private var toastJob: Job? = null
    private var demoRng = Random.Default
    private var sessionToken: String = if (store.signedIn && !store.demo) store.token else ""

    private val _state = MutableStateFlow(
        UiState(
            signedIn = store.signedIn,
            demo = store.demo,
            hubUrl = store.hubUrl,
            token = "",
            encryptionAvailable = store.encryptionAvailable,
            dark = when (store.darkOverride) {
                "dark" -> true
                "light" -> false
                else -> null
            },
        ),
    )
    val state: StateFlow<UiState> = _state

    init {
        if (store.signedIn) {
            refresh(initial = true)
            if (!store.demo) startPoll()
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

    fun toggleDark(systemDark: Boolean) {
        val cur = _state.value.dark ?: systemDark
        val next = !cur
        store.darkOverride = if (next) "dark" else "light"
        _state.update { it.copy(dark = next) }
    }

    fun enterDemo() {
        demoRng = Random.Default
        sessionToken = ""
        store.persistSession(demoMode = true, accessToken = "")
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
        viewModelScope.launch {
            _state.update { it.copy(loading = true, gateError = null) }
            try {
                val ov = withContext(Dispatchers.IO) { hub.overview(url, token) }
                sessionToken = token
                store.hubUrl = HubClient.normalizeBase(url)
                store.persistSession(demoMode = false, accessToken = token)
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
                loadAux(store.hubUrl, token, ov)
                startPoll()
            } catch (e: ApiException) {
                _state.update { it.copy(loading = false, gateError = e.message) }
            } catch (e: Exception) {
                _state.update { it.copy(loading = false, gateError = e.message ?: "登录失败") }
            }
        }
    }

    fun logout() {
        poll?.cancel()
        sessionToken = ""
        store.clearSecrets()
        _state.update {
            UiState(
                signedIn = false,
                hubUrl = store.hubUrl,
                encryptionAvailable = store.encryptionAvailable,
                dark = it.dark,
            )
        }
    }

    fun refresh(initial: Boolean = false) {
        val s = _state.value
        if (!s.signedIn) return
        viewModelScope.launch {
            _state.update { it.copy(refreshing = !initial, loading = initial, error = null) }
            try {
                if (s.demo) {
                    val ov = DemoCatalog.overview(demoRng)
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
                    val ov = withContext(Dispatchers.IO) { hub.overview(s.hubUrl, accessToken()) }
                    _state.update {
                        it.copy(
                            overview = ov,
                            loading = false,
                            refreshing = false,
                            lastUpdated = System.currentTimeMillis(),
                            staleData = false,
                        )
                    }
                    loadAux(s.hubUrl, accessToken(), ov)
                }
            } catch (e: ApiException) {
                if (e.status == 401 || e.status == 403) {
                    logout()
                    _state.update { it.copy(gateError = e.message) }
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
        viewModelScope.launch {
            _state.update { it.copy(historyLoading = true, historyError = null) }
            try {
                val page = if (s.demo) {
                    DemoCatalog.historyPage(s.historyCursor, rng = demoRng)
                } else {
                    withContext(Dispatchers.IO) { hub.historyDaily(s.hubUrl, accessToken(), s.historyCursor) }
                }
                applyHistoryPage(page, replace = false, fallback = false)
            } catch (e: Exception) {
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
        _state.update { it.copy(showUpdate = true, updateLoading = true, updateError = null) }
        viewModelScope.launch {
            try {
                val data = if (s.demo) {
                    DemoCatalog.updateCheck()
                } else {
                    withContext(Dispatchers.IO) { hub.systemUpdate(s.hubUrl, accessToken(), refresh = true) }
                }
                _state.update { it.copy(update = data, updateLoading = false, updateError = null) }
            } catch (e: Exception) {
                _state.update {
                    it.copy(
                        updateLoading = false,
                        updateError = e.message ?: "检索失败",
                    )
                }
            }
        }
    }

    private fun accessToken(): String = sessionToken.ifBlank { store.token }

    private suspend fun loadAux(url: String, token: String, ov: Overview) {
        val failed = mutableListOf<String>()
        if (!ov.features.providerStatus) {
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
                _state.update {
                    it.copy(
                        providers = pv.providers,
                        providersStatus = if (pv.providers.isEmpty()) AuxStatus.Empty else AuxStatus.Ready,
                        providersPartial = pv.partial,
                        providersPartialErrors = pv.errors,
                    )
                }
            } catch (e: ApiException) {
                val st = if (e.status == 404) AuxStatus.Unsupported else AuxStatus.Error
                _state.update { it.copy(providers = emptyList(), providersStatus = st) }
                if (st == AuxStatus.Error) failed += "提供商状态"
            } catch (_: Exception) {
                _state.update { it.copy(providers = emptyList(), providersStatus = AuxStatus.Error) }
                failed += "提供商状态"
            }
        }

        if (!ov.features.subscriptions) {
            _state.update { it.copy(subscriptions = null, subsStatus = AuxStatus.Unsupported) }
        } else {
            try {
                val sub = withContext(Dispatchers.IO) { hub.subscriptions(url, token) }
                val empty = sub.subscriptions.isEmpty()
                _state.update {
                    it.copy(
                        subscriptions = sub,
                        subsStatus = if (empty) AuxStatus.Empty else AuxStatus.Ready,
                    )
                }
            } catch (e: ApiException) {
                val st = if (e.status == 404) AuxStatus.Unsupported else AuxStatus.Error
                _state.update { it.copy(subscriptions = null, subsStatus = st) }
                if (st == AuxStatus.Error) failed += "订阅清单"
            } catch (_: Exception) {
                _state.update { it.copy(subscriptions = null, subsStatus = AuxStatus.Error) }
                failed += "订阅清单"
            }
        }

        if (!ov.features.historyDaily) {
            applyFallbackHistory(ov, "overview")
        } else {
            try {
                val hist = withContext(Dispatchers.IO) { hub.historyDaily(url, token, null) }
                applyHistoryPage(hist, replace = true, fallback = false)
            } catch (e: ApiException) {
                if (e.status == 404) {
                    applyFallbackHistory(ov, "unsupported")
                } else {
                    applyFallbackHistory(ov, e.message ?: "日归档加载失败")
                    failed += "日归档"
                }
            } catch (e: Exception) {
                applyFallbackHistory(ov, e.message ?: "日归档加载失败")
                failed += "日归档"
            }
        }
        if (failed.isNotEmpty()) toast("部分数据暂不可用（${failed.joinToString("、")}）")
    }

    private fun applyHistoryPage(
        page: io.github.iroha1145.cloudmonitor.data.HistoryPage,
        replace: Boolean,
        fallback: Boolean,
    ) {
        _state.update {
            val items = if (replace) page.items else it.history + page.items
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
                history = rows,
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
                delay(5 * 60 * 1000L)
                if (isActive && _state.value.signedIn && !_state.value.demo) refresh()
            }
        }
    }

    fun modelColors(): Map<String, androidx.compose.ui.graphics.Color> {
        val ov = _state.value.overview ?: return emptyMap()
        val names = rankedNames(ov.totals.allTime.models.ifEmpty { ov.totals.today.models })
        return assignColors(names)
    }

    fun clientColors(): Map<String, androidx.compose.ui.graphics.Color> {
        val ov = _state.value.overview ?: return emptyMap()
        val names = rankedNames(ov.totals.allTime.clients.ifEmpty { ov.totals.today.clients })
        return assignColors(names)
    }

    fun trend() = _state.value.overview?.let { trendRows(it) }.orEmpty()
}
