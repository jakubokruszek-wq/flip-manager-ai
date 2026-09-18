export function scanStatus(error: unknown): number {
  return typeof error === "object" && error !== null && "status" in error && typeof error.status === "number"
    ? error.status
    : 500;
}

export const FACEBOOK_SOURCE_NOT_CONFIGURED_CODE = "FACEBOOK_PRODUCTION_SOURCE_NOT_CONFIGURED";

/**
 * Classifies why a Facebook scan could not be queued. Every case here is an
 * operator-fixable precondition, so it must not reach the client as a generic
 * 500 carrying an internal token — that is indistinguishable from a crash and
 * leaves no way to tell that no scan was ever created.
 */
export function facebookScanStartFailure(errorMessage: string | null): { status: number; code: string } | null {
  const message = errorMessage ?? "";
  if (/COLLECTOR_(?:OFFLINE|READINESS_QUERY_FAILED)/.test(message)) {
    return { status: 503, code: message.startsWith("COLLECTOR_OFFLINE") ? "COLLECTOR_OFFLINE" : "COLLECTOR_READINESS_UNAVAILABLE" };
  }
  if (message.includes(FACEBOOK_SOURCE_NOT_CONFIGURED_CODE)) {
    return { status: 503, code: FACEBOOK_SOURCE_NOT_CONFIGURED_CODE };
  }
  return null;
}

const SCAN_START_MESSAGES: Record<string, string> = {
  COLLECTOR_OFFLINE: "Facebook Collector jest offline lub nie ma świeżego heartbeat.",
  COLLECTOR_READINESS_UNAVAILABLE: "Nie udało się sprawdzić gotowości Facebook Collectora.",
  [FACEBOOK_SOURCE_NOT_CONFIGURED_CODE]: "Skan nie wystartował: żadna obsługiwana grupa Facebooka nie jest włączona. Włącz grupę na liście grup Facebooka i spróbuj ponownie.",
};

export function scanStartErrorMessage(message: string): string {
  return SCAN_START_MESSAGES[message] ?? message;
}
