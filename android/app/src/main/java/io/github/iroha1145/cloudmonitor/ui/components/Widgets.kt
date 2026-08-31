@file:OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)

package io.github.iroha1145.cloudmonitor.ui.components

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import coil.request.ImageRequest
import io.github.iroha1145.cloudmonitor.EagerSvgDecoderFactory
import io.github.iroha1145.cloudmonitor.data.Format
import io.github.iroha1145.cloudmonitor.data.logoAssetPath
import io.github.iroha1145.cloudmonitor.ui.theme.CmColorsCurrent
import io.github.iroha1145.cloudmonitor.ui.theme.LocalReducedMotion
import io.github.iroha1145.cloudmonitor.ui.theme.Motion
import io.github.iroha1145.cloudmonitor.ui.theme.applyEnterBlur
import io.github.iroha1145.cloudmonitor.ui.theme.rememberGrow
import io.github.iroha1145.cloudmonitor.vm.Period

@OptIn(ExperimentalFoundationApi::class)
@Composable
fun Panel(
    modifier: Modifier = Modifier,
    content: @Composable ColumnScope.() -> Unit,
) {
    val cm = CmColorsCurrent
    val shape = RoundedCornerShape(24.dp)
    Column(
        modifier
            .fillMaxWidth()
            .shadow(
                elevation = 12.dp,
                shape = shape,
                clip = false,
                ambientColor = cm.shadowAmbient,
                spotColor = cm.shadowSpot,
            )
            .border(1.dp, cm.border, shape)
            .background(cm.card, shape)
            .clip(shape)
            .padding(16.dp),
        content = content,
    )
}

@Composable
fun PanelHead(title: String, sub: String, trailing: @Composable (() -> Unit)? = null) {
    val cm = CmColorsCurrent
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Top) {
        Column(Modifier.weight(1f)) {
            Text(title, color = cm.ink, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
            if (sub.isNotEmpty()) {
                Spacer(Modifier.height(2.dp))
                Text(sub, color = cm.mute, fontSize = 12.sp)
            }
        }
        if (trailing != null) trailing()
    }
}

@Composable
fun CompactNumber(value: Double, size: TextUnit = 32.sp, tight: Boolean = false, color: Color = CmColorsCurrent.ink) {
    val reduced = LocalReducedMotion.current
    val p = Format.compactParts(value, tight)
    val body = @Composable {
        Row(verticalAlignment = Alignment.Bottom) {
            Text(p.n, color = color, fontSize = size, fontWeight = FontWeight.SemiBold, letterSpacing = (-0.4).sp)
            if (p.u.isNotEmpty()) {
                Text(
                    p.u,
                    color = color.copy(alpha = 0.72f),
                    fontSize = (size.value * 0.45f).sp,
                    fontWeight = FontWeight.Medium,
                    modifier = Modifier.padding(start = 2.dp, bottom = 4.dp),
                )
            }
        }
    }
    AnimatedContent(
        targetState = p.n + p.u,
        transitionSpec = {
            if (reduced) EnterTransition.None togetherWith ExitTransition.None
            else (slideInVertically(tween(Motion.Digit, easing = FastOutSlowInEasing)) { it / 3 } + fadeIn()) togetherWith
                fadeOut(tween(Motion.Digit / 2))
        },
        label = "num-pop",
    ) { _ ->
        val enter = remember { Animatable(if (reduced) 1f else 0f) }
        LaunchedEffect(Unit) {
            if (!reduced) enter.animateTo(1f, tween(Motion.Digit, easing = FastOutSlowInEasing))
        }
        Box(Modifier.graphicsLayer { applyEnterBlur(enter.value, 4f) }) { body() }
    }
}

@Composable
fun PeriodSeg(selected: Period, onSelect: (Period) -> Unit) {
    val cm = CmColorsCurrent
    val haptic = LocalHapticFeedback.current
    Row(
        Modifier
            .clip(RoundedCornerShape(999.dp))
            .background(cm.brand25)
            .padding(3.dp)
            .selectableGroup(),
        horizontalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        Period.entries.forEach { p ->
            val on = p == selected
            Text(
                p.label,
                color = if (on) cm.ink else cm.mute,
                fontSize = 12.sp,
                fontWeight = if (on) FontWeight.SemiBold else FontWeight.Medium,
                modifier = Modifier
                    .clip(RoundedCornerShape(999.dp))
                    .background(if (on) cm.card else Color.Transparent)
                    .selectable(
                        selected = on,
                        role = Role.Tab,
                        onClick = {
                            haptic.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                            onSelect(p)
                        },
                    )
                    .padding(horizontal = 10.dp, vertical = 6.dp),
            )
        }
    }
}

@Composable
fun ClientLogo(name: String?, size: Dp = 16.dp, tint: Color = CmColorsCurrent.ink) {
    val path = logoAssetPath(name)
    val letter = name.orEmpty().trim().take(1).uppercase().ifEmpty { "?" }
    if (path != null) {
        val context = LocalContext.current
        val request = remember(path) {
            ImageRequest.Builder(context)
                .data(path)
                .memoryCacheKey("cm-logo:$path")
                .decoderFactory(EagerSvgDecoderFactory())
                .crossfade(false)
                .allowHardware(true)
                .build()
        }
        AsyncImage(
            model = request,
            contentDescription = name,
            modifier = Modifier.size(size),
            contentScale = ContentScale.Fit,
            colorFilter = ColorFilter.tint(tint),
        )
    } else {
        Box(
            Modifier
                .size(size)
                .clip(RoundedCornerShape(4.dp))
                .background(CmColorsCurrent.brand50),
            contentAlignment = Alignment.Center,
        ) {
            Text(letter, fontSize = (size.value * 0.62f).sp, color = tint, fontWeight = FontWeight.SemiBold)
        }
    }
}

@Composable
fun StatusDot(ok: Boolean?, unknown: Boolean = false, pulse: Boolean = false) {
    val cm = CmColorsCurrent
    val c = when {
        unknown || ok == null -> cm.mute
        ok -> cm.ok
        else -> cm.crit
    }
    val reduced = LocalReducedMotion.current
    val inf = rememberInfiniteTransition(label = "dot-pulse")
    val pulseScale by inf.animateFloat(
        1f, 1.35f,
        infiniteRepeatable(tween(1100, easing = LinearEasing), RepeatMode.Reverse),
        label = "pulse",
    )
    val scale = if (pulse && ok == true && !reduced) pulseScale else 1f
    Box(
        Modifier
            .size(8.dp)
            .graphicsLayer { scaleX = scale; scaleY = scale }
            .clip(CircleShape)
            .background(c),
    )
}

@Composable
fun MixBar(
    parts: List<Pair<Color, Double>>,
    modifier: Modifier = Modifier,
    height: Dp = 8.dp,
    grow: Boolean = false,
    growKey: Any = parts.size,
) {
    val sum = parts.sumOf { it.second }.coerceAtLeast(1.0)
    val grown = rememberGrow(growKey)
    val frac = if (grow) grown else 1f
    Row(
        modifier
            .height(height)
            .graphicsLayer {
                scaleX = frac.coerceIn(0.02f, 1f)
                transformOrigin = TransformOrigin(0f, 0.5f)
            }
            .clip(RoundedCornerShape(999.dp)),
    ) {
        parts.filter { it.second > 0 }.forEach { (c, v) ->
            Box(
                Modifier
                    .weight((v / sum).toFloat().coerceAtLeast(0.0001f))
                    .height(height)
                    .background(c),
            )
        }
    }
}

@Composable
fun EmptyHint(text: String) {
    val cm = CmColorsCurrent
    Box(Modifier.fillMaxWidth().padding(vertical = 28.dp), contentAlignment = Alignment.Center) {
        Text(text, color = cm.mute, fontSize = 13.sp)
    }
}

@Composable
fun Modifier.tipClick(title: String, rows: List<Pair<String, String>>): Modifier {
    val tip = LocalFloatTip.current
    return onWindowPress(title, rows) { pos -> tip.show(title, rows, pos) }
}

@Composable
fun ShimmerPanel(height: Dp = 128.dp) {
    val cm = CmColorsCurrent
    val reduced = LocalReducedMotion.current
    val inf = rememberInfiniteTransition(label = "sk")
    val v by inf.animateFloat(
        0f, 1f,
        infiniteRepeatable(tween(1200, easing = LinearEasing), RepeatMode.Restart),
        label = "sk-x",
    )
    val x = if (reduced) 0.5f else v
    val brush = Brush.linearGradient(
        colors = listOf(cm.brand25, cm.border, cm.brand25),
        start = Offset(x * 900f - 240f, 0f),
        end = Offset(x * 900f + 80f, 180f),
    )
    Box(
        Modifier
            .fillMaxWidth()
            .height(height)
            .clip(RoundedCornerShape(24.dp))
            .background(brush),
    )
}

@Composable
fun ConnFlowTrack(online: Boolean, modifier: Modifier = Modifier) {
    val reduced = LocalReducedMotion.current
    val inf = rememberInfiniteTransition(label = "conn")
    val a by inf.animateFloat(
        0f, 1f,
        infiniteRepeatable(tween(2000, easing = LinearEasing), RepeatMode.Restart),
        label = "flow-a",
    )
    val b by inf.animateFloat(
        0f, 1f,
        infiniteRepeatable(tween(2000, delayMillis = 660, easing = LinearEasing), RepeatMode.Restart),
        label = "flow-b",
    )
    val c by inf.animateFloat(
        0f, 1f,
        infiniteRepeatable(tween(2000, delayMillis = 1330, easing = LinearEasing), RepeatMode.Restart),
        label = "flow-c",
    )
    BoxWithConstraints(
        modifier
            .height(2.dp)
            .clip(RoundedCornerShape(2.dp))
            .background(if (online) Color(0xFF34D399) else Color(0xFFCFD3DD)),
    ) {
        if (online && !reduced) {
            val w = maxWidth
            listOf(a, b, c).forEach { t ->
                val alpha = when {
                    t < 0.12f -> t / 0.12f
                    t > 0.88f -> (1f - t) / 0.12f
                    else -> 1f
                }
                Box(
                    Modifier
                        .align(Alignment.CenterStart)
                        .offset(x = w * t * 0.96f)
                        .size(4.dp)
                        .graphicsLayer { this.alpha = alpha }
                        .clip(CircleShape)
                        .background(Color(0xFF0A7C58)),
                )
            }
        }
    }
}
