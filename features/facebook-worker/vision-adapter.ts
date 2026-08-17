import type { FacebookListingInput } from "../facebook-watcher/types.ts";
import type { FacebookPostSnapshot, FacebookVisionExtraction } from "./types.ts";
import { inspectFacebookIntentSignals, resolveFacebookListingIntent } from "../facebook-watcher/facebook-intent.ts";
import type { FacebookPostImportResult } from "./post-flow.ts";

const MIN_PROPERTY_IMAGE_CONFIDENCE = 0.8;

export function evaluateFacebookPersistenceGate(post: FacebookPostSnapshot) {
  const resolution = resolveFacebookPostIntentWithSource(post);
  const intent = resolution.intent;
  console.info("FACEBOOK_INTENT_DECISION", { deterministic_intent: intent.deterministicIntent, vision_intent: intent.visionIntent, final_intent: intent.intent, intent_source: intent.intentSource, conflict: intent.conflict });
  logFacebookIntentSignals(post.postId, "AUTHORITATIVE_POST_TEXT", post.authoritativePostText ?? "", intent.intent);
  logFacebookIntentSignals(post.postId, "VISION_VISIBLE_TEXT", post.vision?.visibleText ?? "", intent.intent);
  logFacebookIntentSignals(post.postId, resolution.textSource, resolution.classifierText, intent.intent);
  return { ...intent, allowed: post.vision?.isProperty === true && intent.intent === "SELL_PROPERTY" };
}

function resolveFacebookPostIntent(post: FacebookPostSnapshot) {
  return resolveFacebookPostIntentWithSource(post).intent;
}

function resolveFacebookPostIntentWithSource(post: FacebookPostSnapshot) {
  if (post.authoritativePostTextSource === "CONFLICT" || post.authoritativePostTextProvenance === "AMBIGUOUS_COMPOSITE") {
    return {
      intent: {
        intent: "UNKNOWN" as const,
        confidence: 0.35,
        reasonCode: "FACEBOOK_INTENT_UNKNOWN" as const,
        deterministicIntent: "UNKNOWN" as const,
        visionIntent: post.vision?.listingIntent ?? "UNKNOWN",
        intentSource: "CONFLICT" as const,
        conflict: true,
      },
      classifierText: "",
      textSource: post.authoritativePostTextProvenance === "AMBIGUOUS_COMPOSITE" ? "CLASSIFIER_INPUT_AMBIGUOUS_COMPOSITE" : "CLASSIFIER_INPUT_SOURCE_CONFLICT",
    };
  }
  const authoritativePostText = post.authoritativePostText?.trim() ?? "";
  if (authoritativePostText) {
    return {
      intent: resolveFacebookListingIntent(authoritativePostText, post.vision?.listingIntent, post.vision?.intentConfidence),
      classifierText: authoritativePostText,
      textSource: "CLASSIFIER_INPUT_AUTHORITATIVE_POST_TEXT",
    };
  }
  const classifierText = post.vision?.visibleText?.trim() ?? "";
  return { intent: resolveFacebookListingIntent(classifierText, post.vision?.listingIntent, post.vision?.intentConfidence), classifierText, textSource: "CLASSIFIER_INPUT_VISION_VISIBLE_TEXT" };
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
  const intent = resolveFacebookPostIntent(post);
  const overrides: NonNullable<FacebookListingInput["overrides"]> = {};
  if (vision) {
    assignKnown(overrides, "title", vision.title); assignKnown(overrides, "description", vision.description);
    assignKnown(overrides, "city", vision.city); assignKnown(overrides, "district", vision.district); assignKnown(overrides, "neighborhood", vision.neighborhood); assignKnown(overrides, "street", vision.street);
    assignKnown(overrides, "price", vision.price); assignKnown(overrides, "area", vision.area); assignKnown(overrides, "rooms", vision.rooms); assignKnown(overrides, "floor", vision.floor); assignKnown(overrides, "totalFloors", vision.totalFloors);
    assignKnown(overrides, "condition", vision.condition); assignKnown(overrides, "sellerType", vision.sellerType);
  }
  return {
    url: post.permalink ?? undefined,
    postText: post.authoritativePostTextSource === "CONFLICT" || post.authoritativePostTextProvenance === "AMBIGUOUS_COMPOSITE"
      ? undefined
      : post.authoritativePostText?.trim() || post.vision?.visibleText?.trim() || undefined,
    groupName,
    publishedAt: post.publishedAt ?? undefined,
    images: acceptedFacebookPropertyImages(post.imageUrls, vision?.imageAssessments),
    overrides: vision ? overrides : undefined,
    analysisConfidence: vision?.confidence,
    analysisFieldConfidence: vision?.fieldConfidence,
    analysisFlags: vision ? ["vision_post_region"] : undefined,
    listingIntent: intent.intent,
    intentConfidence: intent.confidence,
    intentSource: intent.intentSource,
    imageAssessments: vision?.imageAssessments,
  };
}

function logFacebookIntentSignals(postId: string | null, textSource: string, text: string, finalIntent: string | null): void {
  const signals = inspectFacebookIntentSignals(text);
  console.info("FACEBOOK_INTENT_SIGNAL_DIAGNOSTIC", {
    post_id: postId,
    text_source: textSource,
    text_length: signals.normalizedLength,
    buy_signals: signals.buySignals,
    sell_signals: signals.sellSignals,
    conflicting_signals: signals.buySignals.length > 0 && signals.sellSignals.length > 0,
    final_intent: finalIntent ?? "UNKNOWN",
  });
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
