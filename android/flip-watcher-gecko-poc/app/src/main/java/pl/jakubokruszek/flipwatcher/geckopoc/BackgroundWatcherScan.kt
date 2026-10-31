package pl.jakubokruszek.flipwatcher.geckopoc

import android.content.Context
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.media.ImageReader
import android.os.Handler
import android.os.HandlerThread
import android.view.MotionEvent
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.mozilla.geckoview.GeckoDisplay
import org.mozilla.geckoview.GeckoResult
import org.mozilla.geckoview.GeckoSession
import java.util.UUID

/** Phone-only Gecko session using the existing profile, parser, document proofs and photo binding. */
class BackgroundWatcherScan(private val context:Context) {
    suspend fun run(group:WatcherGroup,alive:()->Boolean):SavedResult=runTarget(group,group.url,false,alive)
    internal suspend fun runFixture(target:String,alive:()->Boolean):SavedResult {
        require(java.net.URI(target).host=="127.0.0.1")
        return runTarget(WatcherGroup(FIXTURE_GROUP_ID,"Fixture"),target,true,alive)
    }
    private suspend fun runTarget(group:WatcherGroup,target:String,fixture:Boolean,alive:()->Boolean):SavedResult=withContext(Dispatchers.Main){
        withTimeout(if(fixture)300_000 else 110_000){
            check(alive())
            val browser=GeckoSession()
            val images=DesktopThumbnails()
            var gate:DesktopTrial?=null
            var current:String?=null;var pageReady=false;var initial=true;var stopReason:String?=null
            val channel=CollectorChannel(browser,fixtureMode=fixture)
            var surface:BackgroundViewport?=null
            fun live()=alive()&&stopReason==null
            browser.navigationDelegate=object:GeckoSession.NavigationDelegate {
                override fun onLoadRequest(s:GeckoSession,r:GeckoSession.NavigationDelegate.LoadRequest):GeckoResult<org.mozilla.geckoview.AllowOrDeny>? {
                    val newWindow=r.target==GeckoSession.NavigationDelegate.TARGET_WINDOW_NEW
                    val rejected=if(initial&&r.uri=="about:blank")null else BackgroundNavigationPolicy.rejection(r.uri,group.id,if(fixture)target else null)
                    val allowed=live()&&!newWindow&&!r.hasUserGesture&&if(initial)rejected==null else gate?.request(r.uri,r.isRedirect,newWindow,r.hasUserGesture)==true
                    if(!allowed&&stopReason==null)stopReason=rejected?:"GROUP_CONTEXT_REJECTED"
                    return GeckoResult.fromValue(if(allowed)org.mozilla.geckoview.AllowOrDeny.ALLOW else org.mozilla.geckoview.AllowOrDeny.DENY)
                }
                override fun onLocationChange(s:GeckoSession,u:String?,permissions:MutableList<GeckoSession.PermissionDelegate.ContentPermission>,gesture:Boolean){
                    if(initial&&(u==null||u=="about:blank"))return
                    current=u
                    if(initial){u?.let{BackgroundNavigationPolicy.rejection(it,group.id,if(fixture)target else null)}?.let{stopReason=it}}
                    else if(gate?.location(u)!=true)stopReason="GROUP_CONTEXT_REJECTED"
                }
                override fun onLoadError(s:GeckoSession,u:String?,e:org.mozilla.geckoview.WebRequestError):GeckoResult<String>?{stopReason="GROUP_LOAD_ERROR";return null}
            }
            browser.progressDelegate=object:GeckoSession.ProgressDelegate {
                override fun onPageStart(s:GeckoSession,u:String){pageReady=false}
                override fun onPageStop(s:GeckoSession,success:Boolean){pageReady=success;if(!success)stopReason="GROUP_LOAD_ERROR"}
            }
            try {
                channel.attach(GeckoHost.collectorExtension(context));check(live())
                browser.open(GeckoHost.runtime(context));surface=BackgroundViewport(browser)
                browser.setActive(true);browser.setFocused(true);browser.loadUri(target)
                val until=android.os.SystemClock.elapsedRealtime()+(if(fixture)90_000 else 35_000)
                while(live()&&android.os.SystemClock.elapsedRealtime()<until){
                    if(current!=null&&pageReady&&channel.isConnected&&channel.connectedUrl==current){
                        val probe=channel.probe(1000)
                        if((probe?.passwordInputs?:0)>0){stopReason="LOGIN_REQUIRED";break}
                        if(probe?.readyState in setOf("interactive","complete"))break
                    }
                    delay(200)
                }
                check(live()&&current!=null&&pageReady&&channel.isConnected&&channel.connectedUrl==current){stopReason?:"GROUP_NOT_READY"}
                val actualTarget=checkNotNull(current)
                val trial=DesktopTrial(actualTarget,{android.os.SystemClock.elapsedRealtime()},fixture,groupId=group.id,allowRootQuery=true)
                gate=trial;initial=false;check(trial.begin(true));val nonce=UUID.randomUUID().toString()
                channel.viewportBridge=DesktopViewportBridge(checkNotNull(surface),nonce,images,{live()&&trial.active&&trial.phase==DesktopTrial.Phase.READING})
                val result=DesktopSessionPreview.run(browser,channel,trial,nonce,actualTarget,{current},{pageReady&&live()},fastScroll=true,fixture=fixture,groupId=group.id,alive=::live)
                check(live()&&result.reason=="DONE"){stopReason?:"SCAN_"+result.reason}
                val rows=checkNotNull(result.reply).rows
                val photos=rows.flatMap{row->images.rows(row.postId).mapIndexed{slot,b->ResultArchive.photo(row.postId,slot,false,b)}}
                SavedResult(System.currentTimeMillis(),rows,emptyList(),photos)
            }finally {
                runCatching{channel.close()};runCatching{surface?.close()};images.clear()
                runCatching{browser.stop()};runCatching{browser.setActive(false)};runCatching{browser.close()}
            }
        }
    }
}

/** Render target, never a screenshot of another app. Only exact-bound image crops leave RAM. */
internal class BackgroundViewport(private val browser:GeckoSession):WatcherViewport,AutoCloseable {
    override val width=1080
    override val height=1920
    private var closed=false
    private val thread=HandlerThread("watcher-render").apply{start()}
    private val reader=ImageReader.newInstance(width,height,PixelFormat.RGBX_8888,2).apply{
        setOnImageAvailableListener({reader->runCatching{reader.acquireLatestImage()?.close()}},Handler(thread.looper))
    }
    private val display=browser.acquireDisplay().apply{surfaceChanged(GeckoDisplay.SurfaceInfo.Builder(reader.surface).size(width,height).build())}
    override val isShown get()=!closed
    override fun hasWindowFocus()=!closed
    override fun onGenericMotionEvent(event:MotionEvent):Boolean {if(closed)return false;browser.panZoomController.onMotionEvent(event);return true}
    override fun capturePixels():GeckoResult<Bitmap> = display.capturePixels()
    override fun close(){if(closed)return;closed=true;runCatching{display.surfaceDestroyed()};runCatching{browser.releaseDisplay(display)};reader.close();thread.quitSafely()}
}
