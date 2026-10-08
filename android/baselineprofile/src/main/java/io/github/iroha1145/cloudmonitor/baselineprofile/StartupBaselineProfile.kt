package io.github.iroha1145.cloudmonitor.baselineprofile

import androidx.benchmark.macro.junit4.BaselineProfileRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.filters.LargeTest
import androidx.test.uiautomator.By
import androidx.test.uiautomator.Until
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * 收集冷启动到总览、五个分页，以及总览数字滚轮播完的基线配置。
 *
 * 不要在 GitHub Actions 的界面测试里跑这个用例。那台模拟器把动画时长设成 0，
 * 而且 `connectedDebugAndroidTest` 只测 `:app`。在本机或真机上生成：
 *
 * ./gradlew :app:generateBaselineProfile
 *
 * 需要已连接的 arm64 或 x86_64 设备，动画时长不为 0。生成结果会写进
 * baselineprofile 模块，下一次 release 构建再打进 APK。
 */
@RunWith(AndroidJUnit4::class)
@LargeTest
class StartupBaselineProfile {
    @get:Rule
    val rule = BaselineProfileRule()

    @Test
    fun coldStartTabsAndTicker() = rule.collect(
        packageName = "io.github.iroha1145.cloudmonitor",
        includeInStartupProfile = true,
    ) {
        startActivityAndWait()
        device.findObject(By.text("体验演示"))?.click()
        device.wait(Until.hasObject(By.text("总用量")), 20_000)
        // Ledger ticker is 450ms plus a short stagger. Wait until the digits settle.
        Thread.sleep(1_200)
        listOf("模型", "设备", "配额", "历史", "总览").forEach { label ->
            val tab = device.findObject(By.text(label))
            if (tab != null) {
                tab.click()
                device.waitForIdle()
            }
        }
    }
}
