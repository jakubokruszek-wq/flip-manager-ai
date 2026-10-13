/**
 * Read-path limits for Finder. Kept in one dependency-free module so tests
 * and the route can assert them without importing server-only code.
 */

/**
 * PostgREST form of membership-reconciliation.ts's visibleMembership():
 * a current match, or an explicit REVIEW membership. The canonical RPC always
 * writes "review" for REVIEW rows; the unknown_* clauses cover legacy rows
 * written before that, for every field filter-evaluation.ts can mark unknown.
 */
export const FINDER_REVIEW_UNKNOWN_FIELDS = ["price", "area", "rooms", "floor", "topFloor", "buildingType", "yearBuilt", "ownership", "district", "city", "sellerType", "marketType"] as const;
export const FINDER_REVIEW_MEMBERSHIP_OR_FILTER = [
  "is_current_match.eq.true",
  'match_reasons.cs.["review"]',
  ...FINDER_REVIEW_UNKNOWN_FIELDS.map((field) => `match_reasons.cs.["unknown_${field}"]`),
].join(",");

/** Latest scans per filter shown in "Źródła i historia skanów"; the full history is never needed for cards. */
export const SOURCE_SCAN_READ_LIMIT = 60;
export const ARCHIVE_PAGE_SIZE_DEFAULT = 30;
export const ARCHIVE_PAGE_SIZE_MAX = 100;
export const RESALE_COMPS_CACHE_TTL_MS = 5 * 60_000;
