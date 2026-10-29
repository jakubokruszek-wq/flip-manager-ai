package pl.jakubokruszek.flipwatcher.geckopoc

import android.app.AlertDialog
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.view.ViewGroup
import android.widget.Button
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Before
import org.junit.After
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class SavedOcrInstrumentedTest {
 private val context get()=InstrumentationRegistry.getInstrumentation().targetContext
 private fun row()=DesktopRow("550000000000091","https://www.facebook.com/groups/${PocPolicy.APPROVED_GROUP_ID}/posts/550000000000091/","DOM",null,"NONE",null,null,null,null,null,"UNKNOWN",false,1,"NO_TEXT")
 private fun field(a:PocActivity,name:String)=PocActivity::class.java.getDeclaredField(name).apply{isAccessible=true}.get(a)
 private fun seed(){
  val b=Bitmap.createBitmap(800,400,Bitmap.Config.ARGB_8888);val c=Canvas(b);c.drawColor(Color.WHITE)
  val p=Paint(Paint.ANTI_ALIAS_FLAG).apply{color=Color.BLACK;textSize=60f}
  c.drawText("Sprzedam mieszkanie",20f,100f,p);c.drawText("260000 zl 45,8 m2",20f,200f,p)
  val photo=try{ResultArchive.photo(row().postId,0,true,b)}finally{b.recycle()}
  assertTrue(ResultArchive(context).save(SavedResult(123,listOf(row()),emptyList(),listOf(photo))))
 }
 @Before fun before(){ArchiveTestSupport.clear(context)}
 @After fun after(){ArchiveTestSupport.clear(context)}
 @Test fun explicitSavedOcrWorksWithoutBrowserAndKeepsTextFieldsSeparate(){
  seed()
  ActivityScenario.launch(PocActivity::class.java).use{scenario->
   ArchiveTestSupport.drain(context)
   scenario.onActivity{a->
    assertNull(field(a,"session"))
    a.findViewById<ViewGroup>(android.R.id.content).findViewWithTag<Button>("poc.saved.ocr").performClick()
    (field(a,"ocrConsentDialog") as AlertDialog).getButton(AlertDialog.BUTTON_POSITIVE).performClick()
   }
   val end=System.currentTimeMillis()+45000;var complete=false
   while(!complete&&System.currentTimeMillis()<end){scenario.onActivity{complete=field(it,"ocrBusy")==false};if(!complete)Thread.sleep(100)}
   assertTrue("Saved OCR did not finish",complete);ArchiveTestSupport.drain(context)
   val value=ResultArchive(context).load()!!;assertNull(value.rows.single().price);assertEquals(260000.0,value.ocr.single().price!!,0.0)
   assertEquals(1,value.photos.size)
   scenario.onActivity{a->
    assertNull(field(a,"session"));assertTrue((field(a,"ocrLast") as OcrSummary).suggestions>0)
    val buttons=field(a,"buttons") as Map<*,*>;assertTrue((buttons["savedOcr"] as Button).isEnabled)
    (field(a,"desktopResultDialog") as? AlertDialog)?.dismiss();a.askSavedOcr()
    assertTrue((field(a,"ocrConsentDialog") as AlertDialog).isShowing)
    (field(a,"ocrConsentDialog") as AlertDialog).getButton(AlertDialog.BUTTON_NEGATIVE).performClick()
   }
  }
 }
 @Test fun cancellingConsentDoesNotRunModelOrOpenBrowser(){
  seed();ActivityScenario.launch(PocActivity::class.java).use{scenario->
   ArchiveTestSupport.drain(context)
   scenario.onActivity{a->a.askSavedOcr();(field(a,"ocrConsentDialog") as AlertDialog).getButton(AlertDialog.BUTTON_NEGATIVE).performClick();assertEquals(false,field(a,"ocrBusy"));assertNull(field(a,"session"))}
   assertTrue(ResultArchive(context).load()!!.ocr.isEmpty())
  }
 }
 @Test fun archivedReviewRequiresANewExplicitGroupContext(){
  seed();ActivityScenario.launch(PocActivity::class.java).use{scenario->
   ArchiveTestSupport.drain(context)
   scenario.onActivity{a->
    val root=a.findViewById<ViewGroup>(android.R.id.content)
    assertNotNull(root.findViewWithTag<Button>("poc.review.enrich"));assertNotNull(root.findViewWithTag<Button>("poc.photo.inspect.${row().postId}"))
    root.findViewWithTag<Button>("poc.review.enrich").performClick()
    assertNull(field(a,"session"));assertEquals(false,field(a,"reviewBusy"))
   }
  }
 }
}
