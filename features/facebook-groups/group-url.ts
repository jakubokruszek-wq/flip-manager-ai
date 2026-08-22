import type { FacebookGroupInput, FacebookGroupPriority, WatchedFacebookGroup } from "./types.ts";

export const FACEBOOK_GROUP_URL_MAX_LENGTH = 500;
export const FACEBOOK_GROUP_IDENTIFIER_MAX_LENGTH = 200;

export class FacebookGroupValidationError extends Error {
  readonly code = "FACEBOOK_GROUP_VALIDATION_ERROR";
}

export type FacebookGroupCreatePayload = {
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

export function parseFacebookGroupCreatePayload(value: unknown): NormalizedFacebookGroupCreateInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new FacebookGroupValidationError("Nieprawidłowe dane grupy.");
  const row = value as Record<string, unknown>;
  if (typeof row.url !== "string") throw new FacebookGroupValidationError("Podaj URL grupy Facebook.");
  const normalized = normalizeFacebookGroupUrl(row.url);
  const suppliedName = typeof row.name === "string" ? row.name.trim() : "";
  if (suppliedName.length > 200) throw new FacebookGroupValidationError("Nazwa grupy jest za długa.");
  const city = typeof row.city === "string" && row.city.trim() ? row.city.trim() : "Łódź";
  if (city.length > 100) throw new FacebookGroupValidationError("Nazwa miasta jest za długa.");
  const priority: FacebookGroupPriority = row.priority === undefined ? "normal" : row.priority === "normal" || row.priority === "high" ? row.priority : invalidPriority();
  if (row.enabled !== undefined && typeof row.enabled !== "boolean") throw new FacebookGroupValidationError("Nieprawidłowa wartość pola Enabled.");
  return {
    identifier: normalized.identifier,
    input: {
      url: normalized.url,
      name: suppliedName || `Facebook group ${normalized.identifier}`,
      city,
      district: null,
      neighborhood: null,
      priority,
      keywords: [],
      enabled: row.enabled !== false,
    },
  };
}

export function findDuplicateFacebookGroup<T extends Pick<WatchedFacebookGroup, "url"> & { canonicalGroupId?: string | null }>(groups: T[], normalizedUrl: string, identifier: string): T | null {
  const normalizedIdentifier = identifier.toLocaleLowerCase("en-US");
  return groups.find((group) => {
    if (group.canonicalGroupId?.trim().toLocaleLowerCase("en-US") === normalizedIdentifier) return true;
    try { return normalizeFacebookGroupUrl(group.url).identifier === normalizedIdentifier || normalizeFacebookGroupUrl(group.url).url === normalizedUrl; }
    catch { return group.url.trim().replace(/\/$/, "").toLocaleLowerCase("en-US") === normalizedUrl.replace(/\/$/, "").toLocaleLowerCase("en-US"); }
  }) ?? null;
}

function invalidPriority(): never {
  throw new FacebookGroupValidationError("Priorytet musi mieć wartość normal lub high.");
}
