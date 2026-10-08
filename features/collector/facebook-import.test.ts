import assert from "node:assert/strict";
import test, { mock } from "node:test";

type QueryResult = { data: unknown; error: null | { message: string } };

const state = {
  listingUpsertCalls: 0,
  metadataUpsertPayloads: [] as Array<Record<string, unknown>>,
  reconciliationInputs: [] as Array<Record<string, unknown>>,
};

class Query {
  private readonly table: string;
  private operation: "select" | "insert" | "update" | "upsert" = "select";
  private filters: Array<[string, unknown]> = [];
  private payload: Record<string, unknown> | null = null;

  constructor(table: string) {
    this.table = table;
  }

  select() { return this; }
  eq(column: string, value: unknown) { this.filters.push([column, value]); return this; }
  filter(column: string, _operator: string, value: unknown) { this.filters.push([column, value]); return this; }
  order() { return this; }
  limit() { return this; }
  maybeSingle() { return Promise.resolve(this.result("maybeSingle")); }
  single() { return Promise.resolve(this.result("single")); }
  insert(payload: Record<string, unknown>) { this.operation = "insert"; this.payload = payload; return this; }
  update(payload: Record<string, unknown>) { this.operation = "update"; this.payload = payload; return this; }
  upsert(payload: Record<string, unknown>) {
    this.operation = "upsert";
    this.payload = payload;
    if (this.table === "listings") state.listingUpsertCalls += 1;
    if (this.table === "listing_source_metadata") state.metadataUpsertPayloads.push(payload);
    return this;
  }

  then(resolve: (value: QueryResult) => unknown, reject?: (reason: unknown) => unknown) {
    return Promise.resolve(this.result("then")).then(resolve, reject);
  }

  private result(terminal: string): QueryResult {
    if (this.table === "collector_imports" && this.operation === "select") return { data: null, error: null };
    if (this.table === "collector_imports" && this.operation === "insert" && terminal === "single") return { data: { id: "import-1", listing_id: null, status: "received" }, error: null };
    if (this.table === "listings" && this.operation === "select") return { data: null, error: null };
    if (this.table === "listing_source_metadata" && this.operation === "select") {
      const hasPostIdFilter = this.filters.some(([column, value]) => column === "metadata->>postId" && value === "4486483384955652");
      return { data: hasPostIdFilter ? [{ listing_id: "legacy-listing" }] : terminal === "maybeSingle" ? null : [], error: null };
    }
    return { data: null, error: null };
  }
}

const adminClient = { from: (table: string) => new Query(table) };

mock.module("@/lib/supabase/admin", { namedExports: { createAdminClient: () => adminClient } });
mock.module("@/features/flip-finder/filter-evaluation", { namedExports: { evaluateCanonicalListingDecision: () => ({ bucket: "REJECTED", reasons: [], missingFields: [], hardRejectReasons: [] }) } });
mock.module("@/features/flip-finder/server/canonical-reconciliation", { namedExports: { reconcileCanonicalListingDecision: async (input: Record<string, unknown>) => { state.reconciliationInputs.push(input); } } });
mock.module("@/features/flip-finder/server/search-filters", { namedExports: { getActiveSearchFiltersForSource: async () => [{ id: "filter-1" }] } });
mock.module("@/features/facebook-watcher/facebook-intent", { namedExports: { resolveFacebookListingIntent: () => ({ intent: "SELL_PROPERTY" }) } });
mock.module("@/features/facebook-watcher/search-quality", { namedExports: { classifyFacebookAvailability: () => "ACTIVE", classifyFacebookPropertyType: () => "APARTMENT" } });

const { importFacebookCollectorPayload } = await import("./facebook-import.ts");

test("collector reuses a legacy listing found by canonical Facebook post metadata", async () => {
  state.listingUpsertCalls = 0;
  state.metadataUpsertPayloads = [];
  state.reconciliationInputs = [];

  const result = await importFacebookCollectorPayload("device-1", "import-1", {
    sourcePostUrl: "https://www.facebook.com/groups/new-route/posts/4486483384955652?utm_source=feed",
    title: "Mieszkanie na sprzedaż",
    content: "Pełny opis oferty",
    price: 439000,
    area: 50,
    rooms: 2,
    location: "Łódź",
    imageUrls: [],
    collectedAt: "2026-09-27T20:00:00.000Z",
  });

  assert.equal(result.status, "updated");
  assert.equal(result.listingId, "legacy-listing");
  assert.equal(state.listingUpsertCalls, 0, "a canonical post match must not create another listings row");
  assert.equal(state.metadataUpsertPayloads[0]?.listing_id, "legacy-listing");
  assert.equal(state.reconciliationInputs.length, 1);
  assert.equal(state.reconciliationInputs[0]?.matchOrigin, "collector_import");
  assert.equal(state.reconciliationInputs[0]?.matchedAt, "2026-09-27T20:00:00.000Z", "canonical reconciliation must use the time the post was collected, not import processing time");
});
