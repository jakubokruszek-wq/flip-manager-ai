import assert from "node:assert/strict";
import test, { mock } from "node:test";

const secret = "orphan-repair-test-secret-which-is-not-a-client-header";
process.env.FACEBOOK_ORPHAN_REPAIR_SECRET = secret;

const repairCalls: string[] = [];
mock.module("@/features/facebook-watcher/server", {
  namedExports: {
    listFacebookOrphans: async () => [{ listingId: "listing-1" }],
    repairFacebookOrphanFromCollectorEvidence: async (listingId: string) => {
      repairCalls.push(listingId);
      return { listingId, repairedFilters: ["filter-1"] };
    },
  },
});

const route = await import("../../app/api/facebook-watcher/orphans/route.ts");

function request(method: "GET" | "POST", options: { auth?: string; action?: string; body?: unknown } = {}): Request {
  const headers = new Headers();
  if (options.auth) headers.set("authorization", options.auth);
  if (options.action) headers.set("x-facebook-watcher-action", options.action);
  headers.set("origin", "https://flip-manager-ai.vercel.app");
  headers.set("sec-fetch-site", "same-origin");
  if (options.body !== undefined) headers.set("content-type", "application/json");
  return new Request("https://flip-manager-ai.vercel.app/api/facebook-watcher/orphans", {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

async function status(response: Response): Promise<number> {
  await response.arrayBuffer();
  return response.status;
}

test("anonymous GET is rejected before the read-only orphan listing runs", async () => {
  assert.equal(await status(await route.GET(request("GET"))), 401);
});

test("anonymous repair is rejected even with all browser action headers", async () => {
  assert.equal(await status(await route.POST(request("POST", { action: "repair-facebook-orphan", body: { listingId: "00000000-0000-0000-0000-000000000001" } }))), 401);
  assert.deepEqual(repairCalls, []);
});

test("client headers cannot authenticate the orphan route", async () => {
  assert.equal(await status(await route.GET(request("GET", { action: "repair-facebook-orphan" }))), 401);
});

test("authenticated but unauthorized bearer token is forbidden", async () => {
  assert.equal(await status(await route.GET(request("GET", { auth: "Bearer wrong-secret" }))), 403);
});

test("authorized GET and repair are allowed, and repair receives only the server-validated listing id", async () => {
  assert.equal(await status(await route.GET(request("GET", { auth: `Bearer ${secret}` }))), 200);
  const listingId = "00000000-0000-0000-0000-000000000001";
  const response = await route.POST(request("POST", {
    auth: `Bearer ${secret}`,
    action: "repair-facebook-orphan",
    body: {
      listingId,
      metadata: { price: 1_000_000, lifecycle: "MATCHED" },
      membership: "attacker-controlled",
      price: 1_000_000,
      sourceIdentity: "attacker-controlled",
    },
  }));
  assert.equal(await status(response), 200);
  assert.deepEqual(repairCalls, [listingId]);
});

test("authorized repair rejects malformed listing ids before invoking recovery", async () => {
  const before = repairCalls.length;
  assert.equal(await status(await route.POST(request("POST", { auth: `Bearer ${secret}`, action: "repair-facebook-orphan", body: { listingId: "attacker-listing" } }))), 400);
  assert.equal(repairCalls.length, before);
});
