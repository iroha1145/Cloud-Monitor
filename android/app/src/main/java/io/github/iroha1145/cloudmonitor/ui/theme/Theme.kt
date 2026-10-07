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

val Brand = Color(0xFF1F5FAE)
val Brand50 = Color(0xFFEDF3FB)

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
    val hover2: Color,
    val sidebar: Color,
    val navActive: Color,
    val navInk: Color,
    val hmInk: List<Color>,
    val activity: List<Color>,
    val activityInk: List<Color>,
)

val LightCm = CmColors(
    canvas = Color(0xFFFAFAFA),
    card = Color(0xFFFFFFFF),
    border = Color(0xFFE8E8E8),
    ink = Color(0xFF171717),
    ink2 = Color(0xFF5B5B5B),
    mute = Color(0xFF6A6A6A),
    ok = Color(0xFF127152),
    okInk = Color(0xFF127152),
    okBg = Color(0xFFE6F5EE),
    warn = Color(0xFFA3570B),
    warnInk = Color(0xFFA3570B),
    warnBg = Color(0xFFFBF0E3),
    crit = Color(0xFFC23A46),
    critBg = Color(0xFFFBEBEC),
    brand = Brand,
    brand50 = Brand50,
    brand25 = Color(0xFFF4F4F4),
    glass = Color(0xEBFAFAFA),
    shadowAmbient = Color(0x08000000),
    shadowSpot = Color(0x05000000),
    hm = listOf(
        Color(0xFFF4F4F4), Color(0xFFE5EEEF), Color(0xFFBDDBDC),
        Color(0xFF78B4B5), Color(0xFF246875),
    ),
    hmInk = listOf(
        Color(0xFF6A6A6A), Color(0xFF365962), Color(0xFF254B52),
        Color(0xFF15373E), Color(0xFFFFFFFF),
    ),
    activity = listOf(
        Color.Transparent, Color(0xFFDEEEE9), Color(0xFFA3D6C7),
        Color(0xFF4CAA90), Color(0xFF19775E),
    ),
    activityInk = listOf(
        Color(0xFF5B5B5B), Color(0xFF345A4F), Color(0xFF24483D),
        Color(0xFF112F27), Color(0xFFFFFFFF),
    ),
    borderStrong = Color(0xFFD9D9D9),
    inset = Color(0xFFFAFAFA),
    hover = Color(0xFFF4F4F4),
    hover2 = Color(0xFFEBEBEB),
    sidebar = Color(0xFFFAFAFA),
    navActive = Color(0xFFEBEBEB),
    navInk = Color(0xFF171717),
)

val DarkCm = CmColors(
    canvas = Color(0xFF111111),
    card = Color(0xFF171717),
    border = Color(0xFF262626),
    ink = Color(0xFFEDEDED),
    ink2 = Color(0xFFB0B0B0),
    mute = Color(0xFF969696),
    ok = Color(0xFF4FCF9F),
    okInk = Color(0xFF4FCF9F),
    okBg = Color(0xFF11291F),
    warn = Color(0xFFF0A85B),
    warnInk = Color(0xFFF0A85B),
    warnBg = Color(0xFF2B1D0E),
    crit = Color(0xFFF0848C),
    critBg = Color(0xFF2C1316),
    brand = Color(0xFF8BB9F2),
    brand50 = Color(0xFF172437),
    brand25 = Color(0xFF1B1B1B),
    glass = Color(0xE0111111),
    shadowAmbient = Color(0x66000000),
    shadowSpot = Color(0x44000000),
    hm = listOf(
        Color(0xFF202020), Color(0xFF243E48), Color(0xFF335D64),
        Color(0xFF78B4B5), Color(0xFFB4DEDD),
    ),
    hmInk = listOf(
        Color(0xFF969696), Color(0xFFA6C9CC), Color(0xFFDCECED),
        Color(0xFF102D34), Color(0xFF183B43),
    ),
    activity = listOf(
        Color.Transparent, Color(0xFF203C34), Color(0xFF30594B),
        Color(0xFF85C9B3), Color(0xFFB8E5D5),
    ),
    activityInk = listOf(
        Color(0xFFB0B0B0), Color(0xFFBCE4D8), Color(0xFFDBF1E9),
        Color(0xFF183C30), Color(0xFF193B31),
    ),
    borderStrong = Color(0xFF343434),
    inset = Color(0xFF141414),
    hover = Color(0xFF202020),
    hover2 = Color(0xFF2A2A2A),
    sidebar = Color(0xFF111111),
    navActive = Color(0xFF292929),
    navInk = Color(0xFFEDEDED),
)

val LocalCmColors = staticCompositionLocalOf { LightCm }

val CmColorsCurrent: CmColors
    @Composable get() = LocalCmColors.current

private fun scheme(cm: CmColors, dark: Boolean): ColorScheme {
    val base = if (dark) darkColorScheme() else lightColorScheme()
    return base.copy(
        primary = cm.brand,
        onPrimary = if (dark) Color(0xFF102033) else Color.White,
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
                displayLarge = webText(36, 43, FontWeight.Medium),
                displayMedium = webText(32, 40, FontWeight.Medium),
                displaySmall = webText(28, 36, FontWeight.Medium),
                headlineLarge = webText(26, 34, FontWeight.Medium),
                headlineMedium = webText(25, 33, FontWeight.Medium),
                headlineSmall = webText(22, 29, FontWeight.Medium),
                titleLarge = webText(20, 28, FontWeight.Medium),
                titleMedium = webText(16, 23, FontWeight.Medium),
                titleSmall = webText(14, 21, FontWeight.Medium),
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
