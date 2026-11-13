package pl.jakubokruszek.flipwatcher.geckopoc
import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
@RunWith(AndroidJUnit4::class)
class TextPosterInstrumentedTest {
    private val context:Context=ApplicationProvider.getApplicationContext()
    @Test fun greenOffMarketAndStoryMessageKeepFieldsOwnTextAndActualPreviewPixels()=runBlocking {
        val path="/groups/$FIXTURE_GROUP_ID/"
        val server=LoopbackFixtureServer(pages=mapOf(path to "desktop-green-sale-posters")){name->runCatching{context.assets.open(name).bufferedReader().use{it.readText()}}.getOrNull()}
        try {
            val saved=BackgroundWatcherScan(context).runFixture("http://127.0.0.1:${server.port}$path"){true}
            val green=checkNotNull(saved.rows.find{it.postId=="1655103482946827"})
            assertEquals("SELL_PROPERTY",green.intent);assertEquals(260000.0,green.price);assertEquals(37.64,green.area)
            val body=checkNotNull(saved.postTexts[green.postId]);assertTrue(body.contains("Tatrzańska"));assertFalse(body.contains("FOREIGN COMMENT"))
            for(id in listOf("1655103482946827","1655103482946828")){
                assertTrue("Actual poster pixels required for $id: ${saved.captureStats}",saved.photos.any{it.postId==id&&it.jpeg.isNotEmpty()})
                val row=checkNotNull(saved.rows.find{it.postId==id})
                assertNull(OfferQuality.reason(row,saved.photos.count{it.postId==id}))
            }
        }finally{server.close()}
    }
    @Test fun textOnlyOfferIsVisibleAndOldHeldSnapshotCanBeReleasedWithoutChangingIt()=runBlocking {
        val device="11111111-1111-4111-8111-111111111104"
        val group=WatcherGroups.configured.first();val id="550000000000104"
        val body="OFF-MARKET! sprzedam mieszkanie 37,64m2 Łódź Tatrzańska 66/68 260000zł"
        val row=DesktopRow(id,group.url+"posts/$id/","DOM",260000.0,"EXPLICIT_TOTAL",37.64,null,null,null,null,"SELL_PROPERTY",true,0)
        val saved=SavedResult(System.currentTimeMillis(),listOf(row),emptyList(),emptyList(),mapOf(id to body))
        WatcherOutbox(context).use{q->
            q.enqueue(device,group,saved);val first=checkNotNull(q.next(device,Long.MAX_VALUE))
            assertEquals(body,org.json.JSONObject(first.body).getString("postText"));assertEquals(0,org.json.JSONObject(first.body).getJSONArray("photos").length())
            q.writableDatabase.execSQL("UPDATE outbox SET state='quality_hold' WHERE id=?",arrayOf(first.id))
            assertNull(q.next(device,Long.MAX_VALUE))
            q.enqueue(device,group,saved);val resumed=checkNotNull(q.next(device,Long.MAX_VALUE))
            assertEquals(first.id,resumed.id);assertEquals(first.body,resumed.body)
        }
        kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.Main){
            val panel=OffersPanel(context,onOpen={},onReport={})
            panel.showRows(listOf(row),postTexts=mapOf(id to body))
            assertEquals(body,panel.findViewWithTag<android.widget.TextView>("poc.offer.text.$id")?.text?.toString())
        }
    }

}
