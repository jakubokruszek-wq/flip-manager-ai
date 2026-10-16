import { hostname } from "node:os";

export type WorkerConfig = {
  apiUrl: URL;
  secret: string;
  workerId: string;
  pollIntervalMs: number;
  once: boolean;
  /** First pause after OLX refuses access (403/405/429/CAPTCHA); doubles on repeats. */
  blockCooldownMs: number;
  /** Upper bound for the doubling block cooldown. */
  maxBlockCooldownMs: number;
  /** How often a WORKER_STATUS monitoring line is written. */
  statusLogIntervalMs: number;
};

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const apiUrl = new URL(required(environment.OLX_WORKER_API_URL, "OLX_WORKER_API_URL"));
  if (apiUrl.protocol !== "https:" && apiUrl.hostname !== "localhost") throw new Error("OLX_WORKER_API_URL must use HTTPS.");
  const secret = required(environment.OLX_WORKER_SECRET, "OLX_WORKER_SECRET");
  if (secret.length < 32) throw new Error("OLX_WORKER_SECRET must contain at least 32 characters.");
  const pollIntervalMs = Number(environment.OLX_WORKER_POLL_INTERVAL_MS ?? 10_000);
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 2_000 || pollIntervalMs > 300_000) throw new Error("Invalid OLX_WORKER_POLL_INTERVAL_MS.");
  const blockCooldownMs = integerInRange(environment.OLX_WORKER_BLOCK_COOLDOWN_MS, 900_000, 1_000, 21_600_000, "OLX_WORKER_BLOCK_COOLDOWN_MS");
  const statusLogIntervalMs = integerInRange(environment.OLX_WORKER_STATUS_LOG_INTERVAL_MS, 300_000, 1_000, 3_600_000, "OLX_WORKER_STATUS_LOG_INTERVAL_MS");
  return {
    apiUrl,
    secret,
    workerId: (environment.OLX_WORKER_ID?.trim() || defaultWorkerId(environment)).slice(0, 100),
    pollIntervalMs,
    once: environment.OLX_WORKER_ONCE === "1",
    blockCooldownMs,
    maxBlockCooldownMs: Math.max(blockCooldownMs, Math.min(blockCooldownMs * 8, 21_600_000)),
    statusLogIntervalMs,
  };
}

function defaultWorkerId(environment: NodeJS.ProcessEnv): string {
  // Railway injects RAILWAY_REPLICA_ID into every running replica.
  const replica = environment.RAILWAY_REPLICA_ID?.trim();
  if (replica) return `railway-${replica.slice(0, 12)}`;
  return `windows-${hostname()}`;
}

function integerInRange(value: string | undefined, fallback: number, min: number, max: number, name: string): number {
  const parsed = Number(value?.trim() || fallback);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`Invalid ${name}.`);
  return parsed;
}

function required(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`${name} is required.`);
  return value.trim();
}
