import { collectorSigningKey } from "../protocol.ts";
/** Configuration for a separately approved synthetic test deployment.
 * This module never reads production Supabase credentials. */
export function offlineTestOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
      url.hostname === "flip-manager-ai.vercel.app" || url.hostname.endsWith(".supabase.co") ||
      ["localhost", "127.0.0.1", "10.0.2.2"].includes(url.hostname)) throw Error("OFFLINE_TEST_ORIGIN_INVALID");
  return url.origin;
}
export function remoteOfflineTestConfig(env: Readonly<Record<string, string | undefined>>) {
  if (env.FLIP_OFFLINE_REMOTE_TEST !== "true") return null;
  // A dedicated process/database is mandatory. Never use this in Next routes.
  if (env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY || env.OPENAI_API_KEY ||
      env.FACEBOOK_ANDROID_QUEUE_ENABLED === "true" || env.FACEBOOK_ANDROID_INTEGRATION_ENABLED === "true")
    throw Error("OFFLINE_TEST_PRODUCTION_CONFIG_FORBIDDEN");
  const origin = offlineTestOrigin(env.FLIP_OFFLINE_TEST_ORIGIN ?? "");
  const signingKey = env.FLIP_OFFLINE_DEVICE_SIGNING_KEY ?? "";
  if (!/^[a-f0-9]{64}$/.test(signingKey) || signingKey === collectorSigningKey("isolated-ci-device-token")) throw Error("OFFLINE_TEST_DEVICE_KEY_REQUIRED");
  const expiresAt = Number(env.FLIP_OFFLINE_TEST_EXPIRES_AT);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + 7 * 86400_000)
    throw Error("OFFLINE_TEST_EXPIRY_REQUIRED");
  return { origin, signingKey, expiresAt };
}
