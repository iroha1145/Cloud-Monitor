package io.github.iroha1145.cloudmonitor.data

import org.junit.Assert.assertEquals
import org.junit.Test

class DeviceStatusTest {
    private val now = 1_000_000_000_000L
    private val overview = Overview(staleAfterMs = 600_000)

    private fun device(
        stale: Boolean? = null,
        ageMs: Double? = null,
        sync: Double = 0.0,
    ) = Device(deviceId = "d", stale = stale, ageMs = ageMs, syncUploadIntervalMs = sync)

    @Test fun explicitStaleIsTwoState() {
        assertEquals(DeviceStatus.Online, deviceStatus(device(stale = false, ageMs = 9_000_000.0), overview, now))
        assertEquals(DeviceStatus.Offline, deviceStatus(device(stale = true, ageMs = 1_000.0), overview, now))
    }

    @Test fun missingStaleUsesOnlineDelayedOffline() {
        assertEquals(DeviceStatus.Online, deviceStatus(device(ageMs = 100_000.0), overview, now))
        assertEquals(DeviceStatus.Delayed, deviceStatus(device(ageMs = 900_000.0), overview, now))
        assertEquals(DeviceStatus.Offline, deviceStatus(device(ageMs = 4_000_000.0), overview, now))
    }

    @Test fun officialUploadIntervalWidensTheFreshWindow() {
        assertEquals(DeviceStatus.Online, deviceStatus(device(ageMs = 1_100_000.0, sync = 600_000.0), overview, now))
        assertEquals(DeviceStatus.Delayed, deviceStatus(device(ageMs = 1_500_000.0, sync = 600_000.0), overview, now))
        assertEquals(DeviceStatus.Offline, deviceStatus(device(ageMs = 4_000_000.0, sync = 600_000.0), overview, now))
        assertEquals(DeviceStatus.Delayed, deviceStatus(device(ageMs = 900_000.0, sync = 900_000.0), overview, now))
    }
}
