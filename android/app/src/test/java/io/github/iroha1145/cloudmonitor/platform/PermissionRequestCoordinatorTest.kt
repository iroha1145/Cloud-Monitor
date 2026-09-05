package io.github.iroha1145.cloudmonitor.platform

import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class PermissionRequestCoordinatorTest {
    @Test fun twentyFourConcurrentRequestsShareOneGrant() = runBlocking {
        val coordinator = PermissionRequestCoordinator()
        val calls = List(24) {
            async(start = CoroutineStart.UNDISPATCHED) { coordinator.awaitPermission("monitor.local") }
        }
        val request = requireNotNull(coordinator.pending.value)
        assertEquals(24, request.waiters)
        coordinator.respond(request, true)
        assertTrue(calls.awaitAll().all { it })
        assertNull(coordinator.pending.value)
    }

    @Test fun denialSettlesEveryWaiterAndDoesNotRepeatPromptImmediately() = runBlocking {
        var clock = 0L
        val coordinator = PermissionRequestCoordinator(monotonicMillis = { clock })
        val calls = List(24) {
            async(start = CoroutineStart.UNDISPATCHED) { coordinator.awaitPermission("monitor.local") }
        }
        coordinator.respond(requireNotNull(coordinator.pending.value), false)
        assertTrue(calls.awaitAll().none { it })
        assertFalse(coordinator.awaitPermission("another.local"))
        assertNull(coordinator.pending.value)
        clock = 30_001
        val retry = async(start = CoroutineStart.UNDISPATCHED) { coordinator.awaitPermission("monitor.local") }
        coordinator.respond(requireNotNull(coordinator.pending.value), true)
        assertTrue(retry.await())
    }

    @Test fun timeoutReturnsAndClearsPendingRequest() = runBlocking {
        val coordinator = PermissionRequestCoordinator(timeoutMillis = 25)
        assertFalse(withTimeout(1_000) { coordinator.awaitPermission("monitor.local") })
        assertNull(coordinator.pending.value)
    }

    @Test fun cancellingOneRequestPreservesTheOtherWaiter() = runBlocking {
        val coordinator = PermissionRequestCoordinator()
        val first = async(start = CoroutineStart.UNDISPATCHED) { coordinator.awaitPermission("monitor.local") }
        val second = async(start = CoroutineStart.UNDISPATCHED) { coordinator.awaitPermission("monitor.local") }
        val request = requireNotNull(coordinator.pending.value)
        first.cancelAndJoin()
        assertSame(request, coordinator.pending.value)
        assertEquals(1, request.waiters)
        coordinator.respond(request, true)
        assertTrue(second.await())
    }

    @Test fun cancellingAllRequestsRemovesOrphanPromptAndOldCallbackCannotFinishRetry() = runBlocking {
        val coordinator = PermissionRequestCoordinator()
        val abandoned = async(start = CoroutineStart.UNDISPATCHED) { coordinator.awaitPermission("old.local") }
        val oldRequest = requireNotNull(coordinator.pending.value)
        abandoned.cancelAndJoin()
        assertNull(coordinator.pending.value)
        val retry = async(start = CoroutineStart.UNDISPATCHED) { coordinator.awaitPermission("new.local") }
        val newRequest = requireNotNull(coordinator.pending.value)
        coordinator.respond(oldRequest, false)
        assertSame(newRequest, coordinator.pending.value)
        assertFalse(retry.isCompleted)
        coordinator.respond(newRequest, true)
        assertTrue(retry.await())
    }
}
