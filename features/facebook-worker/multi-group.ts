import type { FacebookGroupSnapshot, FacebookJobStatus } from "./types.ts";
import { facebookJobIdempotencyKey } from "./types.ts";

export type WatchedFacebookGroup = FacebookGroupSnapshot & {
  priority: "high" | "normal" | "low";
  createdAt: string;
};

export type FacebookGroupJobPlan = {
  filterId: string;
  runId: string;
  group: FacebookGroupSnapshot;
  groupSnapshot: [FacebookGroupSnapshot];
  idempotencyKey: string;
};

const PRIORITY_ORDER: Record<WatchedFacebookGroup["priority"], number> = { high: 0, normal: 1, low: 2 };

export function orderFacebookGroups(groups: WatchedFacebookGroup[]): WatchedFacebookGroup[] {
  return [...groups].sort((left, right) => PRIORITY_ORDER[left.priority] - PRIORITY_ORDER[right.priority]
    || left.createdAt.localeCompare(right.createdAt)
    || left.id.localeCompare(right.id));
}

export function planFacebookGroupJobs(filterId: string, runId: string, groups: WatchedFacebookGroup[]): FacebookGroupJobPlan[] {
  return orderFacebookGroups(groups).map(({ id, name, url }) => {
    const group = { id, name, url };
    return { filterId, runId, group, groupSnapshot: [group], idempotencyKey: facebookJobIdempotencyKey(filterId, runId, id) };
  });
}

export function aggregateFacebookJobStatus(statuses: FacebookJobStatus[]): FacebookJobStatus | "partial" | null {
  if (statuses.length === 0) return null;
  if (statuses.some((status) => status === "running")) return "running";
  if (statuses.some((status) => status === "queued")) return "queued";
  const failed = statuses.filter((status) => status === "failed").length;
  if (failed === statuses.length) return "failed";
  if (failed > 0) return "partial";
  return "completed";
}
