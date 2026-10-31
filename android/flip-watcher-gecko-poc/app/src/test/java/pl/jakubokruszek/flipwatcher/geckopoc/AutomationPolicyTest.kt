package pl.jakubokruszek.flipwatcher.geckopoc

import org.junit.Test
import org.junit.Assert.*
import java.time.Instant
import java.time.ZoneId

class AutomationPolicyTest {
    @Test fun threeLocalWindowsAndNoDuplicateSlot() {
        val zone=ZoneId.of("Europe/Warsaw")
        val before=Instant.parse("2026-10-30T05:59:59Z")
        assertEquals(Instant.parse("2026-10-30T06:00:00Z"),AutomationPolicy.next(before,zone))
        assertEquals("2026-10-29/23",AutomationPolicy.slot(before,zone))
        assertEquals("2026-10-30/7",AutomationPolicy.slot(before.plusSeconds(1),zone))
        assertEquals(Instant.parse("2026-10-30T14:00:00Z"),AutomationPolicy.next(before.plusSeconds(1),zone))
        assertEquals("2026-10-30/7",AutomationPolicy.slot(Instant.parse("2026-10-30T13:59:00Z"),zone))
        assertEquals(Instant.parse("2026-10-31T06:00:00Z"),AutomationPolicy.next(Instant.parse("2026-10-30T22:00:00Z"),zone))
    }
    @Test fun dstUsesCalendarHoursRatherThan24ElapsedHours() {
        val zone=ZoneId.of("Europe/Warsaw")
        assertEquals(Instant.parse("2026-10-25T06:00:00Z"),AutomationPolicy.next(Instant.parse("2026-10-24T21:00:00Z"),zone))
        assertEquals(Instant.parse("2026-03-29T05:00:00Z"),AutomationPolicy.next(Instant.parse("2026-03-28T22:00:00Z"),zone))
    }
    @Test fun retriesAreBoundedAndDigestIsStable() {
        assertEquals(30000L,AutomationPolicy.retryDelay(0))
        assertEquals(60000L,AutomationPolicy.retryDelay(1))
        assertEquals(21600000L,AutomationPolicy.retryDelay(Int.MAX_VALUE))
        assertEquals(AutomationPolicy.digest("same".toByteArray()),AutomationPolicy.digest("same".toByteArray()))
        assertNotEquals(AutomationPolicy.digest("same".toByteArray()),AutomationPolicy.digest("other".toByteArray()))
    }
    @Test fun editableMinutesRoundTripAndRejectDuplicates() {
        val minutes=listOf(23*60+45,6*60+15,14*60+30)
        assertEquals(listOf(375,870,1425),AutomationPolicy.decode(AutomationPolicy.encode(minutes)))
        assertEquals("06:15",AutomationPolicy.label(375))
        assertEquals("2026-10-30/06:15",AutomationPolicy.slot(Instant.parse("2026-10-30T05:15:00Z"),ZoneId.of("Europe/Warsaw"),minutes))
        for(invalid in listOf(listOf(1,1,2),listOf(1,2),listOf(-1,2,3),listOf(1,2,1440))) {
            assertTrue(runCatching{AutomationPolicy.encode(invalid)}.isFailure)
        }
    }
    @Test fun gapDoesNotRunBeforeResolvedInstantAndOverlapRunsOnce() {
        val zone=ZoneId.of("Europe/Warsaw");val times=listOf(150,720,1380)
        val before=Instant.parse("2026-03-29T01:15:00Z")
        assertEquals(Instant.parse("2026-03-29T01:30:00Z"),AutomationPolicy.next(before,zone,times))
        assertEquals("2026-03-28/23",AutomationPolicy.slot(before,zone,times))
        assertEquals("2026-03-29/02:30",AutomationPolicy.slot(before.plusSeconds(900),zone,times))
        assertEquals("2026-10-25/02:30",AutomationPolicy.slot(Instant.parse("2026-10-25T01:30:00Z"),zone,times))
        assertEquals(Instant.parse("2026-10-25T11:00:00Z"),AutomationPolicy.next(Instant.parse("2026-10-25T00:30:00Z"),zone,times))
    }
}
