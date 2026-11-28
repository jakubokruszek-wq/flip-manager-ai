import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { validQueryStreet } from "../../../../features/transaction-prices/wfs.ts";
import type { RcnRawRow } from "../../../../features/transaction-prices/types.ts";

let authorization: 200 | 401 | 403 = 200;
let fetchCalls: string[] = [];
let upstreamError = false;
let truncated = false;
let rows: RcnRawRow[] = [];
const sourceTime = "2026-11-28T12:00:00.000Z";
const clock = Date.now();
const buyDate = new Date(clock - 180 * 86400000).toISOString().slice(0, 10);
const sellDate = new Date(clock - 60 * 86400000).toISOString().slice(0, 10);
mock.module("@/features/auth/operator", { namedExports: {
  requireOperator: async () => { if (authorization !== 200) throw new Error(String(authorization)); return { id: "operator" }; },
  operatorAuthorizationResponse: (error: Error) => Response.json({ message: "Brak dostępu." }, { status: Number(error.message) }),
} });
mock.module("@/features/transaction-prices/wfs", { namedExports: {
  validQueryStreet,
  fetchRcnStreet: async (street: string) => {
    fetchCalls.push(street);
    if (upstreamError) throw new Error("PRIVATE_UPSTREAM_URL_AND_TOKEN");
    return { rows, fetchedAt: sourceTime, truncated };
  },
} });
const { GET } = await import("./route.ts");
const get = (street = "Tatrzańska") => GET(new Request(`http://localhost/api/price-radar/rcn?${new URLSearchParams({ street })}`));
function sale(unit: string, transaction: string, date: string, price: number, area: number): RcnRawRow {
  return { TRAN_LOKALNY_ID_IIP: `private-transaction-${transaction}`, TRAN_WERSJA_ID: `${date} 12:00:00`, LOK_ID_LOKALU: `private-unit-${unit}`,
    LOK_ADRES: `MSC:Łódź;UL:Tatrzańska;NR_PORZ:66 m.${unit}`, DOK_DATA: `${date} 00:00:00`, NIER_UDZIAL: "1/1", LOK_FUNKCJA: "mieszkalna",
    TRAN_RODZAJ_TRANS: "wolnyRynek", TRAN_RODZAJ_RYNKU: "rynekWtorny", LOK_CENA_BRUTTO: String(price), LOK_POW_UZYT: String(area),
    TRAN_CENA_BRUTTO: "9999999", NIER_CENA_BRUTTO: "8888888" };
}
function privateCache(response: Response) { assert.equal(response.headers.get("cache-control"), "private, no-store"); }
test.beforeEach(() => {
  authorization = 200; fetchCalls = []; upstreamError = false; truncated = false;
  rows = [29, 70, 100].flatMap((area, i) => [sale(String(i), `buy${i}`, buyDate, 200000, area), sale(String(i), `sell${i}`, sellDate, 260000, area)]);
});
test("RCN Radar authorization precedes street validation and source requests", async () => {
  for (const status of [401, 403] as const) {
    authorization = status; assert.equal((await get("*")).status, status); assert.deepEqual(fetchCalls, []);
  }
});
test("RCN Radar normalizes one street and returns real model counts across all unit areas", async () => {
  const response = await get("  ul. Tatrzańska  "); privateCache(response); assert.equal(response.status, 200);
  const body = await response.json(); assert.equal(body.status, "ready"); assert.equal(body.street, "Tatrzańska");
  assert.equal(body.candidateCount, 3); assert.equal(body.strongCandidateCount, 3);
  assert.deepEqual(body.rows.map((row: { area: number }) => row.area).sort((a: number, b: number) => a - b), [29, 70, 100]);
  assert(body.rows.every((row: { priceIncreasePct: number; strongSignal: boolean; holdingDays: number }) => row.priceIncreasePct === 30 && row.strongSignal && row.holdingDays === 120));
  assert.equal(body.fetchedAt, sourceTime); assert.deepEqual(fetchCalls, ["Tatrzańska"]);
  const serialized = JSON.stringify(body); for (const privateValue of ["private-unit", "private-transaction", "9999999", "8888888"]) assert(!serialized.includes(privateValue));
});
test("RCN Radar rejects empty, oversized and wildcard streets without source access", async () => {
  for (const street of ["", "a", "12345", "a".repeat(101), "Tatrzańska*", "Tatrzańska?", "Tatrzańska%", "Tatrzańska!", "<script>"]) {
    const response = await get(street); privateCache(response); assert.equal(response.status, 400, street); assert.deepEqual(fetchCalls, []);
  }
});
test("RCN Radar retains limited-sample status and never pairs different units", async () => {
  truncated = true; rows = [sale("1", "buy", buyDate, 200000, 40), sale("2", "sell", sellDate, 320000, 40)];
  const response = await get(); privateCache(response); const body = await response.json();
  assert.equal(body.status, "no_candidates"); assert.equal(body.candidateCount, 0); assert.equal(body.strongCandidateCount, 0); assert.equal(body.truncated, true);
});
test("RCN Radar source failure is a private 503 without internal details", async () => {
  upstreamError = true; const response = await get(); privateCache(response); assert.equal(response.status, 503);
  assert(!JSON.stringify(await response.json()).includes("PRIVATE"));
});
