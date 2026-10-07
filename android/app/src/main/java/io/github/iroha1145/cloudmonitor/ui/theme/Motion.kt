package io.github.iroha1145.cloudmonitor.ui.theme

import android.graphics.RenderEffect as AndroidRenderEffect
import android.graphics.Shader
import android.provider.Settings
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.Easing
import androidx.compose.animation.core.keyframes
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.GraphicsLayerScope
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.asComposeRenderEffect
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.background
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlin.math.roundToInt

val LocalReducedMotion = compositionLocalOf { false }

/** transitions.dev tokens from hub/dashboard/src/tokens.css. */
val EaseSmoothOut: Easing = CubicBezierEasing(0.22f, 1f, 0.36f, 1f)
val EaseBounce: Easing = CubicBezierEasing(0.34f, 1.36f, 0.64f, 1f)
val EaseInOut: Easing = CubicBezierEasing(0.42f, 0f, 0.58f, 1f)

object Motion {
    const val Stagger = 40
    const val Quick = 150
    const val Fast = 250
    const val Medium = 350
    const val Slow = 400
    const val VerySlow = 500
    const val Shake = 280
    const val StaggerCap = 4
    const val Draw = Fast
    const val Digit = VerySlow
    const val Gate = Quick
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

/** Web digit pop uses a 2px blur that clears as the glyph settles. */
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

/** Page sections rise 8px over --duration-fast. The web recipe does not blur them. */
@Composable
fun Modifier.riseIn(index: Int, replayKey: Any = Unit): Modifier {
    val reduced = LocalReducedMotion.current
    if (reduced) return this
    val progress = remember(replayKey) { Animatable(0f) }
    val py = with(LocalDensity.current) { 8.dp.toPx() }
    LaunchedEffect(index, replayKey) {
        progress.snapTo(0f)
        delay((index.coerceAtMost(Motion.StaggerCap) * Motion.Stagger).toLong())
        progress.animateTo(1f, tween(Motion.Fast, easing = EaseSmoothOut))
    }
    return graphicsLayer {
        val p = progress.value
        alpha = p
        translationY = (1f - p) * py
    }
}

/** Page swap: fade in over --duration-fast. Exit is owned by the next page. */
@Composable
fun Modifier.pageEnter(key: Any): Modifier {
    val reduced = LocalReducedMotion.current
    if (reduced) return this
    val progress = remember(key) { Animatable(0f) }
    LaunchedEffect(key) {
        progress.snapTo(0f)
        progress.animateTo(1f, tween(Motion.Fast, easing = EaseSmoothOut))
    }
    return graphicsLayer { alpha = progress.value }
}

/** Dialog content scales from 0.96, matching t-modal-in. */
@Composable
fun Modifier.modalEnter(key: Any): Modifier {
    val reduced = LocalReducedMotion.current
    if (reduced) return this
    val progress = remember(key) { Animatable(0f) }
    LaunchedEffect(key) {
        progress.snapTo(0f)
        progress.animateTo(1f, tween(Motion.Fast, easing = EaseSmoothOut))
    }
    return graphicsLayer {
        val p = progress.value
        alpha = p
        val scale = 0.96f + 0.04f * p
        scaleX = scale
        scaleY = scale
    }
}

/** Failed key submission: 6px, -6px, 4px over 280ms. */
@Composable
fun Modifier.errorShake(nonce: Int): Modifier {
    val reduced = LocalReducedMotion.current
    val offset = remember { Animatable(0f) }
    val distance = with(LocalDensity.current) { 1.dp.toPx() }
    LaunchedEffect(nonce, reduced) {
        if (reduced || nonce <= 0) {
            offset.snapTo(0f)
            return@LaunchedEffect
        }
        offset.snapTo(0f)
        offset.animateTo(0f, keyframes {
            durationMillis = Motion.Shake
            0f at 0 using EaseSmoothOut
            6f at 80 using EaseSmoothOut
            -6f at 160 using EaseSmoothOut
            4f at 220 using EaseSmoothOut
            0f at Motion.Shake
        })
    }
    return graphicsLayer { translationX = offset.value * distance }
}

@Composable
fun rememberGrow(key: Any): Float {
    val reduced = LocalReducedMotion.current
    val grow = remember(key) { Animatable(if (reduced) 1f else 0f) }
    LaunchedEffect(key, reduced) {
        if (reduced) grow.snapTo(1f)
        else {
            grow.snapTo(0f)
            grow.animateTo(1f, tween(Motion.Draw, easing = EaseSmoothOut))
        }
    }
    return grow.value
}

/**
 * One thumb glides between measured children. The first layout snaps;
 * later moves use --duration-fast and --ease-smooth-out.
 */
@Composable
fun SlidingThumb(
    selected: Int,
    bounds: Map<Int, Rect>,
    color: Color,
    shape: Shape,
    modifier: Modifier = Modifier,
) {
    val target = bounds[selected]
    val reduced = LocalReducedMotion.current
    val left = remember { Animatable(target?.left ?: 0f) }
    val top = remember { Animatable(target?.top ?: 0f) }
    val width = remember { Animatable(target?.width ?: 0f) }
    val height = remember { Animatable(target?.height ?: 0f) }
    var ready by remember { mutableStateOf(false) }
    LaunchedEffect(target, reduced) {
        if (target == null) return@LaunchedEffect
        if (!ready || reduced) {
            left.snapTo(target.left)
            top.snapTo(target.top)
            width.snapTo(target.width)
            height.snapTo(target.height)
            ready = true
        } else {
            val spec = tween<Float>(Motion.Fast, easing = EaseSmoothOut)
            coroutineScope {
                launch { left.animateTo(target.left, spec) }
                launch { top.animateTo(target.top, spec) }
                launch { width.animateTo(target.width, spec) }
                launch { height.animateTo(target.height, spec) }
            }
        }
    }
    if (!ready) return
    Box(
        modifier
            .offset { IntOffset(left.value.roundToInt(), top.value.roundToInt()) }
            .size(with(LocalDensity.current) { width.value.toDp() }, with(LocalDensity.current) { height.value.toDp() })
            .clip(shape)
            .background(color),
    )
}
