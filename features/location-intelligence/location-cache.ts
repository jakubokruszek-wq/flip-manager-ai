import { locationCacheKey } from "./deterministic-location.ts";
import type { LocationResolution } from "./types.ts";

const locationCache = new Map<string, LocationResolution>();
const pendingLocations = new Map<string, Promise<LocationResolution>>();

export function getCachedLocation(city: string | null, street: string | null): LocationResolution | null {
  const key = locationCacheKey(city, street);
  const value = key ? locationCache.get(key) : null;
  return value ? { ...value } : null;
}

export function setCachedLocation(resolution: LocationResolution): void {
  const key = locationCacheKey(resolution.city, resolution.street);
  if (key) locationCache.set(key, { ...resolution });
}

export function clearLocationCache(): void {
  locationCache.clear();
  pendingLocations.clear();
}

export async function resolveCachedLocation(
  city: string,
  street: string,
  factory: () => Promise<LocationResolution>,
): Promise<LocationResolution> {
  const key = locationCacheKey(city, street);
  if (!key) return factory();
  const cached = locationCache.get(key);
  if (cached) return { ...cached };
  const pending = pendingLocations.get(key);
  if (pending) return { ...await pending };
  const created = factory();
  pendingLocations.set(key, created);
  try {
    const resolution = await created;
    locationCache.set(key, { ...resolution });
    return { ...resolution };
  } finally {
    pendingLocations.delete(key);
  }
}
