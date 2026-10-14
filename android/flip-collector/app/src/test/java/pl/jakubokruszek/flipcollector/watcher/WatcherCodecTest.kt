package pl.jakubokruszek.flipcollector.watcher

import org.junit.Assert.assertEquals
import org.junit.Test
import java.time.DayOfWeek

class WatcherCodecTest {
    @Test
    fun scheduleRoundTrips() {
        val schedule = ScanSchedule(enabled = true, startMinutes = 23 * 60 + 15, endMinutes = 90, days = setOf(DayOfWeek.MONDAY, DayOfWeek.SUNDAY), requireWifi = false, requireCharging = true)
        assertEquals(schedule, WatcherCodec.decodeSchedule(WatcherCodec.encodeSchedule(schedule)))
    }

    @Test
    fun missingOrBrokenScheduleFallsBackToDefaults() {
        assertEquals(ScanSchedule.DEFAULT, WatcherCodec.decodeSchedule(null))
        assertEquals(ScanSchedule.DEFAULT, WatcherCodec.decodeSchedule("not json"))
        assertEquals(ScanSchedule.DEFAULT, WatcherCodec.decodeSchedule("{\"startMinutes\":99999}"))
    }

    @Test
    fun selectionRoundTrips() {
        assertEquals(GroupSelection.AllActive, WatcherCodec.decodeSelection(WatcherCodec.encodeSelection(GroupSelection.AllActive)))
        assertEquals(GroupSelection.Single("g-1"), WatcherCodec.decodeSelection(WatcherCodec.encodeSelection(GroupSelection.Single("g-1"))))
        assertEquals(GroupSelection.AllActive, WatcherCodec.decodeSelection("garbage"))
    }

    @Test
    fun groupsRoundTrip() {
        val groups = listOf(WatchedGroup("1", "Łódź", "https://www.facebook.com/groups/x", active = false))
        assertEquals(groups, WatcherCodec.decodeGroups(WatcherCodec.encodeGroups(groups)))
    }

    @Test
    fun recordWithReportsAndStopReasonRoundTrips() {
        val record = ScanRecord("s1", ScanTrigger.AUTOMATIC, "2026-10-14T00:00:00Z", "2026-10-14T00:05:00Z", ScanOutcome.STOPPED, 2, 7, 0, 1, "Bałuty: błąd", "w1", ScanMode.DEMO, 3, listOf(GroupReport("A", 7, 3), GroupReport("Bałuty", 0, 0, "błąd")), "Zatrzymane przez użytkownika")
        assertEquals(listOf(record), WatcherCodec.decodeHistory(WatcherCodec.encodeHistory(listOf(record))))
    }

    @Test
    fun historyFromVersion020StillDecodes() {
        val old = "[{\"id\":\"s\",\"trigger\":\"MANUAL\",\"startedAt\":\"a\",\"finishedAt\":\"b\",\"outcome\":\"DRY_RUN\",\"groups\":1,\"postsSeen\":0,\"postsSent\":0,\"errors\":0,\"message\":null,\"windowKey\":null}]"
        val decoded = WatcherCodec.decodeHistory(old).single()
        assertEquals(ScanOutcome.DRY_RUN, decoded.outcome)
        assertEquals(ScanMode.DEMO, decoded.mode)
        assertEquals(emptyList<GroupReport>(), decoded.groupReports)
    }

    @Test
    fun historyRoundTripsAndIsCappedNewestFirst() {
        val records = (1..60).fold(emptyList<ScanRecord>()) { history, index ->
            WatcherCodec.prepend(history, ScanRecord("s$index", ScanTrigger.MANUAL, "2026-10-14T00:00:00Z", "2026-10-14T00:01:00Z", ScanOutcome.DRY_RUN, 2, 0, 0, 0, if (index % 2 == 0) null else "note", null))
        }
        assertEquals(WatcherCodec.HISTORY_LIMIT, records.size)
        assertEquals("s60", records.first().id)
        assertEquals(records, WatcherCodec.decodeHistory(WatcherCodec.encodeHistory(records)))
    }
}
