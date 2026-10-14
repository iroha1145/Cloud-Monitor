package io.github.iroha1145.cloudmonitor.data

import org.junit.Assert.assertEquals
import org.junit.Test

class LogosTest {
    @Test
    fun museSparkModelsUseTheMetaMark() {
        assertEquals("meta", modelVendorId("muse-spark"))
        assertEquals("meta", modelVendorId("muse-spark-1"))
        assertEquals("meta", modelVendorId("muse spark"))
        assertEquals("meta", modelVendorId("Muse Spark Max"))
        assertEquals("meta", clientLogoId("muse-spark-1"))
    }

    @Test
    fun v070ClientsAndLocalRunnersResolveTheirOwnMarks() {
        assertEquals("catpaw", clientLogoId("catpaw"))
        assertEquals("fx", clientLogoId("fx"))
        assertEquals("minimax", clientLogoId("mcode"))
        assertEquals("droid", clientLogoId("factory"))
        assertEquals("omp", clientLogoId("ohmypi"))
        assertEquals("kimi", modelVendorId("k2"))
        assertEquals("kimi", modelVendorId("k2d6-agent"))
        assertEquals("", modelVendorId("ollama-runner"))
        assertEquals("ollama", clientLogoId("ollama"))
        assertEquals("hermes-agent", clientLogoId("hermes"))
        assertEquals("stepfun", clientLogoId("stepfun"))
        assertEquals("alibaba", clientLogoId("alibaba"))
        CLIENT_NAMES.keys.forEach { id ->
            org.junit.Assert.assertTrue("Missing logo for client id $id", clientLogoId(id).isNotEmpty())
        }
    }
}

