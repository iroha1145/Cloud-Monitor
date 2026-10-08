package io.github.iroha1145.cloudmonitor

import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.github.iroha1145.cloudmonitor.ui.components.NumberTicker
import io.github.iroha1145.cloudmonitor.ui.components.RecomposeProbe
import org.junit.After
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** The rolling digits must finish without a composition on every animation frame. */
@RunWith(AndroidJUnit4::class)
class NumberTickerRecomposeTest {
    @get:Rule
    val compose = createComposeRule()

    @Before fun enableMotion() {
        shell("settings put global animator_duration_scale 1")
        shell("settings put global transition_animation_scale 1")
        shell("settings put global window_animation_scale 1")
    }

    @After fun restoreStillness() {
        shell("settings put global animator_duration_scale 0")
        shell("settings put global transition_animation_scale 0")
        shell("settings put global window_animation_scale 0")
    }

    @Test fun settledTickerStaysUnderAFrameBudget() {
        val probe = RecomposeProbe()
        compose.setContent {
            MaterialTheme {
                NumberTicker(
                    value = "184.6",
                    color = Color.Black,
                    style = MaterialTheme.typography.headlineMedium,
                    recomposeProbe = probe,
                )
            }
        }
        compose.waitUntil(5_000) { probe.count >= 2 }
        Thread.sleep(1_500)
        compose.waitForIdle()
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val countFile = java.io.File(context.getExternalFilesDir(null), "recompose-count.txt")
        countFile.writeText(probe.count.toString())
        android.util.Log.i("TickerRecompose", "count=${probe.count} file=${countFile.absolutePath}")
        assertTrue(
            "NumberTicker recomposed ${probe.count} times during the roll; a per-frame read would be much higher",
            probe.count in 2..24,
        )
        compose.onNode(hasText("184.6")).assertExists()
    }

    private fun shell(command: String) {
        InstrumentationRegistry.getInstrumentation().uiAutomation.executeShellCommand(command).use { descriptor ->
            java.io.FileInputStream(descriptor.fileDescriptor).use { it.readBytes() }
        }
    }
}
