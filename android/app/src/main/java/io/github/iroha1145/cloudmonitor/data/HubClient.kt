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
        val query = buildMap {
            put("limit", "30")
            if (!cursor.isNullOrBlank()) put("cursor", cursor)
        }
        return get(baseUrl, "/api/v1/tm/history/daily", token, query)
    }

    fun systemUpdate(baseUrl: String, token: String, refresh: Boolean = false): SystemUpdate {
        val query = if (refresh) mapOf("refresh" to "1") else emptyMap()
        return get(baseUrl, "/api/v1/system/update", token, query)
    }

    private inline fun <reified T> get(
        baseUrl: String,
        path: String,
        token: String,
        query: Map<String, String> = emptyMap(),
    ): T {
        val root = normalizeBase(baseUrl).toHttpUrlOrNull()
            ?: throw ApiException(0, "面板地址无效")
        val builder = root.newBuilder()
        path.trim('/').split('/').filter { it.isNotEmpty() }.forEach { builder.addPathSegment(it) }
        query.forEach { (k, v) -> builder.addQueryParameter(k, v) }
        val req = Request.Builder()
            .url(builder.build())
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
            s = s.trimEnd('/')
            val parsed = s.toHttpUrlOrNull() ?: throw ApiException(0, "面板地址无效")
            if (parsed.scheme == "http" && !isCleartextAllowedHost(parsed.host)) {
                throw ApiException(0, "公网请使用 HTTPS；明文 HTTP 仅允许本机和局域网地址")
            }
            return s
        }

        internal fun isCleartextAllowedHost(host: String): Boolean {
            val h = host.trim().lowercase().removePrefix("[").removeSuffix("]")
            if (h.isEmpty()) return false
            if (h == "localhost" || h == "::1" || h == "0:0:0:0:0:0:0:1" || h == "10.0.2.2") return true
            if (h.endsWith(".local")) return true
            val parts = h.split('.')
            if (parts.size == 4) {
                val oct = parts.map { it.toIntOrNull() }
                if (oct.all { it != null && it in 0..255 }) {
                    val a = oct[0]!!
                    val b = oct[1]!!
                    return a == 127 || a == 10 || (a == 192 && b == 168) ||
                        (a == 172 && b in 16..31) || (a == 169 && b == 254)
                }
            }
            return h.contains(':') && (
                h.startsWith("fe80:") || h.startsWith("fc") || h.startsWith("fd")
            )
        }
    }
}
