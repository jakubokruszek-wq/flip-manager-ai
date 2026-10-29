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
import org.mozilla.geckoview.WebExtension

/** Local PNG delivered by a test-only redirect; actual DOM image URL, no page getter override. */
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
 private data class Lab(val extension:WebExtension,val redirects:java.util.concurrent.atomic.AtomicInteger)
 private suspend fun lab(context:android.content.Context,document:String,image:String,pixels:String):Lab {
  val runtime=GeckoHost.runtime(context)
  val extension=runtime.webExtensionController.ensureBuiltIn("resource://android/assets/ext/photo_lab/","photo-lab@flip-manager.local").await()!!
  val connected=CompletableDeferred<WebExtension.Port>();val configured=CompletableDeferred<Unit>();val redirects=java.util.concurrent.atomic.AtomicInteger()
  extension.setMessageDelegate(object:WebExtension.MessageDelegate{
   override fun onConnect(port:WebExtension.Port){
    if(port.sender.session!=null){port.disconnect();return}
    port.setDelegate(object:WebExtension.PortDelegate{
     override fun onPortMessage(message:Any,p:WebExtension.Port){val j=ScanProtocol.asJson(message)?:return;when(j.optString("type")){"configured"->configured.complete(Unit);"redirected"->redirects.incrementAndGet()}}
    });connected.complete(port)
   }
  },"photo_binding_lab")
  try{
   val port=withTimeout(10000){connected.await()};port.postMessage(JSONObject().put("type","configure").put("document",document).put("image",image).put("pixels",pixels))
   withTimeout(5000){configured.await()};return Lab(extension,redirects)
  }catch(e:Exception){runtime.webExtensionController.uninstall(extension).await();throw e}
 }
 private fun runCase(mode:String){
  ActivityScenario.launch(GeckoTestHostActivity::class.java).use{scenario->
   var host:GeckoTestHostActivity?=null;scenario.onActivity{host=it}
   runBlocking{withTimeout(60000){withContext(Dispatchers.Main){
    val settings=GeckoHost.runtime(host!!).settings
    settings.javaClass.getMethod("setConsoleOutput", Boolean::class.javaPrimitiveType).invoke(settings,true)
    val id="550000000000091";val link="https://www.facebook.com/groups/$FIXTURE_GROUP_ID/posts/$id/"
    val path="/v/t39.30808-6/123456789_987654321_555555555_n.jpg"
    val known="https://scontent-waw2-1.xx.fbcdn.net$path?oh=old&oe=123&_nc_cat=1"
    val rendered="https://scontent-fra3-2.xx.fbcdn.net$path?stp=dst-jpg_s960x960&oh=new&oe=456&_nc_cat=2&_nc_test=$mode"
    val story=JSONObject().put("__typename","Story").put("post_id",id).put("permalink_url",link)
      .put("message",JSONObject().put("text","Sprzedam mieszkanie 45,8 m2 za 260000 zł"))
      .put("attachments",org.json.JSONArray().put(JSONObject().put("media",JSONObject().put("__typename","Photo").put("id","880000000000001").put("image",JSONObject().put("uri",known).put("width",800).put("height",400)))))
    val heading=if(mode=="foreign")"<a href='${link.replace(id,"550000000000092")}'>Other post</a>" else "<a href='https://www.facebook.com/'>Author</a>"
    val photo="<a href='https://www.facebook.com/photo/?fbid=880000000000001&amp;set=pcb.$id'><img id='photo' style='display:block;width:600px;height:300px' src='$rendered'></a>"
    val body=if(mode=="anchor")photo else "<div role=article>$heading$photo</div>"
    val html="<!doctype html><title>Bound photo fixture</title><script type='application/json'>$story</script><main>$body</main>"
    val postPath="/groups/$FIXTURE_GROUP_ID/posts/$id/"
    val server=LoopbackFixtureServer(pages=mapOf(postPath to "bound-photo")){name->when(name){"fixtures/home.html"->"<!doctype html><title>Group</title><p>Home</p>";"fixtures/bound-photo.html"->html;else->null}}
    val lab=lab(host!!,"http://127.0.0.1:${server.port}$postPath",rendered,png())
    val original=GeckoSession();val source=CollectorChannel(original,fixtureMode=true)
    try{
     source.attach(GeckoHost.collectorExtension(host!!));original.open(GeckoHost.runtime(host!!));host!!.geckoView.setSession(original);original.setActive(true)
     original.loadUri(server.url("/groups/$FIXTURE_GROUP_ID/","home"));assertTrue(source.awaitPort(15000));delay(300)
     val row=DesktopRow(id,link,"DOM",null,"NONE",null,null,null,null,null,"UNKNOWN",false,1,"NO_TEXT")
     var callbacks=0
     val out=ReviewDataRunner.run(host!!.geckoView,original,listOf(row),true,{true},fixtureOrigin="http://127.0.0.1:${server.port}",selectedPostId=id,onBoundPost={channel,r,current,live->
      callbacks++;val images=DesktopThumbnails()
      try{
       val imageReply=channel.reviewImages(r,current,host!!.geckoView,images,true,group=FIXTURE_GROUP_ID,alive=live)
       assertTrue("outcome=${channel.reviewImageOutcome}, details=${channel.reviewImageDetails}, live=${live()}, redirects=${lab.redirects.get()}",imageReply)
       assertEquals(channel.reviewImageDetails.toString(),1,channel.reviewImageDetails.getValue("sourceProof"))
       if(mode=="foreign"){
        assertEquals("NO_IMAGE",channel.reviewImageOutcome);assertTrue(images.ocrRows(id).isEmpty());assertEquals(1,channel.reviewImageDetails.getValue("foreignOwner"))
       }else{
        assertEquals(channel.reviewImageDetails.toString(),"CAPTURED",channel.reviewImageOutcome);assertEquals(1,channel.reviewImageDetails.getValue("sourceAsset"))
        if(mode=="anchor")assertEquals(1,channel.reviewImageDetails.getValue("anchorOwner"))
        val bitmap=images.ocrRows(id).single().copy(Bitmap.Config.ARGB_8888,false)
        val text=LocalOcr.readOwned(bitmap);assertTrue("Fixture crop did not contain rendered price: $mode",text.contains("260"));assertTrue(live())
       }
      }finally{images.clear()}
     })
     assertEquals(out.summary.report(),"DONE",out.summary.reason);assertEquals(1,callbacks);assertEquals(1,out.summary.opened);assertTrue("Local image redirect was not observed",lab.redirects.get()>0)
    }finally{source.close();if(host!!.geckoView.session!=null)host!!.geckoView.releaseSession();original.close();server.close();GeckoHost.runtime(host!!).webExtensionController.uninstall(lab.extension).await();settings.javaClass.getMethod("setConsoleOutput", Boolean::class.javaPrimitiveType).invoke(settings,false)}
   }}}
  }
 }
}
