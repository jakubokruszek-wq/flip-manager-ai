import assert from "node:assert/strict";
import test from "node:test";

import { expireStaleFinderSourceScans } from "./scan-progress.ts";

type Row = Record<string, unknown>;

function fakeAdmin(seed: Row[]) {
  const rows = seed.map((row) => ({ ...row }));
  const updates: Array<{ ids: string[]; patch: Row }> = [];
  return {
    rows,
    updates,
    from(table: string) {
      assert.equal(table, "source_scans");
      const filters: Array<{ op: "eq" | "neq" | "in"; column: string; value: unknown }> = [];
      let mode: "select" | "update" = "select";
      let patch: Row = {};
      const matches = (row: Row) => filters.every(({ op, column, value }) => op === "eq" ? row[column] === value : op === "neq" ? row[column] !== value : Array.isArray(value) && value.includes(row[column]));
      const builder = {
        select: () => builder,
        update: (value: Row) => { mode = "update"; patch = value; return builder; },
        eq: (column: string, value: unknown) => { filters.push({ op: "eq", column, value }); return builder; },
        neq: (column: string, value: unknown) => { filters.push({ op: "neq", column, value }); return builder; },
        in: (column: string, value: unknown) => { filters.push({ op: "in", column, value }); return builder; },
        abortSignal: () => builder,
        then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
          if (mode === "select") return Promise.resolve({ data: rows.filter(matches), error: null }).then(resolve, reject);
          const selected = rows.filter(matches);
          selected.forEach((row) => Object.assign(row, patch));
          updates.push({ ids: selected.map((row) => String(row.id)), patch });
          return Promise.resolve({ data: null, error: null }).then(resolve, reject);
        },
      };
      return builder;
    },
  };
}

const now = Date.parse("2026-10-03T12:00:00.000Z");
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();

test("progress watchdog queues orphaned Finder source rows and preserves heartbeat-active work", async () => {
  const admin = fakeAdmin([
    { id: "stale-official", run_id: "run-1", scan_run_id: "run-1", source: "official_uml", status: "running", started_at: ago(30), filter_snapshot: {} },
    { id: "fresh-heartbeat", scan_run_id: "run-1", source: "official_cooperative", status: "running", started_at: ago(60), filter_snapshot: { _scanProgress: { lastProgressAt: ago(1) } } },
    { id: "watcher-facebook", scan_run_id: "run-1", source: "facebook", status: "running", started_at: ago(60), filter_snapshot: {} },
    { id: "olx-worker", scan_run_id: "run-1", source: "olx", status: "running", started_at: ago(60), filter_snapshot: {} },
    { id: "other-run", scan_run_id: "run-2", source: "official_uml", status: "running", started_at: ago(60), filter_snapshot: {} },
  ]);

  await expireStaleFinderSourceScans(admin as never, "run-1", now);

  assert.equal(admin.rows.find((row) => row.id === "stale-official")?.status, "pending");
  assert.match(String(admin.rows.find((row) => row.id === "stale-official")?.error_message), /^SOURCE_TIMEOUT:/);
  assert.equal(admin.rows.find((row) => row.id === "fresh-heartbeat")?.status, "running");
  assert.equal(admin.rows.find((row) => row.id === "watcher-facebook")?.status, "running");
  assert.equal(admin.rows.find((row) => row.id === "olx-worker")?.status, "running");
  assert.equal(admin.rows.find((row) => row.id === "other-run")?.status, "running");
  assert.deepEqual(admin.updates.map((update) => update.ids), [["stale-official"]]);
  assert.equal(admin.updates[0]?.patch.continuation_next_at, "2026-10-03T13:00:00.000Z");
});

test("a continuation missing two hourly cycles becomes terminal and releases its lock", async () => {
  const admin = fakeAdmin([
    { id: "expired-continuation", scan_run_id: "run-expired", source: "official_uml", status: "pending", started_at: ago(180), continuation_next_at: ago(121), continuation_cycle_at: ago(180), error_message: "SOURCE_TIMEOUT: waiting for continuation", filter_snapshot: {} },
  ]);

  await expireStaleFinderSourceScans(admin as never, "run-expired", now);

  const row = admin.rows[0];
  assert.equal(row.status, "failed");
  assert.match(String(row.error_message), /^SOURCE_CONTINUATION_EXPIRED:/);
});
