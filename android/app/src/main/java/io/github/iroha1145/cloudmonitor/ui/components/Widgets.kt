package io.github.iroha1145.cloudmonitor.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import coil.request.ImageRequest
import io.github.iroha1145.cloudmonitor.data.Format
import io.github.iroha1145.cloudmonitor.data.logoAssetPath
import io.github.iroha1145.cloudmonitor.ui.theme.CmColorsCurrent
import io.github.iroha1145.cloudmonitor.vm.Period

@Composable
fun Panel(
    modifier: Modifier = Modifier,
    content: @Composable ColumnScope.() -> Unit,
) {
    val cm = CmColorsCurrent
    Column(
        modifier
            .fillMaxWidth()
            .shadow(8.dp, RoundedCornerShape(24.dp), ambientColor = Color(0x14003770), spotColor = Color(0x0A003B89))
            .clip(RoundedCornerShape(24.dp))
            .background(cm.card)
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
    val p = Format.compactParts(value, tight)
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

@Composable
fun PeriodSeg(selected: Period, onSelect: (Period) -> Unit) {
    val cm = CmColorsCurrent
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
                    .selectable(selected = on, role = Role.Tab, onClick = { onSelect(p) })
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
        AsyncImage(
            model = ImageRequest.Builder(LocalContext.current)
                .data(path)
                .build(),
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
fun StatusDot(ok: Boolean?, unknown: Boolean = false) {
    val cm = CmColorsCurrent
    val c = when {
        unknown || ok == null -> cm.mute
        ok -> cm.ok
        else -> cm.crit
    }
    Box(Modifier.size(8.dp).clip(CircleShape).background(c))
}

@Composable
fun MixBar(parts: List<Pair<Color, Double>>, modifier: Modifier = Modifier, height: Dp = 8.dp) {
    val sum = parts.sumOf { it.second }.coerceAtLeast(1.0)
    Row(
        modifier
            .height(height)
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
