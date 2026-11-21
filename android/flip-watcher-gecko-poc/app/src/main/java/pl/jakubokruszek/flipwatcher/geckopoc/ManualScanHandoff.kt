package pl.jakubokruszek.flipwatcher.geckopoc

import android.app.Activity
import android.app.ActivityManager
import android.app.Application
import android.content.Context
import android.content.SharedPreferences
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.Process

/** Only newly requested manual cycles wait for every app window to leave STARTED. */
internal object ManualScanHandoff {
    const val KEY = "manual_background_request"
    private const val DIAGNOSTICS="watcher-manual-handoff-diagnostics-v1"
    @Volatile private var backgroundSince=android.os.SystemClock.elapsedRealtime()
    fun ready(visible:Boolean=RenderComparisonVisibility.hasStartedActivity, now:Long=android.os.SystemClock.elapsedRealtime(), since:Long=backgroundSince)=
        !visible && since!=Long.MAX_VALUE && now-since>=1_500L
    fun waiting(context: Context, request: String?, visible: Boolean = RenderComparisonVisibility.hasStartedActivity): Boolean =
        request != null && visible && WatcherAutomation.preferences(context).getString(KEY, null) == request

    private fun processName(context:Context):String? = runCatching {
        if(Build.VERSION.SDK_INT>=28)Application.getProcessName()
        else context.getSystemService(ActivityManager::class.java)?.runningAppProcesses?.firstOrNull{it.pid==Process.myPid()}?.processName
    }.getOrNull()
    private fun failureType(error:Exception)=when(error){
        is SecurityException->2
        is ClassCastException->3
        is IllegalStateException->1
        is IllegalArgumentException->4
        else->5
    }
    private fun rememberFailure(context:Context,error:Exception){
        // A second storage failure must not escape the lifecycle callback either.
        runCatching {
            val prefs=context.getSharedPreferences(DIAGNOSTICS,Context.MODE_PRIVATE)
            val count=(prefs.getInt("failureCount",0).coerceIn(0,99_999_999)+1)
            prefs.edit().putInt("lastFailureType",failureType(error)).putInt("failureCount",count).commit()
        }
    }
    fun failureCounts(context:Context):Map<String,Int> = runCatching {
        val prefs=context.getSharedPreferences(DIAGNOSTICS,Context.MODE_PRIVATE)
        mapOf("manualKickFailureType" to prefs.getInt("lastFailureType",0).coerceIn(0,5),
            "manualKickFailureCount" to prefs.getInt("failureCount",0).coerceIn(0,100_000_000))
    }.getOrDefault(emptyMap())

    /** Application.onCreate also runs in Gecko child processes. Verify identity
     * BEFORE preferences, Handler callbacks or WorkManager can be initialized. */
    fun install(application: Application,
                currentProcess:()->String?={processName(application)},
                register:(Application.ActivityLifecycleCallbacks)->Unit={application.registerActivityLifecycleCallbacks(it)},
                post:((()->Unit)->Unit)?=null,
                preferences:()->SharedPreferences={WatcherAutomation.preferences(application)},
                enqueue:()->Unit={WatcherAutomation.onBackground(application)},
                visible:()->Boolean={RenderComparisonVisibility.hasStartedActivity},
                failure:(Exception)->Unit={rememberFailure(application,it)}):Boolean {
        val main=runCatching{application.applicationInfo.processName}.getOrNull()
        val actual=runCatching{currentProcess()}.getOrNull()
        if(main.isNullOrBlank()||actual.isNullOrBlank()||actual!=main)return false
        fun failed(error:Exception){runCatching{failure(error)}}
        return try {
            val dispatch=post?:Handler(Looper.getMainLooper()).let{handler->{action:()->Unit->
                check(handler.post{action()}){"HANDOFF_POST_REJECTED"}
            }}
            fun kick() {
                try {
                    // Run after all lifecycle observers, including the window tracker.
                    dispatch {
                        try {
                            val prefs=preferences()
                            val request=prefs.getString("requested_scan",null)
                            val hasWindow=visible()
                            if(!hasWindow&&backgroundSince==Long.MAX_VALUE)backgroundSince=android.os.SystemClock.elapsedRealtime()
                            if(request!=null&&prefs.getString(KEY,null)==request&&!hasWindow)enqueue()
                        }catch(error:Exception){failed(error)}
                    }
                }catch(error:Exception){failed(error)}
            }
            register(object:Application.ActivityLifecycleCallbacks {
                override fun onActivityStopped(activity:Activity)=kick()
                override fun onActivityCreated(activity:Activity,state:Bundle?){}
                override fun onActivityStarted(activity:Activity){backgroundSince=Long.MAX_VALUE}
                override fun onActivityResumed(activity:Activity){}
                override fun onActivityPaused(activity:Activity){}
                override fun onActivitySaveInstanceState(activity:Activity,state:Bundle){}
                override fun onActivityDestroyed(activity:Activity){}
            })
            // A restored pending request may start in the MAIN process without an Activity.
            kick()
            true
        }catch(error:Exception){failed(error);false}
    }
}
