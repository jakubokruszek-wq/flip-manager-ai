import assert from "node:assert/strict";
import test from "node:test";

const { scanSource } = await import("./manual-scan.ts");

type LeaseRow = {
  id: string;
  status: string;
  continuation_lease_token: string;
  continuation_lease_until: string;
  last_owner_result: string;
};

type FakeBuilder = {
  select: () => FakeBuilder;
  update: (value: Record<string, unknown>) => FakeBuilder;
  eq: (column: string, value: string) => FakeBuilder;
  gt: (column: string, value: string) => FakeBuilder;
  abortSignal: () => FakeBuilder;
  maybeSingle: () => Promise<{ data: { id: string } | null; error: null }>;
  then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => Promise<unknown>;
};

function fakeSupabase(row: LeaseRow) {
  let appliedUpdates = 0;
  let sourceScansReads = 0;

  const client = {
    from(table: string) {
      assert.equal(table, "source_scans");
      let mode: "select" | "update" = "select";
      let patch: Record<string, unknown> = {};
      const filters: Array<{ kind: "eq" | "gt"; column: string; value: string }> = [];
      const builder: FakeBuilder = {
        select: () => { mode = "select"; sourceScansReads += 1; return builder; },
        update: (value: Record<string, unknown>) => { mode = "update"; patch = value; return builder; },
        eq: (column: string, value: string) => { filters.push({ kind: "eq", column, value }); return builder; },
        gt: (column: string, value: string) => { filters.push({ kind: "gt", column, value }); return builder; },
        abortSignal: () => builder,
        async maybeSingle() {
          return { data: matches(row, filters) ? { id: row.id } : null, error: null };
        },
        then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
          const matched = matches(row, filters);
          if (mode === "update" && matched) {
            Object.assign(row, patch);
            appliedUpdates += 1;
          }
          return Promise.resolve({ data: matched ? [{ id: row.id }] : [], error: null }).then(resolve, reject);
        },
      };
      return builder;
    },
  };

  return { client, row, get appliedUpdates() { return appliedUpdates; }, get sourceScansReads() { return sourceScansReads; } };
}

function matches(row: LeaseRow, filters: Array<{ kind: "eq" | "gt"; column: string; value: string }>): boolean {
  return filters.every((filter) => {
    const current = row[filter.column as keyof LeaseRow];
    if (filter.kind === "eq") return current === filter.value;
    return typeof current === "string" && Date.parse(current) > Date.parse(filter.value);
  });
}

async function runWithLease(row: LeaseRow, token: string) {
  let fetchCalls = 0;
  const supabase = fakeSupabase(row);
  const source = {
    id: "official_uml",
    label: "UMŁ/BIP",
    fetch: async () => {
      fetchCalls += 1;
      return { listings: [], warnings: [], fetched: 0 };
    },
  };
  const prepared = {
    id: row.id,
    source: source.id,
    started_at: "2026-10-04T10:00:00.000Z",
    continuation_lease_token: token,
  };
  const result = await scanSource(source as never, "filter-lease", {} as never, supabase.client as never, "run-lease", new Map(), prepared, 1_000, { preparedAlreadyRunning: true });
  return { result, fetchCalls, supabase };
}

test("a worker with a replaced token cannot fetch or overwrite the new owner's result", async () => {
  const original = {
    id: "scan-replaced",
    status: "running",
    continuation_lease_token: "new-owner-token",
    continuation_lease_until: "2099-10-04T10:04:00.000Z",
    last_owner_result: "new-owner-result",
  } satisfies LeaseRow;

  const { result, fetchCalls, supabase } = await runWithLease(original, "old-owner-token");

  assert.equal(fetchCalls, 0, "a stale worker must stop before source.fetch");
  assert.equal(result.status, "pending");
  assert.equal(result.errorCode, "CONTINUATION_LEASE_LOST");
  assert.equal(supabase.appliedUpdates, 0, "the stale finalization CAS must not update the replacement owner row");
  assert.deepEqual(original, {
    id: "scan-replaced",
    status: "running",
    continuation_lease_token: "new-owner-token",
    continuation_lease_until: "2099-10-04T10:04:00.000Z",
    last_owner_result: "new-owner-result",
  });
});

test("an expired token cannot fetch or overwrite even when no newer token has been assigned yet", async () => {
  const original = {
    id: "scan-expired",
    status: "running",
    continuation_lease_token: "expired-token",
    continuation_lease_until: "2020-10-04T10:04:00.000Z",
    last_owner_result: "previous-result",
  } satisfies LeaseRow;

  const { result, fetchCalls, supabase } = await runWithLease(original, "expired-token");

  assert.equal(fetchCalls, 0, "an expired lease must be rejected before source.fetch");
  assert.equal(result.errorCode, "CONTINUATION_LEASE_LOST");
  assert.equal(supabase.appliedUpdates, 0, "an expired worker must not finalize its old result");
  assert.equal(original.last_owner_result, "previous-result");
});
