package pl.jakubokruszek.flipwatcher.geckopoc

import kotlinx.coroutines.delay
import org.mozilla.geckoview.AllowOrDeny
import org.mozilla.geckoview.GeckoResult
import org.mozilla.geckoview.GeckoSession

/** Release the feed DOM while detail workers run. No state is persisted or kill ignored. */
internal class ReviewOriginalParking(private val session:GeckoSession,private val channel:CollectorChannel,private val target:String){
    private val navigation=session.navigationDelegate
    private val progress=session.progressDelegate
    private var touched=false
    suspend fun park(alive:()->Boolean){
        check(alive()&&channel.isConnected&&channel.connectedUrl==target)
        var blank=false;var finished=false;var foreign=false
        touched=true
        session.navigationDelegate=object:GeckoSession.NavigationDelegate{
            override fun onLoadRequest(s:GeckoSession,q:GeckoSession.NavigationDelegate.LoadRequest):GeckoResult<AllowOrDeny>{
                val allowed=q.uri=="about:blank"&&q.target!=GeckoSession.NavigationDelegate.TARGET_WINDOW_NEW&&!q.hasUserGesture
                if(!allowed)foreign=true
                return GeckoResult.fromValue(if(allowed)AllowOrDeny.ALLOW else AllowOrDeny.DENY)
            }
            override fun onLocationChange(s:GeckoSession,u:String?,p:MutableList<GeckoSession.PermissionDelegate.ContentPermission>,gesture:Boolean){if(u=="about:blank"&&!gesture)blank=true else foreign=true}
        }
        session.progressDelegate=object:GeckoSession.ProgressDelegate{override fun onPageStop(s:GeckoSession,success:Boolean){if(blank&&success)finished=true}}
        // ContentDelegate remains installed: a genuine original engine loss still stops.
        session.setFocused(false);session.setActive(false);session.loadUri("about:blank")
        val deadline=android.os.SystemClock.elapsedRealtime()+5000
        while(alive()&&!foreign&&(!blank||!finished||channel.isConnected)&&android.os.SystemClock.elapsedRealtime()<deadline)delay(50)
        check(alive()&&!foreign&&blank&&finished&&!channel.isConnected){"ORIGINAL_PARK_FAILED"}
        session.purgeHistory()
    }
    suspend fun restore(alive:()->Boolean){
        if(!touched)return
        session.navigationDelegate=navigation;session.progressDelegate=progress
        if(!alive())return
        val generation=channel.connectionGeneration
        session.loadUri(target)
        val deadline=android.os.SystemClock.elapsedRealtime()+10000
        while(alive()&&android.os.SystemClock.elapsedRealtime()<deadline){
            if(channel.isConnected&&channel.connectionGeneration>generation&&channel.connectedUrl==target){
                val probe=channel.probe(1000)
                if(probe?.readyState in setOf("interactive","complete"))return
            }
            delay(50)
        }
        check(!alive()){ "ORIGINAL_RESTORE_FAILED" }
    }
}
