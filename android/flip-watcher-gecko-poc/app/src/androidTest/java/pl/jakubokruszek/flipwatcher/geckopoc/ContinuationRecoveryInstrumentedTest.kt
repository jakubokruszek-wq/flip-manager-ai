package pl.jakubokruszek.flipwatcher.geckopoc

import android.content.Context
import android.content.SharedPreferences
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.work.ListenableWorker.Result
import androidx.work.WorkerFactory
import androidx.work.WorkerParameters
import androidx.work.testing.TestListenableWorkerBuilder
import kotlinx.coroutines.*
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.time.Instant
import java.time.ZoneId
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class ContinuationRecoveryInstrumentedTest {
 private val context:Context=ApplicationProvider.getApplicationContext()
 private val credentials=WatcherLink.Credentials("12345678-1234-1234-1234-123456789012","fixture-unused-credential")
 private val groups=WatcherGroups.configured.take(2)
 private fun restore(prefs:SharedPreferences,values:Map<String,*>) {
  val edit=prefs.edit().clear()
  for((k,v)in values)when(v){is String->edit.putString(k,v);is Boolean->edit.putBoolean(k,v);is Long->edit.putLong(k,v);is Int->edit.putInt(k,v);is Float->edit.putFloat(k,v);is Set<*>->edit.putStringSet(k,v.filterIsInstance<String>().toSet())}
  check(edit.commit())
 }
 private inner class Fixture {
  val request=UUID.randomUUID().toString()
  val slot=WatcherCaptureReport.cycle("manual/$request")
  val prefs=WatcherAutomation.preferences(context)
  val calls=java.util.Collections.synchronizedList(mutableListOf<String>())
  var lookups=0;var continuations=0
  var scanAction:suspend(WatcherGroup)->SavedResult={validResult(it)}
  val factory=object:WorkerFactory(){
   override fun createWorker(appContext:Context,name:String,parameters:WorkerParameters)=object:WatcherAutomationWorker(appContext,parameters){
    override fun credentials(context:Context)=this@ContinuationRecoveryInstrumentedTest.credentials
    override fun groups(credentials:WatcherLink.Credentials):List<WatcherGroup>{lookups++;return this@ContinuationRecoveryInstrumentedTest.groups}
    override fun send(credentials:WatcherLink.Credentials,item:WatcherOutbox.Item)="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
    override fun sendReport(credentials:WatcherLink.Credentials,item:WatcherOutbox.Item){}
    override fun continueScan(context:Context){continuations++}
    override suspend fun scan(group:WatcherGroup,progress:(String)->Unit):SavedResult{calls.add(group.key);return scanAction(group)}
   }
  }
  fun worker()=TestListenableWorkerBuilder<WatcherAutomationWorker>(context).setWorkerFactory(factory).build()
  fun prepare(){
   context.deleteDatabase("watcher-outbox-v1.db")
   check(prefs.edit().clear().putBoolean("enabled",true).putLong("schedule_since",0).putString("requested_scan",request).commit())
   WatcherAutomation.uiVisible=false
   val window=WatcherCaptureReport.cycle(AutomationPolicy.current(Instant.now(),ZoneId.systemDefault(),WatcherAutomation.schedule(context)).key)
   WatcherOutbox(context).use{it.completeScan(slot,groups.first().key);it.completeScan(window,groups.first().key)}
  }
 }
 private fun validResult(group:WatcherGroup):SavedResult {
  val id="550000000000191"
  val bitmap=android.graphics.Bitmap.createBitmap(192,144,android.graphics.Bitmap.Config.ARGB_8888)
  val canvas=android.graphics.Canvas(bitmap);canvas.drawColor(android.graphics.Color.WHITE)
  canvas.drawRect(10f,10f,100f,100f,android.graphics.Paint().apply{color=android.graphics.Color.BLUE})
  val photo=try{ResultArchive.photo(id,0,false,bitmap)}finally{bitmap.recycle()}
  return SavedResult(System.currentTimeMillis(),listOf(DesktopRow(id,group.postUrl(id),"DOM",430000.0,"EXPLICIT_TOTAL",42.0,2,"Bałuty",null,null,"SELL_PROPERTY",true,0)),emptyList(),listOf(photo),captureStats=DesktopProtocol.emptyStats()+mapOf("pageVisible" to 1,"scrollMoves" to 1))
 }
 private suspend fun fixture(block:suspend(Fixture)->Unit){
  val prefs=WatcherAutomation.preferences(context);val backup=prefs.all.toMap()
  val status=context.getSharedPreferences("watcher-scan-status-v1",Context.MODE_PRIVATE);val statusBackup=status.all.toMap()
  val catalog=context.getSharedPreferences("gecko_poc",Context.MODE_PRIVATE);val catalogBackup=catalog.all.toMap()
  val visible=WatcherAutomation.uiVisible;val active=WatcherGroups.active.toList();val sources=WatcherSources.active.toList()
  try{Fixture().also{it.prepare()}.let{block(it)}}finally{
   WatcherAutomation.configure(context,false)
   restore(prefs,backup);restore(status,statusBackup);restore(catalog,catalogBackup)
   WatcherAutomation.uiVisible=visible;WatcherSources.setActive(sources);WatcherGroups.setActive(active)
   context.deleteDatabase("watcher-outbox-v1.db")
  }
 }
 @Test fun busyKickRetainsPendingCycleAndResumesFirstUnfinishedReceipt()=runBlocking {
  fixture{f->
   val kick=f.worker();val id=kick.id
   WatcherAutomation.lock.lock()
   try {
    assertEquals(Result.retry(),kick.doWork())
    assertEquals(f.request,f.prefs.getString("requested_scan",null))
    assertEquals(0,f.lookups);assertTrue(f.calls.isEmpty())
    WatcherOutbox(context).use{assertEquals(setOf(groups.first().key),it.scannedSources(f.slot))}
   }finally{WatcherAutomation.lock.unlock()}
   assertEquals(Result.success(),kick.doWork());assertEquals(id,kick.id)
   assertEquals(listOf(groups.last().key),f.calls.toList())
   WatcherOutbox(context).use{assertEquals(groups.map{g->g.key}.toSet(),it.scannedSources(f.slot))}
   assertNull(f.prefs.getString("requested_scan",null))
   assertEquals(Result.success(),kick.doWork())
   assertEquals("Completed duplicate cannot scan again",1,f.calls.size)
  }
 }
 @Test fun kickDuringUiInterruptedSourceUnwindIsNotLost()=runBlocking {
  fixture{f->
   val entered=CompletableDeferred<Unit>();val release=CompletableDeferred<Unit>()
   f.scanAction={entered.complete(Unit);release.await();throw IllegalStateException("SCAN_PORT_LOST")}
   val owner=async(Dispatchers.Default){f.worker().doWork()}
   try {
    withTimeout(5000){entered.await()}
    WatcherAutomation.uiVisible=true
    val kick=f.worker()
    assertEquals(Result.retry(),kick.doWork())
    release.complete(Unit)
    assertEquals(Result.success(),withTimeout(5000){owner.await()})
    assertEquals("WAITING_UI",WatcherScanStatus.read(context).phase)
    assertEquals(0,f.continuations)
    assertEquals(f.request,f.prefs.getString("requested_scan",null))
    WatcherOutbox(context).use{assertFalse(it.scanned(f.slot,groups.last().key))}
    WatcherAutomation.uiVisible=false;f.scanAction={validResult(it)}
    assertEquals(Result.success(),kick.doWork())
    assertEquals(listOf(groups.last().key,groups.last().key),f.calls.toList())
   }finally{release.complete(Unit);owner.cancelAndJoin()}
  }
 }
 @Test fun disabledOrUserStoppedCycleCannotBeRevivedByRetainedKick()=runBlocking {
  fixture{f->
   val kick=f.worker()
   WatcherAutomation.lock.lock()
   try {
    assertEquals(Result.retry(),kick.doWork())
    f.prefs.edit().putBoolean("enabled",false).commit()
    assertEquals(Result.success(),kick.doWork())
   }finally{WatcherAutomation.lock.unlock()}
   assertTrue(f.calls.isEmpty());assertEquals(f.request,f.prefs.getString("requested_scan",null))
   f.prefs.edit().putBoolean("enabled",true).commit()
   ScanUserControl.stop(context,{}, {})
   assertTrue(ScanUserControl.isStopped(context,f.slot))
   assertEquals(Result.success(),kick.doWork())
   assertTrue(f.calls.isEmpty());assertEquals(0,f.lookups)
   assertEquals("STOPPED",WatcherScanStatus.read(context).phase)
   WatcherOutbox(context).use{assertEquals(setOf(groups.first().key),it.scannedSources(f.slot))}
  }
 }
}
