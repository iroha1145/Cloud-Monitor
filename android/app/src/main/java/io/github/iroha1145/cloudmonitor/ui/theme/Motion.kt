package io.github.iroha1145.cloudmonitor.ui.theme

import android.graphics.RenderEffect as AndroidRenderEffect
import android.graphics.Shader
import android.provider.Settings
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.tween
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.GraphicsLayerScope
import androidx.compose.ui.graphics.asComposeRenderEffect
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay

val LocalReducedMotion = compositionLocalOf { false }

object Motion {
    const val Fast = 250
    const val Slow = 400
    const val Draw = 700
    const val Digit = 280
    const val StaggerMs = 40
    const val StaggerCap = 7
    const val Gate = 200
}

@Composable
fun rememberReducedMotion(): Boolean {
    val context = LocalContext.current
    return remember(context) {
        try {
            val animator = Settings.Global.getFloat(
                context.contentResolver,
                Settings.Global.ANIMATOR_DURATION_SCALE,
                1f,
            )
            val transition = Settings.Global.getFloat(
                context.contentResolver,
                Settings.Global.TRANSITION_ANIMATION_SCALE,
                1f,
            )
            val window = Settings.Global.getFloat(
                context.contentResolver,
                Settings.Global.WINDOW_ANIMATION_SCALE,
                1f,
            )
            animator == 0f || transition == 0f || window == 0f
        } catch (_: Exception) {
            false
        }
    }
}

/** 网页 `.page-enter` / `.digit-enter` 的 blur→0；使用系统 RenderEffect。 */
fun GraphicsLayerScope.applyEnterBlur(progress: Float, maxSigmaPx: Float) {
    if (maxSigmaPx <= 0f) {
        renderEffect = null
        return
    }
    val p = progress.coerceIn(0f, 1f)
    val sigma = maxSigmaPx * (1f - p)
    renderEffect = if (p < 0.999f && sigma > 0.15f) {
        AndroidRenderEffect.createBlurEffect(sigma, sigma, Shader.TileMode.CLAMP)
            .asComposeRenderEffect()
    } else {
        null
    }
}

@Composable
fun Modifier.riseIn(index: Int): Modifier {
    val reduced = LocalReducedMotion.current
    if (reduced) return this
    val progress = remember { Animatable(0f) }
    val py = with(LocalDensity.current) { 8.dp.toPx() }
    LaunchedEffect(index) {
        progress.snapTo(0f)
        delay((index.coerceAtMost(Motion.StaggerCap) * Motion.StaggerMs).toLong())
        progress.animateTo(1f, tween(Motion.Slow, easing = FastOutSlowInEasing))
    }
    return graphicsLayer {
        val p = progress.value
        alpha = p
        translationY = (1f - p) * py
        applyEnterBlur(p, 6f)
    }
}

@Composable
fun Modifier.pageEnter(key: Any): Modifier {
    val reduced = LocalReducedMotion.current
    if (reduced) return this
    val progress = remember(key) { Animatable(0f) }
    LaunchedEffect(key) {
        progress.snapTo(0f)
        progress.animateTo(1f, tween(Motion.Fast, easing = FastOutSlowInEasing))
    }
    return graphicsLayer {
        applyEnterBlur(progress.value, 8f)
    }
}

@Composable
fun rememberGrow(key: Any): Float {
    val reduced = LocalReducedMotion.current
    val grow = remember(key) { Animatable(if (reduced) 1f else 0f) }
    LaunchedEffect(key, reduced) {
        if (reduced) grow.snapTo(1f)
        else {
            grow.snapTo(0f)
            grow.animateTo(1f, tween(Motion.Draw, easing = FastOutSlowInEasing))
        }
    }
    return grow.value
}

@Composable
fun rememberSpin(active: Boolean): Float {
    val reduced = LocalReducedMotion.current
    val rot = remember { Animatable(0f) }
    LaunchedEffect(active, reduced) {
        if (!active || reduced) return@LaunchedEffect
        while (true) {
            rot.animateTo(rot.value + 360f, tween(700, easing = LinearEasing))
        }
    }
    return rot.value
}
