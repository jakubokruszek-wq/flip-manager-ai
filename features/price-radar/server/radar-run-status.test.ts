import assert from "node:assert/strict";
import test, { mock } from "node:test";

type Row = Record<string, unknown>;
mock.module("@/lib/supabase/admin", { namedExports: { createAdminClient: () => { throw new Error("status tests must inject a fake DB"); } } });
const { latestRadarRun } = await import("./radar-run-status.ts");

function fakeDb(row: Row, jobs: Row[] = []) {
  return {
    from(table: string) {
      assert.ok(table === "price_radar_runs" || table === "olx_scan_jobs");
      const rows = table === "price_radar_runs" ? [{ owner_id: "owner-1", ...row }] : jobs;
      const filters: Array<[string, unknown]> = [];
      const builder: Row = {
        select: () => builder,
        eq: (key: string, value: unknown) => { filters.push([key, value]); return builder; },
        order: () => builder,
        limit: () => builder,
        maybeSingle: async () => ({ data: rows.find((candidate) => filters.every(([key, value]) => candidate[key] === value)) ?? null, error: null }),
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
      lastProgressAt: "2026-10-10T10:59:00.000Z",
      sourceWarnings: { otodom: ["Otodom: duplicate (1)"] },
      sourceRejectionCounts: { otodom: { duplicate: 1 } },
      qualificationRejections: { olx: { district_not_confirmed: 7, invented_reason: 100 }, "bad source": { rental: 4 } },
      detailDiagnostics: { domiporta: [{ kind: "detail_not_confirmed", listingUrl: "https://domiporta.test/oferta/123", finalUrl: "https://domiporta.test/oferta/123", httpStatus: 200, identity: "same_url", unconfirmedFields: ["market_type"], contradictoryFields: [] }] },
    },
    source_statuses: { olx: "completed" },
  }) as never);
  assert.deepEqual(run?.qualificationRejections, { olx: { district_not_confirmed: 7 } });
  assert.equal(run?.userTerminatedAt, "2026-10-10T11:00:00.000Z", "the latest-run read exposes the persistent non-resumable end timestamp");
  assert.equal(run?.lastProgressAt, "2026-10-10T10:59:00.000Z", "latest-run GET exposes the last durable checkpoint separately from run start");
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
  assert.equal(run?.lastProgressAt, null, "legacy runs without the additive checkpoint timestamp remain readable");
});

test("latest run reads the actual Radar OLX queue state and lease when OLX owns the checkpoint", async () => {
  const run = await latestRadarRun("owner-1", fakeDb({
    id: "run-olx", started_at: "2026-10-12T20:00:00.000Z", status: "running", lease_until: "2026-10-12T20:02:00.000Z",
    checkpoint: { sourceQueue: ["domiporta", "olx"], currentSourceIndex: 2, lastProgressAt: "2026-10-12T20:01:00.000Z" },
    source_statuses: { domiporta: "completed", olx: "running" },
  }, [{ context_type: "price_radar", radar_owner_id: "owner-1", radar_run_id: "run-olx", status: "queued", leased_until: null }]) as never);
  assert.equal(run?.olxJobStatus, "queued");
  assert.equal(run?.olxJobLeaseUntil, null);
});
