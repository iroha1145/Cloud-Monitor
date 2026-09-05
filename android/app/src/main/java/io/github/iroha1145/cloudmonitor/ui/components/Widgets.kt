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
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.clickable
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.Icon
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import io.github.iroha1145.cloudmonitor.ui.AppIcons
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
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
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
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
    val shape = RoundedCornerShape(10.dp)
    Column(
        modifier
            .fillMaxWidth()
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
    val copy: @Composable (Modifier) -> Unit = { modifier ->
        Column(modifier, verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(title, color = cm.ink, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
            if (sub.isNotEmpty()) Text(sub, color = cm.mute, style = MaterialTheme.typography.bodySmall)
        }
    }
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        if (maxWidth < 320.dp || LocalDensity.current.fontScale > 1.4f) {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                copy(Modifier.fillMaxWidth())
                if (trailing != null) trailing()
            }
        } else {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.Top) {
                copy(Modifier.weight(1f))
                if (trailing != null) trailing()
            }
        }
    }
}

@Composable
fun CompactNumber(value: Double, size: TextUnit = 32.sp, tight: Boolean = false, color: Color = CmColorsCurrent.ink) {
    val parts = Format.compactParts(value, tight)
    Text(parts.n + parts.u, color = color, fontSize = size, fontWeight = FontWeight.SemiBold)
}

@Composable
fun PeriodSeg(selected: Period, onSelect: (Period) -> Unit) {
    WebSegmentedControl(Period.entries.map { it.label }, Period.entries.indexOf(selected), { onSelect(Period.entries[it]) })
}

/** Web-sized visuals inside Android's minimum 48 dp touch targets. */
@Composable
fun WebSegmentedControl(
    options: List<String>,
    selected: Int,
    onSelect: (Int) -> Unit,
    modifier: Modifier = Modifier,
    tags: List<String> = emptyList(),
    enabled: List<Boolean> = emptyList(),
) {
    val cm = CmColorsCurrent
    val haptic = LocalHapticFeedback.current
    Box(modifier.horizontalScroll(rememberScrollState())) {
        Box(Modifier.matchParentSize().padding(vertical = 6.dp)
            .background(cm.hover, RoundedCornerShape(7.dp))
            .border(1.dp, cm.border, RoundedCornerShape(7.dp)))
        Row(Modifier.selectableGroup().padding(horizontal = 3.dp)) {
            options.forEachIndexed { index, label ->
                val on = index == selected
                Box(
                    Modifier.then(tags.getOrNull(index)?.let { Modifier.testTag(it) } ?: Modifier)
                    .selectable(
                        selected = on,
                        enabled = enabled.getOrNull(index) != false,
                        role = Role.Tab,
                        onClick = {
                            haptic.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                            onSelect(index)
                        },
                    )
                    .heightIn(min = 48.dp)
                    .widthIn(min = 60.dp)
                    .padding(vertical = 9.dp, horizontal = 1.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(label, color = if (enabled.getOrNull(index) == false) cm.mute else if (on) cm.ink else cm.mute,
                        style = MaterialTheme.typography.labelLarge,
                        fontWeight = if (on) FontWeight.SemiBold else FontWeight.Medium,
                        modifier = Modifier.background(if (on) cm.card else Color.Transparent, RoundedCornerShape(5.dp))
                            .padding(horizontal = 12.dp, vertical = 6.dp))
                }
            }
        }
    }
}

@Composable
fun WebSegments(
    options: List<String>,
    selected: Int,
    onSelect: (Int) -> Unit,
    modifier: Modifier = Modifier,
    tags: List<String> = emptyList(),
    enabled: List<Boolean> = emptyList(),
) = WebSegmentedControl(options, selected, onSelect, modifier, tags, enabled)

@Composable
fun WebPill(label: String, selected: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val cm = CmColorsCurrent
    Box(modifier.selectable(selected, role = Role.Tab, onClick = onClick)
        .heightIn(min = 48.dp).padding(vertical = 8.dp), contentAlignment = Alignment.Center) {
        Text(label, color = if (selected) cm.ink else cm.ink2,
            style = MaterialTheme.typography.labelLarge,
            fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Medium,
            modifier = Modifier.background(if (selected) cm.card else cm.hover, RoundedCornerShape(6.dp))
                .border(1.dp, if (selected) cm.borderStrong else cm.border, RoundedCornerShape(6.dp))
                .padding(horizontal = 12.dp, vertical = 7.dp))
    }
}

@Composable
fun WebActionButton(
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    icon: ImageVector? = null,
    loading: Boolean = false,
) {
    val cm = CmColorsCurrent
    val color = if (enabled) cm.ink2 else cm.mute
    Box(modifier.clip(RoundedCornerShape(7.dp)).clickable(enabled = enabled, role = Role.Button, onClick = onClick)
        .heightIn(min = 48.dp).padding(vertical = 2.dp), contentAlignment = Alignment.Center) {
        Row(Modifier.background(cm.card, RoundedCornerShape(7.dp))
            .border(1.dp, cm.borderStrong, RoundedCornerShape(7.dp))
            .heightIn(min = 44.dp).padding(horizontal = 13.dp, vertical = 9.dp),
            horizontalArrangement = Arrangement.spacedBy(7.dp), verticalAlignment = Alignment.CenterVertically) {
            if (loading) CircularProgressIndicator(Modifier.size(14.dp), color = color, strokeWidth = 1.5.dp)
            else if (icon != null) Icon(icon, null, Modifier.size(14.dp), tint = color)
            Text(label, color = color, style = MaterialTheme.typography.labelLarge)
        }
    }
}

@Composable
fun WebSearchField(
    value: String,
    onValueChange: (String) -> Unit,
    label: String,
    placeholder: String = "",
    modifier: Modifier = Modifier,
) {
    val cm = CmColorsCurrent
    val focus = LocalFocusManager.current
    BasicTextField(value, onValueChange,
        modifier = modifier.fillMaxWidth().heightIn(min = 48.dp).semantics { contentDescription = label },
        textStyle = MaterialTheme.typography.bodyMedium.copy(color = cm.ink),
        singleLine = true,
        cursorBrush = SolidColor(cm.brand),
        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
        keyboardActions = KeyboardActions(onSearch = { focus.clearFocus() }),
        decorationBox = { innerTextField ->
            Row(Modifier.padding(vertical = 3.dp).heightIn(min = 42.dp)
                .background(cm.card, RoundedCornerShape(6.dp))
                .border(1.dp, cm.borderStrong, RoundedCornerShape(6.dp))
                .padding(horizontal = 12.dp, vertical = 10.dp),
                horizontalArrangement = Arrangement.spacedBy(9.dp), verticalAlignment = Alignment.CenterVertically) {
                Canvas(Modifier.size(15.dp)) {
                    val stroke = 1.5.dp.toPx()
                    drawCircle(cm.mute, radius = size.minDimension * .30f,
                        center = Offset(size.width * .40f, size.height * .40f), style = Stroke(stroke))
                    drawLine(cm.mute, Offset(size.width * .63f, size.height * .63f),
                        Offset(size.width * .94f, size.height * .94f), strokeWidth = stroke, cap = StrokeCap.Round)
                }
                Box(Modifier.weight(1f)) {
                    if (value.isEmpty()) Text(placeholder.ifEmpty { label }, color = cm.mute, style = MaterialTheme.typography.bodyMedium)
                    innerTextField()
                }
            }
        })
}

@Composable
fun ClientLogo(name: String?, size: Dp = 16.dp, tint: Color = CmColorsCurrent.ink) {
    val path = logoAssetPath(name)
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
            Icon(AppIcons.Terminal, contentDescription = name ?: "客户端", tint = tint, modifier = Modifier.size(size))
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
    val haptic = LocalHapticFeedback.current
    return combinedClickable(
        onClick = { tip.show(title, rows) },
        onLongClick = {
            haptic.performHapticFeedback(HapticFeedbackType.LongPress)
            tip.show(title, rows)
        },
    )
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
            .clip(RoundedCornerShape(10.dp))
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
