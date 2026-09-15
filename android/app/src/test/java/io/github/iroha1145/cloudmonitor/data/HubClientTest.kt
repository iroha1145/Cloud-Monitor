package io.github.iroha1145.cloudmonitor.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.InetAddress
import javax.net.ssl.SSLHandshakeException

class HubClientTest {
    @Test fun normalizeBaseAllowsLanHostnamesAndStripsTm() {
        assertEquals("http://nas:2500", HubClient.normalizeBase("http://nas:2500/tm/"))
        assertEquals("http://panel.home.arpa", HubClient.normalizeBase("http://panel.home.arpa/tm"))
        assertEquals("http://monitor.local", HubClient.normalizeBase("http://monitor.local"))
        assertEquals("http://192.168.1.20", HubClient.normalizeBase("http://192.168.1.20/"))
        assertEquals("http://nas.lan:2500", HubClient.normalizeBase("http://nas.lan:2500"))
        assertEquals("http://192.168.1.20.nip.io", HubClient.normalizeBase("http://192.168.1.20.nip.io"))
        assertEquals("http://example.com", HubClient.normalizeBase("http://example.com/tm/overview"))
    }

    @Test fun normalizeBaseRejectsObviouslyPublicHttp() {
        val publicIp = runCatching { HubClient.normalizeBase("http://8.8.8.8") }.exceptionOrNull()
        assertTrue(publicIp is ApiException)
        assertTrue((publicIp as ApiException).message.contains("HTTPS"))
    }

    @Test fun cleartextPeerRejectsPublicAddressesEvenForLocalNames() {
        assertTrue(HubClient.isCleartextAllowedPeer(InetAddress.getByName("127.0.0.1")))
        assertTrue(HubClient.isCleartextAllowedPeer(InetAddress.getByName("192.168.1.20")))
        assertTrue(HubClient.isCleartextAllowedPeer(InetAddress.getByName("10.0.2.2")))
        assertFalse(HubClient.isCleartextAllowedPeer(InetAddress.getByName("8.8.8.8")))
        assertFalse(HubClient.isCleartextAllowedHost("evil.example.com"))
        assertTrue(HubClient.isCleartextAllowedHost("panel.local"))
        assertFalse(HubClient.isObviouslyPublicName("evil.example.com"))
        assertTrue(HubClient.isObviouslyPublicName("8.8.8.8"))
    }

    @Test fun sslHandshakeIsDistinguishedFromGenericIo() {
        assertEquals(
            "证书校验失败，请确认面板使用受信任的 HTTPS 证书",
            HubClient.connectionFailureMessage(SSLHandshakeException("self-signed")),
        )
        assertEquals(
            "证书校验失败，请确认面板使用受信任的 HTTPS 证书",
            HubClient.connectionFailureMessage(java.io.IOException(SSLHandshakeException("nested"))),
        )
        assertEquals("无法连接服务器", HubClient.connectionFailureMessage(java.io.IOException("refused")))
    }
}
