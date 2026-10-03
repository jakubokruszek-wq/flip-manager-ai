import assert from "node:assert/strict";
import test, { mock } from "node:test";

let clientCalls = 0;
mock.module("@/lib/supabase/server", {
  namedExports: {
    createClient: () => {
      clientCalls += 1;
      throw new Error("disabled source must return before loading filters");
    },
  },
});

const { getActiveSearchFiltersForSource } = await import("./search-filters.ts");

test("a legacy unavailable source never reaches the active-filter worker query", async () => {
  clientCalls = 0;
  assert.deepEqual(await getActiveSearchFiltersForSource("official_uml"), []);
  assert.equal(clientCalls, 0);
});

test("Bezposrednio stays blocked by the same runtime gate", async () => {
  clientCalls = 0;
  assert.deepEqual(await getActiveSearchFiltersForSource("bezposrednio"), []);
  assert.equal(clientCalls, 0);
});
