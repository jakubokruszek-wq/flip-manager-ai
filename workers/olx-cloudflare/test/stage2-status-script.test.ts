/**
 * Regression for the failed stage-2 run 38455654010: after
 * `wrangler deploy --var OLX_CLOUD_ENABLED:1` succeeded, 12 /status checks
 * never matched the enabled state and nothing said why. The Durable Object
 * reads the kill switch from its own environment; if it still runs the
 * previous (disabled) version, /status keeps reporting OLX_CLOUD_DISABLED.
 * scripts/stage2-status.sh now prints a safe diagnostic line per attempt and
 * requires the Worker AND the Durable Object to run the deployed version.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const SCRIPT = new URL("../scripts/stage2-status.sh", import.meta.url).pathname;
const TOKEN = "t".repeat(40);
const OLD = "19b81f9e-fedb-49e2-97a9-7d7acbd1cc9b";
const NEW = "948f253b-70fc-470c-9d2b-3342307cc327";

type Status = Record<string, unknown>;

function status(options: { enabled: boolean; worker: string; runner: string; overrides?: Status; config?: Status }): Status {
  return {
    ok: options.enabled,
    code: options.enabled ? null : "OLX_CLOUD_DISABLED",
    message: null,
    config: { claimMode: "manual", workerId: "cloudflare-olx-stage2", maxJobsPerDay: 1, maxJobsPerInvocation: 1, maxHeldJobs: 1, safeBrowserBudgetSeconds: 120, ...options.config },
    configCheck: { killSwitch: options.enabled ? "enabled" : "disabled", stage1Lock: false, valid: true, problem: null, apiHost: "flip-manager-ai.vercel.app", workerSecret: "set", adminToken: "set", warnings: [] },
    ledger: null,
    paused: null,
    running: false,
    nextAlarm: null,
    version: { worker: options.worker, runner: options.runner, matches: options.worker === options.runner, runnerReset: false },
    ...options.overrides,
  };
}

/** Serves the given responses in order (the last one repeats) and runs the script against them. */
async function runScript(args: string[], responses: Array<{ http: number; body: unknown }>): Promise<{ code: number | null; output: string; requests: number; authorized: boolean }> {
  let requests = 0;
  let authorized = true;
  const server = createServer((request, response) => {
    const next = responses[Math.min(requests, responses.length - 1)];
    requests += 1;
    if (request.headers.authorization !== `Bearer ${TOKEN}`) authorized = false;
    response.writeHead(next.http, { "content-type": "application/json" });
    response.end(typeof next.body === "string" ? next.body : JSON.stringify(next.body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  const out = join(mkdtempSync(join(tmpdir(), "stage2-")), "status.json");
  try {
    const child = spawn("bash", [SCRIPT, ...args.map((arg) => (arg === "OUT" ? out : arg))], { env: { ...process.env, STAGE2_URL: `http://127.0.0.1:${port}`, ADMIN_TOKEN: TOKEN } });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
    return { code, output, requests, authorized };
  } finally {
    server.close();
  }
}

test("run 38455654010 regression: Durable Object still on the disabled version → not confirmed, with a diagnostic per attempt", async () => {
  const stale = status({ enabled: false, worker: NEW, runner: OLD });
  const result = await runScript(["wait", "enabled", NEW, "3", "0", "OUT"], [{ http: 200, body: stale }]);
  assert.equal(result.code, 1);
  assert.equal(result.requests, 3);
  assert.equal(result.authorized, true);
  assert.match(result.output, /próba 1\/3 \(enabled\): HTTP 200 ok=false code=OLX_CLOUD_DISABLED killSwitch=disabled/);
  assert.match(result.output, new RegExp(`worker=${NEW} runner=${OLD} zgodne=false`));
  assert.match(result.output, /limity\(dzień\/wywołanie\/trzymane\)=1\/1\/1 budżet=120s running=false nextAlarm=null/);
  assert.match(result.output, /::error::Nie potwierdzono stanu 'enabled'/);
  assert.match(result.output, /"workerSecret": "set"/, "safe summary printed on failure");
  assert.doesNotMatch(result.output, new RegExp(TOKEN), "the admin token is never printed");
});

test("enabled state is confirmed only once the Worker and the Durable Object both run the deployed version", async () => {
  const result = await runScript(["wait", "enabled", NEW, "5", "0", "OUT"], [
    { http: 200, body: status({ enabled: false, worker: NEW, runner: OLD }) },
    { http: 200, body: status({ enabled: true, worker: NEW, runner: OLD }) },
    { http: 200, body: status({ enabled: true, worker: NEW, runner: NEW }) },
  ]);
  assert.equal(result.code, 0, result.output);
  assert.equal(result.requests, 3);
  assert.match(result.output, /Potwierdzono stan 'enabled'/);
});

test("enabled response from an older deploy (both on another version) is not accepted", async () => {
  const result = await runScript(["wait", "enabled", NEW, "2", "0", "OUT"], [{ http: 200, body: status({ enabled: true, worker: OLD, runner: OLD }) }]);
  assert.equal(result.code, 1);
});

test("the enabled state keeps the trial limits: auto mode, no daily cap, an alarm or a running batch are refused", async () => {
  for (const variant of [{ config: { claimMode: "auto" } }, { config: { maxJobsPerDay: 0 } }, { config: { maxJobsPerInvocation: 2 } }, { config: { safeBrowserBudgetSeconds: 480 } }, { overrides: { nextAlarm: "2026-10-13T19:33:00.000Z" } }, { overrides: { running: true } }]) {
    const result = await runScript(["wait", "enabled", NEW, "1", "0", "OUT"], [{ http: 200, body: status({ enabled: true, worker: NEW, runner: NEW, ...variant }) }]);
    assert.equal(result.code, 1, JSON.stringify(variant));
  }
});

test("disabled state: confirmed for the disable deploy's version; 'any' requires Worker and Durable Object to agree", async () => {
  const disabled = status({ enabled: false, worker: OLD, runner: OLD });
  assert.equal((await runScript(["wait", "disabled", OLD, "1", "0", "OUT"], [{ http: 200, body: disabled }])).code, 0);
  assert.equal((await runScript(["wait", "disabled", "any", "1", "0", "OUT"], [{ http: 200, body: disabled }])).code, 0);
  // An enabled Durable Object behind a disabled Worker is never reported as safe.
  const split = { ...status({ enabled: false, worker: OLD, runner: NEW }) };
  assert.equal((await runScript(["wait", "disabled", "any", "2", "0", "OUT"], [{ http: 200, body: split }])).code, 1);
  // Old code without a version block cannot be confirmed (deploy-disabled first).
  const legacy = { ...disabled, version: undefined };
  assert.equal((await runScript(["wait", "disabled", "any", "1", "0", "OUT"], [{ http: 200, body: legacy }])).code, 1);
});

test("non-200 or non-JSON answers are reported with their HTTP status", async () => {
  const result = await runScript(["wait", "enabled", NEW, "2", "0", "OUT"], [{ http: 404, body: "Not found" }, { http: 503, body: "<html>" }]);
  assert.equal(result.code, 1);
  assert.match(result.output, /próba 1\/2 \(enabled\): HTTP 404, odpowiedź nie jest JSON-em/);
  assert.match(result.output, /próba 2\/2 \(enabled\): HTTP 503/);
});

test("deploy-version reads the version id from the real wrangler output of run 38455654010", async () => {
  const log = join(mkdtempSync(join(tmpdir(), "stage2-")), "enable.log");
  const text = [
    "env.OLX_CLOUD_ENABLED (\"(hidden)\")                                                    Environment Variable",
    "Uploaded flip-manager-olx-cloud-stage2 (3.32 sec)",
    "Deployed flip-manager-olx-cloud-stage2 triggers (0.58 sec)",
    "  https://flip-manager-olx-cloud-stage2.jakub-okruszek.workers.dev",
    `Current Version ID: ${NEW}`,
  ].join("\n");
  (await import("node:fs")).writeFileSync(log, text);
  const result = await runScript(["deploy-version", log], [{ http: 200, body: {} }]);
  assert.equal(result.code, 0);
  assert.equal(result.output.trim(), NEW);
  (await import("node:fs")).writeFileSync(log, "Uploaded flip-manager-olx-cloud-stage2\n");
  assert.equal((await runScript(["deploy-version", log], [{ http: 200, body: {} }])).code, 1);
});

test("workflow: enable-probe never calls /run-once or /selftest; every enabled attempt is always followed by a disable", () => {
  const workflow = readFileSync(new URL("../../../.github/workflows/olx-cloudflare-stage2.yml", import.meta.url), "utf8");
  const steps = workflow.split(/\n      - (?=name:|uses:)/);
  const step = (name: string) => {
    const found = steps.find((candidate) => candidate.startsWith(`name: ${name}`));
    assert.ok(found, name);
    return found;
  };
  assert.match(workflow, /options: \[check, deploy-disabled, enable-probe, run-one-job, disable\]/);
  assert.match(step("Dokładnie jedno /run-once"), /if: \$\{\{ inputs.action == 'run-one-job' && steps.enable.outcome == 'success' \}\}/);
  assert.equal(steps.slice(1).filter((candidate) => candidate.includes("/run-once?jobId")).length, 1, "only one step calls /run-once");
  assert.match(step("Sprawdzenie konfiguracji"), /if \[ "\$ACTION" = "enable-probe" \]; then[\s\S]*?exit 0[\s\S]*selftest\?selective=1/, "enable-probe exits before /selftest");
  for (const name of ["ZAWSZE wyłącz Workera po próbie", "Wynik i weryfikacja wyłączenia"]) {
    assert.match(step(name), /if: \$\{\{ always\(\) && \(inputs.action == 'run-one-job' \|\| inputs.action == 'enable-probe'\) && steps.enable.outcome != 'skipped' \}\}/, name);
  }
  assert.match(step("Chwilowe włączenie"), /--var OLX_CLOUD_ENABLED:1/);
  assert.match(step("Chwilowe włączenie"), /wait enabled "\$version"/);
  assert.match(step("ZAWSZE wyłącz Workera po próbie"), /env\.OLX_CLOUD_ENABLED \("0"\)/);
  assert.match(step("Wynik i weryfikacja wyłączenia"), /wait disabled "\$DISABLED_VERSION"/);
  assert.doesNotMatch(workflow, /--var OLX_CLOUD_(CLAIM_MODE|MAX_JOBS)/, "mode and limits are never overridden");
});
