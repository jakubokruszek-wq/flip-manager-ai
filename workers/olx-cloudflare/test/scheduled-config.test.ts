/**
 * The unattended production Worker: separate from stage 2, disabled as
 * committed, scheduled mode with the reviewed limits, a 15-minute Cron.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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

test("bindings, migrations and build match the main Worker (only vars, triggers and the immediate DO update differ)", () => {
  const body = (toml: string) => toml.slice(toml.indexOf("main ="), toml.indexOf("[vars]"))
    .replace(/^\[triggers\][\s\S]*?(?=^\[)/m, "")
    .replace(/^\[durable_objects\.code_update_strategy\]\nmode = "immediate"\n/m, "")
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
  assert.doesNotMatch(commands, /stage2\.toml|olx-cloud-stage2|--name\b|--env\b/, "never deploys, configures or calls the stage-2 test Worker");
  assert.match(workflow, /--var OLX_CLOUD_ENABLED:1/);
  assert.match(workflow, /failure\(\) && inputs\.action == 'enable'/, "an unconfirmed enable is rolled back to disabled");
  assert.doesNotMatch(workflow, /echo "\$\{?(ADMIN_TOKEN|WORKER_SECRET|CLOUDFLARE_API_TOKEN)/, "no secret is printed");
});

test("workflow secrets: stage-2 VALUES may be reused as fallbacks, *_SCHEDULED wins, admin token stays separate and required", () => {
  const workflow = readFileSync(new URL("../../../.github/workflows/olx-cloudflare-scheduled.yml", import.meta.url), "utf8");
  const commands = workflow.split("\n").filter((line) => !line.trim().startsWith("#")).join("\n");
  const values = (name: string) => [...commands.matchAll(new RegExp(`^\\s+${name}: (.+)$`, "gm"))].map((match) => match[1]);

  // Only these two stage-2 secrets may be read, and only as a fallback after the scheduled one.
  assert.deepEqual([...new Set([...commands.matchAll(/secrets\.([A-Z0-9_]*STAGE2)\b/g)].map((match) => match[1]))].sort(),
    ["CLOUDFLARE_API_TOKEN_STAGE2", "OLX_WORKER_SECRET_STAGE2"]);
  assert.doesNotMatch(commands, /OLX_CLOUD_ADMIN_TOKEN_STAGE2/, "the admin token of stage 2 is never used");
  const apiTokens = values("CLOUDFLARE_API_TOKEN");
  assert.ok(apiTokens.length >= 4);
  for (const value of apiTokens) assert.equal(value, "${{ secrets.CLOUDFLARE_API_TOKEN_SCHEDULED || secrets.CLOUDFLARE_API_TOKEN_STAGE2 }}");
  const workerSecrets = values("WORKER_SECRET");
  assert.ok(workerSecrets.length >= 2);
  for (const value of workerSecrets) assert.equal(value, "${{ secrets.OLX_WORKER_SECRET_SCHEDULED || secrets.OLX_WORKER_SECRET_STAGE2 }}");
  const adminTokens = values("ADMIN_TOKEN");
  assert.ok(adminTokens.length >= 4);
  for (const value of adminTokens) assert.equal(value, "${{ secrets.OLX_CLOUD_ADMIN_TOKEN_SCHEDULED }}", "no fallback for the admin token");
  assert.match(commands, /\[ "\$\{#ADMIN_TOKEN\}" -ge 32 \] \|\| \{ echo "::error::Brak lub zbyt krótki OLX_CLOUD_ADMIN_TOKEN_SCHEDULED"; exit 1; \}/, "admin token required for every action");
  for (const value of values("CLOUDFLARE_ACCOUNT_ID")) assert.equal(value, "${{ secrets.CLOUDFLARE_ACCOUNT_ID }}");

  // Whatever token is used, every wrangler command targets only the scheduled Worker's config.
  const wrangler = commands.split("\n").filter((line) => /wrangler (deploy|secret)/.test(line));
  assert.ok(wrangler.length >= 6);
  for (const line of wrangler) assert.match(line, /--config "\$SCHEDULED_CONFIG"/, line);
  assert.match(commands, /^  SCHEDULED_CONFIG: wrangler\.scheduled\.toml$/m);
  assert.match(commands, /^  SCHEDULED_NAME: flip-manager-olx-cloud-scheduled$/m);
  for (const url of commands.match(/https:\/\/[^\s"']+/g) ?? []) assert.match(url, /^https:\/\/flip-manager-olx-cloud-scheduled\./, url);
});

test("workflow tests: root deps (playwright) and Chromium installed before npm test; skipped Chromium tests fail the run", () => {
  const workflow = readFileSync(new URL("../../../.github/workflows/olx-cloudflare-scheduled.yml", import.meta.url), "utf8");
  const at = (pattern: RegExp) => { const index = workflow.search(pattern); assert.ok(index >= 0, String(pattern)); return index; };
  const rootInstall = at(/working-directory: \.\n\s+run: npm ci --no-audit --no-fund/);
  const chromium = at(/working-directory: \.\n\s+run: npx playwright install --with-deps chromium/);
  const workerInstall = at(/- name: Instalacja zależności Workera\n(?:.*\n)*?\s+run: npm ci --no-audit --no-fund/);
  const tests = at(/npm test 2>&1 \| tee test\.log/);
  assert.ok(rootInstall < chromium && chromium < workerInstall && workerInstall < tests, "root npm ci -> Chromium -> worker npm ci -> npm test");
  assert.match(workflow, /grep -Eq '\^# fail 0\$' test\.log/);
  assert.match(workflow, /grep -Eq '\^# skipped 0\$' test\.log/, "Chromium tests skip themselves without a browser; that must fail the run");
  assert.ok(tests < at(/npx wrangler deploy --dry-run/), "tests before the dry-run and any deploy");
});

test("activation (runs 38606455224, 38607086215): immediate Durable Object update; every deploy proven by deployment, var and served version; no \"any\"", () => {
  const workflow = readFileSync(new URL("../../../.github/workflows/olx-cloudflare-scheduled.yml", import.meta.url), "utf8");
  const commands = workflow.split("\n").filter((line) => !line.trim().startsWith("#")).join("\n");
  // The wrangler default is a DEFERRED Durable Object code update (up to 300 s): the old version kept serving.
  assert.match(scheduled, /^\[durable_objects\.code_update_strategy\]\nmode = "immediate"$/m);
  assert.match(commands, /durable_objects\\\.code_update_strategy/, "the workflow's config check requires it too");
  assert.doesNotMatch(commands, /"\$STATUS" wait \w+ any\b/, "a wait is always for one exact version");
  assert.doesNotMatch(commands, /version=any/);
  for (const call of commands.match(/"\$STATUS" wait (?:enabled|disabled) [^ ]+ \d+ \d+/g) ?? []) {
    const [, , , , attempts, pause] = call.split(" ");
    if (Number(attempts) > 1) assert.ok(Number(attempts) * Number(pause) >= 300, `${call}: must outlast a 300 s deferral`);
  }
  const step = (name: string) => { const start = commands.indexOf(`- name: ${name}`); assert.ok(start >= 0, name); const end = commands.indexOf("\n      - ", start + 1); return commands.slice(start, end < 0 ? undefined : end); };
  const order = (text: string, ...parts: string[]) => { let at = -1; for (const part of parts) { const next = text.indexOf(part, at + 1); assert.ok(next > at, `${part} after the previous proof`); at = next; } };

  order(step("Włączenie automatu"), "wrangler deploy --config \"$SCHEDULED_CONFIG\" --var OLX_CLOUD_ENABLED:1", "deploy-version enable.log",
    "wrangler deployments status --json", "\"$STATUS\" deployment \"$version\"", "wrangler versions view \"$version\" --json",
    "\"$STATUS\" var version.json OLX_CLOUD_ENABLED 1", "\"$STATUS\" wait enabled \"$version\"");
  order(step("Sekrety Workera (tylko w nim)"), "wrangler secret put OLX_WORKER_SECRET", "wrangler deployments status --json", "active-version deployment.json");
  order(step("Weryfikacja stanu wyłączonego"), "\"$STATUS\" deployment \"$VERSION\"", "\"$STATUS\" var version.json OLX_CLOUD_ENABLED 0", "\"$STATUS\" wait disabled \"$VERSION\"");
  order(step("Sprawdzenie stanu, budżetu i połączenia"), "active-version deployment-before.json", "\"$STATUS\" wait disabled \"$active\"");
  // The automatic rollback is confirmed like any other deploy, and never silently.
  order(step("Wyłącz, jeśli włączenie nie zostało potwierdzone"), "wrangler deploy --config \"$SCHEDULED_CONFIG\" | tee rollback.log",
    "\"$STATUS\" deployment \"$version\"", "\"$STATUS\" wait disabled \"$version\"");
  assert.doesNotMatch(step("Wyłącz, jeśli włączenie nie zostało potwierdzone"), /--var/);
});

test("confirm: surrounding spaces are ignored (run 38612095982 sent \" WLACZ-AUTOMAT-OLX\"), anything else is still refused", () => {
  const workflow = readFileSync(new URL("../../../.github/workflows/olx-cloudflare-scheduled.yml", import.meta.url), "utf8");
  const block = workflow.slice(workflow.indexOf("- name: Kontrola wejścia"));
  const script = block.slice(block.indexOf("run: |") + 7, block.indexOf("\n\n")).split("\n").map((line) => line.replace(/^ {10}/, "")).join("\n");
  const run = (action: string, confirm: string) => spawnSync("bash", ["-c", script], { env: { ...process.env, ACTION: action, CONFIRM: confirm, GITHUB_REF: "refs/heads/main", GITHUB_SHA: "x" }, encoding: "utf8" }).status;
  assert.equal(run("enable", " WLACZ-AUTOMAT-OLX"), 0);
  assert.equal(run("enable", "WLACZ-AUTOMAT-OLX \n"), 0);
  for (const wrong of ["", "WLACZ-AUTOMAT", "wlacz-automat-olx", "WLACZ AUTOMAT OLX", "WLACZ-AUTOMAT-OLX!"]) assert.equal(run("enable", wrong), 1, JSON.stringify(wrong));
  assert.equal(run("check", ""), 0);
  assert.equal(run("check", "  "), 0, "only spaces = no confirmation");
  assert.equal(run("disable", "WLACZ-AUTOMAT-OLX"), 1, "confirm only for enable");
});

