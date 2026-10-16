// Container end-to-end tests for the cloud OLX worker image.
//
//   docker build -f workers/olx-browser/Dockerfile -t flip-olx-worker:test .
//   OLX_CONTAINER_E2E=1 node --test --experimental-strip-types workers/olx-browser/test/container.e2e.test.ts
//
// Each test runs the built image against an in-process fake of the Flip
// Manager worker API (real HMAC verification, real lease rules). Workers use
// the image's own headless Chromium; OLX pages come from a local fixture
// (test/fixture-entry.ts) so no request ever reaches OLX or Production.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createWorkerAuthHeaders, OLX_WORKER_NONCE_HEADER, OLX_WORKER_SIGNATURE_HEADER, OLX_WORKER_TIMESTAMP_HEADER } from "../../../features/flip-finder/olx-worker-protocol.ts";
import { startFakeQueueApi } from "./fake-queue-api.ts";

const enabled = process.env.OLX_CONTAINER_E2E === "1";
const image = process.env.OLX_WORKER_IMAGE ?? "flip-olx-worker:test";
const secret = "container-e2e-secret-with-more-than-32-characters";
const testDir = fileURLToPath(new URL(".", import.meta.url));
const options = { skip: !enabled, timeout: 240_000 };

type Container = { name: string; output(): string; events(): Array<Record<string, unknown>>; exited: Promise<number | null> };

function docker(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("docker", args, { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function runContainer(name: string, apiUrl: string, extraEnv: Record<string, string>, entry: "production" | "fixture" = "fixture"): Container {
  const env = { OLX_WORKER_API_URL: apiUrl, OLX_WORKER_SECRET: secret, OLX_WORKER_ID: name, OLX_WORKER_POLL_INTERVAL_MS: "2000", ...extraEnv };
  const command = entry === "production" ? [] : [
    "node", "--use-system-ca", "--experimental-strip-types", "--disable-warning=ExperimentalWarning", "workers/olx-browser/test/fixture-entry.ts",
  ];
  const child = spawn("docker", [
    "run", "--rm", "--name", name, "--network", "host",
    ...(entry === "fixture" ? ["-v", `${testDir}:/app/workers/olx-browser/test:ro`] : []),
    ...Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
    image, ...command,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => { output += String(chunk); });
  child.stderr.on("data", (chunk) => { output += String(chunk); });
  return {
    name,
    output: () => output,
    events: () => output.split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line) as Record<string, unknown>),
    exited: new Promise((resolve) => child.once("exit", resolve)),
  };
}

async function waitFor(description: string, predicate: () => boolean, timeoutMs = 60_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function signedPost(apiUrl: string, pathname: string, payload: unknown): Promise<number> {
  const body = JSON.stringify(payload);
  const auth = createWorkerAuthHeaders({ secret, method: "POST", pathname, body });
  const response = await fetch(new URL(pathname, apiUrl), { method: "POST", body, headers: {
    "content-type": "application/json", [OLX_WORKER_TIMESTAMP_HEADER]: auth.timestamp, [OLX_WORKER_NONCE_HEADER]: auth.nonce, [OLX_WORKER_SIGNATURE_HEADER]: auth.signature,
  } });
  return response.status;
}

test("image runs as an unprivileged user under tini, with no secrets, env files or tests baked in", options, () => {
  const inspect = JSON.parse(docker(["image", "inspect", image]).stdout)[0] as { Config: { User: string; Env: string[]; Entrypoint: string[] } };
  assert.equal(inspect.Config.User, "pwuser");
  assert.deepEqual(inspect.Config.Entrypoint, ["/usr/bin/tini", "--"]);
  assert.equal(inspect.Config.Env.some((entry) => /^OLX_WORKER_(SECRET|API_URL)=/.test(entry)), false);
  const probe = docker(["run", "--rm", image, "sh", "-c", "id -u; find /app -name '.env*' -o -name '*.test.ts' | wc -l; ls /app/features; echo DISPLAY=${DISPLAY:-none}"]);
  assert.equal(probe.status, 0, probe.stderr);
  const [uid, leakedFiles, ...rest] = probe.stdout.trim().split("\n");
  assert.notEqual(uid, "0");
  assert.equal(leakedFiles, "0");
  assert.deepEqual(rest.slice(0, -1).sort(), ["flip-finder", "properties"]);
  assert.equal(rest.at(-1), "DISPLAY=none", "the worker needs no display or user browser session");
});

test("production entry point boots in the container, authenticates with HMAC and polls the queue", options, async () => {
  const api = await startFakeQueueApi({ secret });
  try {
    const worker = runContainer("olx-e2e-boot", api.url, { OLX_WORKER_ONCE: "1" }, "production");
    assert.equal(await worker.exited, 0, worker.output());
    assert.equal(api.authFailures, 0);
    assert.deepEqual(api.events.map((event) => [event.path, event.workerId]), [["claim", "olx-e2e-boot"]]);
    const names = worker.events().map((event) => event.event);
    assert.deepEqual(names, ["WORKER_START", "WORKER_STOP"]);
    assert.equal(worker.events()[0]?.level, "info");
  } finally {
    await api.close();
  }
});

test("claims a test job, renews the lease while Chromium works and completes with the fetched offers", options, async () => {
  const api = await startFakeQueueApi({ secret });
  try {
    const [job] = api.enqueue(1);
    const worker = runContainer("olx-e2e-job", api.url, { OLX_WORKER_ONCE: "1", OLX_FIXTURE_ADS: "5", OLX_FIXTURE_DELAY_MS: "4000", OLX_FIXTURE_HEARTBEAT_MS: "1000" });
    assert.equal(await worker.exited, 0, worker.output());
    assert.equal(job!.status, "completed", worker.output());
    assert.deepEqual(job!.result, { fetched: 5, listings: 5, durationMs: (job!.result as { durationMs: number }).durationMs });
    const heartbeats = api.events.filter((event) => event.path === "heartbeat");
    assert.ok(heartbeats.length >= 4, `expected start, periodic and final heartbeats, got ${heartbeats.length}`);
    const leases = heartbeats.map((event) => (event.detail as { leasedUntil: number }).leasedUntil);
    assert.deepEqual(leases, [...leases].sort((a, b) => a - b), "each heartbeat renews the lease further");
    const summary = worker.events().find((event) => event.event === "JOB_SUMMARY");
    assert.equal(summary?.outcome, "completed");
    assert.equal(summary?.rawItems, 5);
    assert.equal(summary?.normalizedItems, 5);
    assert.ok(Number(summary?.durationMs) >= 4000);
    const claim = api.events.find((event) => event.path === "claim" && event.jobId)!;
    assert.equal(worker.output().includes((claim.detail as { leaseToken: string }).leaseToken), false, "lease tokens never reach the logs");
  } finally {
    await api.close();
  }
});

test("restart safety: SIGTERM and SIGKILL mid-job leave the job to lease expiry; the next container resumes it exactly once", options, async () => {
  const api = await startFakeQueueApi({ secret });
  try {
    const [job] = api.enqueue(1);

    // 1. Railway redeploy: SIGTERM while the page is loading.
    const first = runContainer("olx-e2e-restart-1", api.url, { OLX_FIXTURE_MODE: "hang" });
    await waitFor("first claim + heartbeat", () => api.events.some((event) => event.path === "heartbeat" && event.workerId === "olx-e2e-restart-1"));
    const firstToken = (api.events.find((event) => event.path === "claim" && event.jobId)!.detail as { leaseToken: string }).leaseToken;
    assert.equal(docker(["stop", "-t", "20", first.name]).status, 0);
    assert.equal(await first.exited, 0, "graceful shutdown exits 0\n" + first.output());
    assert.ok(first.events().some((event) => event.event === "WORKER_SHUTDOWN"));
    assert.equal(first.events().find((event) => event.event === "JOB_ERROR")?.code, "WORKER_SHUTDOWN");
    assert.equal(api.events.some((event) => event.path === "complete" || event.path === "fail"), false, "a stopped worker neither completes nor burns the job");
    assert.equal(job!.status, "running");

    // 2. Crash / OOM: SIGKILL with no chance to clean up.
    api.expireLeases();
    const second = runContainer("olx-e2e-restart-2", api.url, { OLX_FIXTURE_MODE: "hang" });
    await waitFor("second claim + heartbeat", () => api.events.some((event) => event.path === "heartbeat" && event.workerId === "olx-e2e-restart-2"));
    assert.equal(docker(["kill", second.name]).status, 0);
    await second.exited;
    assert.equal(job!.attempts, 2);

    // A worker that lost its lease cannot finalize the job any more.
    api.expireLeases();
    assert.equal(await signedPost(api.url, "/api/olx-worker/complete", { jobId: job!.id, leaseToken: firstToken, workerId: "olx-e2e-restart-1", fetched: 0, listings: [], warnings: [], durationMs: 1 }), 409);

    // 3. The replacement container picks the requeued job up and finishes it.
    const third = runContainer("olx-e2e-restart-3", api.url, { OLX_WORKER_ONCE: "1" });
    assert.equal(await third.exited, 0, third.output());
    assert.equal(job!.status, "completed");
    assert.equal(job!.attempts, 3);
    assert.equal(job!.workerId, "olx-e2e-restart-3");
    assert.equal(api.events.filter((event) => event.path === "complete" && event.ok).length, 1);
  } finally {
    await api.close();
  }
});

test("parallel workers never process the same job twice", options, async () => {
  const api = await startFakeQueueApi({ secret });
  const workers: Container[] = [];
  try {
    const jobs = api.enqueue(6);
    for (const index of [1, 2, 3]) workers.push(runContainer(`olx-e2e-parallel-${index}`, api.url, { OLX_FIXTURE_DELAY_MS: "1500" }));
    await waitFor("all jobs completed", () => jobs.every((job) => job.status === "completed"), 180_000);
    for (const worker of workers) docker(["stop", "-t", "20", worker.name]);
    for (const worker of workers) assert.equal(await worker.exited, 0, worker.output());
    const claims = api.events.filter((event) => event.path === "claim" && event.jobId);
    const completes = api.events.filter((event) => event.path === "complete" && event.ok);
    assert.equal(claims.length, 6, "each job is claimed exactly once");
    assert.equal(new Set(claims.map((event) => event.jobId)).size, 6);
    assert.equal(completes.length, 6);
    assert.equal(new Set(completes.map((event) => event.jobId)).size, 6);
    assert.equal(api.events.some((event) => !event.ok), false, "no worker ever wrote to a job it did not hold");
    for (const event of completes) assert.equal(event.workerId, claims.find((claim) => claim.jobId === event.jobId)!.workerId);
    assert.ok(new Set(claims.map((event) => event.workerId)).size >= 2, "the jobs were actually spread over concurrent workers");
  } finally {
    for (const worker of workers) docker(["rm", "-f", worker.name]);
    await api.close();
  }
});

for (const [mode, code] of [["http403", "OLX_HTTP_403"], ["captcha", "OLX_HUMAN_VERIFICATION"]] as const) {
  test(`OLX ${code}: the job fails once, nothing is retried and later jobs are released without opening OLX`, options, async () => {
    const api = await startFakeQueueApi({ secret });
    try {
      const [blocked, waiting] = api.enqueue(2);
      const worker = runContainer(`olx-e2e-${mode}`, api.url, { OLX_FIXTURE_MODE: mode, OLX_WORKER_BLOCK_COOLDOWN_MS: "600000" });
      await waitFor("second job released", () => waiting!.status !== "queued");
      await new Promise((resolve) => setTimeout(resolve, 4_000)); // two more base poll intervals
      docker(["stop", "-t", "20", worker.name]);
      assert.equal(await worker.exited, 0, worker.output());
      assert.equal(blocked!.status, "failed");
      assert.equal(blocked!.errorCode, code);
      assert.equal(blocked!.attempts, 1);
      assert.equal(waiting!.status, "failed");
      assert.equal(waiting!.errorCode, "OLX_ACCESS_COOLDOWN", "released at once with an explicit reason, not left to the 90 s claim timeout");
      assert.equal(waiting!.attempts, 1);
      const cooldown = worker.events().find((event) => event.event === "WORKER_OLX_ACCESS_COOLDOWN")!;
      assert.equal(cooldown.reason, code);
      assert.equal(cooldown.level, 1);
      assert.equal(cooldown.durationMs, 600_000);
      assert.equal(worker.events().filter((event) => event.event === "OLX_BROWSER_START").length, 1, "an access denial is never retried");
    } finally {
      await api.close();
    }
  });
}
