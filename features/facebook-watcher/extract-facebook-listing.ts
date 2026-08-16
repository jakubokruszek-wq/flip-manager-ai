import "server-only";

import { analyzeFacebookImages } from "./analyze-facebook-images";
import { extractFacebookProperty } from "./extract-facebook-property";
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
  };
}

export function isUsableFacebookProperty(property: FacebookProperty, sourceText: string | undefined): boolean {
  const text = sourceText?.toLocaleLowerCase("pl-PL") ?? "";
  const explicitPropertyLanguage = /mieszkan|nieruchomo|kawalerk|apartament|lokal mieszkal|\bm[2-6]\b/.test(text);
  const structuredFields = [property.price, property.area, property.rooms, property.neighborhood, property.district, property.street]
    .filter((value) => value !== null).length;
  return explicitPropertyLanguage || structuredFields >= 3;
}

function needsVision(property: FacebookProperty): boolean {
  return property.price === null || property.area === null || property.rooms === null || (property.street === null && property.neighborhood === null && property.district === null);
}

