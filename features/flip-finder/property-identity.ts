import type { ListingSource } from "./index.ts";

export const CONFIRMED_PROPERTY_IDENTITY_KINDS = ["canonical_unit_id", "portal_shared_unit_id"] as const;
export type ConfirmedPropertyIdentityKind = (typeof CONFIRMED_PROPERTY_IDENTITY_KINDS)[number];

export type ConfirmedPropertyMember = {
  id: string;
  source: ListingSource;
  title: string | null;
  price: number | null;
  area: number | null;
  rooms: number | null;
  originalUrl: string | null;
  publishedAt?: string | null;
  firstSeenAt?: string | null;
  lastSeenAt?: string | null;
};

export type ConfirmedPropertyGroupResult<T extends ConfirmedPropertyMember> = T & {
  linkedListings: ConfirmedPropertyMember[];
  crossSourceIdentity: string | null;
};

/** Cross-portal grouping is opt-in; weak similarity fields are never identity. */
export function normalizeConfirmedPropertyIdentity(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^(canonical_unit_id|portal_shared_unit_id):([A-Za-z0-9][A-Za-z0-9._:-]{0,199})$/.exec(value.trim());
  return match ? `${match[1]}:${match[2]}` : null;
}

/** One deterministic representative per confirmed multi-portal group. */
export function groupConfirmedPropertyResults<T extends ConfirmedPropertyMember & {
  crossSourceIdentity?: string | null;
  decisionBucket?: "MATCHED" | "REVIEW" | "REJECTED";
  lifecycleStatus?: "ACTIVE" | "REVIEW" | "STALE" | "ARCHIVED" | "REJECTED";
  manualDecision?: "ACCEPTED" | "REJECTED" | null;
  matchReasons?: string[];
  unknownFields?: string[];
  isNew?: boolean;
}>(rows: readonly T[]): Array<ConfirmedPropertyGroupResult<T>> {
  const buckets = new Map<string, T[]>();
  const results: Array<ConfirmedPropertyGroupResult<T>> = [];
  for (const row of rows) {
    const identity = normalizeConfirmedPropertyIdentity(row.crossSourceIdentity);
    if (!identity) {
      results.push({ ...row, crossSourceIdentity: null, linkedListings: [toMember(row)] });
      continue;
    }
    const group = buckets.get(identity) ?? [];
    group.push(row);
    buckets.set(identity, group);
  }
  for (const [identity, members] of buckets) {
    if (members.length < 2) {
      results.push(...members.map((row) => ({ ...row, crossSourceIdentity: null, linkedListings: [toMember(row)] })));
      continue;
    }
    const ordered = [...members].sort((left, right) => completeness(right) - completeness(left)
      || left.source.localeCompare(right.source)
      || left.id.localeCompare(right.id));
    const representative = ordered[0];
    const rejected = members.some((member) => member.manualDecision === "REJECTED" || member.decisionBucket === "REJECTED" || member.lifecycleStatus === "REJECTED");
    const archived = members.some((member) => member.lifecycleStatus === "ARCHIVED" || member.lifecycleStatus === "STALE" || member.matchReasons?.includes("finder_cleared"));
    const bucket = rejected ? "REJECTED" : members.some((member) => member.decisionBucket === "REVIEW") ? "REVIEW" : "MATCHED";
    results.push({
      ...representative,
      crossSourceIdentity: identity,
      linkedListings: ordered.map(toMember),
      decisionBucket: bucket,
      lifecycleStatus: rejected ? "REJECTED" : archived ? "ARCHIVED" : bucket === "REVIEW" ? "REVIEW" : "ACTIVE",
      manualDecision: members.some((member) => member.manualDecision === "REJECTED") ? "REJECTED" : members.every((member) => member.manualDecision === "ACCEPTED") ? "ACCEPTED" : null,
      isNew: members.some((member) => member.isNew === true),
      matchReasons: [...new Set(members.flatMap((member) => member.matchReasons ?? []))],
      unknownFields: [...new Set(members.flatMap((member) => member.unknownFields ?? []))],
    });
  }
  return results;
}

function completeness(row: ConfirmedPropertyMember): number {
  return Number(Boolean(row.title)) * 2 + Number(row.price !== null) * 2 + Number(row.area !== null) * 2
    + Number(row.rooms !== null) + Number(Boolean(row.originalUrl)) + Number(Boolean(row.publishedAt));
}

function toMember(row: ConfirmedPropertyMember): ConfirmedPropertyMember {
  return { id: row.id, source: row.source, title: row.title, price: row.price, area: row.area, rooms: row.rooms, originalUrl: row.originalUrl, publishedAt: row.publishedAt ?? null, firstSeenAt: row.firstSeenAt ?? null, lastSeenAt: row.lastSeenAt ?? null };
}
