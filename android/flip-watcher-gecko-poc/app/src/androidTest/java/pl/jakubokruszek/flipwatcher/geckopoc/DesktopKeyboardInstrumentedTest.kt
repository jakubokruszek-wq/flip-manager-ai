package pl.jakubokruszek.flipwatcher.geckopoc

import android.os.ParcelFileDescriptor
import android.os.SystemClock
import android.view.ViewGroup
import android.view.WindowManager
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import android.widget.LinearLayout
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

/** Disposable emulator UI only; no Gecko session or Facebook navigation is opened. */
@RunWith(AndroidJUnit4::class)
class DesktopKeyboardInstrumentedTest {
    private fun shell(command:String)=ParcelFileDescriptor.AutoCloseInputStream(
        InstrumentationRegistry.getInstrumentation().uiAutomation.executeShellCommand(command)
    ).bufferedReader().use{it.readText().trim()}
    private fun await(scenario:ActivityScenario<GeckoTestHostActivity>,description:String,condition:(GeckoTestHostActivity)->Boolean){
        val deadline=SystemClock.elapsedRealtime()+7000
        while(SystemClock.elapsedRealtime()<deadline){var ready=false;scenario.onActivity{ready=condition(it)};if(ready)return;SystemClock.sleep(50)}
        fail(description)
    }
    @Test fun realImeDismissalRestoresTheBrowserSurfaceWithoutReadingInput(){
        val previous=shell("settings get secure show_ime_with_hard_keyboard")
        shell("settings put secure show_ime_with_hard_keyboard 1")
        try{ActivityScenario.launch(GeckoTestHostActivity::class.java).use{scenario->
            lateinit var input:EditText
            scenario.onActivity{host->
                WindowCompat.setDecorFitsSystemWindows(host.window,false)
                host.window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_NOTHING or WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_HIDDEN)
                val browser=host.geckoView;(browser.parent as ViewGroup).removeView(browser)
                val root=LinearLayout(host).apply{orientation=LinearLayout.VERTICAL;isFocusableInTouchMode=true}
                input=EditText(host).apply{hint="Synthetic input";isSingleLine=true}
                root.addView(input,LinearLayout.LayoutParams(-1,-2))
                root.addView(browser,LinearLayout.LayoutParams(-1,0,1f))
                ViewCompat.setOnApplyWindowInsetsListener(root){view,insets->
                    val bars=insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime())
                    view.setPadding(bars.left,bars.top,bars.right,bars.bottom);WindowInsetsCompat.CONSUMED
                }
                host.setContentView(root);root.requestFocus();ViewCompat.requestApplyInsets(root)
            }
            await(scenario,"browser never laid out without IME"){it.geckoView.height>300&&it.geckoView.hasWindowFocus()&&!DesktopKeyboard.visible(it.geckoView)}
            var fullHeight=0;scenario.onActivity{fullHeight=it.geckoView.height;input.requestFocus();it.getSystemService(InputMethodManager::class.java).showSoftInput(input,InputMethodManager.SHOW_IMPLICIT)}
            await(scenario,"real keyboard did not shrink the browser"){DesktopKeyboard.visible(it.geckoView)&&it.geckoView.height<fullHeight}
            var smallHeight=0;scenario.onActivity{smallHeight=it.geckoView.height;DesktopKeyboard.dismiss(it.geckoView)}
            await(scenario,"preview did not dismiss IME and restore browser height"){!DesktopKeyboard.visible(it.geckoView)&&it.geckoView.height>=fullHeight-4}
            scenario.onActivity{assertTrue(it.geckoView.height>smallHeight);assertTrue(it.geckoView.isShown)}
        }}finally{if(previous in setOf("0","1"))shell("settings put secure show_ime_with_hard_keyboard $previous") else shell("settings delete secure show_ime_with_hard_keyboard")}
    }
}
