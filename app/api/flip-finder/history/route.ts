import { authorizeHistoryClear } from "@/features/flip-finder/server/history-clear-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

const ACTIVE_SOURCE_STATUSES = ["pending", "running"];
const ACTIVE_JOB_STATUSES = ["queued", "claimed", "running"];

export async function DELETE(request: Request): Promise<Response> {
  const authorizationError = authorizeHistoryClear(request);
  if (authorizationError) return authorizationError;

  try {
    const admin = createAdminClient();
    const [sourceScans, facebookJobs, olxJobs] = await Promise.all([
      admin.from("source_scans").select("id", { count: "exact", head: true }).in("status", ACTIVE_SOURCE_STATUSES),
      admin.from("facebook_scan_jobs").select("id", { count: "exact", head: true }).in("status", ACTIVE_JOB_STATUSES),
      admin.from("olx_scan_jobs").select("id", { count: "exact", head: true }).in("status", ACTIVE_JOB_STATUSES),
    ]);

    const preflightError = sourceScans.error ?? facebookJobs.error ?? olxJobs.error;
    if (preflightError) {
      console.error("FLIP FINDER HISTORY CLEAR PREFLIGHT ERROR:", preflightError);
      return Response.json({ ok: false, code: "HISTORY_CLEAR_PREFLIGHT_FAILED" }, { status: 503 });
    }

    const activeWork = (sourceScans.count ?? 0) + (facebookJobs.count ?? 0) + (olxJobs.count ?? 0);
    if (activeWork > 0) {
      return Response.json({ ok: false, code: "HISTORY_CLEAR_SCAN_ACTIVE" }, { status: 409 });
    }

    const supabase = await createClient();
    const { data, error } = await supabase
      .from("listings")
      .delete()
      .not("id", "is", null)
      .select("id");

    if (error) {
      console.error("FLIP FINDER HISTORY CLEAR DELETE ERROR:", error);
      return Response.json({ ok: false, code: "HISTORY_CLEAR_FAILED" }, { status: 503 });
    }

    return Response.json({ ok: true, deletedListings: data?.length ?? 0 });
  } catch (error) {
    console.error("FLIP FINDER HISTORY CLEAR ERROR:", error);
    return Response.json({ ok: false, code: "HISTORY_CLEAR_FAILED" }, { status: 503 });
  }
}
