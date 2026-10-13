/**
 * The stage-2 Worker: a separate Worker, disabled and cron-less by default,
 * limited to one job per day and per invocation with a 120 s browser budget.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { loadCloudConfig } from "../src/config.ts";

const read = (name: string) => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
const vars = (toml: string) => Object.fromEntries([...toml.slice(toml.indexOf("[vars]")).matchAll(/^([A-Z0-9_]+)\s*=\s*"([^"]*)"/gm)].map((match) => [match[1], match[2]]));
const stage2 = read("wrangler.stage2.toml");

test("stage-2 Worker has its own name and never targets the production or stage-1 Worker", () => {
  const toplevel = stage2.slice(0, stage2.search(/^\[/m));
  assert.deepEqual([...toplevel.matchAll(/^name\s*=\s*"([^"]+)"/gm)].map((match) => match[1]), ["flip-manager-olx-cloud-stage2"]);
  assert.doesNotMatch(stage2, /^name = "flip-manager-olx-cloud(-stage1)?"$/m);
  assert.doesNotMatch(stage2, /^\[env\.|^routes?\s*=|^\[\[routes\]\]/m);
});

test("no Cron Trigger and nothing that could claim on its own", () => {
  assert.doesNotMatch(stage2, /^\[triggers\]/m);
  assert.doesNotMatch(stage2, /^crons\s*=/m);
});

test("initial vars: disabled, manual, 1 job/day, 1 job/invocation, 1 held job, 120 s safe budget, no secrets", () => {
  const v = vars(stage2);
  assert.equal(v.OLX_CLOUD_ENABLED, "0");
  assert.equal(v.OLX_CLOUD_CLAIM_MODE, "manual");
  assert.equal(v.OLX_CLOUD_MAX_JOBS_PER_DAY, "1", "0 would mean NO limit");
  assert.equal(v.OLX_CLOUD_MAX_JOBS_PER_INVOCATION, "1");
  assert.equal(v.OLX_CLOUD_MAX_HELD_JOBS, "1");
  assert.equal(v.OLX_CLOUD_SAFE_BROWSER_BUDGET_SECONDS, "120");
  assert.equal(v.OLX_CLOUD_ON_BUDGET_EXHAUSTED, "leave_queued");
  assert.equal(v.OLX_CLOUD_WORKER_ID, "cloudflare-olx-stage2");
  assert.equal(v.OLX_CLOUD_LISTING_ID_MODE, "legacy");
  assert.equal(v.OLX_CLOUD_STAGE1_LOCK, undefined);
  for (const key of Object.keys(v)) assert.doesNotMatch(key, /SECRET|TOKEN/, `${key} must be a Cloudflare secret, not a var`);
  for (const key of ["OLX_CLOUD_ENABLED", "OLX_CLOUD_CLAIM_MODE", "OLX_CLOUD_MAX_JOBS_PER_DAY"]) {
    assert.equal([...stage2.matchAll(new RegExp(`^${key}\\s*=`, "gm"))].length, 1, `${key} exactly once`);
  }
});

test("bindings, migrations and build match the main Worker config (only vars and triggers differ)", () => {
  const body = (toml: string) => toml.slice(toml.indexOf("main ="), toml.indexOf("[vars]"))
    .replace(/^\[triggers\][\s\S]*?(?=^\[)/m, "")
    .split("\n").filter((line) => line.trim() && !line.trim().startsWith("#")).join("\n");
  assert.equal(body(stage2), body(read("wrangler.toml")));
});

test("as deployed (disabled) it never loads a runnable config; enabled for one run it is manual with the stage-2 limits", () => {
  const secret = { OLX_WORKER_SECRET: "x".repeat(40) };
  const disabled = loadCloudConfig({ ...vars(stage2), ...secret });
  assert.equal(disabled.ok, false);
  assert.equal(!disabled.ok && disabled.code, "OLX_CLOUD_DISABLED");
  const enabled = loadCloudConfig({ ...vars(stage2), ...secret, OLX_CLOUD_ENABLED: "1" });
  assert.ok(enabled.ok);
  assert.equal(enabled.config.claimMode, "manual");
  assert.equal(enabled.config.maxJobsPerDay, 1);
  assert.equal(enabled.config.maxJobsPerInvocation, 1);
  assert.equal(enabled.config.safeBrowserBudgetMs, 120_000);
  assert.equal(enabled.config.listingIdPolicy, "legacy");
});
