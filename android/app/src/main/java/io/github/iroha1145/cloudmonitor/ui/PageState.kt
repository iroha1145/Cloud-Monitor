package io.github.iroha1145.cloudmonitor.ui

import androidx.compose.runtime.Stable
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.listSaver

/** User choices belong to the page, so scrolling lazy content cannot discard them. */
@Stable
class PageState(selection: String = "全部") {
    val query = mutableStateOf("")
    val selection = mutableStateOf(selection)
    val sortCost = mutableStateOf(false)
    val todayOnly = mutableStateOf(false)
    val limit = mutableIntStateOf(8)
    val trendDays = mutableIntStateOf(30)
    val trendMetric = mutableStateOf("tokens")
    val trendDay = mutableStateOf("")
    val summaryPeriod = mutableStateOf("Today")
    val activityDay = mutableStateOf("")
    val modelSort = mutableIntStateOf(0)
    val modelProvider = mutableStateOf("全部")

    companion object {
        val Saver = listSaver<PageState, Any>(
            save = { listOf(it.query.value, it.selection.value, it.sortCost.value, it.todayOnly.value,
                it.limit.intValue, it.trendDays.intValue,                 it.summaryPeriod.value, it.trendMetric.value, it.trendDay.value,
                it.activityDay.value, it.modelSort.intValue, it.modelProvider.value) },
            restore = { values -> PageState(values[1] as String).apply {
                query.value = values[0] as String
                sortCost.value = values[2] as Boolean
                todayOnly.value = values[3] as Boolean
                limit.intValue = values[4] as Int
                trendDays.intValue = values[5] as Int
                summaryPeriod.value = values[6] as String
                trendMetric.value = values.getOrNull(7) as? String ?: "tokens"
                trendDay.value = values.getOrNull(8) as? String ?: ""
                activityDay.value = values.getOrNull(9) as? String ?: ""
                modelSort.intValue = values.getOrNull(10) as? Int ?: 0
                modelProvider.value = values.getOrNull(11) as? String ?: "全部"
            } },
        )
    }
}
