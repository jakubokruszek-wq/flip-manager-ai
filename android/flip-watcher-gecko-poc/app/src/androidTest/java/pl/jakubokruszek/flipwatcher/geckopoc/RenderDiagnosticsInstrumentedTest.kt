package pl.jakubokruszek.flipwatcher.geckopoc
import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID
@RunWith(AndroidJUnit4::class)
class RenderDiagnosticsInstrumentedTest {
 private val context:Context=ApplicationProvider.getApplicationContext()
 @Test fun disabledModePreservesOriginalExceptionAndOptInPreservesErrorCode(){
  RenderDiagnostics.set(context,false)
  try {
   val error=IllegalStateException("GROUP_RENDER_RETRY_FAILED")
   assertNull(RenderDiagnostics.begin(context,"GROUP"))
   assertSame(error,RenderDiagnostics.failure(context,"GROUP",error,null,null,0))
   val group=WatcherGroups.configured.first()
   val off=WatcherCaptureReport.create(context,"diag","run",group,null,error.message!!).getJSONObject("stats")
   assertFalse(off.has("renderDiagEnabled"));assertFalse(off.has("capturedEpochDay"))
   RenderDiagnostics.set(context,true);val observation=checkNotNull(RenderDiagnostics.begin(context,"GROUP"))
   observation.available();observation.acquisitionFailed(1)
   val wrapped=RenderDiagnostics.failure(context,"GROUP",error,observation,null,1)
   assertEquals(error.message,wrapped.message);assertSame(error,wrapped.cause)
   val stats=(wrapped as RenderObservationFailure).stats
   assertEquals(1,stats["groupAcquireErrors"]);assertEquals(1,stats["groupSurfaceResets"])
   assertTrue(stats.values.all{it in 0..100_000_000})
   val cancellation=kotlinx.coroutines.CancellationException("GROUP_RENDER_RETRY_FAILED")
   assertSame(cancellation,RenderDiagnostics.failure(context,"GROUP",cancellation,observation,null,0))
   val privateError=IllegalStateException("https://private.invalid/cookie")
   assertSame(privateError,RenderDiagnostics.failure(context,"GROUP",privateError,observation,null,0))
   val before=System.currentTimeMillis()
   val report=WatcherCaptureReport.create(context,"diag","run",group,null,error.message!!,1,emptyMap(),stats).getJSONObject("stats")
   val captured=report.getLong("capturedEpochDay")*86400000L+report.getLong("capturedDayMs")
   assertTrue(captured in before..System.currentTimeMillis());assertTrue(report.length()<=160)
   for(key in report.keys())assertTrue(report.getLong(key) in 0..100_000_000L)
   RenderDiagnostics.set(context,false)
   assertSame(error,RenderDiagnostics.failure(context,"GROUP",error,observation,null,0))
  } finally {RenderDiagnostics.set(context,false)}
 }
 @Test fun observedFixtureStillRequiresRealFramesAndOwnPosterPixels()=runBlocking {
  val path="/groups/$FIXTURE_GROUP_ID/"
  val server=LoopbackFixtureServer(pages=mapOf(path to "desktop-green-sale-posters")){name->runCatching{context.assets.open(name).bufferedReader().use{it.readText()}}.getOrNull()}
  RenderDiagnostics.set(context,true)
  try {
   val result=BackgroundWatcherScan(context).runFixture("http://127.0.0.1:${server.port}$path"){true}
   assertTrue(checkNotNull(result.captureStats["groupImageCallbacks"])>0)
   assertTrue(checkNotNull(result.captureStats["groupAcquiredFrames"])>0)
   assertTrue(checkNotNull(result.captureStats["groupRenderedFrames"])>0)
   assertTrue(result.photos.any{it.postId=="1655103482946827"&&it.jpeg.isNotEmpty()})
  }finally{RenderDiagnostics.set(context,false);server.close()}
 }
 @Test fun optionalFreshReportPriorityPreservesDefaultFifoAndUnsentBacklog(){
  val device=UUID.randomUUID().toString()
  WatcherOutbox(context).use{q->
   val ids=List(4){UUID.randomUUID().toString()}
   ids.forEachIndexed{i,id->q.report(device,if(i<2)"old"else"current","source$i",JSONObject().put("batchId",id))}
   assertEquals(ids[0],q.nextReport(device)?.id)
   assertEquals(ids[3],q.nextReport(device,"current")?.id)
   q.reportSent(ids[3]);assertEquals(ids[2],q.nextReport(device,"current")?.id)
   q.reportSent(ids[2]);assertEquals(ids[0],q.nextReport(device,"current")?.id)
   q.reportSent(ids[0]);assertEquals(ids[1],q.nextReport(device)?.id)
  }
 }
}
