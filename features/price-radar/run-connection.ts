/** HTTP failure that carries its status, so the UI can tell a server error from a lost connection. */
export class RadarHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "RadarHttpError";
    this.status = status;
  }
}

export type RadarConnectionIssue = "offline" | "network" | "server" | "session";

/** Browser fetch failures ("Failed to fetch", Safari's "Load failed", Firefox's NetworkError) are transport errors, not server answers. */
export function isRadarNetworkError(reason: unknown): boolean {
  if (reason instanceof RadarHttpError) return false;
  if (!(reason instanceof Error)) return false;
  return reason.name === "TypeError" && /fetch|load failed|network/iu.test(reason.message)
    || /^(failed to fetch|load failed|networkerror)/iu.test(reason.message)
    || reason.name === "AbortError" || reason.name === "TimeoutError";
}

export function radarConnectionIssue(reason: unknown, online: boolean): RadarConnectionIssue | null {
  if (reason instanceof RadarHttpError) {
    if (reason.status === 401 || reason.status === 403) return "session";
    return reason.status >= 500 || reason.status === 408 || reason.status === 429 ? "server" : null;
  }
  if (isRadarNetworkError(reason)) return online ? "network" : "offline";
  return null;
}

const CONNECTION_MESSAGES: Record<RadarConnectionIssue, string> = {
  offline: "Brak połączenia z internetem. Skan źródeł HTTP działa na serwerze niezależnie od telefonu; stan odświeży się automatycznie po odzyskaniu połączenia.",
  network: "Nie udało się połączyć z serwerem Radaru (sieć lub aplikacja w tle). Ponowię próbę automatycznie.",
  server: "Serwer Radaru chwilowo nie odpowiada poprawnie. Zapisany postęp jest bezpieczny; ponowię próbę automatycznie.",
  session: "Sesja wygasła. Zaloguj się ponownie, aby zobaczyć aktualny stan Radaru.",
};

/** Operator-facing text: never the raw "Failed to fetch" from the browser. */
export function describeRadarRequestError(reason: unknown, fallback: string, online = typeof navigator === "undefined" ? true : navigator.onLine !== false): string {
  const issue = radarConnectionIssue(reason, online);
  if (issue) return CONNECTION_MESSAGES[issue];
  if (reason instanceof Error && reason.message.trim()) return reason.message;
  return fallback;
}

/** Poll cadence: fast while a run is unfinished, slower when idle, backing off after failures. */
export function radarRunPollDelayMs(input: { nonterminal: boolean; consecutiveFailures: number }): number {
  if (input.consecutiveFailures > 0) return Math.min(60_000, 15_000 * 2 ** (input.consecutiveFailures - 1));
  return input.nonterminal ? 5_000 : 45_000;
}

/**
 * The server continues a run right after each portion releases its lease. The
 * PWA only steps in once the lease has been expired for a grace period, so an
 * open phone does not race the server's own continuation every few seconds.
 */
export const RADAR_BROWSER_RESUME_GRACE_MS = 20_000;

export function radarLeaseExpiredForBrowserResume(leaseUntil: string | null | undefined, now = Date.now()): boolean {
  if (!leaseUntil) return true;
  const until = Date.parse(leaseUntil);
  return !Number.isFinite(until) || until + RADAR_BROWSER_RESUME_GRACE_MS <= now;
}
