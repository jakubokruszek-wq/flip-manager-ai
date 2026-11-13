package pl.jakubokruszek.flipwatcher.geckopoc

import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.runBlocking
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class WatcherManualInstrumentedTest {
    @Test fun resumeButtonReadsRealPhotosWithDisplayOffWithoutAlarmGrantOrBatteryExemption()=runBlocking {
        WatcherWakeInstrumentedTest().runActual(true)
    }
}
