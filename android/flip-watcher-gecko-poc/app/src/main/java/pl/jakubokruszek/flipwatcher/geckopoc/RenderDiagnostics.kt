package pl.jakubokruszek.flipwatcher.geckopoc

import android.app.ActivityManager
import android.content.Context
import android.os.Build
import android.os.Debug
import android.os.SystemClock
import org.mozilla.geckoview.GeckoSession

/** Explicit, time-limited observation only. No page text, URLs, images, cookies or keys. */
internal object RenderDiagnostics {
    private const val KEY="render_observe_until"
    fun enabled(context:Context)=RenderObservationPolicy.active(WatcherAutomation.preferences(context).getLong(KEY,0),System.currentTimeMillis())
    fun set(context:Context,on:Boolean){check(WatcherAutomation.preferences(context).edit().putLong(KEY,if(on)System.currentTimeMillis()+RenderObservationPolicy.DURATION else 0).commit())}
    fun begin(context:Context,prefix:String):RenderObservation?=if(enabled(context))RenderObservation(prefix){SystemClock.elapsedRealtime()}else null
    fun attach(browser:GeckoSession,observation:RenderObservation?){
        if(observation==null)return
        browser.contentDelegate=object:GeckoSession.ContentDelegate {
            override fun onFirstComposite(session:GeckoSession){observation.composite()}
            override fun onFirstContentfulPaint(session:GeckoSession){observation.paint()}
            override fun onCrash(session:GeckoSession){observation.crash()}
            override fun onKill(session:GeckoSession){observation.kill()}
        }
    }
    fun failure(context:Context,prefix:String,e:Exception,observation:RenderObservation?,surface:BackgroundViewport?,resets:Int):Exception {
        // Preserve cancellation and all non-code exceptions exactly. Disabled mode
        // returns the original exception and installs no delegates or counters.
        if(!enabled(context)||observation==null||e is kotlinx.coroutines.CancellationException||e.message?.matches(Regex("[A-Z0-9_]{1,60}"))!=true)return e
        val p=prefix.lowercase();val stats=observation.snapshot().toMutableMap()
        stats[p+"RenderedFrames"]=surface?.renderedFrames?:0
        stats[p+"SurfaceResets"]=resets
        stats[p+"SurfaceValid"]=if(surface?.surfaceValid==true)1 else 0
        stats["renderDiagEnabled"]=1;stats["renderSdk"]=Build.VERSION.SDK_INT
        runCatching {
            val memory=ActivityManager.MemoryInfo();context.getSystemService(ActivityManager::class.java).getMemoryInfo(memory)
            stats["renderLowMemory"]=if(memory.lowMemory)1 else 0
            stats["renderAvailableRamMb"]=(memory.availMem/1048576).coerceIn(0,100_000_000).toInt()
            stats["renderPssKb"]=Debug.getPss().coerceIn(0,100_000_000).toInt()
            val runtime=Runtime.getRuntime();stats["renderHeapMb"]=((runtime.totalMemory()-runtime.freeMemory())/1048576).coerceIn(0,100_000_000).toInt()
        }
        return RenderObservationFailure(checkNotNull(e.message),stats.toMap(),e)
    }
}
