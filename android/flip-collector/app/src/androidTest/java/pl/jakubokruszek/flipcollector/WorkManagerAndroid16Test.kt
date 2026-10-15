package pl.jakubokruszek.flipcollector

import android.content.Context
import android.os.Build
import android.util.Log
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.work.Configuration
import androidx.work.ListenableWorker
import androidx.work.NetworkType
import androidx.work.WorkInfo
import androidx.work.WorkManager
import androidx.work.testing.SynchronousExecutor
import androidx.work.testing.TestListenableWorkerBuilder
import androidx.work.testing.WorkManagerTestInitHelper
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import pl.jakubokruszek.flipcollector.watcher.GroupReport
import pl.jakubokruszek.flipcollector.watcher.ScanJournal
import pl.jakubokruszek.flipcollector.watcher.ScanMode
import pl.jakubokruszek.flipcollector.watcher.ScanOutcome
import pl.jakubokruszek.flipcollector.watcher.ScanSchedule
import pl.jakubokruszek.flipcollector.watcher.ScanTrigger
import pl.jakubokruszek.flipcollector.watcher.WindowStatus
import pl.jakubokruszek.flipcollector.watcher.android.AutoScanWorker
import pl.jakubokruszek.flipcollector.watcher.android.WatcherRuntime

/**
 * WorkManager behaviour of the watcher on a real Android runtime (CI runs it on
 * an API 36 / Android 16 emulator). Uses WorkManager's TestDriver, so
 * constraints and delays are switched on explicitly; no real time passes and
 * nothing touches the network or Facebook.
 */
@RunWith(AndroidJUnit4::class)
class WorkManagerAndroid16Test {
    private lateinit var context: Context
    private lateinit var workManager: WorkManager

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext()
        context.getSharedPreferences("flip_collector_watcher", Context.MODE_PRIVATE).edit().clear().commit()
        WorkManagerTestInitHelper.initializeTestWorkManager(
            context,
            Configuration.Builder().setMinimumLoggingLevel(Log.DEBUG).setExecutor(SynchronousExecutor()).build(),
        )
        workManager = WorkManager.getInstance(context)
        Log.i("FlipCollectorTest", "Running on API ${Build.VERSION.SDK_INT} (${Build.VERSION.RELEASE})")
    }

    private fun autoInfo(): WorkInfo? = workManager.getWorkInfosForUniqueWork(WatcherRuntime.AUTO_WORK_NAME).get().firstOrNull()
    private fun probeInfo(): WorkInfo? = workManager.getWorkInfosForUniqueWork(WatcherRuntime.PROBE_WORK).get().firstOrNull()
    private fun diagnosticCodes() = WatcherRuntime.settings(context).diagnostics().map { it.code }

    /** CoroutineWorkers finish on Dispatchers.Default even with the synchronous test executor; poll briefly. */
    private fun eventually(what: String, timeoutMs: Long = 15_000, check: () -> Boolean) {
        val end = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < end) {
            if (check()) return
            Thread.sleep(100)
        }
        throw AssertionError("Timed out waiting for: $what")
    }

    @Test
    fun enabledScheduleRegistersAPeriodicTickWithWifiAndChargingConstraints() {
        WatcherRuntime.applySchedule(context, ScanSchedule.DEFAULT.copy(enabled = true))
        val info = autoInfo()
        assertNotNull(info)
        info!!
        assertEquals(WorkInfo.State.ENQUEUED, info.state)
        assertEquals(NetworkType.UNMETERED, info.constraints.requiredNetworkType)
        assertTrue(info.constraints.requiresCharging())
        assertEquals(15 * 60 * 1000L, info.periodicityInfo?.repeatIntervalMillis)
    }

    @Test
    fun disabledScheduleCancelsTheTick() {
        WatcherRuntime.applySchedule(context, ScanSchedule.DEFAULT.copy(enabled = true))
        WatcherRuntime.applySchedule(context, ScanSchedule.DEFAULT.copy(enabled = false))
        assertEquals(WorkInfo.State.CANCELLED, autoInfo()?.state)
    }

    @Test
    fun relaxedScheduleDropsTheNetworkAndChargingConstraints() {
        WatcherRuntime.applySchedule(context, ScanSchedule.DEFAULT.copy(enabled = true, requireWifi = false, requireCharging = false))
        val info = autoInfo()!!
        assertEquals(NetworkType.NOT_REQUIRED, info.constraints.requiredNetworkType)
        assertTrue(!info.constraints.requiresCharging())
        assertTrue("battery-not-low protects an unplugged phone", info.constraints.requiresBatteryNotLow())
    }

    @Test
    fun probeWaitsForItsConstraintsAndThenRecordsItsRun() {
        WatcherRuntime.scheduleProbe(context, 1)
        val id = probeInfo()!!.id
        val driver = WorkManagerTestInitHelper.getTestDriver(context)!!
        driver.setInitialDelayMet(id)
        // Delay over, but Wi-Fi/charging not met: Android must keep it waiting.
        assertEquals(WorkInfo.State.ENQUEUED, probeInfo()!!.state)
        driver.setAllConstraintsMet(id)
        eventually("probe SUCCEEDED") { probeInfo()!!.state == WorkInfo.State.SUCCEEDED }
        assertTrue(diagnosticCodes().contains("PROBE_RAN"))
    }

    @Test
    fun periodicTickRunsWhenConstraintsAreMetAndStaysScheduled() {
        WatcherRuntime.applySchedule(context, ScanSchedule.DEFAULT.copy(enabled = true))
        val id = autoInfo()!!.id
        val driver = WorkManagerTestInitHelper.getTestDriver(context)!!
        driver.setAllConstraintsMet(id)
        driver.setPeriodDelayMet(id)
        eventually("tick logged") { diagnosticCodes().any { it.startsWith("AUTO_TICK") || it == "AUTO_SCAN_FINISHED" || it == "SCAN_FINISHED" } }
        eventually("periodic tick back to ENQUEUED") { autoInfo()!!.state == WorkInfo.State.ENQUEUED }
    }

    @Test
    fun tickWithAutomationOffOnlyLogsWhy() = runBlocking {
        val result = TestListenableWorkerBuilder<AutoScanWorker>(context).build().doWork()
        assertEquals(ListenableWorker.Result.success(), result)
        val event = WatcherRuntime.settings(context).diagnostics().first { it.code == "AUTO_TICK_WAIT" }
        assertTrue(event.message, event.message.contains("Automat jest wyłączony"))
    }

    @Test
    fun journalLeftByADeadProcessBecomesAnInterruptedRecord() {
        val store = WatcherRuntime.settings(context)
        store.markWindowStarted("2026-10-15T02:00+02:00")
        store.saveJournal(ScanJournal("dead-1", ScanTrigger.AUTOMATIC, ScanMode.DEMO, "2026-10-15T00:01:00Z", "2026-10-15T02:00+02:00", 1, 0, 5, 2, 0, 0, emptyList<GroupReport>(), "2026-10-15T00:02:00Z", "DEMO"))
        val record = WatcherRuntime.recoverInterruptedScan(context)
        assertEquals(ScanOutcome.INTERRUPTED, record?.outcome)
        assertNull(store.journal())
        assertEquals("dead-1", store.history(ScanMode.DEMO).first().id)
        assertTrue(store.history(ScanMode.LIVE).isEmpty())
        assertEquals(WindowStatus.INTERRUPTED, store.ledger().first().status)
        // A second call finds nothing to recover.
        assertNull(WatcherRuntime.recoverInterruptedScan(context))
    }
}
