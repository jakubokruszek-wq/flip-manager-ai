package pl.jakubokruszek.flipcollector.watcher.android

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.BatteryManager
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import pl.jakubokruszek.flipcollector.BuildConfig
import pl.jakubokruszek.flipcollector.DeviceTokenStore
import pl.jakubokruszek.flipcollector.collector.LiveCollectionGate
import pl.jakubokruszek.flipcollector.watcher.DeviceConditions
import pl.jakubokruszek.flipcollector.watcher.DryRunScanExecutor
import pl.jakubokruszek.flipcollector.watcher.ScanCoordinator
import pl.jakubokruszek.flipcollector.watcher.ScanSchedule
import java.util.concurrent.TimeUnit

/**
 * Process-wide watcher objects. One [ScanCoordinator] per process, so the
 * screen and the periodic worker share its single-scan lock.
 */
object WatcherRuntime {
    private const val AUTO_WORK = "flip-collector-facebook-watcher-auto"

    @Volatile private var coordinatorInstance: ScanCoordinator? = null

    fun settings(context: Context) = WatcherSettingsStore(context)

    fun gate(context: Context) = LiveCollectionGate(
        buildAllowsLive = BuildConfig.LIVE_COLLECTION_ENABLED,
        facebookSessionConsent = settings(context).facebookSessionConsent(),
    )

    fun coordinator(context: Context): ScanCoordinator = coordinatorInstance ?: synchronized(this) {
        coordinatorInstance ?: run {
            val app = context.applicationContext
            // This release ships only the dry-run executor: no Facebook page
            // and no job-queue call is made, whatever the settings say.
            ScanCoordinator(
                scope = CoroutineScope(SupervisorJob() + Dispatchers.Default),
                executor = DryRunScanExecutor(pause = { kotlinx.coroutines.delay(400) }),
                onFinished = { record -> settings(app).appendHistory(record) },
            ).also { coordinatorInstance = it }
        }
    }

    fun conditions(context: Context): DeviceConditions {
        val app = context.applicationContext
        val connectivity = app.getSystemService(ConnectivityManager::class.java)
        val capabilities = connectivity?.getNetworkCapabilities(connectivity.activeNetwork)
        val onWifi = capabilities?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true &&
            capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
        val charging = app.getSystemService(BatteryManager::class.java)?.isCharging == true
        val tokens = DeviceTokenStore(app)
        return DeviceConditions(onWifi = onWifi, charging = charging, paired = tokens.token() != null)
    }

    /**
     * Keeps the periodic tick in line with the settings: off when automation
     * is off, otherwise every 15 minutes (WorkManager's minimum) with the
     * Wi-Fi and charging requirements as system constraints, so Android
     * does not even wake the app while they are unmet.
     */
    fun applySchedule(context: Context, schedule: ScanSchedule) {
        val workManager = WorkManager.getInstance(context.applicationContext)
        if (!schedule.enabled || schedule.days.isEmpty()) {
            workManager.cancelUniqueWork(AUTO_WORK)
            return
        }
        val constraints = Constraints.Builder()
            .setRequiredNetworkType(if (schedule.requireWifi) NetworkType.UNMETERED else NetworkType.CONNECTED)
            .setRequiresCharging(schedule.requireCharging)
            .build()
        val request = PeriodicWorkRequestBuilder<AutoScanWorker>(15, TimeUnit.MINUTES)
            .setConstraints(constraints)
            .build()
        workManager.enqueueUniquePeriodicWork(AUTO_WORK, ExistingPeriodicWorkPolicy.UPDATE, request)
    }
}
