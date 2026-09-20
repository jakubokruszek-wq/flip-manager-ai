import { restoreFacebookWatcherListing } from "@/features/facebook-watcher/server";
import { authorizeFacebookWatcherAction } from "@/features/facebook-watcher/server/history-clear-auth";

type Context = { params: Promise<{ listingId: string }> };
export async function POST(request: Request, { params }: Context): Promise<Response> {
  const denied = authorizeFacebookWatcherAction(request, "restore-to-finder");
  if (denied) return denied;
  const listingId = (await params).listingId;
  if (!/^[0-9a-f-]{20,}$/i.test(listingId)) return Response.json({ ok: false, code: "INVALID_LISTING_ID" }, { status: 400 });
  try { return Response.json({ ok: true, ...(await restoreFacebookWatcherListing(listingId)) }); }
  catch (error) { return Response.json({ ok: false, code: error instanceof Error ? error.message.split(":", 1)[0] : "FACEBOOK_RESTORE_FAILED" }, { status: 503 }); }
}
