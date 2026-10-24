package pl.jakubokruszek.flipwatcher.geckopoc

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Rect
import android.os.SystemClock
import android.view.ContextThemeWrapper
import android.view.InputDevice
import android.view.MotionEvent
import android.view.View
import android.widget.Button
import android.widget.CheckBox
import android.widget.ScrollView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList

/** Actual compact native window, 200% font, real input clicks; never opens Facebook. */
@RunWith(AndroidJUnit4::class)
class DesktopConsentInstrumentedTest {
    private val instrumentation get()=InstrumentationRegistry.getInstrumentation()
    private fun make(a:GeckoTestHostActivity,choices:MutableList<DesktopConsentDialog.Selection>):DesktopConsentDialog {
        val c=android.content.res.Configuration(a.resources.configuration).apply{fontScale=2f}
        val themed=ContextThemeWrapper(a,android.R.style.Theme_Material_Light_Dialog_NoActionBar).apply{applyOverrideConfiguration(c)}
        return DesktopConsentDialog(a,themed){choices.add(it)}.apply{
            show()
            val d=a.resources.displayMetrics.density
            // Smaller than the CI device: exercise a 320dp by 360dp dialog.
            window!!.setLayout(minOf((320*d).toInt(),a.resources.displayMetrics.widthPixels),(360*d).toInt())
        }
    }
    private fun settle(scenario:ActivityScenario<GeckoTestHostActivity>,d:DesktopConsentDialog){
        repeat(150){
            instrumentation.waitForIdleSync();var ready=false
            scenario.onActivity{val v=d.window!!.decorView;ready=v.isLaidOut&&!v.isLayoutRequested&&v.hasWindowFocus()&&v.findViewWithTag<Button>("poc.desktop.consentAccept").height>0}
            if(ready)return
            SystemClock.sleep(20)
        }
        fail("consent dialog did not reach a visible laid out state")
    }
    private fun rect(v:View):Rect {val p=IntArray(2);v.getLocationOnScreen(p);return Rect(p[0],p[1],p[0]+v.width,p[1]+v.height)}
    private fun reachable(d:DesktopConsentDialog,tag:String):Rect {
        val v=d.window!!.decorView.findViewWithTag<Button>(tag);val visible=Rect()
        assertTrue(v.isShown&&v.isEnabled);assertTrue(v.getGlobalVisibleRect(visible))
        assertEquals("button clipped vertically",v.height,visible.height());assertEquals("button clipped horizontally",v.width,visible.width())
        assertTrue("button outside dialog",rect(d.window!!.decorView).contains(rect(v)))
        val owner=Rect();d.ownerActivity!!.window.decorView.getWindowVisibleDisplayFrame(owner)
        assertTrue("button outside usable screen",owner.contains(rect(v)))
        return rect(v)
    }
    private fun tap(r:Rect){
        val t=SystemClock.uptimeMillis()
        for(action in listOf(MotionEvent.ACTION_DOWN,MotionEvent.ACTION_UP)){
            val e=MotionEvent.obtain(t,SystemClock.uptimeMillis(),action,r.exactCenterX(),r.exactCenterY(),0)
            e.source=InputDevice.SOURCE_TOUCHSCREEN;try{instrumentation.sendPointerSync(e)}finally{e.recycle()}
        }
        instrumentation.waitForIdleSync()
    }
    private fun picture(d:DesktopConsentDialog,name:String){
        val v=d.window!!.decorView;val b=Bitmap.createBitmap(v.width,v.height,Bitmap.Config.ARGB_8888)
        try{v.draw(Canvas(b));File(d.context.filesDir,"consent-ui-$name.png").outputStream().use{assertTrue(b.compress(Bitmap.CompressFormat.PNG,100,it))}}finally{b.recycle()}
    }
    @Test fun compactLargeTextConsentActionsAreVisibleAndRealAcceptTapWorks(){
        ActivityScenario.launch(GeckoTestHostActivity::class.java).use{scenario->
            val choices=CopyOnWriteArrayList<DesktopConsentDialog.Selection>();lateinit var d:DesktopConsentDialog
            scenario.onActivity{d=make(it,choices)};settle(scenario,d);lateinit var accept:Rect
            scenario.onActivity{
                accept=reachable(d,"poc.desktop.consentAccept");reachable(d,"poc.desktop.consentCancel")
                assertTrue(d.window!!.decorView.findViewWithTag<CheckBox>("poc.desktop.gesture").isChecked)
                assertFalse(d.window!!.decorView.findViewWithTag<CheckBox>("poc.desktop.extended").isChecked)
                picture(d,"compact-large")
            }
            tap(accept);assertEquals(listOf(DesktopConsentDialog.Selection(true,false)),choices.toList())
            scenario.onActivity{assertFalse(d.isShowing)}
        }
    }
    @Test fun expandedScrollableDetailsNeverMoveFooterAndCancelDoesNotGrantConsent(){
        ActivityScenario.launch(GeckoTestHostActivity::class.java).use{scenario->
            val choices=CopyOnWriteArrayList<DesktopConsentDialog.Selection>();lateinit var d:DesktopConsentDialog;lateinit var before:Rect;lateinit var disclosure:Rect
            scenario.onActivity{d=make(it,choices)};settle(scenario,d)
            scenario.onActivity{
                before=reachable(d,"poc.desktop.consentAccept")
                d.window!!.decorView.findViewWithTag<ScrollView>("poc.desktop.consentBody").fullScroll(View.FOCUS_DOWN)
            };instrumentation.waitForIdleSync()
            scenario.onActivity{disclosure=reachable(d,"poc.desktop.consentDisclosure")};tap(disclosure);settle(scenario,d)
            scenario.onActivity{d.window!!.decorView.findViewWithTag<ScrollView>("poc.desktop.consentBody").fullScroll(View.FOCUS_DOWN)}
            instrumentation.waitForIdleSync();lateinit var cancel:Rect
            scenario.onActivity{
                assertEquals(before,reachable(d,"poc.desktop.consentAccept"));cancel=reachable(d,"poc.desktop.consentCancel")
                assertTrue(d.window!!.decorView.findViewWithTag<ScrollView>("poc.desktop.consentBody").canScrollVertically(-1))
                picture(d,"compact-expanded")
            }
            tap(cancel);assertTrue(choices.isEmpty())
            scenario.onActivity{assertFalse(d.isShowing);d=make(it,choices);assertTrue(d.window!!.decorView.findViewWithTag<CheckBox>("poc.desktop.gesture").isChecked);assertFalse(d.window!!.decorView.findViewWithTag<CheckBox>("poc.desktop.extended").isChecked);d.dismiss()}
        }
    }
}
