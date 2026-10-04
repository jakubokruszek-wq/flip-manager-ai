import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test, { mock } from "node:test";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWTPayload } from "jose";

mock.module("server-only", { defaultExport: {} });

const {
  GITHUB_ACTIONS_OIDC_AUDIENCE,
  GITHUB_ACTIONS_OIDC_ISSUER,
  GITHUB_ACTIONS_REF,
  GITHUB_ACTIONS_REPOSITORY,
  GITHUB_ACTIONS_REPOSITORY_ID,
  GITHUB_ACTIONS_WORKFLOW_REF,
  authorizeContinuationRequest,
  verifyGitHubActionsOidc,
} = await import("./github-actions-oidc.ts");

const { privateKey, publicKey } = await generateKeyPair("RS256");
const publicJwk = await exportJWK(publicKey);
const localJwkSet = createLocalJWKSet({ keys: [{ ...publicJwk, kid: "test-key", alg: "RS256", use: "sig" }] });

function claims(overrides: Record<string, unknown> = {}) {
  return {
    repository: GITHUB_ACTIONS_REPOSITORY,
    repository_id: GITHUB_ACTIONS_REPOSITORY_ID,
    ref: GITHUB_ACTIONS_REF,
    workflow_ref: GITHUB_ACTIONS_WORKFLOW_REF,
    ...overrides,
  };
}

async function token(overrides: Record<string, unknown> = {}, options: { key?: CryptoKey; expiration?: string | number } = {}) {
  return new SignJWT(claims(overrides))
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(GITHUB_ACTIONS_OIDC_ISSUER)
    .setAudience(GITHUB_ACTIONS_OIDC_AUDIENCE)
    .setIssuedAt()
    .setNotBefore("0s")
    .setExpirationTime(options.expiration ?? "10m")
    .sign(options.key ?? privateKey);
}

test("accepts a valid signed GitHub Actions token with the exact workflow claims", async () => {
  const signed = await token();
  await assert.doesNotReject(() => verifyGitHubActionsOidc(signed, localJwkSet));
});

test("rejects a token with an invalid signature", async () => {
  const other = await generateKeyPair("RS256");
  const signed = await token({}, { key: other.privateKey });
  await assert.rejects(() => verifyGitHubActionsOidc(signed, localJwkSet));
});

for (const [label, override] of [
  ["repository", { repository: "someone-else/flip-manager-ai" }],
  ["repository id", { repository_id: "1" }],
  ["branch", { ref: "refs/heads/release" }],
  ["workflow", { workflow_ref: `${GITHUB_ACTIONS_REPOSITORY}/.github/workflows/other.yml@${GITHUB_ACTIONS_REF}` }],
  ["issuer", { __issuer: "https://example.invalid" }],
  ["audience", { __audience: "another-service" }],
] as const) {
  test(`rejects a token with an invalid ${label}`, async () => {
    const overrides: Record<string, unknown> = { ...override };
    const issuer = typeof overrides.__issuer === "string" ? overrides.__issuer : GITHUB_ACTIONS_OIDC_ISSUER;
    const audience = typeof overrides.__audience === "string" ? overrides.__audience : GITHUB_ACTIONS_OIDC_AUDIENCE;
    delete overrides.__issuer;
    delete overrides.__audience;
    const signed = await new SignJWT(claims(overrides))
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(issuer)
      .setAudience(audience)
      .setIssuedAt()
      .setNotBefore("0s")
      .setExpirationTime("10m")
      .sign(privateKey);
    await assert.rejects(() => verifyGitHubActionsOidc(signed, localJwkSet));
  });
}

test("rejects expired and not-yet-valid tokens", async () => {
  const expired = await token({}, { expiration: Math.floor(Date.now() / 1000) - 60 });
  await assert.rejects(() => verifyGitHubActionsOidc(expired, localJwkSet));
  const future = new SignJWT(claims()).setProtectedHeader({ alg: "RS256", kid: "test-key" }).setIssuer(GITHUB_ACTIONS_OIDC_ISSUER).setAudience(GITHUB_ACTIONS_OIDC_AUDIENCE).setNotBefore(Math.floor(Date.now() / 1000) + 120).setExpirationTime("10m").sign(privateKey);
  const futureSigned = await future;
  await assert.rejects(() => verifyGitHubActionsOidc(futureSigned, localJwkSet));
});

test("requires both exp and nbf claims instead of accepting an otherwise signed token", async () => {
  const missingNbf = await new SignJWT(claims()).setProtectedHeader({ alg: "RS256", kid: "test-key" }).setIssuer(GITHUB_ACTIONS_OIDC_ISSUER).setAudience(GITHUB_ACTIONS_OIDC_AUDIENCE).setExpirationTime("10m").sign(privateKey);
  await assert.rejects(() => verifyGitHubActionsOidc(missingNbf, localJwkSet));
  const missingExp = await new SignJWT(claims()).setProtectedHeader({ alg: "RS256", kid: "test-key" }).setIssuer(GITHUB_ACTIONS_OIDC_ISSUER).setAudience(GITHUB_ACTIONS_OIDC_AUDIENCE).setNotBefore("0s").sign(privateKey);
  await assert.rejects(() => verifyGitHubActionsOidc(missingExp, localJwkSet));
});

test("anonymous continuation requests are denied while CRON_SECRET and verified OIDC are accepted", async () => {
  const previous = process.env.CRON_SECRET;
  try {
    process.env.CRON_SECRET = "local-test-secret";
    assert.equal(await authorizeContinuationRequest(new Request("https://example.test")), false);
    assert.equal(await authorizeContinuationRequest(new Request("https://example.test", { headers: { "x-cron-secret": "wrong" } })), false);
    assert.equal(await authorizeContinuationRequest(new Request("https://example.test", { headers: { "x-cron-secret": "local-test-secret" } })), true);
    const oidcAccepted = await authorizeContinuationRequest(
      new Request("https://example.test", { headers: { authorization: "Bearer oidc-token" } }),
      async (value) => value === "oidc-token" ? {} as JWTPayload : Promise.reject(new Error("unexpected token")),
    );
    assert.equal(oidcAccepted, true);
    const invalidOidcRejected = await authorizeContinuationRequest(
      new Request("https://example.test", { headers: { authorization: "Bearer invalid" } }),
      async () => { throw new Error("invalid"); },
    );
    assert.equal(invalidOidcRejected, false);
  } finally {
    if (previous === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previous;
  }
});

test("workflow is hourly, bounded, serialized, and only calls the continuation endpoint", () => {
  const workflow = readFileSync(join(process.cwd(), ".github", "workflows", "finder-scan-continuation.yml"), "utf8");
  assert.match(workflow, /cron:\s*["']7 \* \* \* \*["']/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /concurrency:/);
  assert.match(workflow, /id-token:\s*write/);
  assert.match(workflow, /max_requests=4/);
  assert.match(workflow, /api\/jobs\/finder-scan-continuation/);
  assert.match(workflow, /flip-manager-finder-continuation/);
  assert.doesNotMatch(workflow, /manual-scan|\/scan["'\s]|facebook_scan_jobs/);
  const continuationRoute = readFileSync(join(process.cwd(), "app", "api", "jobs", "finder-scan-continuation", "route.ts"), "utf8");
  assert.match(continuationRoute, /export const maxDuration = 60/);
  const scanRoute = readFileSync(join(process.cwd(), "app", "api", "flip-finder", "search-filters", "[id]", "scan", "route.ts"), "utf8");
  assert.match(scanRoute, /export const maxDuration = 60/);
  const vercel = readFileSync(join(process.cwd(), "vercel.json"), "utf8");
  assert.match(vercel, /api\/jobs\/facebook-watch/);
  assert.doesNotMatch(vercel, /api\/jobs\/finder-scan-continuation/);
});
