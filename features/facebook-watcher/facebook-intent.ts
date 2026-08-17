import type { FacebookIntentSource, FacebookListingIntent, FacebookSkipReasonCode } from "../facebook-worker/types.ts";

export type FacebookIntentDecision = {
  intent: FacebookListingIntent;
  confidence: number;
  reasonCode: FacebookSkipReasonCode | null;
  deterministicIntent: FacebookListingIntent;
  visionIntent: FacebookListingIntent;
  intentSource: FacebookIntentSource;
  conflict: boolean;
};

export function resolveFacebookListingIntent(
  text: string | null | undefined,
  visionIntent: FacebookListingIntent | null | undefined,
  visionConfidence: number | null | undefined,
): FacebookIntentDecision {
  const normalized = normalizeIntentText(text ?? "");
  const propertyContext = /\b(mieszkan[\p{L}\d]*|nieruchomo[\p{L}\d]*|kawalerk[\p{L}\d]*|apartament[\p{L}\d]*|dom[\p{L}\d]*|lokal[\p{L}\d]*)\b/u.test(normalized);
  const buySignal = propertyContext && /\b(kupie(?:\s+za\s+gotowke)?|chce\s+kupic|chetnie\s+kupie|interesuje\s+mnie\s+zakup)\b/u.test(normalized)
    || /\b(?:poszukuje|szukam)\s+(?:pilnie\s+)?(?:mieszkania|domu|nieruchomosci|kawalerki|apartamentu)\b/u.test(normalized);
  const sellSignal = propertyContext && /\b(sprzedam|na\s+sprzedaz|do\s+sprzedania|oferuje\s+na\s+sprzedaz)\b/u.test(normalized);
  const rentWantedSignal = /\b(szukam|poszukuje)\b[^.\n]{0,80}\b(wynajecia|najmu|wynajme)\b/u.test(normalized);
  const rentOfferSignal = /\b(do wynajecia|wynajme|oferuje najem)\b/u.test(normalized) && !rentWantedSignal;
  const serviceSignal = /\b(uslugi remontowe|wykonczenia wnetrz|posrednictwo|agent nieruchomosci|fotografia nieruchomosci)\b/u.test(normalized);

  const normalizedVisionIntent = visionIntent ?? "UNKNOWN";
  if (propertyContext && rentWantedSignal) return decision("RENT_WANTED", 0.96, "RENT_WANTED", normalizedVisionIntent, "UNKNOWN");
  if (propertyContext && rentOfferSignal) return decision("RENT_OFFER", 0.94, "RENT_OFFER", normalizedVisionIntent, "UNKNOWN");
  if (serviceSignal) return decision("SERVICE", 0.95, "SERVICE", normalizedVisionIntent, "UNKNOWN");
  if (buySignal && sellSignal) return decision("UNKNOWN", 0.35, "UNKNOWN", normalizedVisionIntent, "CONFLICT", true);
  if (propertyContext && buySignal) return decision("BUY_PROPERTY", 0.99, "BUY_PROPERTY", normalizedVisionIntent, "DETERMINISTIC_BUY");
  if (propertyContext && sellSignal) return decision("SELL_PROPERTY", 0.99, "SELL_PROPERTY", normalizedVisionIntent, "DETERMINISTIC_SELL");

  const boundedVisionConfidence = boundedConfidence(visionConfidence);
  if (visionIntent && visionIntent !== "UNKNOWN" && boundedVisionConfidence >= 0.75) {
    return decision(visionIntent, boundedVisionConfidence, "UNKNOWN", normalizedVisionIntent, "VISION");
  }
  if (visionIntent === "OTHER" && boundedVisionConfidence >= 0.75) return decision("OTHER", boundedVisionConfidence, "UNKNOWN", normalizedVisionIntent, "VISION");
  return decision("UNKNOWN", boundedVisionConfidence, "UNKNOWN", normalizedVisionIntent, "UNKNOWN");
}

export function facebookIntentSkipReason(intent: FacebookListingIntent): FacebookSkipReasonCode | null {
  if (intent === "SELL_PROPERTY") return null;
  if (intent === "BUY_PROPERTY") return "FACEBOOK_BUY_REQUEST";
  if (intent === "RENT_OFFER" || intent === "RENT_WANTED") return "FACEBOOK_RENT_REQUEST";
  if (intent === "SERVICE") return "FACEBOOK_SERVICE_POST";
  if (intent === "UNKNOWN") return "FACEBOOK_INTENT_UNKNOWN";
  return "FACEBOOK_NON_SALE_POST";
}

function decision(intent: FacebookListingIntent, confidence: number, deterministicIntent: FacebookListingIntent, visionIntent: FacebookListingIntent, intentSource: FacebookIntentSource, conflict = false): FacebookIntentDecision {
  return { intent, confidence, reasonCode: facebookIntentSkipReason(intent), deterministicIntent, visionIntent, intentSource, conflict };
}

function normalizeIntentText(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase("pl-PL").replace(/\s+/g, " ").trim();
}

function boundedConfidence(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}
