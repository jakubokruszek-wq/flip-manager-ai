package pl.jakubokruszek.flipwatcher.geckopoc

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class WatcherAutomationInstrumentedTest {
    private val context:Context=ApplicationProvider.getApplicationContext()
    private val device="12345678-1234-1234-1234-123456789012"
    private val group=WatcherGroups.configured.first()
    private fun result(price:Double=430000.0)=SavedResult(System.currentTimeMillis(),listOf(
        DesktopRow("550000000000091",group.url+"posts/550000000000091/","DOM",price,"EXPLICIT_TOTAL",42.0,2,"Bałuty",null,null,"SELL_PROPERTY",true,0)
    ),emptyList(),emptyList())
    @Test fun encryptedQueueSurvivesReopenLostReceiptAndRepeatedScan() {
        context.deleteDatabase("watcher-outbox-v1.db")
        val first=WatcherOutbox(context).use{q->q.enqueue(device,group,result());checkNotNull(q.next(device,Long.MAX_VALUE))}
        val replay=WatcherOutbox(context).use{q->q.enqueue(device,group,result());checkNotNull(q.next(device,Long.MAX_VALUE))}
        assertEquals(first.id,replay.id);assertEquals(first.body,replay.body)
        WatcherOutbox(context).use{q->q.acknowledge(first.id,"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")}
        WatcherOutbox(context).use{q->
            q.enqueue(device,group,result());assertNull(q.next(device,Long.MAX_VALUE))
            q.enqueue(device,group,result(440000.0));val changed=checkNotNull(q.next(device,Long.MAX_VALUE));assertNotEquals(first.id,changed.id)
            q.defer(changed,true);assertNull(q.next(device,Long.MAX_VALUE));q.retry();assertEquals(changed.id,q.next(device,Long.MAX_VALUE)?.id)
            q.readableDatabase.rawQuery("SELECT body FROM outbox WHERE state='pending'",null).use{c->assertTrue(c.moveToFirst());assertFalse(String(c.getBlob(0),Charsets.UTF_8).contains("facebook.com"))}
            q.completeScan("2026-10-30/7",group.id);assertTrue(q.scanned("2026-10-30/7",group.id));assertFalse(q.scanned("2026-10-30/15",group.id))
        }
        context.deleteDatabase("watcher-outbox-v1.db")
    }
    @Test fun actualBackgroundRendererReadsExactRowsAndBoundPhotoWithoutActivity()=runBlocking {
        val path="/groups/$FIXTURE_GROUP_ID/"
        val server=LoopbackFixtureServer(redirects=mapOf(path to path.trimEnd('/')),pages=mapOf(path.trimEnd('/') to "desktop-viewport")){name->runCatching{context.assets.open(name).bufferedReader().use{it.readText()}}.getOrNull()}
        try {
            val saved=BackgroundWatcherScan(context).runFixture("http://127.0.0.1:${server.port}$path"){true}
            assertTrue(saved.rows.isNotEmpty())
            assertTrue(saved.rows.all{it.permalink.startsWith("https://www.facebook.com/groups/$FIXTURE_GROUP_ID/posts/")})
            assertTrue("Background photos must be captured, not inferred from row counters",saved.photos.isNotEmpty())
            assertTrue(saved.photos.all{p->saved.rows.any{it.postId==p.postId}&&p.jpeg.isNotEmpty()})
        }finally{server.close()}
    }
    @Test fun workerDrains31QueuedOffersWhileUiVisibleAndReplaysLostReceiptWithoutDuplicates()=runBlocking {
        context.deleteDatabase("watcher-outbox-v1.db")
        val prefs=WatcherAutomation.preferences(context)
        val oldEnabled=WatcherAutomation.enabled(context);val oldVisible=WatcherAutomation.uiVisible
        val oldCompleted=prefs.getString("completed_slot",null)
        prefs.edit().putBoolean("enabled",true).remove("completed_slot").commit();WatcherAutomation.uiVisible=false
        val accepted=linkedMapOf<String,String>();var calls=0;var loseReceipt=true;var foregroundAttempts=0
        val credentials=WatcherLink.Credentials(device,"synthetic-credential-unused-over-network")
        val factory=object:androidx.work.WorkerFactory(){
            override fun createWorker(appContext:Context,name:String,parameters:androidx.work.WorkerParameters):androidx.work.ListenableWorker =
                object:WatcherAutomationWorker(appContext,parameters){
                    override fun credentials(context:Context)=credentials
                    override fun groups(credentials:WatcherLink.Credentials):List<WatcherGroup> { check(!WatcherAutomation.uiVisible){"Browser must not be used while UI is visible"};return emptyList() }
                    override fun send(credentials:WatcherLink.Credentials,item:WatcherOutbox.Item):String {
                        calls++
                        val old=accepted.putIfAbsent(item.id,item.body)
                        if(old!=null)assertEquals("Retries must preserve the exact frozen body",old,item.body)
                        if(loseReceipt){loseReceipt=false;throw java.io.IOException("Synthetic lost receipt")}
                        return "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
                    }
                }
        }
        fun worker()=androidx.work.testing.TestListenableWorkerBuilder<WatcherAutomationWorker>(context).setWorkerFactory(factory)
            .setForegroundUpdater{_,_,_->
                foregroundAttempts++
                androidx.concurrent.futures.CallbackToFutureAdapter.getFuture<Void>{reply->
                    reply.setException(android.app.ForegroundServiceStartNotAllowedException("Synthetic background start denial"));"denied"
                }
            }.build()
        try {
            WatcherOutbox(context).use { q ->
                repeat(31){index->val post=(550000000000100L+index).toString()
                    val row=result().rows.single().copy(postId=post,permalink=group.url+"posts/$post/")
                    q.enqueue(device,group,result().copy(rows=listOf(row)))
                }
            }
            assertEquals(androidx.work.ListenableWorker.Result.success(),worker().doWork())
            assertEquals(1,accepted.size)
            WatcherOutbox(context).use{it.retry()}
            WatcherAutomation.uiVisible=true
            assertEquals(androidx.work.ListenableWorker.Result.success(),worker().doWork())
            WatcherOutbox(context).use{q->assertNull(q.next(device,Long.MAX_VALUE));assertTrue(q.status().contains("sent: 31"))}
            assertEquals(31,accepted.size);assertEquals(32,calls)
            assertEquals(androidx.work.ListenableWorker.Result.success(),worker().doWork())
            assertEquals("Acknowledged snapshots must not be sent again",32,calls)
            assertEquals("No foreground service may be requested",0,foregroundAttempts)
            WatcherAutomation.lock.lock()
            try {
                assertEquals("Duplicate work must not wait past its Android job budget",
                    androidx.work.ListenableWorker.Result.success(),kotlinx.coroutines.withTimeout(1000){worker().doWork()})
            }finally{WatcherAutomation.lock.unlock()}
        }finally{
            WatcherAutomation.configure(context,false)
            prefs.edit().putBoolean("enabled",oldEnabled).putString("completed_slot",oldCompleted).commit();WatcherAutomation.uiVisible=oldVisible
            context.deleteDatabase("watcher-outbox-v1.db")
        }
    }
}
