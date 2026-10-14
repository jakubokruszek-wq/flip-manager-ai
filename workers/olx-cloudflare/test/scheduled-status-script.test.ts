/** scripts/scheduled-status.sh: the workflow's proof of the unattended Worker's state. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const SCRIPT = new URL("../scripts/scheduled-status.sh", import.meta.url).pathname;
const TOKEN = "t".repeat(40);
const V = "948f253b-70fc-470c-9d2b-3342307cc327";

function status(enabled: boolean, config: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}) {
  return {
    ok: enabled, code: enabled ? null : "OLX_CLOUD_DISABLED", message: null,
    config: { claimMode: "scheduled", workerId: "cloudflare-olx-scheduled", maxJobsPerDay: 2, maxJobsPerInvocation: 1, maxHeldJobs: 1, safeBrowserBudgetSeconds: 120, onBudgetExhausted: "leave_queued", ...config },
    configCheck: { killSwitch: enabled ? "enabled" : "disabled", stage1Lock: false, valid: true, problem: null, workerSecret: "set", adminToken: "set", warnings: [] },
    running: false, nextAlarm: null, paused: null, ledger: null,
    version: { worker: V, runner: V, matches: true, runnerReset: false },
    ...overrides,
  };
}

async function wait(state: "enabled" | "disabled", body: unknown): Promise<{ code: number | null; output: string }> {
  const server = createServer((_request, response) => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(body)); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  const out = join(mkdtempSync(join(tmpdir(), "scheduled-")), "status.json");
  try {
    const child = spawn("bash", [SCRIPT, "wait", state, V, "1", "0", out], { env: { ...process.env, SCHEDULED_URL: `http://127.0.0.1:${port}`, ADMIN_TOKEN: TOKEN } });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
    return { code, output };
  } finally {
    server.close();
  }
}

test("confirms disabled and enabled scheduled states; a pending claim alarm is allowed while enabled", async () => {
  assert.equal((await wait("disabled", status(false))).code, 0);
  assert.equal((await wait("enabled", status(true))).code, 0);
  assert.equal((await wait("enabled", status(true, {}, { nextAlarm: "2026-10-15T07:45:01.000Z" }))).code, 0);
});

test("refuses any looser configuration, another mode or Worker, and a running batch when disabling", async () => {
  for (const config of [{ claimMode: "auto" }, { claimMode: "manual" }, { workerId: "cloudflare-olx-stage2" }, { maxJobsPerDay: 0 }, { maxJobsPerDay: 1 }, { maxJobsPerDay: 3 }, { maxHeldJobs: 2 }, { safeBrowserBudgetSeconds: 480 }, { onBudgetExhausted: "fail_jobs" }]) {
    assert.equal((await wait("enabled", status(true, config))).code, 1, JSON.stringify(config));
  }
  assert.equal((await wait("disabled", status(false, {}, { running: true }))).code, 1);
  const result = await wait("enabled", status(false));
  assert.equal(result.code, 1);
  assert.doesNotMatch(result.output, new RegExp(TOKEN));
});
