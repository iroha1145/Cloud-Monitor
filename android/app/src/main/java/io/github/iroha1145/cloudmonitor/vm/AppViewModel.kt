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

data class UiState(
    val signedIn: Boolean = false,
    val demo: Boolean = false,
    val hubUrl: String = "",
    val token: String = "",
    val dark: Boolean? = null,
    val tab: AppTab = AppTab.Overview,
    val loading: Boolean = false,
    val refreshing: Boolean = false,
    val error: String? = null,
    val gateError: String? = null,
    val overview: Overview? = null,
    val providers: List<ProviderCard> = emptyList(),
    val subscriptions: SubscriptionsPayload? = null,
    val history: List<HistoryDay> = emptyList(),
    val historyCursor: String? = null,
    val historyHasMore: Boolean = false,
    val historyLoading: Boolean = false,
    val modelPeriod: Period = Period.Today,
    val clientPeriod: Period = Period.Today,
    val mxPeriod: Period = Period.Today,
    val mxCost: Boolean = false,
    val actView: Int = 2, // 0 day 1 week 2 month
    val lastUpdated: Long? = null,
)

class AppViewModel(app: Application) : AndroidViewModel(app) {
    private val store = SessionStore(app)
    private val hub = HubClient()
    private var poll: Job? = null
    private var demoRng = Random.Default

    private val _state = MutableStateFlow(
        UiState(
            signedIn = store.signedIn,
            demo = store.demo,
            hubUrl = store.hubUrl,
            token = if (store.signedIn && !store.demo) store.token else "",
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

    fun toggleDark(systemDark: Boolean) {
        val cur = _state.value.dark ?: systemDark
        val next = !cur
        store.darkOverride = if (next) "dark" else "light"
        _state.update { it.copy(dark = next) }
    }

    fun enterDemo() {
        demoRng = Random.Default
        store.demo = true
        store.signedIn = true
        store.token = ""
        _state.update {
            it.copy(signedIn = true, demo = true, gateError = null, error = null, tab = AppTab.Overview)
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
                store.hubUrl = HubClient.normalizeBase(url)
                store.token = token
                store.demo = false
                store.signedIn = true
                _state.update {
                    it.copy(
                        signedIn = true,
                        demo = false,
                        hubUrl = store.hubUrl,
                        loading = false,
                        overview = ov,
                        lastUpdated = System.currentTimeMillis(),
                        tab = AppTab.Overview,
                    )
                }
                loadAux(store.hubUrl, token, false)
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
        store.clearSecrets()
        _state.update {
            UiState(
                signedIn = false,
                hubUrl = store.hubUrl,
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
                    val hist = DemoCatalog.historyPage(null, rng = demoRng)
                    _state.update {
                        it.copy(
                            overview = ov,
                            providers = DemoCatalog.providerStatus(ov).providers,
                            subscriptions = DemoCatalog.subscriptions(demoRng),
                            history = hist.items,
                            historyCursor = hist.nextCursor,
                            historyHasMore = hist.hasMore,
                            loading = false,
                            refreshing = false,
                            lastUpdated = System.currentTimeMillis(),
                        )
                    }
                } else {
                    val ov = withContext(Dispatchers.IO) { hub.overview(s.hubUrl, store.token) }
                    _state.update {
                        it.copy(
                            overview = ov,
                            loading = false,
                            refreshing = false,
                            lastUpdated = System.currentTimeMillis(),
                        )
                    }
                    loadAux(s.hubUrl, store.token, false)
                }
            } catch (e: ApiException) {
                if (e.status == 401 || e.status == 403) {
                    logout()
                    _state.update { it.copy(gateError = e.message) }
                } else {
                    _state.update { it.copy(loading = false, refreshing = false, error = e.message) }
                }
            } catch (e: Exception) {
                _state.update { it.copy(loading = false, refreshing = false, error = e.message ?: "刷新失败") }
            }
        }
    }

    fun loadMoreHistory() {
        val s = _state.value
        if (!s.signedIn || s.historyLoading || !s.historyHasMore) return
        viewModelScope.launch {
            _state.update { it.copy(historyLoading = true) }
            try {
                val page = if (s.demo) {
                    DemoCatalog.historyPage(s.historyCursor, rng = demoRng)
                } else {
                    withContext(Dispatchers.IO) { hub.historyDaily(s.hubUrl, store.token, s.historyCursor) }
                }
                _state.update {
                    it.copy(
                        history = it.history + page.items,
                        historyCursor = page.nextCursor,
                        historyHasMore = page.hasMore,
                        historyLoading = false,
                    )
                }
            } catch (_: Exception) {
                _state.update { it.copy(historyLoading = false) }
            }
        }
    }

    private suspend fun loadAux(url: String, token: String, demo: Boolean) {
        if (demo) return
        try {
            val pv = withContext(Dispatchers.IO) { hub.providerStatus(url, token) }
            _state.update { it.copy(providers = pv.providers) }
        } catch (_: Exception) {
            _state.update { it.copy(providers = emptyList()) }
        }
        try {
            val sub = withContext(Dispatchers.IO) { hub.subscriptions(url, token) }
            _state.update { it.copy(subscriptions = sub) }
        } catch (_: Exception) {
            _state.update { it.copy(subscriptions = null) }
        }
        try {
            val hist = withContext(Dispatchers.IO) { hub.historyDaily(url, token, null) }
            _state.update {
                it.copy(
                    history = hist.items,
                    historyCursor = hist.nextCursor,
                    historyHasMore = hist.hasMore,
                )
            }
        } catch (_: Exception) {
            /* keep empty; history screen falls back to overview activity */
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
