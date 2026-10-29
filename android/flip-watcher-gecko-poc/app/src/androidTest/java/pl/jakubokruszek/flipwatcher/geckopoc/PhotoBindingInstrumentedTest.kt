package pl.jakubokruszek.flipwatcher.geckopoc

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.util.Base64
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.*
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.mozilla.geckoview.GeckoSession

/** Local rendered pixels + synthetic CDN identity aliases; never fetches a real CDN or Facebook. */
@RunWith(AndroidJUnit4::class)
class PhotoBindingInstrumentedTest {
 @Test fun signedCdnVariantInUnboundArticleCapturesReadablePixels()=runCase("article")
 @Test fun explicitOwnPhotoLinkWithoutArticleCapturesReadablePixels()=runCase("anchor")
 @Test fun sameAssetInForeignArticleIsNotCaptured()=runCase("foreign")
 private fun png():String{
  val b=Bitmap.createBitmap(800,400,Bitmap.Config.ARGB_8888);val c=Canvas(b);c.drawColor(Color.WHITE)
  val p=Paint(Paint.ANTI_ALIAS_FLAG).apply{color=Color.BLACK;textSize=60f}
  c.drawText("Sprzedam mieszkanie",20f,100f,p);c.drawText("260000 zl 45,8 m2",20f,200f,p)
  val out=java.io.ByteArrayOutputStream();b.compress(Bitmap.CompressFormat.PNG,100,out);b.recycle()
  return "data:image/png;base64,"+Base64.encodeToString(out.toByteArray(),Base64.NO_WRAP)
 }
 private fun runCase(mode:String){
  ActivityScenario.launch(GeckoTestHostActivity::class.java).use{scenario->
   var host:GeckoTestHostActivity?=null;scenario.onActivity{host=it}
   runBlocking{withTimeout(60000){withContext(Dispatchers.Main){
    val id="550000000000091";val link="https://www.facebook.com/groups/$FIXTURE_GROUP_ID/posts/$id/"
    val path="/v/t39.30808-6/123456789_987654321_555555555_n.jpg"
    val known="https://scontent-waw2-1.xx.fbcdn.net$path?oh=old&oe=123&_nc_cat=1"
    val rendered="https://scontent-fra3-2.xx.fbcdn.net$path?stp=dst-jpg_s960x960&oh=new&oe=456&_nc_cat=2"
    val story=JSONObject().put("__typename","Story").put("post_id",id).put("permalink_url",link)
      .put("message",JSONObject().put("text","Sprzedam mieszkanie 45,8 m2 za 260000 zł"))
      .put("attachments",org.json.JSONArray().put(JSONObject().put("media",JSONObject().put("__typename","Photo").put("id","880000000000001").put("image",JSONObject().put("uri",known).put("width",800).put("height",400)))))
    val heading=if(mode=="foreign")"<a href='${link.replace(id,"550000000000092")}'>Other post</a>" else "<a href='https://www.facebook.com/'>Author</a>"
    val photo="<a href='https://www.facebook.com/photo/?fbid=880000000000001&amp;set=pcb.$id'><img id='photo' style='display:block;width:600px;height:300px' src='${png()}'></a>"
    val body=if(mode=="anchor")photo else "<div role=article>$heading$photo</div>"
    val html="<!doctype html><title>Bound photo fixture</title><script type='application/json'>$story</script><main>$body</main><script>Object.defineProperty(document.getElementById('photo'),'currentSrc',{get:()=>${JSONObject.quote(rendered)}});</script>"
    val postPath="/groups/$FIXTURE_GROUP_ID/posts/$id/"
    val server=LoopbackFixtureServer(pages=mapOf(postPath to "bound-photo")){name->when(name){"fixtures/home.html"->"<!doctype html><title>Group</title><p>Home</p>";"fixtures/bound-photo.html"->html;else->null}}
    val original=GeckoSession();val source=CollectorChannel(original,fixtureMode=true)
    try{
     source.attach(GeckoHost.collectorExtension(host!!));original.open(GeckoHost.runtime(host!!));host!!.geckoView.setSession(original);original.setActive(true)
     original.loadUri(server.url("/groups/$FIXTURE_GROUP_ID/","home"));assertTrue(source.awaitPort(15000));delay(300)
     val row=DesktopRow(id,link,"DOM",null,"NONE",null,null,null,null,null,"UNKNOWN",false,1,"NO_TEXT")
     var callbacks=0
     val out=ReviewDataRunner.run(host!!.geckoView,original,listOf(row),true,{true},fixtureOrigin="http://127.0.0.1:${server.port}",selectedPostId=id,onBoundPost={channel,r,current,live->
      callbacks++;val images=DesktopThumbnails()
      try{
       assertTrue(channel.reviewImages(r,current,host!!.geckoView,images,true,group=FIXTURE_GROUP_ID,alive=live))
       if(mode=="foreign"){
        assertEquals("NO_IMAGE",channel.reviewImageOutcome);assertTrue(images.ocrRows(id).isEmpty());assertEquals(1,channel.reviewImageDetails.getValue("foreignOwner"))
       }else{
        assertEquals("CAPTURED",channel.reviewImageOutcome);assertEquals(1,channel.reviewImageDetails.getValue("sourceAsset"))
        if(mode=="anchor")assertEquals(1,channel.reviewImageDetails.getValue("anchorOwner"))
        val bitmap=images.ocrRows(id).single().copy(Bitmap.Config.ARGB_8888,false)
        val text=LocalOcr.readOwned(bitmap);assertTrue("Fixture crop did not contain rendered price: $mode",text.contains("260"));assertTrue(live())
       }
      }finally{images.clear()}
     })
     assertEquals(out.summary.report(),"DONE",out.summary.reason);assertEquals(1,callbacks);assertEquals(1,out.summary.opened)
    }finally{source.close();if(host!!.geckoView.session!=null)host!!.geckoView.releaseSession();original.close();server.close()}
   }}}
  }
 }
}
