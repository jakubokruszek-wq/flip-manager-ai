/**
 * One JSON object per line on stdout. `level` and `message` are the fields
 * Railway (and most log collectors) use for severity and the headline; every
 * other key becomes a searchable attribute (e.g. `@event:JOB_SUMMARY`).
 */
export function log(event: string, data: Record<string, unknown> = {}): void {
  const { message, ...attributes } = data;
  const headline = message === undefined ? event : `${event}: ${String(message)}`;
  process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), level: logLevel(event), message: headline, event, ...attributes })}\n`);
}

export function logLevel(event: string): "error" | "warn" | "info" {
  if (/(?:_ERROR|_FATAL|_STALL)$/.test(event)) return "error";
  if (/(?:_FAIL|_COOLDOWN|_SHUTDOWN)$/.test(event)) return "warn";
  return "info";
}
