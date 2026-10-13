import { operatorAuthorizationResponse, requireOperator } from "@/features/auth/operator";
import { HISTORY_DELETE_CONFIRMATION, HISTORY_DELETE_ENV, historyDeleteEnabled, validateHistoryDeleteRequest } from "@/features/flip-finder/history-delete-guard";

import { createAdminClient } from "@/lib/supabase/admin";

const ACTIVE_SOURCE_STATUSES = ["pending", "running"];
const ACTIVE_JOB_STATUSES = ["queued", "claimed", "running"];

/**
 * Preview of the permanent delete: what it would remove (every filter and
 * portal) and whether it is enabled on this server. Reads counts only.
 */
export async function GET(): Promise<Response> {
  try {
    await requireOperator();
  } catch (error) {
    return operatorAuthorizationResponse(error);
  }
  try {
    const admin = createAdminClient();
    const [listings, snapshots, filters] = await Promise.all([
      admin.from("listings").select("id", { count: "exact", head: true }),
      admin.from("listing_snapshots").select("id", { count: "exact", head: true }),
      admin.from("search_filters").select("id", { count: "exact", head: true }),
    ]);
    const error = listings.error ?? snapshots.error ?? filters.error;
    if (error) {
      console.error("FLIP FINDER HISTORY PREVIEW ERROR:", error);
      return Response.json({ ok: false, code: "HISTORY_PREVIEW_FAILED" }, { status: 503 });
    }
    return Response.json({
      ok: true,
      enabled: historyDeleteEnabled(),
      enableVariable: HISTORY_DELETE_ENV,
      confirmation: HISTORY_DELETE_CONFIRMATION,
      listings: listings.count ?? 0,
      priceSnapshots: snapshots.count ?? 0,
      filters: filters.count ?? 0,
    });
  } catch (error) {
    console.error("FLIP FINDER HISTORY PREVIEW ERROR:", error);
    return Response.json({ ok: false, code: "HISTORY_PREVIEW_FAILED" }, { status: 503 });
  }
}

export async function DELETE(request: Request): Promise<Response> {
  try {
    await requireOperator();
  } catch (error) {
    return operatorAuthorizationResponse(error);
  }

  if (!historyDeleteEnabled()) {
    return Response.json({
      ok: false,
      code: "HISTORY_DELETE_DISABLED",
      message: `Trwałe usuwanie wszystkich ofert jest wyłączone na tym serwerze (${HISTORY_DELETE_ENV}). Aby ukryć wyniki filtra bez usuwania danych, użyj „Wyczyść wyniki”.`,
    }, { status: 403 });
  }

  try {
    const body: unknown = await request.json().catch(() => null);
    const admin = createAdminClient();
    const [sourceScans, facebookJobs, olxJobs, listings] = await Promise.all([
      admin.from("source_scans").select("id", { count: "exact", head: true }).in("status", ACTIVE_SOURCE_STATUSES),
      admin.from("facebook_scan_jobs").select("id", { count: "exact", head: true }).in("status", ACTIVE_JOB_STATUSES),
      admin.from("olx_scan_jobs").select("id", { count: "exact", head: true }).in("status", ACTIVE_JOB_STATUSES),
      admin.from("listings").select("id", { count: "exact", head: true }),
    ]);

    const preflightError = sourceScans.error ?? facebookJobs.error ?? olxJobs.error ?? listings.error;
    if (preflightError) {
      console.error("FLIP FINDER HISTORY CLEAR PREFLIGHT ERROR:", preflightError);
      return Response.json({ ok: false, code: "HISTORY_CLEAR_PREFLIGHT_FAILED" }, { status: 503 });
    }

    const activeWork = (sourceScans.count ?? 0) + (facebookJobs.count ?? 0) + (olxJobs.count ?? 0);
    if (activeWork > 0) {
      return Response.json({ ok: false, code: "HISTORY_CLEAR_SCAN_ACTIVE" }, { status: 409 });
    }

    const validation = validateHistoryDeleteRequest(body, listings.count ?? 0);
    if (!validation.ok) {
      return Response.json({ ok: false, code: validation.code, message: validation.message }, { status: validation.status });
    }

    const { data, error } = await admin
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
