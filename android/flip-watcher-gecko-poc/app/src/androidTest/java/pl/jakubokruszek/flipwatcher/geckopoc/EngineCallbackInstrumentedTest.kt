package pl.jakubokruszek.flipwatcher.geckopoc
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.mozilla.geckoview.GeckoSession
@RunWith(AndroidJUnit4::class)
class EngineCallbackInstrumentedTest{
 @Test fun retiredSessionEngineEventsCannotCloseTheCurrentSession(){
  ActivityScenario.launch(PocActivity::class.java).use{scenario->scenario.onActivity{activity->
   val field=PocActivity::class.java.getDeclaredField("session").apply{isAccessible=true}
   val delegate=PocActivity::class.java.getDeclaredField("contentDelegate").apply{isAccessible=true}.get(activity) as GeckoSession.ContentDelegate
   val current=GeckoSession();val retired=GeckoSession();field.set(activity,current)
   delegate.onKill(retired);delegate.onCrash(retired);assertSame(current,field.get(activity))
   val title=activity.title;delegate.onTitleChange(retired,"Checkpoint");assertEquals(title,activity.title);assertSame(current,field.get(activity))
   delegate.onKill(current);assertNull(field.get(activity))
  }}
 }
}
