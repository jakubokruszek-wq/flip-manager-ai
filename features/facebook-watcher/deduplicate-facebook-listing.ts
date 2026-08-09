import { normalizeComparableText } from "./normalize-facebook-listing.ts";

export type FacebookDuplicateCandidate = { price: number | null; area: number | null; district: string | null; address: string | null };
export type FacebookDuplicateTarget = { price: number | null; area: number | null; neighborhood: string | null; district: string | null; street: string | null };

export function isLikelySameFacebookProperty(target: FacebookDuplicateTarget, candidate: FacebookDuplicateCandidate): boolean {
  if (!target.price || !target.area || !candidate.price || !candidate.area) return false;
  const priceMatch = Math.abs(candidate.price - target.price) / target.price <= 0.03;
  const areaMatch = Math.abs(candidate.area - target.area) <= Math.max(1.5, target.area * 0.03);
  const targetLocation = normalizeComparableText([target.neighborhood, target.district, target.street].filter(Boolean).join(" "));
  const candidateLocation = normalizeComparableText(`${candidate.district ?? ""} ${candidate.address ?? ""}`);
  const locationMatch = Boolean(targetLocation && candidateLocation && targetLocation.split(" ").some((token) => token.length > 3 && candidateLocation.includes(token)));
  return priceMatch && areaMatch && locationMatch;
}
