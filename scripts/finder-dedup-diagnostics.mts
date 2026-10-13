/**
 * READ-ONLY diagnostics of Flip Finder cross-portal deduplication.
 *
 * Runs the exact Finder read path (getFilterResults -> partitionFinderRows ->
 * groupPropertyResults) twice: once with explicit identity only (the cards
 * before cross-portal deduplication) and once as the Finder runs it, and
 * prints which listings were linked, which stay separate and why, with the
 * score, evidence and conflicts of every assessed pair.
 *
 * The Supabase client is wrapped by readOnlySupabase(): insert, update,
 * upsert, delete, rpc and storage throw before any request is sent.
 *
 * Live (SELECT only; needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY):
 *   node --import ./scripts/test-alias-loader.mjs --experimental-strip-types --experimental-test-module-mocks \
 *     scripts/finder-dedup-diagnostics.mts --filter <search_filter_id> [--operator <user_id>] \
 *     [--case 238000:37.07 --case 298000:46.55] [--export features/flip-finder/server/__fixtures__/finder-dedup-production.json] [--out report.md]
 *
 * Replay of an export (no network):
 *   ... scripts/finder-dedup-diagnostics.mts --from features/flip-finder/server/__fixtures__/finder-dedup-production.json
 */
import { mock } from "node:test";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { readOnlySupabase } from "../features/flip-finder/server/read-only-supabase.ts";
import type { IdentityPairDiagnostic } from "../features/flip-finder/property-identity.ts";
import { FakeFacebookSupabase } from "../features/facebook-watcher/server/facebook-fake-supabase.ts";
import { buildDedupFixture, buildDedupReport, createSelectRecorder, FINDER_READ_TABLES, focusListingIds, type DedupFixture, type FocusCase } from "../features/flip-finder/server/dedup-diagnostics.ts";

function args(name: string): string[] {
  const values: string[] = [];
  process.argv.forEach((value, index) => { if (value === `--${name}` && process.argv[index + 1]) values.push(process.argv[index + 1]); });
  return values;
}

const fromPath = args("from")[0];
const fixture: DedupFixture | null = fromPath ? JSON.parse(readFileSync(fromPath, "utf8")) as DedupFixture : null;
const filterId = args("filter")[0] ?? fixture?.filterId;
const operatorId = args("operator")[0] ?? fixture?.operatorId ?? undefined;
const cases: FocusCase[] = (args("case").length ? args("case") : fixture ? [] : ["238000:37.07", "298000:46.55"]).map((value) => {
  const [price, area] = value.split(":").map(Number);
  return { price, area };
});
const focusCases = cases.length ? cases : fixture?.cases ?? [];
if (!filterId) throw new Error("Podaj --filter <search_filter_id> albo --from <eksport.json>.");

const { recorded, record } = createSelectRecorder();

let client: { from: (table: string) => unknown };
if (fixture) {
  const fake = new FakeFacebookSupabase();
  for (const table of FINDER_READ_TABLES) fake.seed(table, fixture.tables[table] ?? []);
  client = readOnlySupabase(fake as unknown as { from: (table: string) => unknown });
} else {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Brak NEXT_PUBLIC_SUPABASE_URL lub SUPABASE_SERVICE_ROLE_KEY w środowisku.");
  client = readOnlySupabase(createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } }), record);
}

mock.module("@/lib/supabase/server", { namedExports: { createClient: async () => client } });
mock.module("@/lib/supabase/admin", { namedExports: { createAdminClient: () => client } });
const { getFilterResults, resetFinderReadCachesForTests } = await import("../features/flip-finder/server/filter-results.ts");

const now = fixture ? Date.parse(fixture.now) : Date.now();
resetFinderReadCachesForTests();
const before = await getFilterResults(filterId, false, now, operatorId, { identity: { crossPortalEvidence: false } });
resetFinderReadCachesForTests();
const pairs: IdentityPairDiagnostic[] = [];
const after = await getFilterResults(filterId, false, now, operatorId, { identity: { onPairAssessed: (pair) => pairs.push(pair) } });
if (!before || !after) throw new Error(`Nie znaleziono filtra ${filterId}.`);

const listingRows = new Map<string, Record<string, unknown>>(
  (fixture ? fixture.tables.listings ?? [] : [...(recorded.get("listings")?.values() ?? [])]).map((row) => [String(row.id), row]),
);
const report = buildDedupReport({ before, after, pairs, cases: focusCases, listingRows });
const outPath = args("out")[0];
if (outPath) writeFileSync(outPath, report);
console.log(report);

const exportPath = args("export")[0];
if (exportPath) {
  if (fixture) throw new Error("--export działa tylko w trybie live.");
  const ids = focusListingIds(after, pairs, focusCases);
  const exported = buildDedupFixture({ recorded, ids, filterId, operatorId: operatorId ?? null, now, cases: focusCases });
  mkdirSync(dirname(exportPath), { recursive: true });
  writeFileSync(exportPath, `${JSON.stringify(exported, null, 2)}\n`);
  console.error(`Zapisano eksport ${ids.size} ofert do ${exportPath}.`);
}
