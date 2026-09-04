import { resolveActualRoomCount, resolveFacebookPrice } from "./extract-facebook-property.ts";
import { resolveFacebookListingIntent } from "./facebook-intent.ts";

export type DeterministicFacebookSellFacts = {
  complete: boolean;
  price: number | null;
  pricePerM2: number | null;
  area: number | null;
  rooms: number | null;
};

const number = (value: string | undefined): number | null => value
  ? Number(value.replace(",", ".").replace(/\s/g, ""))
  : null;

/**
 * Resolves only fields explicitly present in authoritative Facebook text.
 * It deliberately performs no location inference and never uses Vision data.
 */
export function resolveDeterministicFacebookSellFacts(text: string | null | undefined): DeterministicFacebookSellFacts {
  const authoritativeText = text?.trim() ?? "";
  const intent = resolveFacebookListingIntent(authoritativeText, null, null);
  const area = number(authoritativeText.match(/(\d{1,3}(?:[.,]\d+)?)\s*m(?:2|\u00b2)(?![\p{L}\d])/iu)?.[1]);
  const explicitRooms = resolveActualRoomCount(authoritativeText);
  const mRooms = number(authoritativeText.match(/\bM(\d)\b/iu)?.[1]);
  const rooms = explicitRooms ?? (mRooms === null ? null : Math.max(1, mRooms - 1));
  const price = resolveFacebookPrice(authoritativeText, area);
  return {
    complete: intent.intent === "SELL_PROPERTY" && price.price !== null && area !== null && rooms !== null,
    price: price.price,
    pricePerM2: price.pricePerM2,
    area,
    rooms,
  };
}
