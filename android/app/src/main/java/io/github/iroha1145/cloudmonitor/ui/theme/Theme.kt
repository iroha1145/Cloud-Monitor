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

val Brand = Color(0xFF2672C0)
val Brand700 = Color(0xFF195A99)
val Brand50 = Color(0xFFE7F0FA)

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
    val glass: Color,
    val shadowAmbient: Color,
    val shadowSpot: Color,
    val hm: List<Color>,
)

val LightCm = CmColors(
    canvas = Color(0xFFFAFAFB),
    card = Color(0xFFFFFFFF),
    border = Color(0xFFECEEF1),
    ink = Color(0xFF20242B),
    ink2 = Color(0xFF606775),
    mute = Color(0xFF606775),
    ok = Color(0xFF219477),
    okInk = Color(0xFF16765E),
    okBg = Color(0xFFEAF6F0),
    warn = Color(0xFFB88320),
    warnInk = Color(0xFF8A5A0A),
    warnBg = Color(0xFFFFF4DC),
    crit = Color(0xFFC64236),
    critBg = Color(0xFFFDECE9),
    brand = Brand,
    brand50 = Brand50,
    brand25 = Color(0xFFF3F6FA),
    glass = Color(0xEBFAFAFB),
    shadowAmbient = Color(0x08000000),
    shadowSpot = Color(0x05000000),
    hm = listOf(
        Color(0xFFECEEF1), Color(0xFFE7F0FA), Color(0xFFCADFF4),
        Color(0xFFA1C8EB), Color(0xFF2672C0), Color(0xFF174574),
    ),
)

val DarkCm = CmColors(
    canvas = Color(0xFF191B20),
    card = Color(0xFF24262D),
    border = Color(0xFF383D47),
    ink = Color(0xFFF1F3F5),
    ink2 = Color(0xFFCDD1D9),
    mute = Color(0xFFACB3BF),
    ok = Color(0xFF3DCC86),
    okInk = Color(0xFF7EE0A8),
    okBg = Color(0xFF123528),
    warn = Color(0xFFFACC15),
    warnInk = Color(0xFFFDE047),
    warnBg = Color(0xFF3A3008),
    crit = Color(0xFFFF8A80),
    critBg = Color(0xFF3A1618),
    brand = Color(0xFF8ABCF0),
    brand50 = Color(0xFF233D59),
    brand25 = Color(0xFF282F39),
    glass = Color(0xE0191B20),
    shadowAmbient = Color(0x66000000),
    shadowSpot = Color(0x44000000),
    hm = listOf(
        Color(0xFF292E37), Color(0xFF233D59), Color(0xFF174574),
        Color(0xFF195A99), Color(0xFF68A4DD), Color(0xFFB6D9FB),
    ),
)

val LocalCmColors = staticCompositionLocalOf { LightCm }

val CmColorsCurrent: CmColors
    @Composable get() = LocalCmColors.current

private fun scheme(cm: CmColors, dark: Boolean): ColorScheme {
    val base = if (dark) darkColorScheme() else lightColorScheme()
    return base.copy(
        primary = cm.brand,
        onPrimary = if (dark) Color(0xFF102A43) else Color.White,
        secondary = cm.brand,
        onSecondary = if (dark) cm.canvas else Color.White,
        secondaryContainer = cm.brand50,
        onSecondaryContainer = cm.ink,
        surfaceContainer = cm.canvas,
        surfaceContainerLow = cm.card,
        surfaceContainerHigh = cm.brand25,
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
