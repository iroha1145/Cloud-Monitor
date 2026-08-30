package io.github.iroha1145.cloudmonitor.ui.theme

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
        alpha = progress.value
        translationY = (1f - progress.value) * py
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
