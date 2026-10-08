package io.github.iroha1145.cloudmonitor

import android.content.Context
import android.content.pm.ApplicationInfo
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.github.iroha1145.cloudmonitor.data.SessionStore
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/** Opening the keystore still fails closed: nothing is stored and the user is signed out. */
@RunWith(AndroidJUnit4::class)
class KeystoreFailureTest {
    @Before fun reset() = wipe()

    @After fun cleanup() = wipe()

    @Test fun failedKeystoreDoesNotPretendTheTokenWasSaved() {
        val context = debugContext()
        check(context.getSharedPreferences("cm_session_meta", Context.MODE_PRIVATE).edit()
            .putBoolean("signed_in", true)
            .putBoolean("remember_token", true)
            .putString("hub_url", "http://127.0.0.1:9")
            .commit())
        val store = SessionStore(context) { null }
        store.ensureSecrets()
        assertFalse(store.encryptionAvailable)
        assertFalse(store.signedIn)
        assertEquals("", store.token)
        assertNull(store.consumeSecretsError())
        store.persistSession(demoMode = false, accessToken = "should-not-stick", rememberAccessToken = true)
        assertFalse(store.signedIn)
        assertEquals("", store.token)
        assertFalse(store.hasPersistedToken())
        assertTrue(store.rememberToken)
    }

    private fun wipe() {
        val context = debugContext()
        context.deleteSharedPreferences("cm_session")
        SessionStore(context).apply {
            ensureSecrets()
            clearSecrets()
            hubUrl = ""
            rememberToken = false
        }
    }

    private fun debugContext(): Context {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        check(context.packageName == "io.github.iroha1145.cloudmonitor.debug")
        check(context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0)
        return context
    }
}
