package pl.jakubokruszek.flipwatcher.geckopoc
import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
@RunWith(AndroidJUnit4::class)
class ProfileWatcherInstrumentedTest {
    private val context:Context=ApplicationProvider.getApplicationContext()
    private val device="12345678-1234-1234-1234-123456789012"
    @Test fun actualProfileRendererCapturesOwnTextGraphicAndOcrPhotoAndFreezesTypedOutbox()=runBlocking {
        val source=WatcherGroup("61563667387467","Dawid Trojanowski","PROFILE")
        val server=LoopbackFixtureServer(pages=mapOf("/profile.php" to "desktop-profile-offers")){name->runCatching{context.assets.open(name).bufferedReader().use{it.readText()}}.getOrNull()}
        context.deleteDatabase("watcher-outbox-v1.db")
        try {
            val saved=ProfileWatcherScan(context).runFixture(source,"http://127.0.0.1:${server.port}/profile.php?id=${source.id}"){true}
            assertTrue(saved.rows.none{it.postId=="999999999999"})
            for(id in listOf("1655103482946823","pfbidAbCdEf0123456789")){
                val row=checkNotNull(saved.rows.find{it.postId==id})
                assertEquals(source.postUrl(id),row.permalink);assertEquals("SELL_PROPERTY",row.intent)
                assertEquals(368000.0,row.price);assertEquals(62.4,row.area)
                assertTrue("Own profile image $id must be actual stored pixels: ${saved.captureStats}; captured=${saved.photos.map{it.postId}}",saved.photos.any{it.postId==id&&it.jpeg.isNotEmpty()})
            }
            val commentPost=checkNotNull(saved.rows.find{it.postId=="1655103482946825"});assertEquals(339000.0,commentPost.price);assertEquals(42.42,commentPost.area)
            val selected=saved.rows.first{it.postId=="pfbidAbCdEf0123456789"}
            val frozen=WatcherOutbox(context).use{q->q.enqueue(device,source,saved.copy(rows=listOf(selected),photos=saved.photos.filter{it.postId==selected.postId}));checkNotNull(q.next(device,Long.MAX_VALUE))}
            WatcherOutbox(context).use{q->val item=checkNotNull(q.next(device,Long.MAX_VALUE));assertEquals(frozen.body,item.body);assertEquals(frozen.id,item.id)
                val body=org.json.JSONObject(item.body);assertEquals(3,body.getInt("version"));assertEquals("PROFILE",body.getString("sourceType"));assertEquals(source.id,body.getString("groupId"));assertEquals(source.postUrl(selected.postId),body.getJSONObject("row").getString("permalink"))
                assertNotNull(SavedResultCodec.rows(org.json.JSONArray().put(body.getJSONObject("row")),source.id,true,profile=true))
                assertNull(SavedResultCodec.rows(org.json.JSONArray().put(body.getJSONObject("row")),source.id,true))
            }
        }finally{server.close();context.deleteDatabase("watcher-outbox-v1.db")}
    }
    @Test fun renewedProfileSurfaceRequiresNewFramesAndKeepsActualOwnPhotos()=runBlocking {
        val source=WatcherGroup("61563667387467","Dawid Trojanowski","PROFILE")
        val server=LoopbackFixtureServer(pages=mapOf("/profile.php" to "desktop-profile-offers")){name->runCatching{context.assets.open(name).bufferedReader().use{it.readText()}}.getOrNull()}
        try{
            val saved=ProfileWatcherScan(context).runFixture(source,"http://127.0.0.1:${server.port}/profile.php?id=${source.id}",forceSurfaceRefresh=true,forceSnapshotProbe=true){true}
            assertEquals(1,saved.captureStats["profileSurfaceResets"])
            assertEquals(1,saved.captureStats["fixtureSnapshotFrames"])
            assertTrue((saved.captureStats["profileRenderedFrames"]?:0)>0)
            val id="pfbidAbCdEf0123456789";val row=checkNotNull(saved.rows.find{it.postId==id})
            assertEquals("SELL_PROPERTY",row.intent);assertEquals(368000.0,row.price)
            assertTrue(saved.photos.any{it.postId==id&&it.jpeg.isNotEmpty()})
            assertTrue(saved.rows.none{it.postId=="999999999999"})
        }finally{server.close()}
    }

}
