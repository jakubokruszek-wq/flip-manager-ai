import "server-only";

import { analyzeFacebookImages } from "./analyze-facebook-images";
import { extractFacebookProperty, resolveFacebookPrice } from "./extract-facebook-property";
import { FACEBOOK_CONFIDENCE_FIELDS, type FacebookFieldConfidence } from "../facebook-worker/types.ts";
import type { FacebookListingInput, FacebookProperty } from "./types";
import { resolveFacebookListingIntent } from "./facebook-intent";

export async function extractFacebookListing(input: FacebookListingInput): Promise<FacebookProperty> {
  const base = await extractFacebookProperty(input);
  if (!input.images?.length || !needsVision(base)) return base;

  const vision = await analyzeFacebookImages(input.images, input.postText);
  if (!vision) return base;
  const combinedText = [input.postText, vision.visibleText].filter(Boolean).join("\n");
  const textResult = vision.visibleText
    ? await extractFacebookProperty({ ...input, postText: combinedText })
    : base;
  // Keep an unambiguous intent from the authoritative post text authoritative.
  // OCR/Vision text can contain neighbouring UI or shared-post language and
  // must not downgrade a deterministic SELL to UNKNOWN.
  const intent = resolveFacebookExtractionIntent(input.postText, combinedText, vision.listingIntent, vision.intentConfidence);
  const acceptedImages = (input.images ?? []).filter((_, index) => vision.imageAssessments.some((assessment) => assessment.imageIndex === index && assessment.relevance === "PROPERTY_IMAGE" && assessment.confidence >= 0.8));
  const priceSourceText = input.postText?.trim() || vision.visibleText || "";
  const resolvedPrice = resolveFacebookPrice(priceSourceText, textResult.area ?? vision.area);

  return {
    ...textResult,
    city: textResult.city ?? vision.city,
    district: textResult.district ?? vision.district,
    neighborhood: textResult.neighborhood ?? vision.neighborhood,
    street: textResult.street ?? vision.street,
    price: resolvedPrice.price,
    priceProvenance: resolvedPrice.price !== null ? (input.priceProvenance ?? (input.postText ? "AUTHORITATIVE_TEXT" : "VISION")) : textResult.priceProvenance,
    area: textResult.area ?? vision.area,
    rooms: textResult.rooms ?? vision.rooms,
    floor: textResult.floor ?? vision.floor,
    totalFloors: textResult.totalFloors ?? vision.totalFloors,
    condition: textResult.condition ?? vision.condition,
    sellerType: textResult.sellerType ?? vision.sellerType,
    confidence: Math.max(textResult.confidence, vision.confidence),
    fieldConfidence: selectFieldConfidence(textResult, vision),
    listingIntent: intent.intent,
    intentConfidence: intent.confidence,
    intentSource: intent.intentSource,
    imageAssessments: vision.imageAssessments,
    images: acceptedImages,
  };
}

export function resolveFacebookExtractionIntent(
  authoritativeText: string | undefined,
  combinedText: string,
  visionIntent: FacebookProperty["listingIntent"],
  visionConfidence: number | undefined,
) {
  const authoritativeIntent = authoritativeText ? resolveFacebookListingIntent(authoritativeText, null, null) : null;
  return authoritativeIntent && authoritativeIntent.intent !== "UNKNOWN"
    ? authoritativeIntent
    : resolveFacebookListingIntent(combinedText, visionIntent, visionConfidence);
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
