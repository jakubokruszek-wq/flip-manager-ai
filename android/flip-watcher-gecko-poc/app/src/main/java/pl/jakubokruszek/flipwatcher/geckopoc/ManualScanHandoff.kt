package pl.jakubokruszek.flipwatcher.geckopoc

import android.app.Activity
import android.app.Application
import android.content.Context
import android.os.Bundle
import android.os.Handler
import android.os.Looper

/** Only newly requested manual cycles wait for every app window to leave STARTED. */
internal object ManualScanHandoff {
    const val KEY = "manual_background_request"
    @Volatile private var backgroundSince=android.os.SystemClock.elapsedRealtime()
    fun ready(visible:Boolean=RenderComparisonVisibility.hasStartedActivity, now:Long=android.os.SystemClock.elapsedRealtime(), since:Long=backgroundSince)=
        !visible && since!=Long.MAX_VALUE && now-since>=1_500L
    fun waiting(context: Context, request: String?, visible: Boolean = RenderComparisonVisibility.hasStartedActivity): Boolean =
        request != null && visible && WatcherAutomation.preferences(context).getString(KEY, null) == request

    fun install(application: Application) {
        val handler = Handler(Looper.getMainLooper())
        fun kick() {
            // Run after all lifecycle observers, including the window tracker.
            handler.post {
                val prefs = WatcherAutomation.preferences(application)
                val request = prefs.getString("requested_scan", null)
                if (!RenderComparisonVisibility.hasStartedActivity && backgroundSince==Long.MAX_VALUE)
                    backgroundSince=android.os.SystemClock.elapsedRealtime()
                if (request != null && prefs.getString(KEY, null) == request && !RenderComparisonVisibility.hasStartedActivity)
                    WatcherAutomation.onBackground(application)
            }
        }
        application.registerActivityLifecycleCallbacks(object : Application.ActivityLifecycleCallbacks {
            override fun onActivityStopped(activity: Activity) = kick()
            override fun onActivityCreated(activity: Activity, state: Bundle?) {}
            override fun onActivityStarted(activity: Activity) { backgroundSince=Long.MAX_VALUE }
            override fun onActivityResumed(activity: Activity) {}
            override fun onActivityPaused(activity: Activity) {}
            override fun onActivitySaveInstanceState(activity: Activity, state: Bundle) {}
            override fun onActivityDestroyed(activity: Activity) {}
        })
        // A restored pending request may start in a process with no Activity at all.
        kick()
    }
}
