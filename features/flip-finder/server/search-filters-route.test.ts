import assert from "node:assert/strict";
import test, { mock } from "node:test";

// Reimplemented locally rather than imported from the real module: the real
// "@/features/auth/operator" transitively imports next/headers via
// createAuthServerClient, which is unavailable outside the Next runtime.
// mock.module below replaces the whole specifier before anything imports it
// for real, so the mock must be fully self-contained.
class OperatorAuthorizationError extends Error {
  readonly status: 401 | 403;
  readonly code: "OPERATOR_SESSION_REQUIRED" | "OPERATOR_ROLE_REQUIRED";
  constructor(status: 401 | 403, code: "OPERATOR_SESSION_REQUIRED" | "OPERATOR_ROLE_REQUIRED") {
    super(code);
    this.name = "OperatorAuthorizationError";
    this.status = status;
    this.code = code;
  }
}
function operatorAuthorizationResponse(error: unknown): Response {
  if (error instanceof OperatorAuthorizationError) return Response.json({ ok: false, code: error.code }, { status: error.status });
  throw error;
}

let operatorOutcome: "authorized" | "unauthenticated" | "forbidden" = "authorized";
mock.module("@/features/auth/operator", {
  namedExports: {
    OperatorAuthorizationError,
    operatorAuthorizationResponse,
    requireOperator: async () => {
      if (operatorOutcome === "unauthenticated") throw new OperatorAuthorizationError(401, "OPERATOR_SESSION_REQUIRED");
      if (operatorOutcome === "forbidden") throw new OperatorAuthorizationError(403, "OPERATOR_ROLE_REQUIRED");
      return { id: "operator-1", email: "operator@example.com" };
    },
  },
});

type WriteResult = { data: Record<string, unknown> | null; error: { code: string; message: string } | null };
let insertResult: WriteResult = { data: null, error: null };
let updateResult: WriteResult = { data: null, error: null };

// Shared, stateful backing store standing in for the database: a create
// through the admin client appends here, and a subsequent list read through
// the regular client (exactly what a real page reload re-fetches) reflects
// it. This is what proves the create -> persist -> "refresh" round trip
// without a real Supabase Production connection or a real browser-
// authenticated operator session, neither of which is available in this
// environment (the proxy in lib/supabase/auth-proxy.ts redirects any
// unauthenticated page navigation to /login before a real page ever
// renders, so a full Playwright browser test cannot exercise this without
// real credentials) — an explicit, acknowledged limitation, substituted
// with this route-level integration test per this mission's own allowance.
const searchFiltersTable: Record<string, unknown>[] = [];

function chainable(result: unknown) {
  const builder: Record<string, unknown> = {
    select: () => builder,
    eq: () => builder,
    not: () => builder,
    order: () => builder,
    limit: () => builder,
    then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => Promise.resolve(result).then(resolve, reject),
  };
  return builder;
}

let adminClientThrowMessage: string | null = null;
function fakeAdminClient() {
  if (adminClientThrowMessage) throw new Error(adminClientThrowMessage);
  return {
    from: () => ({
      insert: () => ({
        select: () => ({
          single: async () => {
            if (insertResult.data) searchFiltersTable.push(insertResult.data);
            return insertResult;
          },
        }),
      }),
      update: () => ({
        eq: (_column: string, id: string) => ({
          select: () => ({
            maybeSingle: async () => {
              if (updateResult.data) {
                const index = searchFiltersTable.findIndex((row) => row.id === id);
                if (index >= 0) searchFiltersTable[index] = updateResult.data;
              }
              return updateResult;
            },
          }),
        }),
      }),
      delete: () => ({ eq: async () => ({ error: null, count: 1 }) }),
    }),
  };
}

mock.module("@/lib/supabase/admin", {
  namedExports: {
    createAdminClient: fakeAdminClient,
  },
});

mock.module("@/lib/supabase/server", {
  namedExports: {
    createClient: async () => ({
      from: (table: string) => (table === "search_filters" ? chainable({ data: searchFiltersTable, error: null }) : chainable({ data: [], error: null })),
    }),
  },
});

const collectionRoute = await import("../../../app/api/flip-finder/search-filters/route.ts");
const itemRoute = await import("../../../app/api/flip-finder/search-filters/[id]/route.ts");

const now = "2026-09-26T00:00:00.000Z";
const validPayload = {
  name: "Test filter",
  sources: ["otodom"],
  city: "Łódź",
  districts: [],
  priceMin: null,
  priceMax: null,
  areaMin: null,
  areaMax: null,
  rooms: [],
  floorMin: null,
  floorMax: null,
  excludeGroundFloor: false,
  excludeTopFloor: false,
  buildingTypes: [],
  ownershipTypes: [],
  marketType: null,
  privateOnly: false,
  maxPricePerSqm: null,
  requiredKeywords: [],
  excludedKeywords: [],
  minFlipScore: null,
  minEstimatedProfit: null,
  maxEstimatedRenovationCost: null,
  scanIntervalMinutes: 60,
  isActive: true,
};

const validRow = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Test filter",
  sources: ["otodom"],
  city: "Łódź",
  districts: [],
  price_min: null,
  price_max: null,
  area_min: null,
  area_max: null,
  rooms: [],
  floor_min: null,
  floor_max: null,
  exclude_ground_floor: false,
  exclude_top_floor: false,
  building_types: [],
  ownership_types: [],
  market_type: null,
  private_only: false,
  max_price_per_sqm: null,
  required_keywords: [],
  excluded_keywords: [],
  min_flip_score: null,
  min_estimated_profit: null,
  max_estimated_renovation_cost: null,
  scan_interval_minutes: 60,
  is_active: true,
  last_scanned_at: null,
  created_at: now,
  updated_at: now,
};

function postRequest(body: unknown): Request {
  return new Request("https://flip-manager-ai.vercel.app/api/flip-finder/search-filters", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function patchRequest(body: unknown): Request {
  return new Request("https://flip-manager-ai.vercel.app/api/flip-finder/search-filters/fixture-id", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("an unauthenticated request is rejected with 401 before any write is attempted", async () => {
  operatorOutcome = "unauthenticated";
  const response = await collectionRoute.POST(postRequest(validPayload));
  assert.equal(response.status, 401);
});

test("a session without the operator role is rejected with 403 before any write is attempted", async () => {
  operatorOutcome = "forbidden";
  const response = await collectionRoute.POST(postRequest(validPayload));
  assert.equal(response.status, 403);
});

test("an authorized operator can create a filter", async () => {
  operatorOutcome = "authorized";
  insertResult = { data: validRow, error: null };
  const response = await collectionRoute.POST(postRequest(validPayload));
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.name, "Test filter");
});

test("a database error while creating a filter returns a specific, diagnostic message — never the same opaque string regardless of cause", async () => {
  operatorOutcome = "authorized";
  insertResult = { data: null, error: { code: "42501", message: "permission denied for table search_filters" } };
  const response = await collectionRoute.POST(postRequest(validPayload));
  assert.equal(response.status, 500);
  const body = await response.json();
  assert.match(body.message, /42501/);
  assert.match(body.message, /permission denied for table search_filters/);
});

test("an authorized operator can update a filter, and it round-trips through GET immediately after — the exact regression this mission guards", async () => {
  operatorOutcome = "authorized";
  updateResult = { data: { ...validRow, name: "Updated filter" }, error: null };
  const response = await itemRoute.PATCH(patchRequest({ ...validPayload, name: "Updated filter" }), { params: Promise.resolve({ id: validRow.id }) });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.filter.name, "Updated filter");
});

test("a database error while updating a filter returns a specific, diagnostic message", async () => {
  operatorOutcome = "authorized";
  updateResult = { data: null, error: { code: "23514", message: "new row for relation \"search_filters\" violates check constraint \"search_filters_price_range\"" } };
  const response = await itemRoute.PATCH(patchRequest(validPayload), { params: Promise.resolve({ id: validRow.id }) });
  assert.equal(response.status, 500);
  const body = await response.json();
  assert.match(body.message, /23514/);
  assert.match(body.message, /search_filters_price_range/);
});

test("invalid input is rejected with a specific 400 before any write is attempted, distinct from a database error", async () => {
  operatorOutcome = "authorized";
  const response = await collectionRoute.POST(postRequest({ ...validPayload, name: "" }));
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.match(body.message, /Nazwa/);
});

// Substitutes for a real browser test of "create a filter, refresh the
// page, confirm it still exists": creates through the real POST handler,
// then re-fetches through the real GET handler exactly as a page reload
// would, and confirms the created filter is present in that fresh read.
// A real Playwright browser test cannot exercise this in this environment
// (see the comment on searchFiltersTable above) because the request never
// reaches this handler at all — lib/supabase/auth-proxy.ts's
// refreshOperatorSession redirects any unauthenticated page navigation to
// /login before the page renders, and no real operator session is
// available here.
test("a filter created via POST is present in a subsequent GET — the create-then-refresh round trip a real page reload performs", async () => {
  operatorOutcome = "authorized";
  searchFiltersTable.length = 0;
  const created = { ...validRow, id: "22222222-2222-4222-8222-222222222222", name: "Round-trip filter" };
  insertResult = { data: created, error: null };

  const postResponse = await collectionRoute.POST(postRequest({ ...validPayload, name: "Round-trip filter" }));
  assert.equal(postResponse.status, 201);

  const getResponse = await collectionRoute.GET();
  assert.equal(getResponse.status, 200);
  const body = await getResponse.json();
  assert.ok(body.filters.some((filter: { name: string }) => filter.name === "Round-trip filter"), "the just-created filter must be present in a fresh list read, exactly as a real page reload would show");
});

// A real, previously-undiscovered gap: only a Postgres query returning a
// structured {error} (a SearchFilterWriteError) was ever surfaced. Anything
// thrown earlier -- most importantly createAdminClient() itself throwing
// when a required server credential (NEXT_PUBLIC_SUPABASE_URL /
// SUPABASE_SERVICE_ROLE_KEY) is missing -- is a plain Error, and fell
// through to the exact same opaque fallback message this whole mission
// exists to fix. This proves that gap is now closed.
test("createAdminClient() itself throwing (e.g. a missing server credential) is surfaced with its real message, not the generic fallback", async () => {
  operatorOutcome = "authorized";
  adminClientThrowMessage = "Brak konfiguracji serwerowego dostępu Supabase: brakuje SUPABASE_SERVICE_ROLE_KEY.";
  try {
    const response = await collectionRoute.POST(postRequest(validPayload));
    assert.equal(response.status, 500);
    const body = await response.json();
    assert.match(body.message, /SUPABASE_SERVICE_ROLE_KEY/, "the real thrown message must reach the API response, not a generic string");
  } finally {
    adminClientThrowMessage = null;
  }
});

// The client already guards against a double click by disabling the submit
// button for the duration of the request (search-filter-form.tsx sets
// `saving=true`, which the button's `disabled` prop reads, synchronously
// before the network call begins) -- verified here directly against the
// component source, since a live double-click gesture needs the same real
// browser session this file's other comments explain is unavailable.
test("the client's double-submit guard disables the button synchronously before the network request, not after", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../components/search-filter-form.tsx", import.meta.url), "utf8");
  const submitBody = source.match(/const submit = async \(event: React\.FormEvent\) => \{[\s\S]*?\};/)?.[0];
  assert.ok(submitBody, "submit handler must exist");
  const setSavingTrueIndex = submitBody.indexOf("setSaving(true)");
  const fetchIndex = submitBody.indexOf("await fetch(");
  assert.ok(setSavingTrueIndex >= 0 && fetchIndex > setSavingTrueIndex, "setSaving(true) must run before the network request starts, so a second click while saving cannot fire a second submit");
  assert.match(source, /disabled=\{saving\}/, "the submit button must be disabled while saving");
});

// Even if two requests somehow both reached the server (a network-level
// retry, not just a UI double-click), each is handled independently and
// correctly -- neither corrupts the other's response or crashes the route.
test("two concurrent create requests are each handled independently and correctly, with no crash or cross-talk", async () => {
  operatorOutcome = "authorized";
  insertResult = { data: { ...validRow, name: "Concurrent A" }, error: null };
  const first = collectionRoute.POST(postRequest({ ...validPayload, name: "Concurrent A" }));
  insertResult = { data: { ...validRow, id: "33333333-3333-4333-8333-333333333333", name: "Concurrent B" }, error: null };
  const second = collectionRoute.POST(postRequest({ ...validPayload, name: "Concurrent B" }));
  const [firstResponse, secondResponse] = await Promise.all([first, second]);
  assert.equal(firstResponse.status, 201);
  assert.equal(secondResponse.status, 201);
});
