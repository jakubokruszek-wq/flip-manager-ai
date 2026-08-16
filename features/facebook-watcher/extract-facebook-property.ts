import type { FacebookListingInput, FacebookProperty } from "./types";
import { resolveLocation } from "../location-intelligence/resolve-location.ts";

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
  const street = text.match(/\bul\.?\s+([\p{L}][\p{L}\s.-]{2,40}?)(?=,|\d|\.|$)/iu)?.[1]?.trim() ?? null;
  const flags = FLAG_PHRASES.filter((phrase) => lower.includes(phrase));
  const known = [priceThousands || priceFull, area, explicitRooms || mRooms, place || districtFound, floor].filter(Boolean).length;
  const explicitNeighborhood = place?.[1] ?? null;
  const explicitDistrict = place?.[2] ?? districtFound;
  const location = await resolveLocation({ address: street, street, district: explicitDistrict, city: explicitNeighborhood || explicitDistrict || /łódź/i.test(text) ? "Łódź" : null, locationText: text, title: text.split(/[.!?\n]/)[0] ?? null, description: text || null });
  const confidence = Math.min(0.98, 0.35 + known * 0.12);
  const property: FacebookProperty = {
    title: text.split(/[.!?\n]/)[0]?.trim().slice(0, 180) || "Oferta z Facebooka",
    city: location.city,
    neighborhood: explicitNeighborhood ?? location.neighborhood,
    district: explicitDistrict ?? location.district,
    street: street ?? location.street,
    price: priceThousands ? Math.round((number(priceThousands[1]) ?? 0) * 1000) : number(priceFull?.[1]),
    area,
    rooms: number(explicitRooms?.[1]) ?? (mRooms ? Math.max(1, Number(mRooms[1]) - 1) : null),
    floor: fraction ? Number(fraction[1]) : floor,
    totalFloors: fraction ? Number(fraction[2]) : null,
    marketType: /rynek pierwotny|deweloper/i.test(text) ? "primary" : /sprzedam|po babci|do remontu/i.test(text) ? "secondary" : null,
    sellerType: /bez pośrednik|bezpośrednio|prywatnie/i.test(text) ? "private" : /biuro|agencj|pośrednik/i.test(text) ? "agency" : null,
    condition: /remont|po babci/i.test(text) ? "renovation" : /po remoncie|do wejścia/i.test(text) ? "ready" : null,
    description: text || null, originalUrl: input.url ?? null, images: input.images ?? [],
    confidence, flags,
  };
  property.fieldConfidence = Object.fromEntries([
    "title", "description", "city", "district", "neighborhood", "street", "price", "area", "rooms", "floor", "totalFloors", "condition", "sellerType",
  ].map((field) => [field, property[field as keyof FacebookProperty] === null ? 0 : confidence]));
  return property;
}
