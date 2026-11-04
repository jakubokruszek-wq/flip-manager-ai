import { authenticateCollectorDevice, CollectorAuthError } from "@/features/collector/device-auth";
import { createMobileScanPost } from "@/features/collector/facebook-mobile-scan";
import { isEnabledWatchedFacebookSource } from "@/features/facebook-groups/server";
import { createAdminClient } from "@/lib/supabase/admin";
export const runtime="nodejs";
export const POST=createMobileScanPost({
  authenticate:authenticateCollectorDevice,
  authStatus:error=>error instanceof CollectorAuthError?error.status:null,
  allowed:group=>isEnabledWatchedFacebookSource({sourceId:group,type:"GROUP",url:`https://www.facebook.com/groups/${group}/`}),
  save:async(device,report)=>{
    const result=await createAdminClient().from("collector_mobile_scan_reports").upsert({device_id:device,batch_id:report.batchId,scan_id:report.scanId,source_id:report.groupId,app_version:report.appVersion,report},{onConflict:"device_id,batch_id",ignoreDuplicates:true});
    if(result.error)throw new Error("SCAN_REPORT_STORAGE_RETRY");
  },
});
