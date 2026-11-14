package pl.jakubokruszek.flipwatcher.geckopoc

import android.content.Context
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.mozilla.geckoview.GeckoView

@RunWith(AndroidJUnit4::class)
class RenderComparisonInstrumentedTest {
 private val context:Context=ApplicationProvider.getApplicationContext()
 @Test fun sameDocumentSameDimensionsVisibleHeadlessForegroundAndStoppedActivity()=runBlocking {
  val path="/groups/$FIXTURE_GROUP_ID/"
  val server=LoopbackFixtureServer(pages=mapOf(path to "desktop-green-sale-posters")){name->runCatching{context.assets.open(name).bufferedReader().use{it.readText()}}.getOrNull()}
  val group=WatcherGroup(FIXTURE_GROUP_ID,"fixture")
  try{
   ActivityScenario.launch(GeckoTestHostActivity::class.java).use{scenario->
    lateinit var view:GeckoView
    scenario.onActivity{view=it.geckoView}
    var width=0;var height=0;var focused=false
    kotlinx.coroutines.withTimeout(5000){while(width<128||height<128||!focused){scenario.onActivity{width=it.geckoView.width;height=it.geckoView.height;focused=it.geckoView.hasWindowFocus()};kotlinx.coroutines.delay(50)}}
    assertTrue(width in 128..2160&&height in 128..2160)
    assertTrue(RenderComparisonVisibility.hasStartedActivity)
    val target="http://127.0.0.1:${server.port}$path"
    fun ready()=view.windowVisibility==android.view.View.VISIBLE&&view.isShown&&view.hasWindowFocus()
    val visible=RenderComparisonProbe.run(context,group,view,width,height,::ready,target)
    assertEquals("visible stats="+visible.stats,"RENDER_COMPARE_OBSERVED",visible.issue);assertEquals(1,visible.stats["comparisonDocument"])
    assertEquals(1,visible.stats["comparisonCapture"]);assertEquals(1,visible.stats["comparisonVaried"])
    assertFalse("Visible capture cannot pretend to be ImageReader frames",visible.stats.containsKey("groupRenderedFrames"))
    assertTrue((visible.stats["comparisonArticles"]?:0)>0)
    val headless=RenderComparisonProbe.run(context,group,null,width,height,::ready,target)
    assertEquals("headless stats="+headless.stats,"RENDER_COMPARE_OBSERVED",headless.issue);assertEquals(1,headless.stats["comparisonDocument"])
    assertEquals(1,headless.stats["comparisonCapture"]);assertTrue((headless.stats["groupAcquiredFrames"]?:0)>0)
    scenario.moveToState(Lifecycle.State.CREATED)
    assertEquals(Lifecycle.State.CREATED,scenario.state)
    kotlinx.coroutines.withTimeout(5000){while(kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.Main){view.windowVisibility==android.view.View.VISIBLE||RenderComparisonVisibility.hasStartedActivity})kotlinx.coroutines.delay(50)}
    val background=RenderComparisonProbe.run(context,group,null,width,height,{view.windowVisibility!=android.view.View.VISIBLE},target)
    assertEquals("background stats="+background.stats,"RENDER_COMPARE_OBSERVED",background.issue);assertEquals(1,background.stats["comparisonDocument"])
    assertEquals(1,background.stats["comparisonCapture"]);assertTrue((background.stats["groupRenderedFrames"]?:0)>0)
    assertEquals(visible.stats["comparisonWidth"],background.stats["comparisonWidth"])
    assertEquals(visible.stats["comparisonHeight"],background.stats["comparisonHeight"])
   }
  }finally{server.close()}
 }
 @Test fun notificationStatusWindowIsVisibleEvenWhenNormalScannerUiFlagIsFalse(){
  val previous=WatcherAutomation.uiVisible
  val epoch=RenderComparisonVisibility.foregroundEpoch
  WatcherAutomation.uiVisible=false
  try{ActivityScenario.launch(ScanStatusActivity::class.java).use{
   assertFalse(WatcherAutomation.uiVisible)
   assertTrue("Diagnostic background arm must reject the visible progress window",RenderComparisonVisibility.hasStartedActivity)
   assertTrue(RenderComparisonVisibility.foregroundEpoch>epoch)
  }}finally{WatcherAutomation.uiVisible=previous}
 }
 @Test fun navigationToAnotherGroupIsRejectedWithoutCapturedDocument()=runBlocking {
  val path="/groups/$FIXTURE_GROUP_ID/"
  val server=LoopbackFixtureServer(redirects=mapOf(path to "/groups/9999999999999/")){null}
  try {
   val result=RenderComparisonProbe.run(context,WatcherGroup(FIXTURE_GROUP_ID,"fixture"),null,1080,1920,{true},"http://127.0.0.1:${server.port}$path")
   assertEquals("GROUP_CONTEXT_REJECTED",result.issue);assertEquals(0,result.stats["comparisonDocument"])
   assertEquals(0,result.stats["comparisonCapture"])
  }finally{server.close()}
 }
}
