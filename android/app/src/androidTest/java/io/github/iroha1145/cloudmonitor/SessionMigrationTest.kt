package io.github.iroha1145.cloudmonitor

import android.content.Context
import android.content.pm.ApplicationInfo
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.github.iroha1145.cloudmonitor.data.AndroidAesGcmTokenCipher
import io.github.iroha1145.cloudmonitor.data.SessionStore
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.ExternalResource
import org.junit.rules.RuleChain
import org.junit.rules.TestRule
import org.junit.runner.RunWith
import java.io.File
import java.security.KeyStore

/** An old EncryptedSharedPreferences file is readable once, then the new store logs in by itself. */
@RunWith(AndroidJUnit4::class)
class SessionMigrationTest {
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
            val overview = InstrumentationRegistry.getInstrumentation().context.assets
                .open("connection/overview.json").bufferedReader().use { it.readText() }
            val fixture = LoopbackOverview(overview, TOKEN)
            server = fixture
            writeLegacySession(context, fixture.baseUrl, TOKEN)
        }

        override fun after() {
            server?.close()
            val context = debugContext()
            context.deleteSharedPreferences("cm_session")
            SessionStore(context).apply {
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

    @Test fun legacyFileMigratesAndSignsInAgainAfterRecreation() {
        compose.waitUntil(20_000) {
            compose.onAllNodes(hasTestTag("usage-summary")).fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNode(hasText("查看你的用量")).assertDoesNotExist()
        val saved = SessionStore(debugContext()).apply { ensureSecrets() }
        assertEquals(TOKEN, saved.token)
        assertTrue(saved.signedIn)
        assertTrue(saved.rememberToken)
        assertTrue(saved.hasPersistedToken())
        assertFalse(legacyFile().exists())
        val keystore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        assertFalse(keystore.containsAlias(MasterKey.DEFAULT_MASTER_KEY_ALIAS))
        assertTrue(keystore.containsAlias(AndroidAesGcmTokenCipher.ALIAS))

        val previous = compose.activity
        compose.activityRule.scenario.recreate()
        compose.waitUntil(20_000) {
            compose.onAllNodes(hasTestTag("usage-summary")).fetchSemanticsNodes().isNotEmpty()
        }
        assertNotSame(previous, compose.activity)
        compose.onNode(hasText("查看你的用量")).assertDoesNotExist()
        assertFalse(legacyFile().exists())
        assertEquals(TOKEN, SessionStore(debugContext()).apply { ensureSecrets() }.token)
    }

    @Suppress("DEPRECATION")
    private fun writeLegacySession(context: Context, url: String, token: String) {
        val master = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        val secrets = EncryptedSharedPreferences.create(
            context,
            "cm_session",
            master,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
        check(secrets.edit().putString("token", token).commit())
        check(context.getSharedPreferences("cm_session_meta", Context.MODE_PRIVATE).edit()
            .putString("hub_url", url)
            .putBoolean("signed_in", true)
            .putBoolean("demo", false)
            .putBoolean("remember_token", true)
            .commit())
    }

    private fun legacyFile(): File = File(debugContext().applicationInfo.dataDir, "shared_prefs/cm_session.xml")

    private fun debugContext(): Context {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        check(context.packageName == "io.github.iroha1145.cloudmonitor.debug")
        check(context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0)
        return context
    }

    private companion object {
        const val TOKEN = "migration-test-synthetic-access-token-2026"
    }
}
