import assert from "node:assert/strict";
import test from "node:test";
import { InvestmentDealNotComputedError, loadInvestmentDeal } from "./investment-client.ts";

const deal = { id: "deal-1", listingId: "listing-1" } as never;
const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("client GETs existing deal without initializing it", async () => {
  const requests: Array<{ url: string; method: string }> = [];
  const result = await loadInvestmentDeal("listing-1", async (input, init) => {
    requests.push({ url: String(input), method: init?.method ?? "GET" });
    return jsonResponse({ ok: true, deal });
  });
  assert.deepEqual(result, deal);
  assert.deepEqual(requests, [{ url: "/api/flip-finder/listings/listing-1/investment", method: "GET" }]);
});

test("NOT_COMPUTED remains an explicit read-only state and never initializes a deal", async () => {
  const requests: Array<{ url: string; method: string }> = [];
  await assert.rejects(() => loadInvestmentDeal("listing-1", async (input, init) => {
    requests.push({ url: String(input), method: init?.method ?? "GET" });
    return jsonResponse({ ok: false, code: "NOT_COMPUTED" }, 404);
  }), InvestmentDealNotComputedError);
  assert.deepEqual(requests, [{ url: "/api/flip-finder/listings/listing-1/investment", method: "GET" }]);
});

test("non-NOT_COMPUTED API errors remain localized without additional requests", async () => {
  const requests: string[] = [];
  await assert.rejects(() => loadInvestmentDeal("listing-1", async (input, init) => {
    requests.push(`${init?.method ?? "GET"} ${String(input)}`);
    return jsonResponse({ ok: false, code: "INVESTMENT_DEAL_VERSION_CONFLICT" }, 409);
  }), /Analiza zmieniła się w innym widoku/);
  assert.deepEqual(requests, ["GET /api/flip-finder/listings/listing-1/investment"]);
});
