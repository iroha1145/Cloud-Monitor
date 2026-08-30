@file:Suppress("DEPRECATION")

package io.github.iroha1145.cloudmonitor.data

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

class SessionStore(context: Context) {
    private val meta: SharedPreferences =
        context.getSharedPreferences("cm_session_meta", Context.MODE_PRIVATE)

    private val secrets: SharedPreferences? = try {
        val master = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        EncryptedSharedPreferences.create(
            context,
            "cm_session",
            master,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    } catch (e: Exception) {
        Log.w(TAG, "system keystore unavailable; token will not be persisted", e)
        null
    }

    val encryptionAvailable: Boolean = secrets != null

    init {
        context.getSharedPreferences("cm_session_plain", Context.MODE_PRIVATE).edit().clear().apply()
        if (secrets != null && !meta.contains(KEY_URL)) {
            meta.edit()
                .putString(KEY_URL, secrets.getString(KEY_URL, "").orEmpty())
                .putBoolean(KEY_IN, secrets.getBoolean(KEY_IN, false))
                .putBoolean(KEY_DEMO, secrets.getBoolean(KEY_DEMO, false))
                .apply()
            val theme = secrets.getString(KEY_THEME, null)
            if (theme != null) meta.edit().putString(KEY_THEME, theme).apply()
            secrets.edit()
                .remove(KEY_URL)
                .remove(KEY_IN)
                .remove(KEY_DEMO)
                .remove(KEY_THEME)
                .apply()
        }
        if (secrets == null) {
            meta.edit().putBoolean(KEY_IN, false).apply()
        }
    }

    var demo: Boolean
        get() = meta.getBoolean(KEY_DEMO, false)
        set(value) = meta.edit().putBoolean(KEY_DEMO, value).apply()

    var hubUrl: String
        get() = meta.getString(KEY_URL, "").orEmpty()
        set(value) = meta.edit().putString(KEY_URL, value).apply()

    var token: String
        get() = secrets?.getString(KEY_TOKEN, "").orEmpty()
        set(value) {
            secrets?.edit()?.putString(KEY_TOKEN, value)?.apply()
        }

    var signedIn: Boolean
        get() = meta.getBoolean(KEY_IN, false)
        set(value) = meta.edit().putBoolean(KEY_IN, value).apply()

    var darkOverride: String?
        get() = meta.getString(KEY_THEME, null)
        set(value) {
            if (value == null) meta.edit().remove(KEY_THEME).apply()
            else meta.edit().putString(KEY_THEME, value).apply()
        }

    fun persistSession(demoMode: Boolean, accessToken: String) {
        demo = demoMode
        if (demoMode) {
            signedIn = true
            secrets?.edit()?.remove(KEY_TOKEN)?.apply()
        } else if (encryptionAvailable) {
            signedIn = true
            token = accessToken
        } else {
            signedIn = false
        }
    }

    fun clearSecrets() {
        meta.edit()
            .putBoolean(KEY_IN, false)
            .putBoolean(KEY_DEMO, false)
            .apply()
        secrets?.edit()?.remove(KEY_TOKEN)?.apply()
    }

    private companion object {
        const val TAG = "SessionStore"
        const val KEY_DEMO = "demo"
        const val KEY_URL = "hub_url"
        const val KEY_TOKEN = "token"
        const val KEY_IN = "signed_in"
        const val KEY_THEME = "theme"
    }
}
