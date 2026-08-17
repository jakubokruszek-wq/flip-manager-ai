import type { FacebookListingInput } from "../facebook-watcher/types.ts";
import type { FacebookPostSnapshot, FacebookVisionExtraction } from "./types.ts";
import { resolveFacebookListingIntent } from "../facebook-watcher/facebook-intent.ts";
import type { FacebookPostImportResult } from "./post-flow.ts";

const MIN_PROPERTY_IMAGE_CONFIDENCE = 0.8;

export function evaluateFacebookPersistenceGate(post: FacebookPostSnapshot) {
  const intent = resolveFacebookListingIntent(post.vision?.visibleText ?? post.text, post.vision?.listingIntent, post.vision?.intentConfidence);
  return { ...intent, allowed: post.vision?.isProperty === true && intent.intent === "SELL_PROPERTY" };
}

export async function persistEligibleFacebookPost(
  post: FacebookPostSnapshot,
  persist: (post: FacebookPostSnapshot) => Promise<FacebookPostImportResult>,
): Promise<FacebookPostImportResult> {
  const gate = evaluateFacebookPersistenceGate(post);
  if (gate.allowed) return persist(post);
  const detectedFields = post.vision ? detectedVisionFields(post.vision) : [];
  return { status: "skipped", listingId: null, listingCreated: false, listingUpdated: false, matched: false, matchCreated: false, imagesMirrored: 0, priceDrops: 0, warnings: [], notProperty: { realEstateLanguage: post.vision?.isProperty === true, structuredFieldCount: detectedFields.length, detectedFields, classification: gate.intent === "UNKNOWN" && post.vision?.isProperty === false ? "not_a_property" : "non_sale_intent", reasonCode: gate.reasonCode ?? "FACEBOOK_INTENT_UNKNOWN" } };
}

export function facebookVisionToListingInput(post: FacebookPostSnapshot, groupName: string): FacebookListingInput {
  const vision = post.vision;
  const overrides: NonNullable<FacebookListingInput["overrides"]> = {};
  if (vision) {
    assignKnown(overrides, "title", vision.title); assignKnown(overrides, "description", vision.description);
    assignKnown(overrides, "city", vision.city); assignKnown(overrides, "district", vision.district); assignKnown(overrides, "neighborhood", vision.neighborhood); assignKnown(overrides, "street", vision.street);
    assignKnown(overrides, "price", vision.price); assignKnown(overrides, "area", vision.area); assignKnown(overrides, "rooms", vision.rooms); assignKnown(overrides, "floor", vision.floor); assignKnown(overrides, "totalFloors", vision.totalFloors);
    assignKnown(overrides, "condition", vision.condition); assignKnown(overrides, "sellerType", vision.sellerType);
  }
  return {
    url: post.permalink ?? undefined,
    postText: (vision?.visibleText ?? post.text) || undefined,
    groupName,
    publishedAt: post.publishedAt ?? undefined,
    images: acceptedFacebookPropertyImages(post.imageUrls, vision?.imageAssessments),
    overrides: vision ? overrides : undefined,
    analysisConfidence: vision?.confidence,
    analysisFieldConfidence: vision?.fieldConfidence,
    analysisFlags: vision ? ["vision_post_region"] : undefined,
    listingIntent: vision?.listingIntent,
    intentConfidence: vision?.intentConfidence,
    imageAssessments: vision?.imageAssessments,
  };
}

export function acceptedFacebookPropertyImages(imageUrls: string[], assessments: FacebookVisionExtraction["imageAssessments"] | undefined): string[] {
  if (!assessments?.length) return [];
  const accepted = new Set(assessments
    .filter((item) => item.relevance === "PROPERTY_IMAGE" && item.confidence >= MIN_PROPERTY_IMAGE_CONFIDENCE)
    .map((item) => item.imageIndex));
  return imageUrls.filter((_, index) => accepted.has(index));
}

function assignKnown<K extends keyof NonNullable<FacebookListingInput["overrides"]>>(target: NonNullable<FacebookListingInput["overrides"]>, key: K, value: NonNullable<FacebookListingInput["overrides"]>[K] | null): void {
  if (value !== null) target[key] = value;
}

export function detectedVisionFields(vision: FacebookVisionExtraction): string[] {
  return (["price", "area", "rooms", "neighborhood", "district", "street"] as const).filter((field) => vision[field] !== null);
}
