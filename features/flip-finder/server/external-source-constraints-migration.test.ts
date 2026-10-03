import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../../..");
const migrationPath = path.join(root, "supabase/migrations/20261002190000_allow_registered_external_sources.sql");
const availabilityPath = path.join(root, "features/flip-finder/source-availability.ts");
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

test("the migration adds exactly the three canonical official sources to every current constraint", () => {
  const currentDefinitions = new Map([
    ["listings_source_check", sourceValuesAfter(fs.readFileSync(morizonMigrationPath, "utf8"), "add constraint listings_source_check")],
    ["source_scans_source_check", sourceValuesAfter(fs.readFileSync(morizonMigrationPath, "utf8"), "add constraint source_scans_source_check")],
    ["resale_comps_source_check", sourceValuesAfter(fs.readFileSync(resaleCompsMigrationPath, "utf8"), "source text not null check", "),")],
  ]);
  const expectedOfficialSources = new Set(REGISTERED_OFFICIAL_SOURCES);

  for (const [constraint, current] of currentDefinitions) {
    const migrated = addedConstraintValues(constraint);
    const officialSources = new Set([...migrated].filter((source) => source.startsWith("official_")));
    assert.deepEqual(officialSources, expectedOfficialSources, `${constraint} must contain exactly the canonical official source IDs`);
    for (const source of current) {
      assert.ok(migrated.has(source), `${constraint} must preserve existing source ${source}`);
    }
  }
});

function expectedWithoutExternalSources(): Set<string> {
  return new Set(EXISTING_SOURCES);
}

test("the migration is schema-only and the runtime gate lists only locally complete adapters", () => {
  assert.match(migration, /^begin;[\s\S]*commit;\s*$/i);
  assert.doesNotMatch(migration, /\b(insert|update|delete|truncate)\b/i);
  assert.doesNotMatch(migration, /\bdrop\s+(?:table|column)\b/i);

  const availability = fs.readFileSync(availabilityPath, "utf8");
  assert.match(availability, /SCHEMA_READY_SOURCE_IDS\s*=\s*\[[\s\S]*"otodom"[\s\S]*"olx"[\s\S]*"morizon"[\s\S]*"domiporta"[\s\S]*"sprzedajemy"[\s\S]*"adresowo"[\s\S]*\]/);
  const gateStart = availability.indexOf("SCHEMA_READY_SOURCE_IDS");
  const gateEnd = availability.indexOf("] as const", gateStart);
  assert.ok(gateStart >= 0 && gateEnd > gateStart, "missing schema-ready source gate");
  assert.doesNotMatch(availability.slice(gateStart, gateEnd), /official_uml/);
  assert.doesNotMatch(availability.slice(gateStart, gateEnd), /"bezposrednio"/);
  const registry = fs.readFileSync(path.join(root, "features/flip-finder/server/search-source-registry.ts"), "utf8");
  assert.match(registry, /bezposrednio:\s*"access_limited_without_authentication"/);
  assert.match(registry, /szybko:\s*"public_html_adapter"/);
  assert.match(registry, /oferty_net:\s*"public_html_adapter"/);
  for (const source of REGISTERED_EXTERNAL_SOURCES) {
    assert.match(migration, new RegExp(`['"]${source}['"]`));
  }
  for (const source of REGISTERED_OFFICIAL_SOURCES) {
    assert.match(migration, new RegExp(`['"]${source}['"]`));
  }
});
