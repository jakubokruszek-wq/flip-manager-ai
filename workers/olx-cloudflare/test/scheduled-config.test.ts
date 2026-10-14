/**
 * The unattended production Worker: separate from stage 2, disabled as
 * committed, scheduled mode with the reviewed limits, a 15-minute Cron.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { loadCloudConfig } from "../src/config.ts";

const read = (name: string) => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
const vars = (toml: string) => Object.fromEntries([...toml.slice(toml.indexOf("[vars]")).matchAll(/^([A-Z0-9_]+)\s*=\s*"([^"]*)"/gm)].map((match) => [match[1], match[2]]));
const scheduled = read("wrangler.scheduled.toml");
const stage2 = read("wrangler.stage2.toml");

test("own Worker name; stage 2 stays the manual, cron-less, disabled test Worker", () => {
  const toplevel = scheduled.slice(0, scheduled.search(/^\[/m));
  assert.deepEqual([...toplevel.matchAll(/^name\s*=\s*"([^"]+)"/gm)].map((match) => match[1]), ["flip-manager-olx-cloud-scheduled"]);
  assert.doesNotMatch(scheduled, /^\[env\.|^routes?\s*=|^\[\[routes\]\]/m);
  assert.equal(vars(stage2).OLX_CLOUD_ENABLED, "0");
  assert.equal(vars(stage2).OLX_CLOUD_CLAIM_MODE, "manual");
  assert.doesNotMatch(stage2, /^\[triggers\]/m);
});

test("committed vars: OFF, scheduled, 2 jobs/day (budget-gated), 1 held, 1 per invocation, 120 s budget, leave_queued, no secrets", () => {
  const v = vars(scheduled);
  assert.equal(v.OLX_CLOUD_ENABLED, "0");
  assert.equal(v.OLX_CLOUD_CLAIM_MODE, "scheduled");
  assert.equal(v.OLX_CLOUD_MAX_JOBS_PER_DAY, "2");
  assert.equal(v.OLX_CLOUD_MAX_HELD_JOBS, "1");
  assert.equal(v.OLX_CLOUD_MAX_JOBS_PER_INVOCATION, "1");
  assert.equal(v.OLX_CLOUD_SAFE_BROWSER_BUDGET_SECONDS, "120");
  assert.equal(v.OLX_CLOUD_DAILY_BROWSER_LIMIT_SECONDS, "600");
  assert.equal(v.OLX_CLOUD_ON_BUDGET_EXHAUSTED, "leave_queued");
  assert.equal(v.OLX_CLOUD_REFUSAL_PAUSE_THRESHOLD, "1");
  assert.equal(v.OLX_CLOUD_WORKER_ID, "cloudflare-olx-scheduled");
  for (const key of Object.keys(v)) assert.doesNotMatch(key, /SECRET|TOKEN/);
  for (const key of Object.keys(v)) assert.equal([...scheduled.matchAll(new RegExp(`^${key}\\s*=`, "gm"))].length, 1, `${key} exactly once`);
  assert.match(scheduled, /^\[triggers\]\ncrons = \["\*\/15 \* \* \* \*"\]$/m);
});

test("bindings, migrations and build match the main Worker (only vars and triggers differ)", () => {
  const body = (toml: string) => toml.slice(toml.indexOf("main ="), toml.indexOf("[vars]"))
    .replace(/^\[triggers\][\s\S]*?(?=^\[)/m, "")
    .split("\n").filter((line) => line.trim() && !line.trim().startsWith("#")).join("\n");
  assert.equal(body(scheduled), body(read("wrangler.toml")));
});

test("as committed it never loads a runnable config; enabled it is scheduled mode", () => {
  const secret = { OLX_WORKER_SECRET: "x".repeat(40) };
  const disabled = loadCloudConfig({ ...vars(scheduled), ...secret });
  assert.equal(!disabled.ok && disabled.code, "OLX_CLOUD_DISABLED");
  const enabled = loadCloudConfig({ ...vars(scheduled), ...secret, OLX_CLOUD_ENABLED: "1" });
  assert.ok(enabled.ok);
  assert.equal(enabled.config.claimMode, "scheduled");
});

test("workflow: manual only, main only, confirmed enable, no /run-once, STOP always available", () => {
  const workflow = readFileSync(new URL("../../../.github/workflows/olx-cloudflare-scheduled.yml", import.meta.url), "utf8");
  assert.match(workflow, /^on:\n  workflow_dispatch:/m);
  assert.doesNotMatch(workflow, /^\s+schedule:/m, "GitHub Actions never drives OLX");
  assert.match(workflow, /options: \[check, deploy-disabled, enable, disable\]/);
  assert.match(workflow, /\[ "\$CONFIRM" = "WLACZ-AUTOMAT-OLX" \]/);
  assert.match(workflow, /\[ "\$GITHUB_REF" = "refs\/heads\/main" \]/);
  const commands = workflow.split("\n").filter((line) => !line.trim().startsWith("#")).join("\n");
  assert.doesNotMatch(commands, /run-once/, "no manual run of the unattended Worker");
  assert.doesNotMatch(workflow, /STAGE2|stage2\.toml/, "never touches the stage-2 test Worker");
  assert.match(workflow, /--var OLX_CLOUD_ENABLED:1/);
  assert.match(workflow, /failure\(\) && inputs\.action == 'enable'/, "an unconfirmed enable is rolled back to disabled");
  assert.doesNotMatch(workflow, /echo "\$\{?(ADMIN_TOKEN|WORKER_SECRET|CLOUDFLARE_API_TOKEN)/, "no secret is printed");
});
