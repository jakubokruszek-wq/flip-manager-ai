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
            val gate=DesktopTrial(target,{android.os.SystemClock.elapsedRealtime()},fixture,groupId=group.id)
            var current:String?=null;var pageReady=false;var initial=true;var stopped=false
            val channel=CollectorChannel(browser,fixtureMode=fixture)
            var surface:BackgroundViewport?=null
            fun live()=alive()&&!stopped
            browser.navigationDelegate=object:GeckoSession.NavigationDelegate {
                override fun onLoadRequest(s:GeckoSession,r:GeckoSession.NavigationDelegate.LoadRequest):GeckoResult<org.mozilla.geckoview.AllowOrDeny>? {
                    val allowed=live()&&if(initial)r.uri==target else gate.request(r.uri,r.isRedirect,false,r.hasUserGesture)
                    if(!allowed)stopped=true
                    return GeckoResult.fromValue(if(allowed)org.mozilla.geckoview.AllowOrDeny.ALLOW else org.mozilla.geckoview.AllowOrDeny.DENY)
                }
                override fun onLocationChange(s:GeckoSession,u:String?,permissions:MutableList<GeckoSession.PermissionDelegate.ContentPermission>,gesture:Boolean){
                    current=u
                    if(initial){if(u!=null&&u!=target&&u!="about:blank")stopped=true}
                    else if(!gate.location(u))stopped=true
                }
                override fun onLoadError(s:GeckoSession,u:String?,e:org.mozilla.geckoview.WebRequestError):GeckoResult<String>?{stopped=true;return null}
            }
            browser.progressDelegate=object:GeckoSession.ProgressDelegate {
                override fun onPageStart(s:GeckoSession,u:String){pageReady=false}
                override fun onPageStop(s:GeckoSession,success:Boolean){pageReady=success;if(!success)stopped=true}
            }
            try {
                channel.attach(GeckoHost.collectorExtension(context));check(live())
                browser.open(GeckoHost.runtime(context));surface=BackgroundViewport(browser)
                browser.setActive(true);browser.setFocused(true);browser.loadUri(target)
                val until=android.os.SystemClock.elapsedRealtime()+(if(fixture)90_000 else 35_000)
                while(live()&&android.os.SystemClock.elapsedRealtime()<until){
                    if(current==target&&pageReady&&channel.isConnected&&channel.connectedUrl==target&&channel.probe(1000)?.readyState in setOf("interactive","complete"))break
                    delay(200)
                }
                check(live()&&current==target&&pageReady&&channel.isConnected){"LOGIN_OR_PAGE_REQUIRED"}
                initial=false;check(gate.begin(true));val nonce=UUID.randomUUID().toString()
                channel.viewportBridge=DesktopViewportBridge(checkNotNull(surface),nonce,images,{live()&&gate.active&&gate.phase==DesktopTrial.Phase.READING})
                val result=DesktopSessionPreview.run(browser,channel,gate,nonce,target,{current},{pageReady&&live()},fastScroll=true,fixture=fixture,groupId=group.id,alive=::live)
                check(live()&&result.reason=="DONE"){"SCAN_"+result.reason}
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
