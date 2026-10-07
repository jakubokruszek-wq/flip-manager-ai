import type { PropertySourceListing } from "@/features/properties/types/property";

/** A canonical sale amount must be a finite positive total price in PLN. */
export function isValidSalePrice(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function validSaleListings<T extends Pick<PropertySourceListing, "source" | "price">>(
  listings: readonly T[],
): { listings: T[]; skipped: number } {
  let skipped = 0;
  const kept = listings.filter((listing) => {
    // Facebook's historical missing-price behavior is intentional and stays
    // unchanged. Every portal/official/OLX listing must carry a total sale price.
    if (listing.source === "facebook" || isValidSalePrice(listing.price)) return true;
    skipped += 1;
    return false;
  });
  return { listings: kept, skipped };
}

export function invalidSalePriceWarning(count: number): string | null {
  return count > 0 ? `INVALID_SALE_PRICE: pominięto ${count} ofert bez poprawnej całkowitej ceny sprzedaży.` : null;
}
