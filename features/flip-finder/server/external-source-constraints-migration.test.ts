import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../../..");
const migrationPath = path.join(root, "supabase/migrations/20261002190000_allow_registered_external_sources.sql");
const registryPath = path.join(root, "features/flip-finder/server/search-source-registry.ts");
const foundationMigrationPath = path.join(root, "supabase/migrations/20260719113000_create_flip_finder_foundation.sql");
const morizonMigrationPath = path.join(root, "supabase/migrations/20260719130000_add_morizon_source.sql");
const resaleCompsMigrationPath = path.join(root, "supabase/migrations/20260905120000_create_resale_comps.sql");
const migration = fs.readFileSync(migrationPath, "utf8");

const EXISTING_SOURCES = ["otodom", "olx", "morizon", "facebook"] as const;
const REGISTERED_EXTERNAL_SOURCES = [
  "gratka",
  "nieruchomosci_online",
  "domiporta",
  "sprzedajemy",
  "adresowo",
  "oferty_net",
  "szybko",
  "bezposrednio",
  "domy",
  "allegro_lokalnie",
] as const;
const REGISTERED_OFFICIAL_SOURCES = ["official_cooperative", "official_uml", "official_auction"] as const;

function sourceValues(definition: string): Set<string> {
  return new Set([...definition.matchAll(/'([^']+)'/g)].map((match) => match[1]));
}

function sourceValuesAfter(sql: string, marker: string, endToken = ");"): Set<string> {
  const start = sql.indexOf(marker);
  assert.ok(start >= 0, `missing SQL marker: ${marker}`);
  const end = sql.indexOf(endToken, start);
  assert.ok(end >= 0, `missing end of SQL block: ${marker}`);
  return sourceValues(sql.slice(start, end));
}

function addedConstraintValues(constraint: string): Set<string> {
  return sourceValuesAfter(migration, `add constraint ${constraint}`);
}

test("the prepared migration preserves the exact existing source values and adds every registered source", () => {
  const foundation = fs.readFileSync(foundationMigrationPath, "utf8");
  const morizon = fs.readFileSync(morizonMigrationPath, "utf8");
  const resaleComps = fs.readFileSync(resaleCompsMigrationPath, "utf8");
  const expected = new Set([...EXISTING_SOURCES, ...REGISTERED_EXTERNAL_SOURCES, ...REGISTERED_OFFICIAL_SOURCES]);

  assert.deepEqual(sourceValuesAfter(morizon, "add constraint listings_source_check"), expectedWithoutExternalSources(), "listings_source_check baseline");
  assert.deepEqual(sourceValuesAfter(morizon, "add constraint source_scans_source_check"), expectedWithoutExternalSources(), "source_scans_source_check baseline");
  assert.deepEqual(sourceValuesAfter(resaleComps, "source text not null check", "),"), expectedWithoutExternalSources(), "resale_comps_source_check baseline");
  assert.match(foundation, /source text not null check \(source in \('otodom', 'olx', 'facebook'\)\)/i);

  for (const constraint of ["listings_source_check", "source_scans_source_check", "resale_comps_source_check"]) {
    assert.deepEqual(addedConstraintValues(constraint), expected, constraint);
  }
});

function expectedWithoutExternalSources(): Set<string> {
  return new Set(EXISTING_SOURCES);
}

test("the migration is schema-only and the runtime gate lists only locally complete adapters", () => {
  assert.match(migration, /^begin;[\s\S]*commit;\s*$/i);
  assert.doesNotMatch(migration, /\b(insert|update|delete|truncate)\b/i);
  assert.doesNotMatch(migration, /\bdrop\s+(?:table|column)\b/i);

  const registry = fs.readFileSync(registryPath, "utf8");
  assert.match(registry, /SCHEMA_READY_SOURCE_IDS\s*=\s*\[[\s\S]*"otodom"[\s\S]*"olx"[\s\S]*"morizon"[\s\S]*"domiporta"[\s\S]*"sprzedajemy"[\s\S]*"adresowo"[\s\S]*"szybko"[\s\S]*"domy"[\s\S]*"allegro_lokalnie"[\s\S]*\]/);
  const gateStart = registry.indexOf("SCHEMA_READY_SOURCE_IDS");
  const gateEnd = registry.indexOf("] as const", gateStart);
  assert.ok(gateStart >= 0 && gateEnd > gateStart, "missing schema-ready source gate");
  assert.doesNotMatch(registry.slice(gateStart, gateEnd), /official_uml/);
  for (const source of REGISTERED_EXTERNAL_SOURCES) {
    assert.match(migration, new RegExp(`['"]${source}['"]`));
  }
  for (const source of REGISTERED_OFFICIAL_SOURCES) {
    assert.match(migration, new RegExp(`['"]${source}['"]`));
  }
});
