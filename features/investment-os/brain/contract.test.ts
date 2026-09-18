import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), "utf8");
const BRAIN_SOURCE_FILES = ["types.ts", "dependency-graph.ts", "director-rules.ts", "conflict-engine.ts", "question-engine.ts", "ceo-synthesis.ts", "coordination.ts", "index.ts"].map((file) => `features/investment-os/brain/${file}`);

test("Deal Room Brain V1 issues zero POST/PUT/PATCH/DELETE calls and performs no network or database access", () => {
  for (const file of BRAIN_SOURCE_FILES) {
    const source = read(file);
    assert.doesNotMatch(source, /fetch\(/, `${file} must not call fetch`);
    assert.doesNotMatch(source, /\/api\//, `${file} must not reference an API route`);
    assert.doesNotMatch(source, /method:\s*["'](POST|PUT|PATCH|DELETE)["']/i, `${file} must not construct a mutating request`);
    assert.doesNotMatch(source, /supabase/i, `${file} must not talk to the database directly`);
  }
});

test("Deal Room Brain V1 is deterministic: no wall-clock or random source inside the module", () => {
  for (const file of BRAIN_SOURCE_FILES) {
    const source = read(file);
    assert.doesNotMatch(source, /Date\.now\(\)/, `${file} must not read the wall clock`);
    assert.doesNotMatch(source, /Math\.random\(\)/, `${file} must not use randomness`);
  }
});

test("buildDealBrain is only ever invoked from a read path, never wired into a mutating route", () => {
  const dealRoomView = read("features/investment-os/components/deal-room-view.tsx");
  assert.match(dealRoomView, /buildDealBrain\(deal\)/);
  assert.doesNotMatch(dealRoomView, /fetch\(|\/api\//);
  const initializeRoute = read("app/api/flip-finder/listings/[id]/investment/initialize/route.ts");
  const overridesRoute = read("app/api/flip-finder/listings/[id]/investment/route.ts");
  assert.doesNotMatch(initializeRoute, /brain/i);
  assert.doesNotMatch(overridesRoute, /brain/i);
});
