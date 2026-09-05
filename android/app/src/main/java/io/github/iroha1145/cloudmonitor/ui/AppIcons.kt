package io.github.iroha1145.cloudmonitor.ui

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.unit.dp

/**
 * 自绘描边图标族：24 网格 / 2px 描边 / 圆头圆角，风格对齐 Material Symbols（Rounded）。
 * 不依赖 material-icons-extended；Icon() 的 tint 经 ColorFilter 作用于描边。
 */
object AppIcons {
    val ChevronLeft by lazy { icon("ChevronLeft", "M15,18l-6,-6 6,-6") }
    val ChevronRight by lazy { icon("ChevronRight", "M9,18l6,-6 -6,-6") }
    val Bolt by lazy { icon("Bolt", "M13,2L4,14h7l-1,8 10,-12h-7z") }
    val Database by lazy { icon("Database", "M3,6a9,3 0 1 0 18,0 9,3 0 1 0 -18,0", "M3,6v12a9,3 0 0 0 18,0V6", "M3,12a9,3 0 0 0 18,0") }
    val More: ImageVector by lazy { icon("More", "M5,12h0.01", "M12,12h0.01", "M19,12h0.01") }
    val Models: ImageVector by lazy { icon("Models", "M12,3l9,5-9,5-9-5z", "M3,12l9,5 9-5", "M3,16l9,5 9-5") }
    val Close: ImageVector by lazy { icon("Close", "M6,6l12,12", "M18,6L6,18") }

    val GridView: ImageVector by lazy {
        icon(
            "GridView",
            "M5.25,3.5h3.75a1.75,1.75 0 0 1 1.75,1.75v3.75a1.75,1.75 0 0 1 -1.75,1.75h-3.75a1.75,1.75 0 0 1 -1.75,-1.75v-3.75a1.75,1.75 0 0 1 1.75,-1.75z",
            "M15.0,3.5h3.75a1.75,1.75 0 0 1 1.75,1.75v3.75a1.75,1.75 0 0 1 -1.75,1.75h-3.75a1.75,1.75 0 0 1 -1.75,-1.75v-3.75a1.75,1.75 0 0 1 1.75,-1.75z",
            "M5.25,13.25h3.75a1.75,1.75 0 0 1 1.75,1.75v3.75a1.75,1.75 0 0 1 -1.75,1.75h-3.75a1.75,1.75 0 0 1 -1.75,-1.75v-3.75a1.75,1.75 0 0 1 1.75,-1.75z",
            "M15.0,13.25h3.75a1.75,1.75 0 0 1 1.75,1.75v3.75a1.75,1.75 0 0 1 -1.75,1.75h-3.75a1.75,1.75 0 0 1 -1.75,-1.75v-3.75a1.75,1.75 0 0 1 1.75,-1.75z",
        )
    }
    val Computer: ImageVector by lazy {
        icon(
            "Computer",
            "M4.75,4h14.5a2,2 0 0 1 2,2v9a2,2 0 0 1 -2,2h-14.5a2,2 0 0 1 -2,-2v-9a2,2 0 0 1 2,-2z",
            "M8.5,20.5h7",
            "M12,17v3.5",
        )
    }
    val AccountBalanceWallet: ImageVector by lazy {
        icon(
            "AccountBalanceWallet",
            "M5.5,6h13.0a2.5,2.5 0 0 1 2.5,2.5v7.5a2.5,2.5 0 0 1 -2.5,2.5h-13.0a2.5,2.5 0 0 1 -2.5,-2.5v-7.5a2.5,2.5 0 0 1 2.5,-2.5z",
            "M21,10.75h-4.25a2,2 0 0 0 0,4h4.25",
            "M16.9,12.75h0.01",
        )
    }
    val History: ImageVector by lazy {
        icon(
            "History",
            "M3,12a9,9 0 1 0 9,-9 9.75,9.75 0 0 0 -6.74,2.74L3,8",
            "M3,3v5h5",
            "M12,7v5l4,2",
        )
    }
    val DarkMode: ImageVector by lazy {
        icon("DarkMode", "M12,3a6,6 0 0 0 9,9 9,9 0 1 1 -9,-9Z")
    }
    val LightMode: ImageVector by lazy {
        icon(
            "LightMode",
            "M12,8a4,4 0 1 0 0,8 4,4 0 1 0 0,-8",
            "M12,2.5v2",
            "M12,19.5v2",
            "M2.5,12h2",
            "M19.5,12h2",
            "M5.28,5.28l1.42,1.42",
            "M17.3,17.3l1.42,1.42",
            "M18.72,5.28l-1.42,1.42",
            "M6.7,17.3l-1.42,1.42",
        )
    }
    val Refresh: ImageVector by lazy {
        icon(
            "Refresh",
            "M3,12a9,9 0 0 1 9,-9 9.75,9.75 0 0 1 6.74,2.74L21,8",
            "M21,3v5h-5",
            "M21,12a9,9 0 0 1 -9,9 9.75,9.75 0 0 1 -6.74,-2.74L3,16",
            "M8,16H3v5",
        )
    }
    val Logout: ImageVector by lazy {
        icon(
            "Logout",
            "M9,21H5a2,2 0 0 1 -2,-2V5a2,2 0 0 1 2,-2h4",
            "M16,17l5,-5 -5,-5",
            "M21,12H9",
        )
    }
    val Language: ImageVector by lazy {
        icon(
            "Language",
            "M12,2a10,10 0 1 0 0,20 10,10 0 1 0 0,-20",
            "M2,12h20",
            "M12,2a14.5,14.5 0 0 0 0,20 14.5,14.5 0 0 0 0,-20",
        )
    }
    val Key: ImageVector by lazy {
        icon(
            "Key",
            "M6.75,8.75a3.25,3.25 0 1 0 0,6.5 3.25,3.25 0 1 0 0,-6.5",
            "M10,12h10.5",
            "M17.25,12v2.9",
            "M20.5,12v2.9",
        )
    }
    val PlayArrow: ImageVector by lazy {
        icon("PlayArrow", "M8.5,5.75 18.25,12 8.5,18.25z")
    }
    val Cloud: ImageVector by lazy {
        icon("Cloud", "M17.5,19H9a7,7 0 1 1 6.71,-9h1.79a4.5,4.5 0 1 1 0,9Z")
    }
    val Terminal: ImageVector by lazy {
        icon(
            "Terminal",
            "M5.5,3.75h13.0a2.5,2.5 0 0 1 2.5,2.5v11.5a2.5,2.5 0 0 1 -2.5,2.5h-13.0a2.5,2.5 0 0 1 -2.5,-2.5v-11.5a2.5,2.5 0 0 1 2.5,-2.5z",
            "M7.5,9.75l2.5,2.5 -2.5,2.5",
            "M12.75,14.75h3.75",
        )
    }
    val SystemUpdate: ImageVector by lazy {
        icon(
            "SystemUpdate",
            "M9.0,2.75h6.0a2.5,2.5 0 0 1 2.5,2.5v13.5a2.5,2.5 0 0 1 -2.5,2.5h-6.0a2.5,2.5 0 0 1 -2.5,-2.5v-13.5a2.5,2.5 0 0 1 2.5,-2.5z",
            "M12,7.75v6",
            "M9.4,11.35 12,13.95 14.6,11.35",
            "M12,17.9h0.01",
        )
    }
    val OpenInNew: ImageVector by lazy {
        icon(
            "OpenInNew",
            "M15,3h6v6",
            "M10,14L21,3",
            "M18,13v6a2,2 0 0 1 -2,2H5a2,2 0 0 1 -2,-2V8a2,2 0 0 1 2,-2h6",
        )
    }

    /** 品牌符号：云 + 上升用量柱，与启动图标/Splash 同源。 */
    val CloudPulse: ImageVector by lazy {
        icon(
            "CloudPulse",
            "M17.5,19H9a7,7 0 1 1 6.71,-9h1.79a4.5,4.5 0 1 1 0,9Z",
            "M8.75,16v-1.6",
            "M12,16v-3.4",
            "M15.25,16v-5.2",
        )
    }
}

private fun icon(name: String, vararg pathData: String): ImageVector =
    ImageVector.Builder(
        name = name,
        defaultWidth = 24.dp,
        defaultHeight = 24.dp,
        viewportWidth = 24f,
        viewportHeight = 24f,
    ).apply {
        for (d in pathData) {
            addPath(
                pathData = PathParser().parsePathString(d).toNodes(),
                fill = null,
                stroke = SolidColor(Color.Black),
                strokeLineWidth = 2f,
                strokeLineCap = StrokeCap.Round,
                strokeLineJoin = StrokeJoin.Round,
            )
        }
    }.build()
