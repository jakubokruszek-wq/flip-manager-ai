import "server-only";
import { sendPendingAlertPush } from "@/features/push/alert-delivery";
import { runVisibilityLifecycleCleanup } from "@/features/flip-finder/server/visibility-lifecycle";
import { runFacebookSchedulerTick } from "@/features/facebook-worker/scheduler";

export async function runFacebookWatchJob(){
  const scheduler=await runFacebookSchedulerTick();
  let push={sent:0,skipped:0};try{push=await sendPendingAlertPush();}catch(error){console.error("FACEBOOK WATCH PUSH ERROR",error);}
  let visibilityLifecycle={stale:0,archived:0};
  try{visibilityLifecycle=await runVisibilityLifecycleCleanup();}catch(error){console.error("FACEBOOK VISIBILITY LIFECYCLE ERROR",error);}
  return{scheduler,push,visibilityLifecycle};
}
