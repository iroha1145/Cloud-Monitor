package io.github.iroha1145.cloudmonitor.platform

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.withTimeoutOrNull

/** Shares one permission decision across concurrent requests without retaining cancelled work. */
internal class PermissionRequestCoordinator(
    private val timeoutMillis: Long = 90_000,
    private val denialCooldownMillis: Long = 30_000,
    private val monotonicMillis: () -> Long = { System.nanoTime() / 1_000_000 },
) {
    class Request(val host: String) {
        val result = CompletableDeferred<Boolean>()
        var systemPromptLaunched = false
        internal var waiters = 0
    }

    val pending = MutableStateFlow<Request?>(null)
    private val lock = Any()
    private var deniedAt: Long? = null

    suspend fun awaitPermission(host: String): Boolean {
        val request = synchronized(lock) {
            deniedAt?.let {
                if (monotonicMillis() - it < denialCooldownMillis) return false
            }
            (pending.value ?: Request(host).also { pending.value = it }).also { it.waiters++ }
        }
        try {
            val allowed = withTimeoutOrNull(timeoutMillis) { request.result.await() }
            if (allowed == null) respond(request, false)
            return allowed == true
        } finally {
            synchronized(lock) {
                request.waiters--
                if (request.waiters == 0 && pending.value === request) pending.value = null
            }
        }
    }

    fun respond(request: Request, allowed: Boolean) = synchronized(lock) {
        // A callback from a rotated or timed-out screen must not settle a newer request.
        if (pending.value !== request) return@synchronized
        deniedAt = if (allowed) null else monotonicMillis()
        pending.value = null
        request.result.complete(allowed)
        Unit
    }
}
