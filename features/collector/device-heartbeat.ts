export function collectorDeviceActivityPatch(now: string, markHealthy: boolean): {
  last_used_at: string;
  last_heartbeat_at: string;
  health_status?: "HEALTHY";
} {
  return {
    last_used_at: now,
    last_heartbeat_at: now,
    ...(markHealthy ? { health_status: "HEALTHY" as const } : {}),
  };
}
