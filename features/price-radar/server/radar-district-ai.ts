import "server-only";

import { resolveLocationWithAi } from "@/features/location-intelligence/ai-location-resolver";
import { normalizeLocationPart } from "@/features/location-intelligence/deterministic-location";
import type { AiLocationResolver } from "@/features/location-intelligence/types";
import { resolveKnownRadarDistrict, type QualificationCandidate } from "@/features/price-radar/qualification";

export type RadarDistrictSuggestion = { district: string; evidence: string };

// A per-portion/per-job cap on AI calls, not a cross-run quota -- each
// Radar collection portion (collect.ts) or OLX job (radar-olx-worker.ts)
// creates its own budget, so this only ever bounds the cost of ONE bounded
// unit of work, consistent with this app's existing per-portion time
// budgets. Exhausting it never fails or blocks collection: the candidate
// is still queued, just without a prefilled suggestion that time.
export type RadarDistrictAiBudget = { tryConsume: () => boolean };

export function createRadarDistrictAiBudget(limit = 20): RadarDistrictAiBudget {
  let used = 0;
  return { tryConsume: () => (used < limit ? (used += 1, true) : false) };
}

/**
 * Suggests a district for a candidate already confirmed eligible for the
 * district queue (every other Radar criterion passed; only the district
 * itself is missing). Reuses the app's existing OpenAI client/config
 * (ai-location-resolver.ts) -- no new secrets, no new paid service.
 *
 * Returns null, never throws, whenever the suggestion cannot be trusted:
 * no API key configured, the call fails or times out (the resolver's own
 * 15s AbortSignal.timeout), the AI's own quoted evidence does not
 * genuinely appear anywhere in this candidate's own title/description/
 * district text (a fabricated or copy-pasted-from-elsewhere quote), or
 * the AI's district/neighborhood value does not resolve to one of
 * Radar's 5 known districts or a verified sub-area of one. The caller
 * must still treat the result as a SUGGESTION only -- it is never
 * auto-applied, and only an operator's explicit confirmation (which
 * re-qualifies the candidate fresh) can promote it into the A/B sample.
 */
export async function suggestRadarDistrictWithAi(
  candidate: QualificationCandidate,
  resolver: AiLocationResolver = resolveLocationWithAi,
): Promise<RadarDistrictSuggestion | null> {
  let ai;
  try {
    ai = await resolver({
      address: null,
      street: null,
      district: candidate.district,
      city: candidate.city,
      locationText: candidate.district,
      title: candidate.title,
      description: candidate.description,
    });
  } catch (error) {
    console.error("RADAR DISTRICT AI SUGGESTION ERROR", error);
    return null;
  }
  if (!ai) return null;
  if (!evidenceAppearsIn(ai.evidence, candidate)) return null;
  const district = resolveKnownRadarDistrict(ai.district) ?? resolveKnownRadarDistrict(ai.neighborhood);
  return district ? { district, evidence: ai.evidence } : null;
}

// Mirrors resolve-location.ts's own evidenceComesFromInput check: the AI
// must have read this candidate's OWN text, never invented a plausible-
// sounding address or reused a quote that happens to concern a different
// listing (e.g. an agency's own address, or a neighboring property the
// description mentions in passing).
function evidenceAppearsIn(evidence: string, candidate: QualificationCandidate): boolean {
  const key = normalizeLocationPart(evidence);
  if (!key) return false;
  return [candidate.title, candidate.description, candidate.district, candidate.city]
    .some((value) => normalizeLocationPart(value ?? null)?.includes(key));
}
