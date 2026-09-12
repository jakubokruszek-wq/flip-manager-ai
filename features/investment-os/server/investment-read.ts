import type { CanonicalDeal } from "../types";

export async function investmentDealReadResponse(
  listingId: string,
  read: (id: string) => Promise<CanonicalDeal | null>,
): Promise<Response> {
  const deal = await read(listingId);
  return deal
    ? Response.json({ ok: true, deal })
    : Response.json({ ok: false, code: "NOT_COMPUTED" }, { status: 404 });
}
