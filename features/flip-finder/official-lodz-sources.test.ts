import assert from "node:assert/strict";
import test from "node:test";

import { classifyOfficialNotice, OFFICIAL_LODZ_SOURCES } from "./official-lodz-sources";

test("catalogue contains every requested Łódź cooperative and public source", () => {
  const ids = new Set(OFFICIAL_LODZ_SOURCES.map((source) => source.id));
  for (const id of ["sm-dabrowa", "sm-teofilow", "smtl", "sm-chojny", "sm-srodmiescie", "sm-karolew", "sm-retkinia-polnoc", "sm-retkinia-poludnie", "sm-radogoszcz-wschod", "uml-sale", "bip-uml-sale", "krk-licytacje", "syndic-public-notices"]) {
    assert.ok(ids.has(id), id);
  }
});

test("official notice classification excludes mixed commercial/works tenders", () => {
  const source = OFFICIAL_LODZ_SOURCES.find((item) => item.id === "sm-teofilow")!;
  assert.equal(classifyOfficialNotice("Przetarg na ustanowienie odrębnej własności lokalu mieszkalnego, 2 pokoje", source), "sale_candidate");
  assert.equal(classifyOfficialNotice("Konkurs ofert na malowanie klatek schodowych", source), "excluded");
  assert.equal(classifyOfficialNotice("Ogłoszenie bez rodzaju lokalu", source), "manual_review");
});

test("Mieszkanie za remont is always excluded as a rental program", () => {
  const source = OFFICIAL_LODZ_SOURCES.find((item) => item.id === "mieszkanie-za-remont")!;
  assert.equal(classifyOfficialNotice("Mieszkanie za remont — czynsz i kryteria najmu", source), "excluded");
});
