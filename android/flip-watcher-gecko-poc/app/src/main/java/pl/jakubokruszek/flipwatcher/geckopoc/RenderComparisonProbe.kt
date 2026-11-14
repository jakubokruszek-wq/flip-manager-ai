package pl.jakubokruszek.flipwatcher.geckopoc

import android.content.Context
import android.graphics.Bitmap
import android.os.Build
import android.os.SystemClock
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.mozilla.geckoview.GeckoResult
import org.mozilla.geckoview.GeckoSession
import org.mozilla.geckoview.GeckoView
import kotlin.coroutines.resumeWithException

internal data class RenderComparisonResult(val issue:String,val stats:Map<String,Int>)

/** Explicit count-only comparison. No collector trial, offer parsing, archive or outbox write.
 * Bitmap contents stay in RAM. A captured/uniform image is diagnostic evidence only;
 * it never replaces the production reader's current frame or ownership requirements. */
internal object RenderComparisonProbe {
 suspend fun run(context:Context,group:WatcherGroup,view:GeckoView?,width:Int,height:Int,alive:()->Boolean,fixtureTarget:String?=null):RenderComparisonResult=withContext(Dispatchers.Main){
  require(group.type=="GROUP"&&width in 128..2160&&height in 128..2160&&width.toLong()*height<=4_000_000)
  if(fixtureTarget!=null)require(java.net.URI(fixtureTarget).host=="127.0.0.1")
  val target=fixtureTarget?:group.url
  val browser=GeckoSession();val observation=RenderObservation("GROUP"){SystemClock.elapsedRealtime()}
  RenderDiagnostics.attach(browser,observation)
  val channel=CollectorChannel(browser,fixtureMode=fixtureTarget!=null)
  val load=BackgroundDocumentLoad("GROUP")
  var current:String?=null;var initial=true;var surface:BackgroundViewport?=null
  val stats=mutableMapOf("comparisonWidth" to width,"comparisonHeight" to height,"comparisonReady" to 0,"comparisonDocument" to 0,"comparisonCapture" to 0,"comparisonVaried" to 0,"renderDiagEnabled" to 1,"renderSdk" to Build.VERSION.SDK_INT)
  fun live()=alive()&&load.reason==null
  fun accepted(u:String)=BackgroundNavigationPolicy.rejection(u,group.id,fixtureTarget)==null
  browser.navigationDelegate=object:GeckoSession.NavigationDelegate {
   override fun onLoadRequest(s:GeckoSession,r:GeckoSession.NavigationDelegate.LoadRequest):GeckoResult<org.mozilla.geckoview.AllowOrDeny>?{
    if(initial&&r.uri=="about:blank")return GeckoResult.fromValue(org.mozilla.geckoview.AllowOrDeny.ALLOW)
    val reason=BackgroundNavigationPolicy.rejection(r.uri,group.id,fixtureTarget)
    val ok=live()&&reason==null&&!r.hasUserGesture&&r.target!=GeckoSession.NavigationDelegate.TARGET_WINDOW_NEW
    if(!ok)load.reject(reason?:"GROUP_CONTEXT_REJECTED")
    return GeckoResult.fromValue(if(ok)org.mozilla.geckoview.AllowOrDeny.ALLOW else org.mozilla.geckoview.AllowOrDeny.DENY)
   }
   override fun onLocationChange(s:GeckoSession,u:String?,permissions:MutableList<GeckoSession.PermissionDelegate.ContentPermission>,gesture:Boolean){
    if(initial&&(u==null||u=="about:blank"))return
    initial=false;current=u
    if(u==null||!accepted(u))load.reject(if(u==null)"GROUP_CONTEXT_REJECTED"else BackgroundNavigationPolicy.rejection(u,group.id,fixtureTarget)?:"GROUP_CONTEXT_REJECTED")
   }
   override fun onLoadError(s:GeckoSession,u:String?,e:org.mozilla.geckoview.WebRequestError):GeckoResult<String>?{load.failed(u,e.category,e.code);return null}
  }
  browser.progressDelegate=object:GeckoSession.ProgressDelegate {
   override fun onPageStart(s:GeckoSession,u:String){load.started()}
   override fun onPageStop(s:GeckoSession,success:Boolean){load.stopped(success)}
  }
  val started=SystemClock.elapsedRealtime()
  try {
   withTimeout(70_000){
    check(live()){load.reason?:"COMPARE_INTERRUPTED"}
    channel.attach(GeckoHost.collectorExtension(context));DesktopSessionPreview.applyDesktop(browser)
    browser.open(GeckoHost.runtime(context))
    if(view!=null){check(view.isShown&&view.hasWindowFocus()){ "COMPARE_VIEW_HIDDEN" };view.setSession(browser)}
    else surface=BackgroundViewport(browser,observation,width,height)
    browser.setActive(true);browser.setFocused(true);browser.loadUri(target)
    var ready=false
    val until=SystemClock.elapsedRealtime()+35_000
    while(live()&&SystemClock.elapsedRealtime()<until){
     val u=current
     if(u!=null&&accepted(u)&&load.ready&&channel.isConnected&&channel.connectedUrl==u){
      val p=channel.probe(1000)
      if((p?.passwordInputs?:0)>0){load.reject("LOGIN_REQUIRED");break}
      if(p?.readyState in setOf("interactive","complete")){
       stats["comparisonArticles"]=p!!.articles.coerceIn(0,100_000_000);ready=true;break
      }
     }
     delay(200)
    }
    check(alive()){"COMPARE_INTERRUPTED"}
    check(live()&&ready){load.reason?:"GROUP_NOT_READY"}
    val url=checkNotNull(current);val generation=channel.connectionGeneration
    fun sameDocument()=live()&&load.ready&&current==url&&channel.isConnected&&channel.connectedUrl==url&&channel.connectionGeneration==generation&&accepted(url)
    stats["comparisonReady"]=1
    // Same observation interval for all arms; reproduce the existing headless
    // surface reset without introducing active toggles or alternate frame proof.
    val first=SystemClock.elapsedRealtime()+2500
    while(sameDocument()&&SystemClock.elapsedRealtime()<first)delay(50)
    if(view==null&&surface?.renderedFrames==0){surface?.close();surface=BackgroundViewport(browser,observation,width,height);stats["groupSurfaceResets"]=1;browser.setActive(true);browser.setFocused(true)}
    val settle=SystemClock.elapsedRealtime()+5000
    while(sameDocument()&&SystemClock.elapsedRealtime()<settle)delay(50)
    check(alive()){"COMPARE_INTERRUPTED"}
    check(sameDocument()){load.reason?:"COMPARE_DOCUMENT_CHANGED"}
    if(view!=null)check(view.isShown&&view.hasWindowFocus()){ "COMPARE_VIEW_HIDDEN" }
    stats["comparisonDocument"]=1
    try {
     val bitmap=withTimeout(8000){ownedBitmap(if(view!=null)view.capturePixels() else checkNotNull(surface).capturePixels())}
     try {
      check(alive()){"COMPARE_INTERRUPTED"}
      check(sameDocument()){ "COMPARE_DOCUMENT_CHANGED" }
      if(view!=null)check(view.isShown&&view.hasWindowFocus()){ "COMPARE_VIEW_HIDDEN" }
      check(bitmap.width==width&&bitmap.height==height){"COMPARE_IMAGE_SIZE"}
      stats["comparisonCapture"]=1;stats["comparisonVaried"]=if(varied(bitmap))1 else 0
     } finally {bitmap.recycle()}
    }catch(e:TimeoutCancellationException){stats["comparisonCaptureTimeout"]=1}
     catch(e:CancellationException){throw e}
     catch(e:Exception){stats["comparisonCaptureError"]=1;if(e.message in setOf("COMPARE_DOCUMENT_CHANGED","COMPARE_VIEW_HIDDEN","COMPARE_INTERRUPTED","COMPARE_IMAGE_SIZE"))throw e}
    check(alive()){"COMPARE_INTERRUPTED"}
    check(sameDocument()){load.reason?:"COMPARE_DOCUMENT_CHANGED"}
    stats["comparisonDocument"]=1
   }
   RenderComparisonResult("RENDER_COMPARE_OBSERVED",stats.toMap()+observation.snapshot()+mapOf("groupElapsedMs" to (SystemClock.elapsedRealtime()-started).toInt())+(surface?.let{mapOf("groupRenderedFrames" to it.renderedFrames)}?:emptyMap()))
  }catch(e:CancellationException){if(e !is TimeoutCancellationException)throw e;stats["comparisonDocument"]=0;RenderComparisonResult("COMPARE_TIMEOUT",stats.toMap()+observation.snapshot())}
   catch(e:Exception){if(e.message in setOf("COMPARE_DOCUMENT_CHANGED","COMPARE_VIEW_HIDDEN","COMPARE_INTERRUPTED","COMPARE_IMAGE_SIZE"))stats["comparisonDocument"]=0;RenderComparisonResult(WatcherAutomation.errorCode(e),stats.toMap()+observation.snapshot())}
  finally {
   runCatching{channel.close()}
   if(view!=null)runCatching{view.releaseSession()}
   runCatching{surface?.close()};runCatching{browser.stop()};runCatching{browser.setActive(false)};runCatching{browser.close()}
  }
 }
 private suspend fun ownedBitmap(result:GeckoResult<Bitmap>):Bitmap=suspendCancellableCoroutine{continuation->
  result.accept({bitmap->
   if(bitmap==null){if(continuation.isActive)continuation.resumeWithException(IllegalStateException("COMPARE_EMPTY_IMAGE"))}
   else if(continuation.isActive)continuation.resume(bitmap,onCancellation={_,value,_->value.recycle()}) else bitmap.recycle()
  },{error->if(continuation.isActive)continuation.resumeWithException(error?:IllegalStateException("COMPARE_CAPTURE_FAILED"))})
 }
 internal fun varied(bitmap:Bitmap):Boolean {
  val first=bitmap.getPixel(bitmap.width/2,bitmap.height/2)
  for(y in 1..12)for(x in 1..12)if(bitmap.getPixel((x*bitmap.width/13).coerceAtMost(bitmap.width-1),(y*bitmap.height/13).coerceAtMost(bitmap.height-1))!=first)return true
  return false
 }
}
