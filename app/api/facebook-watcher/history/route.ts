import { authorizeFacebookWatcherAction } from "@/features/facebook-watcher/server/history-clear-auth";
import { clearFacebookWatcherHistory, getFacebookWatcherHistorySummary } from "@/features/facebook-watcher/server/history-clear";

export async function GET(): Promise<Response> {
  try { return Response.json({ ok: true, ...(await getFacebookWatcherHistorySummary()) }); }
  catch { return Response.json({ ok: false, code: "FACEBOOK_WATCHER_HISTORY_READ_FAILED" }, { status: 503 }); }
}

export async function DELETE(request: Request): Promise<Response> {
  const denied = authorizeFacebookWatcherAction(request, "clear-watcher-history");
  if (denied) return denied;
  try { return Response.json({ ok: true, ...(await clearFacebookWatcherHistory()) }); }
  catch (error) {
    const code = error instanceof Error ? error.message.split(":", 1)[0] : "FACEBOOK_WATCHER_HISTORY_CLEAR_FAILED";
    const status = code.startsWith("ACTIVE_FACEBOOK") ? 409 : 503;
    return Response.json({ ok: false, code }, { status });
  }
}
