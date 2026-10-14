package pl.jakubokruszek.flipcollector.watcher

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.util.Collections

@OptIn(ExperimentalCoroutinesApi::class)
class ScanCoordinatorTest {
    private val groups = listOf(WatchedGroup("g1", "Łódź mieszkania", "https://www.facebook.com/groups/a"), WatchedGroup("g2", "Bałuty", "https://www.facebook.com/groups/b"))

    private class GatedExecutor(override val dryRun: Boolean = false, val failOn: Set<String> = emptySet()) : ScanExecutor {
        val gate = CompletableDeferred<Unit>()
        val calls: MutableList<String> = Collections.synchronizedList(mutableListOf())
        override suspend fun scanGroup(group: WatchedGroup, onProgress: (Int, Int) -> Unit): GroupScanResult {
            calls += group.id
            gate.await()
            if (group.id in failOn) throw IllegalStateException("Facebook nie odpowiedział")
            onProgress(3, 1)
            return GroupScanResult(postsSeen = 3, postsSent = 1)
        }
    }

    private fun coordinator(scope: TestScope, executor: ScanExecutor, records: MutableList<ScanRecord>) =
        ScanCoordinator(scope, executor, { records += it }, clock = { Instant.parse("2026-10-14T00:00:00Z") }, newId = { "scan-${records.size}" })

    @Test
    fun secondStartWhileRunningIsRefused() = runTest(StandardTestDispatcher()) {
        val executor = GatedExecutor()
        val records = mutableListOf<ScanRecord>()
        val coordinator = coordinator(this, executor, records)
        assertTrue(coordinator.start(ScanTrigger.MANUAL, groups) is StartResult.Started)
        runCurrent()
        assertEquals(StartResult.AlreadyRunning, coordinator.start(ScanTrigger.AUTOMATIC, groups))
        assertTrue(coordinator.isRunning)
        executor.gate.complete(Unit)
        advanceUntilIdle()
        assertFalse(coordinator.isRunning)
        assertEquals(1, records.size)
        assertEquals(listOf("g1", "g2"), executor.calls)
        // The lock is released after the first scan, so a new one may start.
        assertTrue(coordinator.start(ScanTrigger.MANUAL, groups) is StartResult.Started)
    }

    @Test
    fun concurrentStartsFromManyThreadsAdmitExactlyOne() = runTest(StandardTestDispatcher()) {
        val executor = GatedExecutor()
        val coordinator = coordinator(this, executor, mutableListOf())
        val results = Collections.synchronizedList(mutableListOf<StartResult>())
        val threads = List(16) { Thread { results += coordinator.start(ScanTrigger.MANUAL, groups) } }
        threads.forEach(Thread::start)
        threads.forEach(Thread::join)
        assertEquals(1, results.count { it is StartResult.Started })
        assertEquals(15, results.count { it == StartResult.AlreadyRunning })
        executor.gate.complete(Unit)
        advanceUntilIdle()
    }

    @Test
    fun countersAddUpAcrossGroups() = runTest(StandardTestDispatcher()) {
        val executor = GatedExecutor().also { it.gate.complete(Unit) }
        val records = mutableListOf<ScanRecord>()
        coordinator(this, executor, records).start(ScanTrigger.MANUAL, groups)
        advanceUntilIdle()
        val record = records.single()
        assertEquals(ScanOutcome.COMPLETED, record.outcome)
        assertEquals(2, record.groups)
        assertEquals(6, record.postsSeen)
        assertEquals(2, record.postsSent)
        assertEquals(0, record.errors)
    }

    @Test
    fun oneFailingGroupIsCountedAndTheScanContinues() = runTest(StandardTestDispatcher()) {
        val executor = GatedExecutor(failOn = setOf("g1")).also { it.gate.complete(Unit) }
        val records = mutableListOf<ScanRecord>()
        val coordinator = coordinator(this, executor, records)
        coordinator.start(ScanTrigger.MANUAL, groups)
        advanceUntilIdle()
        val record = records.single()
        assertEquals(ScanOutcome.PARTIAL, record.outcome)
        assertEquals(1, record.errors)
        assertEquals(listOf("g1", "g2"), executor.calls)
        assertEquals("Łódź mieszkania: Facebook nie odpowiedział", record.message)
        assertEquals(ScanState.Idle, coordinator.state.value)
    }

    @Test
    fun allGroupsFailingIsAFailedScanAndReleasesTheLock() = runTest(StandardTestDispatcher()) {
        val executor = GatedExecutor(failOn = setOf("g1", "g2")).also { it.gate.complete(Unit) }
        val records = mutableListOf<ScanRecord>()
        val coordinator = coordinator(this, executor, records)
        coordinator.start(ScanTrigger.AUTOMATIC, groups, windowKey = "w1")
        advanceUntilIdle()
        assertEquals(ScanOutcome.FAILED, records.single().outcome)
        assertEquals("w1", records.single().windowKey)
        assertFalse(coordinator.isRunning)
    }

    @Test
    fun stopCancelsTheScanAndRecordsItAsStopped() = runTest(StandardTestDispatcher()) {
        val executor = GatedExecutor()
        val records = mutableListOf<ScanRecord>()
        val coordinator = coordinator(this, executor, records)
        coordinator.start(ScanTrigger.MANUAL, groups)
        runCurrent()
        assertTrue(coordinator.state.value is ScanState.Running)
        assertTrue(coordinator.stop())
        advanceUntilIdle()
        assertEquals(ScanOutcome.STOPPED, records.single().outcome)
        assertEquals(listOf("g1"), executor.calls)
        assertFalse(coordinator.isRunning)
        assertFalse(coordinator.stop())
    }

    @Test
    fun progressShowsTheCurrentGroup() = runTest(StandardTestDispatcher()) {
        val executor = GatedExecutor()
        val coordinator = coordinator(this, executor, mutableListOf())
        coordinator.start(ScanTrigger.MANUAL, groups)
        runCurrent()
        val running = coordinator.state.value as ScanState.Running
        assertEquals("Łódź mieszkania", running.progress.currentGroup)
        assertEquals(2, running.progress.totalGroups)
        assertEquals(0, running.progress.completedGroups)
        executor.gate.complete(Unit)
        advanceUntilIdle()
    }

    @Test
    fun dryRunNeverReportsPostsAndIsLabelledAsSuch() = runTest(StandardTestDispatcher()) {
        val records = mutableListOf<ScanRecord>()
        coordinator(this, DryRunScanExecutor(), records).start(ScanTrigger.MANUAL, groups)
        advanceUntilIdle()
        val record = records.single()
        assertEquals(ScanOutcome.DRY_RUN, record.outcome)
        assertEquals(0, record.postsSeen)
        assertEquals(0, record.postsSent)
        assertEquals("Tryb przygotowawczy: Facebook nie był otwierany.", record.message)
    }

    @Test
    fun aThrowingHistorySinkStillReleasesTheLock() = runTest(StandardTestDispatcher()) {
        val coordinator = ScanCoordinator(this, DryRunScanExecutor(), { throw IllegalStateException("disk full") })
        coordinator.start(ScanTrigger.MANUAL, groups)
        advanceUntilIdle()
        assertFalse(coordinator.isRunning)
        assertEquals(ScanState.Idle, coordinator.state.value)
    }
}
