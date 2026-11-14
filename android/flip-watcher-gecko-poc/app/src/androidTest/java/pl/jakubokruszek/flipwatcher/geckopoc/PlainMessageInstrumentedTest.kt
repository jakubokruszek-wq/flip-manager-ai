package pl.jakubokruszek.flipwatcher.geckopoc

import android.content.Context
import android.graphics.BitmapFactory
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class PlainMessageInstrumentedTest {
 private val context:Context=ApplicationProvider.getApplicationContext()
 @Test fun unmarkedOwnSaleBodyAndItsPhotoReachReadyQueueWithoutBorrowingCommentOrSharedText()=runBlocking {
  val path="/groups/$FIXTURE_GROUP_ID/"
  val server=LoopbackFixtureServer(pages=mapOf(path to "desktop-unmarked-plain-sale")){name->runCatching{context.assets.open(name).bufferedReader().use{it.readText()}}.getOrNull()}
  try {
   val result=BackgroundWatcherScan(context).runFixture("http://127.0.0.1:${server.port}$path"){true}
   val id="1655103482946835";val row=checkNotNull(result.rows.find{it.postId==id})
   assertEquals("SELL_PROPERTY",row.intent);assertEquals(339000.0,row.price);assertEquals(42.42,row.area)
   val text=checkNotNull(result.postTexts[id]);assertTrue(text.contains("Retkinia"));assertFalse(text.contains("999999"))
   val photo=checkNotNull(result.photos.firstOrNull{it.postId==id})
   val decoded=checkNotNull(BitmapFactory.decodeByteArray(photo.jpeg,0,photo.jpeg.size))
   try{assertTrue(decoded.width<=192&&decoded.height<=144);assertTrue(android.graphics.Color.red(decoded.getPixel(decoded.width/2,decoded.height/2))>180)}finally{decoded.recycle()}
   for(foreign in listOf("1655103482946836","1655103482946837")){
    assertNull(result.postTexts[foreign]);assertFalse(result.rows.any{it.postId==foreign&&OfferQuality.confirmedSale(it)})
   }
   assertTrue((result.captureStats["groupRenderedFrames"]?:0)>0)
   WatcherOutbox(context).use{q->
    val device=java.util.UUID.randomUUID().toString();q.enqueue(device,WatcherGroup(FIXTURE_GROUP_ID,"fixture"),result)
    val item=checkNotNull(q.next(device,Long.MAX_VALUE));val body=JSONObject(item.body)
    assertEquals(id,body.getJSONObject("row").getString("postId"));assertTrue(body.getString("postText").contains("Retkinia"));assertTrue(body.getJSONArray("photos").length()>0)
   }
  }finally{server.close()}
 }
}
