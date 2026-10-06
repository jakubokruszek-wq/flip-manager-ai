import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { FakeFacebookSupabase } from "../../facebook-watcher/server/facebook-fake-supabase.ts";
import type { createAdminClient } from "@/lib/supabase/admin";

let clientCalls = 0;
mock.module("@/lib/supabase/server", {
  namedExports: {
    createClient: () => {
      clientCalls += 1;
      throw new Error("disabled source must return before loading filters");
    },
  },
});

const { getActiveSearchFiltersForSource, getSearchFilter } = await import("./search-filters.ts");

test("the all-blocked official auction category never reaches the active-filter worker query", async () => {
  clientCalls = 0;
  assert.deepEqual(await getActiveSearchFiltersForSource("official_auction"), []);
  assert.equal(clientCalls, 0);
});

test("Bezposrednio stays blocked by the same runtime gate", async () => {
  clientCalls = 0;
  assert.deepEqual(await getActiveSearchFiltersForSource("bezposrednio"), []);
  assert.equal(clientCalls, 0);
});

test("a service continuation loads its filter with the supplied client and bounded signal, without a browser session", async () => {
  clientCalls = 0;
  const db = new FakeFacebookSupabase();
  db.seed("search_filters", [{
    id: "service-filter", name: "Service", sources: ["domy"], city: "Łódź", is_active: true,
    districts: [], rooms: [], building_types: [], ownership_types: [], required_keywords: [], excluded_keywords: [],
    price_min: null, price_max: null, area_min: null, area_max: null, floor_min: null, floor_max: null,
    exclude_ground_floor: false, exclude_top_floor: false, private_only: false, market_type: null,
    max_price_per_sqm: null, min_flip_score: null, min_estimated_profit: null, max_estimated_renovation_cost: null,
    scan_interval_minutes: 60, finder_scan_interval_minutes: 30, last_scanned_at: null,
    created_at: "2026-10-06T00:00:00Z", updated_at: "2026-10-06T00:00:00Z",
  }]);
  const signal = AbortSignal.timeout(5_000);
  let observedSignal: AbortSignal | undefined;
  const from = db.from.bind(db);
  db.from = (table) => {
    const query = from(table);
    const abortSignal = query.abortSignal.bind(query);
    query.abortSignal = (value?: AbortSignal) => { observedSignal = value; return abortSignal(); };
    return query;
  };
  const filter = await getSearchFilter("service-filter", { supabase: db as unknown as ReturnType<typeof createAdminClient>, signal });
  assert.equal(filter?.id, "service-filter");
  assert.equal(filter?.finderScanIntervalMinutes, 30);
  assert.equal(observedSignal, signal);
  assert.equal(clientCalls, 0);
});
