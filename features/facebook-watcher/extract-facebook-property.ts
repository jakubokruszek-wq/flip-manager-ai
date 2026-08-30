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
const boundedFloor = (value: number | null) => value !== null && value >= 0 && value <= 30 ? value : null;

export type FacebookPriceResolution = {
  price: number | null;
  pricePerM2: number | null;
  source: "EXPLICIT_TOTAL" | "THOUSANDS_TOTAL" | "DERIVED_FROM_PRICE_PER_M2" | "NONE";
};

const AUXILIARY_PRICE_CONTEXT = /(?:czynsz|opłat|kaucj|wyposażeni|mebl|remont|prowizj|telefon|tel\.?)[^\n]{0,24}$/i;

export function resolveFacebookPrice(text: string, area: number | null): FacebookPriceResolution {
  const normalized = text.replace(/[\u00a0\u202f]/g, " ");
  const perM2 = uniqueNumbers(Array.from(normalized.matchAll(/(\d{1,3}(?:\s\d{3})+|\d{3,6})(?:[.,](\d{1,2}))?\s*(?:zł|pln)\s*\/\s*m(?:2|²)(?![\p{L}\d])/giu)), (match) => decimalNumber(match[1], match[2]));
  const explicitTotals = uniqueNumbers(Array.from(normalized.matchAll(/(\d{1,3}(?:\s\d{3})+|\d{4,9})(?:[.,](\d{1,2}))?\s*(?:zł|pln)(?!\p{L})/giu))
    .filter((match) => !/^\s*\/\s*m(?:2|²)/iu.test(normalized.slice(match.index! + match[0].length)) && !AUXILIARY_PRICE_CONTEXT.test(normalized.slice(Math.max(0, match.index! - 32), match.index))), (match) => decimalNumber(match[1], match[2]));
  const thousandsTotals = uniqueNumbers(Array.from(normalized.matchAll(/(\d{2,4}(?:[.,]\d+)?)\s*(?:tys\.?|tysi(?:ąc(?:e|y)?)?)/giu))
    .filter((match) => !/^\s*(?:zł|pln)?\s*\/\s*m(?:2|²)/iu.test(normalized.slice(match.index! + match[0].length)) && !AUXILIARY_PRICE_CONTEXT.test(normalized.slice(Math.max(0, match.index! - 32), match.index))), (match) => Math.round((number(match[1]) ?? 0) * 1000));

  const contextualTotals = Array.from(normalized.matchAll(/(?:^|[^\p{L}])(?:cena(?:\s+ofertowa)?|kwota(?:\s+do\s+negocjacji)?)\s*[:=-]?\s*(\d{1,3}(?:[\s.]\d{3})+|\d{4,9})(?:[.,](\d{1,2}))?(?![\d])/giu));
  const contextual = singleValue(uniqueNumbers(contextualTotals, (match) => decimalNumber(match[1], match[2])));
  if (contextual !== null) return { price: contextual, pricePerM2: singleValue(perM2), source: "EXPLICIT_TOTAL" };
  const explicit = singleValue(explicitTotals);
  if (explicit !== null) return { price: explicit, pricePerM2: singleValue(perM2), source: "EXPLICIT_TOTAL" };
  const thousands = singleValue(thousandsTotals);
  if (thousands !== null) return { price: thousands, pricePerM2: singleValue(perM2), source: "THOUSANDS_TOTAL" };
  const unitPrice = singleValue(perM2);
  if (unitPrice !== null && area !== null && area > 0) {
    return { price: Math.round(area * unitPrice), pricePerM2: unitPrice, source: "DERIVED_FROM_PRICE_PER_M2" };
  }
  return { price: null, pricePerM2: unitPrice, source: "NONE" };
}

function decimalNumber(integer: string, decimals: string | undefined): number {
  return Number(`${integer.replace(/\s/g, "")}${decimals ? `.${decimals}` : ""}`);
}

function uniqueNumbers(matches: RegExpMatchArray[], convert: (match: RegExpMatchArray) => number): number[] {
  return [...new Set(matches.map(convert).filter((value) => Number.isFinite(value) && value > 0))];
}

function singleValue(values: number[]): number | null {
  return values.length === 1 ? values[0] : null;
}

export async function extractFacebookProperty(input: FacebookListingInput): Promise<FacebookProperty> {
  const text = input.postText ?? "";
  const lower = text.toLocaleLowerCase("pl-PL");
  const normalizedText = text.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase("pl-PL").replace(/ł/g, "l");
  const place = PLACES.find(([needle]) => lower.includes(needle));
  const districtFound = DISTRICTS.find((item) => lower.includes(item.toLocaleLowerCase("pl-PL"))) ?? null;
  const area = number(text.match(/(\d{1,3}(?:[.,]\d+)?)\s*m(?:²|2)\b/i)?.[1]);
  const unicodeArea = number(text.match(/(\d{1,3}(?:[.,]\d+)?)\s*m\u00b2(?![\p{L}\d])/iu)?.[1]);
  const effectiveArea = unicodeArea ?? area;
  const price = resolveFacebookPrice(text, effectiveArea);
  const mRoomValues = [...normalizedText.matchAll(/\bm([2-6])\b/gu)]
    .filter((match) => !/[#\d]\s*$/u.test(normalizedText.slice(Math.max(0, (match.index ?? 0) - 4), match.index)))
    .map((match) => Number(match[1]));
  const mRooms = new Set(mRoomValues).size === 1 ? mRoomValues[0] : null;
  const explicitRooms = normalizedText.match(/\b(\d{1,2})\s*[-–]?\s*pokoj(?:e|owy|owe|owych)?\b/u);
  const floor = boundedFloor(number(normalizedText.match(/\b(\d{1,2})\.?\s*(?:pietro|pietrze|p\.)\b/u)?.[1]));
  const fraction = normalizedText.match(/\b(\d{1,2})\s*\/\s*(\d{1,2})\s*(?:pietro|p\.)\b/u);
  const streetMatch = text.match(/\bul\.?\s+([\p{L}][\p{L}\s.-]{1,40}?)(?:\s+(\d+[\p{L}]?))?(?=,|\.|\n|$)/iu);
  const street = streetMatch ? [streetMatch[1]?.trim(), streetMatch[2]].filter(Boolean).join(" ") : null;
  const flags = FLAG_PHRASES.filter((phrase) => lower.includes(phrase));
  const known = [price.price !== null, effectiveArea, explicitRooms || mRooms, place || districtFound, floor].filter(Boolean).length;
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
    price: describesConcreteProperty ? price.price : null,
    priceProvenance: describesConcreteProperty ? (input.priceProvenance ?? (price.price !== null ? "AUTHORITATIVE_TEXT" : undefined)) : undefined,
    area: describesConcreteProperty ? effectiveArea : null,
    rooms: describesConcreteProperty ? number(explicitRooms?.[1]) ?? (mRooms ? Math.max(1, mRooms - 1) : null) : null,
    floor: describesConcreteProperty ? fraction ? boundedFloor(Number(fraction[1])) : floor : null,
    totalFloors: describesConcreteProperty && fraction ? Number(fraction[2]) : null,
    marketType: describesConcreteProperty ? /rynek pierwotny|deweloper/i.test(text) ? "primary" : /sprzedam|po babci|do remontu/i.test(text) ? "secondary" : null : null,
    sellerType: describesConcreteProperty ? /bez pośrednik|bezpośrednio|prywatnie/i.test(text) ? "private" : /biuro|agencj|pośrednik/i.test(text) ? "agency" : null : null,
    condition: describesConcreteProperty
      ? /po\s+remoncie|gotow\w*\s+do\s+(?:wprowadzenia|zamieszkania)|do\s+wejscia/u.test(normalizedText)
        ? "ready"
        : /do\s+(?:generalnego\s+)?remontu|po\s+babci/u.test(normalizedText)
          ? "renovation"
          : null
      : null,
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
