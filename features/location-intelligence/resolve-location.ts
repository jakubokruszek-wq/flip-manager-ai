import { resolveLocationWithAi } from "./ai-location-resolver.ts";
import { normalizeLocationPart, resolveDeterministicLocation } from "./deterministic-location.ts";
import { getCachedLocation, resolveCachedLocation } from "./location-cache.ts";
import type { AiLocationResolution, LocationInput, LocationResolution, ResolveLocationOptions } from "./types.ts";

export async function resolveLocation(input: LocationInput, options: ResolveLocationOptions = {}): Promise<LocationResolution> {
  const deterministic = resolveDeterministicLocation(input);
  if (deterministic.neighborhood && deterministic.confidence >= 0.8) return deterministic;

  // Bez ulicy i miasta nie ma bezpiecznego klucza cache ani podstawy do pytania AI.
  if (!deterministic.street || !deterministic.city || options.allowAi === false) return deterministic;

  const cached = getCachedLocation(deterministic.city, deterministic.street);
  if (cached) return mergeWithDeterministic(deterministic, cached);

  return resolveCachedLocation(deterministic.city, deterministic.street, async () => {
    let ai: AiLocationResolution | null = null;
    try {
      ai = await (options.aiResolver ?? resolveLocationWithAi)(input);
    } catch (error) {
      console.error("AI LOCATION RESOLVER ERROR", error);
    }
    const safeAi = ai && evidenceComesFromInput(ai.evidence, input)
      ? ai
      : ai ? { ...ai, neighborhood: null } : null;
    return safeAi ? mergeWithDeterministic(deterministic, { ...safeAi, source: "ai" }) : deterministic;
  });
}

function evidenceComesFromInput(evidence: string, input: LocationInput): boolean {
  const key = normalizeLocationPart(evidence);
  if (!key) return false;
  return [input.address, input.street, input.district, input.city, input.locationText, input.title, input.description]
    .some((value) => normalizeLocationPart(value)?.includes(key));
}

function mergeWithDeterministic(deterministic: LocationResolution, fallback: LocationResolution): LocationResolution {
  const sameCity = !deterministic.city || !fallback.city
    || normalizeLocationPart(deterministic.city) === normalizeLocationPart(fallback.city);
  const confidence = Math.max(0, Math.min(1, fallback.confidence));
  return {
    street: deterministic.street ?? fallback.street,
    neighborhood: confidence >= 0.75 && sameCity ? fallback.neighborhood : null,
    district: deterministic.district ?? (sameCity ? fallback.district : null),
    city: deterministic.city ?? fallback.city,
    confidence,
    evidence: fallback.evidence,
    source: fallback.source === "deterministic" ? "deterministic" : "combined",
  };
}
