import type { FacebookListingInput, FacebookProperty } from "./types";
import { resolveLocation } from "../location-intelligence/resolve-location.ts";
import { resolveFacebookListingIntent } from "./facebook-intent.ts";

const PLACES = [
  ["radogoszcz zachód", "Radogoszcz Zachód", "Bałuty"], ["radogoszcz", "Radogoszcz", "Bałuty"],
  ["teofil", "Teofilów", "Bałuty"], ["retkini", "Retkinia", "Polesie"],
] as const;
const DISTRICTS = ["Bałuty", "Widzew", "Polesie", "Górna", "Śródmieście"];
const FLAG_PHRASES = ["bezpośrednio", "bez pośredników", "do remontu", "generalny remont", "po babci", "pilnie", "okazja", "spadek", "do negocjacji", "prywatnie"];
const number = (value?: string) => value ? Number(value.replace(",", ".").replace(/\s/g, "")) : null;

export async function extractFacebookProperty(input: FacebookListingInput): Promise<FacebookProperty> {
  const text = input.postText ?? "";
  const lower = text.toLocaleLowerCase("pl-PL");
  const place = PLACES.find(([needle]) => lower.includes(needle));
  const districtFound = DISTRICTS.find((item) => lower.includes(item.toLocaleLowerCase("pl-PL"))) ?? null;
  const priceThousands = text.match(/(\d{2,3}(?:[.,]\d+)?)\s*(?:tys\.?|tysi)/i);
  const priceFull = text.match(/(\d[\d\s]{3,})\s*zł/i);
  const area = number(text.match(/(\d{1,3}(?:[.,]\d+)?)\s*m(?:²|2)\b/i)?.[1]);
  const mRooms = text.match(/\bM(\d)\b/i);
  const explicitRooms = text.match(/(\d+)\s*(?:pok(?:oje|oi|ój|\.)?)/i);
  const floor = number(text.match(/(\d+)\s*(?:piętro|piętrze|p\.)/i)?.[1]);
  const fraction = text.match(/\b(\d+)\s*\/\s*(\d+)\s*(?:piętro|p\.)?/i);
  const streetMatch = text.match(/\bul\.?\s+([\p{L}][\p{L}\s.-]{1,40}?)(?:\s+(\d+[\p{L}]?))?(?=,|\.|\n|$)/iu);
  const street = streetMatch ? [streetMatch[1]?.trim(), streetMatch[2]].filter(Boolean).join(" ") : null;
  const flags = FLAG_PHRASES.filter((phrase) => lower.includes(phrase));
  const known = [priceThousands || priceFull, area, explicitRooms || mRooms, place || districtFound, floor].filter(Boolean).length;
  const explicitNeighborhood = place?.[1] ?? null;
  const explicitDistrict = place?.[2] ?? districtFound;
  const location = await resolveLocation({ address: street, street, district: explicitDistrict, city: explicitNeighborhood || explicitDistrict || /łódź/i.test(text) ? "Łódź" : null, locationText: text, title: text.split(/[.!?\n]/)[0] ?? null, description: text || null });
  const confidence = Math.min(0.98, 0.35 + known * 0.12);
  const intent = resolveFacebookListingIntent(text, input.listingIntent, input.intentConfidence);
  const describesConcreteProperty = !["BUY_PROPERTY", "RENT_WANTED", "SERVICE", "OTHER"].includes(intent.intent);
  const property: FacebookProperty = {
    title: text.split(/[.!?\n]/)[0]?.trim().slice(0, 180) || "Oferta z Facebooka",
    city: location.city,
    neighborhood: explicitNeighborhood ?? location.neighborhood,
    district: explicitDistrict ?? location.district,
    street: street ?? location.street,
    price: describesConcreteProperty ? priceThousands ? Math.round((number(priceThousands[1]) ?? 0) * 1000) : number(priceFull?.[1]) : null,
    area: describesConcreteProperty ? area : null,
    rooms: describesConcreteProperty ? number(explicitRooms?.[1]) ?? (mRooms ? Math.max(1, Number(mRooms[1]) - 1) : null) : null,
    floor: describesConcreteProperty ? fraction ? Number(fraction[1]) : floor : null,
    totalFloors: describesConcreteProperty && fraction ? Number(fraction[2]) : null,
    marketType: describesConcreteProperty ? /rynek pierwotny|deweloper/i.test(text) ? "primary" : /sprzedam|po babci|do remontu/i.test(text) ? "secondary" : null : null,
    sellerType: describesConcreteProperty ? /bez pośrednik|bezpośrednio|prywatnie/i.test(text) ? "private" : /biuro|agencj|pośrednik/i.test(text) ? "agency" : null : null,
    condition: describesConcreteProperty ? /remont|po babci/i.test(text) ? "renovation" : /po remoncie|do wejścia/i.test(text) ? "ready" : null : null,
    description: text || null, originalUrl: input.url ?? null, images: input.images ?? [],
    confidence, flags, listingIntent: intent.intent, intentConfidence: intent.confidence, intentSource: intent.intentSource,
    imageAssessments: input.imageAssessments ?? [],
    sourceFacts: extractFacebookSourceFacts(text),
  };
  property.fieldConfidence = Object.fromEntries([
    "title", "description", "city", "district", "neighborhood", "street", "price", "area", "rooms", "floor", "totalFloors", "condition", "sellerType",
  ].map((field) => [field, property[field as keyof FacebookProperty] === null ? 0 : confidence]));
  return property;
}

export function extractFacebookSourceFacts(text: string): NonNullable<FacebookProperty["sourceFacts"]> {
  const rent = text.match(/(?:czynsz|op\u0142aty administracyjne)[^\d]{0,20}(?:ok\.?\s*)?(\d[\d\s]{2,5})\s*(?:z\u0142|pln)/i);
  const equipment = text.match(/(?:wyposa\u017ceni|mebl)[^\d]{0,40}(?:ok\.?\s*)?(\d[\d\s]{3,6})\s*(?:z\u0142|pln)/i);
  const refreshed = text.match(/(?:od\u015bwie\u017con\w*)[^\d]{0,30}(?:w\s+)?([\p{L}]+\s+20\d{2}|20\d{2})/iu)?.[1] ?? null;
  const buildingRenovation = [
    /remon\w*\s+dach/i.test(text) ? "roof" : null,
    /(?:remon\w*\s+)?elewac/i.test(text) && /blok|budyn/i.test(text) ? "facade" : null,
  ].filter((value): value is string => value !== null);
  return {
    administrativeRent: number(rent?.[1]),
    basement: /(?:w\u0142asn\w*\s+)?piwnic/i.test(text) ? true : null,
    dryingRoom: /suszarni/i.test(text) ? true : null,
    refreshedAt: refreshed,
    bathroomRenovated: /\u0142azienk\w*\s+(?:po\s+)?remoncie|remont\w*\s+\u0142azien/i.test(text) ? true : null,
    buildingRenovation,
    furnishingIncluded: /wyposa\u017ceni\w*\s+(?:w\s+cenie|wliczon)/i.test(text) ? true : /wyposa\u017ceni|mebl/i.test(text) ? false : null,
    additionalEquipmentPrice: number(equipment?.[1]),
  };
}
