import { operatorAuthorizationResponse, requireOperator } from "@/features/auth/operator";

import { clearFacebookWatcherHistory, getFacebookWatcherHistorySummary } from "@/features/facebook-watcher/server/history-clear";

export async function GET(): Promise<Response> {
  try {
    await requireOperator();
  } catch (error) {
    return operatorAuthorizationResponse(error);
  }
  try { return Response.json({ ok: true, ...(await getFacebookWatcherHistorySummary()) }); }
  catch { return Response.json({ ok: false, code: "FACEBOOK_WATCHER_HISTORY_READ_FAILED" }, { status: 503 }); }
}

export async function DELETE(_request: Request): Promise<Response> {
  try {
    await requireOperator();
  } catch (error) {
    return operatorAuthorizationResponse(error);
  }
  try { return Response.json({ ok: true, ...(await clearFacebookWatcherHistory()) }); }
  catch (error) {
    const code = error instanceof Error ? error.message.split(":", 1)[0] : "FACEBOOK_WATCHER_HISTORY_CLEAR_FAILED";
    const status = code.startsWith("ACTIVE_FACEBOOK") ? 409 : 503;
    return Response.json({ ok: false, code }, { status });
  }
}
