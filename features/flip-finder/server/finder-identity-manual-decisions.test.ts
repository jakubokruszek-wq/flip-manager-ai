import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { mock } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { FakeFacebookSupabase } from "../../facebook-watcher/server/facebook-fake-supabase.ts";
import { NOW, productionFactsRows, productionScenarioRows } from "./finder-dedup-scenario.fixture.ts";

/**
 * Manual "Połącz" / "Nie łącz" / "Rozłącz" end to end: the real SQL function
 * manage_finder_listing_identity (repository migrations, in PGlite) stores
 * the decision, then the real Finder read path shows the result. Listings,
 * memberships and price history are never changed by a decision.
 */
const ROOT = path.resolve(import.meta.dirname, "../../..");
const IDENTITY_MIGRATION = path.join(ROOT, "supabase/migrations/20261008120000_add_confirmed_property_identity.sql");
const MANUAL_MIGRATION = path.join(ROOT, "supabase/migrations/20261009120000_add_finder_identity_evidence_and_manual_groups.sql");
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FILTER_UUID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

type Tables = Record<string, Record<string, unknown>[]>;

/** Readable fixture ids -> UUIDs (the identity API accepts UUIDs only). */
function uuidFor(label: string): string {
  let hash = 0;
  for (const char of label) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  const hex = hash.toString(16).padStart(8, "0");
  return `${hex}-0000-4000-8000-${hex}0000`;
}

function withUuids(tables: Tables): { tables: Tables; id: (label: string) => string; label: (id: string) => string } {
  const labels = new Map<string, string>();
  const id = (label: string) => { const value = uuidFor(label); labels.set(value, label); return value; };
  const mapped: Tables = {};
  for (const [table, rows] of Object.entries(tables)) {
    mapped[table] = rows.map((row) => {
      const next = { ...row };
      if (table === "listings") next.id = id(String(row.id));
      if (table === "search_filters") next.id = FILTER_UUID;
      if ("listing_id" in row) next.listing_id = id(String(row.listing_id));
      if ("search_filter_id" in row) next.search_filter_id = FILTER_UUID;
      return next;
    });
  }
  return { tables: mapped, id, label: (value: string) => labels.get(value) ?? value };
}

async function identityDatabase(listingIds: string[]): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create table public.listings(id uuid primary key, source text, price numeric, cross_source_identity text, lifecycle_status text, manual_decision text, manual_decision_reason text, review_reason text, missing_fields jsonb not null default '[]'::jsonb, archived_at timestamptz, status text not null default 'active');
    create table public.search_filters(id uuid primary key);
    create table public.listing_filter_matches(listing_id uuid not null, search_filter_id uuid not null, is_current_match boolean not null default true, primary key(listing_id,search_filter_id));
    create table public.properties(id uuid primary key, cross_source_identity text);
    create table public.price_radar_listings(cross_source_identity text);
    grant usage on schema public to anon, authenticated, service_role;
    grant select, insert, update, delete on all tables in schema public to service_role;
  `);
  await db.exec(fs.readFileSync(IDENTITY_MIGRATION, "utf8"));
  await db.exec(fs.readFileSync(MANUAL_MIGRATION, "utf8"));
  await db.query(`insert into public.search_filters(id) values ($1)`, [FILTER_UUID]);
  for (const id of listingIds) {
    await db.query(`insert into public.listings(id,status) values ($1,'active')`, [id]);
    await db.query(`insert into public.listing_filter_matches(listing_id,search_filter_id) values ($1,$2)`, [id, FILTER_UUID]);
  }
  return db;
}

let currentDb = new FakeFacebookSupabase();
mock.module("@/lib/supabase/server", { namedExports: { createClient: async () => currentDb } });
mock.module("@/lib/supabase/admin", { namedExports: { createAdminClient: () => currentDb } });
const { getFilterResults, resetFinderReadCachesForTests } = await import("./filter-results.ts");

async function scenario(tables: Tables) {
  const mapped = withUuids(tables);
  const listingIds = mapped.tables.listings.map((row) => String(row.id));
  const sql = await identityDatabase(listingIds);
  const decide = async (action: "link" | "not_link" | "unlink", a: string, b?: string) => {
    await sql.exec("set role service_role");
    try {
      await sql.query(`select * from public.manage_finder_listing_identity($1,$2,$3,$4,$5)`, [OWNER, FILTER_UUID, action, mapped.id(a), b ? mapped.id(b) : null]);
    } finally { await sql.exec("reset role"); }
  };
  const read = async (mutate?: (tables: Tables) => void) => {
    const groups = (await sql.query<Record<string, unknown>>(`select owner_id::text, search_filter_id::text, group_id::text, listing_id::text from public.finder_listing_identity_groups`)).rows;
    const decisions = (await sql.query<Record<string, unknown>>(`select owner_id::text, search_filter_id::text, listing_a::text, listing_b::text, decision from public.finder_listing_identity_decisions`)).rows;
    const tablesNow = structuredClone(mapped.tables);
    mutate?.(tablesNow);
    const fake = new FakeFacebookSupabase();
    for (const [table, rows] of Object.entries(tablesNow)) fake.seed(table, rows);
    fake.seed("finder_listing_identity_groups", groups).seed("finder_listing_identity_decisions", decisions);
    currentDb = fake;
    resetFinderReadCachesForTests();
    const payload = await getFilterResults(FILTER_UUID, false, NOW, OWNER);
    assert.ok(payload);
    const cards = [...payload.results, ...payload.reviewResults, ...payload.buildingVerificationResults];
    const cardOf = (label: string) => cards.find((card) => (card.linkedListings ?? [{ id: card.id }]).some((item) => item.id === mapped.id(label)));
    return {
      cards,
      fake,
      members: (label: string) => (cardOf(label)?.linkedListings ?? []).map((item) => mapped.label(item.id)).sort(),
      sources: (label: string) => (cardOf(label)?.linkedListings ?? []).map((item) => `${item.source}:${item.originalUrl ? "link" : "brak"}`).sort(),
      candidates: (label: string) => (cardOf(label)?.identityCandidates ?? []).map((item) => mapped.label(item.id)).sort(),
      manual: (label: string) => (cardOf(label)?.identityManualListingIds ?? []).map((value) => mapped.label(value)).sort(),
    };
  };
  return { decide, read, sql, mapped };
}

test("Połącz: the operator links the 238 000 copies one by one into one card with every portal link; listings and price history are untouched", async () => {
  const { decide, read, sql } = await scenario(productionFactsRows());
  try {
    let view = await read();
    assert.equal(view.cards.length, 7, "nothing linked automatically with the production parameters");
    const before = structuredClone({ listings: view.fake.rows("listings"), snapshots: view.fake.rows("listing_snapshots"), memberships: view.fake.rows("listing_filter_matches") });
    await decide("link", "olx-238", "gratka-238");
    await decide("link", "olx-238", "nol-238");
    await decide("link", "olx-238", "otodom-238");
    view = await read();
    assert.deepEqual(view.members("olx-238"), ["gratka-238", "nol-238", "olx-238", "otodom-238"]);
    assert.deepEqual(view.sources("olx-238"), ["gratka:link", "nieruchomosci_online:link", "olx:link", "otodom:link"], "every source stays visible with its own link");
    assert.deepEqual(view.manual("olx-238"), ["gratka-238", "nol-238", "olx-238", "otodom-238"]);
    assert.deepEqual(view.candidates("olx-238"), [], "a linked copy is no longer offered as a possible duplicate");
    assert.equal(view.cards.length, 4);
    assert.deepEqual({ listings: view.fake.rows("listings"), snapshots: view.fake.rows("listing_snapshots"), memberships: view.fake.rows("listing_filter_matches") }, before);
  } finally { await sql.close(); }
});

test("decisions persist: a new scan with a changed price and a fresh read keep the manual group", async () => {
  const { decide, read, sql, mapped } = await scenario(productionFactsRows());
  try {
    await decide("link", "olx-298", "domy-298");
    const view = await read((tables) => {
      const domy = tables.listings.find((row) => row.id === mapped.id("domy-298"));
      if (domy) { domy.price = 295000; domy.last_seen_at = "2026-10-13T08:00:00Z"; }
      tables.listing_snapshots.push({ id: "snapshot-new", listing_id: mapped.id("domy-298"), price: 295000, captured_at: "2026-10-13T08:00:00Z", raw_data: {} });
    });
    assert.deepEqual(view.members("olx-298"), ["domy-298", "olx-298"]);
    assert.deepEqual(view.candidates("olx-298"), ["oferty-298"], "the remaining copy is still offered");
  } finally { await sql.close(); }
});

test("Rozłącz: unlinking a copy from the manual group shows it as its own card and remembers not to offer it again", async () => {
  const { decide, read, sql } = await scenario(productionFactsRows());
  try {
    await decide("link", "olx-238", "gratka-238");
    await decide("link", "olx-238", "otodom-238");
    await decide("unlink", "otodom-238");
    const view = await read();
    assert.deepEqual(view.members("olx-238"), ["gratka-238", "olx-238"]);
    assert.deepEqual(view.members("otodom-238"), ["otodom-238"], "the unlinked copy is still shown, never lost");
    assert.ok(!view.candidates("olx-238").includes("otodom-238"), "the durable not_link keeps it out of the possible duplicates");
    assert.ok(!view.candidates("otodom-238").includes("olx-238"));
  } finally { await sql.close(); }
});

test("Nie łącz: one decision removes the candidate from every copy of the card, and the other candidates stay", async () => {
  const { decide, read, sql } = await scenario(productionFactsRows());
  try {
    await decide("link", "olx-298", "oferty-298");
    await decide("not_link", "olx-298", "domy-298");
    const view = await read();
    assert.deepEqual(view.members("olx-298"), ["oferty-298", "olx-298"]);
    assert.deepEqual(view.candidates("olx-298"), [], "domy-298 is not offered again through oferty-298");
    assert.deepEqual(view.members("domy-298"), ["domy-298"]);
  } finally { await sql.close(); }
});

test("linking a possible duplicate to a card grouped by evidence keeps the whole card together", async () => {
  // Synthetic scenario: OLX, Gratka and Nieruchomości-online are linked by evidence; Otodom (empty description) is a possible duplicate.
  const tables = productionScenarioRows({ "otodom-238": { description: "", address: null } });
  const { decide, read, sql } = await scenario(tables);
  try {
    let view = await read();
    assert.deepEqual(view.members("olx-238"), ["gratka-238", "nol-238", "olx-238"]);
    assert.ok(view.candidates("olx-238").includes("otodom-238"));
    await decide("link", "olx-238", "otodom-238");
    view = await read();
    assert.deepEqual(view.members("olx-238"), ["gratka-238", "nol-238", "olx-238", "otodom-238"], "the card is not split into the manual pair and the evidence group");
    assert.deepEqual(view.manual("olx-238"), ["olx-238", "otodom-238"], "only the operator-linked copies can be unlinked from the group");
    await decide("not_link", "gratka-238", "olx-238");
    view = await read();
    assert.deepEqual(view.members("gratka-238"), ["gratka-238"], "an evidence-linked copy is separated with 'Nie łącz'");
    assert.deepEqual(view.members("olx-238"), ["nol-238", "olx-238", "otodom-238"]);
  } finally { await sql.close(); }
});
