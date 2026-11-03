package pl.jakubokruszek.flipwatcher.geckopoc

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Before
import org.junit.After
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScanStatusInstrumentedTest {
    private val context:Context=ApplicationProvider.getApplicationContext()
    private val credentials=WatcherLink.Credentials("12345678-1234-1234-1234-123456789012","synthetic-unused-token")
    private var prefsBackup:Map<String,*> = emptyMap<String,Any>()
    private var oldVisible=false
    @Before fun prepare(){
        prefsBackup=WatcherAutomation.preferences(context).all.toMap();oldVisible=WatcherAutomation.uiVisible
        WatcherAutomation.configure(context,false)
        context.getSharedPreferences("watcher-scan-status-v1",Context.MODE_PRIVATE).edit().clear().commit()
        WatcherAutomation.preferences(context).edit().clear().putBoolean("enabled",true).putString("requested_scan","status-test").putLong("schedule_since",Long.MAX_VALUE).commit()
        WatcherAutomation.uiVisible=false;context.deleteDatabase("watcher-outbox-v1.db")
    }
    @After fun cleanup(){
        WatcherAutomation.configure(context,false)
        val editor=WatcherAutomation.preferences(context).edit().clear()
        for((key,value) in prefsBackup)when(value){is String->editor.putString(key,value);is Boolean->editor.putBoolean(key,value);is Long->editor.putLong(key,value);is Int->editor.putInt(key,value)}
        editor.commit();WatcherAutomation.uiVisible=oldVisible
        context.getSharedPreferences("watcher-scan-status-v1",Context.MODE_PRIVATE).edit().clear().commit()
        context.deleteDatabase("watcher-outbox-v1.db")
    }
    private fun worker(missingCredentials:Boolean=false,groups:List<WatcherGroup> = WatcherGroups.configured.take(2),scan:suspend (WatcherGroup,(String)->Unit)->SavedResult)=
        androidx.work.testing.TestListenableWorkerBuilder<WatcherAutomationWorker>(context).setWorkerFactory(object:androidx.work.WorkerFactory(){
            override fun createWorker(appContext:Context,name:String,parameters:androidx.work.WorkerParameters):androidx.work.ListenableWorker=
                object:WatcherAutomationWorker(appContext,parameters){
                    override fun credentials(context:Context)=if(missingCredentials)null else this@ScanStatusInstrumentedTest.credentials
                    override fun groups(credentials:WatcherLink.Credentials)=groups
                    override suspend fun scan(group:WatcherGroup,progress:(String)->Unit)=scan.invoke(group,progress)
                }
        }).build()
    @Test fun failedGroupIsReportedAndManualRequestResumesWithoutRescanningSavedGroups()=runBlocking {
        val first=WatcherGroups.configured[0];val second=WatcherGroups.configured[1]
        val calls=mutableListOf<String>();var fail=true
        suspend fun scan(group:WatcherGroup,progress:(String)->Unit):SavedResult {
            calls+=group.id;progress("READING")
            if(group==first&&fail){fail=false;error("GROUP_LOAD_ERROR")}
            return SavedResult(System.currentTimeMillis(),emptyList(),emptyList(),emptyList())
        }
        assertEquals(androidx.work.ListenableWorker.Result.retry(),worker(scan=::scan).doWork())
        val partial=WatcherScanStatus.read(context)
        assertEquals("RETRY",partial.phase);assertEquals("GROUP_LOAD_ERROR",partial.reason);assertEquals(1,partial.done);assertEquals(2,partial.total);assertEquals(0L,partial.lastSuccess)
        assertEquals("status-test",WatcherAutomation.preferences(context).getString("requested_scan",null))
        assertEquals(androidx.work.ListenableWorker.Result.success(),worker(scan=::scan).doWork())
        val done=WatcherScanStatus.read(context);assertEquals("DONE",done.phase);assertEquals(2,done.done);assertTrue(done.lastSuccess>0)
        assertNull(WatcherAutomation.preferences(context).getString("requested_scan",null))
        assertEquals(2,calls.count{it==first.id});assertEquals(1,calls.count{it==second.id})
    }
    @Test fun missingPairingAndVisibleBrowserHaveDistinctPersistentReasons()=runBlocking {
        val unused:suspend (WatcherGroup,(String)->Unit)->SavedResult={_,_->error("Browser must not start")}
        assertEquals(androidx.work.ListenableWorker.Result.retry(),worker(missingCredentials=true,scan=unused).doWork())
        assertEquals("PAIRING_REQUIRED",WatcherScanStatus.read(context).reason)
        WatcherAutomation.uiVisible=true
        assertEquals(androidx.work.ListenableWorker.Result.success(),worker(scan=unused).doWork())
        assertEquals("WAITING_UI",WatcherScanStatus.read(context).phase)
        assertEquals("WAITING_FOR_BACKGROUND",WatcherScanStatus.read(context).reason)
        assertEquals("status-test",WatcherAutomation.preferences(context).getString("requested_scan",null))
    }
    @Test fun liveStatusScreenRefreshesWithoutTakingBrowserOwnershipOrLosingStatus(){
        WatcherScanStatus.begin(context,"live-test")
        WatcherScanStatus.update(context,"live-test"){it.copy(phase="READING",group="Grupa testowa",position=2,total=11,done=1,posts=6,photos=3)}
        ActivityScenario.launch(ScanStatusActivity::class.java).use{scenario->
            val deadline=android.os.SystemClock.elapsedRealtime()+10_000
            var shown=false
            while(!shown&&android.os.SystemClock.elapsedRealtime()<deadline){
                scenario.onActivity{a->shown=a.findViewById<android.view.ViewGroup>(android.R.id.content).findViewWithTag<android.widget.TextView>("scan.live.status").text.toString().contains("Grupy ukończone: 1/11")}
                if(!shown)Thread.sleep(100)
            }
            assertTrue(shown);assertFalse("Read-only progress must not pause background scanning",WatcherAutomation.uiVisible)
            WatcherScanStatus.update(context,"live-test"){it.copy(done=2,photos=5)}
            var refreshed=false
            while(!refreshed&&android.os.SystemClock.elapsedRealtime()<deadline){
                scenario.onActivity{a->refreshed=a.findViewById<android.view.ViewGroup>(android.R.id.content).findViewWithTag<android.widget.TextView>("scan.live.status").text.toString().contains("Grupy ukończone: 2/11")}
                if(!refreshed)Thread.sleep(100)
            }
            assertTrue(refreshed);assertFalse(WatcherAutomation.uiVisible)
            val screenshot=InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot()
            try{context.openFileOutput("scan-status-live.png",Context.MODE_PRIVATE).use{screenshot.compress(android.graphics.Bitmap.CompressFormat.PNG,100,it)}}finally{screenshot.recycle()}
        }
        assertEquals(5,WatcherScanStatus.read(context).photos)
        WatcherScanStatus.begin(context,"new-owner");WatcherScanStatus.update(context,"live-test"){it.copy(photos=999)}
        assertEquals("new-owner",WatcherScanStatus.read(context).run);assertEquals(0,WatcherScanStatus.read(context).photos)
    }
}
