package io.github.iroha1145.cloudmonitor

import java.io.Closeable
import java.io.IOException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketTimeoutException
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/** Serves one overview document on this device's loopback interface. */
internal class LoopbackOverview(private val overview: String, private val token: String) : Closeable {
    private val closed = AtomicBoolean(false)
    private val listener = ServerSocket().apply {
        reuseAddress = true
        bind(InetSocketAddress(InetAddress.getByName("127.0.0.1"), 0))
        soTimeout = 250
    }
    val baseUrl = "http://127.0.0.1:${listener.localPort}"
    val acceptedOverview = AtomicInteger(0)
    private val worker = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "session-migration-loopback").apply { isDaemon = true }
    }

    init {
        worker.execute {
            while (!closed.get()) {
                val socket = try {
                    listener.accept()
                } catch (_: SocketTimeoutException) {
                    continue
                } catch (_: IOException) {
                    break
                }
                try {
                    socket.use { serve(it) }
                } catch (_: IOException) {
                    // The client may close the socket after logout.
                }
            }
        }
    }

    private fun serve(socket: Socket) {
        socket.soTimeout = 2_000
        val reader = socket.getInputStream().bufferedReader(Charsets.US_ASCII)
        val request = reader.readLine() ?: return
        val path = request.split(' ', limit = 3).getOrNull(1)?.substringBefore('?') ?: return
        var authorized = false
        var ended = false
        for (index in 0 until 64) {
            val line = reader.readLine() ?: return
            if (line.isEmpty()) {
                ended = true
                break
            }
            if (line.substringBefore(':').equals("Authorization", ignoreCase = true)) {
                authorized = line.substringAfter(':', "").trim() == "Bearer $token"
            }
        }
        if (!ended) return
        val status: Int
        val body: String
        if (!authorized) {
            status = 401
            body = """{"error":"synthetic test access denied"}"""
        } else if (path == "/api/v1/tm/overview") {
            status = 200
            body = overview
            acceptedOverview.incrementAndGet()
        } else {
            status = 404
            body = """{"error":"fixture endpoint unavailable"}"""
        }
        val bytes = body.toByteArray(Charsets.UTF_8)
        val reason = when (status) { 200 -> "OK"; 401 -> "Unauthorized"; else -> "Not Found" }
        val headers = "HTTP/1.1 $status $reason\r\nContent-Type: application/json; charset=utf-8\r\n" +
            "Content-Length: ${bytes.size}\r\nConnection: close\r\n\r\n"
        socket.getOutputStream().apply {
            write(headers.toByteArray(Charsets.US_ASCII))
            write(bytes)
            flush()
        }
    }

    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        runCatching { listener.close() }
        worker.shutdownNow()
        worker.awaitTermination(3, TimeUnit.SECONDS)
    }
}
