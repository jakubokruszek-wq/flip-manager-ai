import { hasCategoryBFinishEvidence, hasRadarUnfinishedWorkEvidence, inspectRadarFinishEvidence } from "./qualification";
import type { RadarListing } from "./types";

/** Stored category labels alone are insufficient for visible comparables. */
export function hasAcceptedRadarStandard(listing: Pick<RadarListing,"title"|"description"|"marketType"|"renovationStatus"|"verificationIssues">): boolean {
  if (listing.verificationIssues?.length || hasRadarUnfinishedWorkEvidence(listing.title,listing.description)) return false;
  const finish=inspectRadarFinishEvidence(`${listing.title??""}. ${listing.description??""}`);
  if (listing.marketType==="primary") return listing.renovationStatus==="turnkey_finish"&&finish.turnkey&&finish.moveInReady;
  if (listing.renovationStatus==="fresh_renovation") return finish.freshFullRenovation&&finish.moveInReady;
  return hasCategoryBFinishEvidence(listing.title,listing.description);
}
