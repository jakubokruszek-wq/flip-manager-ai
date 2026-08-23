export const REMOVAL_MISS_THRESHOLD = 3;
export const DEFAULT_REVALIDATION_BATCH_SIZE = 20;

export type AvailabilityResult = "available" | "explicit_removed" | "ambiguous_missing" | "temporary_failure";
export type ListingLifecycleState = { status: "active" | "removed"; missCount: number; removedAt: string | null };
export type ListingLifecycleTransition = ListingLifecycleState & { result: AvailabilityResult; statusChanged: boolean };

export function classifyAvailabilityResponse(input: { source: string; status: number; body?: string }): AvailabilityResult {
  if (input.status === 404 || input.status === 410) return "explicit_removed";
  if (input.status === 401 || input.status === 403 || input.status === 429 || input.status >= 500) return "temporary_failure";
  if (input.status >= 400) return "ambiguous_missing";
  const body = (input.body ?? "").normalize("NFKC").toLocaleLowerCase("pl-PL");
  if (hasTemporaryPage(body)) return "temporary_failure";
  if (hasExplicitRemoval(input.source, body)) return "explicit_removed";
  return "available";
}

export function transitionListingLifecycle(state: ListingLifecycleState, result: AvailabilityResult, now: string): ListingLifecycleTransition {
  if (result === "available") return { status: "active", missCount: 0, removedAt: null, result, statusChanged: state.status !== "active" };
  if (result === "temporary_failure") return { ...state, result, statusChanged: false };
  const missCount = result === "explicit_removed" ? Math.max(state.missCount, REMOVAL_MISS_THRESHOLD) : state.missCount + 1;
  const remove = result === "explicit_removed" || missCount >= REMOVAL_MISS_THRESHOLD;
  return { status: remove ? "removed" : state.status, missCount, removedAt: remove ? state.removedAt ?? now : state.removedAt, result, statusChanged: remove && state.status !== "removed" };
}

export function nextAvailabilityCheck(result: AvailabilityResult, now: Date): string {
  const hours = result === "available" ? 7 * 24 : result === "temporary_failure" ? 24 : result === "ambiguous_missing" ? 24 : 30 * 24;
  return new Date(now.getTime() + hours * 3_600_000).toISOString();
}

export function isTemporaryAvailabilityError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "TimeoutError" || error instanceof TypeError;
}

function hasTemporaryPage(body: string): boolean {
  return /captcha|human verification|access denied|zaloguj się|log in|temporarily unavailable|spróbuj ponownie/.test(body);
}

function hasExplicitRemoval(source: string, body: string): boolean {
  const generic = /ogłoszenie (zostało usunięte|nie jest już dostępne)|oferta (została usunięta|nie jest już dostępna)|content (isn't|is not) available|treść jest niedostępna/;
  if (generic.test(body)) return true;
  if (source === "facebook") return /ten materiał został usunięty|this content was deleted/.test(body);
  if (source === "olx") return /to ogłoszenie nie jest już dostępne|ogłoszenie zakończone/.test(body);
  return false;
}
