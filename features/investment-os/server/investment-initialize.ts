export async function investmentInitializeResponse<T>(
  listingId: string,
  initialize: (id: string) => Promise<T | null>,
): Promise<Response> {
  const deal = await initialize(listingId);
  return deal
    ? Response.json({ ok: true, deal })
    : Response.json({ ok: false, code: "NOT_FOUND" }, { status: 404 });
}
