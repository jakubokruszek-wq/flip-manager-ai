package pl.jakubokruszek.flipwatcher.geckopoc

import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.*
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.mozilla.geckoview.GeckoSession
import org.mozilla.geckoview.GeckoSessionSettings

@RunWith(AndroidJUnit4::class)
class ReviewDataInstrumentedTest{
 private val a="550000000000091";private val b="550000000000092"
 private fun row(id:String)=DesktopRow(id,"https://www.facebook.com/groups/$FIXTURE_GROUP_ID/posts/$id/","DOM",null,"NONE",null,null,null,null,null,"UNKNOWN",false,0,"NO_TEXT")
 private fun html(id:String,full:Boolean)=if(!full)"""<!doctype html><title>Exact empty marker</title><article role="article"><a href="https://www.facebook.com/groups/$FIXTURE_GROUP_ID/posts/$id/">Post</a><div data-ad-preview="message"></div></article>""" else """<!doctype html><title>Exact full post</title><div role="dialog"><article role="article"><a href="https://www.facebook.com/groups/$FIXTURE_GROUP_ID/posts/$id/">Post</a></article><div data-ad-preview="message">Sprzedam mieszkanie 42m2. Cena 319000 zł. 2 pokoje. ul. Testowa 12.<div role="comment"><div data-ad-preview="message">Sprzedam inne mieszkanie 999m2 za 9000000 zł</div></div><form><textarea>PRIVATE_DRAFT 999999 zł</textarea></form><blockquote>9999999 zł</blockquote></div></div>"""
 @Test fun batchOpensExactReviewLinksReadsFullMessageWithoutCommentsAndRestoresGroup()=runCase("normal")
 @Test fun exactOpenedPostCapturesSiblingImageForOcrAndRestoresGroup()=runCase("images")
 @Test fun sevenPostsUseSevenSingleDocumentWorkersAndRestoreTheOriginalGroup()=runCase("batches")
 @Test fun cancellationBetweenBatchesNeverOpensTheNextWorker()=runCase("cancelbetween")
 @Test fun activeLoadFailureStillStopsWithoutPublishingRows()=runCase("loaderror")
 @Test fun closedWorkerLoadFailureCannotAbortTheNextPost()=runCase("staleloaderror")
 @Test fun noNewConsentDoesNotNavigateOrReadAnyPost()=runCase("consent")
 @Test fun foreignRedirectAndVerificationStopWithoutPublishingPartialRows(){runCase("foreign");runCase("login")}
 @Test fun failureAfterOneReadKeepsNumericProgressButPublishesNoPartialRows()=runCase("lateforeign")
 @Test fun cancellationClosesTemporarySessionAndRestoresOriginalWithoutPublishing()=runCase("cancel")
 private fun imageHtml():String{
  val b=android.graphics.Bitmap.createBitmap(800,400,android.graphics.Bitmap.Config.ARGB_8888)
  val c=android.graphics.Canvas(b);c.drawColor(android.graphics.Color.WHITE)
  val paint=android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply{color=android.graphics.Color.BLACK;textSize=60f}
  c.drawText("Sprzedam mieszkanie",20f,100f,paint);c.drawText("260000 zl 45,8 m2",20f,200f,paint)
  val out=java.io.ByteArrayOutputStream();b.compress(android.graphics.Bitmap.CompressFormat.PNG,100,out);b.recycle()
  return "<img style='display:block;width:600px;height:300px' src='data:image/png;base64,"+android.util.Base64.encodeToString(out.toByteArray(),android.util.Base64.NO_WRAP)+"'>"
 }
 private fun runCase(mode:String){
  ActivityScenario.launch(GeckoTestHostActivity::class.java).use{scenario->var host:GeckoTestHostActivity?=null;scenario.onActivity{host=it}
   runBlocking{withTimeout(60_000){withContext(Dispatchers.Main){
    val batchMode=mode in setOf("batches","cancelbetween");val batchIds=(0..6).map{(a.toLong()+it).toString()}
    val pathA="/groups/$FIXTURE_GROUP_ID/posts/$a/";val pathB="/groups/$FIXTURE_GROUP_ID/posts/$b/"
    val server=LoopbackFixtureServer(redirects=when(mode){"foreign"->mapOf(pathA to "/groups/foreign/posts/$a/");"lateforeign"->mapOf(pathB to "/groups/foreign/posts/$b/");else->emptyMap()},pages=if(batchMode)batchIds.associate{"/groups/$FIXTURE_GROUP_ID/posts/$it/" to "review-$it"}else mapOf(pathA to "review-full",pathB to "review-empty")){name->val batchId=if(batchMode)batchIds.firstOrNull{name=="fixtures/review-$it.html"}else null;if(batchId!=null)html(batchId,true)else when(name){"fixtures/review-home.html"->"<!doctype html><title>Original group</title><p>Original group unchanged</p>";"fixtures/review-full.html"->if(mode=="login")"<!doctype html><title>Logowanie</title><input type=password>"else if(mode=="images")"<!doctype html><title>Photo only, no caption</title><main><article role=article><a href=\"https://www.facebook.com/groups/$FIXTURE_GROUP_ID/posts/$a/\">Post</a></article>"+imageHtml()+"</main>"else html(a,true);"fixtures/review-empty.html"->html(b,false);else->null}}
    val original=GeckoSession(GeckoSessionSettings.Builder().userAgentMode(if(mode=="images")GeckoSessionSettings.USER_AGENT_MODE_MOBILE else GeckoSessionSettings.USER_AGENT_MODE_DESKTOP).viewportMode(if(mode=="images")GeckoSessionSettings.VIEWPORT_MODE_MOBILE else GeckoSessionSettings.VIEWPORT_MODE_DESKTOP).build())
    val channel=CollectorChannel(original,fixtureMode=true);var loaded=false
    original.progressDelegate=object:GeckoSession.ProgressDelegate{override fun onPageStop(s:GeckoSession,success:Boolean){loaded=success}}
    try{
     channel.attach(GeckoHost.collectorExtension(host!!));original.open(GeckoHost.runtime(host!!));host!!.geckoView.setSession(original);original.setActive(true);original.setFocused(true);host!!.geckoView.requestFocus()
     val home=server.url("/groups/$FIXTURE_GROUP_ID/","review-home");original.loadUri(home);assertTrue(channel.awaitPort(15_000));withTimeout(10_000){while(!loaded||!host!!.geckoView.hasWindowFocus())delay(50)}
     val snapshots=mutableListOf<ReviewDataSummary>();val rows=if(batchMode)batchIds.map{row(it)}else listOf(row(a),row(b));var outcome:ReviewDataRunner.Outcome?=null
     if(mode=="cancel"||mode=="cancelbetween"){
      var begun=false;val job=launch{outcome=ReviewDataRunner.run(host!!.geckoView,original,rows,true,alive={true},progress={_,_->if(mode=="cancel")begun=true},observe={if(mode=="cancelbetween"&&it=="BATCH_CLOSED")begun=true},fixtureOrigin="http://127.0.0.1:${server.port}",originalChannel=channel,snapshot={snapshots.add(it)})}
      withTimeout(if(mode=="cancelbetween")30000L else 10000L){while(!begun)delay(20)};job.cancelAndJoin();assertNull(outcome);assertTrue(snapshots.isNotEmpty());assertNotNull(ReviewDataSummary.decode(snapshots.last().stopped("CANCELLED").encode()));if(mode=="cancelbetween"){assertEquals(1,snapshots.last().opened);assertEquals(1,snapshots.last().batchSessions);assertEquals(1,snapshots.last().batchSessionsClosed)}
     }else{
      var closedFailure:(()->Unit)?=null;val trace=mutableListOf<String>();val workers=mutableSetOf<GeckoSession>();var imageCount=0;var boundCallbacks=0;val result=ReviewDataRunner.run(host!!.geckoView,original,rows,mode!="consent",alive={true},fixtureOrigin="http://127.0.0.1:${server.port}",originalChannel=channel,observe={trace.add(it);if(mode=="staleloaderror"&&it=="BATCH_CLOSED")closedFailure?.invoke()},snapshot={snapshots.add(it)},onBoundPost={source,owner,current,live->
       if(mode=="loaderror")host!!.geckoView.session!!.let{it.progressDelegate!!.onPageStop(it,false)}
       if(mode=="staleloaderror"){val worker=host!!.geckoView.session!!;val delegate=worker.progressDelegate!!;closedFailure={delegate.onPageStop(worker,false)}}
       if(mode=="batches")workers.add(host!!.geckoView.session!!)
       if(mode=="images"){
        assertEquals(GeckoSessionSettings.USER_AGENT_MODE_DESKTOP,host!!.geckoView.session!!.settings.userAgentMode);assertEquals(GeckoSessionSettings.VIEWPORT_MODE_DESKTOP,host!!.geckoView.session!!.settings.viewportMode);boundCallbacks++;val crops=DesktopThumbnails()
        try{assertTrue(source.reviewImages(owner,current,host!!.geckoView,crops,true,group=FIXTURE_GROUP_ID,alive=live));val photo=crops.ocrRows(owner.postId).firstOrNull();if(photo!=null){imageCount++;val text=LocalOcr.readOwned(photo.copy(android.graphics.Bitmap.Config.ARGB_8888,false));assertTrue("Generated fixture OCR did not read price",text.contains("260"));assertTrue(live())}}
        finally{crops.clear();assertEquals(0,crops.ocrBytes)}
       }
      })
      when(mode){
       "batches"->{assertEquals(result.summary.report()+" trace="+trace.joinToString(","),"DONE",result.summary.reason);assertEquals(7,result.summary.opened);assertEquals(7,result.summary.bound);assertEquals(7,result.summary.textRead);assertEquals(7,result.summary.batchSessions);assertEquals(7,result.summary.batchSessionsClosed);assertEquals(7,workers.size);assertFalse(workers.contains(original));assertEquals(7,trace.count{it=="BATCH_OPENED"});assertEquals(7,trace.count{it=="BATCH_CLOSED"});assertEquals(1,trace.count{it=="ORIGINAL_PARKED"});assertEquals(1,trace.count{it=="ORIGINAL_RESTORED"});assertTrue(trace.indexOf("ORIGINAL_PARKED")<trace.indexOf("BATCH_OPENED"))}
       "images"->{assertEquals(result.summary.report()+" trace="+trace.joinToString(","),"DONE",result.summary.reason);assertEquals(2,boundCallbacks);assertEquals(1,imageCount);assertEquals(0,result.summary.textRead);assertEquals(2,result.rows.size)}
       "normal","staleloaderror"->{assertEquals(result.summary.report()+" trace="+trace.joinToString(","),"DONE",result.summary.reason);assertEquals(2,result.summary.opened);assertEquals(1,result.summary.enriched);assertEquals(1,result.summary.unresolved);val actual=result.rows.single{it.postId==a};assertEquals(319000.0,actual.price!!,0.0);assertEquals(42.0,actual.area!!,0.0);assertEquals(2,actual.rooms);assertEquals("Testowa 12",actual.street);assertTrue(DesktopSummary.eligible(actual));assertNull(result.rows.single{it.postId==b}.price)}
       "loaderror"->{assertEquals("LOAD_ERROR",result.summary.reason);assertEquals(1,result.summary.opened);assertTrue(result.rows.isEmpty())}
       "lateforeign"->{assertNotEquals("DONE",result.summary.reason);assertTrue(result.rows.isEmpty());assertEquals(2,result.summary.opened);assertEquals(1,result.summary.enriched);assertTrue(snapshots.any{it.textRead==1&&it.enriched==1});assertEquals(result.summary,ReviewDataSummary.decode(result.summary.encode()))}
       "consent"->{assertEquals("NO_CONSENT_OR_INPUT",result.summary.reason);assertEquals(0,result.summary.opened);assertTrue(result.rows.isEmpty())}
       else->{assertNotEquals("DONE",result.summary.reason);assertTrue(result.rows.isEmpty())}
      }
     }
     assertSame(original,host!!.geckoView.session);if(mode=="images"){assertEquals(GeckoSessionSettings.USER_AGENT_MODE_MOBILE,original.settings.userAgentMode);assertEquals(GeckoSessionSettings.VIEWPORT_MODE_MOBILE,original.settings.viewportMode)};if(mode in setOf("normal","images","batches","staleloaderror","consent"))assertEquals("/groups/$FIXTURE_GROUP_ID/",channel.probe()!!.path) else assertFalse("An unsafe stop or cancellation must not reload the group",channel.isConnected)
    }finally{channel.close();runCatching{host!!.geckoView.releaseSession()};original.close();server.close()}
   }}}
  }
 }
}
