package pl.jakubokruszek.flipcollector.watcher

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.delay
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

/** End-to-end demo scan of one group on bundled test data: start, posts, counters, stop, error, report. */
@OptIn(ExperimentalCoroutinesApi::class)
class DemoScanTest {
    private val offers = DemoData.posts.count { it.isOffer }

    @Test
    fun demoDataIsClearlyLabelledAndLocal() {
        assertTrue(DemoData.group.name.startsWith("DEMO"))
        assertTrue(DemoData.group.url.startsWith("demo://"))
        assertTrue(DemoData.posts.all { it.text.startsWith("DEMO:") })
        assertEquals(12, DemoData.posts.size)
        assertEquals(6, offers)
    }

    @Test
    fun fullDemoRunCountsPostsAndOffersAndSendsNothing() = runTest(StandardTestDispatcher()) {
        val records = mutableListOf<ScanRecord>()
        val coordinator = ScanCoordinator(this, { records += it }, clock = { Instant.parse("2026-10-14T01:00:00Z") })
        coordinator.start(ScanTrigger.MANUAL, DemoData.groups, DemoScanExecutor(pausePerPost = { delay(350) }))
        advanceUntilIdle()
        val record = records.single()
        assertEquals(ScanOutcome.COMPLETED, record.outcome)
        assertEquals(ScanMode.DEMO, record.mode)
        assertEquals(12, record.postsSeen)
        assertEquals(offers, record.offersFound)
        assertEquals(0, record.postsSent)
        assertEquals("Tryb demo: dane testowe, nic nie wysłano do Flip Managera.", record.message)
        assertEquals(listOf(GroupReport(DemoData.group.name, 12, offers)), record.groupReports)
    }

    @Test
    fun countersMoveWhileTheDemoRuns() = runTest(StandardTestDispatcher()) {
        val coordinator = ScanCoordinator(this, {})
        coordinator.start(ScanTrigger.MANUAL, DemoData.groups, DemoScanExecutor(pausePerPost = { delay(350) }))
        runCurrent()
        advanceTimeBy(350L * 5 + 1)
        val progress = (coordinator.state.value as ScanState.Running).progress
        assertEquals(5, progress.currentGroupPosts)
        assertEquals(12, progress.currentGroupTotal)
        assertEquals(5, progress.postsSeen)
        assertEquals(DemoData.posts.take(5).count { it.isOffer }, progress.offersFound)
        advanceUntilIdle()
    }

    @Test
    fun stoppingTheDemoKeepsWhatWasCountedSoFar() = runTest(StandardTestDispatcher()) {
        val records = mutableListOf<ScanRecord>()
        val coordinator = ScanCoordinator(this, { records += it })
        coordinator.start(ScanTrigger.MANUAL, DemoData.groups, DemoScanExecutor(pausePerPost = { delay(350) }))
        runCurrent()
        advanceTimeBy(350L * 4 + 1)
        coordinator.stop()
        advanceUntilIdle()
        val record = records.single()
        assertEquals(ScanOutcome.STOPPED, record.outcome)
        assertEquals("Zatrzymane przez użytkownika", record.stopReason)
        assertEquals(ScanState.Idle, coordinator.state.value)
    }

    @Test
    fun simulatedErrorFailsTheGroupWithAReport() = runTest(StandardTestDispatcher()) {
        val records = mutableListOf<ScanRecord>()
        ScanCoordinator(this, { records += it }).start(ScanTrigger.MANUAL, DemoData.groups, DemoScanExecutor(pausePerPost = { delay(10) }, failAfterPosts = 7))
        advanceUntilIdle()
        val record = records.single()
        assertEquals(ScanOutcome.FAILED, record.outcome)
        assertEquals(1, record.errors)
        assertEquals("Symulowany błąd po 7 postach (tryb demo)", record.groupReports.single().error)
        assertEquals("${DemoData.group.name}: Symulowany błąd po 7 postach (tryb demo)", record.message)
    }
}
