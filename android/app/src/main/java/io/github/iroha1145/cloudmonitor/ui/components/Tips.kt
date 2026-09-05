package io.github.iroha1145.cloudmonitor.ui.components

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import io.github.iroha1145.cloudmonitor.ui.theme.CmColorsCurrent

@Stable
class FloatTipController {
    var visible by mutableStateOf(false)
        private set
    var title by mutableStateOf("")
        private set
    var rows by mutableStateOf(listOf<Pair<String, String>>())
        private set
    fun show(title: String, rows: List<Pair<String, String>>) {
        this.title = title
        this.rows = rows
        visible = true
    }
    fun hide() { visible = false }
}
val LocalFloatTip = staticCompositionLocalOf { FloatTipController() }

/** Native, dismissible details stay open while users read or use a screen reader. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FloatTipHost(controller: FloatTipController) {
    if (!controller.visible) return
    val cm = CmColorsCurrent
    ModalBottomSheet(onDismissRequest = controller::hide, containerColor = cm.card) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 24.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Text(controller.title, style = MaterialTheme.typography.titleLarge, modifier = Modifier.semantics { heading() })
            controller.rows.forEach { (label, value) ->
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(label, color = cm.mute, style = MaterialTheme.typography.bodySmall)
                    Text(value, color = cm.ink, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium)
                }
            }
            TextButton(onClick = controller::hide, modifier = Modifier.fillMaxWidth()) { Text("关闭详情") }
            Spacer(Modifier.height(16.dp))
        }
    }
}

@Composable
fun ToastBanner(text: String?, error: Boolean = false) {
    if (!text.isNullOrBlank()) Snackbar { Text(text, color = if (error) CmColorsCurrent.crit else CmColorsCurrent.ink) }
}
