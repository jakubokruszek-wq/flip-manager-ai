import "server-only";

import { analyzeFacebookImages } from "./analyze-facebook-images";
import { extractFacebookProperty } from "./extract-facebook-property";
import { FACEBOOK_CONFIDENCE_FIELDS, type FacebookFieldConfidence } from "../facebook-worker/types.ts";
import type { FacebookListingInput, FacebookProperty } from "./types";

export async function extractFacebookListing(input: FacebookListingInput): Promise<FacebookProperty> {
  const base = await extractFacebookProperty(input);
  if (!input.images?.length || !needsVision(base)) return base;

  const vision = await analyzeFacebookImages(input.images, input.postText);
  if (!vision) return base;
  const combinedText = [input.postText, vision.visibleText].filter(Boolean).join("\n");
  const textResult = vision.visibleText
    ? await extractFacebookProperty({ ...input, postText: combinedText })
    : base;

  return {
    ...textResult,
    city: textResult.city ?? vision.city,
    district: textResult.district ?? vision.district,
    neighborhood: textResult.neighborhood ?? vision.neighborhood,
    street: textResult.street ?? vision.street,
    price: textResult.price ?? vision.price,
    area: textResult.area ?? vision.area,
    rooms: textResult.rooms ?? vision.rooms,
    floor: textResult.floor ?? vision.floor,
    totalFloors: textResult.totalFloors ?? vision.totalFloors,
    condition: textResult.condition ?? vision.condition,
    sellerType: textResult.sellerType ?? vision.sellerType,
    confidence: Math.max(textResult.confidence, vision.confidence),
    fieldConfidence: selectFieldConfidence(textResult, vision),
  };
}

function selectFieldConfidence(textResult: FacebookProperty, vision: NonNullable<Awaited<ReturnType<typeof analyzeFacebookImages>>>): FacebookFieldConfidence {
  return Object.fromEntries(FACEBOOK_CONFIDENCE_FIELDS.map((field) => [
    field,
    textResult[field] !== null && textResult[field] !== undefined
      ? textResult.fieldConfidence?.[field] ?? textResult.confidence
      : vision.fieldConfidence?.[field] ?? vision.confidence,
  ])) as FacebookFieldConfidence;
}

export function isUsableFacebookProperty(property: FacebookProperty, sourceText: string | undefined): boolean {
  return classifyFacebookProperty(property, sourceText).usable;
}

export type FacebookPropertyClassification = {
  usable: boolean;
  realEstateLanguage: boolean;
  structuredFieldCount: number;
  detectedFields: string[];
};

export function classifyFacebookProperty(property: FacebookProperty, sourceText: string | undefined): FacebookPropertyClassification {
  const text = sourceText?.toLocaleLowerCase("pl-PL") ?? "";
  const realEstateLanguage = /mieszkan|nieruchomo|kawalerk|apartament|lokal mieszkal|\bm[2-6]\b/.test(text);
  const detectedFields = (["price", "area", "rooms", "neighborhood", "district", "street"] as const)
    .filter((field) => property[field] !== null);
  return { usable: realEstateLanguage || detectedFields.length >= 3, realEstateLanguage, structuredFieldCount: detectedFields.length, detectedFields };
}

function needsVision(property: FacebookProperty): boolean {
  return property.price === null || property.area === null || property.rooms === null || (property.street === null && property.neighborhood === null && property.district === null);
}
