import { hostname } from "node:os";
import { join, resolve } from "node:path";

export type FacebookWorkerConfig = { apiUrl: URL; secret: string; workerId: string; profileDir: string; pollIntervalMs: number; once: boolean };

export function resolveFacebookProfileDir(environment: NodeJS.ProcessEnv = process.env): string {
  const localAppData = environment.LOCALAPPDATA?.trim();
  const configured = environment.FACEBOOK_WORKER_PROFILE_DIR?.trim();
  const expanded = configured?.replace(/%LOCALAPPDATA%/gi, localAppData ?? "") || (localAppData ? join(localAppData, "FlipManager", "facebook-worker-profile") : "");
  if (!expanded) throw new Error("FACEBOOK_WORKER_PROFILE_DIR or LOCALAPPDATA is required.");
  const profileDir = resolve(expanded);
  if (/(^|[\\/])(google[\\/]chrome|microsoft[\\/]edge)[\\/]user data([\\/]|$)/i.test(profileDir)) throw new Error("Do not use a personal Chrome or Edge profile.");
  return profileDir;
}

export function loadFacebookWorkerConfig(environment: NodeJS.ProcessEnv = process.env): FacebookWorkerConfig {
  const apiUrl = new URL(required(environment.FACEBOOK_WORKER_API_URL, "FACEBOOK_WORKER_API_URL"));
  if (apiUrl.protocol !== "https:" && apiUrl.hostname !== "localhost") throw new Error("FACEBOOK_WORKER_API_URL must use HTTPS.");
  const secret = required(environment.FACEBOOK_WORKER_SECRET, "FACEBOOK_WORKER_SECRET");
  if (secret.length < 32) throw new Error("FACEBOOK_WORKER_SECRET must contain at least 32 characters.");
  const pollIntervalMs = Number(environment.FACEBOOK_WORKER_POLL_INTERVAL_MS ?? 10_000);
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 2_000 || pollIntervalMs > 300_000) throw new Error("Invalid FACEBOOK_WORKER_POLL_INTERVAL_MS.");
  return { apiUrl, secret, workerId: (environment.FACEBOOK_WORKER_ID?.trim() || `windows-${hostname()}`).slice(0, 100), profileDir: resolveFacebookProfileDir(environment), pollIntervalMs, once: environment.FACEBOOK_WORKER_ONCE === "1" };
}

function required(value: string | undefined, name: string): string { if (!value?.trim()) throw new Error(`${name} is required.`); return value.trim(); }

