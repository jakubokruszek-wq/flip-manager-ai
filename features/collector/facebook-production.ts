export const FACEBOOK_PRODUCTION_SOURCE_URL = "https://www.facebook.com/groups/lodzsprzedazzakupwynajem/";
export const FACEBOOK_PRODUCTION_SOURCE_ID = "lodzsprzedazzakupwynajem";
export const FACEBOOK_COLLECTOR_HEARTBEAT_MAX_AGE_MS = 120_000;

export type FacebookProductionSource = {
  sourceId: string;
  sourceUrl: string;
  sourceType: "GROUP" | "PROFILE";
};

/** Sources explicitly approved for the production browser collector. */
export const FACEBOOK_PRODUCTION_SOURCES: readonly FacebookProductionSource[] = [
  { sourceId: "lodzsprzedazzakupwynajem", sourceUrl: FACEBOOK_PRODUCTION_SOURCE_URL, sourceType: "GROUP" },
  { sourceId: "402796264871862", sourceUrl: "https://www.facebook.com/groups/402796264871862/", sourceType: "GROUP" },
  { sourceId: "2928219830782023", sourceUrl: "https://www.facebook.com/groups/2928219830782023/", sourceType: "GROUP" },
  { sourceId: "1253809205540869", sourceUrl: "https://www.facebook.com/groups/1253809205540869/", sourceType: "GROUP" },
  { sourceId: "1424921570856189", sourceUrl: "https://www.facebook.com/groups/1424921570856189/", sourceType: "GROUP" },
  { sourceId: "1689328011096404", sourceUrl: "https://www.facebook.com/groups/1689328011096404/", sourceType: "GROUP" },
  { sourceId: "61563667387467", sourceUrl: "https://www.facebook.com/profile.php?id=61563667387467", sourceType: "PROFILE" },
];

export function isCollectorHeartbeatFresh(lastHeartbeatAt: string | null, now = Date.now(), health: string | null = null): boolean {
  const heartbeatMs = lastHeartbeatAt ? Date.parse(lastHeartbeatAt) : Number.NaN;
  return Number.isFinite(heartbeatMs) && now - heartbeatMs <= FACEBOOK_COLLECTOR_HEARTBEAT_MAX_AGE_MS && health !== "FAILED";
}

export function isFacebookProductionSource(input: { id?: string | null; sourceId?: string | null; url: string; type?: string | null }): boolean {
  return Boolean(resolveFacebookProductionSource(input));
}

export function resolveFacebookProductionSource(input: { id?: string | null; sourceId?: string | null; url: string; type?: string | null }): FacebookProductionSource | null {
  const sourceId = input.sourceId ?? input.id;
  const sourceType = input.type === "PROFILE" ? "PROFILE" : input.type === "GROUP" ? "GROUP" : null;
  const normalized = normalizeFacebookSourceUrl(input.url, sourceType ?? undefined);
  if (!sourceId || !normalized) return null;
  return FACEBOOK_PRODUCTION_SOURCES.find((source) => source.sourceId === sourceId && source.sourceType === normalized.type && source.sourceUrl === normalized.url) ?? null;
}

export function normalizeFacebookSourceUrl(value: string, type?: "GROUP" | "PROFILE"): { url: string; type: "GROUP" | "PROFILE"; sourceId: string } | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "www.facebook.com") return null;
    const group = url.pathname.match(/^\/groups\/([^/?#]+)\/?$/i);
    if (group) {
      if (type && type !== "GROUP") return null;
      return { url: `https://www.facebook.com/groups/${group[1]}/`, type: "GROUP", sourceId: group[1] };
    }
    if (type && type !== "PROFILE") return null;
    const profileId = url.searchParams.get("id") || url.pathname.match(/\/([0-9]{5,})\/?$/)?.[1] || url.pathname.match(/^\/([0-9]{5,})\/?$/)?.[1];
    if (!profileId || !/^\d{5,30}$/.test(profileId)) return null;
    return { url: `https://www.facebook.com/profile.php?id=${profileId}`, type: "PROFILE", sourceId: profileId };
  } catch {
    return null;
  }
}
