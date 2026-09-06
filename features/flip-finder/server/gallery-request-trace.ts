import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";

export const GALLERY_TRACE_EVENTS = [
  "GALLERY_BUTTON_RENDERED",
  "GALLERY_CARD_POINTER_CAPTURE",
  "GALLERY_BUTTON_POINTER_CAPTURE",
  "GALLERY_CARD_CLICK_CAPTURE",
  "GALLERY_BUTTON_CLICK_CAPTURE",
  "GALLERY_UI_CLICK",
  "GALLERY_HANDLER_ENTER",
  "GALLERY_GUARD_PASS",
  "GALLERY_GUARD_BLOCKED",
  "GALLERY_FETCH_START",
  "GALLERY_FETCH_RESPONSE",
  "GALLERY_FETCH_ERROR",
] as const;

export const GALLERY_TRACE_STATUSES = ["NOT_REQUESTED", "PENDING", "RUNNING", "PARTIAL", "COMPLETE", "FAILED"] as const;

export type GalleryTraceEvent = (typeof GALLERY_TRACE_EVENTS)[number];
export type GalleryTraceStatus = (typeof GALLERY_TRACE_STATUSES)[number];

export type GalleryRequestTrace = {
  traceId: string;
  listingId: string;
  postId: string | null;
  event: GalleryTraceEvent;
  galleryStatus: GalleryTraceStatus;
  timestamp: string;
  targetTag: string | null;
  currentTargetTag: string | null;
  disabled: boolean | null;
  pointerEvents: string | null;
  guardReason: string | null;
  httpStatus: number | null;
  responseOk: boolean | null;
  errorCode: string | null;
  source: string | null;
  clientBuild: string | null;
  component: string | null;
  buttonRendered: boolean | null;
  createdAt: string;
};

type TraceRow = {
  trace_id: string;
  listing_id: string;
  post_id: string | null;
  event: GalleryTraceEvent;
  gallery_status: GalleryTraceStatus;
  client_timestamp: string | null;
  target_tag: string | null;
  current_target_tag: string | null;
  disabled: boolean | null;
  pointer_events: string | null;
  guard_reason: string | null;
  http_status: number | null;
  response_ok: boolean | null;
  error_code: string | null;
  source: string | null;
  client_build: string | null;
  component: string | null;
  button_rendered: boolean | null;
  created_at: string;
};

const MAX_TRACE_ROWS = 80;

function isRenderProbeSchemaMissing(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  return error.code === "42703" || error.code === "PGRST204" || /column .* does not exist|schema cache/i.test(error.message ?? "");
}

export function projectGalleryTrace(value: unknown, listingId: string): Omit<GalleryRequestTrace, "createdAt"> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const traceId = typeof row.traceId === "string" && /^[A-Za-z0-9-]{8,80}$/.test(row.traceId) ? row.traceId : null;
  const event = typeof row.stage === "string" && (GALLERY_TRACE_EVENTS as readonly string[]).includes(row.stage) ? row.stage as GalleryTraceEvent : null;
  const galleryStatus = typeof row.galleryStatus === "string" && (GALLERY_TRACE_STATUSES as readonly string[]).includes(row.galleryStatus) ? row.galleryStatus as GalleryTraceStatus : null;
  if (!traceId || !event || !galleryStatus) return null;
  const postId = typeof row.postId === "string" && /^\d{5,30}$/.test(row.postId) ? row.postId : null;
  const timestamp = typeof row.timestamp === "string" && !Number.isNaN(Date.parse(row.timestamp)) ? new Date(row.timestamp).toISOString() : new Date().toISOString();
  const boundedString = (key: string, max: number): string | null => typeof row[key] === "string" ? row[key].slice(0, max) : null;
  const boundedHttpStatus = Number.isInteger(row.httpStatus) && Number(row.httpStatus) >= 100 && Number(row.httpStatus) <= 599 ? Number(row.httpStatus) : null;
  const source = row.source === "facebook" ? "facebook" : null;
  const component = row.component === "GalleryRequestButton" ? "GalleryRequestButton" : null;
  return {
    traceId,
    listingId,
    postId,
    event,
    galleryStatus,
    timestamp,
    targetTag: boundedString("targetTag", 30),
    currentTargetTag: boundedString("currentTargetTag", 30),
    disabled: typeof row.disabled === "boolean" ? row.disabled : null,
    pointerEvents: boundedString("pointerEvents", 30),
    guardReason: boundedString("guard", 60),
    httpStatus: boundedHttpStatus,
    responseOk: typeof row.responseOk === "boolean" ? row.responseOk : null,
    errorCode: boundedString("errorCode", 120),
    source,
    clientBuild: boundedString("clientBuild", 120),
    component,
    buttonRendered: typeof row.buttonRendered === "boolean" ? row.buttonRendered : null,
  };
}

function fromRow(row: TraceRow): GalleryRequestTrace {
  return {
    traceId: row.trace_id,
    listingId: row.listing_id,
    postId: row.post_id,
    event: row.event,
    galleryStatus: row.gallery_status,
    timestamp: row.client_timestamp ?? row.created_at,
    targetTag: row.target_tag,
    currentTargetTag: row.current_target_tag,
    disabled: row.disabled,
    pointerEvents: row.pointer_events,
    guardReason: row.guard_reason,
    httpStatus: row.http_status,
    responseOk: row.response_ok,
    errorCode: row.error_code,
    source: row.source,
    clientBuild: row.client_build,
    component: row.component,
    buttonRendered: row.button_rendered,
    createdAt: row.created_at,
  };
}

export async function writeGalleryTrace(trace: Omit<GalleryRequestTrace, "createdAt">): Promise<void> {
  const admin = createAdminClient();
  const basePayload = {
    trace_id: trace.traceId,
    listing_id: trace.listingId,
    post_id: trace.postId,
    event: trace.event,
    gallery_status: trace.galleryStatus,
    client_timestamp: trace.timestamp,
    target_tag: trace.targetTag,
    current_target_tag: trace.currentTargetTag,
    disabled: trace.disabled,
    pointer_events: trace.pointerEvents,
    guard_reason: trace.guardReason,
    http_status: trace.httpStatus,
    response_ok: trace.responseOk,
    error_code: trace.errorCode,
  };
  const { error } = await admin.from("gallery_request_traces").insert({
    ...basePayload,
    source: trace.source,
    client_build: trace.clientBuild,
    component: trace.component,
    button_rendered: trace.buttonRendered,
  });
  if (error && isRenderProbeSchemaMissing(error) && trace.event !== "GALLERY_BUTTON_RENDERED") {
    const { error: legacyError } = await admin.from("gallery_request_traces").insert(basePayload);
    if (legacyError) throw new Error("GALLERY_TRACE_STORE_FAILED");
    return;
  }
  if (error) throw new Error("GALLERY_TRACE_STORE_FAILED");
}

export async function readGalleryTraces(listingId: string, traceId?: string): Promise<GalleryRequestTrace[]> {
  const admin = createAdminClient();
  const select = "trace_id,listing_id,post_id,event,gallery_status,client_timestamp,target_tag,current_target_tag,disabled,pointer_events,guard_reason,http_status,response_ok,error_code,source,client_build,component,button_rendered,created_at";
  let query = admin.from("gallery_request_traces").select(select).eq("listing_id", listingId).order("created_at", { ascending: true }).limit(MAX_TRACE_ROWS);
  if (traceId) query = query.eq("trace_id", traceId);
  const { data, error } = await query;
  if (!error) return (data as TraceRow[] | null ?? []).map(fromRow);
  if (!isRenderProbeSchemaMissing(error)) throw new Error("GALLERY_TRACE_READ_FAILED");
  let legacyQuery = admin.from("gallery_request_traces").select("trace_id,listing_id,post_id,event,gallery_status,client_timestamp,target_tag,current_target_tag,disabled,pointer_events,guard_reason,http_status,response_ok,error_code,created_at").eq("listing_id", listingId).order("created_at", { ascending: true }).limit(MAX_TRACE_ROWS);
  if (traceId) legacyQuery = legacyQuery.eq("trace_id", traceId);
  const { data: legacyData, error: legacyError } = await legacyQuery;
  if (legacyError) throw new Error("GALLERY_TRACE_READ_FAILED");
  return (legacyData as TraceRow[] | null ?? []).map((row) => fromRow({ ...row, source: null, client_build: null, component: null, button_rendered: null }));
}
