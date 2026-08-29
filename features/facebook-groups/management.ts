import { FACEBOOK_GROUP_PRIORITIES, type FacebookGroupPriority, type WatchedFacebookGroup } from "./types.ts";

export class FacebookGroupManagementValidationError extends Error {
  readonly code = "FACEBOOK_GROUP_MANAGEMENT_VALIDATION_ERROR";
}

export type FacebookGroupManagementPatch = {
  name: string;
  city: string;
  priority: FacebookGroupPriority;
  enabled: boolean;
};

export function parseFacebookGroupManagementPatch(value: unknown): FacebookGroupManagementPatch {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new FacebookGroupManagementValidationError("Nieprawidłowe dane grupy.");
  const row = value as Record<string, unknown>;
  if ("url" in row || "identifier" in row || "canonicalGroupId" in row) throw new FacebookGroupManagementValidationError("Adres i identyfikator grupy są tylko do odczytu.");
  const name = requiredText(row.name, "Nazwa", 200);
  const city = requiredText(row.city, "Miasto", 100);
  if (typeof row.priority !== "string" || !FACEBOOK_GROUP_PRIORITIES.includes(row.priority as FacebookGroupPriority)) throw new FacebookGroupManagementValidationError("Nieprawidłowy priorytet grupy.");
  if (typeof row.enabled !== "boolean") throw new FacebookGroupManagementValidationError("Status grupy musi mieć wartość aktywna lub nieaktywna.");
  return { name, city, priority: row.priority as FacebookGroupPriority, enabled: row.enabled };
}

export function partitionWatchedFacebookGroups(groups: WatchedFacebookGroup[]) {
  return {
    active: groups.filter((group) => group.enabled),
    inactive: groups.filter((group) => !group.enabled),
  };
}

export function applyManagementPatch(current: WatchedFacebookGroup, patch: FacebookGroupManagementPatch): WatchedFacebookGroup {
  return { ...current, ...patch, url: current.url, id: current.id };
}

export function safeRemovePatch(): Pick<FacebookGroupManagementPatch, "enabled"> {
  return { enabled: false };
}

function requiredText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim()) throw new FacebookGroupManagementValidationError(`${label} jest wymagana.`);
  const result = value.trim();
  if (result.length > maxLength) throw new FacebookGroupManagementValidationError(`${label} jest za długa.`);
  return result;
}
