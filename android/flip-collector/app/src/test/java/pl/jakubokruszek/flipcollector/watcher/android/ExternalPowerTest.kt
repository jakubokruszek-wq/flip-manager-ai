package pl.jakubokruszek.flipcollector.watcher.android

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ExternalPowerTest {
    @Test fun pluggedSourcesCountAsExternalPowerEvenIfOemChargingFlagIsFalse() {
        for (source in listOf(1, 2, 4, 8)) {
            assertTrue("source=$source", externallyPowered(isCharging = false, plugged = source))
        }
    }

    @Test fun unpluggedDeviceDoesNotQualify() {
        assertFalse(externallyPowered(isCharging = false, plugged = 0))
        assertFalse(externallyPowered(isCharging = false, plugged = 16))
    }

    @Test fun PositiveChargingFlagIsAlsoAccepted() {
        assertTrue(externallyPowered(isCharging = true, plugged = 0))
    }
}
