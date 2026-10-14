import assert from "node:assert/strict";
import test, { mock } from "node:test";

/**
 * OLX was removed from Price Radar: the former queue entry point refuses
 * before touching any table, for a new run and for every resume shape that
 * used to requeue a stopped job (RADAR_STOPPED_BY_OPERATOR).
 */
let touched = 0;
mock.module("server-only", { defaultExport: {} });
mock.module("@/lib/supabase/admin", { namedExports: { createAdminClient: () => { touched += 1; throw new Error("must not be created"); } } });
const { enqueueRadarOlxJob } = await import("./radar-olx-queue.ts");

const input = { ownerId: "owner-radar", runId: "run-stopped", leaseToken: "new-radar-token", city: "Łódź" };
const spyDb = () => new Proxy({}, { get: () => { touched += 1; throw new Error("no table may be read or written"); } });

test("Radar can neither create nor resume an OLX job: refused before any read or write", async () => {
  for (const client of [undefined, spyDb()]) {
    await assert.rejects(enqueueRadarOlxJob(input, client), /RADAR_OLX_REMOVED/);
  }
  assert.equal(touched, 0);
});
