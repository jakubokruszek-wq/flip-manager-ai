import assert from "node:assert/strict";
import test, { mock } from "node:test";
import type { RcnRawRow } from "../../../../../features/transaction-prices/types.ts";

const id = "12345678-1234-1234-1234-123456789012";
const sourceTime = "2026-11-28T12:00:00.000Z";
const clock = Date.now();
const buyDate = new Date(clock - 180 * 86400000).toISOString().slice(0, 10);
const sellDate = new Date(clock - 60 * 86400000).toISOString().slice(0, 10);
let authorization: 200 | 401 | 403 = 200;
let dbCalls = 0;
let fetchCalls: string[] = [];
let databaseError = false;
let upstreamError = false;
let truncated = false;
let rows: RcnRawRow[] = [];
let listing: Record<string, unknown> | null;
mock.module("@/features/auth/operator", { namedExports: {
  requireOperator: async () => { if (authorization !== 200) throw new Error(String(authorization)); return { id: "operator" }; },
  operatorAuthorizationResponse: (error: Error) => Response.json({ message: "Brak dostępu." }, { status: Number(error.message) }),
} });
mock.module("@/lib/supabase/server", { namedExports: {
  createClient: async () => {
    dbCalls++;
    return { from: (table: string) => {
      assert.equal(table, "listings");
      return { select: (projection: string) => {
        assert.equal(projection, "id,city,district,address,title,description");
        return { eq: (key: string, value: string) => {
          assert.equal(key, "id"); assert.equal(value, id);
          return { maybeSingle: async () => ({ data: listing, error: databaseError ? new Error("PRIVATE_DATABASE_DETAILS") : null }) };
        } };
      } };
    } };
  },
} });
mock.module("@/features/transaction-prices/wfs", { namedExports: {
  validQueryStreet: (street: string) => street.trim().length > 1 && !/[<>*%]/.test(street),
  fetchRcnStreet: async (street: string) => {
    fetchCalls.push(street);
    if (upstreamError) throw new Error("PRIVATE_SOURCE_URL_TOKEN_INTERNAL_DETAILS");
    return { rows, fetchedAt: sourceTime, truncated };
  },
} });
const { GET } = await import("./route.ts");
function sale(unit: string, transaction: string, date: string, price: number, area = 40): RcnRawRow {
  return { TRAN_LOKALNY_ID_IIP: `private-transaction-${transaction}`, TRAN_WERSJA_ID: `${date} 12:00:00`, LOK_ID_LOKALU: `private-unit-${unit}`,
    LOK_ADRES: `MSC:Łódź;UL:Tatrzańska;NR_PORZ:66 m.${unit}`, DOK_DATA: `${date} 00:00:00`, NIER_UDZIAL: "1/1", LOK_FUNKCJA: "mieszkalna",
    TRAN_RODZAJ_TRANS: "wolnyRynek", TRAN_RODZAJ_RYNKU: "rynekWtorny", LOK_CENA_BRUTTO: String(price), LOK_POW_UZYT: String(area),
    TRAN_CENA_BRUTTO: "9999999", NIER_CENA_BRUTTO: "8888888" };
}
function pairs(): RcnRawRow[] {
  return [29, 70, 100].flatMap((area, i) => [sale(String(i + 1), `buy${i}`, buyDate, 200000, area), sale(String(i + 1), `sell${i}`, sellDate, 260000, area)]);
}
function get(listingId = id) { return GET(new Request(`http://localhost/api/market-intelligence/${listingId}/resales`), { params: Promise.resolve({ listingId }) }); }
function privateCache(response: Response) { assert.equal(response.headers.get("cache-control"), "private, no-store"); }
test.beforeEach(() => {
  authorization = 200; dbCalls = 0; fetchCalls = []; databaseError = false; upstreamError = false; truncated = false;
  listing = { id, city: "Łódź", district: null, address: "ul. Tatrzańska 66/68", title: "Mieszkanie na sprzedaż", description: null, area: null };
  rows = pairs();
});
test("401/403 authorization precedes identifier, database and source access", async () => {
  for (const status of [401, 403] as const) {
    authorization = status;
    assert.equal((await get("invalid-id")).status, status);
    assert.equal(dbCalls, 0); assert.deepEqual(fetchCalls, []);
  }
});
test("missing listing area still returns street-wide repeated sales of all areas and 30% strong signals", async () => {
  const response = await get(); privateCache(response); assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, "ready"); assert.equal(body.street, "Tatrzańska");
  assert.equal(body.candidateCount, 3); assert.equal(body.strongCandidateCount, 3);
  assert.deepEqual(body.rows.map((row: { area: number }) => row.area).sort((a: number, b: number) => a - b), [29, 70, 100]);
  assert(body.rows.every((row: { strongSignal: boolean; priceIncreasePct: number }) => row.strongSignal && row.priceIncreasePct === 30));
  assert(body.rows.every((row: { buyDate: string; sellDate: string; buyPrice: number; sellPrice: number; holdingDays: number }) => row.buyDate === buyDate && row.sellDate === sellDate && row.buyPrice === 200000 && row.sellPrice === 260000 && row.holdingDays === 120));
  assert.equal(body.fetchedAt, sourceTime); assert.deepEqual(fetchCalls, ["Tatrzańska"]);
  const serialized = JSON.stringify(body);
  for (const value of ["private-unit", "private-transaction", "9999999", "8888888", "m.1", "m.2", "m.3"]) assert(!serialized.includes(value), value);
});
test("two similar units in the same building never become a fabricated resale", async () => {
  rows = [sale("1", "buy", buyDate, 200000), sale("2", "sell", sellDate, 320000)];
  const response = await get(); privateCache(response);
  const body = await response.json(); assert.equal(body.status, "no_candidates"); assert.equal(body.candidateCount, 0); assert.equal(body.strongCandidateCount, 0); assert.deepEqual(body.rows, []);
});
test("missing street and unsupported city return empty private results without source access", async () => {
  for (const [change, expected] of [[{ address: null, title: "Mieszkanie", description: null }, "missing_location"], [{ city: "Warszawa" }, "unsupported_location"]] as const) {
    listing = Object.assign({ id, city: "Łódź", district: null, address: "ul. Tatrzańska 66", title: "Mieszkanie", description: null }, change);
    const response = await get(); privateCache(response); assert.equal((await response.json()).status, expected); assert.deepEqual(fetchCalls, []);
  }
});
test("invalid/missing listing produces private 404 without source access", async () => {
  const invalid = await get("not-a-uuid"); privateCache(invalid); assert.equal(invalid.status, 404); assert.equal(dbCalls, 0);
  listing = null; const missing = await get(); privateCache(missing); assert.equal(missing.status, 404); assert.deepEqual(fetchCalls, []);
});
test("limited source preserves truncation and counts only the reviewed sample", async () => {
  truncated = true;
  const response = await get(); privateCache(response); const body = await response.json();
  assert.equal(body.truncated, true); assert.equal(body.candidateCount, 3); assert.equal(body.rows.length, 3);
});
test("source and database errors return private 503 without internal source details", async () => {
  upstreamError = true;
  const upstream = await get(); privateCache(upstream); assert.equal(upstream.status, 503); assert(!JSON.stringify(await upstream.json()).includes("PRIVATE"));
  upstreamError = false; databaseError = true; fetchCalls = [];
  const database = await get(); privateCache(database); assert.equal(database.status, 503); assert(!JSON.stringify(await database.json()).includes("PRIVATE")); assert.deepEqual(fetchCalls, []);
});
