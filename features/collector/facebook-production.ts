export const FACEBOOK_PRODUCTION_SOURCE_URL = "https://www.facebook.com/groups/lodzsprzedazzakupwynajem/";
export const FACEBOOK_PRODUCTION_SOURCE_ID = "lodzsprzedazzakupwynajem";
export const FACEBOOK_COLLECTOR_HEARTBEAT_MAX_AGE_MS = 120_000;

export function isCollectorHeartbeatFresh(lastHeartbeatAt: string | null, now = Date.now(), health: string | null = null): boolean {
  const heartbeatMs = lastHeartbeatAt ? Date.parse(lastHeartbeatAt) : Number.NaN;
  return Number.isFinite(heartbeatMs) && now - heartbeatMs <= FACEBOOK_COLLECTOR_HEARTBEAT_MAX_AGE_MS && health !== "FAILED";
}

export function isFacebookProductionSource(input: { id?: string | null; sourceId?: string | null; url: string; type?: string | null }): boolean {
  return (input.sourceId ?? input.id) === FACEBOOK_PRODUCTION_SOURCE_ID
    && input.type === "GROUP"
    && normalizeFacebookSourceUrl(input.url) === FACEBOOK_PRODUCTION_SOURCE_URL;
}

export function normalizeFacebookSourceUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "www.facebook.com" || !/^\/groups\/[^/]+\/?$/i.test(url.pathname)) return null;
    url.search = "";
    url.hash = "";
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
    return url.toString();
  } catch {
    return null;
  }
}
