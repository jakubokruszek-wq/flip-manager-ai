import { hostname } from "node:os";

export type WorkerConfig = {
  apiUrl: URL;
  secret: string;
  workerId: string;
  pollIntervalMs: number;
  once: boolean;
};

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const apiUrl = new URL(required(environment.OLX_WORKER_API_URL, "OLX_WORKER_API_URL"));
  if (apiUrl.protocol !== "https:" && apiUrl.hostname !== "localhost") throw new Error("OLX_WORKER_API_URL must use HTTPS.");
  const secret = required(environment.OLX_WORKER_SECRET, "OLX_WORKER_SECRET");
  if (secret.length < 32) throw new Error("OLX_WORKER_SECRET must contain at least 32 characters.");
  const pollIntervalMs = Number(environment.OLX_WORKER_POLL_INTERVAL_MS ?? 10_000);
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 2_000 || pollIntervalMs > 300_000) throw new Error("Invalid OLX_WORKER_POLL_INTERVAL_MS.");
  return { apiUrl, secret, workerId: (environment.OLX_WORKER_ID?.trim() || `windows-${hostname()}`).slice(0, 100), pollIntervalMs, once: environment.OLX_WORKER_ONCE === "1" };
}

function required(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`${name} is required.`);
  return value.trim();
}
