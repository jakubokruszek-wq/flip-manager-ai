package pl.jakubokruszek.flipwatcher.geckopoc

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.mozilla.geckoview.GeckoResult
import org.mozilla.geckoview.GeckoSession
import java.util.UUID

/** Only the user's joined-group directory. No post grants, images, OCR or membership changes. */
class JoinedGroupsScan(private val context:Context){
    suspend fun run(alive:()->Boolean,progress:(String)->Unit={}):JoinedGroupsResult=read(JoinedGroupsProtocol.URL,false,alive,progress)
    internal suspend fun runFixture(target:String,alive:()->Boolean)=read(target,true,alive,{})
    private suspend fun read(target:String,fixture:Boolean,alive:()->Boolean,progress:(String)->Unit)=withContext(Dispatchers.Main){withTimeout(120_000){
        require(JoinedGroupsProtocol.page(target,if(fixture)target else null))
        val browser=GeckoSession();val channel=CollectorChannel(browser,fixtureMode=fixture)
        var surface:BackgroundViewport?=null;var current:String?=null;var ready=false;var reading=false;var stop:String?=null
        fun live()=alive()&&stop==null
        fun reason(url:String):String?{val path=runCatching{java.net.URI(url).path}.getOrDefault("")
            if(path.startsWith("/login")||path.startsWith("/recover"))return "LOGIN_REQUIRED"
            if(path.contains("checkpoint",true))return "CHECKPOINT"
            if(path.contains("captcha",true))return "CAPTCHA"
            return if(JoinedGroupsProtocol.page(url,if(fixture)target else null))null else "DISCOVERY_CONTEXT_REJECTED"
        }
        browser.navigationDelegate=object:GeckoSession.NavigationDelegate{
            override fun onLoadRequest(s:GeckoSession,r:GeckoSession.NavigationDelegate.LoadRequest):GeckoResult<org.mozilla.geckoview.AllowOrDeny>?{
                if(current==null&&r.uri=="about:blank")return GeckoResult.fromValue(org.mozilla.geckoview.AllowOrDeny.ALLOW)
                val error=reason(r.uri);val allowed=live()&&!reading&&!r.hasUserGesture&&r.target!=GeckoSession.NavigationDelegate.TARGET_WINDOW_NEW&&error==null
                if(!allowed)stop=error?:"DISCOVERY_CONTEXT_REJECTED"
                return GeckoResult.fromValue(if(allowed)org.mozilla.geckoview.AllowOrDeny.ALLOW else org.mozilla.geckoview.AllowOrDeny.DENY)
            }
            override fun onLocationChange(s:GeckoSession,u:String?,permissions:MutableList<GeckoSession.PermissionDelegate.ContentPermission>,gesture:Boolean){
                if(current==null&&(u==null||u=="about:blank"))return
                if(u==null||reason(u)!=null||reading&&u!=current)stop=if(u==null)"DISCOVERY_CONTEXT_REJECTED"else reason(u)?:"DISCOVERY_CONTEXT_REJECTED"
                current=u
            }
            override fun onLoadError(s:GeckoSession,u:String?,e:org.mozilla.geckoview.WebRequestError):GeckoResult<String>?{stop="DISCOVERY_LOAD_ERROR";return null}
        }
        browser.progressDelegate=object:GeckoSession.ProgressDelegate{
            override fun onPageStart(s:GeckoSession,u:String){ready=false}
            override fun onPageStop(s:GeckoSession,success:Boolean){ready=success;if(!success)stop="DISCOVERY_LOAD_ERROR"}
        }
        try{
            progress("Ładowanie Twoich grup na Facebooku…")
            channel.attach(GeckoHost.collectorExtension(context));DesktopSessionPreview.applyDesktop(browser)
            browser.open(GeckoHost.runtime(context));surface=BackgroundViewport(browser);browser.setActive(true);browser.setFocused(true);browser.loadUri(target)
            val until=android.os.SystemClock.elapsedRealtime()+if(fixture)60_000 else 35_000
            while(live()&&android.os.SystemClock.elapsedRealtime()<until){
                if(ready&&current!=null&&channel.isConnected&&channel.connectedUrl==current){val probe=channel.probe(1000);if((probe?.passwordInputs?:0)>0){stop="LOGIN_REQUIRED";break};if(probe?.readyState in setOf("interactive","complete"))break}
                delay(200)
            }
            check(live()&&ready&&current!=null&&channel.isConnected&&channel.connectedUrl==current){stop?:"DISCOVERY_NOT_READY"}
            reading=true;val expected=checkNotNull(current);val generation=channel.connectionGeneration
            progress("Odczytywanie i przewijanie listy grup…")
            val result=channel.joinedGroups(UUID.randomUUID().toString(),expected)?:error("DISCOVERY_PROTOCOL")
            check(live()&&current==expected&&channel.connectedUrl==expected&&channel.connectionGeneration==generation){stop?:"DISCOVERY_CONTEXT_REJECTED"}
            result
        }finally{runCatching{channel.close()};runCatching{surface?.close()};runCatching{browser.stop()};runCatching{browser.setActive(false)};runCatching{browser.close()}}
    }}
}
