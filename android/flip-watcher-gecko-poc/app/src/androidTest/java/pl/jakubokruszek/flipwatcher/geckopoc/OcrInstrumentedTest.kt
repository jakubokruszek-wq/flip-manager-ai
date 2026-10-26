package pl.jakubokruszek.flipwatcher.geckopoc

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.widget.Button
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.*
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class OcrInstrumentedTest{
 private fun row()=DesktopRow("550000000000081","https://www.facebook.com/groups/${PocPolicy.APPROVED_GROUP_ID}/posts/550000000000081/","DOM",null,"NONE",null,null,null,null,null,"UNKNOWN",false,0,"NO_TEXT")
 private fun image():Bitmap=Bitmap.createBitmap(1000,500,Bitmap.Config.ARGB_8888).also{b->
  val canvas=Canvas(b);canvas.drawColor(Color.WHITE);val paint=Paint(Paint.ANTI_ALIAS_FLAG).apply{color=Color.BLACK;textSize=62f;typeface=android.graphics.Typeface.create("sans-serif",android.graphics.Typeface.BOLD)}
  canvas.drawText("Sprzedam mieszkanie",30f,90f,paint);canvas.drawText("45,8 m2",30f,200f,paint);canvas.drawText("260 000 zl",30f,310f,paint);canvas.drawText("2 pokoje",30f,420f,paint)
 }
 @Test fun bundledLatinModelReadsPixelsAndBackgroundProjectsSelectedFieldsWithoutUploading()=runBlocking{
  withTimeout(40000){
   ActivityScenario.launch(GeckoTestHostActivity::class.java).use{scenario->var host:GeckoTestHostActivity?=null;scenario.onActivity{host=it}
    withContext(Dispatchers.Main){
     if(androidx.test.platform.app.InstrumentationRegistry.getArguments().getString("offlineOcr")=="1"){
      val cm=host!!.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
      withTimeout(10000){while(cm.allNetworks.any{cm.getNetworkCapabilities(it)?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)==true})delay(100)}
      assertFalse(cm.allNetworks.any{cm.getNetworkCapabilities(it)?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)==true})
     }
     val bitmap=image();val text=LocalOcr.readOwned(bitmap);assertTrue(bitmap.isRecycled);assertTrue(text.contains("260"));assertTrue(text.contains("45"))
     GeckoHost.collectorExtension(host!!);assertTrue(GeckoHost.background.awaitPort(15000))
     val projected=GeckoHost.background.ocrFields(row().postId,listOf(text));assertNotNull(projected);assertEquals(260000.0,projected!!.price!!,0.0);assertEquals(45.8,projected.area!!,0.0);assertEquals(2,projected.rooms)
     assertFalse(OcrSummary("DONE",1,1,1,1,0).encode().contains(text))
    }
   }
  }
 }
 @Test fun cacheIsBoundedSeparateAndErasedAlongWithPreview(){
  val store=DesktopThumbnails();val held=mutableListOf<Bitmap>()
  for(i in 1..9){val o=Bitmap.createBitmap(1024,1024,Bitmap.Config.ARGB_8888);held.add(o);assertTrue(store.put((550000000000080+i).toString(),0,Bitmap.createBitmap(100,100,Bitmap.Config.ARGB_8888),o))}
  assertTrue(store.ocrBytes<=24*1024*1024);assertTrue(held.count{it.isRecycled}>=3)
  store.retain(setOf("550000000000081"));assertEquals(1,store.count);assertEquals(1,store.ocrRows("550000000000081").size);store.clear();assertEquals(0,store.ocrBytes);assertTrue(held.all{it.isRecycled})
 }
 @Test fun ocrSuggestionIsLabelledAndNeverMutatesAcceptedRowOrSurvivesErasedUi(){
  ActivityScenario.launch(GeckoTestHostActivity::class.java).use{scenario->scenario.onActivity{a->
   val original=row();val projected=original.copy(price=260000.0,priceSource="EXPLICIT_TOTAL",area=45.8,rooms=2,intent="SELL_PROPERTY",usable=true,qualification="CANDIDATE");var calls=0
   val panel=OffersPanel(a,{},{},onOcr={calls++},ocrAvailable={true},ocrResult={projected});panel.showRows(listOf(original));val start=panel.findViewWithTag<Button>("poc.ocr.start");assertNotNull(start);start.performClick();assertEquals(1,calls)
   assertNotNull(panel.findViewWithTag<android.view.View>("poc.ocr.result.${original.postId}"));assertNull(original.price);assertFalse(DesktopSummary.eligible(original))
   panel.showRows(emptyList());assertNull(start.tag);start.performClick();assertEquals(1,calls);assertNull(panel.findViewWithTag<android.view.View>("poc.ocr.result.${original.postId}"))
  }}
 }
 @Test fun manualReviewRowKeepsBoundOcrPixelsUntilPauseWithoutStartingRecognition(){
  val context=androidx.test.platform.app.InstrumentationRegistry.getInstrumentation().targetContext
  val prefs=context.getSharedPreferences("desktop_trial_summary_v1",Context.MODE_PRIVATE);val saved=prefs.getString("last",null)
  val crop=image();val thumbnail=Bitmap.createBitmap(100,100,Bitmap.Config.ARGB_8888)
  try{ActivityScenario.launch(PocActivity::class.java).use{scenario->
   scenario.onActivity{a->
    assertTrue(a.desktopThumbnails.put(row().postId,0,thumbnail,crop))
    val stats=DesktopProtocol.emptyStats().toMutableMap().apply{put("candidates",1);put("verified",1)}
    a.publishDesktop(DesktopSummary.create("DONE",1,DesktopReply("OK","DONE",listOf(row()),stats)),listOf(row()))
    assertEquals(1,a.desktopThumbnails.ocrRows(row().postId).size);assertFalse(crop.isRecycled)
    assertNotNull(a.findViewById<android.view.ViewGroup>(android.R.id.content).findViewWithTag<Button>("poc.ocr.start"))
   }
   scenario.moveToState(androidx.lifecycle.Lifecycle.State.CREATED);assertTrue(crop.isRecycled);assertTrue(thumbnail.isRecycled)
   scenario.moveToState(androidx.lifecycle.Lifecycle.State.RESUMED)
   scenario.onActivity{a->assertTrue(a.desktopThumbnails.ocrRows(row().postId).isEmpty())}
  }}finally{if(!crop.isRecycled)crop.recycle();if(!thumbnail.isRecycled)thumbnail.recycle();if(saved==null)prefs.edit().remove("last").commit() else prefs.edit().putString("last",saved).commit()}
 }

}
