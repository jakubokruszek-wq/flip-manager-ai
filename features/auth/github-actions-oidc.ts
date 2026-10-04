import "server-only";

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

export const GITHUB_ACTIONS_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
export const GITHUB_ACTIONS_OIDC_AUDIENCE = "flip-manager-finder-continuation";
export const GITHUB_ACTIONS_REPOSITORY = "jakubokruszek-wq/flip-manager-ai";
export const GITHUB_ACTIONS_REPOSITORY_ID = "1298495415";
export const GITHUB_ACTIONS_REF = "refs/heads/main";
export const GITHUB_ACTIONS_WORKFLOW_REF = `${GITHUB_ACTIONS_REPOSITORY}/.github/workflows/finder-scan-continuation.yml@${GITHUB_ACTIONS_REF}`;

const githubActionsJwks = createRemoteJWKSet(new URL(`${GITHUB_ACTIONS_OIDC_ISSUER}/.well-known/jwks`));
type VerificationKeySet = Parameters<typeof jwtVerify>[1];
type OidcVerifier = (token: string) => Promise<JWTPayload>;

/**
 * Verifies a GitHub Actions OIDC token cryptographically and then applies the
 * workflow's narrow trust policy. Claim strings are never trusted before the
 * jose signature, issuer, audience, exp and nbf checks have succeeded.
 */
export async function verifyGitHubActionsOidc(token: string, keySet: VerificationKeySet = githubActionsJwks): Promise<JWTPayload> {
  if (!token || token.length > 20_000) throw new Error("Invalid GitHub Actions OIDC token");
  const { payload } = await jwtVerify(token, keySet, {
    issuer: GITHUB_ACTIONS_OIDC_ISSUER,
    audience: GITHUB_ACTIONS_OIDC_AUDIENCE,
  });
  if (!Number.isInteger(payload.exp) || !Number.isInteger(payload.nbf)) {
    throw new Error("GitHub Actions OIDC token is missing exp or nbf");
  }

  if (payload.repository !== GITHUB_ACTIONS_REPOSITORY
    || String(payload.repository_id) !== GITHUB_ACTIONS_REPOSITORY_ID
    || payload.ref !== GITHUB_ACTIONS_REF
    || payload.workflow_ref !== GITHUB_ACTIONS_WORKFLOW_REF) {
    throw new Error("GitHub Actions OIDC claims are not allowed");
  }
  return payload;
}

/**
 * Keeps the existing CRON_SECRET path and adds signed GitHub Actions OIDC as
 * a second, non-public path. The token itself is never logged or returned.
 */
export async function authorizeContinuationRequest(request: Request, verifyOidc: OidcVerifier = verifyGitHubActionsOidc): Promise<boolean> {
  const authorization = request.headers.get("authorization");
  const bearer = authorization?.match(/^Bearer\s+(.+)$/i)?.[1] ?? null;
  const suppliedSecret = bearer ?? request.headers.get("x-cron-secret");
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && suppliedSecret === cronSecret) return true;
  if (!bearer) return false;
  try {
    await verifyOidc(bearer);
    return true;
  } catch {
    return false;
  }
}
