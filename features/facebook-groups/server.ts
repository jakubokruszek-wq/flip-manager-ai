import "server-only";
import { randomUUID } from "node:crypto";
import { createFacebookWatcherAdminClient } from "@/features/facebook-watcher/supabase-admin";
import { FACEBOOK_PRODUCTION_SOURCES } from "@/features/collector/facebook-production";
import { FacebookGroupValidationError, findDuplicateFacebookGroup, normalizeFacebookSourceUrl, parseFacebookGroupCreatePayload } from "./group-url";
import { parseFacebookGroupManagementPatch, safeRemovePatch } from "./management";
import { buildGroupImportPreview, buildHistoricalFacebookSourceMapping, type DiscoveredFacebookGroupCandidate, type FacebookGroupImportPreviewItem, type HistoricalFacebookSourceMapping } from "./discovery";
import { createDiscoverySession, markDiscoverySessionConsumed, resolveDiscoverySessionToken } from "./discovery-session";
import type { AddWatchedFacebookGroupResult, FacebookGroupAccessStatus, FacebookGroupInput, WatchedFacebookGroup } from "./types";

type Row = Record<string, unknown>;
const memoryGroups: Map<string, WatchedFacebookGroup> = (globalThis as typeof globalThis & { __watchedFacebookGroups?: Map<string, WatchedFacebookGroup> }).__watchedFacebookGroups ?? new Map();
(globalThis as typeof globalThis & { __watchedFacebookGroups?: Map<string, WatchedFacebookGroup> }).__watchedFacebookGroups = memoryGroups;

export async function listWatchedFacebookGroups(): Promise<WatchedFacebookGroup[]> {
  const supabase = createFacebookWatcherAdminClient();
  const result = await supabase.from("watched_facebook_groups").select("*").order("priority").order("name");
  if (!result.error) return (result.data ?? []).map(fromRow);
  if (!missingTable(result.error.message)) throw new Error(`Nie udało się pobrać grup: ${result.error.message}`);
  return [...memoryGroups.values()];
}

/**
 * The canonical runtime eligibility check: is this source currently an
 * enabled row in the database-backed group registry? Used by the collector
 * batch-ingest boundary (features/collector/facebook-batch-server.ts) so a
 * newly imported, active group's collected results are never silently
 * rejected there even though the scheduler has already started enqueueing
 * jobs for it -- both sides of the pipeline must agree on the same single
 * registry, or "imported groups are actually scanned" would be false in a
 * more insidious way (the job runs, but its results are discarded).
 */
export async function isEnabledWatchedFacebookSource(candidate: { sourceId: string; type: "GROUP" | "PROFILE"; url: string }): Promise<boolean> {
  let normalized: { url: string; identifier: string } | null;
  try { normalized = normalizeFacebookSourceUrl(candidate.url, candidate.type); } catch { normalized = null; }
  // The collector sends both fields.  Require them to describe the same
  // canonical identity; accepting a matching sourceId with a different URL
  // would let a malformed or stale batch cross the registry boundary.
  if (!normalized || normalized.identifier !== candidate.sourceId.toLocaleLowerCase("en-US")) return false;
  const groups = await listWatchedFacebookGroups();
  return groups.some((group) => group.enabled && group.type === candidate.type && group.sourceId?.toLocaleLowerCase("en-US") === normalized.identifier);
}

export async function createWatchedFacebookGroup(input: FacebookGroupInput): Promise<WatchedFacebookGroup> {
  const group = normalize({ ...input, id: randomUUID(), nameVerified: true, accessStatus: "MANUAL_IMPORT", lastCheckedAt: null, importedPosts: 0, newToday: 0, opportunities: 0, lastError: null });
  const supabase = createFacebookWatcherAdminClient();
  const result = await supabase.from("watched_facebook_groups").insert(toRow(group)).select("*").single();
  if (!result.error && result.data) return fromRow(result.data);
  if (!result.error || !missingTable(result.error.message)) throw new Error(`Nie udało się zapisać grupy: ${result.error?.message ?? "brak danych"}`);
  memoryGroups.set(group.id, group); return group;
}

export async function addWatchedFacebookGroup(value: unknown): Promise<AddWatchedFacebookGroupResult> {
  try {
    const normalized = parseFacebookGroupCreatePayload(value);
    const existingGroups = await listWatchedFacebookGroups();
    const duplicate = findDuplicateFacebookGroup(existingGroups, normalized.input.url, normalized.identifier, FACEBOOK_PRODUCTION_SOURCES);
    if (duplicate) return duplicateResult(duplicate);
    try {
      return { success: true, duplicate: false, group: await createWatchedFacebookGroup(normalized.input) };
    } catch (error) {
      if (error instanceof Error && /23505|duplicate key|unique constraint/i.test(error.message)) {
        const racedDuplicate = findDuplicateFacebookGroup(await listWatchedFacebookGroups(), normalized.input.url, normalized.identifier, FACEBOOK_PRODUCTION_SOURCES);
        if (racedDuplicate) return duplicateResult(racedDuplicate);
      }
      throw error;
    }
  } catch (error) {
    if (error instanceof FacebookGroupValidationError) return { success: false, duplicate: false, validationError: true, error: error.message };
    throw error;
  }
}

function duplicateResult(duplicate: ReturnType<typeof findDuplicateFacebookGroup<WatchedFacebookGroup>>): AddWatchedFacebookGroupResult {
  if (!duplicate) throw new Error("INVARIANT: duplicateResult called without a duplicate");
  if (duplicate.kind === "watched-group") return { success: false, duplicate: true, error: "Ta grupa jest już obserwowana.", group: duplicate.group };
  return { success: false, duplicate: true, error: "Ta grupa jest już zatwierdzonym źródłem produkcyjnym Watchera (jeszcze nie dodaną ręcznie do listy obserwowanych).", group: null, productionSource: duplicate.source };
}

export async function updateWatchedFacebookGroup(id: string, patch: Partial<FacebookGroupInput> & { accessStatus?: FacebookGroupAccessStatus; lastCheckedAt?: string | null; lastError?: string | null }): Promise<WatchedFacebookGroup> {
  const supabase = createFacebookWatcherAdminClient();
  const values: Row = {};
  if (patch.name !== undefined) values.name = patch.name.trim(); if (patch.url !== undefined) values.url = validateUrl(patch.url, patch.type ?? "GROUP");
  if (patch.city !== undefined) values.city = patch.city.trim(); if (patch.district !== undefined) values.district = nullable(patch.district);
  if (patch.neighborhood !== undefined) values.neighborhood = nullable(patch.neighborhood); if (patch.priority !== undefined) values.priority = patch.priority;
  if (patch.keywords !== undefined) values.keywords = patch.keywords.map(value => value.trim()).filter(Boolean); if (patch.enabled !== undefined) values.enabled = patch.enabled;
  if (patch.accessStatus !== undefined) values.access_status = patch.accessStatus; if (patch.lastCheckedAt !== undefined) values.last_checked_at = patch.lastCheckedAt;
  if (patch.lastError !== undefined) values.last_error = patch.lastError;
  const result = await supabase.from("watched_facebook_groups").update(values).eq("id", id).select("*").single();
  if (!result.error && result.data) return fromRow(result.data);
  if (!result.error || !missingTable(result.error.message)) throw new Error(`Nie udało się zaktualizować grupy: ${result.error?.message ?? "brak danych"}`);
  const current = memoryGroups.get(id); if (!current) throw new Error("Nie znaleziono obserwowanej grupy.");
  const next = normalize({ ...current, ...patch }); memoryGroups.set(id, next); return next;
}

export async function updateWatchedFacebookGroupDetails(id: string, value: unknown): Promise<WatchedFacebookGroup> {
  validateGroupId(id);
  return updateWatchedFacebookGroup(id, parseFacebookGroupManagementPatch(value));
}

export async function removeWatchedFacebookGroup(id: string): Promise<WatchedFacebookGroup> {
  validateGroupId(id);
  return updateWatchedFacebookGroup(id, safeRemovePatch());
}

/**
 * The extension runs "Wykryj grupy nieruchomościowe" on an authenticated
 * facebook.com tab, entirely separate from the Manager page the user reviews
 * the preview on. Candidates are handed off through a private, expiring,
 * database-backed session (facebook_group_discovery_sessions) identified by
 * an opaque one-time token -- never through module/global memory, which does
 * not survive a Vercel cold start or work across concurrent serverless
 * instances (a confirmed, real defect this replaces). Never classifies or
 * writes a watched-group row here: previewDiscoveryToken classifies fresh at
 * read time (so duplicate detection reflects the current registry, not a
 * stale snapshot), and importSelectedFacebookGroups is the only write path.
 */
export async function discoverFacebookGroups(candidates: DiscoveredFacebookGroupCandidate[], deviceId: string | null): Promise<{ token: string; expiresAt: string }> {
  return createDiscoverySession(candidates, deviceId);
}

export type FacebookGroupDiscoveryPreview = { preview: FacebookGroupImportPreviewItem[]; expiresAt: string; consumedAt: string | null };

/**
 * Requires a valid, unexpired session token -- returns null for any wrong,
 * expired, or nonexistent token, never falling back to some other session's
 * or a globally-shared result. Classifies fresh against the CURRENT
 * watched-group registry and production sources every time it is called,
 * so an import made from a second tab in between two preview reads is
 * correctly reflected.
 */
export async function previewDiscoveryToken(token: string): Promise<FacebookGroupDiscoveryPreview | null> {
  const session = await resolveDiscoverySessionToken(token);
  if (!session) return null;
  const existingGroups = await listWatchedFacebookGroups();
  const preview = buildGroupImportPreview(session.candidates, existingGroups, FACEBOOK_PRODUCTION_SOURCES);
  return { preview, expiresAt: session.expiresAt, consumedAt: session.consumedAt };
}

export type FacebookGroupImportSelection = { url: string; name: string; city?: string; priority?: "normal" | "high" };
export type FacebookGroupImportOutcome = { url: string; result: AddWatchedFacebookGroupResult };

/**
 * The only write path a discovered candidate can ever reach. Requires a
 * valid session token and revalidates every selection's URL against that
 * SAME session's own stored candidates -- an arbitrary client-supplied URL/
 * name pair that was never actually discovered in this session is rejected
 * outright, and a URL from a different session's token can never be
 * referenced ("no cross-session candidate access"). Each import still goes
 * through addWatchedFacebookGroup's own required-name and duplicate
 * validation exactly as the manual "add group" form does, so a discovered
 * group can never skip either check just because it arrived through
 * discovery instead. Every selection is processed and reported
 * independently, so one failure never silently drops the rest.
 */
export async function importSelectedFacebookGroups(token: string, selections: FacebookGroupImportSelection[]): Promise<FacebookGroupImportOutcome[] | null> {
  const session = await resolveDiscoverySessionToken(token);
  if (!session) return null;
  const sessionUrls = new Set(session.candidates.flatMap((candidate) => { try { return [normalizeFacebookSourceUrl(candidate.url, "GROUP").url]; } catch { return []; } }));
  const outcomes: FacebookGroupImportOutcome[] = [];
  for (const selection of selections) {
    let normalizedUrl: string | null = null;
    try { normalizedUrl = normalizeFacebookSourceUrl(selection.url, "GROUP").url; } catch { normalizedUrl = null; }
    if (!normalizedUrl || !sessionUrls.has(normalizedUrl)) {
      outcomes.push({ url: selection.url, result: { success: false, duplicate: false, validationError: true, error: "Ta grupa nie pochodzi z autoryzowanej sesji wykrywania." } });
      continue;
    }
    const result = await addWatchedFacebookGroup({ url: selection.url, name: selection.name, city: selection.city, priority: selection.priority });
    outcomes.push({ url: selection.url, result });
  }
  await markDiscoverySessionConsumed(session.id);
  return outcomes;
}

export async function getHistoricalFacebookSourceMapping(): Promise<HistoricalFacebookSourceMapping[]> {
  const existingGroups = await listWatchedFacebookGroups();
  return buildHistoricalFacebookSourceMapping(existingGroups, FACEBOOK_PRODUCTION_SOURCES);
}

export async function recordFacebookGroupImport(groupName: string | undefined, created: boolean, opportunity: boolean) {
  if (!groupName) return; const groups = await listWatchedFacebookGroups(); const group = groups.find(item => item.name.trim().toLocaleLowerCase("pl-PL") === groupName.trim().toLocaleLowerCase("pl-PL")); if (!group) return;
  const next = { imported_posts_count: group.importedPosts + (created ? 1 : 0), new_today_count: group.newToday + (created ? 1 : 0), opportunities_count: group.opportunities + (created && opportunity ? 1 : 0) };
  const supabase = createFacebookWatcherAdminClient(); const result = await supabase.from("watched_facebook_groups").update(next).eq("id", group.id); if (!result.error) return; if (!missingTable(result.error.message)) throw new Error(`Nie udało się zaktualizować statystyk grupy: ${result.error.message}`);
  memoryGroups.set(group.id, { ...group, importedPosts: next.imported_posts_count, newToday: next.new_today_count, opportunities: next.opportunities_count });
}

function normalize(value: WatchedFacebookGroup): WatchedFacebookGroup { const type = value.type ?? "GROUP"; const normalized = normalizeFacebookSourceUrl(value.url, type); return { ...value, type, sourceId: value.sourceId ?? normalized.identifier, name: value.name.trim(), url: normalized.url, city: value.city.trim(), district: nullable(value.district), neighborhood: nullable(value.neighborhood), keywords: value.keywords.map(item => item.trim()).filter(Boolean) }; }
function validateUrl(value: string, type: "GROUP" | "PROFILE") { return normalizeFacebookSourceUrl(value, type).url; }
function nullable(value: string | null | undefined) { const result = value?.trim(); return result || null; }
function missingTable(message: string) { return /does not exist|schema cache/i.test(message); }
function validateGroupId(value: string) { if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new Error("Nieprawidłowy identyfikator grupy."); }
function toRow(group: WatchedFacebookGroup) { return { id: group.id, name: group.name, name_verified: group.nameVerified, url: group.url, city: group.city, district: group.district, neighborhood: group.neighborhood, priority: group.priority, keywords: group.keywords, enabled: group.enabled, access_status: group.accessStatus, last_checked_at: group.lastCheckedAt, imported_posts_count: group.importedPosts, new_today_count: group.newToday, opportunities_count: group.opportunities, last_error: group.lastError }; }
function fromRow(row: Row): WatchedFacebookGroup { const url = String(row.url); const type = /^\/groups\//i.test(new URL(url).pathname) ? "GROUP" : "PROFILE"; let sourceId: string | undefined; try { sourceId = normalizeFacebookSourceUrl(url, type).identifier; } catch { /* preserve legacy URL */ } return { id: String(row.id), type, sourceId, name: String(row.name), nameVerified: row.name_verified !== false, url, city: String(row.city), district: text(row.district), neighborhood: text(row.neighborhood), priority: row.priority as WatchedFacebookGroup["priority"], keywords: Array.isArray(row.keywords) ? row.keywords.filter((item): item is string => typeof item === "string") : [], enabled: row.enabled === true, accessStatus: row.access_status as FacebookGroupAccessStatus, lastCheckedAt: text(row.last_checked_at), importedPosts: number(row.imported_posts_count), newToday: number(row.new_today_count), opportunities: number(row.opportunities_count), lastError: text(row.last_error) }; }
const text = (value: unknown) => typeof value === "string" ? value : null;
const number = (value: unknown) => typeof value === "number" ? value : 0;
