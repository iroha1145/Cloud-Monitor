package io.github.iroha1145.cloudmonitor

import android.content.pm.ActivityInfo
import android.graphics.Bitmap
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.After
import org.junit.Assert.assertNotEquals
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

@RunWith(AndroidJUnit4::class)
class WorkbenchTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    @Before fun openDemo() {
        shell("settings put system font_scale 1.0")
        compose.waitUntil(20_000) {
            compose.onAllNodesWithText("体验演示").fetchSemanticsNodes().isNotEmpty() ||
                compose.onAllNodesWithTag("settings").fetchSemanticsNodes().isNotEmpty()
        }
        if (compose.onAllNodesWithText("体验演示").fetchSemanticsNodes().isEmpty()) {
            compose.onNodeWithTag("settings").performClick()
            compose.onNodeWithText("退出演示").performClick()
            compose.onNodeWithText("确认退出").performClick()
        }
        compose.onNodeWithText("体验演示").performScrollTo().performClick()
        compose.waitUntil(20_000) { compose.onAllNodesWithTag("usage-summary").fetchSemanticsNodes().isNotEmpty() }
        compose.waitForIdle()
        compose.onNodeWithTag("settings").performClick()
        if (compose.onAllNodesWithText("切换浅色外观").fetchSemanticsNodes().isNotEmpty())
            compose.onNodeWithText("切换浅色外观").performClick()
        else shell("input keyevent 4")
    }

    @After fun restoreDevice() {
        shell("settings put system font_scale 1.0")
        compose.activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
    }

    @Test fun fiveDestinationsAndModelSearch() {
        shot("overview-light")
        listOf("Devices", "Models", "Quota", "History", "Overview").forEach { tab ->
            compose.onNodeWithTag("nav-$tab").performClick()
            compose.onNodeWithTag("screen-$tab").assertIsDisplayed()
            compose.onNodeWithTag("screen-$tab").performTouchInput { swipeUp() }
            compose.onNodeWithTag("screen-$tab").performTouchInput { swipeDown() }
            shot(tab.lowercase())
        }
        compose.onNodeWithTag("nav-Models").performClick()
        compose.onNodeWithTag("screen-Models").performScrollToNode(hasTestTag("model-search"))
        compose.onNodeWithTag("model-search").performTextInput("no-such-model-123")
        compose.onNodeWithText("没有匹配的模型").assertExists()
        compose.onNodeWithTag("model-search").performTextClearance()
        compose.onNodeWithText("没有匹配的模型").assertDoesNotExist()
    }

    @Test fun dailyTrendSelectionAndPersistentDetails() {
        compose.onNodeWithTag("screen-Overview").performScrollToNode(hasTestTag("trend-30"))
        compose.onNodeWithTag("trend-30").assertIsSelected()
        compose.onNodeWithTag("trend-7").performClick().assertIsSelected()
        compose.onNodeWithTag("trend-30").performClick().assertIsSelected()
        compose.onNodeWithTag("screen-Overview").performScrollToNode(hasTestTag("trend-chart"))
        shot("trend-line-tokens")
        val before = compose.onNodeWithTag("trend-chart").fetchSemanticsNode().config.toString()
        compose.onNodeWithTag("trend-chart").performSemanticsAction(SemanticsActions.SetProgress) { it(0f) }
        val after = compose.onNodeWithTag("trend-chart").fetchSemanticsNode().config.toString()
        assertNotEquals("Date selection must change the displayed day", before, after)
        compose.onNodeWithTag("screen-Overview").performScrollToNode(hasTestTag("trend-next"))
        compose.onNodeWithTag("trend-previous").assertIsNotEnabled()
        compose.onNodeWithTag("trend-next").performClick()
        compose.onNodeWithTag("trend-previous").assertIsEnabled().performClick()
        compose.onNodeWithTag("trend-details").performClick()
        compose.onNodeWithText("全部词元").assertIsDisplayed()
        compose.mainClock.advanceTimeBy(4_000)
        compose.onNodeWithText("关闭详情").assertExists()
        shot("trend-detail")
        compose.onNodeWithText("关闭详情").performScrollTo().performClick()
        compose.onNodeWithText("全部词元").assertDoesNotExist()
        compose.onNodeWithTag("screen-Overview").performScrollToNode(hasTestTag("trend-cost"))
        compose.onNodeWithTag("trend-cost").performClick().assertIsSelected()
        shot("trend-line-cost")
        compose.activityRule.scenario.recreate()
        compose.onNodeWithTag("screen-Overview").performScrollToNode(hasTestTag("trend-cost"))
        compose.onNodeWithTag("trend-cost").assertIsSelected()
        compose.onNodeWithTag("screen-Overview").performScrollToNode(hasTestTag("trend-previous"))
        compose.onNodeWithTag("trend-previous").assertIsNotEnabled()
        compose.onNodeWithTag("screen-Overview").performScrollToNode(hasTestTag("trend-chart"))
        compose.onNodeWithTag("trend-chart").performTouchInput { swipeRight() }
        compose.onNodeWithTag("screen-Overview").performScrollToNode(hasTestTag("trend-previous"))
        compose.onNodeWithTag("trend-previous").assertIsEnabled()
    }

    @Test fun modelSearchSurvivesKeyboardDismissalRotationAndTabSwitch() {
        compose.onNodeWithTag("nav-Models").performClick()
        compose.onNodeWithTag("screen-Models").performScrollToNode(hasTestTag("model-search"))
        compose.onNodeWithTag("model-search").performTextInput("no-such-model-rotation")
        compose.onNodeWithText("没有匹配的模型").assertExists()
        shell("input keyevent 4")
        compose.onNodeWithTag("nav-Models").assertIsSelected()
        compose.onNodeWithTag("model-search").assertTextContains("no-such-model-rotation")
        compose.activityRule.scenario.recreate()
        compose.onNodeWithTag("screen-Models").performScrollToNode(hasTestTag("model-search"))
        compose.onNodeWithTag("model-search").assertTextContains("no-such-model-rotation")
        compose.activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE
        compose.waitUntil(15_000) { compose.activity.resources.configuration.orientation == android.content.res.Configuration.ORIENTATION_LANDSCAPE }
        compose.onNodeWithTag("screen-Models").performScrollToNode(hasTestTag("model-search"))
        compose.onNodeWithTag("model-search").assertTextContains("no-such-model-rotation")
        compose.onNodeWithText("没有匹配的模型").assertExists()
        compose.onNodeWithTag("nav-Overview").performClick()
        compose.onNodeWithTag("nav-Models").performClick()
        compose.onNodeWithTag("screen-Models").performScrollToNode(hasTestTag("model-search"))
        compose.onNodeWithTag("model-search").assertTextContains("no-such-model-rotation")
        compose.activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
        compose.waitUntil(15_000) { compose.onAllNodesWithTag("bottom-navigation").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("screen-Models").performScrollToNode(hasTestTag("model-search"))
        compose.onNodeWithTag("model-search").assertTextContains("no-such-model-rotation")
    }

    @Test fun deviceSessionAndTrendFiltersSurviveRecreation() {
        compose.onNodeWithTag("screen-Overview").performScrollToNode(hasTestTag("trend-7"))
        compose.onNodeWithTag("trend-7").performClick()
        compose.onNodeWithTag("nav-Devices").performClick()
        compose.onNodeWithTag("screen-Devices").performScrollToNode(hasTestTag("device-search"))
        compose.onNodeWithTag("device-search").performTextInput("no-such-device")
        shell("input keyevent 4")
        compose.onNodeWithTag("nav-History").performClick()
        compose.onNodeWithTag("screen-History").performScrollToNode(hasTestTag("session-search"))
        compose.onNodeWithTag("session-search").performTextInput("no-such-session")
        shell("input keyevent 4")
        compose.activityRule.scenario.recreate()
        compose.onNodeWithTag("screen-History").performScrollToNode(hasTestTag("session-search"))
        compose.onNodeWithTag("session-search").assertTextContains("no-such-session")
        compose.onNodeWithTag("nav-Devices").performClick()
        compose.onNodeWithTag("screen-Devices").performScrollToNode(hasTestTag("device-search"))
        compose.onNodeWithTag("device-search").assertTextContains("no-such-device")
        compose.onNodeWithTag("nav-Overview").performClick()
        compose.onNodeWithTag("screen-Overview").performScrollToNode(hasTestTag("trend-7"))
        compose.onNodeWithTag("trend-7").assertIsSelected()
    }

    @Test fun darkThemeLargeTextAndLandscapeRetainNavigation() {
        compose.onNodeWithTag("settings").performClick()
        val switch = compose.onAllNodesWithText("切换深色外观").fetchSemanticsNodes()
        if (switch.isNotEmpty()) compose.onNodeWithText("切换深色外观").performClick()
        else shell("input keyevent 4")
        shot("overview-dark")
        compose.onNodeWithTag("nav-Models").performClick()
        compose.activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE
        compose.waitUntil(15_000) { compose.activity.resources.configuration.orientation == android.content.res.Configuration.ORIENTATION_LANDSCAPE }
        compose.onNodeWithTag("nav-Models").assertIsSelected()
        compose.onNodeWithTag("screen-Models").assertIsDisplayed()
        shot("landscape-models")
        compose.activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
        compose.waitUntil(15_000) { compose.onAllNodesWithTag("bottom-navigation").fetchSemanticsNodes().isNotEmpty() }
        shell("settings put system font_scale 2.0")
        compose.waitUntil(15_000) { compose.activity.resources.configuration.fontScale >= 1.9f }
        listOf("Overview", "Devices", "Models", "Quota", "History").forEach { tab ->
            compose.onNodeWithTag("nav-$tab").performClick()
            compose.onNodeWithTag("screen-$tab").assertIsDisplayed()
            shot("large-text-${tab.lowercase()}")
            compose.onNodeWithTag("screen-$tab").performTouchInput { swipeUp() }
        }
    }

    private fun shell(command: String) {
        InstrumentationRegistry.getInstrumentation().uiAutomation.executeShellCommand(command).use { descriptor ->
            java.io.FileInputStream(descriptor.fileDescriptor).use { it.readBytes() }
        }
    }

    private fun shot(name: String) {
        compose.waitForIdle()
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        instrumentation.waitForIdleSync()
        // Semantics can be idle one frame before SurfaceFlinger presents a theme/rotation change.
        android.os.SystemClock.sleep(300)
        val directory = File(instrumentation.targetContext.getExternalFilesDir(null), "screenshots").apply { mkdirs() }
        instrumentation.uiAutomation.takeScreenshot()?.let { bitmap ->
            File(directory, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
            bitmap.recycle()
        }
    }
}
