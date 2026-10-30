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
import org.junit.AfterClass
import org.junit.Test
import org.junit.runner.RunWith
import org.mozilla.geckoview.GeckoSession
import org.mozilla.geckoview.WebExtension

/** Local PNG delivered by a test-only redirect; actual DOM image URL, no page getter override. */
@RunWith(AndroidJUnit4::class)
class PhotoBindingInstrumentedTest {
 companion object {
  private var installedLab:WebExtension?=null
  private var labRuntime:org.mozilla.geckoview.GeckoRuntime?=null
  @AfterClass @JvmStatic fun removeLab(){runBlocking{withContext(Dispatchers.Main){
   val e=installedLab;val r=labRuntime;installedLab=null;labRuntime=null
   if(e!=null&&r!=null)r.webExtensionController.uninstall(e).await()
   Unit
  }}}
 }
 @Test fun signedCdnVariantInUnboundArticleCapturesReadablePixels()=runCase("article")
 @Test fun explicitOwnPhotoLinkWithoutArticleCapturesReadablePixels()=runCase("anchor")
 @Test fun sameAssetInForeignArticleIsNotCaptured()=runCase("foreign")
 @Test fun exactOwnPhotosInPlainMainWithoutAnyHrefCaptureReadablePixels()=runCase("plain")
 @Test fun verifiedArticleWithPhotoOutsideCardCapturesReadablePixels()=runCase("outside")
 @Test fun exactOwnPhotosWithoutMainOrArticleCaptureReadablePixels()=runCase("body")
 @Test fun ownSourceInForeignUnboundRegionIsNotCaptured()=runCase("plainForeign")
 @Test fun ownSourceInCommentRegionIsNotCaptured()=runCase("plainComment")
 @Test fun exactOwnPhotoInMediaAlbumWithoutPostLinkCapturesReadablePixels()=runCase("album")
 @Test fun exactOwnPhotoInDifferentGmPostIsNotCaptured()=runCase("foreignGm")
 private fun png():String{
  val b=Bitmap.createBitmap(800,400,Bitmap.Config.ARGB_8888);val c=Canvas(b);c.drawColor(Color.WHITE)
  val p=Paint(Paint.ANTI_ALIAS_FLAG).apply{color=Color.BLACK;textSize=60f}
  c.drawText("Sprzedam mieszkanie",20f,100f,p);c.drawText("260000 zl 45,8 m2",20f,200f,p)
  val out=java.io.ByteArrayOutputStream();b.compress(Bitmap.CompressFormat.PNG,100,out);b.recycle()
  return "data:image/png;base64,"+Base64.encodeToString(out.toByteArray(),Base64.NO_WRAP)
 }
 private data class Lab(val extension:WebExtension,val redirects:java.util.concurrent.atomic.AtomicInteger,val port:WebExtension.Port)
 private suspend fun lab(context:android.content.Context,document:String,image:String,pixels:String):Lab {
  val runtime=GeckoHost.runtime(context)
  val extension=runtime.webExtensionController.ensureBuiltIn("resource://android/assets/ext/photo_lab/","photo-lab@flip-manager.local").await()!!
  installedLab=extension;labRuntime=runtime
  val connected=CompletableDeferred<WebExtension.Port>();val configured=CompletableDeferred<Unit>();val redirects=java.util.concurrent.atomic.AtomicInteger()
  extension.setMessageDelegate(object:WebExtension.MessageDelegate{
   override fun onConnect(port:WebExtension.Port){
    if(port.sender.session!=null){port.disconnect();return}
    port.setDelegate(object:WebExtension.PortDelegate{
     override fun onPortMessage(message:Any,p:WebExtension.Port){val j=ScanProtocol.asJson(message)?:return;when(j.optString("type")){"configured"->configured.complete(Unit);"redirected"->redirects.incrementAndGet()}}
    });connected.complete(port)
   }
  },"photo_binding_lab")
  var activePort:WebExtension.Port?=null
  try{
   val port=withTimeout(10000){connected.await()};activePort=port;port.postMessage(JSONObject().put("type","configure").put("document",document).put("image",image).put("pixels",pixels))
   withTimeout(5000){configured.await()};return Lab(extension,redirects,port)
  }catch(e:Exception){extension.setMessageDelegate(null,"photo_binding_lab");activePort?.disconnect();throw e}
 }
 private fun runCase(mode:String){
  ActivityScenario.launch(GeckoTestHostActivity::class.java).use{scenario->
   var host:GeckoTestHostActivity?=null;scenario.onActivity{host=it}
   runBlocking{withTimeout(60000){withContext(Dispatchers.Main){
    val id="550000000000091";val link="https://www.facebook.com/groups/$FIXTURE_GROUP_ID/posts/$id/"
    val path="/v/t39.30808-6/123456789_987654321_555555555_n.jpg"
    val known="https://scontent-waw2-1.xx.fbcdn.net$path?oh=old&oe=123&_nc_cat=1"
    val rendered="https://scontent-fra3-2.xx.fbcdn.net$path?stp=dst-jpg_s960x960&oh=new&oe=456&_nc_cat=2&_nc_test=$mode"
    val plain=mode in setOf("plain","body","plainForeign","plainComment","album","foreignGm")
    val sourceUris=if(plain)(0 until 5).map{if(it==0)rendered else "$rendered&_nc_slot=$it"}else listOf(known)
    val story=JSONObject().put("__typename","Story").put("post_id",id).put("permalink_url",link)
      .put("message",JSONObject().put("text","Sprzedam mieszkanie 45,8 m2 za 260000 zł"))
      .put("attachments",org.json.JSONArray(sourceUris.mapIndexed{index,uri->JSONObject().put("media",JSONObject().put("__typename","Photo").put("id",(880000000000001L+index).toString()).put("image",JSONObject().put("uri",uri).put("width",800).put("height",400)))}))
    val heading=if(mode=="outside")"<a href='$link'>Post</a>" else if(mode=="foreign"||mode=="plainForeign")"<a href='${link.replace(id,"550000000000092")}'>Other post</a>" else if(plain)"" else "<a href='https://www.facebook.com/'>Author</a>"
    val photo=if(mode=="album"||mode=="foreignGm")sourceUris.mapIndexed{index,uri->"<div><a href='https://www.facebook.com/photo/?fbid=${880000000000001L+index}&amp;set=${if(mode=="album")"a.880000000000099" else "gm.550000000000092"}'><img id='photo$index' style='display:block;width:600px;height:300px' src='$uri'></a></div>"}.joinToString("") else if(plain)sourceUris.mapIndexed{index,uri->"<div role=link tabindex=0><img id='photo$index' style='display:block;width:600px;height:300px' src='$uri'></div>"}.joinToString("") else "<a href='https://www.facebook.com/photo/?fbid=880000000000001&amp;set=pcb.$id'><img id='photo' style='display:block;width:600px;height:300px' src='$rendered'></a>"
    val icons=if(plain)(0 until 56).joinToString(""){"<img style='width:8px;height:8px' src='data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=='>"} else ""
    val body=when{mode=="outside"->"<div role=article>$heading</div>$photo$icons";mode=="plainComment"->"<div role=comment>$photo</div>$icons";plain->"$heading<div>$photo</div>$icons";mode=="anchor"->photo;else->"<div role=article>$heading$photo</div>"}
    val region=if(mode=="body")body else "<main>$body</main>"
    val html="<!doctype html><title>Bound photo fixture</title><script type='application/json'>$story</script>$region"
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
       assertTrue("failure=${channel.reviewImageFixtureFailure}, outcome=${channel.reviewImageOutcome}, details=${channel.reviewImageDetails}, live=${live()}, redirects=${lab.redirects.get()}",imageReply)
       assertEquals(channel.reviewImageDetails.toString(),sourceUris.size,channel.reviewImageDetails.getValue("sourceProof"))
       if(mode in setOf("foreign","plainForeign","plainComment","foreignGm")){
        assertEquals("NO_IMAGE",channel.reviewImageOutcome);assertTrue(images.ocrRows(id).isEmpty())
        if(mode=="plainComment")assertEquals(5,channel.reviewImageDetails.getValue("excludedOwner"))else assertEquals(sourceUris.size,channel.reviewImageDetails.getValue("foreignOwner"))
       }else{
        assertEquals(channel.reviewImageDetails.toString(),"CAPTURED",channel.reviewImageOutcome);if(plain){assertEquals(61,channel.reviewImageDetails.getValue("documentImg"));assertEquals(5,channel.reviewImageDetails.getValue("sourceExact"));assertEquals(5,channel.reviewImageDetails.getValue("sourceOwner"));assertEquals(0,channel.reviewImageDetails.getValue("anchorOwner"))}else assertEquals(1,channel.reviewImageDetails.getValue("sourceAsset"))
        if(mode=="anchor")assertEquals(1,channel.reviewImageDetails.getValue("anchorOwner"))
        if(mode=="outside")assertEquals(1,channel.reviewImageDetails.getValue("sourceOwner"))
        val bitmap=images.ocrRows(id).single().copy(Bitmap.Config.ARGB_8888,false)
        val text=LocalOcr.readOwned(bitmap);assertTrue("Fixture crop did not contain rendered price: $mode",text.contains("260"));assertTrue(live())
       }
      }finally{images.clear()}
     })
     assertEquals(out.summary.report(),"DONE",out.summary.reason);assertEquals(1,callbacks);assertEquals(1,out.summary.opened);assertTrue("Local image redirect was not observed",lab.redirects.get()>0)
    }finally{source.close();if(host!!.geckoView.session!=null)host!!.geckoView.releaseSession();original.close();server.close();lab.extension.setMessageDelegate(null,"photo_binding_lab");lab.port.disconnect()}
   }}}
  }
 }
}
