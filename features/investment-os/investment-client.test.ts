import assert from "node:assert/strict";
import test from "node:test";
import { loadInvestmentDeal } from "./investment-client.ts";

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

test("NOT_COMPUTED causes one explicit idempotent initialize POST and waits for its deal", async () => {
  const requests: Array<{ url: string; method: string; action: string | null }> = [];
  const result = await loadInvestmentDeal("listing-1", async (input, init) => {
    const method = init?.method ?? "GET";
    requests.push({ url: String(input), method, action: new Headers(init?.headers).get("x-flip-finder-action") });
    return method === "GET" ? jsonResponse({ ok: false, code: "NOT_COMPUTED" }, 404) : jsonResponse({ ok: true, deal });
  });
  assert.deepEqual(result, deal);
  assert.deepEqual(requests, [
    { url: "/api/flip-finder/listings/listing-1/investment", method: "GET", action: null },
    { url: "/api/flip-finder/listings/listing-1/investment/initialize", method: "POST", action: "investment-os" },
  ]);
});

test("NOT_COMPUTED is not shown as a GET error when initialization returns a conflict", async () => {
  await assert.rejects(() => loadInvestmentDeal("listing-1", async (_input, init) => init?.method === "POST"
    ? jsonResponse({ ok: false, code: "INVESTMENT_DEAL_VERSION_CONFLICT" }, 409)
    : jsonResponse({ ok: false, code: "NOT_COMPUTED" }, 404)), /INVESTMENT_DEAL_VERSION_CONFLICT/);
});
