package pl.jakubokruszek.flipcollector.watcher.android

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.BatteryManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.workDataOf
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import pl.jakubokruszek.flipcollector.BuildConfig
import pl.jakubokruszek.flipcollector.DeviceTokenStore
import pl.jakubokruszek.flipcollector.MainActivity
import pl.jakubokruszek.flipcollector.R
import pl.jakubokruszek.flipcollector.collector.LiveCollectionGate
import pl.jakubokruszek.flipcollector.watcher.DemoScanExecutor
import pl.jakubokruszek.flipcollector.watcher.DeviceConditions
import pl.jakubokruszek.flipcollector.watcher.DiagnosticLevel
import pl.jakubokruszek.flipcollector.watcher.ScanCoordinator
import pl.jakubokruszek.flipcollector.watcher.ScanExecutor
import pl.jakubokruszek.flipcollector.watcher.ScanMode
import pl.jakubokruszek.flipcollector.watcher.ScanOutcome
import pl.jakubokruszek.flipcollector.watcher.ScanRecord
import pl.jakubokruszek.flipcollector.watcher.ScanRecovery
import pl.jakubokruszek.flipcollector.watcher.ScanSchedule
import pl.jakubokruszek.flipcollector.watcher.ScanTrigger
import java.time.Instant
import java.util.concurrent.TimeUnit

/**
 * Process-wide watcher objects. One [ScanCoordinator] per process, so the
 * screen and the periodic worker share its single-scan lock.
 */
object WatcherRuntime {
    private const val AUTO_WORK = "flip-collector-facebook-watcher-auto"
    private const val CHANNEL_ID = "facebook-watcher-scans"
    private const val NOTIFICATION_ID = 4201

    @Volatile private var coordinatorInstance: ScanCoordinator? = null

    fun settings(context: Context) = WatcherSettingsStore(context)

    fun gate(context: Context) = LiveCollectionGate(
        buildAllowsLive = BuildConfig.LIVE_COLLECTION_ENABLED,
        facebookSessionConsent = settings(context).facebookSessionConsent(),
    )

    /** DEMO until live collection is both built in and consented to. */
    fun mode(context: Context): ScanMode = if (gate(context).open) ScanMode.LIVE else ScanMode.DEMO

    /**
     * The executor for the next scan. This release has no live executor: a
     * LIVE request still gets the demo, and [mode] never returns LIVE here
     * because the build flag is false.
     */
    fun executor(context: Context): ScanExecutor {
        check(!gate(context).open) { "LIVE_EXECUTOR_NOT_ACTIVATED" }
        val settings = settings(context)
        return DemoScanExecutor(failAfterPosts = if (settings.demoSimulateError()) 7 else null)
    }

    fun groupSource(context: Context): pl.jakubokruszek.flipcollector.integration.GroupSource =
        pl.jakubokruszek.flipcollector.integration.GroupSource {
            if (!BuildConfig.ANDROID_BACKEND_INTEGRATION_ENABLED) {
                pl.jakubokruszek.flipcollector.integration.GroupFetchResult.Failure("ANDROID_INTEGRATION_DISABLED")
            } else {
                val tokens = DeviceTokenStore(context)
                val id = tokens.deviceId()
                val token = tokens.token()
                if (id == null || token == null) pl.jakubokruszek.flipcollector.integration.GroupFetchResult.Failure("NOT_PAIRED")
                else {
                    val url = pl.jakubokruszek.flipcollector.UploadRetryWorker.preferences(context).getString(pl.jakubokruszek.flipcollector.UploadRetryWorker.KEY_BASE_URL, BuildConfig.DEFAULT_FLIP_MANAGER_URL)!!
                    val client = pl.jakubokruszek.flipcollector.collector.SignedCollectorClient(
                        pl.jakubokruszek.flipcollector.collector.CollectorCredentials(url, id, token), gate(context), metadataEnabled = true)
                    pl.jakubokruszek.flipcollector.integration.AndroidGroupSource(client).fetch()
                }
            }
        }

    fun coordinator(context: Context): ScanCoordinator = coordinatorInstance ?: synchronized(this) {
        coordinatorInstance ?: run {
            val app = context.applicationContext
            ScanCoordinator(
                scope = CoroutineScope(SupervisorJob() + Dispatchers.Default),
                onFinished = { record -> onScanFinished(app, record) },
                onCheckpoint = { journal -> settings(app).saveJournal(journal) },
            ).also { coordinatorInstance = it }
        }
    }

    private fun onScanFinished(context: Context, record: ScanRecord) {
        val settings = settings(context)
        // Order matters for recovery: history first, then the window, then the journal.
        // A crash between them leaves a journal whose scan id is already in the
        // history, and recovery then only clears it.
        settings.appendHistory(record)
        record.windowKey?.let { settings.markWindowFinished(it, record.outcome) }
        settings.clearJournal()
        val level = if (record.outcome.successful) DiagnosticLevel.INFO else DiagnosticLevel.WARN
        settings.log(level, "SCAN_FINISHED", "${record.mode} ${record.trigger} ${record.outcome}: posty ${record.postsSeen}, oferty ${record.offersFound}, błędy ${record.errors}${record.stopReason?.let { ", powód: $it" } ?: ""}")
        if (settings.notifyAfterScan()) notifyScanFinished(context, record)
    }

    /**
     * Turns a journal left by a dead process into an INTERRUPTED history record
     * and marks its window INTERRUPTED (one retry allowed). Safe to call any
     * time: it does nothing while a scan runs in this process, and nothing
     * when the journal's scan is already in the history.
     */
    @Synchronized
    fun recoverInterruptedScan(context: Context): ScanRecord? {
        val app = context.applicationContext
        if (coordinator(app).isRunning) return null
        val settings = settings(app)
        val journal = settings.journal() ?: return null
        if (settings.allHistory().any { it.id == journal.scanId }) {
            settings.clearJournal()
            return null
        }
        val record = ScanRecovery.interruptedRecord(journal, Instant.now())
        settings.appendHistory(record)
        record.windowKey?.let { settings.markWindowFinished(it, ScanOutcome.INTERRUPTED) }
        settings.clearJournal()
        settings.log(DiagnosticLevel.WARN, "SCAN_RECOVERED_INTERRUPTED", "${journal.mode} ${journal.trigger}: grupy ${journal.completedGroups}/${journal.totalGroups}, ostatni zapis ${journal.lastCheckpointAt}")
        return record
    }

    /**
     * Schedules a one-off background probe ([ProbeWorker]) in [delayMinutes]
     * with the schedule's Wi-Fi and charging constraints. It records when it
     * really ran, so delays from Doze, App Standby or Android 16 job quotas can
     * be measured on the phone without adb.
     */
    fun scheduleProbe(context: Context, delayMinutes: Long) {
        val schedule = settings(context).schedule()
        val constraints = Constraints.Builder()
            .setRequiredNetworkType(if (schedule.requireWifi) NetworkType.UNMETERED else NetworkType.NOT_REQUIRED)
            .setRequiresCharging(schedule.requireCharging)
            .build()
        val request = OneTimeWorkRequestBuilder<ProbeWorker>()
            .setInitialDelay(delayMinutes, TimeUnit.MINUTES)
            .setConstraints(constraints)
            .setInputData(workDataOf(ProbeWorker.KEY_PLANNED_AT to System.currentTimeMillis() + TimeUnit.MINUTES.toMillis(delayMinutes)))
            .addTag(PROBE_TAG)
            .build()
        WorkManager.getInstance(context.applicationContext).enqueueUniqueWork(PROBE_WORK, ExistingWorkPolicy.REPLACE, request)
        settings(context).log(DiagnosticLevel.INFO, "PROBE_SCHEDULED", "za $delayMinutes min, wifi=${schedule.requireWifi} ładowanie=${schedule.requireCharging}")
    }

    const val PROBE_WORK = "flip-collector-workmanager-probe"
    const val PROBE_TAG = "flip-collector-probe"
    const val AUTO_WORK_NAME = AUTO_WORK

    fun scheduleOfflineContinuation(context: Context) {
        check(OfflineAutomationRuntime.enabled(context))
        val request=OneTimeWorkRequestBuilder<AutoScanWorker>()
            .setInitialDelay(30,TimeUnit.SECONDS)
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.UNMETERED).setRequiresCharging(true).build())
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork("flip-offline-continuation",ExistingWorkPolicy.APPEND_OR_REPLACE,request)
    }

    fun conditions(context: Context): DeviceConditions {
        val app = context.applicationContext
        val connectivity = app.getSystemService(ConnectivityManager::class.java)
        val capabilities = connectivity?.getNetworkCapabilities(connectivity.activeNetwork)
        val onWifi = capabilities?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true &&
            capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
        val battery = app.getSystemService(BatteryManager::class.java)
        val charging = battery?.isCharging == true
        val percent = battery?.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)?.takeIf { it in 0..100 }
        return DeviceConditions(onWifi = onWifi, charging = charging, paired = DeviceTokenStore(app).token() != null, batteryPercent = percent)
    }

    /**
     * Keeps the periodic tick in line with the settings: off when automation
     * is off, otherwise every 15 minutes (WorkManager's minimum) with the
     * Wi-Fi and charging requirements as system constraints, so Android does
     * not even wake the app while they are unmet.
     */
    fun applySchedule(context: Context, schedule: ScanSchedule) {
        val workManager = WorkManager.getInstance(context.applicationContext)
        if (!schedule.enabled || schedule.days.isEmpty()) {
            workManager.cancelUniqueWork(AUTO_WORK)
            return
        }
        val constraints = Constraints.Builder()
            .setRequiredNetworkType(if (schedule.requireWifi) NetworkType.UNMETERED else NetworkType.NOT_REQUIRED)
            .setRequiresCharging(schedule.requireCharging)
            .setRequiresBatteryNotLow(!schedule.requireCharging)
            .build()
        val request = PeriodicWorkRequestBuilder<AutoScanWorker>(15, TimeUnit.MINUTES)
            .setConstraints(constraints)
            .build()
        workManager.enqueueUniquePeriodicWork(AUTO_WORK, ExistingPeriodicWorkPolicy.UPDATE, request)
    }

    fun canNotify(context: Context): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    private fun notifyScanFinished(context: Context, record: ScanRecord) {
        if (!canNotify(context)) return
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        manager.createNotificationChannel(NotificationChannel(CHANNEL_ID, "Skany Facebook Watchera", NotificationManager.IMPORTANCE_LOW))
        val open = PendingIntent.getActivity(
            context, 0,
            Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val prefix = if (record.mode == ScanMode.DEMO) "DEMO · " else ""
        val who = if (record.trigger == ScanTrigger.AUTOMATIC) "Skan automatyczny" else "Skan ręczny"
        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_watcher)
            .setContentTitle("$prefix$who: ${record.outcome.label}")
            .setContentText("Oferty: ${record.offersFound} · posty: ${record.postsSeen} · błędy: ${record.errors}")
            .setContentIntent(open)
            .setAutoCancel(true)
            .setOnlyAlertOnce(true)
            .build()
        try {
            NotificationManagerCompat.from(context).notify(NOTIFICATION_ID, notification)
        } catch (_: SecurityException) {
            // Permission revoked between the check and the call.
        }
    }
}
