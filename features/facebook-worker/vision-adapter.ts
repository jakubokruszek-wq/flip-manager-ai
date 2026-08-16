import type { FacebookListingInput } from "../facebook-watcher/types.ts";
import type { FacebookPostSnapshot, FacebookVisionExtraction } from "./types.ts";

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
    images: post.imageUrls,
    overrides: vision ? overrides : undefined,
    analysisConfidence: vision?.confidence,
    analysisFieldConfidence: vision?.fieldConfidence,
    analysisFlags: vision ? ["vision_post_region"] : undefined,
  };
}

function assignKnown<K extends keyof NonNullable<FacebookListingInput["overrides"]>>(target: NonNullable<FacebookListingInput["overrides"]>, key: K, value: NonNullable<FacebookListingInput["overrides"]>[K] | null): void {
  if (value !== null) target[key] = value;
}

export function detectedVisionFields(vision: FacebookVisionExtraction): string[] {
  return (["price", "area", "rooms", "neighborhood", "district", "street"] as const).filter((field) => vision[field] !== null);
}
