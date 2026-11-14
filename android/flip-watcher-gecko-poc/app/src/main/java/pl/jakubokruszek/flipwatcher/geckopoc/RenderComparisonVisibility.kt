package pl.jakubokruszek.flipwatcher.geckopoc

import android.app.Activity
import android.app.Application
import android.os.Bundle
import java.util.Collections
import java.util.IdentityHashMap

/** Passive diagnostic-only window tracking. The production worker keeps its own policy. */
internal object RenderComparisonVisibility {
 @Volatile var hasStartedActivity=true;private set
 @Volatile var foregroundEpoch=0L;private set
 private var installed=false
 fun install(application:Application){
  if(installed)return
  installed=true
  val started=Collections.newSetFromMap(IdentityHashMap<Activity,Boolean>())
  application.registerActivityLifecycleCallbacks(object:Application.ActivityLifecycleCallbacks{
   override fun onActivityStarted(activity:Activity){foregroundEpoch++;started.add(activity);hasStartedActivity=started.isNotEmpty()}
   override fun onActivityStopped(activity:Activity){started.remove(activity);hasStartedActivity=started.isNotEmpty()}
   override fun onActivityDestroyed(activity:Activity){started.remove(activity);hasStartedActivity=started.isNotEmpty()}
   override fun onActivityCreated(activity:Activity,state:Bundle?){}
   override fun onActivityResumed(activity:Activity){}
   override fun onActivityPaused(activity:Activity){}
   override fun onActivitySaveInstanceState(activity:Activity,state:Bundle){}
  })
  // Application.onCreate installs this before any Activity starts. Until then
  // the initial true fails closed if a WorkManager initializer runs first.
  hasStartedActivity=false
 }
}
class WatcherApplication:Application(){
 override fun onCreate(){super.onCreate();RenderComparisonVisibility.install(this)}
}
