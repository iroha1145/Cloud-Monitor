package io.github.iroha1145.cloudmonitor.ui.components

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.combinedClickable
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
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntRect
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupPositionProvider
import androidx.compose.ui.window.PopupProperties
import io.github.iroha1145.cloudmonitor.ui.theme.CmColorsCurrent
import kotlinx.coroutines.delay
import kotlin.math.roundToInt

@Stable
class FloatTipController {
    var visible by mutableStateOf(false)
        private set
    var title by mutableStateOf("")
        private set
    var rows by mutableStateOf(listOf<Pair<String, String>>())
        private set
    var windowPos by mutableStateOf(Offset.Zero)
        private set
    private var gen = 0

    fun show(title: String, rows: List<Pair<String, String>>, windowPos: Offset) {
        this.title = title
        this.rows = rows
        this.windowPos = windowPos
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

/** 对齐网页 `floatTip.place`：水平居中于触点，优先出现在手指上方，贴边翻转。 */
private class FollowPointerPositionProvider(
    private val pointer: Offset,
) : PopupPositionProvider {
    override fun calculatePosition(
        anchorBounds: IntRect,
        windowSize: IntSize,
        layoutDirection: LayoutDirection,
        popupContentSize: IntSize,
    ): IntOffset {
        val margin = 8
        val px = pointer.x.roundToInt()
        val py = pointer.y.roundToInt()
        val lx = clamp(px - popupContentSize.width / 2, popupContentSize.width, windowSize.width, margin)
        val above = py - popupContentSize.height - 12
        val ly = if (above >= margin) {
            above
        } else {
            clamp(py + 16, popupContentSize.height, windowSize.height, margin)
        }
        return IntOffset(lx, ly)
    }

    private fun clamp(value: Int, size: Int, window: Int, margin: Int): Int {
        val max = window - size - margin
        if (max < margin) return ((window - size) / 2).coerceAtLeast(0)
        return value.coerceIn(margin, max)
    }
}

fun LayoutCoordinates?.toWindow(local: Offset): Offset {
    val c = this
    return if (c != null && c.isAttached) c.localToWindow(local) else local
}

/** 点按 / 长按：记下触点窗口坐标，同时把滚动交给 LazyColumn（不消费 Initial 事件）。 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun Modifier.onWindowPress(
    key1: Any? = Unit,
    key2: Any? = Unit,
    onPress: (windowPos: Offset) -> Unit,
): Modifier {
    val haptic = LocalHapticFeedback.current
    var layout by remember { mutableStateOf<LayoutCoordinates?>(null) }
    var lastLocal by remember { mutableStateOf<Offset?>(null) }
    fun emit() {
        val c = layout
        if (c == null || !c.isAttached) return
        val local = lastLocal ?: Offset(c.size.width / 2f, 0f)
        onPress(c.localToWindow(local))
    }
    return this
        .onGloballyPositioned { layout = it }
        .pointerInput(key1, key2) {
            awaitPointerEventScope {
                while (true) {
                    val event = awaitPointerEvent(PointerEventPass.Initial)
                    val change = event.changes.firstOrNull() ?: continue
                    if (change.pressed) lastLocal = change.position
                }
            }
        }
        .combinedClickable(
            onClick = { emit() },
            onLongClick = {
                haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                emit()
            },
        )
}

@Composable
fun FloatTipHost(controller: FloatTipController) {
    if (!controller.visible) return
    val cm = CmColorsCurrent
    val gen = controller.generation()
    val pos = controller.windowPos
    val provider = remember(pos.x, pos.y) { FollowPointerPositionProvider(pos) }
    LaunchedEffect(gen) {
        delay(2800)
        if (controller.generation() == gen) controller.hide()
    }
    Popup(
        popupPositionProvider = provider,
        onDismissRequest = { controller.hide() },
        properties = PopupProperties(focusable = false, clippingEnabled = false),
    ) {
        val shape = RoundedCornerShape(12.dp)
        Column(
            Modifier
                .shadow(10.dp, shape, ambientColor = cm.shadowAmbient, spotColor = cm.shadowSpot)
                .border(1.dp, cm.border, shape)
                .background(cm.glass, shape)
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
