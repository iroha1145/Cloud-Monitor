@file:Suppress("DEPRECATION")

package io.github.iroha1145.cloudmonitor.data

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

class SessionStore(context: Context) {
    private val app = context.applicationContext
    private val lock = Any()
    private var opened = false
    private var meta: SharedPreferences? = null
    private var secrets: SharedPreferences? = null
    @Volatile var encryptionAvailable: Boolean = true
        private set

    /** 普通 prefs + 密钥库都在这里打开，须在后台线程调用。构造函数不碰磁盘。 */
    fun ensureSecrets() {
        synchronized(lock) {
            if (opened) return
            opened = true
            app.getSharedPreferences("cm_session_plain", Context.MODE_PRIVATE).edit().clear().apply()
            val metaPrefs = app.getSharedPreferences("cm_session_meta", Context.MODE_PRIVATE)
            meta = metaPrefs
            secrets = try {
                val master = MasterKey.Builder(app)
                    .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                    .build()
                EncryptedSharedPreferences.create(
                    app,
                    "cm_session",
                    master,
                    EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                    EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
                )
            } catch (e: Exception) {
                Log.w(TAG, "system keystore unavailable; token will not be persisted", e)
                null
            }
            encryptionAvailable = secrets != null
            if (secrets != null && !metaPrefs.contains(KEY_URL)) {
                metaPrefs.edit()
                    .putString(KEY_URL, secrets!!.getString(KEY_URL, "").orEmpty())
                    .putBoolean(KEY_IN, secrets!!.getBoolean(KEY_IN, false))
                    .putBoolean(KEY_DEMO, secrets!!.getBoolean(KEY_DEMO, false))
                    .apply()
                val theme = secrets!!.getString(KEY_THEME, null)
                if (theme != null) metaPrefs.edit().putString(KEY_THEME, theme).apply()
                secrets!!.edit()
                    .remove(KEY_URL)
                    .remove(KEY_IN)
                    .remove(KEY_DEMO)
                    .remove(KEY_THEME)
                    .apply()
            }
            if (secrets == null) {
                metaPrefs.edit().putBoolean(KEY_IN, false).apply()
            }
        }
    }

    private fun metaPrefs(): SharedPreferences {
        val cached = meta
        if (cached != null) return cached
        ensureSecrets()
        return meta!!
    }

    var demo: Boolean
        get() = metaPrefs().getBoolean(KEY_DEMO, false)
        set(value) = metaPrefs().edit().putBoolean(KEY_DEMO, value).apply()

    var hubUrl: String
        get() = metaPrefs().getString(KEY_URL, "").orEmpty()
        set(value) = metaPrefs().edit().putString(KEY_URL, value).apply()

    var token: String
        get() = secrets?.getString(KEY_TOKEN, "").orEmpty()
        set(value) {
            secrets?.edit()?.putString(KEY_TOKEN, value)?.apply()
        }

    var signedIn: Boolean
        get() = metaPrefs().getBoolean(KEY_IN, false)
        set(value) = metaPrefs().edit().putBoolean(KEY_IN, value).apply()

    var darkOverride: String?
        get() = metaPrefs().getString(KEY_THEME, null)
        set(value) {
            if (value == null) metaPrefs().edit().remove(KEY_THEME).apply()
            else metaPrefs().edit().putString(KEY_THEME, value).apply()
        }

    fun persistSession(demoMode: Boolean, accessToken: String) {
        ensureSecrets()
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

    fun markSignedOut() {
        metaPrefs().edit()
            .putBoolean(KEY_IN, false)
            .putBoolean(KEY_DEMO, false)
            .apply()
    }

    fun clearToken() {
        ensureSecrets()
        secrets?.edit()?.remove(KEY_TOKEN)?.apply()
    }

    fun clearSecrets() {
        markSignedOut()
        clearToken()
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
