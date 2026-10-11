import assert from "node:assert/strict";
import test from "node:test";

import { activeFilterSources, DISABLED_SOURCE_IDS, isActiveFilterSource, isDisabledSource, SCHEMA_READY_SOURCE_IDS } from "./source-availability.ts";
import type { ListingSource } from "./index.ts";

test("the active gate has only the locally verified Finder adapters", () => {
  assert.deepEqual(SCHEMA_READY_SOURCE_IDS, ["otodom", "olx", "morizon", "domiporta", "sprzedajemy", "adresowo", "gratka", "nieruchomosci_online", "oferty_net", "domy", "allegro_lokalnie", "official_cooperative", "official_uml"]);
  assert.equal(isActiveFilterSource("facebook"), true);
  assert.equal(isActiveFilterSource("official_cooperative"), true);
  assert.equal(isActiveFilterSource("official_uml"), true);
  assert.equal(isActiveFilterSource("official_auction"), false);
});

test("szybko.pl is deliberately disabled everywhere -- not merely unlisted", () => {
  assert.deepEqual(DISABLED_SOURCE_IDS, ["szybko"]);
  assert.equal(isDisabledSource("szybko"), true);
  assert.equal(isActiveFilterSource("szybko"), false, "a disabled source must never be active, even though its ID stays recognized");
  assert.equal(SCHEMA_READY_SOURCE_IDS.includes("szybko" as (typeof SCHEMA_READY_SOURCE_IDS)[number]), false);
  for (const source of SCHEMA_READY_SOURCE_IDS) assert.equal(isDisabledSource(source), false, `${source} must not be flagged disabled`);
});

test("legacy saved source IDs are retained in storage while blocked or disabled IDs stay out of active UI/scan sets", () => {
  const legacy: ListingSource[] = [
    "otodom", "facebook", "gratka", "nieruchomosci_online", "oferty_net", "szybko",
    "bezposrednio", "domy", "allegro_lokalnie", "official_cooperative", "official_uml", "official_auction",
  ];
  assert.deepEqual(activeFilterSources(legacy), ["otodom", "facebook", "gratka", "nieruchomosci_online", "oferty_net", "domy", "allegro_lokalnie", "official_cooperative", "official_uml"]);
});
