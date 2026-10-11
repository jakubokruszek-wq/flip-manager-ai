import assert from "node:assert/strict";
import test, { mock } from "node:test";

type Row = Record<string, unknown>;
mock.module("@/lib/supabase/admin", { namedExports: { createAdminClient: () => { throw new Error("status tests must inject a fake DB"); } } });
const { latestRadarRun } = await import("./radar-run-status.ts");

function fakeDb(row: Row) {
  return {
    from(table: string) {
      assert.equal(table, "price_radar_runs");
      const builder: Row = {
        select: () => builder,
        eq: () => builder,
        order: () => builder,
        limit: () => builder,
        maybeSingle: async () => ({ data: row, error: null }),
      };
      return builder;
    },
  };
}

test("latest run exposes saved qualification rejection counts and ignores malformed checkpoint diagnostics", async () => {
  const run = await latestRadarRun("owner-1", fakeDb({
    id: "run-1", started_at: "2026-10-10T10:00:00.000Z", status: "partial", scanned_count: 12, qualified_count: 0,
    user_terminated_at: "2026-10-10T11:00:00.000Z",
    checkpoint: {
      sourceQueue: ["olx"], currentSourceIndex: 1, sourceStatuses: { olx: "completed" }, sourceErrors: {},
      sourceWarnings: { otodom: ["Otodom: duplicate (1)"] },
      sourceRejectionCounts: { otodom: { duplicate: 1 } },
      qualificationRejections: { olx: { district_not_confirmed: 7, invented_reason: 100 }, "bad source": { rental: 4 } },
      detailDiagnostics: { domiporta: [{ kind: "detail_not_confirmed", listingUrl: "https://domiporta.test/oferta/123", finalUrl: "https://domiporta.test/oferta/123", httpStatus: 200, identity: "same_url", unconfirmedFields: ["market_type"], contradictoryFields: [] }] },
    },
    source_statuses: { olx: "completed" },
  }) as never);
  assert.deepEqual(run?.qualificationRejections, { olx: { district_not_confirmed: 7 } });
  assert.equal(run?.userTerminatedAt, "2026-10-10T11:00:00.000Z", "the latest-run read exposes the persistent non-resumable end timestamp");
  assert.deepEqual(run?.checkpoint.qualificationRejections, { olx: { district_not_confirmed: 7 } });
  assert.deepEqual(run?.sourceWarnings, { otodom: ["Otodom: duplicate (1)"] }, "latest-run GET exposes candidate warnings separately from failures");
  assert.deepEqual(run?.sourceRejectionCounts, { otodom: { duplicate: 1 } }, "latest-run GET exposes parser rejection counts");
  assert.equal(run?.checkpoint.detailDiagnostics?.domiporta?.[0]?.httpStatus, 200, "latest-run GET preserves sanitized detail evidence stored in the checkpoint");
  assert.deepEqual(run?.checkpoint.detailDiagnostics?.domiporta?.[0]?.unconfirmedFields, ["market_type"]);
});

test("legacy checkpoints without qualification diagnostics remain readable", async () => {
  const run = await latestRadarRun("owner-1", fakeDb({
    id: "legacy-run", started_at: "2026-10-09T10:00:00.000Z", status: "completed", checkpoint: { sourceQueue: [], currentSourceIndex: 0 },
  }) as never);
  assert.deepEqual(run?.qualificationRejections, {});
  assert.deepEqual(run?.checkpoint.qualificationRejections, {});
});
