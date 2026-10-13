const MAX_DEPLOYMENT_ID_LENGTH = 32;
const VALID_DEPLOYMENT_ID = /^[A-Za-z0-9_-]+$/;

function isValidDeploymentId(value) {
  return Boolean(
    value &&
      value.length <= MAX_DEPLOYMENT_ID_LENGTH &&
      !value.startsWith("dpl_") &&
      VALID_DEPLOYMENT_ID.test(value),
  );
}

/**
 * Resolve a custom Next.js deployment ID for Vercel skew protection.
 * Vercel's generated deployment ID is unique per deployment; removing its
 * reserved prefix makes it valid as a custom Next.js deployment ID.
 * @param {Record<string, string | undefined>} env
 * @returns {string | undefined}
 */
export function resolveNextDeploymentId(env) {
  const platformId = env.VERCEL_DEPLOYMENT_ID?.replace(/^dpl_/, "");
  if (isValidDeploymentId(platformId)) return platformId;

  // If Vercel has not exposed its per-deployment ID, leave skew protection to
  // the platform rather than reusing a commit ID across redeployments.
  if (env.VERCEL === "1") return undefined;

  const commitSha =
    env.VERCEL_GIT_COMMIT_SHA ??
    env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA ??
    env.NEXT_PUBLIC_COMMIT_SHA;
  const fallback = commitSha
    ?.replace(/^dpl_/, "")
    .replace(/[^A-Za-z0-9_-]/g, "")
    .slice(0, MAX_DEPLOYMENT_ID_LENGTH);
  return isValidDeploymentId(fallback) ? fallback : undefined;
}
