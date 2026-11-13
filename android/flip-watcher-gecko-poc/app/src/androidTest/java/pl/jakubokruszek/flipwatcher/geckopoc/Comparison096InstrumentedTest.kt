package pl.jakubokruszek.flipwatcher.geckopoc
import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
@RunWith(AndroidJUnit4::class)
class Comparison096InstrumentedTest {
 private val context:Context=ApplicationProvider.getApplicationContext()
 @Test fun priorCursorWrapsEverySourceAndDnsFailureDoesNotDiscardReadyTextOffers()=runBlocking {
  val prefs=WatcherAutomation.preferences(context);val backup=prefs.all.toMap()
  val visible=WatcherAutomation.uiVisible;val oldGroups=WatcherGroups.active.toList()
  val catalog=context.getSharedPreferences("gecko_poc",Context.MODE_PRIVATE);val oldCatalog=catalog.getString("watcher_active_groups",null)
  val selected=WatcherGroups.configured.take(3);val calls=mutableListOf<String>();val sent=mutableSetOf<String>()
  val device=java.util.UUID.randomUUID().toString();val credentials=WatcherLink.Credentials(device,"x".repeat(40))
  try {
   context.deleteDatabase("watcher-outbox-v1.db")
   prefs.edit().clear().putBoolean("enabled",true).putLong("schedule_since",0).putString("requested_scan",java.util.UUID.randomUUID().toString()).putString("last_attempted_source",selected[0].key).commit()
   WatcherAutomation.uiVisible=false
   val factory=object:androidx.work.WorkerFactory(){
    override fun createWorker(appContext:Context,name:String,parameters:androidx.work.WorkerParameters):androidx.work.ListenableWorker = object:WatcherAutomationWorker(appContext,parameters){
     override fun credentials(context:Context)=credentials
     override fun groups(credentials:WatcherLink.Credentials)=selected
     override fun continueScan(context:Context){error("096 exhausted DNS failure must not spin")}
     override fun sendReport(credentials:WatcherLink.Credentials,item:WatcherOutbox.Item){}
     override fun send(credentials:WatcherLink.Credentials,item:WatcherOutbox.Item):String {
      val body=org.json.JSONObject(item.body);assertEquals(0,body.getJSONArray("photos").length())
      assertTrue(body.getString("postText").contains("Tatrzańska"));assertTrue(sent.add(body.getString("groupId")))
      return "comparison-${sent.size}"
     }
     override suspend fun scan(group:WatcherGroup,progress:(String)->Unit):SavedResult {
      calls.add(group.key)
      if(group.key==selected[0].key)error("GROUP_LOAD_ERROR_C5_E37")
      val id=(550000000000106L+selected.indexOf(group)).toString()
      val row=DesktopRow(id,group.url+"posts/$id/","DOM",260000.0,"EXPLICIT_TOTAL",37.64,2,"Bałuty",null,null,"SELL_PROPERTY",true,0)
      return SavedResult(System.currentTimeMillis(),listOf(row),emptyList(),emptyList(),mapOf(id to "Sprzedam mieszkanie 37,64 m2 Łódź Tatrzańska 66/68 za 260000 zł"),DesktopProtocol.emptyStats()+mapOf("pageVisible" to 1,"scrollMoves" to 1))
     }
    }
   }
   fun worker()=androidx.work.testing.TestListenableWorkerBuilder<WatcherAutomationWorker>(context).setWorkerFactory(factory).build()
   assertEquals(androidx.work.ListenableWorker.Result.success(),worker().doWork())
   assertEquals(listOf(selected[1].key,selected[2].key,selected[0].key),calls)
   assertEquals(2,sent.size);assertEquals("PARTIAL",WatcherScanStatus.read(context).phase)
   val slot=checkNotNull(prefs.getString("capture_cycle",null))
   WatcherOutbox(context).use{q->
    assertTrue(selected.all{q.scanned(slot,it.key)})
    assertTrue(q.cycleReports(slot).any{it.optString("issue")=="GROUP_LOAD_ERROR_C5_E37"})
    assertEquals(2,q.transferCounts()["queueSent"]);assertEquals(0,q.transferCounts()["queueQualityHeld"])
   }
   worker().doWork();assertEquals(3,calls.size)
  }finally{
   WatcherAutomation.configure(context,false)
   val edit=prefs.edit().clear();for((k,v)in backup)when(v){is String->edit.putString(k,v);is Boolean->edit.putBoolean(k,v);is Long->edit.putLong(k,v);is Int->edit.putInt(k,v)};edit.commit()
   WatcherAutomation.uiVisible=visible;WatcherGroups.setActive(oldGroups);catalog.edit().putString("watcher_active_groups",oldCatalog).commit();context.deleteDatabase("watcher-outbox-v1.db")
  }
 }
}
