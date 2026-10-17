package pl.jakubokruszek.flipcollector.watcher.android

import android.content.Context
import android.os.Build
import androidx.work.CoroutineWorker
import androidx.work.WorkInfo
import androidx.work.WorkerParameters
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.first
import pl.jakubokruszek.flipcollector.watcher.AutoDecision
import pl.jakubokruszek.flipcollector.watcher.AutoScanPlanner
import pl.jakubokruszek.flipcollector.watcher.DiagnosticLevel
import pl.jakubokruszek.flipcollector.watcher.ScanLimits
import pl.jakubokruszek.flipcollector.watcher.ScanSchedule
import pl.jakubokruszek.flipcollector.watcher.ScanState
import pl.jakubokruszek.flipcollector.watcher.ScanTrigger
import pl.jakubokruszek.flipcollector.watcher.StartResult
import pl.jakubokruszek.flipcollector.watcher.WindowLedger
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter

/**
 * Periodic tick (WorkManager, every 15 min while automation is on). Asks
 * [AutoScanPlanner] whether a scan is due and, if so, runs one inside this
 * worker and waits for it. The scan's total limit ([ScanLimits.AUTOMATIC],
 * 8 min) stays under WorkManager's per-worker execution limit. If the system
 * stops the worker anyway (quota, constraints lost, timeout), the scan is
 * cancelled and the stop reason goes to the history and diagnostics.
 *
 * No foreground service: Android does not allow starting one from the
 * background at 02:00, and this tick does not need one.
 */
class AutoScanWorker(appContext: Context, params: WorkerParameters) : CoroutineWorker(appContext, params) {
    override suspend fun doWork(): Result {
        // Only an explicitly configured, pinned loopback fixture can take this
        // branch. Production integration and LIVE flags remain false.
        if (OfflineAutomationRuntime.enabled(applicationContext)) {
            val schedule=WatcherRuntime.settings(applicationContext).schedule()
            val window=schedule.windowContaining(ZonedDateTime.now(schedule.zone))
            if (!schedule.enabled || window==null) return Result.success()
            val result=OfflineAutomationRuntime.run(applicationContext,window.key,window.end.toInstant().toEpochMilli())
            if(result in setOf("CONTINUE_NEXT_CYCLE","SOURCE_DEFERRED","RECONCILIATION_REQUIRED","RETRY_REQUIRED"))
                WatcherRuntime.scheduleOfflineContinuation(applicationContext)
            return Result.success()
        }
        // A journal left by a killed process becomes an INTERRUPTED record first,
        // so the planner below sees the window as interrupted, not running.
        WatcherRuntime.recoverInterruptedScan(applicationContext)
        val settings = WatcherRuntime.settings(applicationContext)
        val schedule = settings.schedule()
        val coordinator = WatcherRuntime.coordinator(applicationContext)
        val now = ZonedDateTime.now(schedule.zone)
        val stamp = now.format(STAMP)
        val conditions = WatcherRuntime.conditions(applicationContext)
        val mode = WatcherRuntime.mode(applicationContext)
        val decision = AutoScanPlanner.decide(
            now = now,
            schedule = schedule,
            conditions = conditions,
            groups = settings.groups(),
            selection = settings.selection(),
            ledger = settings.ledger(),
            scanRunning = coordinator.isRunning,
            mode = mode,
            liveAllowed = WatcherRuntime.gate(applicationContext).open,
        )
        when (decision) {
            is AutoDecision.Wait -> {
                val text = decision.blockers.joinToString(" ") { it.message }.ifBlank { "brak powodu" }
                settings.saveLastAutoCheck("$stamp — $text")
                settings.log(DiagnosticLevel.INFO, "AUTO_TICK_WAIT", "$text (Wi-Fi: ${conditions.onWifi}, ładowanie: ${conditions.charging}, bateria: ${conditions.batteryPercent ?: "?"}%)")
            }
            is AutoDecision.Start -> {
                // Mark the window first: a crash mid-scan is then seen as an
                // interruption of this window (one retry), never as a fresh window.
                settings.markWindowStarted(decision.window.key)
                when (coordinator.start(ScanTrigger.AUTOMATIC, decision.groups, WatcherRuntime.executor(applicationContext), ScanLimits.AUTOMATIC, decision.window.key)) {
                    is StartResult.Started -> {
                        settings.saveLastAutoCheck("$stamp — uruchomiono skan $mode (okno ${ScanSchedule.format(schedule.startMinutes)}–${ScanSchedule.format(schedule.endMinutes)})")
                        settings.log(DiagnosticLevel.INFO, "AUTO_SCAN_START", "$mode, grupy: ${decision.groups.size}, okno ${decision.window.key}, próba ${decision.attempt}/${WindowLedger.MAX_ATTEMPTS}")
                        try {
                            coordinator.state.first { it is ScanState.Idle }
                        } catch (stopped: CancellationException) {
                            val reason = "System zatrzymał zadanie WorkManagera (${stopReasonName()})"
                            coordinator.stop(reason)
                            settings.log(DiagnosticLevel.WARN, "AUTO_SCAN_STOPPED_BY_SYSTEM", reason)
                            throw stopped
                        }
                    }
                    StartResult.AlreadyRunning -> {
                        settings.saveLastAutoCheck("$stamp — skan już trwa")
                        settings.log(DiagnosticLevel.INFO, "AUTO_TICK_BUSY", "Skan już trwa")
                    }
                }
            }
        }
        return Result.success()
    }

    private fun stopReasonName(): String {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return "powód nieznany (Android < 12)"
        return when (val code = stopReason) {
            WorkInfo.STOP_REASON_TIMEOUT -> "STOP_REASON_TIMEOUT"
            WorkInfo.STOP_REASON_QUOTA -> "STOP_REASON_QUOTA"
            WorkInfo.STOP_REASON_CONSTRAINT_CHARGING -> "STOP_REASON_CONSTRAINT_CHARGING"
            WorkInfo.STOP_REASON_CONSTRAINT_CONNECTIVITY -> "STOP_REASON_CONSTRAINT_CONNECTIVITY"
            WorkInfo.STOP_REASON_CONSTRAINT_BATTERY_NOT_LOW -> "STOP_REASON_CONSTRAINT_BATTERY_NOT_LOW"
            WorkInfo.STOP_REASON_DEVICE_STATE -> "STOP_REASON_DEVICE_STATE"
            WorkInfo.STOP_REASON_APP_STANDBY -> "STOP_REASON_APP_STANDBY"
            WorkInfo.STOP_REASON_USER -> "STOP_REASON_USER"
            WorkInfo.STOP_REASON_SYSTEM_PROCESSING -> "STOP_REASON_SYSTEM_PROCESSING"
            WorkInfo.STOP_REASON_CANCELLED_BY_APP -> "STOP_REASON_CANCELLED_BY_APP"
            else -> "kod $code"
        }
    }

    private companion object {
        val STAMP: DateTimeFormatter = DateTimeFormatter.ofPattern("dd.MM HH:mm")
    }
}
