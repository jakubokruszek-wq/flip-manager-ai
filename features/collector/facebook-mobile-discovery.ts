import type { DiscoveredFacebookGroupCandidate } from "../facebook-groups/discovery.ts";

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).sort().join() === keys.sort().join();
const reserved = new Set(["joins", "feed", "discover", "create", "notifications", "your_groups"]);
/** Membership metadata only. This endpoint cannot enable sources or receive posts/images. */
export function parseMobileDiscovery(value: unknown, now = new Date()): DiscoveredFacebookGroupCandidate[] | null {
  if (!record(value) || !exact(value, ["version", "pageUrl", "groups"]) || value.version !== 1 || value.pageUrl !== "https://www.facebook.com/groups/joins/" || !Array.isArray(value.groups) || value.groups.length < 1 || value.groups.length > 200) return null;
  const seen = new Set<string>(), result: DiscoveredFacebookGroupCandidate[] = [];
  for (const row of value.groups) {
    if (!record(row) || !exact(row, ["url", "name"]) || typeof row.url !== "string") return null;
    const id = /^https:\/\/www\.facebook\.com\/groups\/([a-z0-9_.-]{1,100})\/$/.exec(row.url)?.[1];
    if (!id || reserved.has(id) || seen.has(id)) return null;
    if (row.name !== null && (typeof row.name !== "string" || row.name.trim() !== row.name || row.name.length < 1 || row.name.length > 200 || /[\p{Cc}]|https?:\/\//u.test(row.name))) return null;
    seen.add(id); result.push({ url: row.url, name: row.name as string | null, discoveredAt: now.toISOString() });
  }
  return result;
}
export function createMobileDiscoveryPost(deps: {
  authenticate(token: string): Promise<{ id: string }>;
  discover(candidates: DiscoveredFacebookGroupCandidate[], device: string): Promise<{ token: string; expiresAt: string }>;
  authStatus(error: unknown): number | null;
}) {
  return async (request: Request): Promise<Response> => {
    const headers = { "Cache-Control": "private, no-store" };
    try {
      const token = /^Bearer ([A-Za-z0-9_-]{32,128})$/i.exec(request.headers.get("authorization") ?? "")?.[1];
      if (!token) return Response.json({ code: "PAIRING_REQUIRED" }, { status: 401, headers });
      const device = await deps.authenticate(token);
      const reader = request.body?.getReader();
      if (!reader) return Response.json({ code: "INVALID_DISCOVERY" }, { status: 422, headers });
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        while (true) {
          const part = await reader.read(); if (part.done) break;
          size += part.value.length;
          if (size > 128 * 1024) { await reader.cancel(); return Response.json({ code: "TOO_LARGE" }, { status: 413, headers }); }
          chunks.push(part.value);
        }
      } finally { reader.releaseLock(); }
      let input: unknown;
      try { input = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch { return Response.json({ code: "INVALID_DISCOVERY" }, { status: 422, headers }); }
      const candidates = parseMobileDiscovery(input);
      if (!candidates) return Response.json({ code: "INVALID_DISCOVERY" }, { status: 422, headers });
      const session = await deps.discover(candidates, device.id);
      return Response.json(session, { headers });
    } catch (error) {
      return Response.json({ code: "DISCOVERY_RETRY" }, { status: deps.authStatus(error) ?? 503, headers });
    }
  };
}
