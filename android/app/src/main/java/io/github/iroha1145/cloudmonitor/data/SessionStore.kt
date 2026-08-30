package io.github.iroha1145.cloudmonitor.data

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

class SessionStore(context: Context) {
    private val prefs: SharedPreferences = try {
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
    } catch (_: Exception) {
        context.getSharedPreferences("cm_session_plain", Context.MODE_PRIVATE)
    }

    var demo: Boolean
        get() = prefs.getBoolean(KEY_DEMO, false)
        set(value) = prefs.edit().putBoolean(KEY_DEMO, value).apply()

    var hubUrl: String
        get() = prefs.getString(KEY_URL, "").orEmpty()
        set(value) = prefs.edit().putString(KEY_URL, value).apply()

    var token: String
        get() = prefs.getString(KEY_TOKEN, "").orEmpty()
        set(value) = prefs.edit().putString(KEY_TOKEN, value).apply()

    var signedIn: Boolean
        get() = prefs.getBoolean(KEY_IN, false)
        set(value) = prefs.edit().putBoolean(KEY_IN, value).apply()

    var darkOverride: String?
        get() = prefs.getString(KEY_THEME, null)
        set(value) {
            if (value == null) prefs.edit().remove(KEY_THEME).apply()
            else prefs.edit().putString(KEY_THEME, value).apply()
        }

    fun clearSecrets() {
        prefs.edit()
            .putBoolean(KEY_IN, false)
            .putBoolean(KEY_DEMO, false)
            .remove(KEY_TOKEN)
            .apply()
    }

    private companion object {
        const val KEY_DEMO = "demo"
        const val KEY_URL = "hub_url"
        const val KEY_TOKEN = "token"
        const val KEY_IN = "signed_in"
        const val KEY_THEME = "theme"
    }
}
