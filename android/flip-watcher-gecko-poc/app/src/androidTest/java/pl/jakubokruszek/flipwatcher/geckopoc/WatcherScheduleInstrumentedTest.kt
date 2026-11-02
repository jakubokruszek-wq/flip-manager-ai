package pl.jakubokruszek.flipwatcher.geckopoc
import android.content.Context
import android.widget.Button
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Test
import org.junit.Assert.*
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class WatcherScheduleInstrumentedTest {
    private val context:Context=ApplicationProvider.getApplicationContext()
    @Test fun actualTimePickerSavesAndRecreationKeepsMinutes() {
        val prefs=WatcherAutomation.preferences(context)
        val old=prefs.getString("scan_minutes",null);val since=prefs.getLong("schedule_since",0)
        assertFalse("Fixture must not enable live automation",WatcherAutomation.enabled(context))
        try {
            WatcherAutomation.saveSchedule(context,listOf(420,900,1380))
            ActivityScenario.launch(PocActivity::class.java).use { scenario ->
                scenario.onActivity { activity ->
                    activity.editAutomationSchedule()
                    activity.automationScheduleDialog!!.findViewById<android.view.View>(android.R.id.content)
                        .findViewWithTag<Button>("automation.time.0").performClick()
                    val picker=activity.automationTimeDialog!!
                    picker.updateTime(6,25)
                    picker.getButton(android.app.AlertDialog.BUTTON_POSITIVE).performClick()
                    activity.automationScheduleDialog!!.getButton(android.app.AlertDialog.BUTTON_POSITIVE).performClick()
                    assertEquals(listOf(385,900,1380),WatcherAutomation.schedule(context))
                }
                scenario.recreate()
                scenario.onActivity { activity ->
                    activity.editAutomationSchedule()
                    val button=activity.automationScheduleDialog!!.findViewById<android.view.View>(android.R.id.content)
                        .findViewWithTag<Button>("automation.time.0")
                    assertEquals("06:25",button.text.toString())
                    activity.automationScheduleDialog!!.getButton(android.app.AlertDialog.BUTTON_NEGATIVE).performClick()
                }
            }
            assertTrue(runCatching{WatcherAutomation.saveSchedule(context,listOf(385,385,1380))}.isFailure)
            assertEquals(listOf(385,900,1380),WatcherAutomation.schedule(context))
        } finally {
            prefs.edit().putString("scan_minutes",old).putLong("schedule_since",since).commit()
        }
    }
    @Test fun longJournalCannotHideScheduleButtonOnCompactDialog() {
        ActivityScenario.launch(PocActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                activity.showAutomationSettings((1..200).joinToString("\n"){"SCAN_STARTED ($it)"})
                val dp=activity.resources.displayMetrics.density
                activity.automationStatusDialog!!.window!!.setLayout((320*dp).toInt(),(480*dp).toInt())
            }
            androidx.test.platform.app.InstrumentationRegistry.getInstrumentation().waitForIdleSync()
            scenario.onActivity { activity ->
                val dialog=activity.automationStatusDialog!!
                val decor=dialog.window!!.decorView
                val button=decor.findViewWithTag<Button>("automation.edit")
                val visible=android.graphics.Rect()
                assertTrue("Edit hours must be visible before scrolling the journal",button.getGlobalVisibleRect(visible))
                assertEquals("The whole edit control must fit",button.height,visible.height())
                val scroll=decor.findViewWithTag<android.widget.ScrollView>("automation.scroll")
                assertTrue("Long journal must scroll",scroll.getChildAt(0).height>scroll.height)
                button.performClick()
                assertNull(activity.automationStatusDialog)
                assertTrue(activity.automationScheduleDialog!!.isShowing)
            }
        }
    }
}
