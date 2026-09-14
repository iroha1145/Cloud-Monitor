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
}
