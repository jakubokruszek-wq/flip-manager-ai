import { FACEBOOK_PRODUCTION_SOURCES, type FacebookProductionSource } from "@/features/collector/facebook-production";
import { findDuplicateFacebookGroup, normalizeFacebookGroupUrl } from "./group-url";
import type { WatchedFacebookGroup } from "./types";

export const FACEBOOK_GROUP_IMPORT_STATUSES = ["NOWA", "JUZ_W_MANAGERZE", "MOZLIWY_DUPLIKAT", "WYMAGA_WERYFIKACJI", "POMINIETA"] as const;
export type FacebookGroupImportStatus = (typeof FACEBOOK_GROUP_IMPORT_STATUSES)[number];

export const UNKNOWN_GROUP_NAME = "Nieznana grupa";

/**
 * What the extension's "Wykryj grupy nieruchomościowe" action reports for
 * one group it found while the user was authenticated on facebook.com. The
 * name comes from Facebook's own rendered page, never from an unverified
 * screenshot/OCR guess — a candidate with no name at all is deliberately
 * routed to WYMAGA_WERYFIKACJI below, never auto-treated as ready to import.
 */
export type DiscoveredFacebookGroupCandidate = {
  url: string;
  name: string | null;
  discoveredAt: string;
  /** Set by the extension itself when a link is explicitly out of scope (e.g. not a real-estate group it was asked to look for). */
  skipReason?: string | null;
};

export type FacebookGroupImportPreviewItem = {
  url: string;
  normalizedUrl: string | null;
  identifier: string | null;
  discoveredName: string | null;
  status: FacebookGroupImportStatus;
  reason: string;
};

type WatchedGroupLike = Pick<WatchedFacebookGroup, "url" | "name"> & { canonicalGroupId?: string | null };

/**
 * Classifies one discovered candidate against both real registries a group
 * can already belong to (see findDuplicateFacebookGroup's own doc comment).
 * Never activates anything by itself — this is a preview, always followed by
 * an explicit, separate import step where the user selects exactly which
 * NOWA/MOZLIWY_DUPLIKAT rows to actually add.
 */
export function classifyDiscoveredFacebookGroupCandidate(
  candidate: DiscoveredFacebookGroupCandidate,
  watchedGroups: readonly WatchedGroupLike[],
  productionSources: readonly FacebookProductionSource[] = FACEBOOK_PRODUCTION_SOURCES,
): FacebookGroupImportPreviewItem {
  const discoveredName = candidate.name?.trim() || null;
  if (candidate.skipReason) {
    return { url: candidate.url, normalizedUrl: null, identifier: null, discoveredName, status: "POMINIETA", reason: candidate.skipReason };
  }
  let normalized: { url: string; identifier: string } | null;
  try {
    normalized = normalizeFacebookGroupUrl(candidate.url);
  } catch {
    normalized = null;
  }
  if (!normalized) {
    return { url: candidate.url, normalizedUrl: null, identifier: null, discoveredName, status: "WYMAGA_WERYFIKACJI", reason: "Adres grupy nie mógł zostać zweryfikowany (musi wskazywać bezpośrednio na /groups/<identyfikator>)." };
  }
  const duplicate = findDuplicateFacebookGroup(watchedGroups, normalized.url, normalized.identifier, productionSources);
  if (duplicate) {
    const reason = duplicate.kind === "watched-group"
      ? `Grupa jest już obserwowana w Managerze jako "${duplicate.group.name}".`
      : "Grupa jest już zatwierdzonym źródłem produkcyjnym Watchera.";
    return { url: candidate.url, normalizedUrl: normalized.url, identifier: normalized.identifier, discoveredName, status: "JUZ_W_MANAGERZE", reason };
  }
  // "No activation from a screenshot name alone": a candidate the extension
  // could not read a real name for needs a human to confirm it before it can
  // ever become an actionable, named watched group.
  if (!discoveredName) {
    return { url: candidate.url, normalizedUrl: normalized.url, identifier: normalized.identifier, discoveredName: null, status: "WYMAGA_WERYFIKACJI", reason: "Rozszerzenie nie odczytało nazwy grupy z Facebooka — wymagana ręczna weryfikacja przed importem." };
  }
  const nameCollision = watchedGroups.find((group) => group.name.trim().toLocaleLowerCase("pl-PL") === discoveredName.toLocaleLowerCase("pl-PL"));
  if (nameCollision) {
    return { url: candidate.url, normalizedUrl: normalized.url, identifier: normalized.identifier, discoveredName, status: "MOZLIWY_DUPLIKAT", reason: `Nazwa pokrywa się z już obserwowaną grupą "${nameCollision.name}", ale adres jest inny — sprawdź ręcznie przed importem.` };
  }
  return { url: candidate.url, normalizedUrl: normalized.url, identifier: normalized.identifier, discoveredName, status: "NOWA", reason: "Nowa grupa, nieznana w Managerze ani wśród zatwierdzonych źródeł." };
}

/**
 * Batches classification and de-duplicates candidates the extension may have
 * reported more than once (e.g. the same group linked from two different
 * pages in one discovery run) by their normalized identifier.
 */
export function buildGroupImportPreview(
  candidates: readonly DiscoveredFacebookGroupCandidate[],
  watchedGroups: readonly WatchedGroupLike[],
  productionSources: readonly FacebookProductionSource[] = FACEBOOK_PRODUCTION_SOURCES,
): FacebookGroupImportPreviewItem[] {
  const seen = new Set<string>();
  const result: FacebookGroupImportPreviewItem[] = [];
  for (const candidate of candidates) {
    const item = classifyDiscoveredFacebookGroupCandidate(candidate, watchedGroups, productionSources);
    const dedupeKey = item.identifier ?? item.url;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    result.push(item);
  }
  return result;
}

export type HistoricalFacebookSourceMapping = {
  sourceId: string;
  sourceUrl: string;
  sourceType: FacebookProductionSource["sourceType"];
  name: string;
  isNamed: boolean;
};

/**
 * A read-only preview of what a human-readable name is actually known for
 * each of the hardcoded, approved production sources. Never invents a name:
 * a source with no matching watched_facebook_groups row shows the literal
 * "Nieznana grupa" fallback, exactly as it should when no authoritative
 * name has ever been captured for it.
 */
export function buildHistoricalFacebookSourceMapping(
  watchedGroups: readonly Pick<WatchedFacebookGroup, "name" | "sourceId">[],
  productionSources: readonly FacebookProductionSource[] = FACEBOOK_PRODUCTION_SOURCES,
): HistoricalFacebookSourceMapping[] {
  return productionSources.map((source) => {
    const match = watchedGroups.find((group) => (group.sourceId ?? "").toLocaleLowerCase("en-US") === source.sourceId.toLocaleLowerCase("en-US"));
    const name = match?.name?.trim();
    return { sourceId: source.sourceId, sourceUrl: source.sourceUrl, sourceType: source.sourceType, name: name || UNKNOWN_GROUP_NAME, isNamed: Boolean(name) };
  });
}
