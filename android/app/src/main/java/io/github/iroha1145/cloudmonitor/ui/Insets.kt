package io.github.iroha1145.cloudmonitor.ui

import android.app.Activity
import android.graphics.Color as AndroidColor
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.platform.LocalView
import android.view.WindowManager

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
        activity.window.isNavigationBarContrastEnforced = false
    }
}

/** 登录页挡住系统截屏/多任务缩略图；进入面板后清掉，方便用户截图用量。 */
@Composable
fun SecureScreen(enabled: Boolean) {
    val view = LocalView.current
    DisposableEffect(enabled) {
        val window = (view.context as? Activity)?.window
        if (enabled) window?.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        else window?.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
        onDispose {
            window?.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
        }
    }
}
