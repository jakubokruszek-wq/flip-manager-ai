import assert from "node:assert/strict";
import test from "node:test";
import { constructionYear, constructionYearFromSource } from "./construction-year.ts";

test("only explicit own construction facts supply a building year", () => {
  assert.equal(constructionYearFromSource({ itemOffered: { yearBuilt: "1930" } }), 1930);
  assert.equal(constructionYearFromSource({ additionalProperty: [{ name: "Rok budowy", value: 1960 }] }), 1960);
  assert.equal(constructionYearFromSource({}, "Rok budowy: 1930\nRemont 2025"), 1930);
  assert.equal(constructionYearFromSource({ yearBuilt: 1960 }, "Rok budowy: 1930"), 1960);
  for (const description of ["Remont w 1930 roku", "Opublikowano 1930", "Obok szkoła, rok budowy: 1930"]) {
    assert.equal(constructionYearFromSource({}, description), null);
  }
  assert.equal(constructionYearFromSource({ similarProperties: [{ yearBuilt: 1930 }] }), null);
  assert.equal(constructionYearFromSource({ yearBuilt: 1930, constructionYear: 1960 }), null);
  for (const value of [1699, 2101, 1930.5, "1930 m²", "2026-11-12"]) assert.equal(constructionYear(value), null);
});
