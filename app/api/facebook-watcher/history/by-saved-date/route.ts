import { operatorAuthorizationResponse, requireOperator } from "@/features/auth/operator";
import { createFacebookWatcherAdminClient } from "@/features/facebook-watcher/supabase-admin";
import { authorizeFacebookWatcherAction } from "@/features/facebook-watcher/server/history-clear-auth";
import { savedCutoff } from "@/features/facebook-watcher/saved-cleanup";

const headers={"Cache-Control":"private, no-store"};
async function execute(before:unknown,apply:boolean,expected:unknown,db:ReturnType<typeof createFacebookWatcherAdminClient>){
  const cutoff=savedCutoff(before);
  if(apply&&(typeof expected!=="string"||!/^[a-f0-9]{32}$/.test(expected)))return Response.json({code:"CLEANUP_PREVIEW_REQUIRED"},{status:400,headers});
  const result=await db.rpc("facebook_watcher_cleanup_saved_before",{p_before:cutoff,p_apply:apply,p_expected:apply?expected:null});
  if(result.error)throw new Error(result.error.message);
  return Response.json({ok:true,...result.data},{headers});
}
function failure(error:unknown){
  const message=error instanceof Error?error.message:"";
  const code=message.includes("ACTIVE_FACEBOOK_WORK")?"ACTIVE_FACEBOOK_WORK":message.includes("CLEANUP_PREVIEW_CHANGED")?"CLEANUP_PREVIEW_CHANGED":message.includes("INVALID_SAVED_CUTOFF")?"INVALID_SAVED_CUTOFF":"SAVED_CLEANUP_UNAVAILABLE";
  return Response.json({ok:false,code},{status:code==="INVALID_SAVED_CUTOFF"?400:code==="SAVED_CLEANUP_UNAVAILABLE"?503:409,headers});
}
export async function GET(request:Request){
  try{await requireOperator();}catch(error){return operatorAuthorizationResponse(error);}
  try{return await execute(new URL(request.url).searchParams.get("before"),false,null,createFacebookWatcherAdminClient());}catch(error){return failure(error);}
}
export async function DELETE(request:Request){
  try{await requireOperator();}catch(error){return operatorAuthorizationResponse(error);}
  const denied=authorizeFacebookWatcherAction(request,"clear-watcher-history");if(denied)return denied;
  try{const body=await request.json();return await execute(body?.before,true,body?.token,createFacebookWatcherAdminClient());}catch(error){return failure(error);}
}
