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
    fun stepFunModelsUseTheStepFunMark() {
        listOf(
            "step-5-preview", "step-3.7-flash", "step-3.5-flash-2603", "step-1o-turbo-vision",
            "step-audio-r1.5", "Step-3.7-Flash", "deepinfra/stepfun-ai/Step-3.7-Flash",
        ).forEach { model ->
            assertEquals(model, "stepfun", modelVendorId(model))
            assertEquals(model, "stepfun", clientLogoId(model))
        }
        assertEquals("", modelVendorId("multistep-planner"))
        assertEquals("", modelVendorId("step-by-step"))
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

