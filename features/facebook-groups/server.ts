import "server-only";
import { randomUUID } from "node:crypto";
import { createFacebookWatcherAdminClient } from "@/features/facebook-watcher/supabase-admin";
import { FacebookGroupValidationError, findDuplicateFacebookGroup, normalizeFacebookGroupUrl, parseFacebookGroupCreatePayload } from "./group-url";
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

export async function createWatchedFacebookGroup(input: FacebookGroupInput): Promise<WatchedFacebookGroup> {
  const group = normalize({ ...input, id: randomUUID(), accessStatus: "MANUAL_IMPORT", lastCheckedAt: null, importedPosts: 0, newToday: 0, opportunities: 0, lastError: null });
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
    const duplicate = findDuplicateFacebookGroup(existingGroups, normalized.input.url, normalized.identifier);
    if (duplicate) return { success: false, duplicate: true, error: "Ta grupa jest już obserwowana.", group: duplicate };
    try {
      return { success: true, duplicate: false, group: await createWatchedFacebookGroup(normalized.input) };
    } catch (error) {
      if (error instanceof Error && /23505|duplicate key|unique constraint/i.test(error.message)) {
        const racedDuplicate = findDuplicateFacebookGroup(await listWatchedFacebookGroups(), normalized.input.url, normalized.identifier);
        if (racedDuplicate) return { success: false, duplicate: true, error: "Ta grupa jest już obserwowana.", group: racedDuplicate };
      }
      throw error;
    }
  } catch (error) {
    if (error instanceof FacebookGroupValidationError) return { success: false, duplicate: false, validationError: true, error: error.message };
    throw error;
  }
}

export async function updateWatchedFacebookGroup(id: string, patch: Partial<FacebookGroupInput> & { accessStatus?: FacebookGroupAccessStatus; lastCheckedAt?: string | null; lastError?: string | null }): Promise<WatchedFacebookGroup> {
  const supabase = createFacebookWatcherAdminClient();
  const values: Row = {};
  if (patch.name !== undefined) values.name = patch.name.trim(); if (patch.url !== undefined) values.url = validateUrl(patch.url);
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

export async function recordFacebookGroupImport(groupName: string | undefined, created: boolean, opportunity: boolean) {
  if (!groupName) return; const groups = await listWatchedFacebookGroups(); const group = groups.find(item => item.name.trim().toLocaleLowerCase("pl-PL") === groupName.trim().toLocaleLowerCase("pl-PL")); if (!group) return;
  const next = { imported_posts_count: group.importedPosts + (created ? 1 : 0), new_today_count: group.newToday + (created ? 1 : 0), opportunities_count: group.opportunities + (created && opportunity ? 1 : 0) };
  const supabase = createFacebookWatcherAdminClient(); const result = await supabase.from("watched_facebook_groups").update(next).eq("id", group.id); if (!result.error) return; if (!missingTable(result.error.message)) throw new Error(`Nie udało się zaktualizować statystyk grupy: ${result.error.message}`);
  memoryGroups.set(group.id, { ...group, importedPosts: next.imported_posts_count, newToday: next.new_today_count, opportunities: next.opportunities_count });
}

function normalize(value: WatchedFacebookGroup): WatchedFacebookGroup { return { ...value, name: value.name.trim(), url: validateUrl(value.url), city: value.city.trim(), district: nullable(value.district), neighborhood: nullable(value.neighborhood), keywords: value.keywords.map(item => item.trim()).filter(Boolean) }; }
function validateUrl(value: string) { return normalizeFacebookGroupUrl(value).url; }
function nullable(value: string | null | undefined) { const result = value?.trim(); return result || null; }
function missingTable(message: string) { return /does not exist|schema cache/i.test(message); }
function toRow(group: WatchedFacebookGroup) { return { id: group.id, name: group.name, url: group.url, city: group.city, district: group.district, neighborhood: group.neighborhood, priority: group.priority, keywords: group.keywords, enabled: group.enabled, access_status: group.accessStatus, last_checked_at: group.lastCheckedAt, imported_posts_count: group.importedPosts, new_today_count: group.newToday, opportunities_count: group.opportunities, last_error: group.lastError }; }
function fromRow(row: Row): WatchedFacebookGroup { return { id: String(row.id), name: String(row.name), url: String(row.url), city: String(row.city), district: text(row.district), neighborhood: text(row.neighborhood), priority: row.priority as WatchedFacebookGroup["priority"], keywords: Array.isArray(row.keywords) ? row.keywords.filter((item): item is string => typeof item === "string") : [], enabled: row.enabled === true, accessStatus: row.access_status as FacebookGroupAccessStatus, lastCheckedAt: text(row.last_checked_at), importedPosts: number(row.imported_posts_count), newToday: number(row.new_today_count), opportunities: number(row.opportunities_count), lastError: text(row.last_error) }; }
const text = (value: unknown) => typeof value === "string" ? value : null;
const number = (value: unknown) => typeof value === "number" ? value : 0;
