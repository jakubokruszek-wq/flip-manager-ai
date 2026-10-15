import type { SupabaseClient } from "@supabase/supabase-js";
import type { AndroidFinderOwnership } from "./import-policy";
export type AndroidFinderWrite = { listingId: string; created: number; updated: number; duplicates: number; matched: boolean; matchCreated: boolean; priceDrop: number };
export async function persistAndroidFinderPost(db: SupabaseClient, owner: AndroidFinderOwnership, input: {
  sourceScanId: string; postId: string | null; listing: Record<string, unknown>; metadata: Record<string, unknown>;
  decision: { bucket: string; reasons: string[]; missingFields: string[] }; checkedAt: string;
}): Promise<AndroidFinderWrite> {
  if (input.sourceScanId !== owner.sourceScanId || !input.postId) throw Error("ANDROID_FINDER_CONTEXT_INVALID");
  const result=await db.rpc("persist_android_facebook_finder_post",{
    p_job_id:owner.jobId,p_device_id:owner.deviceId,p_lease_token:owner.leaseToken,p_completion_id:owner.completionId,p_payload_hash:owner.payloadHash,
    p_post_id:input.postId,p_listing:input.listing,p_metadata:input.metadata,p_decision:input.decision,p_checked_at:input.checkedAt,
  });
  if(result.error) throw Error("ANDROID_FINDER_TRANSACTION_FAILED",{cause:result.error.code});
  const value: unknown = result.data;
  if(!value || typeof value!=="object" || Array.isArray(value)) throw Error("ANDROID_FINDER_RECEIPT_INVALID");
  const row=value as Record<string,unknown>;
  if(typeof row.listingId!=="string" || !/^[a-f0-9-]{36}$/.test(row.listingId) ||
      typeof row.created!=="number" || typeof row.updated!=="number" || typeof row.duplicates!=="number" ||
      ![row.created,row.updated,row.duplicates].every(n=>n===0||n===1) || row.created+row.updated+row.duplicates!==1 ||
      typeof row.matched!=="boolean" || typeof row.matchCreated!=="boolean" || (row.priceDrop!==0 && row.priceDrop!==1)) throw Error("ANDROID_FINDER_RECEIPT_INVALID");
  return {listingId:row.listingId,created:row.created,updated:row.updated,duplicates:row.duplicates,matched:row.matched,matchCreated:row.matchCreated,priceDrop:row.priceDrop};
}
