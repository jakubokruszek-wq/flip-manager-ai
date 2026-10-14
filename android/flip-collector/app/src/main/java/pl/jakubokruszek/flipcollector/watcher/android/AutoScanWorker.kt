package pl.jakubokruszek.flipcollector.watcher.android

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import kotlinx.coroutines.flow.first
import pl.jakubokruszek.flipcollector.watcher.AutoDecision
import pl.jakubokruszek.flipcollector.watcher.AutoScanPlanner
import pl.jakubokruszek.flipcollector.watcher.ScanSchedule
import pl.jakubokruszek.flipcollector.watcher.ScanState
import pl.jakubokruszek.flipcollector.watcher.ScanTrigger
import pl.jakubokruszek.flipcollector.watcher.StartResult
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter

/** Periodic tick: asks [AutoScanPlanner] whether a scan is due and, if so, runs one and waits for it. */
class AutoScanWorker(appContext: Context, params: WorkerParameters) : CoroutineWorker(appContext, params) {
    override suspend fun doWork(): Result {
        val settings = WatcherRuntime.settings(applicationContext)
        val schedule = settings.schedule()
        val coordinator = WatcherRuntime.coordinator(applicationContext)
        val now = ZonedDateTime.now(schedule.zone)
        val decision = AutoScanPlanner.decide(
            now = now,
            schedule = schedule,
            conditions = WatcherRuntime.conditions(applicationContext),
            groups = settings.groups(),
            selection = settings.selection(),
            lastStartedWindowKey = settings.lastStartedWindowKey(),
            scanRunning = coordinator.isRunning,
        )
        val stamp = now.format(STAMP)
        when (decision) {
            is AutoDecision.Wait -> settings.saveLastAutoCheck(
                if (decision.blockers.isEmpty()) "$stamp — okno już obsłużone" else "$stamp — ${decision.blockers.joinToString(" ") { it.message }}",
            )
            is AutoDecision.Start -> {
                // Store the window first: a crash mid-scan must not start it again.
                settings.saveLastStartedWindowKey(decision.window.key)
                when (coordinator.start(ScanTrigger.AUTOMATIC, decision.groups, decision.window.key)) {
                    is StartResult.Started -> {
                        settings.saveLastAutoCheck("$stamp — uruchomiono skan (okno ${ScanSchedule.format(schedule.startMinutes)}–${ScanSchedule.format(schedule.endMinutes)})")
                        coordinator.state.first { it is ScanState.Idle }
                    }
                    StartResult.AlreadyRunning -> settings.saveLastAutoCheck("$stamp — skan już trwa")
                }
            }
        }
        return Result.success()
    }

    private companion object {
        val STAMP: DateTimeFormatter = DateTimeFormatter.ofPattern("dd.MM HH:mm")
    }
}
