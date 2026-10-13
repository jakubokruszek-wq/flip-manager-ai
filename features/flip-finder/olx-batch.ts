/**
 * OLX batch hygiene and scan statistics for the OLX worker completion path
 * (features/flip-finder/server/olx-jobs.ts).
 *
 * One OLX results page can list the same ad more than once (a promoted copy
 * above the regular one): stage-2 run 38460045910 read 52 ads with 49 unique
 * ids. The database never stored a copy -- listings are upserted on
 * (source, external_listing_id) -- but every repeat was evaluated and counted
 * again, so "matched" and the rejection diagnostics could exceed the number
 * of distinct offers. Each offer is now processed once per scan.
 */

type BatchListing = { externalListingId: string; price: number | null; contentHash?: string | null };

export type DedupedBatch<T> = {
  listings: T[];
  /** Repeats removed (input length minus unique ids). */
  duplicates: number;
  /** Repeats whose price or content differed from the kept (first) copy. */
  conflictingDuplicates: number;
};

/** Keeps the first copy of every external id, in page order. */
export function dedupeListingsByExternalId<T extends BatchListing>(listings: T[]): DedupedBatch<T> {
  const kept = new Map<string, T>();
  let conflictingDuplicates = 0;
  for (const listing of listings) {
    const first = kept.get(listing.externalListingId);
    if (!first) {
      kept.set(listing.externalListingId, listing);
      continue;
    }
    if (first.price !== listing.price || (first.contentHash ?? null) !== (listing.contentHash ?? null)) conflictingDuplicates += 1;
  }
  return { listings: [...kept.values()], duplicates: listings.length - kept.size, conflictingDuplicates };
}

/**
 * OLX's own ad token from an offer URL (".../tytul-oferty-CID3-IDLFLU.html"
 * -> "LFLU"). Unlike the slug before it, the token does not change when the
 * seller edits the title, so it identifies the same ad after the legacy
 * external id (the whole slug) and the normalized URL have both changed.
 */
export function olxUrlIdToken(url: string | null | undefined): string | null {
  if (!url) return null;
  let pathname: string;
  try {
    const parsed = new URL(url);
    if (!/(^|\.)olx\.pl$/i.test(parsed.hostname)) return null;
    pathname = parsed.pathname;
  } catch {
    return null;
  }
  return /-ID([A-Za-z0-9]+)\.html$/.exec(pathname)?.[1] ?? null;
}

/**
 * Per-scan counts with one meaning each. Source data (read, unique, created,
 * updated, unchanged) is kept apart from the filter outcome (matched, review,
 * rejectedByFilter): every unique offer is stored as source data whatever the
 * filter says, and only the filter outcome decides the Finder section.
 */
export type ListingScanStats = {
  /** Offers read from the source page. */
  read: number;
  /** Dropped before storage (no valid total sale price). */
  skippedInvalid: number;
  /** Distinct offers processed and stored. */
  unique: number;
  /** Repeated ids on the page, processed once. */
  duplicates: number;
  /** New source records. */
  created: number;
  /** Existing records whose price or content changed. */
  updated: number;
  /** Existing records seen again without a change. */
  unchanged: number;
  /** Filter outcome: current matches. */
  matched: number;
  /** Filter outcome: need manual verification (unknown fields). */
  review: number;
  /** Filter outcome: rejected by the current filter (kept as source data). */
  rejectedByFilter: number;
};

export function emptyListingScanStats(): ListingScanStats {
  return { read: 0, skippedInvalid: 0, unique: 0, duplicates: 0, created: 0, updated: 0, unchanged: 0, matched: 0, review: 0, rejectedByFilter: 0 };
}

/** Adds one processed (unique) offer. */
export function recordListingOutcome(stats: ListingScanStats, outcome: { bucket: "MATCHED" | "REVIEW" | "REJECTED"; created: boolean; updated: boolean }): void {
  stats.unique += 1;
  if (outcome.created) stats.created += 1;
  else if (outcome.updated) stats.updated += 1;
  else stats.unchanged += 1;
  if (outcome.bucket === "MATCHED") stats.matched += 1;
  else if (outcome.bucket === "REVIEW") stats.review += 1;
  else stats.rejectedByFilter += 1;
}

/** Polish one-line summary for scan warnings/diagnostics. */
export function formatListingScanStats(stats: ListingScanStats): string {
  return `Odczytane ${stats.read}, unikalne ${stats.unique}, powtórzenia ${stats.duplicates}, pominięte ${stats.skippedInvalid}; `
    + `nowe ${stats.created}, zaktualizowane ${stats.updated}, bez zmian ${stats.unchanged}; `
    + `dopasowane ${stats.matched}, do weryfikacji ${stats.review}, odrzucone przez filtr ${stats.rejectedByFilter}.`;
}
