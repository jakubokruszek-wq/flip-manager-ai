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
    private var continuations=0
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
    @Test fun sourceSummaryPersistsContinuationAndSeparatesUnknownFromZero(){
        val groups=listOf(WatcherGroup("123456","Grupa testowa"),WatcherGroup("654321","Profil testowy","PROFILE"))
        context.getSharedPreferences("watcher-source-summary-v1",Context.MODE_PRIVATE).edit().clear().commit()
        WatcherScanSummary.start(context,"test-cycle",groups)
        val start=WatcherScanSummary.text(context)
        assertTrue(start.contains("rozpoczęcie:"));assertTrue(start.contains("niepotwierdzone"));assertTrue(start.contains("jeszcze nie odczytano"))
        WatcherScanSummary.source(context,"test-cycle",groups[0],0,"")
        WatcherScanSummary.source(context,"test-cycle",groups[1],null,"PROFILE_NOT_READY")
        WatcherScanSummary.start(context,"test-cycle",groups)
        val resumed=WatcherScanSummary.text(context)
        assertTrue(resumed.contains("Grupa: Grupa testowa — nowe: 0"));assertTrue(resumed.contains("Profil: Profil testowy — brak potwierdzonego odczytu"))
        WatcherScanSummary.finish(context);assertFalse(WatcherScanSummary.text(context).contains("Zakończenie: niepotwierdzone"))
        context.getSharedPreferences("watcher-source-summary-v1",Context.MODE_PRIVATE).edit().clear().commit()
    }
    @Test fun twoHundredSourcesStayCollapsedAndCurrentStateAndResumeAreFirst(){
        val summary=context.getSharedPreferences("watcher-source-summary-v1",Context.MODE_PRIVATE)
        val backup=summary.getString("current",null)
        val groups=(0 until 200).map{WatcherGroup("source$it","Źródło testowe #%03d".format(it),if(it%3==0)"PROFILE"else"GROUP")}
        try{
            WatcherScanSummary.start(context,"compact-cycle",groups)
            WatcherScanSummary.source(context,"compact-cycle",groups.first(),0,"")
            val report=WatcherCaptureReport.create(context,"compact-cycle","compact-run",groups.first(),null,"SOURCE_TIMEOUT",62_000L)
            WatcherOutbox(context).use{it.report(credentials.deviceId,"compact-cycle",groups.first().key,report)}
            WatcherScanStatus.begin(context,"compact-run")
            WatcherScanStatus.update(context,"compact-run"){it.copy(phase="READING",total=200,done=1,position=2,group="Bieżąca grupa")}
            val compact=WatcherScanStatus.report(context)
            assertTrue(compact.startsWith("Odczyt postów i zdjęć"))
            assertTrue("The main report must stay bounded",compact.lines().size<40)
            assertFalse(compact.contains(groups.last().name))
            val details=WatcherScanStatus.sourceReport(context)
            assertTrue(details.contains(groups.last().name));assertTrue(details.contains("czas: 1 min 2 s"))
            assertEquals("Each source must be listed once",1,Regex(Regex.escape(groups.first().name)).findAll(details).count())
            ActivityScenario.launch(ScanStatusActivity::class.java).use{scenario->
                InstrumentationRegistry.getInstrumentation().waitForIdleSync()
                scenario.onActivity{a->
                    val root=a.findViewById<android.view.ViewGroup>(android.R.id.content)
                    val sources=root.findViewWithTag<android.widget.TextView>("scan.live.sources")
                    val journal=root.findViewWithTag<android.widget.TextView>("scan.live.journal")
                    assertEquals(android.view.View.GONE,sources.visibility);assertEquals("",sources.text.toString())
                    assertEquals(android.view.View.GONE,journal.visibility);assertEquals("",journal.text.toString())
                    val resume=root.findViewWithTag<android.widget.Button>("scan.resume")
                    assertTrue("Resume must be visible above the long report",resume.getGlobalVisibleRect(android.graphics.Rect()))
                    root.findViewWithTag<android.widget.Button>("scan.sources.toggle").performClick()
                }
                val deadline=android.os.SystemClock.elapsedRealtime()+10_000
                var expanded=false
                while(!expanded&&android.os.SystemClock.elapsedRealtime()<deadline){
                    scenario.onActivity{a->expanded=a.findViewById<android.view.ViewGroup>(android.R.id.content).findViewWithTag<android.widget.TextView>("scan.live.sources").text.toString().contains(groups.last().name)}
                    if(!expanded)Thread.sleep(100)
                }
                assertTrue("Expanded source list must load all 200 sources",expanded)
                scenario.onActivity{a->
                    val root=a.findViewById<android.view.ViewGroup>(android.R.id.content)
                    root.findViewWithTag<android.widget.Button>("scan.sources.toggle").performClick()
                    assertEquals(android.view.View.GONE,root.findViewWithTag<android.widget.TextView>("scan.live.sources").visibility)
                    assertEquals("",root.findViewWithTag<android.widget.TextView>("scan.live.sources").text.toString())
                    root.findViewWithTag<android.widget.Button>("scan.journal.toggle").performClick()
                }
                scenario.recreate()
                scenario.onActivity{a->
                    val root=a.findViewById<android.view.ViewGroup>(android.R.id.content)
                    assertEquals(android.view.View.GONE,root.findViewWithTag<android.widget.TextView>("scan.live.sources").visibility)
                    assertEquals(android.view.View.VISIBLE,root.findViewWithTag<android.widget.TextView>("scan.live.journal").visibility)
                }
                assertFalse("Progress view must not stop the browser",WatcherAutomation.uiVisible)
            }
        }finally{summary.edit().putString("current",backup).commit()}
    }
    private fun worker(missingCredentials:Boolean=false,groups:List<WatcherGroup> = WatcherGroups.configured.take(2),scan:suspend (WatcherGroup,(String)->Unit)->SavedResult)=
        androidx.work.testing.TestListenableWorkerBuilder<WatcherAutomationWorker>(context).setWorkerFactory(object:androidx.work.WorkerFactory(){
            override fun createWorker(appContext:Context,name:String,parameters:androidx.work.WorkerParameters):androidx.work.ListenableWorker=
                object:WatcherAutomationWorker(appContext,parameters){
                    override fun continueScan(context:Context){continuations++}
                    override fun credentials(context:Context)=if(missingCredentials)null else this@ScanStatusInstrumentedTest.credentials
                    override fun groups(credentials:WatcherLink.Credentials)=groups
                    override fun sendReport(credentials:WatcherLink.Credentials,item:WatcherOutbox.Item){}
                    override suspend fun scan(group:WatcherGroup,progress:(String)->Unit)=scan.invoke(group,progress)
                }
        }).build()
    @Test fun failedGroupIsReportedAndManualRequestResumesWithoutRescanningSavedGroups()=runBlocking {
        val first=WatcherGroups.configured[0];val second=WatcherGroups.configured[1]
        val calls=mutableListOf<String>();var fail=true
        suspend fun scan(group:WatcherGroup,progress:(String)->Unit):SavedResult {
            calls+=group.id;progress("READING")
            if(group==first&&fail){fail=false;error("NETWORK_UNAVAILABLE")}
            // Measured non-offer post proves a healthy read, unlike an unmeasured empty stub.
            val row=DesktopRow("550000000000099",group.url+"posts/550000000000099/","DOM",null,"NONE",null,null,null,null,null,"OTHER",false,0,"INTENT")
            return SavedResult(System.currentTimeMillis(),listOf(row),emptyList(),emptyList(),captureStats=DesktopProtocol.emptyStats()+mapOf("pageVisible" to 1,"scrollMoves" to 1))
        }
        assertEquals(androidx.work.ListenableWorker.Result.success(),worker(scan=::scan).doWork())
        assertEquals(1,continuations)
        val partial=WatcherScanStatus.read(context)
        assertEquals("RETRY",partial.phase);assertEquals("NETWORK_UNAVAILABLE",partial.reason);assertEquals(1,partial.done);assertEquals(2,partial.attempted);assertEquals(1,partial.retrying);assertEquals(2,partial.total);assertEquals(0L,partial.lastSuccess)
        assertEquals("status-test",WatcherAutomation.preferences(context).getString("requested_scan",null))
        assertEquals(androidx.work.ListenableWorker.Result.success(),worker(scan=::scan).doWork())
        val done=WatcherScanStatus.read(context);assertEquals("DONE",done.phase);assertEquals(2,done.done);assertEquals(2,done.attempted);assertEquals(0,done.retrying);assertTrue(done.lastSuccess>0)
        assertNull(WatcherAutomation.preferences(context).getString("requested_scan",null))
        assertEquals(2,calls.count{it==first.id});assertEquals(1,calls.count{it==second.id})
    }
    @Test fun exhaustedRenderingClosesWithWarningWithoutReplayingTheWholeSource()=runBlocking {
        val first=WatcherGroups.configured[0]
        val calls=mutableListOf<String>()
        suspend fun scan(group:WatcherGroup,progress:(String)->Unit):SavedResult {
            calls+=group.id;progress("READING")
            if(group==first)error("GROUP_RENDER_RETRY_FAILED")
            val row=DesktopRow("550000000000099",group.url+"posts/550000000000099/","DOM",null,"NONE",null,null,null,null,null,"OTHER",false,0,"INTENT")
            return SavedResult(System.currentTimeMillis(),listOf(row),emptyList(),emptyList(),captureStats=DesktopProtocol.emptyStats()+mapOf("pageVisible" to 1,"scrollMoves" to 1))
        }
        assertEquals(androidx.work.ListenableWorker.Result.success(),worker(scan=::scan).doWork())
        val partial=WatcherScanStatus.read(context)
        assertEquals("PARTIAL",partial.phase);assertEquals("CAPTURE_PARTIAL",partial.reason)
        assertEquals(2,partial.done);assertEquals(0,partial.retrying);assertEquals(0,continuations)
        assertEquals(0L,partial.lastSuccess)
        worker(scan=::scan).doWork();assertEquals(2,calls.size)
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
    @Test fun continuationUsesFreshFixedDelayAndResumeKeepsTheSameCycleAndReceipts(){
        val prefs=WatcherAutomation.preferences(context)
        val cycle=WatcherCaptureReport.cycle("manual/status-test")
        val group=WatcherGroups.configured.first()
        prefs.edit().putString("capture_cycle",cycle).putString("last_attempted_source",group.key).commit()
        WatcherOutbox(context).use{it.completeScan(cycle,group.key)}
        WatcherScanStatus.begin(context,"continuation-test")
        WatcherScanStatus.update(context,"continuation-test"){it.copy(done=20,total=33,posts=19,photos=4)}
        WatcherScanStatus.finish(context,"continuation-test","RETRY","BATCH_CONTINUE")
        var queued=0
        repeat(3){
            WatcherAutomation.continuation(context){name,policy,work->
                queued++;assertEquals(WatcherAutomation.CONTINUATION_TAG,name)
                assertEquals(androidx.work.ExistingWorkPolicy.APPEND_OR_REPLACE,policy)
                assertEquals(30_000L,work.workSpec.initialDelay)
                assertEquals(0,work.workSpec.runAttemptCount)
                assertEquals(androidx.work.NetworkType.CONNECTED,work.workSpec.constraints.requiredNetworkType)
            }
        }
        assertEquals(3,queued)
        assertTrue(prefs.getLong("continuation_at",0)>System.currentTimeMillis())
        assertTrue(WatcherScanStatus.report(context).contains("Plan wznowienia tej samej próby:"))
        WatcherAutomation.resume(context){work->
            assertEquals(0L,work.workSpec.initialDelay)
            assertTrue(work.tags.contains(WatcherAutomation.CONTINUATION_TAG))
        }
        assertEquals("status-test",prefs.getString("requested_scan",null))
        assertEquals(cycle,prefs.getString("capture_cycle",null))
        assertEquals(group.key,prefs.getString("last_attempted_source",null))
        WatcherOutbox(context).use{assertTrue(it.scanned(cycle,group.key))}
        val state=WatcherScanStatus.read(context)
        assertEquals("QUEUED",state.phase);assertEquals(20,state.done);assertEquals(33,state.total);assertEquals(19,state.posts);assertEquals(4,state.photos)
        assertEquals(0L,prefs.getLong("continuation_at",0))
        WatcherScanStatus.begin(context,"already-finished")
        WatcherScanStatus.update(context,"already-finished"){it.copy(done=33,total=33)}
        WatcherScanStatus.finish(context,"already-finished","PARTIAL","CAPTURE_PARTIAL")
        val finished=runCatching{WatcherAutomation.resume(context){error("Must not enqueue a finished cycle")}}
        assertEquals("SCAN_ALREADY_FINISHED",finished.exceptionOrNull()?.message)
        assertEquals("PARTIAL",WatcherScanStatus.read(context).phase)
    }
    @Test fun liveStatusScreenRefreshesWithoutTakingBrowserOwnershipOrLosingStatus(){
        WatcherScanStatus.begin(context,"live-test")
        WatcherScanStatus.update(context,"live-test"){it.copy(phase="READING",group="Grupa testowa",position=2,total=11,done=1,posts=6,photos=3)}
        ActivityScenario.launch(ScanStatusActivity::class.java).use{scenario->
            val deadline=android.os.SystemClock.elapsedRealtime()+10_000
            var shown=false
            while(!shown&&android.os.SystemClock.elapsedRealtime()<deadline){
                scenario.onActivity{a->shown=a.findViewById<android.view.ViewGroup>(android.R.id.content).findViewWithTag<android.widget.TextView>("scan.live.status").text.toString().contains("Źródła z próbą odczytu: 1/11")}
                if(!shown)Thread.sleep(100)
            }
            assertTrue(shown);assertFalse("Read-only progress must not pause background scanning",WatcherAutomation.uiVisible)
            WatcherScanStatus.update(context,"live-test"){it.copy(done=2,photos=5)}
            var refreshed=false
            while(!refreshed&&android.os.SystemClock.elapsedRealtime()<deadline){
                scenario.onActivity{a->refreshed=a.findViewById<android.view.ViewGroup>(android.R.id.content).findViewWithTag<android.widget.TextView>("scan.live.status").text.toString().contains("Źródła z próbą odczytu: 2/11")}
                if(!refreshed)Thread.sleep(100)
            }
            assertTrue(refreshed);assertFalse(WatcherAutomation.uiVisible)
            val screenshot=InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot()
            try{context.openFileOutput("scan-status-live.png",Context.MODE_PRIVATE).use{screenshot.compress(android.graphics.Bitmap.CompressFormat.PNG,100,it)}}finally{screenshot.recycle()}
        }
        assertEquals(5,WatcherScanStatus.read(context).photos)
        WatcherScanStatus.finish(context,"live-test","DONE")
        val completed=WatcherScanStatus.read(context).lastSuccess
        WatcherScanStatus.request(context)
        assertEquals("QUEUED",WatcherScanStatus.read(context).phase);assertEquals(0,WatcherScanStatus.read(context).photos);assertEquals(0L,WatcherScanStatus.read(context).started);assertEquals(completed,WatcherScanStatus.read(context).lastSuccess)
        WatcherScanStatus.begin(context,"new-owner");WatcherScanStatus.update(context,"live-test"){it.copy(photos=999)}
        assertEquals("new-owner",WatcherScanStatus.read(context).run);assertEquals(0,WatcherScanStatus.read(context).photos)
    }
}
