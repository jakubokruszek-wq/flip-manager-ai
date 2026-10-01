import { operatorAuthorizationResponse, requireOperator } from "@/features/auth/operator";
import {
  getWatcherScanIntervalMinutes,
  saveWatcherScanIntervalMinutes,
  WatcherScanIntervalValidationError,
} from "@/features/facebook-worker/scheduler-settings";

export async function GET(): Promise<Response> {
  try { await requireOperator(); }
  catch (error) { return operatorAuthorizationResponse(error); }
  try {
    return Response.json({ ok: true, intervalMinutes: await getWatcherScanIntervalMinutes() }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("WATCHER SCAN INTERVAL GET ERROR", error);
    return Response.json({ ok: false, code: "WATCHER_SCAN_INTERVAL_READ_FAILED" }, { status: 500 });
  }
}

export async function PUT(request: Request): Promise<Response> {
  try { await requireOperator(); }
  catch (error) { return operatorAuthorizationResponse(error); }
  let body: unknown;
  try { body = await request.json(); }
  catch { return Response.json({ ok: false, code: "INVALID_JSON" }, { status: 400 }); }
  try {
    const intervalMinutes = await saveWatcherScanIntervalMinutes((body as { intervalMinutes?: unknown } | null)?.intervalMinutes);
    return Response.json({ ok: true, intervalMinutes });
  } catch (error) {
    if (error instanceof WatcherScanIntervalValidationError) return Response.json({ ok: false, code: "INVALID_WATCHER_SCAN_INTERVAL" }, { status: 400 });
    if (error instanceof Error && error.message === "WATCHER_SCAN_INTERVAL_NO_ACTIVE_FILTER") return Response.json({ ok: false, code: error.message }, { status: 409 });
    console.error("WATCHER SCAN INTERVAL PUT ERROR", error);
    return Response.json({ ok: false, code: "WATCHER_SCAN_INTERVAL_WRITE_FAILED" }, { status: 500 });
  }
}
