package pl.jakubokruszek.flipwatcher.geckopoc

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class CaptureTimingInstrumentedTest {
    @Test fun ordinaryReportsRecordCaptureTimeBeforeDelayedDeliveryWithoutBusinessData() {
        val context=ApplicationProvider.getApplicationContext<Context>()
        val settings=WatcherAutomation.preferences(context)
        val had=settings.contains("render_observe_until");val old=settings.getLong("render_observe_until",0)
        try {
        RenderDiagnostics.set(context,false)
        assertFalse(RenderDiagnostics.enabled(context))
        val before=System.currentTimeMillis()
        val report=WatcherCaptureReport.create(context,"fixture-cycle","fixture-run",WatcherGroups.configured.first(),null,"SCAN_PORT_LOST",1234,
            mapOf("queuePending" to 2,"queueSent" to 3))
        val after=System.currentTimeMillis()
        val stats=report.getJSONObject("stats")
        val captured=stats.getLong("capturedEpochDay")*86400000L+stats.getLong("capturedDayMs")
        assertTrue(captured in before..after)
        assertEquals(1234,stats.getInt("groupElapsedMs"));assertEquals(2,stats.getInt("queuePending"))
        assertEquals(0,report.getJSONArray("posts").length())
        assertTrue(stats.length()<=160)
        assertFalse(stats.has("renderDiagEnabled"))
        } finally {
            val edit=settings.edit()
            if(had)edit.putLong("render_observe_until",old) else edit.remove("render_observe_until")
            check(edit.commit())
        }
    }
    @Test fun timingDoesNotOverflowPinnedNumericCounterContract() {
        val context=ApplicationProvider.getApplicationContext<Context>()
        val queue=mapOf("queuePending" to 1,"queueBlocked" to 2,"queueQualityHeld" to 3,"queueSent" to 4)
        for(size in listOf(152,153,154,155,156)) {
            val counters=(0 until size).associate{"fixture$it" to it}
            val stats=WatcherCaptureReport.create(context,"cycle","run",WatcherGroups.configured.first(),null,"SCAN_PORT_LOST",queueStats=queue,failureStats=counters).getJSONObject("stats")
            assertTrue("size=$size",stats.length()<=160)
            assertEquals(4,stats.getInt("queueSent"))
            assertTrue(stats.keys().asSequence().all{key->stats.getLong(key) in 0..100_000_000L})
        }
    }
}
