package pl.jakubokruszek.flipwatcher.geckopoc

import android.graphics.Rect
import android.view.View
import android.view.Display
import androidx.activity.ComponentActivity
import androidx.lifecycle.Lifecycle
import org.mozilla.geckoview.GeckoView

/** Real visible PiP policy only. It grants no offer-reading or image ownership permission. */
internal object PipRenderVisibility {
 // Android supplies genuine PiP windows with a short edge of108px on some
 // displays. This diagnostic captures its real viewport; it does not encode
 // offer photos or relax the ordinary reader's128px minimum.
 const val MIN_VIEWPORT=64
 /** Count-only setup evidence. Failures retain the reason instead of a bare timeout. */
 fun snapshot(activity:ComponentActivity,view:GeckoView):Map<String,Int> {
  val rect=Rect();val hasRect=view.getGlobalVisibleRect(rect)
  return mapOf(
   "pipCheckMode" to if(activity.isInPictureInPictureMode)1 else 0,
   "pipCheckLifecycle" to activity.lifecycle.currentState.ordinal,
   "pipCheckContext" to if(view.context===activity)1 else 0,
   "pipCheckOwnRoot" to if(view.rootView===activity.window.decorView)1 else 0,
   "pipCheckAttached" to if(view.isAttachedToWindow)1 else 0,
   "pipCheckShown" to if(view.isShown)1 else 0,
   "pipCheckWindowVisible" to if(view.windowVisibility==View.VISIBLE)1 else 0,
   "pipCheckDisplayOn" to if(view.display?.state==Display.STATE_ON)1 else 0,
   "pipCheckWindows" to RenderComparisonVisibility.startedActivityCount,
   "pipMeasuredWidth" to view.width.coerceIn(0,100_000_000),
   "pipMeasuredHeight" to view.height.coerceIn(0,100_000_000),
   "pipCheckRect" to if(hasRect&&rect.width()>0&&rect.height()>0)1 else 0)
 }
 fun matches(activity:ComponentActivity,view:GeckoView,width:Int,height:Int):Boolean {
  if(!activity.isInPictureInPictureMode||activity.isFinishing||activity.isDestroyed||
   !activity.lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)||view.context!==activity||
   !view.isAttachedToWindow||!view.isShown||view.windowVisibility!=View.VISIBLE||
   view.display?.state!=Display.STATE_ON||view.width!=width||view.height!=height)return false
  val visible=Rect()
  return view.getGlobalVisibleRect(visible)&&visible.width()>0&&visible.height()>0
 }
}
