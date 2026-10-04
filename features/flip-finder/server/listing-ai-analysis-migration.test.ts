import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

/**
 * Real, database-level schema-compatibility check for the DRAFT
 * listing_ai_analysis migration (supabase/migrations/
 * 20261004040000_add_listing_ai_analysis.sql -- not applied anywhere,
 * including here: PGlite is a throwaway, in-memory engine, not Supabase/
 * Production). Runs the ACTUAL migration SQL on top of the real listings
 * foundation table, proving the FK, unique constraint, jsonb-object check
 * constraints, and updated_at trigger behave as
 * listing-ai-analysis.ts assumes, before a human ever applies it for real.
 */

function extractBlock(sql: string, startMarker: string, endMarker: string): string {
  const start = sql.indexOf(startMarker);
  assert.ok(start >= 0, `marker not found: ${startMarker}`);
  const end = sql.indexOf(endMarker, start);
  assert.ok(end >= 0, `end marker not found: ${endMarker}`);
  return sql.slice(start, end + endMarker.length);
}

async function freshDb(): Promise<PGlite> {
  const db = new PGlite();
  const foundation = fs.readFileSync(path.join(process.cwd(), "supabase/migrations/20260719113000_create_flip_finder_foundation.sql"), "utf8");
  const draft = fs.readFileSync(path.join(process.cwd(), "supabase/migrations/20261004040000_add_listing_ai_analysis.sql"), "utf8");

  await db.exec(extractBlock(
    foundation,
    "create table if not exists public.listings (",
    "create index if not exists listings_city_district_idx\n  on public.listings (city, district);",
  ));
  await db.exec(extractBlock(draft, "create table if not exists public.listing_ai_analysis (", "for each row execute function public.set_listing_ai_analysis_updated_at();"));

  return db;
}

async function insertListing(db: PGlite, externalId: string): Promise<string> {
  const result = await db.query<{ id: string }>(
    `insert into public.listings (source, external_listing_id, original_url, images) values ($1, $2, $3, $4) returning id`,
    ["otodom", externalId, `https://otodom.pl/oferta/${externalId}`, JSON.stringify([])],
  );
  return (result.rows[0] as { id: string }).id;
}

test("the exact upsert shape listing-ai-analysis.ts sends is schema-compatible with the real draft migration", async () => {
  const db = await freshDb();
  const listingId = await insertListing(db, "offer-1");
  const result = await db.query(
    `insert into public.listing_ai_analysis (listing_id, content_hash, images_hash, model, text_findings, photo_findings)
     values ($1, $2, $3, $4, $5, $6) returning *`,
    [listingId, "hash-abc", "img-hash-1", "gpt-6-luna", JSON.stringify({ buildingTypeHint: "blok" }), JSON.stringify({ visibleCondition: "do remontu" })],
  );
  const row = result.rows[0] as Record<string, unknown>;
  assert.equal(row.content_hash, "hash-abc");
  assert.equal(row.model, "gpt-6-luna");
  assert.ok(row.created_at);
  assert.ok(row.updated_at);
});

test("a second row for the SAME listing_id is rejected by the unique constraint -- exactly one cached analysis per listing", async () => {
  const db = await freshDb();
  const listingId = await insertListing(db, "offer-2");
  const insertOnce = () => db.query(
    `insert into public.listing_ai_analysis (listing_id, content_hash, model) values ($1, $2, $3)`,
    [listingId, "hash-1", "gpt-6-luna"],
  );
  await insertOnce();
  await assert.rejects(insertOnce, (error: unknown) => {
    assert.match((error as Error).message, /listing_ai_analysis_listing_id_key/);
    return true;
  });
});

test("the upsert-on-conflict(listing_id) pattern listing-ai-analysis.ts relies on actually replaces the row instead of erroring", async () => {
  const db = await freshDb();
  const listingId = await insertListing(db, "offer-3");
  await db.query(`insert into public.listing_ai_analysis (listing_id, content_hash, model, text_findings) values ($1, $2, $3, $4)`, [listingId, "hash-old", "gpt-6-luna", JSON.stringify({ old: true })]);
  await db.query(
    `insert into public.listing_ai_analysis (listing_id, content_hash, model, text_findings)
     values ($1, $2, $3, $4)
     on conflict (listing_id) do update set content_hash = excluded.content_hash, text_findings = excluded.text_findings`,
    [listingId, "hash-new", "gpt-6-luna", JSON.stringify({ old: false })],
  );
  const result = await db.query(`select content_hash, text_findings from public.listing_ai_analysis where listing_id = $1`, [listingId]);
  assert.equal(result.rows.length, 1, "upsert must replace, never duplicate, the one row for this listing");
  assert.equal((result.rows[0] as Record<string, unknown>).content_hash, "hash-new");
});

test("deleting the parent listing cascades and removes its cached analysis", async () => {
  const db = await freshDb();
  const listingId = await insertListing(db, "offer-4");
  await db.query(`insert into public.listing_ai_analysis (listing_id, content_hash, model) values ($1, $2, $3)`, [listingId, "hash-1", "gpt-6-luna"]);
  await db.query(`delete from public.listings where id = $1`, [listingId]);
  const result = await db.query(`select id from public.listing_ai_analysis where listing_id = $1`, [listingId]);
  assert.equal(result.rows.length, 0);
});

test("a non-object text_findings value is rejected by the real check constraint", async () => {
  const db = await freshDb();
  const listingId = await insertListing(db, "offer-5");
  await assert.rejects(
    () => db.query(`insert into public.listing_ai_analysis (listing_id, content_hash, model, text_findings) values ($1, $2, $3, $4)`, [listingId, "hash-1", "gpt-6-luna", JSON.stringify(["not", "an", "object"])]),
    (error: unknown) => {
      assert.match((error as Error).message, /listing_ai_analysis_text_findings_object/);
      return true;
    },
  );
});

test("the updated_at trigger fires on UPDATE", async () => {
  const db = await freshDb();
  const listingId = await insertListing(db, "offer-6");
  const inserted = await db.query(`insert into public.listing_ai_analysis (listing_id, content_hash, model) values ($1, $2, $3) returning updated_at`, [listingId, "hash-1", "gpt-6-luna"]);
  const originalUpdatedAt = (inserted.rows[0] as Record<string, unknown>).updated_at;
  await new Promise((resolve) => setTimeout(resolve, 5));
  const updated = await db.query(`update public.listing_ai_analysis set content_hash = $1 where listing_id = $2 returning updated_at`, ["hash-2", listingId]);
  assert.notEqual((updated.rows[0] as Record<string, unknown>).updated_at, originalUpdatedAt);
});
