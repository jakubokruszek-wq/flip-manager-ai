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
}
