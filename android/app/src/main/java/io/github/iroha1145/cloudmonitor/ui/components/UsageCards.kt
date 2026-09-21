package io.github.iroha1145.cloudmonitor.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import io.github.iroha1145.cloudmonitor.data.Format
import io.github.iroha1145.cloudmonitor.data.TokenSeg
import io.github.iroha1145.cloudmonitor.ui.theme.CmColorsCurrent

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun ComponentLegend(segments: List<TokenSeg>) {
    FlowRow(horizontalArrangement = Arrangement.spacedBy(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        segments.forEach { segment ->
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Box(Modifier.size(7.dp).clip(CircleShape).background(segment.color))
                Text(segment.label, color = CmColorsCurrent.mute, style = MaterialTheme.typography.bodySmall)
                Text(Format.fmtCompact(segment.value), color = CmColorsCurrent.ink, style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}
