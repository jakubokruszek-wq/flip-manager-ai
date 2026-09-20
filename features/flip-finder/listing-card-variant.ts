export type ListingCardVariant = "standalone" | "watcher" | undefined;

/**
 * Single source of truth for whether ExpandableListingCard's generic
 * StatusBadge ("Aktywna"/"Usunięta"/"Sprzedana") may render. The Facebook
 * Watcher embeds this card with its own workflow/lifecycle presentation
 * already covering the same ground, so the badge must be suppressed
 * EVERYWHERE the card renders it — the collapsed preview and the expanded
 * dialog alike. Both call sites read this one function so they can never
 * drift apart the way they once did (the dialog kept rendering it
 * unconditionally after the collapsed preview was fixed).
 */
export function shouldShowGenericStatusBadge(variant: ListingCardVariant): boolean {
  return variant !== "watcher";
}
