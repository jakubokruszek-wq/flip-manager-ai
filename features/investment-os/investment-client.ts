import type { CanonicalDeal } from "./types";

type ApiBody = { ok?: boolean; code?: string; message?: string; deal?: CanonicalDeal };
type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export async function loadInvestmentDeal(listingId: string, request: Fetcher = fetch): Promise<CanonicalDeal> {
  const url = `/api/flip-finder/listings/${listingId}/investment`;
  const response = await request(url, { cache: "no-store" });
  const body = await response.json() as ApiBody;
  if (response.status === 404 && body.code === "NOT_COMPUTED") {
    const initialized = await request(`${url}/initialize`, { method: "POST", headers: { "x-flip-finder-action": "investment-os" } });
    const initializedBody = await initialized.json() as ApiBody;
    if (!initialized.ok || !initializedBody.deal) throw new Error(initializedBody.message ?? initializedBody.code ?? "Investment Desk nie udało się zainicjalizować");
    return initializedBody.deal;
  }
  if (!response.ok || !body.deal) throw new Error(body.message ?? body.code ?? "Investment Desk niedostępny");
  return body.deal;
}
