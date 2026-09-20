import { authorizeFacebookWatcherAction } from "@/features/facebook-watcher/server/history-clear-auth";
import { authorizeFacebookOrphanOperator } from "@/features/facebook-watcher/server/facebook-orphan-auth";
import { listFacebookOrphans, repairFacebookOrphanFromCollectorEvidence } from "@/features/facebook-watcher/server";

export async function GET(request: Request): Promise<Response> {
  const auth = authorizeFacebookOrphanOperator(request);
  if (!auth.authorized) return Response.json({ ok: false, code: "FACEBOOK_ORPHAN_ACTION_FORBIDDEN" }, { status: auth.status });
  try { return Response.json({ ok: true, orphans: await listFacebookOrphans() }); }
  catch { return Response.json({ ok: false, code: "FACEBOOK_ORPHAN_LIST_FAILED" }, { status: 503 }); }
}

export async function POST(request: Request): Promise<Response> {
  // The auth check is the sole authorization boundary. The Origin/Fetch-
  // Metadata/action-header check below remains only as defense-in-depth
  // against same-origin browser CSRF-style requests; it must never be able
  // to grant access on its own, so it is checked strictly after auth.
  const auth = authorizeFacebookOrphanOperator(request);
  if (!auth.authorized) return Response.json({ ok: false, code: "FACEBOOK_ORPHAN_ACTION_FORBIDDEN" }, { status: auth.status });
  const denied = authorizeFacebookWatcherAction(request, "repair-facebook-orphan");
  if (denied) return denied;
  let listingId: unknown;
  try { listingId = (await request.json()).listingId; } catch { listingId = null; }
  if (typeof listingId !== "string" || !/^[0-9a-f-]{20,}$/i.test(listingId)) return Response.json({ ok: false, code: "INVALID_LISTING_ID" }, { status: 400 });
  try { return Response.json({ ok: true, ...(await repairFacebookOrphanFromCollectorEvidence(listingId)) }); }
  catch (error) {
    const message = error instanceof Error ? error.message : "FACEBOOK_ORPHAN_REPAIR_FAILED";
    const code = message.split(":", 1)[0];
    const known = ["FACEBOOK_ORPHAN_SOURCE_IDENTITY_MISSING", "FACEBOOK_ORPHAN_SOURCE_EVIDENCE_MISSING", "FACEBOOK_ORPHAN_NO_ACTIVE_FILTER", "FACEBOOK_ORPHAN_SOURCE_SCAN_READ_FAILED", "FACEBOOK_ORPHAN_REPAIR_NO_SOURCE_SCAN", "FACEBOOK_ORPHAN_REPAIR_IDENTITY_MISMATCH"];
    return Response.json({ ok: false, code: known.includes(code) ? code : "FACEBOOK_ORPHAN_REPAIR_FAILED" }, { status: known.includes(code) ? 409 : 503 });
  }
}
