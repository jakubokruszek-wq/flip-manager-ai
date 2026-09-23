import type { FacebookProductionSource } from "@/features/collector/facebook-production";
import type { FacebookGroupInput, FacebookGroupPriority, WatchedFacebookGroup, FacebookSourceType } from "./types.ts";

export const FACEBOOK_GROUP_URL_MAX_LENGTH = 500;
export const FACEBOOK_GROUP_IDENTIFIER_MAX_LENGTH = 200;

export class FacebookGroupValidationError extends Error {
  readonly code = "FACEBOOK_GROUP_VALIDATION_ERROR";
}

export type FacebookGroupCreatePayload = {
  type?: FacebookSourceType;
  url: string;
  name?: string;
  city?: string;
  priority?: "normal" | "high";
  enabled?: boolean;
};

export type NormalizedFacebookGroupCreateInput = {
  identifier: string;
  input: FacebookGroupInput;
};

export function normalizeFacebookGroupUrl(value: string): { url: string; identifier: string } {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > FACEBOOK_GROUP_URL_MAX_LENGTH) throw new FacebookGroupValidationError("Podaj prawidłowy adres grupy Facebook.");
  let parsed: URL;
  try { parsed = new URL(trimmed); }
  catch { throw new FacebookGroupValidationError("Podaj prawidłowy adres grupy Facebook."); }
  const hostname = parsed.hostname.toLocaleLowerCase("en-US");
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !["facebook.com", "www.facebook.com"].includes(hostname)) {
    throw new FacebookGroupValidationError("Adres musi prowadzić do grupy na facebook.com.");
  }
  const match = parsed.pathname.match(/^\/groups\/([^/]+)\/?$/i);
  const identifier = match?.[1]?.trim() ?? "";
  if (!identifier || identifier.length > FACEBOOK_GROUP_IDENTIFIER_MAX_LENGTH || !/^[a-z0-9._-]+$/i.test(identifier)) {
    throw new FacebookGroupValidationError("URL musi wskazywać bezpośrednio na /groups/<identifier>.");
  }
  return { url: `https://www.facebook.com/groups/${identifier}/`, identifier: identifier.toLocaleLowerCase("en-US") };
}

export function normalizeFacebookSourceUrl(value: string, type: FacebookSourceType): { url: string; identifier: string } {
  if (type === "GROUP") return normalizeFacebookGroupUrl(value);
  const trimmed = value.trim();
  let parsed: URL;
  try { parsed = new URL(trimmed); } catch { throw new FacebookGroupValidationError("Podaj prawidłowy adres profilu Facebook."); }
  if (parsed.protocol !== "https:" || !/(^|\.)facebook\.com$/i.test(parsed.hostname)) throw new FacebookGroupValidationError("Adres musi prowadzić do profilu na facebook.com.");
  const id = parsed.searchParams.get("id") ?? parsed.pathname.match(/\/([0-9]{5,})\/?$/)?.[1] ?? parsed.pathname.match(/^\/([^/]+)\/?$/)?.[1];
  if (!id || /^(share|groups|profile\.php)$/i.test(id)) throw new FacebookGroupValidationError("URL musi wskazywać bezpośrednio na profil Facebook.");
  return { url: `https://www.facebook.com/profile.php?id=${encodeURIComponent(id)}`, identifier: id.toLowerCase() };
}

export function parseFacebookGroupCreatePayload(value: unknown): NormalizedFacebookGroupCreateInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new FacebookGroupValidationError("Nieprawidłowe dane grupy.");
  const row = value as Record<string, unknown>;
  if (typeof row.url !== "string") throw new FacebookGroupValidationError("Podaj URL grupy Facebook.");
  const type = row.type === "PROFILE" ? "PROFILE" : "GROUP";
  const normalized = normalizeFacebookSourceUrl(row.url, type);
  const suppliedName = typeof row.name === "string" ? row.name.trim() : "";
  // A human-readable name is required at creation time, the same as it
  // already was when editing an existing group (management.ts's
  // requiredText). Silently defaulting to a numeric-ID-based synthetic name
  // ("Facebook group 1424921570856189") is exactly the "bare numeric ID as
  // the primary label" defect an independent review of da7a787 found — the
  // identifier remains available as secondary technical text, but it must
  // never stand in for a real name.
  if (!suppliedName) throw new FacebookGroupValidationError("Nazwa grupy jest wymagana.");
  if (suppliedName.length > 200) throw new FacebookGroupValidationError("Nazwa grupy jest za długa.");
  const city = typeof row.city === "string" && row.city.trim() ? row.city.trim() : "Łódź";
  if (city.length > 100) throw new FacebookGroupValidationError("Nazwa miasta jest za długa.");
  const priority: FacebookGroupPriority = row.priority === undefined ? "normal" : row.priority === "normal" || row.priority === "high" ? row.priority : invalidPriority();
  if (row.enabled !== undefined && typeof row.enabled !== "boolean") throw new FacebookGroupValidationError("Nieprawidłowa wartość pola Enabled.");
  return {
    identifier: normalized.identifier,
    input: {
      url: normalized.url,
      type,
      sourceId: normalized.identifier,
      name: suppliedName,
      city,
      district: null,
      neighborhood: null,
      priority,
      keywords: [],
      enabled: row.enabled !== false,
    },
  };
}

export type FacebookGroupDuplicateMatch<T> =
  | { kind: "watched-group"; group: T }
  | { kind: "production-source"; source: FacebookProductionSource };

/**
 * Duplicate detection against BOTH real registries a group identifier can
 * already belong to: the DB-backed watched_facebook_groups table (what the
 * "add group" UI writes to) and the hardcoded FACEBOOK_PRODUCTION_SOURCES
 * allowlist (what the scheduler actually requires before it will ever scan a
 * source — see features/collector/facebook-production.ts). These are two
 * genuinely separate systems: a source can be an approved production source
 * without ever having a matching watched_facebook_groups row, so checking
 * only one would let a user believe they are adding a brand new group that
 * is, in fact, already live in production.
 */
export function findDuplicateFacebookGroup<T extends Pick<WatchedFacebookGroup, "url"> & { canonicalGroupId?: string | null }>(
  groups: readonly T[],
  normalizedUrl: string,
  identifier: string,
  productionSources: readonly FacebookProductionSource[] = [],
): FacebookGroupDuplicateMatch<T> | null {
  const normalizedIdentifier = identifier.toLocaleLowerCase("en-US");
  const watchedMatch = groups.find((group) => {
    if (group.canonicalGroupId?.trim().toLocaleLowerCase("en-US") === normalizedIdentifier) return true;
    try { return normalizeFacebookGroupUrl(group.url).identifier === normalizedIdentifier || normalizeFacebookGroupUrl(group.url).url === normalizedUrl; }
    catch { return group.url.trim().replace(/\/$/, "").toLocaleLowerCase("en-US") === normalizedUrl.replace(/\/$/, "").toLocaleLowerCase("en-US"); }
  });
  if (watchedMatch) return { kind: "watched-group", group: watchedMatch };
  const sourceMatch = productionSources.find((source) => source.sourceId.toLocaleLowerCase("en-US") === normalizedIdentifier);
  if (sourceMatch) return { kind: "production-source", source: sourceMatch };
  return null;
}

function invalidPriority(): never {
  throw new FacebookGroupValidationError("Priorytet musi mieć wartość normal lub high.");
}
