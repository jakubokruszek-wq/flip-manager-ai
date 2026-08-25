import { authenticateFacebookWorkerRequest } from "@/features/facebook-worker/auth";
import { FACEBOOK_IMAGE_REVALIDATION_VERSION } from "@/features/facebook-worker/image-revalidation";
import { createFacebookWatcherAdminClient } from "@/features/facebook-watcher/supabase-admin";
import type { FacebookImageRevalidationTarget } from "@/features/facebook-worker/types";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const auth = await authenticateFacebookWorkerRequest(request);
  if (!auth.ok) return auth.response;
  try {
    const input = parseInput(JSON.parse(auth.body) as unknown);
    const supabase = createFacebookWatcherAdminClient();
    let query = supabase.from("listings").select("id,external_listing_id,images,original_url").eq("source", "facebook").eq("status", "active").not("images", "eq", "[]").order("updated_at", { ascending: true }).limit(200);
    if (input.listingId) query = query.eq("id", input.listingId);
    if (input.postId) query = query.eq("external_listing_id", input.postId);
    const listings = await query;
    if (listings.error) throw new Error(`FACEBOOK_REVALIDATION_LISTINGS_FAILED: ${listings.error.message}`);
    const ids = (listings.data ?? []).map((row) => String(row.id));
    const metadata = ids.length ? await supabase.from("listing_source_metadata").select("listing_id,source_post_url,metadata,collected_at").in("listing_id", ids).order("collected_at", { ascending: false }) : { data: [], error: null };
    if (metadata.error) throw new Error(`FACEBOOK_REVALIDATION_METADATA_FAILED: ${metadata.error.message}`);
    const latest = new Map<string, Record<string, unknown>>();
    const links = new Map<string, string>();
    for (const row of metadata.data ?? []) {
      const id = String(row.listing_id);
      if (!latest.has(id)) latest.set(id, asRow(row.metadata));
      if (!links.has(id)) links.set(id, String(row.source_post_url));
    }
    const targets: FacebookImageRevalidationTarget[] = (listings.data ?? []).flatMap((row) => {
      const images = Array.isArray(row.images) ? row.images.filter((value): value is string => typeof value === "string") : [];
      const listingId = String(row.id);
      const postId = String(row.external_listing_id);
      const metadataRow = latest.get(listingId) ?? {};
      const perImage = Array.isArray(metadataRow.imageProvenance) ? metadataRow.imageProvenance : [];
      const version = typeof metadataRow.imageRevalidationVersion === "number" ? metadataRow.imageRevalidationVersion : null;
      const hasPerImageProvenance = perImage.length === images.length && perImage.every((item) => {
        const provenance = asRow(item);
        return String(provenance.sourcePostId ?? "") === postId && (String(provenance.storyRootPostId ?? "") === postId || provenance.structuredPostMediaProvenance === true);
      });
      if (images.length === 0 || (hasPerImageProvenance && version === FACEBOOK_IMAGE_REVALIDATION_VERSION)) return [];
      const permalink = links.get(listingId) ?? String(row.original_url ?? "");
      if (!isExactFacebookPostUrl(permalink, postId)) return [];
      return [{ listingId, postId, permalink, currentImages: images }];
    }).slice(0, input.limit);
    return Response.json({ targets });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "FACEBOOK_REVALIDATION_LIST_FAILED" }, { status: 422 });
  }
}

function parseInput(value: unknown): { limit: number; listingId: string | null; postId: string | null } {
  const row = asRow(value);
  const rawLimit = row.limit === undefined ? 5 : Number(row.limit);
  if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 50) throw new Error("INVALID_REVALIDATION_LIMIT");
  return { limit: rawLimit, listingId: optionalId(row.listingId), postId: optionalId(row.postId) };
}
function optionalId(value: unknown): string | null { return value === undefined || value === null || value === "" ? null : typeof value === "string" && value.length <= 300 ? value : (() => { throw new Error("INVALID_REVALIDATION_ID"); })(); }
function asRow(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function isExactFacebookPostUrl(value: string, postId: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && /(^|\.)facebook\.com$/i.test(url.hostname) && new RegExp(`/posts/${postId}/?$`, "i").test(url.pathname) && !url.searchParams.has("comment_id");
  } catch { return false; }
}
