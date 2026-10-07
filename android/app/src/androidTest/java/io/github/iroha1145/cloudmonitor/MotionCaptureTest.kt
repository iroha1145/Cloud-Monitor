package io.github.iroha1145.cloudmonitor

import android.content.Context
import android.content.pm.ApplicationInfo
import android.graphics.Bitmap
import android.graphics.Color
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.github.iroha1145.cloudmonitor.data.SessionStore
import org.junit.Rule
import org.junit.Test
import org.junit.rules.ExternalResource
import org.junit.rules.RuleChain
import org.junit.rules.TestRule
import org.junit.runner.RunWith
import java.io.Closeable
import java.io.File
import java.io.FileInputStream
import java.io.IOException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketTimeoutException
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

/**
 * Logs into the in-process fixture hub and records the signed-in pages.
 * GitHub Actions runs this on a KVM emulator; the host agent cannot.
 */
@RunWith(AndroidJUnit4::class)
class MotionCaptureTest {
    private val compose = createAndroidComposeRule<MainActivity>()
    private val isolatedSession = object : ExternalResource() {
        override fun before() {
            clearDebugSession()
            enableMotion()
        }
        override fun after() {
            runCatching {
                shell("settings put global animator_duration_scale 0")
                shell("settings put global transition_animation_scale 0")
                shell("settings put global window_animation_scale 0")
            }
            clearDebugSession()
        }
    }

    @get:Rule
    val rules: TestRule = RuleChain.outerRule(isolatedSession).around(compose)

    @Test fun captureFixturePagesAndMotion() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val overview = instrumentation.context.assets.open("connection/overview.json").bufferedReader().use { it.readText() }
        val history = instrumentation.context.assets.open("connection/history_daily.json").bufferedReader().use { it.readText() }
        val subscriptions = instrumentation.context.assets.open("connection/subscriptions.json").bufferedReader().use { it.readText() }
        val shots = File(instrumentation.targetContext.getExternalFilesDir(null), "screenshots").apply { mkdirs() }
        FixtureHub(overview, history, subscriptions).use { server ->
            compose.waitUntil(20_000) {
                compose.onAllNodes(hasText("查看你的用量")).fetchSemanticsNodes().isNotEmpty()
            }
            compose.onNode(hasText("面板地址") and hasSetTextAction())
                .performScrollTo().performTextReplacement(server.baseUrl)
            compose.onNode(hasText("访问密钥") and hasSetTextAction())
                .performScrollTo().performTextReplacement(ACCESS_TOKEN)
            compose.onNodeWithText("进入工作台").performScrollTo().performClick()
            compose.waitUntil(30_000) {
                compose.onAllNodes(hasTestTag("usage-summary")).fetchSemanticsNodes().isNotEmpty()
            }
            ensureLight()
            captureTheme("light", shots)
            compose.onNodeWithTag("theme-toggle").performClick()
            compose.waitForIdle()
            Thread.sleep(400)
            captureTheme("dark", shots)
            compose.onNodeWithTag("theme-toggle").performClick()
            compose.waitForIdle()
            recordMotion(shots)
        }
    }

    private fun captureTheme(theme: String, shots: File) {
        compose.onNodeWithTag("nav-Overview").performClick()
        compose.onNodeWithTag("screen-Overview").performScrollToNode(hasTestTag("usage-summary"))
        compose.waitForIdle()
        Thread.sleep(1_200)
        saveShot(shots, "overview-$theme.png")

        compose.onNodeWithTag("nav-Models").performClick()
        compose.onNodeWithTag("screen-Models").performScrollToNode(hasText("已识别部分"))
        compose.waitForIdle()
        Thread.sleep(700)
        saveShot(shots, "models-$theme.png")

        compose.onNodeWithTag("nav-Devices").performClick()
        compose.waitForIdle()
        Thread.sleep(700)
        saveShot(shots, "devices-$theme.png")

        compose.onNodeWithTag("nav-History").performClick()
        compose.waitForIdle()
        Thread.sleep(700)
        saveShot(shots, "history-$theme.png")

        compose.onNodeWithTag("screen-History").performScrollToNode(hasText("活动一览"))
        compose.waitForIdle()
        Thread.sleep(700)
        saveShot(shots, "heatmap-$theme.png")

        compose.onNodeWithTag("screen-History").performScrollToNode(hasTestTag("session-search"))
        compose.waitForIdle()
        Thread.sleep(400)
        saveShot(shots, "sessions-$theme.png")

        compose.onNodeWithTag("nav-Quota").performClick()
        compose.onNodeWithTag("screen-Quota").performScrollToNode(hasText("下次续订"))
        compose.waitForIdle()
        Thread.sleep(700)
        saveShot(shots, "quota-$theme.png")
    }

    private fun recordMotion(shots: File) {
        val video = File("/data/local/tmp/cm-motion.mp4")
        val recording = thread(name = "screenrecord-wait", isDaemon = true) {
            val descriptor = InstrumentationRegistry.getInstrumentation().uiAutomation.executeShellCommand(
                "screenrecord --time-limit 15 --bit-rate 4000000 ${video.absolutePath}",
            )
            FileInputStream(descriptor.fileDescriptor).use { it.readBytes() }
            descriptor.close()
        }
        Thread.sleep(600)
        listOf("Models", "Devices", "Quota", "History", "Overview", "History", "Overview").forEach { tab ->
            compose.onNodeWithTag("nav-$tab").performClick()
            Thread.sleep(1400)
        }
        compose.onNodeWithTag("refresh").performClick()
        Thread.sleep(2200)
        recording.join(20_000)
        check(!recording.isAlive) { "screen recording did not finish" }
        val size = shellOutput("stat -c %s ${video.absolutePath}")
            .lineSequence()
            .mapNotNull { it.trim().toLongOrNull() }
            .firstOrNull() ?: 0L
        check(size > 50_000L) { "motion video is missing or too small ($size bytes)" }
        shellOutput("cp ${video.absolutePath} ${File(shots, "motion.mp4").absolutePath}")
    }

    private fun saveShot(directory: File, name: String) {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        instrumentation.waitForIdleSync()
        val bitmap = instrumentation.uiAutomation.takeScreenshot()
            ?: error("screenshot failed: $name")
        try {
            assertFrame(bitmap, name)
            File(directory, name).outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        } finally {
            bitmap.recycle()
        }
    }

    private fun assertFrame(bitmap: Bitmap, name: String) {
        val stepX = (bitmap.width / 24).coerceAtLeast(1)
        val stepY = (bitmap.height / 48).coerceAtLeast(1)
        val colors = HashSet<Int>()
        var dark = 0
        var samples = 0
        var y = 0
        while (y < bitmap.height) {
            var x = 0
            while (x < bitmap.width) {
                val pixel = bitmap.getPixel(x, y)
                colors.add(pixel)
                val sum = Color.red(pixel) + Color.green(pixel) + Color.blue(pixel)
                if (sum < 24) dark++
                samples++
                x += stepX
            }
            y += stepY
        }
        check(colors.size >= 8) { "$name looks blank (${colors.size} colors)" }
        check(dark < samples * 0.7) { "$name is mostly black ($dark/$samples)" }
    }

    private fun ensureLight() {
        val dark = compose.onAllNodes(hasText("切换浅色外观")).fetchSemanticsNodes().isNotEmpty() ||
            compose.onAllNodes(hasContentDescription("切换浅色外观")).fetchSemanticsNodes().isNotEmpty()
        if (dark) {
            compose.onNodeWithTag("theme-toggle").performClick()
            compose.waitForIdle()
            Thread.sleep(400)
        }
    }

    private fun enableMotion() {
        shell("settings put global animator_duration_scale 1")
        shell("settings put global transition_animation_scale 1")
        shell("settings put global window_animation_scale 1")
    }

    private fun shell(command: String) {
        shellOutput(command)
    }

    private fun shellOutput(command: String): String {
        InstrumentationRegistry.getInstrumentation().uiAutomation.executeShellCommand(command).use { descriptor ->
            return FileInputStream(descriptor.fileDescriptor).use { it.readBytes() }.toString(Charsets.UTF_8)
        }
    }

    private fun clearDebugSession() {
        val context = debugContext()
        val store = SessionStore(context)
        store.ensureSecrets()
        store.clearSecrets()
        store.hubUrl = ""
        check(context.getSharedPreferences("cm_session_meta", Context.MODE_PRIVATE).edit()
            .putBoolean("signed_in", false).putBoolean("demo", false).putString("hub_url", "").commit())
    }

    private fun debugContext(): Context {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        check(context.packageName == "io.github.iroha1145.cloudmonitor.debug")
        check(context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0)
        return context
    }

    private class FixtureHub(
        private val overview: String,
        private val history: String,
        private val subscriptions: String,
    ) : Closeable {
        private val closed = AtomicBoolean(false)
        private val listener = ServerSocket().apply {
            reuseAddress = true
            bind(InetSocketAddress(InetAddress.getByName("127.0.0.1"), 0))
            soTimeout = 250
        }
        val baseUrl = "http://127.0.0.1:${listener.localPort}"
        private val worker = Executors.newSingleThreadExecutor { runnable ->
            Thread(runnable, "motion-capture-fixture").apply { isDaemon = true }
        }

        init {
            worker.execute {
                while (!closed.get()) {
                    val socket = try {
                        listener.accept()
                    } catch (_: SocketTimeoutException) {
                        continue
                    } catch (_: IOException) {
                        break
                    }
                    try {
                        socket.use { serve(it) }
                    } catch (_: IOException) {
                    }
                }
            }
        }

        private fun serve(socket: Socket) {
            socket.soTimeout = 2_000
            val reader = socket.getInputStream().bufferedReader(Charsets.US_ASCII)
            val request = reader.readLine() ?: return
            val path = request.split(' ', limit = 3).getOrNull(1)?.substringBefore('?') ?: return
            var authorized = false
            while (true) {
                val line = reader.readLine() ?: return
                if (line.isEmpty()) break
                if (line.substringBefore(':').equals("Authorization", ignoreCase = true)) {
                    authorized = line.substringAfter(':', "").trim() == "Bearer $ACCESS_TOKEN"
                }
            }
            val body = when {
                !authorized -> """{"error":"synthetic test access denied"}"""
                path == "/api/v1/tm/overview" -> overview
                path == "/api/v1/tm/history/daily" -> history
                path == "/api/v1/tm/subscriptions" -> subscriptions
                path == "/api/v1/tm/provider-status" -> """{"providers":[]}"""
                else -> """{"error":"fixture endpoint unavailable"}"""
            }
            val status = when {
                !authorized -> 401
                path == "/api/v1/tm/overview" || path == "/api/v1/tm/history/daily" ||
                    path == "/api/v1/tm/subscriptions" || path == "/api/v1/tm/provider-status" -> 200
                else -> 404
            }
            val bytes = body.toByteArray(Charsets.UTF_8)
            val reason = when (status) { 200 -> "OK"; 401 -> "Unauthorized"; else -> "Not Found" }
            socket.getOutputStream().apply {
                write("HTTP/1.1 $status $reason\r\nContent-Type: application/json\r\nContent-Length: ${bytes.size}\r\nConnection: close\r\n\r\n".toByteArray())
                write(bytes)
                flush()
            }
        }

        override fun close() {
            if (!closed.compareAndSet(false, true)) return
            runCatching { listener.close() }
            worker.shutdownNow()
            worker.awaitTermination(3, TimeUnit.SECONDS)
        }
    }

    private companion object {
        const val ACCESS_TOKEN = "connection-test-synthetic-access-token-2026"
    }
}
