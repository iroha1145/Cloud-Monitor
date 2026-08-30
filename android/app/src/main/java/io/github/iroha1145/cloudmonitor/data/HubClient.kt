package io.github.iroha1145.cloudmonitor.data

import kotlinx.serialization.json.Json
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import java.util.concurrent.TimeUnit

class HubClient(
    private val http: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(25, TimeUnit.SECONDS)
        .writeTimeout(15, TimeUnit.SECONDS)
        .build(),
) {
    val json = Json {
        ignoreUnknownKeys = true
        isLenient = true
        coerceInputValues = true
        explicitNulls = false
    }

    fun overview(baseUrl: String, token: String): Overview =
        get(baseUrl, "/api/v1/tm/overview", token)

    fun subscriptions(baseUrl: String, token: String): SubscriptionsPayload =
        get(baseUrl, "/api/v1/tm/subscriptions", token)

    fun providerStatus(baseUrl: String, token: String): ProviderStatusPayload =
        get(baseUrl, "/api/v1/tm/provider-status", token)

    fun historyDaily(baseUrl: String, token: String, cursor: String?): HistoryPage {
        val q = buildString {
            append("/api/v1/tm/history/daily?limit=30")
            if (!cursor.isNullOrBlank()) append("&cursor=").append(cursor)
        }
        return get(baseUrl, q, token)
    }

    private inline fun <reified T> get(baseUrl: String, path: String, token: String): T {
        val root = normalizeBase(baseUrl)
        val url = (root + path).toHttpUrlOrNull()
            ?: throw ApiException(0, "面板地址无效")
        val req = Request.Builder()
            .url(url)
            .header("Accept", "application/json")
            .header("Authorization", "Bearer $token")
            .get()
            .build()
        val resp = try {
            http.newCall(req).execute()
        } catch (e: Exception) {
            throw ApiException(0, "无法连接服务器")
        }
        resp.use { r ->
            val body = r.body?.string().orEmpty()
            if (!r.isSuccessful) {
                val msg = when (r.code) {
                    401, 403 -> "访问密钥无效"
                    else -> "请求失败 ${r.code}"
                }
                throw ApiException(r.code, msg)
            }
            return try {
                json.decodeFromString<T>(body)
            } catch (e: Exception) {
                throw ApiException(r.code, "响应无法解析")
            }
        }
    }

    companion object {
        fun normalizeBase(raw: String): String {
            var s = raw.trim()
            if (s.isEmpty()) throw ApiException(0, "请填写面板地址")
            if (!s.startsWith("http://") && !s.startsWith("https://")) {
                s = "https://$s"
            }
            return s.trimEnd('/')
        }
    }
}
