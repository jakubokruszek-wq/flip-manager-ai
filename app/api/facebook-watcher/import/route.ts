import { FacebookSourceError } from "@/features/facebook-watcher/facebook-source-adapter";
import { importFacebookWatcher } from "@/features/facebook-watcher/server";
import { sendPendingAlertPush } from "@/features/push/alert-delivery";

export async function POST(request: Request) {
  try { const result=await importFacebookWatcher(await request.json());void sendPendingAlertPush().catch(error=>console.error("FACEBOOK IMPORT PUSH ERROR",error));return Response.json(result); }
  catch (error) { const status = error instanceof FacebookSourceError ? 400 : 500; return Response.json({ error: error instanceof Error ? error.message : "Import nie powiódł się.", code: error instanceof FacebookSourceError ? error.code : "IMPORT_FAILED" }, { status }); }
}
