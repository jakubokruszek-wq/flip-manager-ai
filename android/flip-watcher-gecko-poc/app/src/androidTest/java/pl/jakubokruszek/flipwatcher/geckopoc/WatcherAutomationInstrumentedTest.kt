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
        val server=LoopbackFixtureServer(pages=mapOf(path to "desktop-viewport")){name->runCatching{context.assets.open(name).bufferedReader().use{it.readText()}}.getOrNull()}
        try {
            val saved=BackgroundWatcherScan(context).runFixture("http://127.0.0.1:${server.port}$path"){true}
            assertTrue(saved.rows.isNotEmpty())
            assertTrue(saved.rows.all{it.permalink.startsWith("https://www.facebook.com/groups/$FIXTURE_GROUP_ID/posts/")})
            assertTrue("Background photos must be captured, not inferred from row counters",saved.photos.isNotEmpty())
            assertTrue(saved.photos.all{p->saved.rows.any{it.postId==p.postId}&&p.jpeg.isNotEmpty()})
        }finally{server.close()}
    }
}
