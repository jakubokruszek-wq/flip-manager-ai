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
import kotlinx.coroutines.launch
import kotlinx.coroutines.Job
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.mozilla.geckoview.GeckoDisplay
import org.mozilla.geckoview.GeckoResult
import org.mozilla.geckoview.GeckoSession
import java.util.UUID

/** Phone-only Gecko session using the existing profile, parser, document proofs and photo binding. */
class BackgroundWatcherScan(private val context:Context) {
    suspend fun run(group:WatcherGroup,alive:()->Boolean,progress:(String)->Unit={}):SavedResult=BackgroundLoadRetry.run("GROUP",alive,progress){runTarget(group,group.url,false,alive,progress)}
    internal suspend fun runFixture(target:String,alive:()->Boolean):SavedResult {
        require(java.net.URI(target).host=="127.0.0.1")
        return runTarget(WatcherGroup(FIXTURE_GROUP_ID,"Fixture"),target,true,alive)
    }
    private suspend fun runTarget(group:WatcherGroup,target:String,fixture:Boolean,alive:()->Boolean,progress:(String)->Unit={}):SavedResult=withContext(Dispatchers.Main){
        withTimeout(if(fixture)300_000 else 180_000){
            check(alive())
            val browser=GeckoSession()
            val images=DesktopThumbnails(50)
            progress("LOADING")
            var observer:Job?=null
            var gate:DesktopTrial?=null
            var current:String?=null;var initial=true;val load=BackgroundDocumentLoad("GROUP")
            val channel=CollectorChannel(browser,fixtureMode=fixture)
            var surface:BackgroundViewport?=null
            fun live()=alive()&&load.reason==null
            browser.navigationDelegate=object:GeckoSession.NavigationDelegate {
                override fun onLoadRequest(s:GeckoSession,r:GeckoSession.NavigationDelegate.LoadRequest):GeckoResult<org.mozilla.geckoview.AllowOrDeny>? {
                    val newWindow=r.target==GeckoSession.NavigationDelegate.TARGET_WINDOW_NEW
                    val rejected=if(initial&&r.uri=="about:blank")null else BackgroundNavigationPolicy.rejection(r.uri,group.id,if(fixture)target else null)
                    val allowed=live()&&!newWindow&&!r.hasUserGesture&&if(initial)rejected==null else gate?.request(r.uri,r.isRedirect,newWindow,r.hasUserGesture)==true
                    if(!allowed)load.reject(rejected?:"GROUP_CONTEXT_REJECTED")
                    return GeckoResult.fromValue(if(allowed)org.mozilla.geckoview.AllowOrDeny.ALLOW else org.mozilla.geckoview.AllowOrDeny.DENY)
                }
                override fun onLocationChange(s:GeckoSession,u:String?,permissions:MutableList<GeckoSession.PermissionDelegate.ContentPermission>,gesture:Boolean){
                    if(initial&&(u==null||u=="about:blank"))return
                    current=u
                    if(initial){u?.let{BackgroundNavigationPolicy.rejection(it,group.id,if(fixture)target else null)}?.let{load.reject(it)}}
                    else if(gate?.location(u)!=true)load.reject("GROUP_CONTEXT_REJECTED")
                }
                override fun onLoadError(s:GeckoSession,u:String?,e:org.mozilla.geckoview.WebRequestError):GeckoResult<String>?{load.failed(u,e.category,e.code);return null}
            }
            browser.progressDelegate=object:GeckoSession.ProgressDelegate {
                override fun onPageStart(s:GeckoSession,u:String){load.started()}
                override fun onPageStop(s:GeckoSession,success:Boolean){load.stopped(success)}
            }
            try {
                channel.attach(GeckoHost.collectorExtension(context));check(live())
                DesktopSessionPreview.applyDesktop(browser)
                browser.open(GeckoHost.runtime(context));surface=BackgroundViewport(browser)
                browser.setActive(true);browser.setFocused(true);browser.loadUri(target)
                val until=android.os.SystemClock.elapsedRealtime()+(if(fixture)90_000 else 35_000)
                while(live()&&android.os.SystemClock.elapsedRealtime()<until){
                    if(current!=null&&load.ready&&channel.isConnected&&channel.connectedUrl==current){
                        val probe=channel.probe(1000)
                        if((probe?.passwordInputs?:0)>0){load.reject("LOGIN_REQUIRED");break}
                        if(probe?.readyState in setOf("interactive","complete"))break
                    }
                    delay(200)
                }
                check(live()&&current!=null&&load.ready&&channel.isConnected&&channel.connectedUrl==current){load.reason?:"GROUP_NOT_READY"}
                val actualTarget=checkNotNull(current)
                val trial=DesktopTrial(actualTarget,{android.os.SystemClock.elapsedRealtime()},fixture,groupId=group.id,allowRootQuery=true)
                gate=trial;initial=false;check(trial.begin(true));val nonce=UUID.randomUUID().toString()
                observer=launch{var last="";while(true){val phase=if(trial.phase==DesktopTrial.Phase.READING)"READING"else"LOADING";if(phase!=last){last=phase;progress(phase)};delay(500)}}
                channel.viewportBridge=DesktopViewportBridge(checkNotNull(surface),nonce,images,{live()&&trial.active&&trial.phase==DesktopTrial.Phase.READING},background=true)
                val result=DesktopSessionPreview.run(browser,channel,trial,nonce,actualTarget,{current},{load.ready&&live()},fastScroll=true,fixture=fixture,groupId=group.id,alive=::live,includePostText=true)
                check(live()&&result.reason=="DONE"){load.reason?:"SCAN_"+result.reason}
                val sourceRows=checkNotNull(result.reply).rows
                val rows=BackgroundPosterOcr.run(sourceRows,::live,{images.ocrRows(it).size},
                    read={id,slot->images.ocrRows(id).getOrNull(slot)?.copy(Bitmap.Config.ARGB_8888,false)?.let{LocalOcr.readOwned(it)}},
                    project={id,texts->GeckoHost.background.ocrFields(id,texts,true,group.id)},
                    now={android.os.SystemClock.elapsedRealtime()},progress=progress)
                check(live()){load.reason?:"CANCELLED"}
                channel.viewportBridge?.close()
                val photos=BackgroundPhotoEncoding.encode(rows,images)
                check(live()){load.reason?:"CANCELLED"}
                val counts=channel.lastViewportCaptureCounts
                val keys=listOf("groupCaptureAttempts","groupCaptureInactive","groupCaptureAspect","groupCaptureFrame","groupCaptureLate","groupCaptureError","groupCapturePending","groupCaptureCommitted")
                SavedResult(System.currentTimeMillis(),rows,emptyList(),photos,checkNotNull(result.reply).postTexts,
                    checkNotNull(result.reply).stats+keys.mapIndexed{i,key->key to counts.getOrElse(i){0}}.toMap()+mapOf("groupRenderedFrames" to checkNotNull(surface).renderedFrames))
            }finally {
                observer?.cancel()
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
    @Volatile internal var renderedFrames:Int=0;private set
    private val thread=HandlerThread("watcher-render").apply{start()}
    private val reader=ImageReader.newInstance(width,height,PixelFormat.RGBX_8888,2).apply{
        setOnImageAvailableListener({reader->runCatching{reader.acquireLatestImage()?.let{image->renderedFrames=(renderedFrames+1).coerceAtMost(100_000_000);image.close()}}},Handler(thread.looper))
    }
    private val display=browser.acquireDisplay().apply{surfaceChanged(GeckoDisplay.SurfaceInfo.Builder(reader.surface).size(width,height).build())}
    override val isShown get()=!closed
    override fun hasWindowFocus()=!closed
    override fun onGenericMotionEvent(event:MotionEvent):Boolean {if(closed)return false;browser.panZoomController.onMotionEvent(event);return true}
    override fun capturePixels():GeckoResult<Bitmap> = display.capturePixels()
    override fun close(){if(closed)return;closed=true;runCatching{display.surfaceDestroyed()};runCatching{browser.releaseDisplay(display)};reader.close();thread.quitSafely()}
}
