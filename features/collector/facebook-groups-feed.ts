import { normalizeFacebookGroupUrl, normalizeFacebookSourceUrl } from "../facebook-groups/group-url.ts";
import { resolveFacebookGroupDisplayName } from "../facebook-groups/display-name.ts";
import type { WatchedFacebookGroup } from "../facebook-groups/types.ts";

// Android through 0.5.73 rejects the entire feed on any unknown ID.
// Keep that wire contract stable; protocol 2 clients validate dynamic identities.
export const LEGACY_ANDROID_GROUP_IDS = new Set([
  "lodzsprzedazzakupwynajem","1253809205540869","1689328011096404",
  "1424921570856189","mieszkania.na.sprzedaz.lodz","402796264871862",
  "308185249243000","441817689512680","mieszkaniawlodzi",
  "w.lodzkim.dzialka.dom.mieszkanie","ogloszenia.lodzkie",
]);

/** Source metadata only. No post contents, credentials or scheduler claims. */
export function collectorGroupFeed(rows: readonly WatchedFacebookGroup[], protocol?: 1 | 2): ReturnType<typeof groupFeed>;
export function collectorGroupFeed(rows: readonly WatchedFacebookGroup[], protocol: 3): ReturnType<typeof sourceFeed>;
export function collectorGroupFeed(rows: readonly WatchedFacebookGroup[], protocol: 1 | 2 | 3): ReturnType<typeof groupFeed> | ReturnType<typeof sourceFeed>;
export function collectorGroupFeed(rows: readonly WatchedFacebookGroup[], protocol: 1 | 2 | 3 = 2) {
  return protocol === 3 ? sourceFeed(rows) : groupFeed(rows, protocol);
}
function sourceFeed(rows: readonly WatchedFacebookGroup[]) {
  const seen = new Set<string>();
  const sources = rows.filter(row => row.enabled).map(row => {
    if (row.type !== "GROUP" && row.type !== "PROFILE") throw new Error("INVALID_SOURCE_REGISTRY");
    const source = normalizeFacebookSourceUrl(row.url, row.type);
    const key = `${row.type}/${source.identifier}`;
    if (!/^[A-Za-z0-9_.-]{1,100}$/.test(source.identifier) || source.identifier !== row.sourceId?.toLowerCase() || seen.has(key)) throw new Error("INVALID_SOURCE_REGISTRY");
    seen.add(key);
    return { registryId: row.id, sourceType: row.type, sourceId: source.identifier,
      url: row.type === "GROUP" ? source.url : /^\d+$/.test(source.identifier) ? `https://www.facebook.com/profile.php?id=${source.identifier}` : `https://www.facebook.com/${source.identifier}/`,
      name: resolveFacebookGroupDisplayName(row), city: row.city, priority: row.priority, keywords: row.keywords, accessStatus: row.accessStatus };
  }).sort((a,b) => Number(a.sourceType === "PROFILE") - Number(b.sourceType === "PROFILE"));
  if (sources.length > 200) throw new Error("INVALID_SOURCE_REGISTRY");
  return { version: 2 as const, sources };
}
function groupFeed(rows: readonly WatchedFacebookGroup[], protocol: 1 | 2 = 2) {
  const seen = new Set<string>();
  const groups = rows.filter(row => row.enabled && row.type === "GROUP").map(row => {
    const source = normalizeFacebookGroupUrl(row.url);
    if (source.identifier !== row.sourceId?.toLowerCase() || seen.has(source.identifier)) {
      throw new Error("INVALID_GROUP_REGISTRY");
    }
    seen.add(source.identifier);
    return {
      registryId: row.id, groupId: source.identifier, url: source.url,
      name: resolveFacebookGroupDisplayName(row), city: row.city,
      priority: row.priority, keywords: row.keywords, accessStatus: row.accessStatus,
    };
  });
  const compatible=protocol===2?groups:groups.filter(group=>LEGACY_ANDROID_GROUP_IDS.has(group.groupId));
  return { version: 1 as const, groups:compatible, compatibility:{protocol,omittedGroupCount:groups.length-compatible.length} };
}

export function createCollectorGroupsGet(deps: {
  authenticate: (token: string) => Promise<unknown>;
  list: () => Promise<WatchedFacebookGroup[]>;
  authStatus: (error: unknown) => number;
}) {
  const headers = { "Cache-Control": "private, no-store", Vary: "Authorization, X-Watcher-Group-Protocol" };
  return async (request: Request): Promise<Response> => {
    const match = /^Bearer ([A-Za-z0-9_-]{32,128})$/i.exec(request.headers.get("authorization") ?? "");
    if (!match) return Response.json({ code: "UNAUTHORIZED" }, { status: 401, headers });
    try { await deps.authenticate(match[1]); }
    catch (error) {
      const status = deps.authStatus(error) === 401 ? 401 : 503;
      return Response.json({ code: status === 401 ? "UNAUTHORIZED" : "AUTH_UNAVAILABLE" }, { status, headers });
    }
    try { return Response.json(collectorGroupFeed(await deps.list(),request.headers.get("x-watcher-group-protocol")==="3"?3:request.headers.get("x-watcher-group-protocol")==="2"?2:1), { headers }); }
    catch { return Response.json({ code: "GROUPS_UNAVAILABLE" }, { status: 503, headers }); }
  };
}

