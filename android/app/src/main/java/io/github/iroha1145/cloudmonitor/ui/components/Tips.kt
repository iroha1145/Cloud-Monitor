package io.github.iroha1145.cloudmonitor.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupProperties
import io.github.iroha1145.cloudmonitor.ui.theme.CmColorsCurrent
import kotlinx.coroutines.delay

@Stable
class FloatTipController {
    var visible by mutableStateOf(false)
        private set
    var title by mutableStateOf("")
        private set
    var rows by mutableStateOf(listOf<Pair<String, String>>())
        private set
    private var gen = 0

    fun show(title: String, rows: List<Pair<String, String>>) {
        this.title = title
        this.rows = rows
        visible = true
        gen++
    }

    fun hide() {
        visible = false
        gen++
    }

    fun generation(): Int = gen
}

val LocalFloatTip = staticCompositionLocalOf { FloatTipController() }

@Composable
fun FloatTipHost(controller: FloatTipController) {
    if (!controller.visible) return
    val cm = CmColorsCurrent
    val gen = controller.generation()
    LaunchedEffect(gen) {
        delay(2800)
        if (controller.generation() == gen) controller.hide()
    }
    Popup(
        onDismissRequest = { controller.hide() },
        properties = PopupProperties(focusable = false, clippingEnabled = false),
    ) {
        Column(
            Modifier
                .shadow(10.dp, RoundedCornerShape(12.dp))
                .background(cm.card, RoundedCornerShape(12.dp))
                .padding(horizontal = 12.dp, vertical = 10.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Text(controller.title, color = cm.ink, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
            controller.rows.forEach { (k, v) ->
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text(k, color = cm.mute, fontSize = 11.sp)
                    Text(v, color = cm.ink, fontSize = 11.sp, fontWeight = FontWeight.Medium)
                }
            }
        }
    }
}

@Composable
fun ToastBanner(text: String?, error: Boolean = false) {
    if (text.isNullOrBlank()) return
    val cm = CmColorsCurrent
    Popup {
        Text(
            text,
            color = if (error) cm.crit else cm.ink,
            fontSize = 13.sp,
            modifier = Modifier
                .padding(top = 8.dp)
                .shadow(8.dp, RoundedCornerShape(12.dp), ambientColor = Color(0x33000000))
                .background(cm.card, RoundedCornerShape(12.dp))
                .padding(horizontal = 14.dp, vertical = 10.dp),
        )
    }
}
