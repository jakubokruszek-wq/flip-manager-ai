import type { CanonicalDeal } from "./types";

type ApiBody = { ok?: boolean; code?: string; message?: string; deal?: CanonicalDeal; media?: string[] };
type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class InvestmentDealNotComputedError extends Error {
  constructor() {
    super("Analiza nie została jeszcze przygotowana.");
    this.name = "InvestmentDealNotComputedError";
  }
}

/** A `CanonicalDeal` plus its presentation-only listing photos, never part of the deal's facts or fingerprint. */
export type DealWithMedia = CanonicalDeal & { media?: string[] };

export async function loadInvestmentDeal(listingId: string, request: Fetcher = fetch): Promise<CanonicalDeal> {
  const url = `/api/flip-finder/listings/${listingId}/investment`;
  const response = await request(url, { cache: "no-store" });
  const body = await response.json() as ApiBody;
  if (response.status === 404 && body.code === "NOT_COMPUTED") {
    throw new InvestmentDealNotComputedError();
  }
  if (!response.ok || !body.deal) throw new Error(investmentErrorMessage(body, "Analiza inwestycyjna jest obecnie niedostępna."));
  if (Array.isArray(body.media)) (body.deal as DealWithMedia).media = body.media;
  return body.deal;
}

function investmentErrorMessage(body: ApiBody, fallback: string): string {
  if (typeof body.message === "string" && body.message.trim()) return body.message;
  if (body.code === "NOT_FOUND") return "Nie znaleziono oferty, dla której można przygotować analizę.";
  if (body.code === "NOT_COMPUTED") return "Analiza nie została jeszcze przygotowana.";
  if (body.code === "INVESTMENT_DEAL_VERSION_CONFLICT") return "Analiza zmieniła się w innym widoku. Odśwież stronę i spróbuj ponownie.";
  return fallback;
}
