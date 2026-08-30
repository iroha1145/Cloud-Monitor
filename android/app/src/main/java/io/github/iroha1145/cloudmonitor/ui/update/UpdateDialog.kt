package io.github.iroha1145.cloudmonitor.ui.update

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.github.iroha1145.cloudmonitor.data.Format
import io.github.iroha1145.cloudmonitor.data.SystemUpdate
import io.github.iroha1145.cloudmonitor.ui.theme.CmColorsCurrent

@Composable
fun UpdateDialog(
    demo: Boolean,
    loading: Boolean,
    error: String?,
    data: SystemUpdate?,
    onDismiss: () -> Unit,
) {
    val cm = CmColorsCurrent
    val context = LocalContext.current
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("检索更新") },
        text = {
            Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState())) {
                Text(
                    if (demo) "演示数据，不会改服务器。" else "手机端只检索版本信息，不会在服务器上应用更新。",
                    color = cm.mute,
                    fontSize = 12.sp,
                )
                Spacer(Modifier.height(12.dp))
                when {
                    loading -> CircularProgressIndicator()
                    !error.isNullOrBlank() -> Text(error, color = cm.crit, fontSize = 13.sp)
                    data != null -> UpdateBody(data, demo)
                }
            }
        },
        confirmButton = {
            val url = data?.latestRelease?.htmlUrl ?: data?.repo
            if (!url.isNullOrBlank() && Format.safeHttpUrl(url) != null) {
                TextButton({
                    try {
                        context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
                    } catch (_: Exception) { }
                }) { Text("打开 GitHub") }
            }
        },
        dismissButton = { TextButton(onDismiss) { Text("关闭") } },
    )
}

@Composable
private fun UpdateBody(data: SystemUpdate, demo: Boolean) {
    val cm = CmColorsCurrent
    val cur = data.current
    val sha = cur.gitSha?.take(7)?.ifBlank { null } ?: "—"
    RowLine("当前", "${cur.version ?: "dev"} · $sha")
    val latest = data.latestRelease
    if (latest != null) {
        val pill = if (data.releaseAhead) "有新版本" else "已是最新"
        RowLine(
            "最新 Release",
            latest.tag + (latest.publishedAt?.take(10)?.let { " · $it" } ?: "") + " · $pill",
        )
        if (!latest.notes.isNullOrBlank()) {
            Spacer(Modifier.height(8.dp))
            Text(latest.notes.replace(Regex("""\*\*([^*]+)\*\*"""), "$1"), color = cm.ink2, fontSize = 13.sp)
        }
    } else {
        RowLine("最新 Release", "暂无 GitHub Release")
    }
    data.main?.let { main ->
        val pill = if (data.mainAhead) "有新提交" else "已同步"
        RowLine(
            "origin/main",
            listOfNotNull(main.shortSha, pill, main.message).joinToString(" · "),
        )
    }
    if (!data.githubError.isNullOrBlank()) {
        Spacer(Modifier.height(8.dp))
        Text(data.githubError, color = cm.crit, fontSize = 12.sp)
    }
    Spacer(Modifier.height(8.dp))
    Text(
        if (demo) "演示模式不会改服务器。" else "检索可用。在线升级需要用 install.sh 安装，且只能在服务器上执行。",
        color = cm.mute,
        fontSize = 12.sp,
    )
}

@Composable
private fun RowLine(k: String, v: String) {
    val cm = CmColorsCurrent
    Spacer(Modifier.height(6.dp))
    Text(k, color = cm.mute, fontSize = 11.sp)
    Text(v, color = cm.ink, fontSize = 13.sp, fontWeight = FontWeight.Medium, fontFamily = FontFamily.Monospace)
}
