package pl.jakubokruszek.flipwatcher.geckopoc

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID

/** Local diagnostic retention only: never invokes report transport or the offer queue. */
@RunWith(AndroidJUnit4::class)
class RenderComparisonRetentionInstrumentedTest {
 private val context:Context=ApplicationProvider.getApplicationContext()
 @Test fun eightMaximumSizedArmsSurviveAndStaleRepliesCannotReplaceNewRun(){
  val prefs=context.getSharedPreferences("watcher-render-comparison-v1",Context.MODE_PRIVATE)
  val previous=prefs.getString("latest",null)
  val run=UUID.randomUUID().toString();val group=WatcherGroup(FIXTURE_GROUP_ID,"fixture")
  try {
   RenderComparisonStore.begin(context,run,group)
   val stats=(0 until 160).associate{"S"+it.toString().padStart(40,'0') to 100_000_000}
   for(arm in 1..8)RenderComparisonStore.update(context,run,group,arm,RenderComparisonResult("RENDER_COMPARE_OBSERVED",stats),UUID.randomUUID().toString(),0)
   val raw=checkNotNull(prefs.getString("latest",null))
   assertTrue("Eight maximum reports exceed old64KiB cap",raw.length>65536)
   assertTrue(raw.length<=98304)
   val stored=JSONObject(raw)
   assertEquals(8,stored.getJSONObject("arms").length())
   for(arm in 1..8)assertEquals(160,stored.getJSONObject("arms").getJSONObject("$arm").getJSONObject("stats").length())
   assertTrue(RenderComparisonStore.summary(context).contains("8. Test obrazu w małym oknie PiP"))
   val next=UUID.randomUUID().toString();RenderComparisonStore.begin(context,next,group)
   RenderComparisonStore.update(context,run,group,6,RenderComparisonResult("COMPARE_INTERRUPTED",emptyMap()),UUID.randomUUID().toString(),0)
   assertEquals(next,JSONObject(checkNotNull(prefs.getString("latest",null))).getString("run"))
   assertEquals(0,JSONObject(checkNotNull(prefs.getString("latest",null))).getJSONObject("arms").length())
  }finally{val edit=prefs.edit();if(previous==null)edit.remove("latest")else edit.putString("latest",previous);assertTrue(edit.commit())}
 }
}
