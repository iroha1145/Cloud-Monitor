package io.github.iroha1145.cloudmonitor.platform

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.InetAddress
import java.net.UnknownHostException

class LocalNetworkAccessTest {
    @Test fun localServerAddressesRequirePermission() {
        listOf("10.0.2.2", "192.168.1.20", "172.16.1.2", "169.254.1.2", "100.64.0.1", "fd00::1", "fe80::1")
            .forEach { assertTrue(it, LocalNetworkAccess.isLocalAddress(InetAddress.getByName(it))) }
    }

    @Test fun publicAndLoopbackAddressesDoNotRequirePermission() {
        listOf("8.8.8.8", "1.1.1.1", "172.32.0.1", "100.128.0.1", "127.0.0.1", "::1", "2606:4700:4700::1111")
            .forEach { assertFalse(it, LocalNetworkAccess.isLocalAddress(InetAddress.getByName(it))) }
    }

    @Test fun localNamesAreDetectedBeforeProtectedMdnsResolution() = runBlocking {
        assertTrue(LocalNetworkAccess.requiresLocalAccess("monitor.local") { error("mDNS must not run before permission") })
        assertTrue(LocalNetworkAccess.requiresLocalAccess("monitor.home.arpa"))
        assertTrue(LocalNetworkAccess.requiresLocalAccess("monitor"))
        assertFalse(LocalNetworkAccess.requiresLocalAccess("localhost"))
    }

    @Test fun customDomainsResolvingToPrivateNetworksRequirePermission() = runBlocking {
        assertTrue(LocalNetworkAccess.requiresLocalAccess("monitor.example.com") {
            arrayOf(InetAddress.getByName("192.168.1.50"))
        })
        assertTrue(LocalNetworkAccess.requiresLocalAccess("monitor.example.com") {
            arrayOf(InetAddress.getByName("1.1.1.1"), InetAddress.getByName("fd00::50"))
        })
    }

    @Test fun publicDomainsAndDnsFailuresNeverAskForLocalPermission() = runBlocking {
        assertFalse(LocalNetworkAccess.requiresLocalAccess("monitor.example.com") {
            arrayOf(InetAddress.getByName("1.1.1.1"))
        })
        assertFalse(LocalNetworkAccess.requiresLocalAccess("missing.example.com") {
            throw UnknownHostException("missing")
        })
    }
}
