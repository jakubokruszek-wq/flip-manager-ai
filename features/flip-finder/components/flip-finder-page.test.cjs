const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const page = fs.readFileSync(path.join(__dirname, "flip-finder-page.tsx"), "utf8");

test("normal Flip Finder UI uses the queue scan result funnel", () => {
  assert.match(page, /WYNIK SKANU/);
  assert.match(page, /Zebrane posty/);
  assert.match(page, /Zweryfikowane EXACT/);
  assert.match(page, /SELL_PROPERTY/);
  assert.match(page, /ODRZUCONE/);
  assert.match(page, /Szczegóły diagnostyczne/);
  assert.doesNotMatch(page, /onClick=\{\(\) => void validateCollector\(activeFilter\)\}/);
  assert.doesNotMatch(page, /onClick=\{\(\) => void testDirectExternalChannel\(\)\}/);
  assert.doesNotMatch(page, /\{collectorValidation \? <CollectorValidationPanel/);
  assert.doesNotMatch(page, /\{externalPingResult \? <div/);
});
