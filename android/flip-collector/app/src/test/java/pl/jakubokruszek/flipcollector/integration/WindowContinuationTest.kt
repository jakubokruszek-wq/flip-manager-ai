package pl.jakubokruszek.flipcollector.integration

import org.junit.Assert.*
import org.junit.Test

class WindowContinuationTest {
    private val conditions=CycleConditions(true,true,true,80,false)
    @Test fun thirteenSourcesContinueWithinSameWindowWithoutRepeatingCompletedOnes() {
        var cursor=WindowCursor("night","LIVE",(1..13).map { "source-$it" })
        var now=0L; var started=0L; var cycles=1; val seen=mutableListOf<String>()
        while (seen.size<13) {
            val next=WindowContinuation.next(cursor,"LIVE",now,started,30*60_000,conditions)
            if (next.id==null) { assertEquals("CONTINUE_NEXT_CYCLE",next.reason); started=now; cycles++; continue }
            seen+=next.id; cursor=WindowContinuation.finished(cursor,next.id); now+=60_000
        }
        assertEquals(13,seen.distinct().size); assertEquals(2,cycles)
        assertEquals("WINDOW_COMPLETE",WindowContinuation.next(cursor,"LIVE",now,started,30*60_000,conditions).reason)
    }
    @Test fun screenThermalWindowAndDataDomainBlockWithoutConsumingSource() {
        val cursor=WindowCursor("night","LIVE",listOf("group","profile"))
        assertEquals("SCREEN_OFF",WindowContinuation.next(cursor,"LIVE",1,0,999_999,conditions.copy(screenOn=false)).reason)
        assertEquals("BATTERY_OR_THERMAL",WindowContinuation.next(cursor,"LIVE",1,0,999_999,conditions.copy(thermalSevere=true)).reason)
        assertEquals("WINDOW_ENDED",WindowContinuation.next(cursor,"LIVE",999_999,0,999_999,conditions).reason)
        assertEquals("DATA_DOMAIN_MISMATCH",WindowContinuation.next(cursor,"DEMO",1,0,999_999,conditions).reason)
        assertTrue(cursor.finished.isEmpty())
    }
}
