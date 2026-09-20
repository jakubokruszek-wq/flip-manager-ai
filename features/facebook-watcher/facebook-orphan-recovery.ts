export type FacebookOrphanState = {
  hasTrustedIdentity: boolean;
  hasSourceMetadata: boolean;
  missingFilterIds: string[];
};

export type FacebookOrphanDiagnostic = FacebookOrphanState & {
  listingId: string;
  externalListingId: string;
  originalUrl: string;
  recoverableFromCapturedEvidence: boolean;
};

/** A listing is incomplete when either source identity or canonical membership is absent. */
export function isFacebookOrphan(state: FacebookOrphanState): boolean {
  return state.hasTrustedIdentity && (!state.hasSourceMetadata || state.missingFilterIds.length > 0);
}

/** Existing rows are only repairable through captured source evidence. */
export function orphanDiagnostic(input: Omit<FacebookOrphanDiagnostic, "recoverableFromCapturedEvidence"> & { capturedEvidenceAvailable?: boolean }): FacebookOrphanDiagnostic {
  return { ...input, recoverableFromCapturedEvidence: input.capturedEvidenceAvailable === true };
}
