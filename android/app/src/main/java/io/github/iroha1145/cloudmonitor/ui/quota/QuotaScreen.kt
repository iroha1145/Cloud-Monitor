package io.github.iroha1145.cloudmonitor.ui.quota

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.github.iroha1145.cloudmonitor.data.Format
import io.github.iroha1145.cloudmonitor.ui.components.ClientLogo
import io.github.iroha1145.cloudmonitor.ui.components.EmptyHint
import io.github.iroha1145.cloudmonitor.ui.components.Panel
import io.github.iroha1145.cloudmonitor.ui.components.PanelHead
import io.github.iroha1145.cloudmonitor.ui.components.QuotaRing
import io.github.iroha1145.cloudmonitor.ui.theme.CmColorsCurrent
import io.github.iroha1145.cloudmonitor.ui.theme.riseIn
import io.github.iroha1145.cloudmonitor.vm.AuxStatus
import io.github.iroha1145.cloudmonitor.vm.UiState

fun LazyListScope.quotaItems(state: UiState) {
    val ov = state.overview
    val limits = ov?.limits.orEmpty()
    val showSubs = state.subsStatus != AuxStatus.Unsupported && ov?.features?.subscriptions != false
    val subs = if (showSubs) state.subscriptions?.subscriptions.orEmpty() else emptyList()
    if (limits.isEmpty() && !showSubs) {
        item { Panel { EmptyHint("暂无配额与订阅数据") } }
        return
    }
    if (limits.isEmpty() && showSubs && subs.isEmpty() && state.subsStatus != AuxStatus.Error) {
        item { Panel { EmptyHint("暂无配额与订阅数据") } }
        return
    }
    if (limits.isNotEmpty()) {
        item("limits") {
            val cm = CmColorsCurrent
            Panel(Modifier.padding(bottom = 12.dp).riseIn(0)) {
                PanelHead("订阅配额", "各 provider 账户的窗口用量与余额")
                Spacer(Modifier.height(8.dp))
                limits.forEach { l ->
                    Column(Modifier.padding(vertical = 10.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            ClientLogo(l.provider)
                            Spacer(Modifier.width(8.dp))
                            Text(Format.fmtProvider(l.provider), color = cm.ink, fontWeight = FontWeight.SemiBold, fontSize = 15.sp)
                            if (!l.planLabel.isNullOrBlank()) {
                                Spacer(Modifier.width(8.dp))
                                Text(l.planLabel, color = cm.mute, fontSize = 12.sp)
                            }
                            Spacer(Modifier.weight(1f))
                            l.balanceUsd?.let { Text(Format.fmtUsd(it), color = cm.ink, fontWeight = FontWeight.SemiBold) }
                        }
                        val account = listOfNotNull(l.accountLabel, l.accountName, l.accountEmail?.let { Format.maskEmail(it) }).joinToString(" · ")
                        if (account.isNotBlank()) Text(account, color = cm.mute, fontSize = 12.sp, modifier = Modifier.padding(top = 4.dp))
                        l.windows.forEach { w ->
                            val label = w.label ?: "窗口"
                            val reset = Format.fmtReset(w.resetsAt)
                            val metric = w.metric.orEmpty().lowercase()
                            val hasPct = w.usedPercent != null
                            Row(Modifier.fillMaxWidth().padding(top = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                                if (hasPct && w.showMeter) {
                                    val used = (w.usedPercent ?: 0.0).coerceIn(0.0, 100.0)
                                    val remain = (100.0 - used) / 100.0
                                    val lv = when {
                                        used < 60 -> "ok"
                                        used < 80 -> "warn"
                                        else -> "crit"
                                    }
                                    QuotaRing(remain.toFloat(), lv)
                                    Spacer(Modifier.width(10.dp))
                                }
                                Column(Modifier.weight(1f)) {
                                    Text(label, color = cm.ink, fontSize = 13.sp, fontWeight = FontWeight.Medium)
                                    val meta = when {
                                        hasPct && w.showMeter -> reset.ifBlank { "已用 ${w.usedPercent!!.toInt()}%" }
                                        metric == "credits" && w.remaining != null ->
                                            "剩余 ${Format.fmtCompact(w.remaining)}" + (w.limit?.let { " / 上限 ${Format.fmtCompact(it)}" } ?: "") + if (reset.isNotEmpty()) " · $reset" else ""
                                        metric == "spend" && w.used != null ->
                                            "已用 ${Format.fmtUsd(w.used)}" + (w.limit?.let { " / ${Format.fmtUsd(it)}" } ?: "") + if (reset.isNotEmpty()) " · $reset" else ""
                                        hasPct -> "已用 ${w.usedPercent!!.toInt()}%" + if (reset.isNotEmpty()) " · $reset" else ""
                                        else -> reset.ifBlank { "用量未知" }
                                    }
                                    Text(meta, color = cm.mute, fontSize = 12.sp)
                                }
                            }
                        }
                        if (!l.device.isNullOrBlank()) {
                            Spacer(Modifier.height(6.dp))
                            Text("来源设备 · ${l.device}", color = cm.mute, fontSize = 11.sp)
                        }
                    }
                }
            }
        }
    }
    if (state.subsStatus == AuxStatus.Error) {
        item("subs-err") {
            Panel(Modifier.padding(bottom = 12.dp).riseIn(1)) {
                Text("订阅清单暂不可用", color = CmColorsCurrent.crit, fontSize = 13.sp)
            }
        }
    } else if (showSubs && subs.isNotEmpty()) {
        item("subs") {
            val cm = CmColorsCurrent
            Panel(Modifier.riseIn(1)) {
                // 对齐网页：完整时间戳，按仪表盘时区渲染
                val tz = ov?.dashboardPeriod?.timeZone ?: ov?.dashboardTimeZone
                PanelHead("订阅清单", state.subscriptions?.updatedAt?.let { "更新于 ${Format.fmtDateTime(it, tz)}" } ?: "")
                Spacer(Modifier.height(8.dp))
                subs.forEach { s ->
                    val kind = if (s.kind.equals("topup", true)) "topup" else "subscription"
                    Column(Modifier.padding(vertical = 10.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            ClientLogo(s.provider)
                            Spacer(Modifier.width(8.dp))
                            Text(s.planName ?: Format.fmtProvider(s.provider), color = cm.ink, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                            val badge = if (kind == "topup") {
                                "充值台账" to false
                            } else {
                                (if (s.autoRenew) "自动续费" else "手动续费") to s.autoRenew
                            }
                            Text(
                                badge.first,
                                color = if (badge.second) cm.okInk else cm.mute,
                                fontSize = 11.sp,
                                fontWeight = FontWeight.SemiBold,
                                modifier = Modifier
                                    .clip(RoundedCornerShape(999.dp))
                                    .background(if (badge.second) cm.okBg else cm.brand25)
                                    .padding(horizontal = 8.dp, vertical = 3.dp),
                            )
                        }
                        val bind = listOfNotNull(
                            s.binding?.profileName,
                            s.binding?.accountEmail?.let { Format.maskEmail(it) },
                            s.binding?.accountKey?.let { Format.truncateKey(it) },
                        ).joinToString(" · ")
                        if (bind.isNotBlank()) Text(bind, color = cm.mute, fontSize = 12.sp)
                        if (kind == "topup") {
                            val total = s.topUps.sumOf { it.amountMinor ?: 0L }
                            val latest = s.topUps.mapNotNull { it.date }.maxOrNull()
                            Text(
                                "充值 ${s.topUps.size} 次 · 累计 ${Format.fmtMoney(total, s.currency)}" +
                                    (latest?.let { " · 最近 ${it.take(10)}" } ?: ""),
                                color = cm.ink2,
                                fontSize = 13.sp,
                            )
                        } else if (s.amountMinor != null) {
                            Text("${Format.fmtMoney(s.amountMinor, s.currency)} · ${Format.billingInterval(s.interval, s.intervalCount)}", color = cm.ink2, fontSize = 13.sp)
                            val start = s.startDate?.take(10)
                            val next = s.nextRenewalOverride?.take(10)
                            if (!start.isNullOrBlank() || !next.isNullOrBlank()) {
                                Text(
                                    listOfNotNull(start?.let { "开始于 $it" }, next?.let { "下次续费 $it" }).joinToString(" · "),
                                    color = cm.mute,
                                    fontSize = 12.sp,
                                )
                            }
                        }
                        s.topUps.forEach { t ->
                            Text("${t.label ?: "加购"} ${Format.fmtMoney(t.amountMinor, s.currency)} · ${t.date.orEmpty().take(10)}", color = cm.mute, fontSize = 12.sp)
                        }
                    }
                }
            }
        }
    }
}
