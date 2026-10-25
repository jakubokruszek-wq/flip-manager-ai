package pl.jakubokruszek.flipwatcher.geckopoc

import android.view.View
import android.view.inputmethod.InputMethodManager
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

/** Close the IME on an explicit preview action; never inspect an input's contents. */
object DesktopKeyboard {
    fun visible(view:View)=ViewCompat.getRootWindowInsets(view)?.isVisible(WindowInsetsCompat.Type.ime())==true
    fun dismiss(view:View){
        if(!view.isAttachedToWindow)return
        ViewCompat.getWindowInsetsController(view)?.hide(WindowInsetsCompat.Type.ime())
        view.context.getSystemService(InputMethodManager::class.java)?.hideSoftInputFromWindow(view.windowToken,0)
    }
}
