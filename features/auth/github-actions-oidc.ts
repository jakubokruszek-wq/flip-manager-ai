import "server-only";

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

export const GITHUB_ACTIONS_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
export const GITHUB_ACTIONS_OIDC_AUDIENCE = "flip-manager-finder-continuation";
export const GITHUB_ACTIONS_FINDER_SCHEDULER_AUDIENCE = "flip-manager-finder-scheduler";
export const GITHUB_ACTIONS_FACEBOOK_WATCH_AUDIENCE = "flip-manager-facebook-watch";
export const GITHUB_ACTIONS_REPOSITORY = "jakubokruszek-wq/flip-manager-ai";
export const GITHUB_ACTIONS_REPOSITORY_ID = "1298495415";
export const GITHUB_ACTIONS_REF = "refs/heads/main";
export const GITHUB_ACTIONS_WORKFLOW_REF = `${GITHUB_ACTIONS_REPOSITORY}/.github/workflows/finder-scan-continuation.yml@${GITHUB_ACTIONS_REF}`;
export const GITHUB_ACTIONS_FINDER_SCHEDULER_WORKFLOW_REF = `${GITHUB_ACTIONS_REPOSITORY}/.github/workflows/finder-scan-scheduler.yml@${GITHUB_ACTIONS_REF}`;
export const GITHUB_ACTIONS_FACEBOOK_WATCH_WORKFLOW_REF = `${GITHUB_ACTIONS_REPOSITORY}/.github/workflows/facebook-watch-scheduler.yml@${GITHUB_ACTIONS_REF}`;

const githubActionsJwks = createRemoteJWKSet(new URL(`${GITHUB_ACTIONS_OIDC_ISSUER}/.well-known/jwks`));
type VerificationKeySet = Parameters<typeof jwtVerify>[1];
type OidcVerifier = (token: string) => Promise<JWTPayload>;
type OidcPolicy = { audience: string; workflowRef: string };

const FINDER_CONTINUATION_POLICY: OidcPolicy = {
  audience: GITHUB_ACTIONS_OIDC_AUDIENCE,
  workflowRef: GITHUB_ACTIONS_WORKFLOW_REF,
};
const FINDER_SCHEDULER_POLICY: OidcPolicy = {
  audience: GITHUB_ACTIONS_FINDER_SCHEDULER_AUDIENCE,
  workflowRef: GITHUB_ACTIONS_FINDER_SCHEDULER_WORKFLOW_REF,
};
const FACEBOOK_WATCH_POLICY: OidcPolicy = {
  audience: GITHUB_ACTIONS_FACEBOOK_WATCH_AUDIENCE,
  workflowRef: GITHUB_ACTIONS_FACEBOOK_WATCH_WORKFLOW_REF,
};

/**
 * Verifies a GitHub Actions OIDC token cryptographically and then applies the
 * workflow's narrow trust policy. Claim strings are never trusted before the
 * jose signature, issuer, audience, exp and nbf checks have succeeded.
 */
async function verifyOidcWithPolicy(token: string, keySet: VerificationKeySet, policy: OidcPolicy): Promise<JWTPayload> {
  if (!token || token.length > 20_000) throw new Error("Invalid GitHub Actions OIDC token");
  const { payload } = await jwtVerify(token, keySet, {
    issuer: GITHUB_ACTIONS_OIDC_ISSUER,
    audience: policy.audience,
  });
  if (!Number.isInteger(payload.exp) || !Number.isInteger(payload.nbf)) {
    throw new Error("GitHub Actions OIDC token is missing exp or nbf");
  }

  if (payload.repository !== GITHUB_ACTIONS_REPOSITORY
    || String(payload.repository_id) !== GITHUB_ACTIONS_REPOSITORY_ID
    || payload.ref !== GITHUB_ACTIONS_REF
    || payload.workflow_ref !== policy.workflowRef) {
    throw new Error("GitHub Actions OIDC claims are not allowed");
  }
  return payload;
}

export async function verifyGitHubActionsOidc(token: string, keySet: VerificationKeySet = githubActionsJwks): Promise<JWTPayload> {
  return verifyOidcWithPolicy(token, keySet, FINDER_CONTINUATION_POLICY);
}

export async function verifyFinderSchedulerOidc(token: string, keySet: VerificationKeySet = githubActionsJwks): Promise<JWTPayload> {
  return verifyOidcWithPolicy(token, keySet, FINDER_SCHEDULER_POLICY);
}

export async function verifyFacebookWatchOidc(token: string, keySet: VerificationKeySet = githubActionsJwks): Promise<JWTPayload> {
  return verifyOidcWithPolicy(token, keySet, FACEBOOK_WATCH_POLICY);
}

/**
 * Keeps the existing CRON_SECRET path and adds signed GitHub Actions OIDC as
 * a second, non-public path. `additionalSecret` is a third, narrower
 * accepted credential for a specific caller (see FINDER_CRON_SECRET below)
 * -- it is never required, only ever additive, and is checked the same way
 * CRON_SECRET already is. The token itself is never logged or returned.
 */
async function authorizeScheduledRequest(request: Request, verifyOidc: OidcVerifier, additionalSecret?: string | null): Promise<boolean> {
  const authorization = request.headers.get("authorization");
  const bearer = authorization?.match(/^Bearer\s+(.+)$/i)?.[1] ?? null;
  const suppliedSecret = bearer ?? request.headers.get("x-cron-secret");
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && suppliedSecret === cronSecret) return true;
  if (additionalSecret && suppliedSecret === additionalSecret) return true;
  if (!bearer) return false;
  try {
    await verifyOidc(bearer);
    return true;
  } catch {
    return false;
  }
}

/**
 * FINDER_CRON_SECRET is a separate, narrowly-scoped shared secret accepted
 * ONLY by the two Finder cron endpoints (this function and
 * authorizeFinderSchedulerRequest below) -- never by Facebook Watch or any
 * other CRON_SECRET-protected route. It exists so a free external trigger
 * (e.g. cron-job.org) never needs the general CRON_SECRET, which also
 * protects facebook-watch and listing-lifecycle: a leak of this one value
 * can only ever reach Finder's own scheduler/continuation, nothing else.
 * GitHub Actions' own signed OIDC path (verifyGitHubActionsOidc/
 * verifyFinderSchedulerOidc) is unchanged and remains fully valid alongside
 * it, so it keeps working the moment GitHub's schedule delivery does.
 */
export async function authorizeContinuationRequest(request: Request, verifyOidc: OidcVerifier = verifyGitHubActionsOidc): Promise<boolean> {
  return authorizeScheduledRequest(request, verifyOidc, process.env.FINDER_CRON_SECRET);
}

export async function authorizeFinderSchedulerRequest(request: Request, verifyOidc: OidcVerifier = verifyFinderSchedulerOidc): Promise<boolean> {
  return authorizeScheduledRequest(request, verifyOidc, process.env.FINDER_CRON_SECRET);
}

export async function authorizeFacebookWatchRequest(request: Request, verifyOidc: OidcVerifier = verifyFacebookWatchOidc): Promise<boolean> {
  return authorizeScheduledRequest(request, verifyOidc);
}
