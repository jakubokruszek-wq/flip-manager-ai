package pl.jakubokruszek.flipwatcher.geckopoc

import android.graphics.Bitmap
import android.graphics.Color
import android.view.ViewGroup
import android.widget.Button
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class PhotoCollectionInstrumentedTest {
 private val context get()=InstrumentationRegistry.getInstrumentation().targetContext
 private fun row(n:Int=1)=DesktopRow((550000000000070+n).toString(),"https://www.facebook.com/groups/${PocPolicy.APPROVED_GROUP_ID}/posts/${550000000000070+n}/","DOM",260000.0,"EXPLICIT_TOTAL",45.8,2,null,null,null,"SELL_PROPERTY",true,1)
 private fun bitmap(color:Int,size:Int)=Bitmap.createBitmap(size,size,Bitmap.Config.ARGB_8888).apply{eraseColor(color)}
 @Test fun captureIsDurablySavedBeforePublishingAndCopiesSurviveSourceCleanup()=runBlocking {
  ArchiveTestSupport.clear(context);val visible=DesktopThumbnails();val r=row();val other=row(2)
  visible.put(other.postId,0,bitmap(Color.BLUE,12))
  var savedBeforePublish=false;var captured:Bitmap?=null
  try {
   assertTrue(PhotoCollection.capture(r.postId,{true},capture={images->
    val small=bitmap(Color.GREEN,12);captured=small;images.put(r.postId,0,small,bitmap(Color.GREEN,80))
   },persist={images->ResultArchiveJobs.saveAwait(context,listOf(r,other),emptyList(),images)},publish={images->
    savedBeforePublish=ResultArchive(context).load()?.photos?.count{it.postId==r.postId}==2
    assertTrue(visible.replacePostFrom(r.postId,images))
   }))
   assertTrue(savedBeforePublish);assertTrue(captured!!.isRecycled)
   assertEquals(Color.GREEN,visible.rows(r.postId).single().getPixel(0,0));assertEquals(Color.BLUE,visible.rows(other.postId).single().getPixel(0,0))
   val saved=ResultArchive(context).load()!!;assertEquals(2,saved.photos.size);assertTrue(saved.ocr.isEmpty());assertTrue(PhotoCollection.queue(saved.rows,{id->saved.photos.any{it.postId==id&&!it.crop}}).none{it.postId==r.postId})
  }finally{visible.clear();ArchiveTestSupport.clear(context)}
 }
 @Test fun noImageAndFailedSaveNeverPublishOrDeleteThePreviousResult()=runBlocking {
  ArchiveTestSupport.clear(context);val r=row();assertTrue(ResultArchive(context).save(SavedResult(1,listOf(r),emptyList(),emptyList())))
  var writes=0;var publishes=0;var owned:Bitmap?=null
  try {
   assertFalse(PhotoCollection.capture(r.postId,{true},{true},{writes++;true},{publishes++}))
   assertEquals(0,writes)
   try{PhotoCollection.capture(r.postId,{true},{images->bitmap(Color.RED,12).also{owned=it}.let{images.put(r.postId,0,it)}},{false},{publishes++});fail("failed save must abort")}
   catch(_:IllegalStateException){}
   assertEquals(0,publishes);assertTrue(owned!!.isRecycled);assertEquals(1L,ResultArchive(context).load()!!.savedAt)
  }finally{ArchiveTestSupport.clear(context)}
 }
 @Test fun aNewSearchKeepsStoredPhotosOfRetainedOffers(){
  ArchiveTestSupport.clear(context);val r=row();val b=bitmap(Color.RED,12)
  val photo=try{ResultArchive.photo(r.postId,0,false,b)}finally{b.recycle()}
  assertTrue(ResultArchive(context).save(SavedResult(1,listOf(r),emptyList(),listOf(photo))))
  try{ActivityScenario.launch(PocActivity::class.java).use{scenario->
   ArchiveTestSupport.drain(context)
   val updated=r.copy(price=259000.0)
   scenario.onActivity{a->val reply=DesktopReply("OK","DONE",listOf(updated),DesktopProtocol.emptyStats().toMutableMap().apply{put("candidates",1);put("verified",1);put("desktop",1);put("dom",1)});a.publishDesktop(DesktopSummary.create("DONE",0,reply),listOf(updated),show=false)}
   ArchiveTestSupport.drain(context)
   val saved=ResultArchive(context).load()!!;assertEquals(updated,saved.rows.single());assertEquals(1,saved.photos.size);assertEquals(r.postId,saved.photos.single().postId)
   scenario.onActivity{a->assertNotNull(a.findViewById<ViewGroup>(android.R.id.content).findViewWithTag<android.view.View>("poc.offer.photo.${r.postId}.0"))}
  }}finally{ArchiveTestSupport.clear(context)}
 }
 @Test fun photosButtonIncludesRecognizedOffersAndDoesNotInvokeOcr(){
  ActivityScenario.launch(GeckoTestHostActivity::class.java).use{scenario->scenario.onActivity{host->
   var photos=0;var ocr=0;val a=row();val b=row(2);val manual=row(3).copy(price=null,priceSource="NONE",area=null,rooms=null,usable=false,intent="UNKNOWN",qualification="NO_TEXT")
   val panel=OffersPanel(host,{}, {},onOcr={ocr++},onPhotos={photos++},photoAvailable={it==a.postId})
   host.addContentView(panel,ViewGroup.LayoutParams(-1,-1));panel.showRows(listOf(a,b,manual))
   val button=panel.findViewWithTag<Button>("poc.photos.collect");assertTrue(button.text.contains("(2)"));assertEquals(0,photos);assertEquals(0,ocr)
   button.performClick();assertEquals(1,photos);assertEquals(0,ocr)
  }}
 }
}
