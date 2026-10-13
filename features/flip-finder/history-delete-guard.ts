/**
 * Guard for "Usuń wszystkie oferty" (formerly "Wyczyść historię
 * wyszukiwania"). The operation permanently deletes every Finder listing of
 * every filter and portal, with its price history, photos and memberships.
 *
 * It is therefore:
 * - disabled unless FLIP_FINDER_HISTORY_DELETE_ENABLED=true on the server;
 * - accepted only with the exact typed confirmation phrase;
 * - accepted only for the listing count the operator was shown, so a scan or
 *   another operator changing the data in between cancels the request.
 */
export const HISTORY_DELETE_CONFIRMATION = "USUŃ WSZYSTKIE OFERTY";
export const HISTORY_DELETE_ENV = "FLIP_FINDER_HISTORY_DELETE_ENABLED";

export function historyDeleteEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[HISTORY_DELETE_ENV] === "true";
}

export type HistoryDeleteRequest = { confirmation: string; expectedListings: number };

export type HistoryDeleteValidation =
  | { ok: true }
  | { ok: false; status: 400 | 409; code: "HISTORY_DELETE_CONFIRMATION_REQUIRED" | "HISTORY_DELETE_COUNT_CHANGED"; message: string };

export function validateHistoryDeleteRequest(body: unknown, currentListings: number): HistoryDeleteValidation {
  const record = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  if (record.confirmation !== HISTORY_DELETE_CONFIRMATION || typeof record.expectedListings !== "number" || !Number.isInteger(record.expectedListings)) {
    return { ok: false, status: 400, code: "HISTORY_DELETE_CONFIRMATION_REQUIRED", message: `Wpisz dokładnie „${HISTORY_DELETE_CONFIRMATION}”, aby potwierdzić trwałe usunięcie.` };
  }
  if (record.expectedListings !== currentListings) {
    return { ok: false, status: 409, code: "HISTORY_DELETE_COUNT_CHANGED", message: `Liczba ofert zmieniła się (było ${record.expectedListings}, jest ${currentListings}). Otwórz okno ponownie i sprawdź, co zostanie usunięte.` };
  }
  return { ok: true };
}
