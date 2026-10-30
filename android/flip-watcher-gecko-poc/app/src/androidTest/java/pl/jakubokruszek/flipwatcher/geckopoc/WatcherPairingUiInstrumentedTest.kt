package pl.jakubokruszek.flipwatcher.geckopoc

import android.app.AlertDialog
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.EditText
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class WatcherPairingUiInstrumentedTest {
    private val instrumentation get()=InstrumentationRegistry.getInstrumentation()
    private fun dialog(activity:PocActivity,name:String):AlertDialog? = PocActivity::class.java.getDeclaredField(name).apply{isAccessible=true}.get(activity) as? AlertDialog
    @Test fun invalidPairingShowsVisibleErrorKeepsArchiveAndMasksInput(){
        val context=instrumentation.targetContext
        WatcherGroups.setActive(WatcherGroups.configured);PocPolicy.selectGroup(WatcherGroups.LEGACY_GROUP)
        ArchiveTestSupport.clear(context)
        val row=DesktopRow("550000000000099","https://www.facebook.com/groups/${WatcherGroups.LEGACY_GROUP}/posts/550000000000099/","DOM",319000.0,"EXPLICIT_TOTAL",42.42,2,"Polesie","Retkinia",null,"SELL_PROPERTY",true,0)
        assertTrue(ResultArchive(context).save(SavedResult(1,listOf(row),emptyList(),emptyList())))
        val path=File(context.noBackupFilesDir,"saved-search-v1.bin");val before=path.readBytes()
        try{ActivityScenario.launch(PocActivity::class.java).use{scenario->
            scenario.onActivity{activity->activity.findViewById<View>(android.R.id.content).findViewWithTag<Button>("poc.tool.tools").performClick()}
            scenario.onActivity{activity->activity.diagnosticsDialog!!.window!!.decorView.findViewWithTag<Button>("poc.tool.watcherConnect").performClick()}
            instrumentation.waitForIdleSync()
            scenario.onActivity{activity->
                val pairing=dialog(activity,"watcherDialog")!!;assertTrue(pairing.isShowing)
                assertTrue(pairing.window!!.attributes.flags and WindowManager.LayoutParams.FLAG_SECURE != 0)
                val input=pairing.window!!.decorView.findViewWithTag<EditText>("watcher.pairing.code")
                assertNotNull(input.transformationMethod);input.setText("invalid code")
                pairing.getButton(AlertDialog.BUTTON_POSITIVE).performClick()
            }
            var visible=false;val deadline=android.os.SystemClock.elapsedRealtime()+10000
            while(!visible&&android.os.SystemClock.elapsedRealtime()<deadline){
                instrumentation.waitForIdleSync();scenario.onActivity{visible=dialog(it,"watcherResultDialog")?.isShowing==true}
                if(!visible)Thread.sleep(25)
            }
            assertTrue("pairing error must be visible",visible)
            scenario.onActivity{activity->
                val result=dialog(activity,"watcherResultDialog")!!
                val text=result.findViewById<android.widget.TextView>(android.R.id.message).text.toString()
                assertTrue(text.contains("Nie zsynchronizowano"));assertFalse(text.contains("invalid code"))
                assertTrue(activity.findViewById<View>(android.R.id.content).findViewWithTag<Button>("poc.tool.open").isEnabled)
            }
            assertArrayEquals(before,path.readBytes());assertEquals(11,WatcherGroups.active.size)
        }}finally{ArchiveTestSupport.clear(context)}
    }
}
