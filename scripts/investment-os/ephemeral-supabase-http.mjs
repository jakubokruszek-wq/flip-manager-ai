import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomInt, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const appDir = process.env.GITHUB_WORKSPACE ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const supabaseWorkdir = process.env.SUPABASE_WORKDIR;
const baseUrl = "http://127.0.0.1:3000";
const allowedHosts = new Set(["127.0.0.1", "localhost"]);
const forbiddenRemoteEnvNames = ["SUPABASE_ACCESS_TOKEN", "SUPABASE_DB_PASSWORD", "SUPABASE_PROJECT_ID", "SUPABASE_DB_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SECRET_KEY"];
const reviewedMigrationHashes = new Map([
  ["20260912120000_create_investment_os_phase1.sql", "0F283BC5E2B351A6F500D140242E55CFEB6D44B936CAF52D1FCF99F4A5E6270D"],
  ["20260912180000_investment_os_deal_cas.sql", "E0F8FD969B825ADD0FF8BD8BAF0B36AB6E8665941A4BF11DE2C50D5D125D099A"],
]);
let server;
let serverStartError;
let serverOutput = "";
let completed = false;

function log(message) {
  console.log(message);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${message}\n`);
}

function redact(value) {
  return String(value)
    .replace(/(postgres(?:ql)?:\/\/[^:/\s]+:)[^@/\s]+@/gi, "$1[REDACTED]@")
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[REDACTED_JWT]")
    .replace(/sb_(?:secret|publishable)_[A-Za-z0-9_-]+/g, "[REDACTED_SUPABASE_KEY]")
    .replace(/(service[_ -]?role[_ -]?key|authorization|password|token)(\s*[:=]\s*)[^\s,;]+/gi, "$1$2[REDACTED]");
}

function verifyReviewedMigrationHashes() {
  for (const [file, expected] of reviewedMigrationHashes) {
    const content = fs.readFileSync(path.join(appDir, "supabase", "migrations", file));
    const actual = createHash("sha256").update(content).digest("hex").toUpperCase();
    assert.equal(actual, expected, `reviewed migration checksum mismatch: ${file}`);
  }
}

function ensureLoopback(rawUrl, label) {
  const parsed = new URL(rawUrl);
  assert.ok(["http:", "postgres:", "postgresql:"].includes(parsed.protocol), `${label} protocol is not local/test-safe`);
  assert.ok(allowedHosts.has(parsed.hostname), `${label} is not loopback; remote connections are forbidden`);
  assert.equal(parsed.search, "", `${label} connection options are disallowed`);
  assert.equal(parsed.hash, "", `${label} URI fragments are disallowed`);
  return parsed;
}

function parseCliEnv(text) {
  const result = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)=(.*)\s*$/);
    if (!match) continue;
    let value = match[2].trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      try { value = JSON.parse(value); } catch { value = value.slice(1, -1); }
    } else if (value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    }
    result[match[1]] = value;
  }
  return result;
}

function runSupabaseStatus() {
  assert.ok(supabaseWorkdir && fs.existsSync(path.join(supabaseWorkdir, "supabase", "config.toml")), "ephemeral Supabase config missing");
  const result = spawnSync("supabase", ["status", "--output", "env"], { cwd: supabaseWorkdir, encoding: "utf8", timeout: 15_000 });
  if (result.error || result.status !== 0) throw new Error(`LOCAL_SUPABASE_STATUS_FAILED:${redact(result.stderr ?? result.error?.message ?? result.status)}`);
  return parseCliEnv(result.stdout);
}

function assertCanonicalPropertiesReplay(databaseUrl) {
  const helper = path.join(appDir, "scripts", "investment-os", "ephemeral-properties-baseline.sh");
  assert.ok(fs.existsSync(helper), "historical properties baseline harness is missing");
  const result = spawnSync("bash", [helper, "assert"], {
    cwd: appDir,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    encoding: "utf8",
    timeout: 30_000,
  });
  const output = redact(`${result.stdout ?? ""}${result.stderr ?? ""}`);
  if (result.error || result.status !== 0) {
    throw new Error(`LOCAL_PROPERTIES_CANONICAL_REPLAY_FAILED:${output.slice(-4_000)}`);
  }
  process.stdout.write(output);
  log("- Local Supabase canonical properties replay: PASS");
}

async function readJson(response) {
  const text = await response.text();
  try { return JSON.parse(text); } catch { return { nonJson: true, snippet: redact(text.slice(0, 240)) }; }
}

function responseSummary(response, body) {
  return {
    httpStatus: response.status,
    ok: body?.ok === true,
    code: typeof body?.code === "string" ? body.code : null,
    dealId: typeof body?.deal?.id === "string" ? body.deal.id : null,
    dealListingId: typeof body?.deal?.listingId === "string" ? body.deal.listingId : null,
    message: typeof body?.message === "string" ? redact(body.message).slice(0, 200) : null,
    nonJson: body?.nonJson === true,
  };
}

function trackServerOutput(chunk) {
  serverOutput = `${serverOutput}${chunk.toString("utf8")}`.slice(-8000);
}

async function waitForReadOnlyGet(client, listingId) {
  const deadline = Date.now() + 90_000;
  let lastStatus = "not-requested";
  while (Date.now() < deadline) {
    if (serverStartError) throw new Error(`NEXT_DEV_START_FAILED:${redact(serverStartError.message)}`);
    if (server.exitCode !== null) throw new Error(`NEXT_DEV_EXITED:${server.exitCode}:${redact(serverOutput)}`);
    try {
      const response = await fetch(`${baseUrl}/api/flip-finder/listings/${listingId}/investment`, { signal: AbortSignal.timeout(5_000) });
      const body = await readJson(response);
      lastStatus = `${response.status}:${body?.code ?? "unknown"}`;
      if (response.status === 404 && body?.code === "NOT_COMPUTED") return { response, body };
    } catch (error) {
      lastStatus = error instanceof Error ? error.name : "request-error";
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`REAL_GET_NOT_COMPUTED_WITHIN_90S:${lastStatus}:${redact(serverOutput)}`);
}

async function main() {
  verifyReviewedMigrationHashes();
  for (const name of forbiddenRemoteEnvNames) {
    if (process.env[name]) throw new Error(`REMOTE_SUPABASE_CREDENTIAL_PRESENT:${name}`);
  }

  const cliEnv = runSupabaseStatus();
  const apiUrl = cliEnv.API_URL ?? cliEnv.SUPABASE_URL;
  const databaseUrl = cliEnv.DB_URL ?? cliEnv.DATABASE_URL;
  const anonKey = cliEnv.ANON_KEY ?? cliEnv.PUBLISHABLE_KEY;
  const serviceRoleKey = cliEnv.SERVICE_ROLE_KEY;
  assert.ok(apiUrl && databaseUrl && anonKey && serviceRoleKey, "local Supabase status omitted required local values");
  const api = ensureLoopback(apiUrl, "Supabase API URL");
  const database = ensureLoopback(databaseUrl, "Supabase DB URL");
  log(`- Job B Supabase endpoint host: ${api.hostname}; DB host: ${database.hostname}; remote connections: NONE`);
  assertCanonicalPropertiesReplay(databaseUrl);

  const client = createClient(apiUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const listingId = randomUUID();
  const postId = randomInt(900_000_000_000_000, 1_000_000_000_000_000).toString();
  const groupId = "123456789012345";
  const now = new Date().toISOString();
  const fixture = {
    id: listingId,
    source: "facebook",
    external_listing_id: postId,
    original_url: `https://www.facebook.com/groups/${groupId}/permalink/${postId}/`,
    normalized_url: `https://www.facebook.com/groups/${groupId}/permalink/${postId}/`,
    title: "Ephemeral Investment OS HTTP fixture",
    price: 250000,
    area: 45,
    price_per_sqm: 250000 / 45,
    rooms: 2,
    address: "Testowa 1",
    district: "Test",
    city: "Łódź",
    description: "Disposable local-only fixture; not Production data.",
    images: [],
    updated_at: now,
  };
  const inserted = await client.from("listings").insert(fixture).select("id,updated_at").single();
  if (inserted.error) throw new Error(`LOCAL_FIXTURE_INSERT_FAILED:${inserted.error.code ?? "unknown"}`);
  assert.equal(inserted.data.id, listingId);
  log(`- Local-only listing fixture created: ${listingId}; post=${postId}`);

  const childEnv = { ...process.env };
  for (const name of Object.keys(childEnv)) {
    if (/^(SUPABASE_|NEXT_PUBLIC_SUPABASE_|DATABASE_URL$|POSTGRES_|OPENAI_)/i.test(name)) delete childEnv[name];
  }
  Object.assign(childEnv, {
    NEXT_PUBLIC_SUPABASE_URL: apiUrl,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: anonKey,
    SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey,
    NEXT_TELEMETRY_DISABLED: "1",
    NODE_ENV: "development",
    PORT: "3000",
  });
  const nextEntrypoint = path.join(appDir, "node_modules", "next", "dist", "bin", "next");
  assert.ok(fs.existsSync(nextEntrypoint), "Next.js dependency is not installed in the CI worktree");
  server = spawn(process.execPath, [nextEntrypoint, "dev", "--hostname", "127.0.0.1", "--port", "3000"], {
    cwd: appDir,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.on("error", (error) => { serverStartError = error; });
  server.stdout.on("data", trackServerOutput);
  server.stderr.on("data", trackServerOutput);

  const getResult = await waitForReadOnlyGet(client, listingId);
  assert.equal(getResult.response.status, 404);
  assert.equal(getResult.body.code, "NOT_COMPUTED");
  const before = await client.from("deals").select("id", { count: "exact", head: true }).eq("listing_id", listingId);
  if (before.error) throw new Error(`DB_READ_BEFORE_POST_FAILED:${before.error.code ?? "unknown"}`);
  assert.equal(before.count, 0, "GET created a deal; it is not read-only");
  log(`- Real HTTP GET before initialize: 404 NOT_COMPUTED; deal rows after GET: ${before.count}`);

  const requestInitialize = async () => {
    const response = await fetch(`${baseUrl}/api/flip-finder/listings/${listingId}/investment/initialize`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost:3000",
        "x-flip-finder-action": "investment-os",
        "sec-fetch-site": "same-origin",
      },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(60_000),
    });
    const body = await readJson(response);
    return { response, body, summary: responseSummary(response, body) };
  };
  const [postA, postB] = await Promise.all([requestInitialize(), requestInitialize()]);
  log(`- Real concurrent POST A: ${JSON.stringify(postA.summary)}`);
  log(`- Real concurrent POST B: ${JSON.stringify(postB.summary)}`);
  assert.equal(postA.response.status, 200, "POST A must complete without HTTP error");
  assert.equal(postB.response.status, 200, "POST B must complete without HTTP error");
  assert.equal(postA.body?.ok, true);
  assert.equal(postB.body?.ok, true);
  assert.ok(postA.body?.deal?.id && postB.body?.deal?.id, "both initialize responses must contain a deal id");
  assert.equal(postA.body.deal.id, postB.body.deal.id, "parallel initialize returned different deal identities");
  assert.equal(postA.body.deal.listingId, listingId);
  assert.equal(postB.body.deal.listingId, listingId);

  const countResult = await client.from("deals").select("id", { count: "exact", head: true }).eq("listing_id", listingId);
  if (countResult.error) throw new Error(`DB_COUNT_AFTER_POST_FAILED:${countResult.error.code ?? "unknown"}`);
  const rowResult = await client.from("deals").select("id,listing_id,version,source_updated_at,stage,facts_fingerprint,scout,verify,market,underwriting,ceo").eq("listing_id", listingId).maybeSingle();
  if (rowResult.error) throw new Error(`DB_DEAL_AFTER_POST_FAILED:${rowResult.error.code ?? "unknown"}`);
  assert.equal(countResult.count, 1, "parallel initialize created duplicate deals");
  assert.ok(rowResult.data, "deal row missing after successful initialize");
  assert.equal(rowResult.data.id, postA.body.deal.id);
  assert.equal(rowResult.data.listing_id, listingId);
  assert.ok(Number.isInteger(rowResult.data.version) && rowResult.data.version >= 1, "deal version is invalid");
  assert.equal(typeof rowResult.data.facts_fingerprint, "string");
  assert.ok(rowResult.data.stage);
  log(`- Real HTTP concurrent initialize DB proof: rows=${countResult.count}; deal=${rowResult.data.id}; version=${rowResult.data.version}; same logical deal=YES; duplicate=NO`);
  log(`- Current deal state: stage=${rowResult.data.stage}; source_updated_at=${rowResult.data.source_updated_at}; director JSON objects=${["scout", "verify", "market", "underwriting", "ceo"].every((key) => rowResult.data[key] && typeof rowResult.data[key] === "object") ? "valid" : "invalid"}`);
  assert.ok(["DISCOVERED", "VERIFYING", "VERIFIED", "MARKET_READY", "UNDERWRITTEN", "DECISION_READY", "ACQUISITION", "RENOVATION", "SALE", "CLOSED"].includes(rowResult.data.stage));
  assert.ok(["scout", "verify", "market", "underwriting", "ceo"].every((key) => rowResult.data[key] && typeof rowResult.data[key] === "object"), "analysis state is malformed");

  verifyReviewedMigrationHashes();
  completed = true;
  log("- Real local Supabase → PostgREST → Next route → PostgreSQL proof: PASS");
}

async function stopServer() {
  if (!server || server.exitCode !== null) return;
  server.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise((resolve) => server.once("exit", () => resolve(true))),
    new Promise((resolve) => setTimeout(() => resolve(false), 5_000)),
  ]);
  if (!exited && server.exitCode === null) server.kill("SIGKILL");
}

try {
  await main();
} finally {
  await stopServer();
  if (!completed) log(`- Local HTTP proof did not complete; sanitized server tail: ${redact(serverOutput).split(/\r?\n/).slice(-12).join(" | ")}`);
}
