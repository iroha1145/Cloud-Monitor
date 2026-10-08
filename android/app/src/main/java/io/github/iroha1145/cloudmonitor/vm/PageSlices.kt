package io.github.iroha1145.cloudmonitor.vm

import io.github.iroha1145.cloudmonitor.data.HistoryDay
import io.github.iroha1145.cloudmonitor.data.Overview
import io.github.iroha1145.cloudmonitor.data.ProviderCard
import io.github.iroha1145.cloudmonitor.data.SubscriptionsPayload
import io.github.iroha1145.cloudmonitor.data.SystemUpdate
import io.github.iroha1145.cloudmonitor.data.workspaceNotices

/** Chrome around the signed-in pages. Toast and theme live here; page bodies do not collect this. */
data class ShellState(
    val signedIn: Boolean = false,
    val demo: Boolean = false,
    val dark: Boolean? = null,
    val tab: AppTab = AppTab.Overview,
    val refreshing: Boolean = false,
    val toast: String? = null,
    val showUpdate: Boolean = false,
    val updateLoading: Boolean = false,
    val updateError: String? = null,
    val update: SystemUpdate? = null,
)

/** Login form. Typing the address does not rebuild the signed-in pages. */
data class GateState(
    val hubUrl: String = "",
    val token: String = "",
    val rememberToken: Boolean = false,
    val encryptionAvailable: Boolean = true,
    val loading: Boolean = false,
    val gateError: String? = null,
    val keyRejected: Boolean = false,
    val shakeNonce: Int = 0,
    val dark: Boolean? = null,
) {
    fun asUiState(): UiState = UiState(
        hubUrl = hubUrl,
        token = token,
        rememberToken = rememberToken,
        encryptionAvailable = encryptionAvailable,
        loading = loading,
        gateError = gateError,
        keyRejected = keyRejected,
        shakeNonce = shakeNonce,
        dark = dark,
    )
}

/** Connection header inside the list. It does not include the toast. */
data class HeaderState(
    val demo: Boolean = false,
    val tab: AppTab = AppTab.Overview,
    val refreshing: Boolean = false,
    val loading: Boolean = false,
    val error: String? = null,
    val sessionWarning: String? = null,
    val lastUpdated: Long? = null,
    val generatedAt: String? = null,
    val zone: String? = null,
    val today: String? = null,
    val notices: List<String> = emptyList(),
    val noticesOpen: Boolean = false,
    val overviewReady: Boolean = false,
)

data class OverviewPage(
    val overview: Overview? = null,
    val history: List<HistoryDay> = emptyList(),
    val clientPeriod: Period = Period.Today,
    val providers: List<ProviderCard> = emptyList(),
    val providersStatus: AuxStatus = AuxStatus.Idle,
    val providersPartial: Boolean = false,
    val providersPartialErrors: List<String> = emptyList(),
)

data class ModelsPage(
    val overview: Overview? = null,
    val modelPeriod: Period = Period.Today,
    val mxPeriod: Period = Period.Today,
    val mxCost: Boolean = false,
)

data class QuotaPage(
    val overview: Overview? = null,
    val subscriptions: SubscriptionsPayload? = null,
    val subsStatus: AuxStatus = AuxStatus.Idle,
)

data class HistoryPage(
    val overview: Overview? = null,
    val history: List<HistoryDay> = emptyList(),
    val actView: Int = 2,
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
)

internal fun UiState.toShell(): ShellState = ShellState(
    signedIn = signedIn,
    demo = demo,
    dark = dark,
    tab = tab,
    refreshing = refreshing,
    toast = toast,
    showUpdate = showUpdate,
    updateLoading = updateLoading,
    updateError = updateError,
    update = update,
)

internal fun UiState.toGate(): GateState = GateState(
    hubUrl = hubUrl,
    token = token,
    rememberToken = rememberToken,
    encryptionAvailable = encryptionAvailable,
    loading = loading,
    gateError = gateError,
    keyRejected = keyRejected,
    shakeNonce = shakeNonce,
    dark = dark,
)

internal fun UiState.toHeader(): HeaderState {
    val overview = overview
    return HeaderState(
        demo = demo,
        tab = tab,
        refreshing = refreshing,
        loading = loading,
        error = error,
        sessionWarning = sessionWarning,
        lastUpdated = lastUpdated,
        generatedAt = overview?.generatedAt,
        zone = overview?.dashboardTimeZone?.takeIf { it.isNotBlank() },
        today = overview?.dashboardPeriod?.today?.key?.takeIf { it.isNotBlank() },
        notices = overview?.let {
            workspaceNotices(
                it,
                providers,
                subscriptionsFailed = subscriptionsLoadFailed || subsStatus == AuxStatus.Error,
                providersFailed = providersLoadFailed || providersStatus == AuxStatus.Error,
                historyFailed = historyLoadFailed || historyStatus == AuxStatus.Error,
                staleData = staleData,
                historyCostRetained = historyCostRetained,
                historyComponentsRetained = historyComponentsRetained,
            )
        }.orEmpty(),
        noticesOpen = staleData || error != null,
        overviewReady = overview != null,
    )
}

internal fun UiState.toOverviewPage(): OverviewPage = OverviewPage(
    overview = overview,
    history = history,
    clientPeriod = clientPeriod,
    providers = providers,
    providersStatus = providersStatus,
    providersPartial = providersPartial,
    providersPartialErrors = providersPartialErrors,
)

internal fun UiState.toModelsPage(): ModelsPage = ModelsPage(
    overview = overview,
    modelPeriod = modelPeriod,
    mxPeriod = mxPeriod,
    mxCost = mxCost,
)

internal fun UiState.toQuotaPage(): QuotaPage = QuotaPage(
    overview = overview,
    subscriptions = subscriptions,
    subsStatus = subsStatus,
)

internal fun UiState.toHistoryPage(): HistoryPage = HistoryPage(
    overview = overview,
    history = history,
    actView = actView,
    historyHasMore = historyHasMore,
    historyLoading = historyLoading,
    historyStatus = historyStatus,
    historyError = historyError,
    historyFallback = historyFallback,
    historyDayBasis = historyDayBasis,
    historyMixedTz = historyMixedTz,
    historyPartial = historyPartial,
    historyPartialErrors = historyPartialErrors,
    historyRetentionDays = historyRetentionDays,
)
