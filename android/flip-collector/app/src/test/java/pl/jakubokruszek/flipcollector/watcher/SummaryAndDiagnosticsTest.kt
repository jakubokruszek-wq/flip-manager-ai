package pl.jakubokruszek.flipcollector.watcher

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

class SummaryAndDiagnosticsTest {
    private fun record(id: String, startedAt: String, outcome: ScanOutcome, offers: Int = 0, errors: Int = 0, message: String? = null) =
        ScanRecord(id, ScanTrigger.MANUAL, startedAt, startedAt, outcome, 1, 10, 0, errors, message, offersFound = offers)

    @Test
    fun summaryPicksLastSuccessfulAndCountsTodayInWarsaw() {
        val history = listOf(
            record("c", "2026-10-14T21:30:00Z", ScanOutcome.FAILED, errors = 1, message = "DEMO: błąd"), // 23:30 Warsaw, 14 Oct
            record("b", "2026-10-14T00:30:00Z", ScanOutcome.COMPLETED, offers = 4),                       // 02:30 Warsaw, 14 Oct
            record("a", "2026-10-13T21:59:00Z", ScanOutcome.COMPLETED, offers = 9),                       // 23:59 Warsaw, 13 Oct
        )
        val summary = ScanSummary.from(history, Instant.parse("2026-10-14T21:45:00Z"))
        assertEquals("b", summary.lastSuccessful?.id)
        assertEquals("c", summary.lastScan?.id)
        assertEquals(4, summary.offersToday)
        assertEquals(2, summary.scansToday)
        assertEquals("DEMO: błąd", summary.lastError)
    }

    @Test
    fun emptyHistoryHasNoLastScan() {
        val summary = ScanSummary.from(emptyList(), Instant.parse("2026-10-14T00:00:00Z"))
        assertNull(summary.lastSuccessful)
        assertEquals(0, summary.offersToday)
    }

    @Test
    fun diagnosticsAreCappedNewestFirstAndRoundTrip() {
        val log = (1..250).fold(emptyList<DiagnosticEvent>()) { acc, i -> Diagnostics.append(acc, DiagnosticEvent("t$i", DiagnosticLevel.INFO, "TICK", "x".repeat(400))) }
        assertEquals(Diagnostics.LIMIT, log.size)
        assertEquals("t250", log.first().at)
        assertEquals(300, log.first().message.length)
        assertEquals(log, Diagnostics.decode(Diagnostics.encode(log)))
        assertEquals(emptyList<DiagnosticEvent>(), Diagnostics.decode("broken"))
    }

    @Test
    fun exportReadsOldestFirstUnderTheHeader() {
        val log = listOf(DiagnosticEvent("t2", DiagnosticLevel.WARN, "B", "drugi"), DiagnosticEvent("t1", DiagnosticLevel.INFO, "A", "pierwszy"))
        val text = Diagnostics.export(log, listOf("Flip Collector 0.3.0"))
        assertTrue(text.startsWith("Flip Collector 0.3.0\n---\nt1 INFO A pierwszy\nt2 WARN B drugi"))
    }
}
