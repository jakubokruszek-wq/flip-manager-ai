import assert from "node:assert/strict";
import test, { mock } from "node:test";
import type { RcnRawRow } from "../../../../../features/transaction-prices/types.ts";

const id = "12345678-1234-1234-1234-123456789012";
const sourceTime = "2026-11-27T12:00:00.000Z";
let authorization: 200 | 401 | 403 = 200;
let dbCalls = 0;
let fetchCalls: string[] = [];
let databaseError = false;
let upstreamError = false;
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
        assert.equal(projection, "id,city,district,address,title,description,area,price");
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
    return { rows, fetchedAt: sourceTime, truncated: false };
  },
} });
const { GET } = await import("./route.ts");
function sourceRow(index: number, market = "rynekWtorny", overrides: RcnRawRow = {}): RcnRawRow {
  const date = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  return { TRAN_LOKALNY_ID_IIP: `private-transaction-${index}`, TRAN_WERSJA_ID: `${date} 12:00:00`, LOK_ID_LOKALU: `private-unit-${index}`,
    LOK_ADRES: `MSC:Łódź;UL:Tatrzańska;NR_PORZ:66 m.${index}`, DOK_DATA: `${date} 00:00:00`, NIER_UDZIAL: "1/1", LOK_FUNKCJA: "mieszkalna",
    TRAN_RODZAJ_TRANS: "wolnyRynek", TRAN_RODZAJ_RYNKU: market, LOK_CENA_BRUTTO: String(240000 + index * 8000), LOK_POW_UZYT: "40",
    TRAN_CENA_BRUTTO: "9999999", NIER_CENA_BRUTTO: "8888888", ...overrides };
}
const request = (market?: string) => new Request(`http://localhost/api/market-intelligence/${id}/transactions${market ? `?market=${market}` : ""}`);
const get = (market?: string, listingId = id) => GET(request(market), { params: Promise.resolve({ listingId }) });
function privateCache(response: Response) { assert.equal(response.headers.get("cache-control"), "private, no-store"); }

test.beforeEach(() => {
  authorization = 200; dbCalls = 0; fetchCalls = []; databaseError = false; upstreamError = false;
  listing = { id, city: "Łódź", district: null, address: "ul. Tatrzańska 66/68", title: "Mieszkanie na sprzedaż", description: null, area: 40, price: 300000 };
  rows = Array.from({ length: 6 }, (_, i) => sourceRow(i));
});

test("401 and 403 exit before database or upstream access", async () => {
  for (const status of [401, 403] as const) {
    authorization = status;
    assert.equal((await get()).status, status);
    assert.equal(dbCalls, 0); assert.deepEqual(fetchCalls, []);
  }
});
test("authorized route resolves the actual street and computes six local-price comparables", async () => {
  const response = await get(); privateCache(response); assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, "ready"); assert.equal(body.market, "secondary"); assert.equal(body.sampleCount, 6);
  assert.equal(body.street, "Tatrzańska"); assert.equal(body.medianPricePerM2, 6500);
  assert.deepEqual(body.estimatedRange, { low: 250000, high: 270000 });
  assert.equal(body.fetchedAt, sourceTime); assert.equal(body.rows.length, 6);
  assert.equal(body.rows[0].building, "66");
  assert.equal(dbCalls, 1); assert.deepEqual(fetchCalls, ["Tatrzańska"]);
  const serialized = JSON.stringify(body);
  for (const secret of ["private-unit", "private-transaction", "9999999", "8888888", "m.0"]) assert(!serialized.includes(secret));
});
test("missing area, missing street and non-Łódź city skip the upstream source", async () => {
  const cases = [
    { change: { area: null }, expected: "missing_area" },
    { change: { address: null, title: "Mieszkanie", description: null }, expected: "missing_location" },
    { change: { city: "Warszawa", address: "ul. Tatrzańska 66" }, expected: "unsupported_location" },
  ];
  for (const { change, expected } of cases) {
    listing = { ...listing, ...change };
    const response = await get(); privateCache(response); assert.equal(response.status, 200);
    assert.equal((await response.json()).status, expected); assert.deepEqual(fetchCalls, []);
    listing = { id, city: "Łódź", district: null, address: "ul. Tatrzańska 66", title: "Mieszkanie", description: null, area: 40, price: 300000 };
  }
});
test("invalid market and listing identifier are rejected without database or source access", async () => {
  const market = await get("mixed"); assert.equal(market.status, 400); privateCache(market);
  const invalid = await get(undefined, "not-a-uuid"); assert.equal(invalid.status, 404); privateCache(invalid);
  assert.equal(dbCalls, 0); assert.deepEqual(fetchCalls, []);
});
test("missing listing returns 404 without querying upstream", async () => {
  listing = null;
  const response = await get(); assert.equal(response.status, 404); privateCache(response);
  assert.equal(dbCalls, 1); assert.deepEqual(fetchCalls, []);
});
test("primary market cannot be inflated by secondary sales and vice versa", async () => {
  rows = [...Array.from({ length: 6 }, (_, i) => sourceRow(i)), ...Array.from({ length: 5 }, (_, i) => sourceRow(i + 20, "rynekPierwotny", { LOK_CENA_BRUTTO: "400000" }))];
  const primary = await get("primary"); privateCache(primary);
  const primaryBody = await primary.json();
  assert.equal(primaryBody.market, "primary"); assert.equal(primaryBody.sampleCount, 5); assert.equal(primaryBody.medianPricePerM2, 10000);
  assert(primaryBody.rows.every((row: { market: string }) => row.market === "primary"));
  const secondary = await get("secondary"); const secondaryBody = await secondary.json();
  assert.equal(secondaryBody.sampleCount, 6); assert.equal(secondaryBody.medianPricePerM2, 6500);
  assert(secondaryBody.rows.every((row: { market: string }) => row.market === "secondary"));
});
test("upstream and database failures are private-cache 503 responses without internal details", async () => {
  upstreamError = true;
  const upstream = await get(); assert.equal(upstream.status, 503); privateCache(upstream);
  assert(!JSON.stringify(await upstream.json()).includes("PRIVATE"));
  upstreamError = false; databaseError = true; fetchCalls = [];
  const database = await get(); assert.equal(database.status, 503); privateCache(database);
  assert(!JSON.stringify(await database.json()).includes("PRIVATE")); assert.deepEqual(fetchCalls, []);
});
