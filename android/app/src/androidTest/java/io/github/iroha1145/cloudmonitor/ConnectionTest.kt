package io.github.iroha1145.cloudmonitor

import android.content.Context
import android.content.pm.ApplicationInfo
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.github.iroha1145.cloudmonitor.data.SessionStore
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.ExternalResource
import org.junit.rules.RuleChain
import org.junit.rules.TestRule
import org.junit.runner.RunWith
import java.io.Closeable
import java.io.IOException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketTimeoutException
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

/** Exercises the real login/session/network path using only this device's loopback interface. */
@RunWith(AndroidJUnit4::class)
class ConnectionTest {
    private val compose = createAndroidComposeRule<MainActivity>()

    // This must run BEFORE ActivityScenario launches; @Before would be too late to
    // prevent a previously persisted demo or real connection from being restored.
    private val isolatedSession = object : ExternalResource() {
        override fun before() = clearDebugSession()
        override fun after() = clearDebugSession()
    }

    @get:Rule
    val rules: TestRule = RuleChain.outerRule(isolatedSession).around(compose)

    @Test fun rejectsWrongKeyConnectsAndKeepsTheSessionAfterActivityRecreation() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val overview = instrumentation.context.assets.open("connection/overview.json").bufferedReader().use { it.readText() }
        val history = instrumentation.context.assets.open("connection/history_daily.json").bufferedReader().use { it.readText() }
        FixtureServer(overview, history).use { server ->
            waitForText("连接你的用量面板")
            compose.onNodeWithTag("usage-summary").assertDoesNotExist()
            compose.onNode(hasText("面板地址") and hasSetTextAction())
                .performScrollTo().performTextReplacement(server.baseUrl)
            compose.onNode(hasText("访问密钥") and hasSetTextAction())
                .performScrollTo().performTextReplacement(WRONG_ACCESS_TOKEN)
            connect()

            waitForText("密钥不正确，请重新输入。")
            compose.onNodeWithText("密钥不正确，请重新输入。").performScrollTo().assertIsDisplayed()
            compose.onNodeWithTag("usage-summary").assertDoesNotExist()
            assertEquals("The actual HTTP endpoint must reject the wrong key", 1, server.rejectedOverview.get())
            assertFalse(readSession().signedIn)

            compose.onNode(hasText("访问密钥") and hasSetTextAction())
                .performScrollTo().performTextReplacement(TEST_ACCESS_TOKEN)
            connect()
            waitForSummary()
            assertFixtureSummary()
            compose.waitUntil(20_000) { server.acceptedHistory.get() > 0 }
            assertTrue(server.acceptedOverview.get() > 0)

            val saved = readSession()
            assertTrue("The emulator's encrypted session must be available", saved.encryptionAvailable)
            assertTrue(saved.signedIn)
            assertFalse("Fixture responses must never select the demo path", saved.demo)
            assertEquals(server.baseUrl, saved.hubUrl)
            assertEquals(TEST_ACCESS_TOKEN, saved.token)

            val previousActivity = compose.activity
            compose.activityRule.scenario.recreate()
            waitForSummary()
            assertNotSame("The activity must actually be recreated", previousActivity, compose.activity)
            compose.onNodeWithText("连接你的用量面板").assertDoesNotExist()

            // A visible cached card alone is insufficient: require a new authorized
            // request after recreation, then verify the fixture is still displayed.
            val beforeRefresh = server.acceptedOverview.get()
            compose.onNodeWithTag("refresh").assertIsEnabled().performClick()
            compose.waitUntil(20_000) { server.acceptedOverview.get() > beforeRefresh }
            compose.waitUntil(20_000) {
                compose.onAllNodes(hasTestTag("refresh") and isEnabled()).fetchSemanticsNodes().isNotEmpty()
            }
            assertFixtureSummary()
            assertEquals(1, server.rejectedOverview.get())

            compose.onNodeWithTag("settings").performClick()
            compose.onNodeWithText("断开连接").assertIsDisplayed()
            compose.onNodeWithText("退出演示").assertDoesNotExist()
            compose.onNodeWithText("断开连接").performClick()
            compose.onNodeWithText("确认退出").performClick()
            waitForText("连接你的用量面板")
            val disconnected = readSession()
            compose.waitUntil(5_000) { !disconnected.signedIn && disconnected.token.isEmpty() }
            server.assertHealthy()
        }
    }

    private fun connect() {
        compose.onNodeWithText("连接面板").performScrollTo().performClick()
    }

    private fun waitForText(text: String) {
        compose.waitUntil(20_000) { compose.onAllNodesWithText(text).fetchSemanticsNodes().isNotEmpty() }
    }

    private fun waitForSummary() {
        compose.waitUntil(20_000) { compose.onAllNodesWithTag("usage-summary").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("usage-summary").assertIsDisplayed()
    }

    private fun assertFixtureSummary() {
        val inSummary = hasAnyAncestor(hasTestTag("usage-summary"))
        compose.onNode(hasText("184.6万") and inSummary).assertIsDisplayed()
        compose.onNode(hasText("\$4.82") and inSummary).assertIsDisplayed()
    }

    private fun readSession(): SessionStore = SessionStore(debugContext()).apply { ensureSecrets() }

    private fun clearDebugSession() {
        val context = debugContext()
        val store = SessionStore(context)
        store.ensureSecrets()
        store.clearSecrets()
        store.hubUrl = ""
        // Commit the metadata before launch; keep keystore/keyset material intact.
        check(context.getSharedPreferences("cm_session_meta", Context.MODE_PRIVATE).edit()
            .putBoolean("signed_in", false).putBoolean("demo", false).putString("hub_url", "").commit())
    }

    private fun debugContext(): Context {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        check(context.packageName == "io.github.iroha1145.cloudmonitor.debug") {
            "ConnectionTest only isolates the debug package"
        }
        check(context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0)
        return context
    }

    /** One bounded worker; no coroutine jobs, remote hosts, or retained request headers. */
    private class FixtureServer(private val overview: String, private val history: String) : Closeable {
        private val closed = AtomicBoolean(false)
        private val failure = AtomicReference<Throwable?>(null)
        private val activeSocket = AtomicReference<Socket?>(null)
        private val listener = ServerSocket().apply {
            reuseAddress = true
            bind(InetSocketAddress(InetAddress.getByName("127.0.0.1"), 0))
            soTimeout = 250
        }
        val baseUrl = "http://127.0.0.1:${listener.localPort}"
        val rejectedOverview = AtomicInteger(0)
        val acceptedOverview = AtomicInteger(0)
        val acceptedHistory = AtomicInteger(0)
        private val worker = Executors.newSingleThreadExecutor { runnable ->
            Thread(runnable, "connection-test-loopback").apply { isDaemon = true }
        }

        init {
            worker.execute {
                try {
                    while (!closed.get()) {
                        val socket = try {
                            listener.accept()
                        } catch (_: SocketTimeoutException) {
                            continue
                        } catch (error: IOException) {
                            if (closed.get()) break else throw error
                        }
                        activeSocket.set(socket)
                        try {
                            socket.use { serve(it) }
                        } catch (_: IOException) {
                            // Activity recreation/logout may cancel an in-flight call.
                            // The socket timeout also bounds incomplete request headers.
                        } finally {
                            activeSocket.compareAndSet(socket, null)
                        }
                    }
                } catch (error: Throwable) {
                    if (!closed.get()) failure.compareAndSet(null, error)
                }
            }
        }

        private fun serve(socket: Socket) {
            socket.soTimeout = 2_000
            val reader = socket.getInputStream().bufferedReader(Charsets.US_ASCII)
            val requestLine = reader.readLine() ?: return
            if (requestLine.length > 8_192) return
            val parts = requestLine.split(' ', limit = 3)
            val path = parts.getOrNull(1)?.substringBefore('?') ?: return
            var authorized = false
            var terminated = false
            for (index in 0 until 64) {
                val line = reader.readLine() ?: return
                if (line.length > 8_192) return
                if (line.isEmpty()) {
                    terminated = true
                    break
                }
                if (line.substringBefore(':').equals("Authorization", ignoreCase = true)) {
                    authorized = line.substringAfter(':', "").trim() == "Bearer $TEST_ACCESS_TOKEN"
                }
            }
            if (!terminated) return
            val status: Int
            val body: String
            if (!authorized) {
                status = 401
                body = """{"error":"synthetic test access denied"}"""
            } else when (path) {
                "/api/v1/tm/overview" -> { status = 200; body = overview }
                "/api/v1/tm/history/daily" -> { status = 200; body = history }
                else -> { status = 404; body = """{"error":"fixture endpoint unavailable"}""" }
            }
            val bytes = body.toByteArray(Charsets.UTF_8)
            val reason = when (status) { 200 -> "OK"; 401 -> "Unauthorized"; else -> "Not Found" }
            val headers = "HTTP/1.1 $status $reason\r\nContent-Type: application/json; charset=utf-8\r\n" +
                "Content-Length: ${bytes.size}\r\nConnection: close\r\n\r\n"
            socket.getOutputStream().apply {
                write(headers.toByteArray(Charsets.US_ASCII))
                write(bytes)
                flush()
            }
            if (path == "/api/v1/tm/overview") {
                if (authorized) acceptedOverview.incrementAndGet() else rejectedOverview.incrementAndGet()
            }
            if (path == "/api/v1/tm/history/daily" && authorized) acceptedHistory.incrementAndGet()
        }

        fun assertHealthy() {
            failure.get()?.let { throw AssertionError("Loopback fixture server failed", it) }
        }

        override fun close() {
            if (!closed.compareAndSet(false, true)) return
            runCatching { listener.close() }
            runCatching { activeSocket.getAndSet(null)?.close() }
            worker.shutdownNow()
            check(worker.awaitTermination(3, TimeUnit.SECONDS)) { "Loopback fixture worker did not stop" }
            assertHealthy()
        }
    }

    private companion object {
        const val TEST_ACCESS_TOKEN = "connection-test-synthetic-access-token-2026"
        const val WRONG_ACCESS_TOKEN = "connection-test-deliberately-invalid-token"
    }
}
