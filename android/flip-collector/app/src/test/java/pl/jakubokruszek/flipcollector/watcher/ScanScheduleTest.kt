package pl.jakubokruszek.flipcollector.watcher

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.DayOfWeek
import java.time.Duration
import java.time.LocalDate
import java.time.ZonedDateTime

class ScanScheduleTest {
    private fun warsaw(text: String): ZonedDateTime = ZonedDateTime.parse("$text[Europe/Warsaw]")

    @Test
    fun defaultsAreDaily0200To0500WithWifiAndChargingAndAutomationOff() {
        val schedule = ScanSchedule.DEFAULT
        assertEquals(120, schedule.startMinutes)
        assertEquals(300, schedule.endMinutes)
        assertEquals(DayOfWeek.entries.toSet(), schedule.days)
        assertTrue(schedule.requireWifi)
        assertTrue(schedule.requireCharging)
        assertFalse(schedule.enabled)
        assertEquals("Europe/Warsaw", schedule.zone.id)
    }

    @Test
    fun windowBoundsAreStartInclusiveEndExclusive() {
        val schedule = ScanSchedule.DEFAULT
        assertFalse(schedule.isWithinWindow(warsaw("2026-10-14T01:59:59+02:00")))
        assertTrue(schedule.isWithinWindow(warsaw("2026-10-14T02:00:00+02:00")))
        assertTrue(schedule.isWithinWindow(warsaw("2026-10-14T04:59:59+02:00")))
        assertFalse(schedule.isWithinWindow(warsaw("2026-10-14T05:00:00+02:00")))
    }

    @Test
    fun onlySelectedDaysOpenAWindow() {
        val schedule = ScanSchedule.DEFAULT.copy(days = setOf(DayOfWeek.MONDAY, DayOfWeek.FRIDAY))
        assertTrue(schedule.isWithinWindow(warsaw("2026-10-12T03:00:00+02:00"))) // Monday
        assertFalse(schedule.isWithinWindow(warsaw("2026-10-13T03:00:00+02:00"))) // Tuesday
        assertTrue(schedule.isWithinWindow(warsaw("2026-10-16T03:00:00+02:00"))) // Friday
    }

    @Test
    fun noDaysMeansNoWindowEver() {
        val schedule = ScanSchedule.DEFAULT.copy(days = emptySet())
        assertFalse(schedule.isWithinWindow(warsaw("2026-10-14T03:00:00+02:00")))
        assertNull(schedule.nextWindow(warsaw("2026-10-14T03:00:00+02:00")))
    }

    @Test
    fun windowCrossingMidnightBelongsToItsStartDay() {
        // Friday 23:00 – Saturday 02:00, only Friday selected.
        val schedule = ScanSchedule.DEFAULT.copy(startMinutes = 23 * 60, endMinutes = 2 * 60, days = setOf(DayOfWeek.FRIDAY))
        assertTrue(schedule.crossesMidnight)
        assertTrue(schedule.isWithinWindow(warsaw("2026-10-16T23:30:00+02:00"))) // Friday evening
        assertTrue(schedule.isWithinWindow(warsaw("2026-10-17T01:59:00+02:00"))) // Saturday night, still Friday's window
        assertFalse(schedule.isWithinWindow(warsaw("2026-10-17T02:00:00+02:00")))
        assertFalse(schedule.isWithinWindow(warsaw("2026-10-17T23:30:00+02:00"))) // Saturday is not selected
        assertFalse(schedule.isWithinWindow(warsaw("2026-10-16T01:00:00+02:00"))) // Thursday's window does not exist
        val window = schedule.windowContaining(warsaw("2026-10-17T01:00:00+02:00"))!!
        assertEquals(LocalDate.parse("2026-10-16"), window.start.toLocalDate())
    }

    @Test
    fun nextWindowSkipsUnselectedDaysAndKeepsCurrentWindow() {
        val schedule = ScanSchedule.DEFAULT.copy(days = setOf(DayOfWeek.SUNDAY))
        val next = schedule.nextWindow(warsaw("2026-10-14T12:00:00+02:00"))!! // Wednesday noon
        assertEquals(warsaw("2026-10-18T02:00:00+02:00").toInstant(), next.start.toInstant())
        val current = schedule.nextWindow(warsaw("2026-10-18T03:00:00+02:00"))!!
        assertEquals(next, current)
    }

    @Test
    fun springForwardGapShortensTheDefaultWindow() {
        // 29 Mar 2026: Warsaw clocks jump 02:00 CET → 03:00 CEST.
        val window = ScanSchedule.DEFAULT.windowStartingOn(LocalDate.parse("2026-03-29"))!!
        assertEquals(warsaw("2026-03-29T03:00:00+02:00").toInstant(), window.start.toInstant())
        assertEquals(warsaw("2026-03-29T05:00:00+02:00").toInstant(), window.end.toInstant())
        assertEquals(Duration.ofHours(2), Duration.between(window.start, window.end))
        assertTrue(ScanSchedule.DEFAULT.isWithinWindow(warsaw("2026-03-29T03:30:00+02:00")))
    }

    @Test
    fun fallBackOverlapLengthensTheDefaultWindowAndStartsOnTheEarlierOffset() {
        // 25 Oct 2026: Warsaw clocks fall back 03:00 CEST → 02:00 CET.
        val window = ScanSchedule.DEFAULT.windowStartingOn(LocalDate.parse("2026-10-25"))!!
        assertEquals(warsaw("2026-10-25T02:00:00+02:00").toInstant(), window.start.toInstant())
        assertEquals(warsaw("2026-10-25T05:00:00+01:00").toInstant(), window.end.toInstant())
        assertEquals(Duration.ofHours(4), Duration.between(window.start, window.end))
        // Both 02:30 instants of that night are inside the window.
        assertTrue(ScanSchedule.DEFAULT.isWithinWindow(warsaw("2026-10-25T02:30:00+02:00")))
        assertTrue(ScanSchedule.DEFAULT.isWithinWindow(warsaw("2026-10-25T02:30:00+01:00")))
    }

    @Test
    fun windowEntirelyInsideTheSpringGapMovesForwardByTheGap() {
        // 02:10–02:50 does not exist on 29 Mar 2026; java.time moves both ends
        // forward by the one-hour gap, so that night's window is 03:10–03:50.
        val schedule = ScanSchedule.DEFAULT.copy(startMinutes = 2 * 60 + 10, endMinutes = 2 * 60 + 50)
        val window = schedule.windowStartingOn(LocalDate.parse("2026-03-29"))!!
        assertEquals(warsaw("2026-03-29T03:10:00+02:00").toInstant(), window.start.toInstant())
        assertEquals(Duration.ofMinutes(40), Duration.between(window.start, window.end))
        assertNotNull(schedule.windowStartingOn(LocalDate.parse("2026-03-30")))
    }

    @Test
    fun windowKeyIsStableAndDiffersPerDay() {
        val schedule = ScanSchedule.DEFAULT
        val a = schedule.windowContaining(warsaw("2026-10-14T02:10:00+02:00"))!!
        val b = schedule.windowContaining(warsaw("2026-10-14T04:50:00+02:00"))!!
        val c = schedule.windowContaining(warsaw("2026-10-15T02:10:00+02:00"))!!
        assertEquals(a.key, b.key)
        assertFalse(a.key == c.key)
    }

    @Test
    fun evaluatesTheWindowInWarsawEvenWhenGivenAnotherZone() {
        val utc = ZonedDateTime.parse("2026-10-14T00:30:00Z") // 02:30 in Warsaw
        assertTrue(ScanSchedule.DEFAULT.isWithinWindow(utc))
    }

    @Test(expected = IllegalArgumentException::class)
    fun rejectsMinutesOutsideTheDay() {
        ScanSchedule(startMinutes = 24 * 60)
    }
}
