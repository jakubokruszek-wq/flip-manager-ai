import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

test("automated watcher gates hard property and availability rejects before persistence", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "features/facebook-watcher/server.ts"), "utf8");
  const gateStart = source.indexOf("const automatedPropertyType = classifyFacebookPropertyType");
  const persistenceStart = source.indexOf("const supabase = createFacebookWatcherAdminClient();", gateStart);
  assert.ok(gateStart >= 0);
  assert.ok(persistenceStart > gateStart);
  const gate = source.slice(gateStart, persistenceStart);
  assert.match(gate, /automatedAvailability/);
  assert.match(gate, /ROOM/);
  assert.match(gate, /GARAGE/);
  assert.match(gate, /automatedAvailability !== "ACTIVE"/);
  assert.match(gate, /status: "skipped"/);
});

test("collector applies the same source hard-reject policy before canonical reconciliation", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "features/collector/facebook-import.ts"), "utf8");
  const start = source.indexOf("const hardSourceReject");
  const end = source.indexOf("const filters =", start);
  const policy = source.slice(start, end);
  assert.match(policy, /HOUSE/);
  assert.match(policy, /ROOM/);
  assert.match(policy, /GARAGE/);
  assert.match(policy, /availability !== "ACTIVE"/);
});
