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

export type FacebookIntentSignalName =
  | "BUY_KUPIE"
  | "BUY_CHCE_KUPIC"
  | "BUY_CHETNIE_KUPIE"
  | "BUY_INTERESUJE_MNIE_ZAKUP"
  | "BUY_POSZUKUJE"
  | "BUY_SZUKAM"
  | "SELL_SPRZEDAM"
  | "SELL_NA_SPRZEDAZ"
  | "SELL_DO_SPRZEDANIA"
  | "SELL_OFERUJE_NA_SPRZEDAZ"
  | "SELL_OFF_MARKET"
  | "SELL_MAM_DO_ZAOFEROWANIA"
  | "SELL_STRUCTURED_OFFER";

export type FacebookIntentSignals = {
  normalizedLength: number;
  propertyContext: boolean;
  buySignals: FacebookIntentSignalName[];
  sellSignals: FacebookIntentSignalName[];
};

const BUY_PATTERNS: ReadonlyArray<{ name: FacebookIntentSignalName; pattern: RegExp; requiresPropertyContext: boolean }> = [
  { name: "BUY_KUPIE", pattern: /\bkupie(?:\s+za\s+gotowke)?\b/u, requiresPropertyContext: true },
  { name: "BUY_CHCE_KUPIC", pattern: /\bchce\s+kupic\b/u, requiresPropertyContext: true },
  { name: "BUY_CHETNIE_KUPIE", pattern: /\bchetnie\s+kupie\b/u, requiresPropertyContext: true },
  { name: "BUY_INTERESUJE_MNIE_ZAKUP", pattern: /\binteresuje\s+mnie\s+zakup\b/u, requiresPropertyContext: true },
  { name: "BUY_POSZUKUJE", pattern: /\bposzukuje\s+(?:pilnie\s+)?(?:mieszkania|domu|nieruchomosci|kawalerki|apartamentu)\b/u, requiresPropertyContext: false },
  { name: "BUY_SZUKAM", pattern: /\bszukam\s+(?:pilnie\s+)?(?:mieszkania|domu|nieruchomosci|kawalerki|apartamentu)\b/u, requiresPropertyContext: false },
];

const SELL_PATTERNS: ReadonlyArray<{ name: FacebookIntentSignalName; pattern: RegExp }> = [
  { name: "SELL_SPRZEDAM", pattern: /\bsprzedam\b/u },
  { name: "SELL_NA_SPRZEDAZ", pattern: /\bna\s+sprzedaz\b/u },
  { name: "SELL_DO_SPRZEDANIA", pattern: /\bdo\s+sprzedania\b/u },
  { name: "SELL_OFERUJE_NA_SPRZEDAZ", pattern: /\boferuje\s+na\s+sprzedaz\b/u },
  { name: "SELL_OFF_MARKET", pattern: /\boff\s*market\b/u },
  { name: "SELL_MAM_DO_ZAOFEROWANIA", pattern: /\bmam\s+do\s+zaoferowania\b/u },
];

export function resolveFacebookListingIntent(
  text: string | null | undefined,
  visionIntent: FacebookListingIntent | null | undefined,
  visionConfidence: number | null | undefined,
): FacebookIntentDecision {
  const normalized = normalizeIntentText(text ?? "");
  const signals = inspectNormalizedFacebookIntentSignals(normalized);
  const propertyContext = signals.propertyContext;
  const buySignal = signals.buySignals.length > 0;
  const sellSignal = signals.sellSignals.length > 0;
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

export function inspectFacebookIntentSignals(text: string | null | undefined): FacebookIntentSignals {
  return inspectNormalizedFacebookIntentSignals(normalizeIntentText(text ?? ""));
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
  return value.normalize("NFKD").replace(/\p{M}/gu, "").replace(/\p{Cf}/gu, "").toLocaleLowerCase("pl-PL").replace(/ł/g, "l").replace(/\s+/g, " ").trim();
}

function inspectNormalizedFacebookIntentSignals(normalized: string): FacebookIntentSignals {
  const propertyContext = /\b(mieszkan[\p{L}\d]*|nieruchomo[\p{L}\d]*|kawalerk[\p{L}\d]*|apartament[\p{L}\d]*|pokoj[\p{L}\d]*|dom[\p{L}\d]*|lokal[\p{L}\d]*)\b/u.test(normalized);
  const buySignals = BUY_PATTERNS
    .filter(({ pattern, requiresPropertyContext }) => (!requiresPropertyContext || propertyContext) && pattern.test(normalized))
    .map(({ name }) => name);
  const sellSignals = propertyContext
    ? SELL_PATTERNS.filter(({ pattern }) => pattern.test(normalized)).map(({ name }) => name)
    : [];
  if (
    propertyContext
    && buySignals.length === 0
    && /\b\d{1,3}(?:[.,]\d+)?\s*m(?:2)?\b/u.test(normalized)
    && /\b\d{2,7}(?:[\s.]\d{3})*(?:[.,]\d+)?\s*(?:tys(?:\.|iecy)?|zl|pln)\b/u.test(normalized)
  ) {
    sellSignals.push("SELL_STRUCTURED_OFFER");
  }
  return { normalizedLength: normalized.length, propertyContext, buySignals, sellSignals };
}

function boundedConfidence(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}
