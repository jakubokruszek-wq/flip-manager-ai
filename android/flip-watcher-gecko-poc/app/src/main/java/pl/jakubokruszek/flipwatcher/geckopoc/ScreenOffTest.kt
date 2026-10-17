package pl.jakubokruszek.flipwatcher.geckopoc

import android.app.AlarmManager
import android.app.KeyguardManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.os.BatteryManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.os.SystemClock
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import java.time.Instant

/**
 * Stage C, LOCAL HTML ONLY: does a GeckoSession load and read a lazily
 * loading page while the screen is off and the phone locked? The test
 * schedules one alarm; the alarm starts a short foreground service that scans
 * the local lazy-feed fixture and records the device state at start and end.
 * No Facebook page is ever opened by this path.
 *
 * Nothing here bypasses Android limits: an exact alarm needs the user-granted
 * "Alarms & reminders" access; without it the alarm is inexact, and a
 * foreground-service start that Android refuses is recorded as the result.
 */
object ScreenOffTest {
    const val CHANNEL_ID = "gecko_poc_test"
    const val RESULT_NOTIFICATION_ID = 2
    private const val RUNNING_NOTIFICATION_ID = 1
    private const val REQUEST_CODE = 41

    data class Scheduled(val exact: Boolean, val atElapsedMs: Long)

    fun schedule(context: Context, delayMs: Long): Scheduled {
        val alarms = context.getSystemService(AlarmManager::class.java)
        val trigger = SystemClock.elapsedRealtime() + delayMs
        val operation = PendingIntent.getBroadcast(
            context, REQUEST_CODE, Intent(context, ScreenOffAlarmReceiver::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val exact = Build.VERSION.SDK_INT < Build.VERSION_CODES.S || alarms.canScheduleExactAlarms()
        if (exact) alarms.setExactAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, trigger, operation)
        else alarms.setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, trigger, operation)
        return Scheduled(exact, trigger)
    }

    fun ensureChannel(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java)
        if (manager.getNotificationChannel(CHANNEL_ID) == null) {
            manager.createNotificationChannel(NotificationChannel(CHANNEL_ID, "Test Gecko POC", NotificationManager.IMPORTANCE_DEFAULT))
        }
    }

    fun notification(context: Context, title: String, text: String): Notification {
        ensureChannel(context)
        val open = PendingIntent.getActivity(context, 0, Intent(context, PocActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        return Notification.Builder(context, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_sys_download_done)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(Notification.BigTextStyle().bigText(text))
            .setContentIntent(open)
            .build()
    }

    /** Screen, lock, charging, battery temperature and Doze, so each result says under what conditions it ran. */
    fun deviceState(context: Context): Map<String, String> {
        val power = context.getSystemService(PowerManager::class.java)
        val keyguard = context.getSystemService(KeyguardManager::class.java)
        val battery = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        val plugged = (battery?.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) ?: 0) != 0
        val tempTenths = battery?.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, -1) ?: -1
        return mapOf(
            "screenOn" to power.isInteractive.toString(),
            "locked" to keyguard.isDeviceLocked.toString(),
            "doze" to power.isDeviceIdleMode.toString(),
            "charging" to plugged.toString(),
            "batteryTempC" to if (tempTenths >= 0) "%.1f".format(tempTenths / 10.0) else "?",
            "ignoringBatteryOptimizations" to power.isIgnoringBatteryOptimizations(context.packageName).toString(),
        )
    }

    fun store(context: Context) = PocResultStore(context.filesDir.resolve(PocResultStore.DIRECTORY))

    internal fun runningNotificationId() = RUNNING_NOTIFICATION_ID
}

class ScreenOffAlarmReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val started = Instant.now().toString()
        try {
            // Exact alarms are one of Android's documented exemptions for starting a foreground service from the background.
            context.startForegroundService(Intent(context, ScreenOffTestService::class.java).putExtra(ScreenOffTestService.EXTRA_TRIGGER, "alarm"))
        } catch (error: Exception) {
            // Typically ForegroundServiceStartNotAllowedException (inexact alarm, app restricted): that IS the test result.
            val state = ScreenOffTest.deviceState(context)
            ScreenOffTest.store(context).append(StoredRun("SCREEN_OFF_TEST", started, Instant.now().toString(), "FGS_START_REFUSED", emptyList(), emptyList(), 0, state + ("error" to error.javaClass.simpleName)))
            context.getSystemService(NotificationManager::class.java)
                .notify(ScreenOffTest.RESULT_NOTIFICATION_ID, ScreenOffTest.notification(context, "Test ekranu: Android odmówił startu", error.javaClass.simpleName))
        }
    }
}

/** Short-lived (≤ 3 min) foreground service that runs the local fixture scan once and stops. */
class ScreenOffTestService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var wakeLock: PowerManager.WakeLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val notification = ScreenOffTest.notification(this, "Gecko POC: test lokalnego HTML", "Trwa odczyt strony testowej (bez Facebooka)…")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) startForeground(ScreenOffTest.runningNotificationId(), notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        else startForeground(ScreenOffTest.runningNotificationId(), notification)
        wakeLock = getSystemService(PowerManager::class.java)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "flipwatcher:geckopoc-test")
            .apply { acquire(MAX_RUN_MS) }
        val trigger = intent?.getStringExtra(EXTRA_TRIGGER) ?: "manual"
        scope.launch {
            // Both render modes back to back, so one test answers both questions:
            // does a session with no surface keep loading, and does an off-screen surface help?
            val lines = mutableListOf<String>()
            for (mode in SurfaceMode.entries) {
                val started = Instant.now().toString()
                val before = ScreenOffTest.deviceState(this@ScreenOffTestService)
                val result = runCatching {
                    HeadlessFixtureScan(this@ScreenOffTestService).run("/groups/$FIXTURE_GROUP_ID/", "lazy-feed", scrolls = 4, scrollPauseMs = 1500, surface = mode)
                }
                val after = ScreenOffTest.deviceState(this@ScreenOffTestService)
                val report = result.getOrNull()?.report ?: ScanProtocol.failure(ScanStatus.COLLECTOR_ERROR, result.exceptionOrNull()?.javaClass?.simpleName)
                val notes = before.mapKeys { "start.${it.key}" } + after.mapKeys { "end.${it.key}" } + mapOf(
                    "trigger" to trigger,
                    "surface" to mode.name,
                    "scrolls" to report.scrolls.toString(),
                    "expectedIfLazyLoadWorks" to "≥10 (5 bez doładowania)",
                ) + (report.error?.let { mapOf("error" to it) } ?: emptyMap())
                ScreenOffTest.store(this@ScreenOffTestService).append(PocResultStore.fromReport("SCREEN_OFF_TEST", started, Instant.now().toString(), report, notes))
                lines += "${mode.name}: ${report.status}, postów ${report.posts.size}"
                if (mode == SurfaceMode.NONE) lines += "Start: ekran ${if (before["screenOn"] == "true") "włączony" else "wygaszony"}, blokada ${before["locked"]}, Doze ${before["doze"]}."
            }
            getSystemService(NotificationManager::class.java)
                .notify(ScreenOffTest.RESULT_NOTIFICATION_ID, ScreenOffTest.notification(this@ScreenOffTestService, "Test ekranu: wynik", lines.joinToString("\n")))
            stopSelf()
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        scope.cancel()
        wakeLock?.let { if (it.isHeld) it.release() }
        super.onDestroy()
    }

    companion object {
        const val EXTRA_TRIGGER = "trigger"
        private const val MAX_RUN_MS = 3 * 60 * 1000L
    }
}
