import assert from "node:assert/strict";
import test, { mock } from "node:test";

/** The route keeps the worker HMAC boundary and the exact { workerId } payload. */
let authorized = true;
let claimResult: unknown = { job: null, reason: "AUTOMATION_DISABLED" };
let claimError: Error | null = null;
const claims: string[] = [];
const usages: unknown[] = [];
mock.module("server-only", { defaultExport: {} });
mock.module("@/features/flip-finder/server/olx-worker-auth", { namedExports: {
  authenticateOlxWorkerRequest: async (request: Request) => authorized ? { ok: true, body: await request.text() } : { ok: false, response: Response.json({ error: "OLX_WORKER_UNAUTHORIZED" }, { status: 401 }) },
} });
mock.module("@/features/flip-finder/server/olx-scheduled-claim", { namedExports: {
  claimScheduledOlxJob: async (workerId: string, usage: unknown) => { claims.push(workerId); usages.push(usage); if (claimError) throw claimError; return claimResult; },
  parseScheduledClaimBody: (value: Record<string, unknown>) => { if (Object.keys(value).some((key) => key !== "workerId" && key !== "usage")) throw new Error("INVALID_SELECTOR"); return { workerId: String(value.workerId), usage: value.usage ?? null }; },
} });
const { POST } = await import("./route.ts");
const request = (body: unknown) => new Request("http://localhost/api/olx-worker/claim-scheduled", { method: "POST", body: JSON.stringify(body) });

test("unsigned requests are rejected before any claim", async () => {
  authorized = false; claims.length = 0;
  assert.equal((await POST(request({ workerId: "cloudflare-olx-scheduled" }))).status, 401);
  assert.equal(claims.length, 0);
  authorized = true;
});

test("returns the claim result with its reason; a selector is refused", async () => {
  claimResult = { job: null, reason: "NO_DUE_JOB" };
  const usage = { accountBrowserMs: 1, workerBrowserMs: 2, safeBudgetMs: 120_000, jobEstimateMs: 45_000 };
  assert.deepEqual(await (await POST(request({ workerId: "cloudflare-olx-scheduled", usage }))).json(), { job: null, reason: "NO_DUE_JOB" });
  assert.deepEqual(usages.at(-1), usage, "the usage report reaches the claim");
  const refused = await POST(request({ workerId: "cloudflare-olx-scheduled", jobId: "x" }));
  assert.equal(refused.status, 400);
});

test("missing migration answers 503 (the Worker claims nothing)", async () => {
  claimError = new Error("OLX_SCHEDULED_CLAIM_UNAVAILABLE");
  const response = await POST(request({ workerId: "cloudflare-olx-scheduled" }));
  assert.equal(response.status, 503);
  claimError = null;
});
