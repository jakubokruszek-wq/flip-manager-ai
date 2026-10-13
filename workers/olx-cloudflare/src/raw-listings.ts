/**
 * Listings JSON produced inside the browser, carried through the shared job
 * runner without being parsed by the Worker (CPU). Only the raw completion
 * path may send it: a plain JSON.stringify of the holder throws instead of
 * silently sending an empty list.
 */
const RAW = Symbol.for("flip-manager.olx.raw-listings-json");

type RawHolder = unknown[] & { [RAW]?: string };

export function rawListings(json: string): unknown[] {
  const trimmed = json.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) throw new Error("OLX_CLOUD_LISTINGS_JSON_INVALID");
  const holder: RawHolder = [];
  holder[RAW] = trimmed;
  Object.defineProperty(holder, "toJSON", { value: () => { throw new Error("OLX_CLOUD_RAW_LISTINGS_REQUIRE_RAW_COMPLETE"); } });
  return holder;
}

export function rawListingsJson(value: unknown): string | null {
  return Array.isArray(value) && typeof (value as RawHolder)[RAW] === "string" ? (value as RawHolder)[RAW] as string : null;
}
