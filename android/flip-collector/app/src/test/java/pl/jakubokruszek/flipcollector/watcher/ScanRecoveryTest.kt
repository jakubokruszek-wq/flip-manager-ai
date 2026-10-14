package pl.jakubokruszek.flipcollector.watcher

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.time.ZonedDateTime

@OptIn(ExperimentalCoroutinesApi::class)
class ScanRecoveryTest {
    private val groups = listOf(WatchedGroup("g1", "A", "https://www.facebook.com/groups/a"), WatchedGroup("g2", "B", "https://www.facebook.com/groups/b"))
    private val t0 = Instant.parse("2026-10-15T00:10:00Z")

    @Test
    fun journalCheckpointsTrackTheScanAndSurviveEncoding() = runTest(StandardTestDispatcher()) {
        val journals = mutableListOf<ScanJournal>()
        val gate = CompletableDeferred<Unit>()
        val executor = object : ScanExecutor {
            override val mode = ScanMode.LIVE
            override suspend fun scanGroup(group: WatchedGroup, onProgress: (GroupProgress) -> Unit): GroupScanResult {
                if (group.id == "g2") gate.await()
                return GroupScanResult(postsSeen = 4, offersFound = 1)
            }
        }
        val coordinator = ScanCoordinator(this, {}, onCheckpoint = { journals += it }, clock = { t0 }, newId = { "scan-1" })
        coordinator.start(ScanTrigger.AUTOMATIC, groups, executor, windowKey = "w1")
        runCurrent()
        // Started, group A started, group A done, group B started — then the "process dies" here.
        val last = journals.last()
        assertEquals("scan-1", last.scanId)
        assertEquals(1, last.completedGroups)
        assertEquals(4, last.postsSeen)
        assertEquals("B", last.currentGroup)
        assertEquals("w1", last.windowKey)
        assertEquals(last, ScanRecovery.decode(ScanRecovery.encode(last)))
        gate.complete(Unit)
        advanceUntilIdle()
    }

    @Test
    fun leftoverJournalBecomesAnInterruptedRecordWithItsCounts() {
        val journal = ScanJournal("scan-9", ScanTrigger.AUTOMATIC, ScanMode.DEMO, "2026-10-15T00:10:00Z", "w1", 2, 1, 12, 6, 0, 0, listOf(GroupReport("A", 12, 6)), "2026-10-15T00:11:00Z", currentGroup = "B")
        val record = ScanRecovery.interruptedRecord(journal, Instant.parse("2026-10-15T07:00:00Z"))
        assertEquals(ScanOutcome.INTERRUPTED, record.outcome)
        assertEquals("scan-9", record.id)
        assertEquals(12, record.postsSeen)
        assertEquals(6, record.offersFound)
        assertEquals("w1", record.windowKey)
        assertEquals(ScanMode.DEMO, record.mode)
        assertEquals("2026-10-15T00:11:00Z", record.finishedAt)
        assertTrue(record.message!!.contains("1/2"))
        assertTrue(record.message!!.contains("przerwana: B"))
        assertTrue(record.stopReason!!.startsWith("Wykryto przy następnym uruchomieniu"))
    }

    @Test
    fun brokenJournalDecodesToNull() {
        assertNull(ScanRecovery.decode(null))
        assertNull(ScanRecovery.decode("{oops"))
    }

    @Test
    fun ledgerDistinguishesFinishedInterruptedAndStarted() {
        var ledger = WindowLedger.started(emptyList(), "w1", t0)
        assertEquals(WindowEntry("w1", WindowStatus.STARTED, 1, t0.toString()), ledger.single())
        ledger = WindowLedger.finished(ledger, "w1", ScanOutcome.INTERRUPTED, t0)
        assertEquals(WindowStatus.INTERRUPTED, ledger.single().status)
        ledger = WindowLedger.started(ledger, "w1", t0)
        assertEquals(2, ledger.single().attempts)
        ledger = WindowLedger.finished(ledger, "w1", ScanOutcome.PARTIAL, t0)
        assertEquals(WindowStatus.FINISHED, ledger.single().status)
        assertEquals(ledger, WindowLedger.decode(WindowLedger.encode(ledger)))
        assertEquals(WindowStatus.INTERRUPTED, WindowLedger.finished(emptyList(), "w2", ScanOutcome.STOPPED, t0).single().status)
        assertEquals(WindowStatus.FINISHED, WindowLedger.finished(emptyList(), "w3", ScanOutcome.TIMED_OUT, t0).single().status)
        assertEquals(WindowStatus.FINISHED, WindowLedger.finished(emptyList(), "w4", ScanOutcome.FAILED, t0).single().status)
    }

    @Test
    fun ledgerKeepsOnlyRecentWindows() {
        val ledger = (1..40).fold(emptyList<WindowEntry>()) { acc, i -> WindowLedger.started(acc, "w$i", t0) }
        assertEquals(30, ledger.size)
        assertEquals("w40", ledger.first().key)
    }

    // --- planner with the ledger ---

    private val ready = DeviceConditions(onWifi = true, charging = true, paired = true)
    private val schedule = ScanSchedule.DEFAULT.copy(enabled = true)
    private val inside = ZonedDateTime.parse("2026-10-15T02:30:00+02:00[Europe/Warsaw]")
    private fun key() = schedule.windowContaining(inside)!!.key
    private fun decide(ledger: List<WindowEntry>, running: Boolean = false) =
        AutoScanPlanner.decide(inside, schedule, ready, emptyList(), GroupSelection.AllActive, ledger, running)

    @Test
    fun plannerStartsFreshWindowAsAttemptOne() {
        assertEquals(1, (decide(emptyList()) as AutoDecision.Start).attempt)
    }

    @Test
    fun plannerWaitsOnAFinishedWindow() {
        val ledger = WindowLedger.finished(WindowLedger.started(emptyList(), key(), t0), key(), ScanOutcome.COMPLETED, t0)
        assertEquals(AutoDecision.Wait(listOf(ScanBlocker.WINDOW_FINISHED)), decide(ledger))
    }

    @Test
    fun plannerRetriesAnInterruptedWindowOnce() {
        val interrupted = WindowLedger.finished(WindowLedger.started(emptyList(), key(), t0), key(), ScanOutcome.INTERRUPTED, t0)
        assertEquals(2, (decide(interrupted) as AutoDecision.Start).attempt)
        val twice = WindowLedger.finished(WindowLedger.started(interrupted, key(), t0), key(), ScanOutcome.STOPPED, t0)
        assertEquals(AutoDecision.Wait(listOf(ScanBlocker.WINDOW_RETRIES_EXHAUSTED)), decide(twice))
    }

    @Test
    fun plannerTreatsAStartedEntryWithNoRunningScanAsInterrupted() {
        val orphan = WindowLedger.started(emptyList(), key(), t0) // process died before recovery ran
        assertEquals(2, (decide(orphan) as AutoDecision.Start).attempt)
        // While the scan really runs, the tick only reports it.
        assertEquals(AutoDecision.Wait(listOf(ScanBlocker.ALREADY_RUNNING)), decide(orphan, running = true))
    }

    @Test
    fun anotherNightIsAFreshWindow() {
        val ledger = WindowLedger.finished(WindowLedger.started(emptyList(), key(), t0), key(), ScanOutcome.COMPLETED, t0)
        val next = AutoScanPlanner.decide(inside.plusDays(1), schedule, ready, emptyList(), GroupSelection.AllActive, ledger, false)
        assertNotNull(next as? AutoDecision.Start)
    }
}
