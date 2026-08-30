package io.github.iroha1145.cloudmonitor.ui

import android.app.Activity
import android.graphics.Color as AndroidColor
import android.os.Build
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import kotlin.math.max

/**
 * 状态栏高度：Compose inset、系统 WindowInsets、资源 dimen 三者取最大。
 * Scaffold 自定义 topBar 里 `statusBarsPadding()` 经常被吃成 0，不能只靠它让开时钟。
 */
@Composable
fun statusBarInsetDp(): Dp {
    val density = LocalDensity.current
    val view = LocalView.current
    val composePx = WindowInsets.safeDrawing.getTop(density)
    val compatPx = ViewCompat.getRootWindowInsets(view)
        ?.getInsets(WindowInsetsCompat.Type.statusBars())
        ?.top
        ?: 0
    val px = max(composePx, compatPx)
    if (px > 0) return with(density) { px.toDp() }
    val id = view.resources.getIdentifier("status_bar_height", "dimen", "android")
    if (id > 0) {
        val dimenPx = view.resources.getDimensionPixelSize(id)
        if (dimenPx > 0) return with(density) { dimenPx.toDp() }
    }
    return 28.dp
}

@Composable
fun ApplyEdgeToEdge(dark: Boolean) {
    val view = LocalView.current
    SideEffect {
        val activity = view.context as? ComponentActivity ?: return@SideEffect
        val style = if (dark) {
            SystemBarStyle.dark(AndroidColor.TRANSPARENT)
        } else {
            SystemBarStyle.light(AndroidColor.TRANSPARENT, AndroidColor.TRANSPARENT)
        }
        activity.enableEdgeToEdge(statusBarStyle = style, navigationBarStyle = style)
        if (Build.VERSION.SDK_INT >= 29) {
            (view.context as? Activity)?.window?.isNavigationBarContrastEnforced = false
        }
    }
}
