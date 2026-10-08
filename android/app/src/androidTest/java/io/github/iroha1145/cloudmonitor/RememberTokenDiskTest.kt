package io.github.iroha1145.cloudmonitor

import android.content.Context
import android.content.pm.ApplicationInfo
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.github.iroha1145.cloudmonitor.data.SessionStore
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Rule
import org.junit.Test
import org.junit.rules.ExternalResource
import org.junit.rules.RuleChain
import org.junit.rules.TestRule
import org.junit.runner.RunWith

/** Leaving the remember box unchecked must not write a ciphertext. */
@RunWith(AndroidJUnit4::class)
class RememberTokenDiskTest {
    private var server: LoopbackOverview? = null
    private val prepare = object : ExternalResource() {
        override fun before() {
            val context = debugContext()
            context.deleteSharedPreferences("cm_session")
            SessionStore(context).apply {
                ensureSecrets()
                clearSecrets()
                hubUrl = ""
                rememberToken = false
            }
        }

        override fun after() {
            server?.close()
            SessionStore(debugContext()).apply {
                ensureSecrets()
                clearSecrets()
                hubUrl = ""
                rememberToken = false
            }
        }
    }
    private val compose = createAndroidComposeRule<MainActivity>()

    @get:Rule
    val rules: TestRule = RuleChain.outerRule(prepare).around(compose)

    @Test fun uncheckedLoginKeepsTheTokenOffDisk() {
        val overview = InstrumentationRegistry.getInstrumentation().context.assets
            .open("connection/overview.json").bufferedReader().use { it.readText() }
        LoopbackOverview(overview, TOKEN).use { fixture ->
            server = fixture
            compose.waitUntil(20_000) {
                compose.onAllNodesWithText("查看你的用量").fetchSemanticsNodes().isNotEmpty()
            }
            compose.onNode(hasText("面板地址") and hasSetTextAction())
                .performScrollTo().performTextReplacement(fixture.baseUrl)
            compose.onNode(hasText("访问密钥") and hasSetTextAction())
                .performScrollTo().performTextReplacement(TOKEN)
            compose.onNodeWithTag("remember-token").performScrollTo().assertIsOff()
            compose.onNodeWithText("进入工作台").performScrollTo().performClick()
            compose.waitUntil(20_000) {
                compose.onAllNodes(hasTestTag("usage-summary")).fetchSemanticsNodes().isNotEmpty()
            }
            val saved = SessionStore(debugContext()).apply { ensureSecrets() }
            assertFalse(saved.signedIn)
            assertFalse(saved.rememberToken)
            assertEquals("", saved.token)
            assertFalse(saved.hasPersistedToken())
        }
    }

    private fun debugContext(): Context {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        check(context.packageName == "io.github.iroha1145.cloudmonitor.debug")
        check(context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0)
        return context
    }

    private companion object {
        const val TOKEN = "unchecked-test-synthetic-access-token-2026"
    }
}
