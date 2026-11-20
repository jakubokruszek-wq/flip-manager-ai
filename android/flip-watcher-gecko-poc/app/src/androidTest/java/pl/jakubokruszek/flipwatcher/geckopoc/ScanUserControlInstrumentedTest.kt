package pl.jakubokruszek.flipwatcher.geckopoc

import android.content.Context
import android.content.SharedPreferences
import android.graphics.Bitmap
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.time.Instant
import java.time.ZoneId
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class ScanUserControlInstrumentedTest {
    private val context:Context=ApplicationProvider.getApplicationContext()
    private fun restore(prefs:SharedPreferences,values:Map<String,*>) {
        val edit=prefs.edit().clear()
        for((key,value)in values)when(value){
            is String->edit.putString(key,value);is Boolean->edit.putBoolean(key,value)
            is Long->edit.putLong(key,value);is Int->edit.putInt(key,value);is Float->edit.putFloat(key,value)
            is Set<*>->edit.putStringSet(key,value.filterIsInstance<String>().toSet())
        }
        check(edit.commit())
    }
    @Test fun stopRetainsFrozenPhotoTextAndReceiptsAndCannotBeOverwrittenByOldRun(){
        val prefs=WatcherAutomation.preferences(context);val backup=prefs.all.toMap()
        val status=context.getSharedPreferences("watcher-scan-status-v1",Context.MODE_PRIVATE);val oldStatus=status.all.toMap()
        val request=UUID.randomUUID().toString();val slot=WatcherCaptureReport.cycle("manual/$request")
        val group=WatcherGroups.configured.first();val device=UUID.randomUUID().toString()
        val id=(System.currentTimeMillis()*100L+17L).toString()
        val row=DesktopRow(id,group.postUrl(id),"DOM",430000.0,"EXPLICIT_TOTAL",42.0,2,"Bałuty",null,null,"SELL_PROPERTY",true,1)
        val bitmap=Bitmap.createBitmap(192,144,Bitmap.Config.ARGB_8888).apply{eraseColor(android.graphics.Color.GREEN)}
        val photo=try{ResultArchive.photo(id,0,false,bitmap)}finally{bitmap.recycle()}
        val sample=SavedResult(System.currentTimeMillis(),listOf(row),emptyList(),listOf(photo),mapOf(id to "Sprzedam mieszkanie 42m2 w Łodzi za 430000 zł."))
        val cancelled=mutableListOf<String>();val tags=mutableListOf<String>()
        fun frozen(q:WatcherOutbox)=q.readableDatabase.rawQuery("SELECT id,hex(body),state FROM outbox WHERE device=? ORDER BY id",arrayOf(device)).use{c->buildString{while(c.moveToNext())append(c.getString(0)).append(c.getString(1)).append(c.getString(2))}}
        try {
            prefs.edit().clear().putBoolean("enabled",true).putString("scan_minutes","300,785,1231")
                .putString("capture_cycle",slot).putString("requested_scan",request).putString(ManualScanHandoff.KEY,request)
                .putString("completed_slot","previous-completed-window").putLong("continuation_at",System.currentTimeMillis()+30000).commit()
            WatcherOutbox(context).use{q->
                q.enqueue(device,group,sample);q.completeScan(slot,group.key)
                val before=frozen(q);assertTrue(before.isNotEmpty())
                val oldRun=UUID.randomUUID().toString();WatcherScanStatus.begin(context,oldRun)
                WatcherScanStatus.update(context,oldRun){it.copy(phase="READING",posts=7,photos=3,total=52,done=1)}
                val now=Instant.now();val zone=ZoneId.systemDefault();val schedule=WatcherAutomation.schedule(context)
                val current=WatcherCaptureReport.cycle(AutomationPolicy.current(now,zone,schedule).key)
                val next=WatcherCaptureReport.cycle(AutomationPolicy.current(AutomationPolicy.next(now,zone,schedule).plusSeconds(1),zone,schedule).key)
                ScanUserControl.stop(context,{cancelled.add(it);Unit},{tags.add(it);Unit})
                assertTrue(ScanUserControl.isStopped(context,slot));assertTrue(ScanUserControl.isStopped(context,current))
                assertFalse(ScanUserControl.isStopped(context,next));assertTrue(WatcherAutomation.enabled(context))
                assertEquals("300,785,1231",prefs.getString("scan_minutes",null));assertEquals("previous-completed-window",prefs.getString("completed_slot",null))
                assertNull(prefs.getString("requested_scan",null));assertNull(prefs.getString(ManualScanHandoff.KEY,null));assertFalse(prefs.contains("continuation_at"))
                assertEquals(before,frozen(q));assertTrue(q.scanned(slot,group.key))
                val stopped=WatcherScanStatus.read(context);assertEquals("STOPPED",stopped.phase);assertEquals(7,stopped.posts);assertEquals(3,stopped.photos);assertNotEquals(oldRun,stopped.run)
                WatcherScanStatus.update(context,oldRun){it.copy(phase="READING",posts=999)};WatcherScanStatus.finish(context,oldRun,"DONE");WatcherScanStatus.beat(context,oldRun)
                WatcherScanStatus.begin(context,oldRun,allowed={!ScanUserControl.isStopped(context,slot)})
                assertEquals(stopped,WatcherScanStatus.read(context))
                assertFalse(cancelled.contains("watcher-calendar-v1"));assertFalse(cancelled.any{it.startsWith("watcher-window-")})
                assertEquals(setOf("watcher-retry-v1","watcher-background-kick-v2",WatcherAutomation.CONTINUATION_TAG,WatcherAutomation.RECOVERY_WORK),cancelled.toSet())
                assertEquals(listOf(WatcherAutomation.CONTINUATION_TAG),tags)
            }
        }finally{
            restore(prefs,backup);restore(status,oldStatus)
            WatcherOutbox(context).use{q->q.writableDatabase.delete("outbox","device=?",arrayOf(device));q.writableDatabase.delete("scans","slot=?",arrayOf(slot))}
        }
    }
    @Test fun freshStartUsesNewReceiptNamespaceWithoutDeletingEarlierProgress(){
        val prefs=WatcherAutomation.preferences(context);val backup=prefs.all.toMap()
        val status=context.getSharedPreferences("watcher-scan-status-v1",Context.MODE_PRIVATE);val oldStatus=status.all.toMap()
        val group=WatcherGroups.configured.first();val previous=UUID.randomUUID().toString();val oldSlot=WatcherCaptureReport.cycle("manual/$previous")
        try {
            prefs.edit().clear().putBoolean("enabled",true).putString("capture_cycle",oldSlot)
                .putString("requested_scan",previous).putString(ManualScanHandoff.KEY,previous).commit()
            WatcherOutbox(context).use{q->q.completeScan(oldSlot,group.key)}
            ActivityScenario.launch(ScanStatusActivity::class.java).use{
                try {
                    assertTrue(RenderComparisonVisibility.hasStartedActivity)
                    ScanUserControl.restartFromZero(context,{},{})
                    val request=checkNotNull(prefs.getString("requested_scan",null));assertNotEquals(previous,request)
                    assertEquals(request,prefs.getString(ManualScanHandoff.KEY,null))
                    val fresh=WatcherCaptureReport.cycle("manual/$request")
                    assertFalse(ScanUserControl.isStopped(context,fresh));assertTrue(ScanUserControl.isStopped(context,oldSlot))
                    WatcherOutbox(context).use{q->assertTrue(q.scanned(oldSlot,group.key));assertFalse(q.scanned(fresh,group.key))}
                    assertEquals("QUEUED",WatcherScanStatus.read(context).phase)
                }finally{
                    // Restore before Activity stops so its lifecycle handoff cannot queue this fixture request.
                    restore(prefs,backup);restore(status,oldStatus)
                }
            }
        }finally{
            restore(prefs,backup);restore(status,oldStatus)
            WatcherOutbox(context).use{q->q.writableDatabase.delete("scans","slot=?",arrayOf(oldSlot))}
        }
    }
}
