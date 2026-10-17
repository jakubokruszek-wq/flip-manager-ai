package pl.jakubokruszek.flipcollector.watcher.android

import android.content.Context
import android.os.PowerManager
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import pl.jakubokruszek.flipcollector.watcher.DiagnosticLevel

/**
 * One-off background probe scheduled from Historia → "Test zadania w tle".
 * It only measures: how late Android ran it compared with the planned time,
 * which run attempt it is, whether the screen was on and the battery state.
 * No scan, no network. The result goes to the diagnostic log.
 */
class ProbeWorker(appContext: Context, params: WorkerParameters) : CoroutineWorker(appContext, params) {
    override suspend fun doWork(): Result {
        val planned = inputData.getLong(KEY_PLANNED_AT, 0L)
        val delaySeconds = if (planned > 0) (System.currentTimeMillis() - planned) / 1000 else -1
        val interactive = applicationContext.getSystemService(PowerManager::class.java)?.isInteractive
        val idle = applicationContext.getSystemService(PowerManager::class.java)?.isDeviceIdleMode
        val conditions = WatcherRuntime.conditions(applicationContext)
        WatcherRuntime.settings(applicationContext).log(
            DiagnosticLevel.INFO,
            "PROBE_RAN",
            "opóźnienie ${if (delaySeconds >= 0) "$delaySeconds s" else "?"} względem planu, próba ${runAttemptCount + 1}, " +
                "ekran włączony=${interactive ?: "?"}, doze=${idle ?: "?"}, ładowanie=${conditions.charging}, bateria=${conditions.batteryPercent ?: "?"}%, wifi=${conditions.onWifi}",
        )
        return Result.success()
    }

    companion object {
        const val KEY_PLANNED_AT = "planned_at"
    }
}
