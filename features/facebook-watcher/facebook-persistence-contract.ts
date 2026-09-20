export type FacebookPersistenceBucket = "MATCHED" | "REVIEW" | "REJECTED";

export type FacebookPersistenceReadback = {
  metadataId: string | null;
  membershipExists: boolean;
  isCurrentMatch: boolean | undefined;
  matchReasons: string[];
};

/** Validates the read-back contract after the canonical writer has returned. */
export function facebookPersistenceFailure(bucket: FacebookPersistenceBucket, readback: FacebookPersistenceReadback): "FACEBOOK_METADATA_PERSIST_FAILED" | "FACEBOOK_FILTER_RECONCILE_FAILED" | null {
  if (!readback.metadataId) return "FACEBOOK_METADATA_PERSIST_FAILED";
  const membershipComplete = bucket === "MATCHED"
    ? readback.isCurrentMatch === true
    : readback.membershipExists && readback.isCurrentMatch !== undefined;
  if (!membershipComplete) return "FACEBOOK_FILTER_RECONCILE_FAILED";
  if (bucket === "REVIEW" && !readback.matchReasons.some((reason) => reason === "review" || reason.startsWith("unknown_"))) return "FACEBOOK_FILTER_RECONCILE_FAILED";
  return null;
}
