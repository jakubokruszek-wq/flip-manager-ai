package pl.jakubokruszek.flipwatcher.geckopoc

import android.content.Context
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.*
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.mozilla.geckoview.GeckoView

@RunWith(AndroidJUnit4::class)
class AndroidSignalRenderComparisonInstrumentedTest {
 private val context:Context=ApplicationProvider.getApplicationContext()
 @Test fun nativeSignalIsAbsentInFirstTwoSamplesAndStartsOnlyAfterTenSeconds()=runBlocking {
  val path="/groups/$FIXTURE_GROUP_ID/"
  val server=LoopbackFixtureServer(pages=mapOf(path to "desktop-green-sale-posters")){name->runCatching{context.assets.open(name).bufferedReader().use{it.readText()}}.getOrNull()}
  try{ActivityScenario.launch(GeckoTestHostActivity::class.java).use{scenario->
   lateinit var view:GeckoView;var width=0;var height=0;var focused=false
   withTimeout(5000){while(width<128||height<128||!focused){scenario.onActivity{view=it.geckoView;width=view.width;height=view.height;focused=view.hasWindowFocus()};delay(50)}}
   val result=RenderComparisonProbe.run(context,WatcherGroup(FIXTURE_GROUP_ID,"fixture"),view,width,height,
    {view.isShown&&view.hasWindowFocus()},"http://127.0.0.1:${server.port}$path",frameSignal=true)
   assertEquals("stats=${result.stats}","RENDER_COMPARE_OBSERVED",result.issue)
   assertEquals(1,result.stats["frameSignalRequested"])
   assertEquals(0,result.stats["timingUiFrames1"]);assertEquals(0,result.stats["timingUiFrames2"])
   assertTrue((result.stats["frameSignalAtMs"]?:0)>=10000)
   assertTrue((result.stats["frameSignalAtMs"]?:Int.MAX_VALUE)<15000)
   assertEquals(1,result.stats["frameSignalActivated"])
   assertTrue((result.stats["timingUiFrames3"]?:0)>0)
   assertTrue((result.stats["timingUiTimers5"]?:0)>0)
   assertEquals(1,result.stats["comparisonCapture"])
   assertEquals(1,result.stats["comparisonDocument"])
   assertEquals(1,result.stats["frameSignalClosed"])
  }}finally{server.close()}
 }
}
