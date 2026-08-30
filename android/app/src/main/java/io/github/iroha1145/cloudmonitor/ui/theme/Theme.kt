package io.github.iroha1145.cloudmonitor.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

val Brand = Color(0xFF533AFD)
val Brand700 = Color(0xFF4032C8)
val Brand50 = Color(0xFFE8E9FF)

@Immutable
data class CmColors(
    val canvas: Color,
    val card: Color,
    val border: Color,
    val ink: Color,
    val ink2: Color,
    val mute: Color,
    val ok: Color,
    val okInk: Color,
    val okBg: Color,
    val warn: Color,
    val warnInk: Color,
    val warnBg: Color,
    val crit: Color,
    val critBg: Color,
    val brand: Color,
    val brand50: Color,
    val brand25: Color,
    val hm: List<Color>,
)

val LightCm = CmColors(
    canvas = Color(0xFFF8FAFD),
    card = Color(0xFFFFFFFF),
    border = Color(0xFFE5EDF5),
    ink = Color(0xFF061B31),
    ink2 = Color(0xFF50617A),
    mute = Color(0xFF50617A),
    ok = Color(0xFF00B261),
    okInk = Color(0xFF006F3A),
    okBg = Color(0xFFE6F7EE),
    warn = Color(0xFFEAB308),
    warnInk = Color(0xFF8A5A0A),
    warnBg = Color(0xFFFDF1C8),
    crit = Color(0xFFD8351E),
    critBg = Color(0xFFFED9DE),
    brand = Brand,
    brand50 = Brand50,
    brand25 = Color(0xFFF5F5FF),
    hm = listOf(
        Color(0xFFE5EDF5), Color(0xFFE8E9FF), Color(0xFFD6D9FC),
        Color(0xFFB9B9F9), Color(0xFF533AFD), Color(0xFF2E2B8C),
    ),
)

val DarkCm = CmColors(
    canvas = Color(0xFF0B1220),
    card = Color(0xFF151C2B),
    border = Color(0xFF2A384C),
    ink = Color(0xFFE8EEF6),
    ink2 = Color(0xFFC5D0DC),
    mute = Color(0xFFB8C5D4),
    ok = Color(0xFF3DCC86),
    okInk = Color(0xFF7EE0A8),
    okBg = Color(0xFF123528),
    warn = Color(0xFFFACC15),
    warnInk = Color(0xFFFDE047),
    warnBg = Color(0xFF3A3008),
    crit = Color(0xFFFF8A80),
    critBg = Color(0xFF3A1618),
    brand = Color(0xFF9B99FF),
    brand50 = Color(0xFF1C2240),
    brand25 = Color(0xFF161B30),
    hm = listOf(
        Color(0xFF1A2333), Color(0xFF1E2547), Color(0xFF2E2B8C),
        Color(0xFF4032C8), Color(0xFF7F7DFC), Color(0xFFC5C4FF),
    ),
)

val LocalCmColors = staticCompositionLocalOf { LightCm }

val CmColorsCurrent: CmColors
    @Composable get() = LocalCmColors.current

private fun scheme(cm: CmColors, dark: Boolean): ColorScheme {
    val base = if (dark) darkColorScheme() else lightColorScheme()
    return base.copy(
        primary = cm.brand,
        onPrimary = Color.White,
        primaryContainer = cm.brand50,
        onPrimaryContainer = cm.ink,
        background = cm.canvas,
        onBackground = cm.ink,
        surface = cm.card,
        onSurface = cm.ink,
        surfaceVariant = cm.brand25,
        onSurfaceVariant = cm.ink2,
        outline = cm.border,
        error = cm.crit,
    )
}

@Composable
fun CloudMonitorTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    val cm = if (darkTheme) DarkCm else LightCm
    CompositionLocalProvider(LocalCmColors provides cm) {
        MaterialTheme(
            colorScheme = scheme(cm, darkTheme),
            typography = MaterialTheme.typography.copy(
                displayLarge = TextStyle(
                    fontFamily = FontFamily.SansSerif,
                    fontWeight = FontWeight.SemiBold,
                    fontSize = 36.sp,
                    letterSpacing = (-0.5).sp,
                    color = cm.ink,
                ),
                titleLarge = TextStyle(
                    fontFamily = FontFamily.SansSerif,
                    fontWeight = FontWeight.SemiBold,
                    fontSize = 20.sp,
                    color = cm.ink,
                ),
                bodyMedium = TextStyle(
                    fontFamily = FontFamily.SansSerif,
                    fontSize = 14.sp,
                    color = cm.ink,
                ),
                labelSmall = TextStyle(
                    fontFamily = FontFamily.SansSerif,
                    fontSize = 12.sp,
                    color = cm.mute,
                ),
            ),
            content = content,
        )
    }
}
