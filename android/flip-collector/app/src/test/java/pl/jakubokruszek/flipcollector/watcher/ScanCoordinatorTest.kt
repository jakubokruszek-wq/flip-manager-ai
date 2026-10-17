package pl.jakubokruszek.flipcollector.watcher

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.delay
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Duration
import java.time.Instant
import java.util.Collections

@OptIn(ExperimentalCoroutinesApi::class)
class ScanCoordinatorTest {
    private val groups = listOf(WatchedGroup("g1", "Łódź mieszkania", "https://www.facebook.com/groups/a"), WatchedGroup("g2", "Bałuty", "https://www.facebook.com/groups/b"))

    private class GatedExecutor(val failOn: Set<String> = emptySet()) : ScanExecutor {
        override val mode = ScanMode.LIVE
        val gate = CompletableDeferred<Unit>()
        val calls: MutableList<String> = Collections.synchronizedList(mutableListOf())
        override suspend fun scanGroup(group: WatchedGroup, onProgress: (GroupProgress) -> Unit): GroupScanResult {
            calls += group.id
            gate.await()
            if (group.id in failOn) throw IllegalStateException("Facebook nie odpowiedział")
            onProgress(GroupProgress(3, 2, 3))
            return GroupScanResult(postsSeen = 3, offersFound = 2, postsSent = 1)
        }
    }

    private fun coordinator(scope: TestScope, records: MutableList<ScanRecord>) =
        ScanCoordinator(scope, { records += it }, clock = { Instant.parse("2026-10-14T00:00:00Z") }, newId = { "scan-${records.size}" })

    @Test
    fun secondStartWhileRunningIsRefused() = runTest(StandardTestDispatcher()) {
        val executor = GatedExecutor()
        val records = mutableListOf<ScanRecord>()
        val coordinator = coordinator(this, records)
        assertTrue(coordinator.start(ScanTrigger.MANUAL, groups, executor) is StartResult.Started)
        runCurrent()
        assertEquals(StartResult.AlreadyRunning, coordinator.start(ScanTrigger.AUTOMATIC, groups, executor))
        assertTrue(coordinator.isRunning)
        executor.gate.complete(Unit)
        advanceUntilIdle()
        assertFalse(coordinator.isRunning)
        assertEquals(1, records.size)
        assertEquals(listOf("g1", "g2"), executor.calls)
        // The lock is released after the first scan, so a new one may start.
        assertTrue(coordinator.start(ScanTrigger.MANUAL, groups, executor) is StartResult.Started)
        advanceUntilIdle()
    }

    @Test
    fun concurrentStartsFromManyThreadsAdmitExactlyOne() = runTest(StandardTestDispatcher()) {
        val executor = GatedExecutor()
        val coordinator = coordinator(this, mutableListOf())
        val results = Collections.synchronizedList(mutableListOf<StartResult>())
        val threads = List(16) { Thread { results += coordinator.start(ScanTrigger.MANUAL, groups, executor) } }
        threads.forEach(Thread::start)
        threads.forEach(Thread::join)
        assertEquals(1, results.count { it is StartResult.Started })
        assertEquals(15, results.count { it == StartResult.AlreadyRunning })
        executor.gate.complete(Unit)
        advanceUntilIdle()
    }

    @Test
    fun countersAddUpAcrossGroupsWithAPerGroupReport() = runTest(StandardTestDispatcher()) {
        val executor = GatedExecutor().also { it.gate.complete(Unit) }
        val records = mutableListOf<ScanRecord>()
        coordinator(this, records).start(ScanTrigger.MANUAL, groups, executor)
        advanceUntilIdle()
        val record = records.single()
        assertEquals(ScanOutcome.COMPLETED, record.outcome)
        assertEquals(ScanMode.LIVE, record.mode)
        assertEquals(2, record.groups)
        assertEquals(6, record.postsSeen)
        assertEquals(4, record.offersFound)
        assertEquals(2, record.postsSent)
        assertEquals(0, record.errors)
        assertEquals(listOf(GroupReport("Łódź mieszkania", 3, 2), GroupReport("Bałuty", 3, 2)), record.groupReports)
        assertNull(record.stopReason)
    }

    @Test
    fun oneFailingGroupIsCountedAndTheScanContinues() = runTest(StandardTestDispatcher()) {
        val executor = GatedExecutor(failOn = setOf("g1")).also { it.gate.complete(Unit) }
        val records = mutableListOf<ScanRecord>()
        val coordinator = coordinator(this, records)
        coordinator.start(ScanTrigger.MANUAL, groups, executor)
        advanceUntilIdle()
        val record = records.single()
        assertEquals(ScanOutcome.PARTIAL, record.outcome)
        assertEquals(1, record.errors)
        assertEquals(listOf("g1", "g2"), executor.calls)
        assertEquals("Łódź mieszkania: Facebook nie odpowiedział", record.message)
        assertEquals("Facebook nie odpowiedział", record.groupReports.first().error)
        assertEquals(ScanState.Idle, coordinator.state.value)
    }

    @Test
    fun allGroupsFailingIsAFailedScanAndReleasesTheLock() = runTest(StandardTestDispatcher()) {
        val executor = GatedExecutor(failOn = setOf("g1", "g2")).also { it.gate.complete(Unit) }
        val records = mutableListOf<ScanRecord>()
        val coordinator = coordinator(this, records)
        coordinator.start(ScanTrigger.AUTOMATIC, groups, executor, windowKey = "w1")
        advanceUntilIdle()
        assertEquals(ScanOutcome.FAILED, records.single().outcome)
        assertEquals("w1", records.single().windowKey)
        assertFalse(coordinator.isRunning)
    }

    @Test
    fun stopCancelsTheScanAndRecordsTheReason() = runTest(StandardTestDispatcher()) {
        val executor = GatedExecutor()
        val records = mutableListOf<ScanRecord>()
        val coordinator = coordinator(this, records)
        coordinator.start(ScanTrigger.MANUAL, groups, executor)
        runCurrent()
        assertTrue(coordinator.state.value is ScanState.Running)
        assertTrue(coordinator.stop("System zatrzymał zadanie (STOP_REASON_TIMEOUT)"))
        advanceUntilIdle()
        val record = records.single()
        assertEquals(ScanOutcome.STOPPED, record.outcome)
        assertEquals("System zatrzymał zadanie (STOP_REASON_TIMEOUT)", record.stopReason)
        assertEquals(listOf("g1"), executor.calls)
        assertFalse(coordinator.isRunning)
        assertFalse(coordinator.stop())
    }

    @Test
    fun aGroupOverItsLimitIsAnErrorAndTheNextGroupStillRuns() = runTest(StandardTestDispatcher()) {
        val slowFirst = object : ScanExecutor {
            override val mode = ScanMode.LIVE
            override suspend fun scanGroup(group: WatchedGroup, onProgress: (GroupProgress) -> Unit): GroupScanResult {
                if (group.id == "g1") awaitCancellation()
                return GroupScanResult(postsSeen = 5, offersFound = 1)
            }
        }
        val records = mutableListOf<ScanRecord>()
        coordinator(this, records).start(ScanTrigger.MANUAL, groups, slowFirst, ScanLimits(perGroup = Duration.ofMinutes(1), total = Duration.ofMinutes(10)))
        advanceUntilIdle()
        val record = records.single()
        assertEquals(ScanOutcome.PARTIAL, record.outcome)
        assertEquals("Przekroczono limit czasu grupy (1 min)", record.groupReports.first().error)
        assertEquals(5, record.postsSeen)
    }

    @Test
    fun aScanOverItsTotalLimitEndsAsTimedOut() = runTest(StandardTestDispatcher()) {
        val slow = object : ScanExecutor {
            override val mode = ScanMode.LIVE
            override suspend fun scanGroup(group: WatchedGroup, onProgress: (GroupProgress) -> Unit): GroupScanResult {
                delay(Duration.ofMinutes(2).toMillis())
                return GroupScanResult(postsSeen = 1)
            }
        }
        val records = mutableListOf<ScanRecord>()
        coordinator(this, records).start(ScanTrigger.AUTOMATIC, groups, slow, ScanLimits(perGroup = Duration.ofMinutes(3), total = Duration.ofMinutes(3)))
        advanceUntilIdle()
        val record = records.single()
        assertEquals(ScanOutcome.TIMED_OUT, record.outcome)
        assertEquals(1, record.postsSeen) // the first group finished at 2 min, the second was cut at 3 min
        assertEquals("Skan przerwany po 3 min (limit całkowity).", record.message)
        assertNull(record.stopReason)
    }

    @Test
    fun progressShowsTheCurrentGroup() = runTest(StandardTestDispatcher()) {
        val executor = GatedExecutor()
        val coordinator = coordinator(this, mutableListOf())
        coordinator.start(ScanTrigger.MANUAL, groups, executor)
        runCurrent()
        val running = coordinator.state.value as ScanState.Running
        assertEquals("Łódź mieszkania", running.progress.currentGroup)
        assertEquals(2, running.progress.totalGroups)
        assertEquals(0, running.progress.completedGroups)
        executor.gate.complete(Unit)
        advanceUntilIdle()
    }

    @Test
    fun aThrowingHistorySinkStillReleasesTheLock() = runTest(StandardTestDispatcher()) {
        val coordinator = ScanCoordinator(this, { throw IllegalStateException("disk full") })
        coordinator.start(ScanTrigger.MANUAL, DemoData.groups, DemoScanExecutor(pausePerPost = {}))
        advanceUntilIdle()
        assertFalse(coordinator.isRunning)
        assertEquals(ScanState.Idle, coordinator.state.value)
    }
}
