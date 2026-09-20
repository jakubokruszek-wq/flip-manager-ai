import type { FacebookWatcherListing } from "./types";

export type FacebookLifecycleCounts = { database: number; current: number; review: number; archived: number; stale: number; rejected: number };

export function countFacebookWatcherLifecycle(items: FacebookWatcherListing[]): FacebookLifecycleCounts {
  const counts: FacebookLifecycleCounts = { database: items.length, current: 0, review: 0, archived: 0, stale: 0, rejected: 0 };
  for (const item of items) {
    if (item.lifecycleStatus === "REVIEW") counts.review += 1;
    if (item.lifecycleStatus === "ARCHIVED") counts.archived += 1;
    else if (item.lifecycleStatus === "STALE") counts.stale += 1;
    else if (item.lifecycleStatus === "REJECTED") counts.rejected += 1;
    else counts.current += 1;
  }
  return counts;
}
