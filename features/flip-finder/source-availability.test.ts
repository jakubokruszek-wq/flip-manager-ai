import assert from "node:assert/strict";
import test from "node:test";

import { activeFilterSources, isActiveFilterSource, SCHEMA_READY_SOURCE_IDS } from "./source-availability.ts";
import type { ListingSource } from "./index.ts";

test("the active gate has only the locally verified Finder adapters", () => {
  assert.deepEqual(SCHEMA_READY_SOURCE_IDS, ["otodom", "olx", "morizon", "domiporta", "sprzedajemy", "adresowo", "gratka", "nieruchomosci_online", "oferty_net", "szybko", "domy", "allegro_lokalnie", "official_cooperative", "official_uml"]);
  assert.equal(isActiveFilterSource("facebook"), true);
  assert.equal(isActiveFilterSource("official_cooperative"), true);
  assert.equal(isActiveFilterSource("official_uml"), true);
  assert.equal(isActiveFilterSource("official_auction"), false);
});

test("legacy saved source IDs are retained in storage while blocked IDs stay out of active UI/scan sets", () => {
  const legacy: ListingSource[] = [
    "otodom", "facebook", "gratka", "nieruchomosci_online", "oferty_net", "szybko",
    "bezposrednio", "domy", "allegro_lokalnie", "official_cooperative", "official_uml", "official_auction",
  ];
  assert.deepEqual(activeFilterSources(legacy), ["otodom", "facebook", "gratka", "nieruchomosci_online", "oferty_net", "szybko", "domy", "allegro_lokalnie", "official_cooperative", "official_uml"]);
});
