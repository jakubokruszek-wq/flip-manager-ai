import assert from "node:assert/strict";
import test, { mock } from "node:test";

type Row = Record<string, unknown>;
const ownerId = "operator-a";

/** One shared fake for the service-role SQL RPC boundary and owner-scoped reads. */
function fakeDb() {
  const tables: Record<string, Row[]> = { price_radar_runs: [], price_radar_listings: [] };
  let sequence = 0;
  return {
    tables,
    async rpc(name: string, args: Row) {
      if (name === "claim_price_radar_run") {
        if (tables.price_radar_runs.some((row) => row.owner_id === args.p_owner_id && ["pending", "running"].includes(String(row.status)))) return { data: null, error: null };
        const row = { id: `run-${++sequence}`, run_id: `run-${sequence}`, owner_id: args.p_owner_id, status: "running", started_at: new Date().toISOString(), finished_at: null, checkpoint: args.p_initial_checkpoint, source_statuses: {}, scanned_count: 0, qualified_count: 0, error_message: null, lease_token: `lease-${sequence}`, lease_until: new Date(Date.now() + 120_000).toISOString() };
        tables.price_radar_runs.push(row);
        return { data: [row], error: null };
      }
      if (name === "checkpoint_price_radar_run") {
        const row = tables.price_radar_runs.find((item) => item.id === args.p_run_id && item.owner_id === args.p_owner_id && item.lease_token === args.p_lease_token && item.status === "running");
        if (!row) return { data: false, error: null };
        Object.assign(row, { checkpoint: args.p_checkpoint, source_statuses: args.p_source_statuses, scanned_count: args.p_scanned_count, qualified_count: args.p_qualified_count, status: args.p_status, error_message: args.p_error_message });
        if (["completed", "partial", "failed"].includes(String(args.p_status))) Object.assign(row, { finished_at: new Date().toISOString(), lease_token: null, lease_until: null });
        return { data: true, error: null };
      }
      if (name === "persist_price_radar_listing") {
        const run = tables.price_radar_runs.find((item) => item.id === args.p_run_id && item.owner_id === args.p_owner_id && item.lease_token === args.p_lease_token && item.status === "running");
        if (!run) return { data: null, error: { message: "RADAR_LEASE_LOST" } };
        const payload = args.p_listing as Row;
        let listing = tables.price_radar_listings.find((item) => item.owner_id === args.p_owner_id && item.source === payload.source && (item.external_listing_id === payload.external_listing_id || item.normalized_url === payload.normalized_url));
        if (!listing) { listing = { id: `listing-${++sequence}`, owner_id: args.p_owner_id, first_seen_at: payload.collected_at, excluded_at: null, excluded_reason: null }; tables.price_radar_listings.push(listing); }
        Object.assign(listing, payload, { status: "active" });
        return { data: listing.id, error: null };
      }
      if (name === "set_price_radar_listing_exclusion") {
        const selected = tables.price_radar_listings.find((item) => item.owner_id === args.p_owner_id && item.id === args.p_listing_id);
        if (!selected) return { data: false, error: null };
        for (const item of tables.price_radar_listings) {
          if (item.owner_id !== args.p_owner_id || (item.id !== selected.id && (!selected.cross_source_identity || item.cross_source_identity !== selected.cross_source_identity))) continue;
          item.excluded_at = args.p_excluded ? item.excluded_at ?? new Date().toISOString() : null;
          item.excluded_reason = args.p_excluded ? args.p_reason : null;
        }
        return { data: true, error: null };
      }
      throw new Error(`unexpected RPC ${name}`);
    },
    from(table: string) {
      const rows = tables[table] ?? (tables[table] = []);
      const filters: Array<(row: Row) => boolean> = [];
      let patch: Row | null = null;
      const builder: Row = {
        select: () => builder,
        eq: (key: string, value: unknown) => { filters.push((row) => row[key] === value); return builder; },
        in: (key: string, values: unknown[]) => { filters.push((row) => values.includes(row[key])); return builder; },
        order: () => builder,
        range: async () => ({ data: rows.filter((row) => filters.every((filter) => filter(row))), error: null }),
        update: (value: Row) => { patch = value; return builder; },
        maybeSingle: async () => {
          const matched = rows.filter((row) => filters.every((filter) => filter(row)));
          if (patch) matched.forEach((row) => Object.assign(row, patch));
          return { data: matched[0] ?? null, error: null };
        },
      };
      return builder;
    },
  };
}

let db: ReturnType<typeof fakeDb>;
mock.module("@/lib/supabase/admin", { namedExports: { createAdminClient: () => db } });
const fakeSources = [{
      id: "domiporta", label: "Domiporta", fetch: async () => ({
        listings: [{
          source: "domiporta", externalListingId: "flow-1", originalUrl: "https://domiporta.pl/flow-1", normalizedUrl: "https://domiporta.pl/flow-1",
          title: "Mieszkanie w bloku, Łódź Bałuty", description: "Świeżo po generalnym remoncie w 2025, gotowe do zamieszkania. Rynek wtórny.",
          price: 450_000, area: 50, pricePerSqm: 9_000, rooms: 2, floor: null, city: "Łódź", district: "Bałuty",
          buildingType: null, locationText: "Bałuty, Łódź", thumbnailUrl: null, images: [], publishedAt: null,
          // This fixture represents the already verified detail response for
          // a Domiporta candidate; search-card-only candidates must be rejected.
          rawPayload: { detailVerified: true }, contentHash: "hash-flow-1",
        }], warnings: [], fetched: 1,
      }),
    }];
mock.module("@/features/flip-finder/server/search-source-registry", {
  namedExports: {
    SOURCES: fakeSources,
    slugifyCity: () => "lodz",
    activeSources: (filter: { sources: string[] }) => fakeSources.filter((source) => filter.sources.includes(source.id)),
  },
});

const { claimOrCreateRadarRun, runRadarCollectionPortion } = await import("./collect.ts");
const { getRadarResults } = await import("./radar-results.ts");
const { excludeRadarListing, restoreRadarListing } = await import("./radar-exclusion.ts");

test("full fake-boundary flow: adapter -> qualification -> lease-fenced persist -> read -> exclusion -> refresh -> restore", async () => {
  db = fakeDb();
  const filters = { districts: ["Bałuty"], market: "both" as const, areaMin: null, areaMax: null, rooms: [], sources: [] };
  const claimed = await claimOrCreateRadarRun(ownerId, ["domiporta"], db as never);
  assert.equal(claimed.kind, "claimed");
  if (claimed.kind !== "claimed" || !claimed.run.leaseToken) return;
  const portion = await runRadarCollectionPortion({ runId: claimed.run.id, ownerId, leaseToken: claimed.run.leaseToken }, db as never);
  assert.equal(portion.status, "completed");
  assert.equal(portion.qualifiedCount, 1);

  const before = await getRadarResults(ownerId, filters, db as never);
  assert.equal(before.listings.length, 1);
  assert.equal(before.stats[0].sampleSize, 1);
  assert.equal(before.stats[0].averagePricePerSqm, null, "one listing is displayed as the actual sample, never as a price reference");
  const listingId = before.listings[0].id;

  assert.deepEqual(await excludeRadarListing(ownerId, listingId, "poza zakresem", db as never), { ok: true });
  const excluded = await getRadarResults(ownerId, filters, db as never);
  assert.equal(excluded.listings.length, 0);
  assert.equal(excluded.excludedListings.length, 1);
  assert.equal(excluded.stats.length, 0);

  const second = await claimOrCreateRadarRun(ownerId, ["domiporta"], db as never);
  assert.equal(second.kind, "claimed");
  if (second.kind === "claimed" && second.run.leaseToken) await runRadarCollectionPortion({ runId: second.run.id, ownerId, leaseToken: second.run.leaseToken }, db as never);
  const afterReimport = await getRadarResults(ownerId, filters, db as never);
  assert.equal(afterReimport.listings.length, 0, "the Radar-only exclusion survives reimport");
  assert.equal(afterReimport.excludedListings.length, 1);

  assert.deepEqual(await restoreRadarListing(ownerId, listingId, db as never), { ok: true });
  const restored = await getRadarResults(ownerId, filters, db as never);
  assert.equal(restored.listings.length, 1);
  assert.equal(restored.excludedListings.length, 0);
});
