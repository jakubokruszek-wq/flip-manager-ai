/** Minimum total asking price for a concrete apartment offered for sale. */
export const MIN_TOTAL_SALE_PRICE_PLN = 160_000;

export function isSaleListingIntent(value: string | null | undefined): boolean {
  return value === null || value === undefined || value === "SELL_PROPERTY" || value === "UNKNOWN";
}

export function isKnownNonSaleListingIntent(value: string | null | undefined): boolean {
  return value !== null && value !== undefined && value !== "SELL_PROPERTY" && value !== "UNKNOWN";
}

export function isBelowMinimumSalePrice(price: number | null, listingIntent?: string | null): boolean {
  return isSaleListingIntent(listingIntent) && price !== null && Number.isFinite(price) && price < MIN_TOTAL_SALE_PRICE_PLN;
}
