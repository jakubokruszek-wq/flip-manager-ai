package pl.jakubokruszek.flipwatcher.geckopoc

import android.graphics.Rect
import android.view.View
import android.view.Display
import androidx.activity.ComponentActivity
import androidx.lifecycle.Lifecycle
import org.mozilla.geckoview.GeckoView

/** Real visible PiP policy only. It grants no offer-reading or image ownership permission. */
internal object PipRenderVisibility {
 fun matches(activity:ComponentActivity,view:GeckoView,width:Int,height:Int):Boolean {
  if(!activity.isInPictureInPictureMode||activity.isFinishing||activity.isDestroyed||
   !activity.lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)||view.context!==activity||
   !view.isAttachedToWindow||!view.isShown||view.windowVisibility!=View.VISIBLE||
   view.display?.state!=Display.STATE_ON||view.width!=width||view.height!=height)return false
  val visible=Rect()
  return view.getGlobalVisibleRect(visible)&&visible.width()>0&&visible.height()>0
 }
}
