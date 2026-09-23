import assert from "node:assert/strict";
import test from "node:test";
import { trimGalleryTraces } from "./gallery-request-trace.ts";

type Row = { id: string; listing_id: string; created_at: string };

/**
 * A minimal fake matching only the exact query shape trimGalleryTraces
 * issues against gallery_request_traces: select("id").eq(listing_id).
 * order(created_at desc).range(start, end), then delete().in("id", ids).
 * Not a general-purpose Supabase double — this table's real query surface
 * is small and worth modeling directly rather than reusing a fake built
 * for a different domain's schema.
 */
function fakeAdmin(rows: Row[]) {
  const deletedIds: string[] = [];
  const client = {
    from(table: string) {
      assert.equal(table, "gallery_request_traces");
      return {
        select(_columns: string) {
          return {
            eq(_column: string, listingId: string) {
              return {
                order(_column: string, _opts: { ascending: boolean }) {
                  const sorted = rows.filter((row) => row.listing_id === listingId).sort((a, b) => b.created_at.localeCompare(a.created_at));
                  return {
                    range(start: number, end: number) {
                      return Promise.resolve({ data: sorted.slice(start, end + 1), error: null });
                    },
                  };
                },
              };
            },
          };
        },
        delete() {
          return {
            in(_column: string, ids: string[]) {
              deletedIds.push(...ids);
              for (const id of ids) {
                const index = rows.findIndex((row) => row.id === id);
                if (index >= 0) rows.splice(index, 1);
              }
              return Promise.resolve({ error: null });
            },
          };
        },
      };
    },
  };
  return { client, deletedIds, remaining: () => rows };
}

function row(id: string, listingId: string, minutesAgo: number): Row {
  return { id, listing_id: listingId, created_at: new Date(Date.now() - minutesAgo * 60_000).toISOString() };
}

test("trimGalleryTraces deletes only the excess beyond the newest 80 rows for that listing", async () => {
  const rows = Array.from({ length: 90 }, (_, i) => row(`row-${i}`, "listing-a", i)); // row-0 is newest, row-89 oldest
  const { client, deletedIds, remaining } = fakeAdmin(rows);

  await trimGalleryTraces(client as never, "listing-a");

  assert.equal(deletedIds.length, 10, "exactly the 10 oldest rows beyond the 80-row cap must be deleted");
  assert.ok(deletedIds.includes("row-89") && deletedIds.includes("row-80"), "the oldest rows (highest index / furthest in the past) must be the ones deleted");
  assert.ok(!deletedIds.includes("row-0") && !deletedIds.includes("row-79"), "the newest 80 rows must never be deleted");
  assert.equal(remaining().filter((r) => r.listing_id === "listing-a").length, 80);
});

test("trimGalleryTraces does nothing when a listing has 80 or fewer trace rows", async () => {
  const rows = Array.from({ length: 5 }, (_, i) => row(`row-${i}`, "listing-b", i));
  const { client, deletedIds } = fakeAdmin(rows);

  await trimGalleryTraces(client as never, "listing-b");

  assert.equal(deletedIds.length, 0);
});

test("trimGalleryTraces only ever touches the requested listing's own rows, never another listing's", async () => {
  const rows = [
    ...Array.from({ length: 90 }, (_, i) => row(`a-${i}`, "listing-a", i)),
    ...Array.from({ length: 90 }, (_, i) => row(`b-${i}`, "listing-b", i)),
  ];
  const { client, deletedIds } = fakeAdmin(rows);

  await trimGalleryTraces(client as never, "listing-a");

  assert.ok(deletedIds.every((id) => id.startsWith("a-")), "trimming one listing must never delete another listing's trace rows");
  assert.equal(deletedIds.length, 10);
});

// The URGENT ADDITION principle applies here too: a trim failure (e.g. a
// missing DELETE grant, exactly like the one found and fixed by
// supabase/migrations/20260923120000_grant_gallery_trace_retention_delete.sql)
// must never surface as an error from the trace-write path — a trace write
// that already succeeded must not be reported as failed just because
// best-effort retention could not run.
test("a trim failure (e.g. a missing DELETE grant) is swallowed and never throws", async () => {
  const client = {
    from(_table: string) {
      return {
        select() {
          return { eq() { return { order() { return { range() { return Promise.resolve({ data: null, error: { code: "42501", message: "permission denied for table gallery_request_traces" } }); } }; } }; } };
        },
        delete() {
          return { in() { return Promise.reject(new Error("should never be called when the select itself failed")); } };
        },
      };
    },
  };

  await assert.doesNotReject(() => trimGalleryTraces(client as never, "listing-c"));
});
