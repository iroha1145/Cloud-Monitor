@file:Suppress("DEPRECATION")

package io.github.iroha1145.cloudmonitor.data

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.util.Log
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import java.io.File
import java.security.GeneralSecurityException
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

private val Context.tokenStore: DataStore<Preferences> by preferencesDataStore(name = "cm_token")

private val KEY_IV = stringPreferencesKey("token_iv")
private val KEY_CT = stringPreferencesKey("token_ct")

/** AES-GCM blob. The authentication tag stays inside [ciphertext]. */
data class EncryptedBlob(val iv: ByteArray, val ciphertext: ByteArray)

/** Encrypts the remembered access token. The key never leaves Android Keystore. */
interface TokenCipher {
    fun encrypt(plain: ByteArray): EncryptedBlob
    fun decrypt(blob: EncryptedBlob): ByteArray
}

class AndroidAesGcmTokenCipher private constructor(private val secretKey: SecretKey) : TokenCipher {
    override fun encrypt(plain: ByteArray): EncryptedBlob {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, secretKey)
        return EncryptedBlob(cipher.iv, cipher.doFinal(plain))
    }

    override fun decrypt(blob: EncryptedBlob): ByteArray {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, secretKey, GCMParameterSpec(TAG_BITS, blob.iv))
        return cipher.doFinal(blob.ciphertext)
    }

    companion object {
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private const val TAG_BITS = 128
        const val ALIAS = "cm_session_token_aes_gcm"

        fun tryCreate(context: Context): AndroidAesGcmTokenCipher? = try {
            val keystore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
            if (!keystore.containsAlias(ALIAS)) {
                val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
                val spec = KeyGenParameterSpec.Builder(
                    ALIAS,
                    KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
                )
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256)
                    .build()
                generator.init(spec)
                generator.generateKey()
                keystore.load(null)
            }
            val key = (keystore.getEntry(ALIAS, null) as KeyStore.SecretKeyEntry).secretKey
            AndroidAesGcmTokenCipher(key)
        } catch (e: Exception) {
            Log.w("SessionStore", "system keystore unavailable; token will not be persisted", e)
            null
        }
    }
}

class SessionStore(
    context: Context,
    private val cipherFactory: () -> TokenCipher? = {
        AndroidAesGcmTokenCipher.tryCreate(context.applicationContext)
    },
) {
    private val app = context.applicationContext
    private val lock = Any()
    private var opened = false
    private var meta: SharedPreferences? = null
    private var cipher: TokenCipher? = null
    private var cipherResolved = false

    @Volatile var encryptionAvailable: Boolean = true
        private set

    @Volatile var lastSecretsError: String? = null
        private set

    /** 普通 prefs、Keystore 和旧加密文件都在这里打开，须在后台线程调用。构造函数不碰磁盘。 */
    fun ensureSecrets() {
        synchronized(lock) {
            if (opened) return
            opened = true
            app.getSharedPreferences("cm_session_plain", Context.MODE_PRIVATE).edit().clear().apply()
            val metaPrefs = app.getSharedPreferences("cm_session_meta", Context.MODE_PRIVATE)
            meta = metaPrefs
            cipher = resolveCipher()
            encryptionAvailable = cipher != null
            migrateLegacy(metaPrefs, cipher)
            if (cipher == null) {
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
        get() {
            ensureSecrets()
            return readToken()
        }
        set(value) {
            ensureSecrets()
            if (value.isEmpty()) removeCiphertext() else writeToken(value)
        }

    var signedIn: Boolean
        get() = metaPrefs().getBoolean(KEY_IN, false)
        set(value) = metaPrefs().edit().putBoolean(KEY_IN, value).apply()

    /** When false, a successful login stays in memory and the encrypted token is removed. */
    var rememberToken: Boolean
        get() = metaPrefs().getBoolean(KEY_REMEMBER, false)
        set(value) = metaPrefs().edit().putBoolean(KEY_REMEMBER, value).apply()

    var darkOverride: String?
        get() = metaPrefs().getString(KEY_THEME, null)
        set(value) {
            if (value == null) metaPrefs().edit().remove(KEY_THEME).apply()
            else metaPrefs().edit().putString(KEY_THEME, value).apply()
        }

    fun persistSession(demoMode: Boolean, accessToken: String, rememberAccessToken: Boolean = false) {
        ensureSecrets()
        demo = demoMode
        if (!demoMode) rememberToken = rememberAccessToken
        if (demoMode) {
            signedIn = true
            removeCiphertext()
        } else if (rememberAccessToken && encryptionAvailable) {
            signedIn = true
            token = accessToken
        } else {
            signedIn = false
            removeCiphertext()
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
        removeCiphertext()
    }

    fun consumeSecretsError(): String? {
        val message = lastSecretsError
        lastSecretsError = null
        return message
    }

    fun clearSecrets() {
        markSignedOut()
        clearToken()
    }

    /** True when DataStore still holds a ciphertext, whether or not it can be decrypted. */
    fun hasPersistedToken(): Boolean = runBlocking {
        val prefs = app.tokenStore.data.first()
        !prefs[KEY_IV].isNullOrBlank() && !prefs[KEY_CT].isNullOrBlank()
    }

    private fun resolveCipher(): TokenCipher? {
        if (cipherResolved) return cipher
        cipherResolved = true
        return try {
            cipherFactory()
        } catch (e: Exception) {
            Log.w(TAG, "system keystore unavailable; token will not be persisted", e)
            null
        }
    }

    private fun migrateLegacy(metaPrefs: SharedPreferences, activeCipher: TokenCipher?) {
        if (!legacyFileExists()) return
        val legacy = try {
            openLegacy()
        } catch (e: Exception) {
            Log.w(TAG, "encrypted session unreadable during migrate", e)
            if (!hasPersistedToken()) {
                metaPrefs.edit().putBoolean(KEY_IN, false).apply()
                lastSecretsError = DECRYPT_MESSAGE
            }
            return
        }
        try {
            if (!metaPrefs.contains(KEY_URL)) {
                metaPrefs.edit()
                    .putString(KEY_URL, legacy.getString(KEY_URL, "").orEmpty())
                    .putBoolean(KEY_IN, legacy.getBoolean(KEY_IN, false))
                    .putBoolean(KEY_DEMO, legacy.getBoolean(KEY_DEMO, false))
                    .apply()
                val theme = legacy.getString(KEY_THEME, null)
                if (theme != null) metaPrefs.edit().putString(KEY_THEME, theme).apply()
            }
            val legacyToken = legacy.getString(KEY_TOKEN, "").orEmpty()
            if (legacyToken.isNotEmpty() && !hasPersistedToken()) {
                if (activeCipher == null) return
                writeToken(legacyToken)
                if (readToken() != legacyToken) {
                    removeCiphertext()
                    metaPrefs.edit().putBoolean(KEY_IN, false).apply()
                    lastSecretsError = DECRYPT_MESSAGE
                    return
                }
            }
            deleteLegacy()
        } catch (e: SecurityException) {
            Log.w(TAG, "encrypted session unreadable during migrate", e)
            metaPrefs.edit().putBoolean(KEY_IN, false).apply()
            lastSecretsError = DECRYPT_MESSAGE
        }
    }

    private fun openLegacy(): SharedPreferences {
        val master = MasterKey.Builder(app)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        return EncryptedSharedPreferences.create(
            app,
            LEGACY_FILE,
            master,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }

    private fun legacyFileExists(): Boolean =
        File(app.applicationInfo.dataDir, "shared_prefs/$LEGACY_FILE.xml").exists()

    private fun deleteLegacy() {
        app.deleteSharedPreferences(LEGACY_FILE)
        try {
            val keystore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
            val alias = MasterKey.DEFAULT_MASTER_KEY_ALIAS
            if (keystore.containsAlias(alias)) keystore.deleteEntry(alias)
        } catch (e: Exception) {
            Log.w(TAG, "legacy keyset delete failed", e)
        }
    }

    private fun readToken(): String {
        val active = cipher ?: return ""
        val prefs = runBlocking { app.tokenStore.data.first() }
        val iv = decode(prefs[KEY_IV]) ?: return ""
        val ct = decode(prefs[KEY_CT]) ?: return ""
        return try {
            String(active.decrypt(EncryptedBlob(iv, ct)), Charsets.UTF_8)
        } catch (e: GeneralSecurityException) {
            Log.w(TAG, "encrypted session unreadable", e)
            discardSecrets()
            ""
        }
    }

    private fun writeToken(value: String) {
        val active = cipher ?: return
        val blob = try {
            active.encrypt(value.toByteArray(Charsets.UTF_8))
        } catch (e: GeneralSecurityException) {
            Log.w(TAG, "encrypted session write failed", e)
            discardSecrets()
            return
        }
        runBlocking {
            app.tokenStore.edit { prefs ->
                prefs[KEY_IV] = Base64.encodeToString(blob.iv, Base64.NO_WRAP)
                prefs[KEY_CT] = Base64.encodeToString(blob.ciphertext, Base64.NO_WRAP)
            }
        }
    }

    private fun removeCiphertext() {
        runBlocking {
            app.tokenStore.edit { prefs ->
                prefs.remove(KEY_IV)
                prefs.remove(KEY_CT)
            }
        }
    }

    private fun discardSecrets() {
        synchronized(lock) {
            cipher = null
            encryptionAvailable = false
            meta?.edit()?.putBoolean(KEY_IN, false)?.apply()
            lastSecretsError = DECRYPT_MESSAGE
        }
    }

    private fun decode(value: String?): ByteArray? {
        if (value.isNullOrBlank()) return null
        return try {
            Base64.decode(value, Base64.NO_WRAP)
        } catch (_: IllegalArgumentException) {
            null
        }
    }

    private companion object {
        const val TAG = "SessionStore"
        const val ANDROID_KEYSTORE = "AndroidKeyStore"
        const val LEGACY_FILE = "cm_session"
        const val DECRYPT_MESSAGE = "登录凭据无法解密，请重新登录"
        const val KEY_DEMO = "demo"
        const val KEY_URL = "hub_url"
        const val KEY_TOKEN = "token"
        const val KEY_IN = "signed_in"
        const val KEY_THEME = "theme"
        const val KEY_REMEMBER = "remember_token"
    }
}
