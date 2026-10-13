/**
 * The stage-1 Worker is a separate Worker that can never claim, and otherwise
 * mirrors the production configuration so stage 1 verifies the same code paths.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { checkCloudConfig, loadCloudConfig } from "../src/config.ts";

const read = (name: string) => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
const vars = (toml: string) => Object.fromEntries([...toml.slice(toml.indexOf("[vars]")).matchAll(/^([A-Z0-9_]+)\s*=\s*"([^"]*)"/gm)].map((match) => [match[1], match[2]]));

test("stage-1 Worker has its own name and never targets the existing flip-manager-olx-cloud Worker", () => {
  const stage1 = read("wrangler.stage1.toml");
  assert.match(stage1, /^name = "flip-manager-olx-cloud-stage1"$/m);
  assert.doesNotMatch(stage1, /^name = "flip-manager-olx-cloud"$/m);
  assert.match(read("wrangler.toml"), /^name = "flip-manager-olx-cloud"$/m);
});

test("stage-1 Worker is locked, disabled and manual; everything else mirrors wrangler.toml", () => {
  const stage1 = vars(read("wrangler.stage1.toml"));
  const production = vars(read("wrangler.toml"));
  assert.equal(stage1.OLX_CLOUD_STAGE1_LOCK, "1");
  assert.equal(stage1.OLX_CLOUD_ENABLED, "0");
  assert.equal(stage1.OLX_CLOUD_CLAIM_MODE, "manual");
  assert.equal(production.OLX_CLOUD_ENABLED, "0");
  assert.equal(production.OLX_CLOUD_CLAIM_MODE, "manual");
  for (const [key, value] of Object.entries(production)) {
    if (key === "OLX_CLOUD_WORKER_ID") continue;
    assert.equal(stage1[key], value, `${key} differs between wrangler.toml and wrangler.stage1.toml`);
  }
  const strip = (toml: string) => toml.slice(toml.indexOf("main ="), toml.indexOf("[vars]")).split("\n").filter((line) => line.trim() && !line.trim().startsWith("#")).join("\n");
  assert.equal(strip(read("wrangler.stage1.toml")), strip(read("wrangler.toml")), "bindings, migrations, build and triggers match");
});

test("the stage-1 lock wins over OLX_CLOUD_ENABLED=1, while configuration checks still run", () => {
  const environment = { ...vars(read("wrangler.stage1.toml")), OLX_CLOUD_ENABLED: "1", OLX_CLOUD_CLAIM_MODE: "auto", OLX_WORKER_SECRET: "x".repeat(40) };
  const loaded = loadCloudConfig(environment);
  assert.equal(loaded.ok, false);
  assert.equal(!loaded.ok && loaded.code, "OLX_CLOUD_STAGE1_LOCKED");
  const check = checkCloudConfig(environment);
  assert.equal(check.stage1Lock, true);
  assert.equal(check.valid, true);
});
