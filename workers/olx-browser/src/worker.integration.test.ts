import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import test from "node:test";

import { verifyWorkerAuth } from "../../../features/flip-finder/olx-worker-protocol.ts";

const live = process.env.OLX_LIVE_TEST === "1";

test("local outbound worker claims and completes one real OLX browser job", { skip: !live, timeout: 120_000 }, async () => {
  const secret = "local-integration-secret-with-32-characters";
  const usedNonces = new Set<string>();
  let claimed = false;
  let completion: Record<string, unknown> | null = null;
  let failure: Record<string, unknown> | null = null;
  const server = createServer(async (request, response) => {
    const body = await readBody(request);
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    const auth = await verifyWorkerAuth({
      secret, method: request.method ?? "POST", pathname, body, headers: new Headers(request.headers as Record<string, string>),
      useNonce: async (nonce) => !usedNonces.has(nonce) && Boolean(usedNonces.add(nonce)),
    });
    if (!auth.ok) return json(response, 401, { error: auth.code });
    if (pathname.endsWith("/claim")) {
      const job = claimed ? null : { id: "job-1", runId: "run-1", sourceScanId: "scan-1", filterId: "filter-1", requestUrl: "https://www.olx.pl/nieruchomosci/mieszkania/sprzedaz/lodz/", leaseToken: "lease-1", leasedUntil: new Date(Date.now() + 120_000).toISOString(), attempts: 1 };
      claimed = true;
      return json(response, 200, { job });
    }
    if (pathname.endsWith("/complete")) completion = JSON.parse(body) as Record<string, unknown>;
    if (pathname.endsWith("/fail")) failure = JSON.parse(body) as Record<string, unknown>;
    return json(response, 200, { ok: true });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert(address && typeof address === "object");
    const child = spawn(process.execPath, ["--experimental-strip-types", "workers/olx-browser/src/index.ts"], {
      cwd: process.cwd(),
      env: { ...process.env, OLX_WORKER_API_URL: `http://localhost:${address.port}`, OLX_WORKER_SECRET: secret, OLX_WORKER_ID: "integration-worker", OLX_WORKER_ONCE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += String(chunk); });
    child.stderr.on("data", (chunk) => { output += String(chunk); });
    const exitCode = await new Promise<number | null>((resolve) => child.once("exit", resolve));
    assert.equal(exitCode, 0, output);
    assert.equal(failure, null, JSON.stringify(failure));
    assert(completion, output);
    const completed = completion as unknown as Record<string, unknown>;
    assert.equal(typeof completed.fetched, "number");
    assert(Number(completed.fetched) > 0);
    assert(Array.isArray(completed.listings));
    assert.equal(completed.listings.length, completed.fetched);
    process.stdout.write(`OLX LIVE WORKER RESULT raw=${completed.fetched} normalized=${completed.listings.length}\n`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

function readBody(request: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function json(response: import("node:http").ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
