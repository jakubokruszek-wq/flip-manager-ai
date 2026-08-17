import type { FacebookListingIntent, FacebookSkipReasonCode } from "../facebook-worker/types.ts";

export type FacebookIntentDecision = {
  intent: FacebookListingIntent;
  confidence: number;
  reasonCode: FacebookSkipReasonCode | null;
};

export function resolveFacebookListingIntent(
  text: string | null | undefined,
  visionIntent: FacebookListingIntent | null | undefined,
  visionConfidence: number | null | undefined,
): FacebookIntentDecision {
  const normalized = normalizeIntentText(text ?? "");
  const propertyContext = /\b(mieszkan\w*|nieruchomo\w*|kawalerk\w*|apartament\w*|dom\w*|lokal\w*)\b/u.test(normalized);
  const buySignal = /\b(kupie|poszukuje|szukam|chetnie kupie|interesuje mnie)\b/u.test(normalized);
  const sellSignal = /\b(sprzedam|na sprzedaz|do sprzedania|oferuje mieszkanie)\b/u.test(normalized)
    || propertyContext && /\b(mieszkanie znajduje sie|cena\s*[:=-]?\s*\d)/u.test(normalized);
  const rentWantedSignal = /\b(szukam|poszukuje)\b[^.\n]{0,80}\b(wynajecia|najmu|wynajme)\b/u.test(normalized);
  const rentOfferSignal = /\b(do wynajecia|wynajme|oferuje najem)\b/u.test(normalized) && !rentWantedSignal;
  const serviceSignal = /\b(uslugi remontowe|wykonczenia wnetrz|posrednictwo|agent nieruchomosci|fotografia nieruchomosci)\b/u.test(normalized);

  if (propertyContext && rentWantedSignal) return decision("RENT_WANTED", 0.96);
  if (propertyContext && rentOfferSignal) return decision("RENT_OFFER", 0.94);
  if (serviceSignal) return decision("SERVICE", 0.95);
  if (propertyContext && buySignal && !sellSignal) return decision("BUY_PROPERTY", 0.98);
  if (propertyContext && sellSignal && !buySignal) return decision("SELL_PROPERTY", 0.98);
  if (buySignal && sellSignal) return decision("UNKNOWN", 0.35);

  const boundedVisionConfidence = boundedConfidence(visionConfidence);
  if (visionIntent && visionIntent !== "UNKNOWN" && boundedVisionConfidence >= 0.75) {
    return decision(visionIntent, boundedVisionConfidence);
  }
  if (visionIntent === "OTHER" && boundedVisionConfidence >= 0.75) return decision("OTHER", boundedVisionConfidence);
  return decision("UNKNOWN", boundedVisionConfidence);
}

export function facebookIntentSkipReason(intent: FacebookListingIntent): FacebookSkipReasonCode | null {
  if (intent === "SELL_PROPERTY") return null;
  if (intent === "BUY_PROPERTY") return "FACEBOOK_BUY_REQUEST";
  if (intent === "RENT_OFFER" || intent === "RENT_WANTED") return "FACEBOOK_RENT_REQUEST";
  if (intent === "SERVICE") return "FACEBOOK_SERVICE_POST";
  if (intent === "UNKNOWN") return "FACEBOOK_INTENT_UNKNOWN";
  return "FACEBOOK_NON_SALE_POST";
}

function decision(intent: FacebookListingIntent, confidence: number): FacebookIntentDecision {
  return { intent, confidence, reasonCode: facebookIntentSkipReason(intent) };
}

function normalizeIntentText(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase("pl-PL").replace(/\s+/g, " ").trim();
}

function boundedConfidence(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}
