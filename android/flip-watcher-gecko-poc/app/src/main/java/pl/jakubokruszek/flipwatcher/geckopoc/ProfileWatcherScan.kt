package pl.jakubokruszek.flipwatcher.geckopoc

import android.content.Context
import android.graphics.Bitmap
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.coroutines.withTimeout
import org.mozilla.geckoview.GeckoResult
import org.mozilla.geckoview.GeckoSession
import java.net.URI
import java.util.UUID

/** Independent PROFILE reader. It cannot arm group-network grants or infer owner from a name. */
class ProfileWatcherScan(private val context:Context){
    suspend fun run(source:WatcherGroup,alive:()->Boolean,progress:(String)->Unit={}):SavedResult=BackgroundLoadRetry.run("PROFILE",alive,progress){runTarget(source,source.url,false,alive,progress)}
    internal suspend fun runFixture(source:WatcherGroup,target:String,forceSurfaceRefresh:Boolean=false,alive:()->Boolean):SavedResult{require(URI(target).host=="127.0.0.1");return runTarget(source,target,true,alive,forceSurfaceRefresh=forceSurfaceRefresh)}
    private suspend fun runTarget(source:WatcherGroup,target:String,fixture:Boolean,alive:()->Boolean,progress:(String)->Unit={},forceSurfaceRefresh:Boolean=false):SavedResult=withContext(Dispatchers.Main){
        require(source.type=="PROFILE")
        withTimeout(if(fixture)300_000 else 180_000){
            val browser=GeckoSession();val channel=CollectorChannel(browser,fixtureMode=fixture);val images=DesktopThumbnails(50,profile=true)
            var surface:BackgroundViewport?=null;var current:String?=null;var reading=false;val load=BackgroundDocumentLoad("PROFILE")
            fun live()=alive()&&load.reason==null
            fun rejection(raw:String):String?{
                val path=runCatching{URI(raw).path}.getOrDefault("")
                if(path.contains("checkpoint",true))return "CHECKPOINT"
                if(path.contains("captcha",true))return "CAPTCHA"
                if(path.startsWith("/login")||path.startsWith("/recover"))return "LOGIN_REQUIRED"
                return if(ProfileIdentity.candidate(raw,source,if(fixture)target else null))null else "PROFILE_CONTEXT_REJECTED"
            }
            browser.navigationDelegate=object:GeckoSession.NavigationDelegate{
                override fun onLoadRequest(s:GeckoSession,r:GeckoSession.NavigationDelegate.LoadRequest):GeckoResult<org.mozilla.geckoview.AllowOrDeny>?{
                    if(current==null&&r.uri=="about:blank")return GeckoResult.fromValue(org.mozilla.geckoview.AllowOrDeny.ALLOW)
                    val rejected=rejection(r.uri)
                    val allowed=live()&&!reading&&!r.hasUserGesture&&r.target!=GeckoSession.NavigationDelegate.TARGET_WINDOW_NEW&&rejected==null
                    if(!allowed)load.reject(rejected?:"PROFILE_CONTEXT_REJECTED")
                    return GeckoResult.fromValue(if(allowed)org.mozilla.geckoview.AllowOrDeny.ALLOW else org.mozilla.geckoview.AllowOrDeny.DENY)
                }
                override fun onLocationChange(s:GeckoSession,u:String?,permissions:MutableList<GeckoSession.PermissionDelegate.ContentPermission>,gesture:Boolean){
                    if(current==null&&(u==null||u=="about:blank"))return
                    if(u==null||rejection(u)!=null||reading&&u!=current)load.reject(if(u==null)"PROFILE_CONTEXT_REJECTED"else rejection(u)?:"PROFILE_CONTEXT_REJECTED")
                    current=u
                }
                override fun onLoadError(s:GeckoSession,u:String?,e:org.mozilla.geckoview.WebRequestError):GeckoResult<String>?{load.failed(u,e.category,e.code);return null}
            }
            browser.progressDelegate=object:GeckoSession.ProgressDelegate{
                override fun onPageStart(s:GeckoSession,u:String){load.started()}
                override fun onPageStop(s:GeckoSession,success:Boolean){load.stopped(success)}
            }
            try{
                progress("LOADING");check(live())
                channel.attach(GeckoHost.collectorExtension(context));DesktopSessionPreview.applyDesktop(browser)
                browser.open(GeckoHost.runtime(context));surface=BackgroundViewport(browser);browser.setActive(true);browser.setFocused(true);browser.loadUri(target)
                suspend fun awaitDocument(afterGeneration:Long?=null){
                    val until=android.os.SystemClock.elapsedRealtime()+if(fixture)90_000 else 35_000
                    while(live()&&android.os.SystemClock.elapsedRealtime()<until){
                        if(load.ready&&current!=null&&channel.isConnected&&channel.connectedUrl==current&&(afterGeneration==null||channel.connectionGeneration>afterGeneration)){
                            val probe=channel.probe(1000)
                            if((probe?.passwordInputs?:0)>0){load.reject("LOGIN_REQUIRED");break}
                            if(probe?.readyState in setOf("interactive","complete"))break
                        }
                        delay(200)
                    }
                    check(live()&&load.ready&&current!=null&&channel.isConnected&&channel.connectedUrl==current&&(afterGeneration==null||channel.connectionGeneration>afterGeneration)){load.reason?:"PROFILE_NOT_READY"}
                }
                awaitDocument()
                val ua=withTimeoutOrNull(5000){browser.userAgent.await()}
                check(ua!=null&&!ua.contains("Mobile",true)&&!ua.contains("Android",true)){"PROFILE_DESKTOP_NOT_APPLIED"}
                // Match the proven group reader: consume the cold initial page and
                // read a fresh desktop document before the first bound pixel crop.
                val previousGeneration=channel.connectionGeneration
                val framesBeforeReload=checkNotNull(surface).renderedFrames
                load.started();browser.reload();awaitDocument(previousGeneration)
                val expected=checkNotNull(current);val generation=channel.connectionGeneration
                fun bound()=live()&&load.ready&&current==expected&&channel.connectionGeneration==generation&&channel.connectedUrl==expected
                val renderUntil=android.os.SystemClock.elapsedRealtime()+5000
                while(bound()&&checkNotNull(surface).renderedFrames<=framesBeforeReload&&android.os.SystemClock.elapsedRealtime()<renderUntil)delay(50)
                var surfaceResets=0
                var rendered=!forceSurfaceRefresh&&checkNotNull(surface).renderedFrames>framesBeforeReload
                if(bound()&&!rendered){
                    // A background compositor can retain an idle render target after reload.
                    // Reattach once; only a real frame delivered to this NEW surface is proof.
                    checkNotNull(surface).close();surface=BackgroundViewport(browser);surfaceResets++
                    browser.setActive(true);browser.setFocused(true)
                    val freshUntil=android.os.SystemClock.elapsedRealtime()+5000
                    while(bound()&&checkNotNull(surface).renderedFrames==0&&android.os.SystemClock.elapsedRealtime()<freshUntil)delay(50)
                    rendered=checkNotNull(surface).renderedFrames>0
                }
                check(bound()){load.reason?:"PROFILE_CONTEXT_REJECTED"}
                check(rendered){"PROFILE_RENDER_RETRY_FAILED"}
                browser.setActive(true);browser.setFocused(true);val nonce=UUID.randomUUID().toString();reading=true
                channel.viewportBridge=DesktopViewportBridge(checkNotNull(surface),nonce,images,::bound,background=true,profile=true)
                progress("READING");val reply=checkNotNull(channel.profilePreview(nonce,source,expected)){"PROFILE_PROTOCOL"};check(bound()){load.reason?:"PROFILE_CONTEXT_REJECTED"}
                val rows=BackgroundPosterOcr.run(reply.rows,::bound,{images.ocrRows(it).size},
                    read={id,slot->images.ocrRows(id).getOrNull(slot)?.copy(Bitmap.Config.ARGB_8888,false)?.let{LocalOcr.readOwned(it)}},
                    project={id,texts->GeckoHost.background.profileOcrFields(source,id,texts)},
                    now={android.os.SystemClock.elapsedRealtime()},progress=progress)
                check(bound()){load.reason?:"PROFILE_CONTEXT_REJECTED"}
                channel.viewportBridge?.close()
                val photos=BackgroundPhotoEncoding.encode(rows,images)
                check(bound()){load.reason?:"PROFILE_CONTEXT_REJECTED"}
                val counters=checkNotNull(channel.viewportBridge).captureCounts
                val keys=listOf("profileCaptureAttempts","profileCaptureInactive","profileCaptureAspect","profileCaptureFrame","profileCaptureLate","profileCaptureError","profileCapturePending","profileCaptureCommitted")
                SavedResult(System.currentTimeMillis(),rows,emptyList(),photos,reply.postTexts,reply.stats+keys.mapIndexed{i,key->key to counters[i]}.toMap()+mapOf("profileRenderedFrames" to checkNotNull(surface).renderedFrames,"profileSurfaceResets" to surfaceResets))
            }finally{runCatching{channel.close()};runCatching{surface?.close()};images.clear();runCatching{browser.stop()};runCatching{browser.setActive(false)};runCatching{browser.close()}}
        }
    }
}
