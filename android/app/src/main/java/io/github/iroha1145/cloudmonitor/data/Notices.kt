package io.github.iroha1145.cloudmonitor.data

private val PARTIAL_ERROR_NOTICE = mapOf(
    "overview_stale" to "数据源暂时不可用，正在显示上次总览。",
    "history_unavailable" to "官方历史记录暂时不可用，趋势可能不完整。",
    "devices_badges_unavailable" to "设备徽章暂时不可用。",
    "activity_unavailable" to "活动时间数据暂时不可用。",
    "clients_json_corrupt" to "日归档的客户端明细损坏。",
    "models_json_corrupt" to "日归档的模型明细损坏。",
)

private val LIMIT_STATUS_NOTICE = mapOf(
    "ok" to null,
    "disabled" to null,
    "notConfigured" to null,
    "unauthorized" to "额度来源授权失效",
    "rateLimited" to "已达速率限制",
    "sourceRateLimited" to "状态源限流",
    "unavailable" to "来源暂不可用",
    "error" to "额度来源读取失败",
)

/** Same notice list as hub/dashboard `normalizeOverview`, plus auxiliary load failures. */
fun workspaceNotices(
    overview: Overview,
    providers: List<ProviderCard> = emptyList(),
    subscriptionsFailed: Boolean = false,
    providersFailed: Boolean = false,
    historyFailed: Boolean = false,
    staleData: Boolean = false,
): List<String> {
    val notices = mutableListOf<String>()
    var specificPartial = false
    overview.partialErrors.forEach { code ->
        PARTIAL_ERROR_NOTICE[code]?.let {
            notices += it
            specificPartial = true
        }
    }
    if (overview.partial && !specificPartial) {
        notices += "部分辅助数据暂不可用，用量总计仍来自设备上报。"
    }
    if (overview.snapshotDegraded) notices += "历史快照同步延迟，趋势可能尚未更新。"
    val forwarding = overview.forwardingOutbox.coerceAtLeast(0)
    val pendingSnapshots = (overview.pendingOutbox - forwarding).coerceAtLeast(0)
    if (forwarding > 0) {
        notices += "还有 ${Format.fmtInt(forwarding.toDouble())} 条上报等待服务恢复后确认，历史记录可能暂未更新。"
    }
    if (pendingSnapshots > 0) {
        notices += "还有 ${Format.fmtInt(pendingSnapshots.toDouble())} 条快照等待同步，历史记录可能尚未更新。"
    }
    if (overview.expiredUnconfirmedOutbox > 0) {
        notices += "有 ${Format.fmtInt(overview.expiredUnconfirmedOutbox.toDouble())} 条较早的上报未能完成同步，历史记录可能存在缺口。"
    }
    if (staleData || overview.stale || overview.staleData) {
        notices += "当前显示的是上一次数据，可能已经过期。"
    }
    val today = usageComponents(overview.totals.today)
    if (today.partial) notices += "已保留可识别的缓存与输出，其余用量列为未分类。"
    if (today.known && !today.complete) notices += "今日组件合计与总量不一致，缓存占比暂不显示。"
    if (overview.sessionsOmitted || overview.sessionsMeta.sessionDetailsIncomplete) {
        notices += "当前快照未包含全部会话详情，不能用会话列表反推全部用量。"
    }
    overview.limits.forEach { provider ->
        val name = Format.fmtProvider(provider.provider)
        if (provider.stale) {
            notices += "$name 额度尚未刷新，保留上一次上报。"
        } else if (provider.status != null) {
            val mapped = if (LIMIT_STATUS_NOTICE.containsKey(provider.status)) {
                LIMIT_STATUS_NOTICE[provider.status]
            } else {
                "额度状态暂时无法识别，等待同步"
            }
            if (mapped != null) notices += "$name $mapped。"
        }
    }
    providers.forEach { provider ->
        if (provider.stale) {
            val name = provider.name.ifBlank { Format.fmtProvider(provider.provider) }
            notices += "$name 服务状态尚未刷新，正在显示上一次查询结果。"
        }
    }
    if (subscriptionsFailed && overview.features.subscriptions) notices += "订阅信息暂时未能加载。"
    if (providersFailed && overview.features.providerStatus) notices += "提供商状态暂时未能加载。"
    if (historyFailed && overview.features.historyDaily) notices += "每日费用明细暂时未能加载。"
    return notices
}
