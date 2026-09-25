import assert from "node:assert/strict";
import test, { mock } from "node:test";

let summaryImpl: () => Promise<unknown> = async () => ({ pureFacebookListingIds: [], preservedListingIds: [], removedAssociationListingIds: [], total: 0, ready: true, blockedReason: null });
let clearImpl: () => Promise<unknown> = async () => ({ pureFacebookListingIds: [], preservedListingIds: [], removedAssociationListingIds: [], total: 0, ready: true, blockedReason: null });
let clearCalls = 0;
let operatorAllowed = true;

mock.module("@/features/auth/operator", {
  namedExports: {
    requireOperator: async () => { if (!operatorAllowed) throw new Error("OPERATOR_SESSION_REQUIRED"); },
    operatorAuthorizationResponse: () => Response.json({ ok: false, code: "OPERATOR_SESSION_REQUIRED" }, { status: 401 }),
  },
});

mock.module("@/features/facebook-watcher/server/history-clear", {
  namedExports: {
    getFacebookWatcherHistorySummary: () => summaryImpl(),
    clearFacebookWatcherHistory: () => {
      clearCalls += 1;
      return clearImpl();
    },
  },
});

const route = await import("../../app/api/facebook-watcher/history/route.ts");

function deleteRequest(options: { origin?: string | null; fetchSite?: string; action?: string } = {}): Request {
  const headers = new Headers();
  const origin = options.origin === undefined ? "https://flip-manager-ai.vercel.app" : options.origin;
  if (origin !== null) headers.set("origin", origin);
  headers.set("sec-fetch-site", options.fetchSite ?? "same-origin");
  if (options.action) headers.set("x-facebook-watcher-action", options.action);
  return new Request("https://flip-manager-ai.vercel.app/api/facebook-watcher/history", { method: "DELETE", headers });
}

async function status(response: Response): Promise<number> {
  await response.arrayBuffer();
  return response.status;
}

test("J: GET returns 200 with the summary body when the summary RPC succeeds", async () => {
  summaryImpl = async () => ({ pureFacebookListingIds: ["a"], preservedListingIds: [], removedAssociationListingIds: [], total: 1, ready: true, blockedReason: null });
  const response = await route.GET();
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.total, 1);
  assert.equal(body.ready, true);
});

test("GET still returns 503 FACEBOOK_WATCHER_HISTORY_READ_FAILED when the summary throws", async () => {
  summaryImpl = async () => {
    throw new Error("FACEBOOK_WATCHER_HISTORY_READ_FAILED: rpc unavailable");
  };
  const response = await route.GET();
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false, code: "FACEBOOK_WATCHER_HISTORY_READ_FAILED" });
});

test("K: DELETE without an operator session is forbidden before clear runs", async () => {
  clearCalls = 0;
  operatorAllowed = false;
  assert.equal(await status(await route.DELETE(deleteRequest())), 401);
  assert.equal(clearCalls, 0);
});

test("K: forged Origin and action headers cannot replace an operator session", async () => {
  clearCalls = 0;
  operatorAllowed = false;
  assert.equal(await status(await route.DELETE(deleteRequest({ origin: "https://flip-manager-ai.vercel.app", action: "clear-watcher-history" }))), 401);
  assert.equal(clearCalls, 0);
});

test("K: a valid operator can invoke clear without a custom action header", async () => {
  clearCalls = 0;
  operatorAllowed = true;
  clearImpl = async () => ({ pureFacebookListingIds: ["a"], preservedListingIds: [], removedAssociationListingIds: [], total: 1, ready: true, blockedReason: null });
  const response = await route.DELETE(deleteRequest());
  assert.equal(response.status, 200);
  assert.equal(clearCalls, 1);
});
