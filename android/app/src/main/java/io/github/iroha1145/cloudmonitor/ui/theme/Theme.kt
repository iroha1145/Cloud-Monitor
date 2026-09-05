package io.github.iroha1145.cloudmonitor.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
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
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.shape.RoundedCornerShape

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
    val borderStrong: Color,
    val inset: Color,
    val hover: Color,
    val sidebar: Color,
    val navActive: Color,
    val navInk: Color,
)

val LightCm = CmColors(
    canvas = Color(0xFFFAFAFB),
    card = Color(0xFFFFFFFF),
    border = Color(0xFFECEEF1),
    ink = Color(0xFF20242B),
    ink2 = Color(0xFF606775),
    mute = Color(0xFF636C7A),
    ok = Color(0xFF219477),
    okInk = Color(0xFF16765E),
    okBg = Color(0xFFE7F6EF),
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
    borderStrong = Color(0xFFDDE1E6),
    inset = Color(0xFFF8F9FA),
    hover = Color(0xFFF2F3F5),
    sidebar = Color(0xFFF5F6F7),
    navActive = Color(0xFFEDF3FA),
    navInk = Color(0xFF276AAF),
)

val DarkCm = CmColors(
    canvas = Color(0xFF191B20),
    card = Color(0xFF24262D),
    border = Color(0xFF323640),
    ink = Color(0xFFF1F3F5),
    ink2 = Color(0xFFB0B6C0),
    mute = Color(0xFFA0A8B5),
    ok = Color(0xFF3DCC86),
    okInk = Color(0xFF62D0A5),
    okBg = Color(0xFF163D34),
    warn = Color(0xFFFACC15),
    warnInk = Color(0xFFFDE047),
    warnBg = Color(0xFF3A3008),
    crit = Color(0xFFFF8A80),
    critBg = Color(0xFF3A1618),
    brand = Color(0xFF8ABCF0),
    brand50 = Color(0xFF25374C),
    brand25 = Color(0xFF21242B),
    glass = Color(0xE0191B20),
    shadowAmbient = Color(0x66000000),
    shadowSpot = Color(0x44000000),
    hm = listOf(
        Color(0xFF292E37), Color(0xFF233D59), Color(0xFF174574),
        Color(0xFF195A99), Color(0xFF68A4DD), Color(0xFFB6D9FB),
    ),
    borderStrong = Color(0xFF454B58),
    inset = Color(0xFF21242B),
    hover = Color(0xFF2C3039),
    sidebar = Color(0xFF1D1F24),
    navActive = Color(0xFF24354C),
    navInk = Color(0xFF9BC8F8),
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
            typography = Typography(
                displayLarge = webText(36, 43, FontWeight.SemiBold),
                displayMedium = webText(32, 40, FontWeight.SemiBold),
                displaySmall = webText(28, 36, FontWeight.SemiBold),
                headlineLarge = webText(28, 36, FontWeight.SemiBold),
                headlineMedium = webText(25, 33, FontWeight.SemiBold),
                headlineSmall = webText(22, 29, FontWeight.SemiBold),
                titleLarge = webText(20, 28, FontWeight.SemiBold),
                titleMedium = webText(16, 23, FontWeight.SemiBold),
                titleSmall = webText(14, 21, FontWeight.SemiBold),
                bodyLarge = webText(14, 22),
                bodyMedium = webText(13, 21),
                bodySmall = webText(11, 18),
                labelLarge = webText(12, 18, FontWeight.Medium),
                labelMedium = webText(11, 16, FontWeight.Medium),
                labelSmall = webText(10, 15, FontWeight.Medium),
            ),
            shapes = Shapes(
                extraSmall = RoundedCornerShape(4.dp),
                small = RoundedCornerShape(6.dp),
                medium = RoundedCornerShape(10.dp),
                large = RoundedCornerShape(14.dp),
                extraLarge = RoundedCornerShape(20.dp),
            ),
            content = content,
        )
    }
}

private fun webText(size: Int, lineHeight: Int, weight: FontWeight = FontWeight.Normal) = TextStyle(
    fontFamily = FontFamily.SansSerif,
    fontWeight = weight,
    fontSize = size.sp,
    lineHeight = lineHeight.sp,
    letterSpacing = 0.sp,
)
