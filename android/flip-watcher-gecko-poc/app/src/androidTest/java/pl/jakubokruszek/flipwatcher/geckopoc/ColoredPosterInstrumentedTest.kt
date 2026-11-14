package pl.jakubokruszek.flipwatcher.geckopoc
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
@RunWith(AndroidJUnit4::class)
class ColoredPosterInstrumentedTest {
 private val context:Context=ApplicationProvider.getApplicationContext()
 @Test fun actualUnmarkedGreenPanelKeepsFieldsOwnTextAndLabelledCaptureWithoutBorrowingComment()=runBlocking {
  val path="/groups/$FIXTURE_GROUP_ID/"
  val server=LoopbackFixtureServer(pages=mapOf(path to "desktop-unmarked-color-posters")){name->runCatching{context.assets.open(name).bufferedReader().use{it.readText()}}.getOrNull()}
  try {
   val result=BackgroundWatcherScan(context).runFixture("http://127.0.0.1:${server.port}$path"){true}
   val id="1655103482946831";val row=checkNotNull(result.rows.find{it.postId==id})
   assertEquals("SELL_PROPERTY",row.intent);assertEquals(260000.0,row.price);assertEquals(37.64,row.area);assertEquals("Tatrzańska 66/68",row.street)
   val text=checkNotNull(result.postTexts[id]);assertTrue(text.contains("OFF-MARKET"));assertTrue(text.contains("Tatrzańska"));assertFalse(text.contains("999999"))
   for(post in listOf(id,"1655103482946832")){
    val photo=checkNotNull(result.photos.firstOrNull{it.postId==post});val decoded=checkNotNull(BitmapFactory.decodeByteArray(photo.jpeg,0,photo.jpeg.size))
    try {
     assertTrue(decoded.width<=192&&decoded.height<=144)
     assertTrue("Caption band required",Color.red(decoded.getPixel(2,decoded.height-2))<60)
     var light=0;for(y in decoded.height-16 until decoded.height)for(x in 0 until decoded.width)if(Color.red(decoded.getPixel(x,y))>180)light++
     assertTrue("Visible caption pixels required",light>20)
     if(post==id)assertTrue("Captured green panel must survive the caption",Color.green(decoded.getPixel(decoded.width/2,5))>60)
    }finally{decoded.recycle()}
   }
   assertTrue((result.captureStats["groupRenderedFrames"]?:0)>0)
   assertTrue(result.photos.none{it.postId=="1655103482946833"})
   val device=java.util.UUID.randomUUID().toString();val group=WatcherGroup(FIXTURE_GROUP_ID,"fixture")
   WatcherOutbox(context).use{q->q.enqueue(device,group,result);val item=checkNotNull(q.next(device,Long.MAX_VALUE));val body=JSONObject(item.body)
    assertEquals(1,body.getJSONArray("photos").length());assertTrue(body.getString("postText").contains("Tatrzańska"));assertEquals("Tatrzańska 66/68",body.getJSONObject("row").getString("street"))}
  }finally{server.close()}
 }
 @Test fun captionPreservesSourceAndFitsExistingTransferLimits(){
  for((width,height)in listOf(192 to 144,192 to 112,80 to 144)){
   val source=Bitmap.createBitmap(width,height,Bitmap.Config.ARGB_8888);source.eraseColor(Color.GREEN)
   try{val labelled=TextPosterPreview.label(source);try{
    assertFalse(source.isRecycled);assertEquals(Color.GREEN,source.getPixel(0,0));assertTrue(labelled.width<=192&&labelled.height<=144)
    assertEquals(Color.GREEN,labelled.getPixel(labelled.width/2,0))
   }finally{labelled.recycle()}}finally{source.recycle()}
  }
 }
}
