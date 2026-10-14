/**
 * Regression: runs 38606455224 and 38607086215 (enable of the unattended Worker).
 *
 * `wrangler deploy --var OLX_CLOUD_ENABLED:1` reported "Current Version ID:
 * d8fa3951-…" (and b3eced97-…), but /status kept answering from version
 * 1d7f95d1-… — the version that the last `wrangler secret put` of the
 * deploy-disabled run (38604780597) had created and deployed — on BOTH the
 * Worker and its Durable Object, with OLX_CLOUD_DISABLED. The workflow only
 * knew "not confirmed". It now proves, separately: the deployment Cloudflare
 * applied (DEPLOYMENT_NOT_APPLIED), the var on that version (VAR_NOT_APPLIED),
 * the version workers.dev serves (VERSION_NOT_ACTIVE), the Durable Object's
 * version (DURABLE_OBJECT_VERSION_MISMATCH) and the state (STATE_MISMATCH).
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const SCRIPT = new URL("../scripts/scheduled-status.sh", import.meta.url).pathname;
const TOKEN = "t".repeat(40);
const SECRET_PUT_VERSION = "1d7f95d1-56b9-454c-bd1e-3a5c91263236";
const ENABLE_VERSION = "d8fa3951-5ee1-4b96-add4-8f087390c82a";
const dir = mkdtempSync(join(tmpdir(), "scheduled-activation-"));

/** The /status body of runs 38606455224/38607086215, with the version pair varied. */
function status(enabled: boolean, worker: string, runner: string) {
  return {
    ok: enabled, code: enabled ? null : "OLX_CLOUD_DISABLED",
    message: enabled ? null : "OLX_CLOUD_ENABLED nie jest ustawione na \"1\" — worker nie odbiera zadań.",
    configCheck: { killSwitch: enabled ? "enabled" : "disabled", stage1Lock: false, valid: true, problem: null, apiHost: "flip-manager-ai.vercel.app", workerSecret: "set", adminToken: "set", warnings: [] },
    config: { claimMode: "scheduled", workerId: "cloudflare-olx-scheduled", maxJobsPerDay: 2, maxJobsPerInvocation: 1, maxHeldJobs: 1, safeBrowserBudgetSeconds: 120, onBudgetExhausted: "leave_queued" },
    running: false, nextAlarm: null, paused: null,
    version: { worker, runner, matches: worker === runner, runnerReset: false },
  };
}

function file(name: string, content: string) {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

function run(...args: string[]) {
  const result = spawnSync("bash", [SCRIPT, ...args], { encoding: "utf8" });
  return { code: result.status, output: `${result.stdout}${result.stderr}` };
}

async function wait(state: "enabled" | "disabled", version: string, respond: (response: import("node:http").ServerResponse) => void) {
  const server = createServer((_request, response) => respond(response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  try {
    const child = spawn("bash", [SCRIPT, "wait", state, version, "2", "0", join(dir, `status-${Math.random()}.json`)],
      { env: { ...process.env, SCHEDULED_URL: `http://127.0.0.1:${port}`, ADMIN_TOKEN: TOKEN } });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
    assert.doesNotMatch(output, new RegExp(TOKEN), "the admin token is never printed");
    return { code, output };
  } finally {
    server.close();
  }
}
const json = (body: unknown) => (response: import("node:http").ServerResponse) => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(body)); };

test("the exact case: deploy reported d8fa3951 but workers.dev kept serving 1d7f95d1 → VERSION_NOT_ACTIVE (not a vague 'not confirmed')", async () => {
  const result = await wait("enabled", ENABLE_VERSION, json(status(false, SECRET_PUT_VERSION, SECRET_PUT_VERSION)));
  assert.equal(result.code, 1);
  assert.match(result.output, new RegExp(`VERSION_NOT_ACTIVE: workers.dev nadal obsługuje wersję ${SECRET_PUT_VERSION}, a wdrożono ${ENABLE_VERSION}`));
  assert.doesNotMatch(result.output, /DURABLE_OBJECT_VERSION_MISMATCH|STATE_MISMATCH/);
});

test("the Worker on the new version but its Durable Object still on the old one → DURABLE_OBJECT_VERSION_MISMATCH", async () => {
  const result = await wait("enabled", ENABLE_VERSION, json(status(true, ENABLE_VERSION, SECRET_PUT_VERSION)));
  assert.equal(result.code, 1);
  assert.match(result.output, new RegExp(`DURABLE_OBJECT_VERSION_MISMATCH: Worker działa w wersji ${ENABLE_VERSION}, Durable Object w ${SECRET_PUT_VERSION}`));
});

test("both on the new version but the kill switch still off → STATE_MISMATCH; no answer at all → STATUS_UNREACHABLE", async () => {
  const state = await wait("enabled", ENABLE_VERSION, json(status(false, ENABLE_VERSION, ENABLE_VERSION)));
  assert.equal(state.code, 1);
  assert.match(state.output, /STATE_MISMATCH: wersja .* zgodna, ale stan różni się od 'enabled' \(code=OLX_CLOUD_DISABLED, killSwitch=disabled/);
  const down = await wait("enabled", ENABLE_VERSION, (response) => { response.writeHead(503); response.end("worker exception"); });
  assert.equal(down.code, 1);
  assert.match(down.output, /STATUS_UNREACHABLE/);
});

test("confirmed only when the Worker AND its Durable Object run the deployed version in the requested state", async () => {
  assert.equal((await wait("enabled", ENABLE_VERSION, json(status(true, ENABLE_VERSION, ENABLE_VERSION)))).code, 0);
  assert.equal((await wait("disabled", SECRET_PUT_VERSION, json(status(false, SECRET_PUT_VERSION, SECRET_PUT_VERSION)))).code, 0);
});

test("deploy log of run 38606455224: the version id is read even though --var is printed as \"(hidden)\"", () => {
  const log = file("enable.log", [
    "env.OLX_CLOUD_ENABLED (\"(hidden)\")                                                    Environment Variable",
    "Uploaded flip-manager-olx-cloud-scheduled (4.67 sec)",
    "Deployed flip-manager-olx-cloud-scheduled triggers (1.69 sec)",
    "  https://flip-manager-olx-cloud-scheduled.jakub-okruszek.workers.dev",
    `Current Version ID: ${ENABLE_VERSION}`,
  ].join("\n"));
  const result = run("deploy-version", log);
  assert.equal(result.code, 0);
  assert.equal(result.output.trim(), ENABLE_VERSION);
});

test("deployment: Cloudflare's active deployment must send 100 % to the deployed version (DEPLOYMENT_NOT_APPLIED otherwise)", () => {
  const applied = file("applied.json", JSON.stringify({ id: "dep-1", versions: [{ version_id: ENABLE_VERSION, percentage: 100 }] }));
  assert.equal(run("deployment", ENABLE_VERSION, applied).code, 0);
  const stale = file("stale.json", JSON.stringify({ id: "dep-0", versions: [{ version_id: SECRET_PUT_VERSION, percentage: 100 }] }));
  const notApplied = run("deployment", ENABLE_VERSION, stale);
  assert.equal(notApplied.code, 1);
  assert.match(notApplied.output, new RegExp(`DEPLOYMENT_NOT_APPLIED: .*\\[${SECRET_PUT_VERSION}:100%\\], a wdrożono ${ENABLE_VERSION}`));
  const split = file("split.json", JSON.stringify({ id: "dep-2", versions: [{ version_id: ENABLE_VERSION, percentage: 50 }, { version_id: SECRET_PUT_VERSION, percentage: 50 }] }));
  assert.equal(run("deployment", ENABLE_VERSION, split).code, 1, "a split deployment is not an applied enable");
  const warned = file("warned.json", `▲ [WARNING] something wrangler printed\n${JSON.stringify({ id: "dep-1", versions: [{ version_id: ENABLE_VERSION, percentage: 100 }] }, null, 2)}`);
  assert.equal(run("deployment", ENABLE_VERSION, warned).code, 0, "a warning before the JSON does not break the check");
  assert.match(run("deployment", ENABLE_VERSION, file("garbage.json", "Not logged in")).output, /DEPLOYMENT_STATUS_UNREADABLE/);
});

test("active-version: after `wrangler secret put` the expected version is the one Cloudflare deployed (here 1d7f95d1), never \"any\"", () => {
  const afterSecrets = file("after-secrets.json", JSON.stringify({ id: "dep-s", versions: [{ version_id: SECRET_PUT_VERSION, percentage: 100 }] }));
  const result = run("active-version", afterSecrets);
  assert.equal(result.code, 0);
  assert.equal(result.output.trim(), SECRET_PUT_VERSION);
  const split = file("split2.json", JSON.stringify({ versions: [{ version_id: ENABLE_VERSION, percentage: 90 }, { version_id: SECRET_PUT_VERSION, percentage: 10 }] }));
  assert.match(run("active-version", split).output, /DEPLOYMENT_SPLIT/);
});

test("var: `--var OLX_CLOUD_ENABLED:1` is proven on the version itself (the deploy log hides it); 0 or missing → VAR_NOT_APPLIED", () => {
  const view = (value: string | null) => file(`view-${value}.json`, JSON.stringify({ id: ENABLE_VERSION, resources: { bindings: [
    ...(value === null ? [] : [{ type: "plain_text", name: "OLX_CLOUD_ENABLED", text: value }]),
    { type: "plain_text", name: "OLX_CLOUD_CLAIM_MODE", text: "scheduled" },
    { type: "secret_text", name: "OLX_WORKER_SECRET" },
  ] } }));
  assert.equal(run("var", view("1"), "OLX_CLOUD_ENABLED", "1").code, 0);
  const off = run("var", view("0"), "OLX_CLOUD_ENABLED", "1");
  assert.equal(off.code, 1);
  assert.match(off.output, new RegExp(`VAR_NOT_APPLIED: wersja ${ENABLE_VERSION} ma OLX_CLOUD_ENABLED = "0", oczekiwano "1"`));
  assert.match(run("var", view(null), "OLX_CLOUD_ENABLED", "1").output, /VAR_NOT_APPLIED: .*= "<brak>"/);
});
