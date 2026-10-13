import type { ListingSource } from "./index.ts";
import { assessListingIdentityPair, hasHardConflict, type ListingIdentityEvidence, type PairIdentityAssessment } from "./identity-evidence.ts";

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

export type PropertyIdentityGroupOptions = {
  blockedPairs?: ReadonlySet<string>;
  manualGroupByListing?: ReadonlyMap<string, string>;
};

export function identityPairKey(leftId: string, rightId: string): string {
  return [leftId, rightId].sort().join("|");
}

/**
 * Groups only pairwise-compatible cliques. This deliberately avoids
 * single-linkage (A≈B and B≈C must not collapse contradictory A/C).
 * Weak attributes never confirm a pair; shared photos produce candidates.
 */
export function groupPropertyResults<T extends ConfirmedPropertyMember & {
  crossSourceIdentity?: string | null;
  identityEvidence?: ListingIdentityEvidence;
  decisionBucket?: "MATCHED" | "REVIEW" | "REJECTED";
  lifecycleStatus?: "ACTIVE" | "REVIEW" | "STALE" | "ARCHIVED" | "REJECTED";
  manualDecision?: "ACCEPTED" | "REJECTED" | null;
  matchReasons?: string[];
  unknownFields?: string[];
  isNew?: boolean;
}>(rows: readonly T[], options: PropertyIdentityGroupOptions = {}): Array<ConfirmedPropertyGroupResult<T> & { identityGroupId: string | null; identityCandidates: Array<ConfirmedPropertyMember & { reason: string }> }> {
  const blocked = options.blockedPairs ?? new Set<string>();
  const manualGroupByListing = options.manualGroupByListing ?? new Map<string, string>();
  const orderedRows = [...rows].sort((a, b) => a.id.localeCompare(b.id));
  const assessments = new Map<string, PairIdentityAssessment>();
  const candidates = new Map<string, Array<ConfirmedPropertyMember & { reason: string }>>();
  // assessListingIdentityPair can only return "confirmed"/"candidate" for two
  // rows that share an explicit identity, an agency reference, a unit key or
  // a building key; every other pair is "separate" by construction. Only
  // those pairs are assessed, which keeps grouping near-linear instead of
  // comparing every pair of rows (O(n²)) on each Finder read.
  const comparablePairs = new Set<string>();
  const buckets = new Map<string, number[]>();
  orderedRows.forEach((row, index) => {
    const evidence = row.identityEvidence;
    const identity = normalizeConfirmedPropertyIdentity(row.crossSourceIdentity);
    const keys = [
      identity ? `identity:${identity}` : null,
      evidence?.agencyReference ? `agency:${evidence.agencyReference.agency}\u0000${evidence.agencyReference.number}` : null,
      evidence?.unitKey ? `unit:${evidence.unitKey}` : null,
      evidence?.buildingKey ? `building:${evidence.buildingKey}` : null,
    ];
    for (const key of keys) {
      if (!key) continue;
      const members = buckets.get(key);
      if (members) members.push(index);
      else buckets.set(key, [index]);
    }
  });
  for (const members of buckets.values()) {
    for (let i = 0; i < members.length; i += 1) for (let j = i + 1; j < members.length; j += 1) comparablePairs.add(`${members[i]}:${members[j]}`);
  }
  const pairs = [...comparablePairs].map((pair) => pair.split(":").map(Number) as [number, number]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const confirmedNeighbours = new Map<string, Set<string>>();
  for (const [i, j] of pairs) {
    {
      const left = orderedRows[i];
      const right = orderedRows[j];
      const key = identityPairKey(left.id, right.id);
      const leftIdentity = normalizeConfirmedPropertyIdentity(left.crossSourceIdentity);
      const rightIdentity = normalizeConfirmedPropertyIdentity(right.crossSourceIdentity);
      const assessment = assessListingIdentityPair(left.identityEvidence ?? emptyEvidence(), right.identityEvidence ?? emptyEvidence(), {
        sameExplicitIdentity: Boolean(leftIdentity && leftIdentity === rightIdentity),
        blocked: blocked.has(key),
      });
      assessments.set(key, assessment);
      if (assessment.kind === "confirmed") {
        confirmedNeighbours.set(left.id, (confirmedNeighbours.get(left.id) ?? new Set()).add(right.id));
        confirmedNeighbours.set(right.id, (confirmedNeighbours.get(right.id) ?? new Set()).add(left.id));
      }
      if (assessment.kind === "candidate") {
        const leftList = candidates.get(left.id) ?? [];
        leftList.push({ ...toMember(right), reason: assessment.reason });
        candidates.set(left.id, leftList);
        const rightList = candidates.get(right.id) ?? [];
        rightList.push({ ...toMember(left), reason: assessment.reason });
        candidates.set(right.id, rightList);
      }
    }
  }

  const groups: T[][] = [];
  const assigned = new Set<string>();
  const manualBuckets = new Map<string, T[]>();
  for (const row of orderedRows) {
    const groupId = manualGroupByListing.get(row.id);
    if (!groupId) continue;
    const bucket = manualBuckets.get(groupId) ?? [];
    bucket.push(row);
    manualBuckets.set(groupId, bucket);
  }
  for (const bucket of manualBuckets.values()) {
    if (bucket.length < 2) continue;
    const compatible = bucket.every((left, index) => bucket.slice(index + 1).every((right) => !hasHardConflict(left.identityEvidence ?? emptyEvidence(), right.identityEvidence ?? emptyEvidence())));
    if (compatible) {
      groups.push(bucket);
      bucket.forEach((row) => assigned.add(row.id));
    }
  }

  const groupIndexById = new Map<string, number>();
  groups.forEach((members, index) => members.forEach((member) => groupIndexById.set(member.id, index)));
  for (const row of orderedRows) {
    if (assigned.has(row.id)) continue;
    // A persisted manual group may be only partially visible in this result
    // set (for example when one member is archived or no longer matches the
    // filter). Do not let automatic evidence silently rebuild a different
    // group around its remaining member.
    if (manualGroupByListing.has(row.id)) {
      groups.push([row]);
      groupIndexById.set(row.id, groups.length - 1);
      assigned.add(row.id);
      continue;
    }
    // Only a group that already contains a confirmed neighbour of this row
    // can accept it (same first-fit order as before, without scanning every group).
    const neighbourGroups = [...(confirmedNeighbours.get(row.id) ?? [])]
      .map((id) => groupIndexById.get(id))
      .filter((index): index is number => index !== undefined)
      .sort((a, b) => a - b);
    const clusterIndex = neighbourGroups.find((index) => {
      const members = groups[index];
      if (members.some((member) => manualGroupByListing.has(member.id))) return false;
      return members.every((member) => assessments.get(identityPairKey(row.id, member.id))?.kind === "confirmed");
    });
    if (clusterIndex !== undefined) {
      groups[clusterIndex].push(row);
      groupIndexById.set(row.id, clusterIndex);
    } else {
      groups.push([row]);
      groupIndexById.set(row.id, groups.length - 1);
    }
    assigned.add(row.id);
  }

  return groups.map((members) => {
    const identity = members.length > 1
      ? normalizeConfirmedPropertyIdentity(members[0].crossSourceIdentity)
      : null;
    const manualGroup = members.length > 1 ? manualGroupByListing.get(members[0].id) ?? null : null;
    const isManual = Boolean(manualGroup && members.every((member) => manualGroupByListing.get(member.id) === manualGroup));
    // A MATCHED member represents the property (its price/area are the ones
    // that satisfy the filter); completeness only breaks ties within a bucket.
    const representative = [...members].sort((a, b) => bucketRank(a.decisionBucket) - bucketRank(b.decisionBucket) || completeness(b) - completeness(a) || a.source.localeCompare(b.source) || a.id.localeCompare(b.id))[0];
    const groupResult = members.length > 1 ? mergeResultMembers(representative, members, identity) : { ...representative, crossSourceIdentity: identity, linkedListings: [toMember(representative)] };
    const memberIds = new Set(members.map((member) => member.id));
    const candidatesById = new Map<string, ConfirmedPropertyMember & { reason: string }>();
    for (const member of members) {
      for (const candidate of candidates.get(member.id) ?? []) {
        if (!memberIds.has(candidate.id) && !candidatesById.has(candidate.id)) candidatesById.set(candidate.id, candidate);
      }
    }
    const identityCandidates = [...candidatesById.values()]
      .sort((a, b) => a.source.localeCompare(b.source) || a.id.localeCompare(b.id))
      .slice(0, 8);
    return { ...groupResult, identityGroupId: isManual ? manualGroup : null, identityCandidates };
  });
}

function mergeResultMembers<T extends ConfirmedPropertyMember & { decisionBucket?: "MATCHED" | "REVIEW" | "REJECTED"; lifecycleStatus?: "ACTIVE" | "REVIEW" | "STALE" | "ARCHIVED" | "REJECTED"; manualDecision?: "ACCEPTED" | "REJECTED" | null; matchReasons?: string[]; unknownFields?: string[]; isNew?: boolean }>(representative: T, members: T[], identity: string | null): ConfirmedPropertyGroupResult<T> {
  const rejected = members.some((member) => member.manualDecision === "REJECTED" || member.decisionBucket === "REJECTED" || member.lifecycleStatus === "REJECTED");
  const archived = members.some((member) => member.lifecycleStatus === "ARCHIVED" || member.lifecycleStatus === "STALE" || member.matchReasons?.includes("finder_cleared"));
  // One confirmed property: if any portal's copy satisfies the filter the
  // property matches. A REVIEW copy on another portal (e.g. missing a field
  // the matched copy has) must not demote or hide the match.
  const bucket = rejected ? "REJECTED" : members.some((member) => member.decisionBucket === "MATCHED") ? "MATCHED" : members.some((member) => member.decisionBucket === "REVIEW") ? "REVIEW" : "MATCHED";
  return {
    ...representative,
    crossSourceIdentity: identity,
    linkedListings: [...members].sort((a, b) => a.source.localeCompare(b.source) || a.id.localeCompare(b.id)).map(toMember),
    decisionBucket: bucket,
    lifecycleStatus: rejected ? "REJECTED" : archived ? "ARCHIVED" : bucket === "REVIEW" ? "REVIEW" : "ACTIVE",
    manualDecision: members.some((member) => member.manualDecision === "REJECTED") ? "REJECTED" : members.every((member) => member.manualDecision === "ACCEPTED") ? "ACCEPTED" : null,
    isNew: members.some((member) => member.isNew === true),
    matchReasons: [...new Set(members.flatMap((member) => member.matchReasons ?? []))],
    unknownFields: bucket === "MATCHED" ? [...(representative.unknownFields ?? [])] : [...new Set(members.flatMap((member) => member.unknownFields ?? []))],
  };
}

function bucketRank(bucket: "MATCHED" | "REVIEW" | "REJECTED" | undefined): number {
  return bucket === "MATCHED" ? 0 : bucket === "REVIEW" ? 1 : bucket === "REJECTED" ? 2 : 1;
}

function emptyEvidence(): ListingIdentityEvidence {
  return { agencyReference: null, buildingKey: null, apartmentNumber: null, unitKey: null, marketType: null, buildingType: null, area: null, rooms: null, floor: null, sharedPhotoAssetKeys: [] };
}

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
