import "server-only";
import { importFacebookWatcher } from "@/features/facebook-watcher/server";
import { sendPendingAlertPush } from "@/features/push/alert-delivery";
import { safeFacebookGroupAdapter } from "./adapter";
import { isFacebookGroupDue } from "./schedule";
import { listWatchedFacebookGroups, updateWatchedFacebookGroup } from "./server";

export async function runFacebookWatchJob(){
  const groups=(await listWatchedFacebookGroups()).filter(group=>isFacebookGroupDue(group)); const results=[];
  for(const group of groups){const started=Date.now();try{const check=await safeFacebookGroupAdapter.checkGroup(group);let imported=0;for(const post of check.posts){await importFacebookWatcher({...post,groupName:post.groupName??group.name});imported++;}await updateWatchedFacebookGroup(group.id,{accessStatus:check.status,lastCheckedAt:check.checkedAt,lastError:check.error??null});results.push({groupId:group.id,status:check.status,posts:check.posts.length,imported,durationMs:Date.now()-started,error:check.error??null});}catch(error){const message=error instanceof Error?error.message:String(error);await updateWatchedFacebookGroup(group.id,{accessStatus:"UNAVAILABLE",lastCheckedAt:new Date().toISOString(),lastError:message}).catch(()=>undefined);results.push({groupId:group.id,status:"UNAVAILABLE",posts:0,imported:0,durationMs:Date.now()-started,error:message});}}
  let push={sent:0,skipped:0};try{push=await sendPendingAlertPush();}catch(error){console.error("FACEBOOK WATCH PUSH ERROR",error);}return{checked:groups.length,groups:results,push};
}
