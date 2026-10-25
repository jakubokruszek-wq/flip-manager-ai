package pl.jakubokruszek.flipwatcher.geckopoc

import android.app.AlertDialog
import android.content.Context
import android.widget.Button
import android.widget.TextView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ReviewReportInstrumentedTest{
 private fun dialog(a:PocActivity,name:String)=PocActivity::class.java.getDeclaredField(name).apply{isAccessible=true}.get(a) as AlertDialog
 @Test fun failureReportAppearsAutomaticallyAndRemainsReachableAfterRecreationWithNoRows(){
  val instrumentation=InstrumentationRegistry.getInstrumentation();val context=instrumentation.targetContext
  val prefs=context.getSharedPreferences("review_data_counts_v1",Context.MODE_PRIVATE);val saved=prefs.getString("last",null)
  val value=ReviewDataSummary("PAGE_TIMEOUT",13,4,3,2,1,1,1,0)
  try{ActivityScenario.launch(PocActivity::class.java).use{scenario->
   scenario.onActivity{a->
    a.publishReviewFailure(value)
    val d=dialog(a,"desktopResultDialog");assertTrue(d.isShowing)
    val text=d.findViewById<TextView>(android.R.id.message).text.toString()
    assertTrue(text.contains("PAGE_TIMEOUT"));assertTrue(text.contains("otwarto 4"));assertTrue(text.contains("nie oznacza"))
    assertEquals(value,ReviewDataSummary.decode(prefs.getString("last",null)));d.dismiss()
   }
   scenario.recreate()
   scenario.onActivity{a->a.findViewById<android.view.ViewGroup>(android.R.id.content).findViewWithTag<Button>("poc.tool.tools").performClick()}
   scenario.onActivity{a->dialog(a,"diagnosticsDialog").window!!.decorView.findViewWithTag<Button>("poc.tool.reviewResult").performClick()}
   instrumentation.waitForIdleSync()
   scenario.onActivity{a->val d=dialog(a,"desktopResultDialog");assertTrue(d.isShowing);assertTrue(d.findViewById<TextView>(android.R.id.message).text.contains("otwarto 4"));d.dismiss()}
  }}finally{if(saved==null)prefs.edit().remove("last").commit() else prefs.edit().putString("last",saved).commit()}
 }
}
