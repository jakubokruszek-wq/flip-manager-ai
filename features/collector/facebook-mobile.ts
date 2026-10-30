import { createHash } from "node:crypto";

export class MobileInputError extends Error {}
export type MobilePost = {
  groupId: string;
  postId: string;
  permalink: string;
  price: number | null;
  area: number | null;
  rooms: number | null;
  location: string | null;
  photos: Array<{ slot: number; bytes: Buffer; hash: string }>;
};
const hash = (body: string | Buffer) => createHash("sha256").update(body).digest("hex");
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
function check(value: unknown): asserts value { if (!value) throw new MobileInputError("INVALID_MOBILE_POST"); }
function fields(value: Record<string, unknown>, names: string[]) { check(Object.keys(value).sort().join() === names.sort().join()); }

/** Selected typed fields are never represented as original Facebook post text or publication time. */
export function parseMobilePost(raw: string, deviceId: string, key: string): MobilePost {
  check(Buffer.byteLength(raw) <= 512 * 1024);
  let j: unknown;
  try { j = JSON.parse(raw); } catch { throw new MobileInputError("INVALID_JSON"); }
  check(record(j)); fields(j, ["version", "groupId", "row", "photos"]);
  check(j.version === 1 && typeof j.groupId === "string" && /^[A-Za-z0-9_.-]{1,100}$/.test(j.groupId));
  const r = j.row; check(record(r));
  fields(r, ["postId", "permalink", "layer", "price", "priceSource", "area", "rooms", "district", "neighborhood", "street", "intent", "usable", "photos", "qualification"]);
  check(typeof r.postId === "string" && /^[0-9]{5,30}$/.test(r.postId));
  const permalink = `https://www.facebook.com/groups/${j.groupId}/posts/${r.postId}/`;
  check(r.permalink === permalink);
  check(key === "mobile-v1:" + hash(Buffer.concat([Buffer.from(`${deviceId}/${j.groupId}/${r.postId}/`), Buffer.from(raw)])));
  function number(v: unknown, max: number): number | null { if (v === null) return null; check(typeof v === "number" && Number.isFinite(v) && v > 0 && v <= max); return v; }
  function text(v: unknown, max: number): string | null { if (v === null) return null; check(typeof v === "string" && v.length > 0 && v.length <= max && !/[\p{Cc}]|https?:\/\//u.test(v)); return v; }
  const price = number(r.price, 20_000_000), area = number(r.area, 9999), rooms = number(r.rooms, 20);
  check(rooms === null || Number.isInteger(rooms));
  check(["NONE", "EXPLICIT_TOTAL", "THOUSANDS_TOTAL", "DERIVED_FROM_PRICE_PER_M2"].includes(String(r.priceSource)) && (price === null) === (r.priceSource === "NONE"));
  check(["DOM", "HYDRATION", "NETWORK", "MIXED"].includes(String(r.layer)) && typeof r.usable === "boolean");
  check(["SELL_PROPERTY", "BUY_PROPERTY", "RENT_OFFER", "RENT_WANTED", "SERVICE", "OTHER", "UNKNOWN"].includes(String(r.intent)));
  check(["CANDIDATE", "NO_TEXT", "FOREIGN_CITY", "NOT_PROPERTY", "INTENT", "MISSING_FIELDS", "CONFLICT", "CLASSIFIER"].includes(String(r.qualification)));
  check(typeof r.photos === "number" && Number.isInteger(r.photos) && r.photos >= 0 && r.photos <= 20);
  const district = text(r.district, 30);
  check(district === null || ["Bałuty", "Widzew", "Polesie", "Śródmieście", "Górna"].includes(district));
  const location = [district, text(r.neighborhood, 40), text(r.street, 80)].filter(Boolean).join(", ") || null;
  check(Array.isArray(j.photos) && j.photos.length <= 3);
  const seen = new Set<number>();
  const photos = j.photos.map(p => {
    check(record(p)); fields(p, ["slot", "jpeg"]);
    check(typeof p.slot === "number" && Number.isInteger(p.slot) && p.slot >= 0 && p.slot <= 2 && !seen.has(p.slot)); seen.add(p.slot);
    check(typeof p.jpeg === "string" && p.jpeg.length <= 128 * 1024 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(p.jpeg));
    const bytes = Buffer.from(p.jpeg, "base64");
    check(bytes.length > 4 && bytes.length <= 96 * 1024 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9);
    // Accept only bounded JPEG image crops, never a full-page screenshot or arbitrary attachment.
    let valid = false;
    for (let i = 2; i + 8 < bytes.length;) {
      check(bytes[i] === 0xff); const marker = bytes[i + 1];
      if (marker === 0xda || marker === 0xd9) break;
      const length = bytes.readUInt16BE(i + 2); check(length >= 2 && i + 2 + length <= bytes.length);
      if ([0xc0, 0xc1, 0xc2].includes(marker)) {
        const height = bytes.readUInt16BE(i + 5), width = bytes.readUInt16BE(i + 7);
        check(width > 0 && width <= 192 && height > 0 && height <= 144); valid = true; break;
      }
      i += 2 + length;
    }
    check(valid);
    return { slot: p.slot, bytes, hash: hash(bytes) };
  });
  return { groupId: j.groupId, postId: r.postId, permalink, price, area, rooms, location, photos };
}

type Dependencies = {
  authenticate(token: string): Promise<{ id: string }>;
  allowed(group: string): Promise<boolean>;
  upload(device: string, post: MobilePost): Promise<string[]>;
  importPost(device: string, key: string, post: MobilePost, images: string[]): Promise<{ listingId: string; status: string }>;
  authStatus(error: unknown): number | null;
};

export function createMobilePost(deps: Dependencies) {
  return async function POST(request: Request): Promise<Response> {
    try {
      const token = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") ?? "")?.[1]?.trim();
      if (!token) return Response.json({ code: "PAIRING_REQUIRED" }, { status: 401 });
      const device = await deps.authenticate(token);
      // Enforce the limit while reading; Content-Length is not trusted.
      const reader = request.body?.getReader(); check(reader);
      const chunks: Uint8Array[] = []; let size = 0;
      try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 512 * 1024) { await reader.cancel(); return Response.json({ code: "TOO_LARGE" }, { status: 413 }); } chunks.push(part.value); } }
      finally { reader.releaseLock(); }
      const raw = Buffer.concat(chunks).toString("utf8");
      const key = request.headers.get("idempotency-key") ?? "";
      const post = parseMobilePost(raw, device.id, key);
      if (!await deps.allowed(post.groupId)) return Response.json({ code: "SOURCE_DISABLED" }, { status: 409 });
      const images = await deps.upload(device.id, post);
      const result = await deps.importPost(device.id, key, post, images);
      return Response.json({ ...result, idempotencyKey: key }, { status: result.status === "created" ? 201 : 200 });
    } catch (error) {
      const status = deps.authStatus(error) ?? (error instanceof MobileInputError ? 422 : 503);
      return Response.json({ code: status === 422 ? "INVALID_MOBILE_POST" : status === 401 ? "PAIRING_REQUIRED" : "MOBILE_IMPORT_RETRY" }, { status });
    }
  };
}
