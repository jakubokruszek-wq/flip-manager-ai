/**
 * The one shared resolver every screen and data path must use to turn a
 * group's stored name into what a human actually sees. An independent
 * review found three divergent fallback strings in production code for
 * "we don't really know this group's name" (the literal string "Facebook",
 * a bare numeric ID, and this module's own "Nieznana grupa") -- this
 * function is the single place that decision is made, so no caller can
 * drift from it again.
 *
 * `nameVerified` distinguishes a name genuinely captured by the app's own
 * add/import flow (which has required a real, human-provided name since
 * the group-registry hardening patch) from a legacy/synthetic placeholder
 * backfilled without ever knowing the group's real name (see the
 * watched_facebook_groups.name_verified column). Omitting `nameVerified`
 * entirely (for a caller with no such column, e.g. a listing's own
 * captured group_name) falls back to "is there a real, non-empty name at
 * all" -- there is no numeric-ID or brand-name fallback anywhere in this
 * function.
 */
export const UNKNOWN_GROUP_DISPLAY_NAME = "Nieznana grupa";

export function resolveFacebookGroupDisplayName(input: { name: string | null | undefined; nameVerified?: boolean }): string {
  if (input.nameVerified === false) return UNKNOWN_GROUP_DISPLAY_NAME;
  const trimmed = input.name?.trim();
  return trimmed || UNKNOWN_GROUP_DISPLAY_NAME;
}
