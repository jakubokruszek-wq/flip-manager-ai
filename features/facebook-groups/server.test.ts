import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { mock } from "node:test";

/**
 * The full discovery -> preview -> import pipeline (discoverFacebookGroups,
 * previewDiscoveryToken, importSelectedFacebookGroups, addWatchedFacebookGroup)
 * had NO end-to-end test at all before this file: discovery-session.test.ts
 * only covers the session store itself, and scheduler-group-registry.test.ts
 * only exercises addWatchedFacebookGroup directly (bypassing the discovery
 * session entirely). This drives the real, production server.ts functions
 * against a minimal fake covering exactly the two tables they touch
 * (facebook_group_discovery_sessions, watched_facebook_groups), matching the
 * same query-shape-specific fake convention discovery-session.test.ts and
 * gallery-request-trace's own tests already use.
 */

type SessionRow = { id: string; token_hash: string; device_id: string | null; candidates: unknown[]; expires_at: string; consumed_at: string | null };
type GroupRow = Record<string, unknown>;

function fakeCombinedAdmin(seedGroups: GroupRow[] = []) {
  const sessionRows: SessionRow[] = [];
  const groupRows: GroupRow[] = [...seedGroups];

  const client = {
    from(table: string) {
      if (table === "facebook_group_discovery_sessions") {
        return {
          insert(payload: Record<string, unknown>) {
            return {
              select() {
                return {
                  async single() {
                    const row: SessionRow = { id: randomUUID(), token_hash: String(payload.token_hash), device_id: (payload.device_id as string | null) ?? null, candidates: (payload.candidates as unknown[]) ?? [], expires_at: String(payload.expires_at), consumed_at: null };
                    sessionRows.push(row);
                    return { data: { id: row.id }, error: null };
                  },
                };
              },
            };
          },
          delete() {
            return { async lt() { return { error: null }; } };
          },
          select() {
            return {
              eq(_column: string, id: string) {
                return { async maybeSingle() { return { data: sessionRows.find((row) => row.id === id) ?? null, error: null }; } };
              },
            };
          },
          update(patch: Record<string, unknown>) {
            return {
              eq(_column: string, id: string) {
                return {
                  is(column: string, value: unknown) {
                    return (async () => {
                      const row = sessionRows.find((item) => item.id === id && (item as unknown as Record<string, unknown>)[column] === value);
                      if (row) Object.assign(row, patch);
                      return { error: null };
                    })();
                  },
                };
              },
            };
          },
        };
      }
      if (table === "watched_facebook_groups") {
        return {
          select() {
            return { order: () => ({ order: async () => ({ data: groupRows, error: null }) }) };
          },
          insert(row: GroupRow) {
            return {
              select() {
                return {
                  async single() {
                    groupRows.push(row);
                    return { data: row, error: null };
                  },
                };
              },
            };
          },
        };
      }
      throw new Error(`fakeCombinedAdmin: unexpected table "${table}"`);
    },
  };
  return { client, sessionRows, groupRows };
}

let current = fakeCombinedAdmin();
mock.module("@/features/facebook-watcher/supabase-admin", { namedExports: { createFacebookWatcherAdminClient: () => current.client } });

const { discoverFacebookGroups, previewDiscoveryToken, importSelectedFacebookGroups, addWatchedFacebookGroup } = await import("./server.ts");

function candidate(url: string, name: string | null = "Nieruchomości Łódź Test") {
  return { url, name, discoveredAt: new Date().toISOString() };
}

test("a discovered candidate previews with its real name and is importable, then reaches the registry enabled=true", async () => {
  current = fakeCombinedAdmin();
  const { token } = await discoverFacebookGroups([candidate("https://www.facebook.com/groups/700111222333/", "Łódź Nieruchomości Flip")], "device-1");
  const preview = await previewDiscoveryToken(token);
  assert.ok(preview);
  assert.equal(preview!.preview.length, 1);
  assert.equal(preview!.preview[0].status, "NOWA_NIERUCHOMOSCIOWA");
  assert.equal(preview!.preview[0].discoveredName, "Łódź Nieruchomości Flip", "the previewed name must be exactly what the extension reported, never invented");

  const outcomes = await importSelectedFacebookGroups(token, [{ url: "https://www.facebook.com/groups/700111222333/", name: "Łódź Nieruchomości Flip" }]);
  assert.ok(outcomes);
  assert.equal(outcomes!.length, 1);
  assert.equal(outcomes![0].result.success, true);
  if (!outcomes![0].result.success) return;
  assert.equal(outcomes![0].result.group.name, "Łódź Nieruchomości Flip");
  assert.equal(outcomes![0].result.group.enabled, true, "an imported group must default to enabled=true so the scheduler picks it up automatically");
  assert.equal(current.groupRows.length, 1);
});

test("importing the exact same candidate a second time is idempotent: no duplicate row, a clear duplicate result", async () => {
  current = fakeCombinedAdmin();
  const { token } = await discoverFacebookGroups([candidate("https://www.facebook.com/groups/800111222333/")], null);
  const selection = [{ url: "https://www.facebook.com/groups/800111222333/", name: "Nieruchomości Łódź Test" }];

  const first = await importSelectedFacebookGroups(token, selection);
  assert.equal(first?.[0]?.result.success, true);
  assert.equal(current.groupRows.length, 1);

  // Re-run discovery + import for the identical group, simulating the
  // operator running discovery again after already importing it.
  const second = await discoverFacebookGroups([candidate("https://www.facebook.com/groups/800111222333/")], null);
  const outcomes = await importSelectedFacebookGroups(second.token, selection);
  assert.equal(outcomes?.[0]?.result.success, false);
  assert.equal(outcomes?.[0]?.result.duplicate, true, "a group already in the registry must be reported as a duplicate, never silently re-created");
  assert.equal(current.groupRows.length, 1, "no second row may ever be created for the same group");
});

// Mission: automatically add Łódź real-estate groups to the Watcher, never
// anything else -- discovery.test.ts already unit-tests classification in
// isolation, but nothing before this test drove the extension's own raw
// candidate shape through the REAL discoverFacebookGroups/
// previewDiscoveryToken/importSelectedFacebookGroups pipeline end to end to
// prove the Łódź+real-estate gate actually reaches the registry, not just
// the classifier's return value. Mirrors watched-groups-page.tsx's own
// importAllRealEstate bulk action, which only ever selects
// NOWA_NIERUCHOMOSCIOWA rows for import.
test("end-to-end: of four extension-shaped discovered candidates, only the Łódź real-estate group reaches the registry, and re-running discovery is idempotent", async () => {
  current = fakeCombinedAdmin();
  const lodzRealEstate = candidate("https://www.facebook.com/groups/400111222331/", "Łódź Nieruchomości Flip");
  const otherCityRealEstate = candidate("https://www.facebook.com/groups/400111222332/", "Nieruchomości Kraków Sprzedam Wynajmę");
  const noCityRealEstate = candidate("https://www.facebook.com/groups/400111222333/", "Mieszkania i Domy Sprzedam Wynajmę");
  const lodzNonRealEstate = candidate("https://www.facebook.com/groups/400111222334/", "Przepisy Kulinarne Łódź");
  const candidates = [lodzRealEstate, otherCityRealEstate, noCityRealEstate, lodzNonRealEstate];

  const { token } = await discoverFacebookGroups(candidates, "device-e2e");
  const preview = await previewDiscoveryToken(token);
  assert.ok(preview);
  const byUrl = new Map(preview!.preview.map((item) => [item.url, item]));
  assert.equal(byUrl.get(lodzRealEstate.url)?.status, "NOWA_NIERUCHOMOSCIOWA", "Łódź + real-estate must be the only auto-import-eligible classification");
  assert.equal(byUrl.get(otherCityRealEstate.url)?.status, "POMINIETA_NIERNIERUCHOMOSCIOWA", "a confidently different city must be excluded, never left ambiguous");
  assert.equal(byUrl.get(noCityRealEstate.url)?.status, "WYMAGA_WERYFIKACJI", "real estate with no city mentioned must require manual review, never be guessed either way");
  assert.equal(byUrl.get(lodzNonRealEstate.url)?.status, "POMINIETA_NIERNIERUCHOMOSCIOWA", "mentioning Łódź alone, with no real-estate signal, must never qualify");

  // The exact same filter watched-groups-page.tsx's importAllRealEstate applies.
  const eligible = preview!.preview.filter((item) => item.status === "NOWA_NIERUCHOMOSCIOWA");
  assert.equal(eligible.length, 1);
  const outcomes = await importSelectedFacebookGroups(token, eligible.map((item) => ({ url: item.url, name: item.discoveredName! })));
  assert.ok(outcomes);
  assert.equal(outcomes!.length, 1);
  assert.equal(outcomes![0].result.success, true);
  assert.equal(current.groupRows.length, 1, "only the Łódź real-estate candidate may ever reach the registry -- never the other three");
  assert.equal(current.groupRows[0].name, "Łódź Nieruchomości Flip");

  // Idempotency: the operator re-running discovery (e.g. the next day) must
  // see the already-imported group reclassified as JUZ_W_MANAGERZE, and an
  // import attempt on it must fail as a duplicate rather than create a
  // second row -- proving the registry's own duplicate-URL check, not just
  // the discovery session's.
  const second = await discoverFacebookGroups(candidates, "device-e2e");
  const secondPreview = await previewDiscoveryToken(second.token);
  assert.equal(secondPreview!.preview.find((item) => item.url === lodzRealEstate.url)?.status, "JUZ_W_MANAGERZE");
  const secondOutcomes = await importSelectedFacebookGroups(second.token, [{ url: lodzRealEstate.url, name: "Łódź Nieruchomości Flip" }]);
  assert.equal(secondOutcomes?.[0]?.result.success, false);
  assert.equal(secondOutcomes?.[0]?.result.duplicate, true);
  assert.equal(current.groupRows.length, 1, "the registry must still contain exactly one row after the repeat run");
});

test("a URL not present in this session's own discovered candidates is rejected even with a valid token (no cross-session candidate injection)", async () => {
  current = fakeCombinedAdmin();
  const { token } = await discoverFacebookGroups([candidate("https://www.facebook.com/groups/900111222333/")], null);
  const outcomes = await importSelectedFacebookGroups(token, [{ url: "https://www.facebook.com/groups/999999999999/", name: "Injected Group" }]);
  assert.ok(outcomes);
  assert.equal(outcomes![0].result.success, false);
  assert.match(outcomes![0].result.error ?? "", /autoryzowanej sesji/);
  assert.equal(current.groupRows.length, 0, "no group may ever be created from a URL outside the session's own candidates");
});

test("an unknown/expired token imports nothing and returns null, never falling back to some other session", async () => {
  current = fakeCombinedAdmin();
  const outcomes = await importSelectedFacebookGroups("00000000-0000-4000-8000-000000000000.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", [{ url: "https://www.facebook.com/groups/111/", name: "Ghost" }]);
  assert.equal(outcomes, null);
  assert.equal(current.groupRows.length, 0);
});

test("importSelectedFacebookGroups still enforces addWatchedFacebookGroup's own required-name validation -- a discovered candidate cannot skip it", async () => {
  current = fakeCombinedAdmin();
  const { token } = await discoverFacebookGroups([candidate("https://www.facebook.com/groups/111222333444/", null)], null);
  const outcomes = await importSelectedFacebookGroups(token, [{ url: "https://www.facebook.com/groups/111222333444/", name: "   " }]);
  assert.ok(outcomes);
  assert.equal(outcomes![0].result.success, false);
  if (outcomes![0].result.success) return;
  assert.equal("validationError" in outcomes![0].result && outcomes![0].result.validationError, true);
  assert.equal(current.groupRows.length, 0, "a blank/whitespace-only name must never reach the registry");
});

// Separation requirement: importing a group is a pure database write. It
// must never touch anything Facebook-scan-related -- that is exclusively
// the scheduler's own, later, independent job (features/facebook-worker).
test("importing a discovered group never creates a facebook_scan_jobs row or any scan-related table access", async () => {
  current = fakeCombinedAdmin();
  const touchedTables: string[] = [];
  const originalFrom = current.client.from.bind(current.client);
  current.client.from = ((table: string) => { touchedTables.push(table); return originalFrom(table); }) as typeof current.client.from;

  const { token } = await discoverFacebookGroups([candidate("https://www.facebook.com/groups/222333444555/")], null);
  await importSelectedFacebookGroups(token, [{ url: "https://www.facebook.com/groups/222333444555/", name: "Nieruchomości Łódź Test" }]);

  assert.ok(!touchedTables.includes("facebook_scan_jobs"));
  assert.ok(!touchedTables.includes("source_scans"));
  assert.deepEqual(new Set(touchedTables), new Set(["facebook_group_discovery_sessions", "watched_facebook_groups"]));
});

test("addWatchedFacebookGroup used directly (the manual 'add group' form path) also defaults enabled=true", async () => {
  current = fakeCombinedAdmin();
  const result = await addWatchedFacebookGroup({ url: "https://www.facebook.com/groups/333444555666/", name: "Manual Add Test" });
  assert.equal(result.success, true);
  if (!result.success) return;
  assert.equal(result.group.enabled, true);
});
