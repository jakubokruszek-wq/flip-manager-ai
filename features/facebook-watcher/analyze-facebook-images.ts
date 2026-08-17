import "server-only";
import type { FacebookVisionExtraction } from "@/features/facebook-worker/types";

type VisionExtraction = FacebookVisionExtraction;

const SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["isProperty", "listingIntent", "intentConfidence", "title", "description", "visibleText", "city", "district", "neighborhood", "street", "price", "area", "rooms", "floor", "totalFloors", "condition", "sellerType", "confidence", "fieldConfidence", "imageAssessments"],
  properties: {
    isProperty: { type: "boolean" }, listingIntent: { type: "string", enum: ["SELL_PROPERTY", "BUY_PROPERTY", "RENT_OFFER", "RENT_WANTED", "SERVICE", "OTHER", "UNKNOWN"] }, intentConfidence: { type: "number", minimum: 0, maximum: 1 }, title: { type: ["string", "null"] }, description: { type: ["string", "null"] },
    visibleText: { type: ["string", "null"] }, city: { type: ["string", "null"] }, district: { type: ["string", "null"] }, neighborhood: { type: ["string", "null"] }, street: { type: ["string", "null"] },
    price: { type: ["number", "null"] }, area: { type: ["number", "null"] }, rooms: { type: ["number", "null"] }, floor: { type: ["number", "null"] }, totalFloors: { type: ["number", "null"] },
    condition: { type: ["string", "null"], enum: ["renovation", "ready", null] }, sellerType: { type: ["string", "null"], enum: ["private", "agency", null] }, confidence: { type: "number", minimum: 0, maximum: 1 },
    fieldConfidence: {
      type: "object", additionalProperties: false,
      required: ["title", "description", "city", "district", "neighborhood", "street", "price", "area", "rooms", "floor", "totalFloors", "condition", "sellerType"],
      properties: Object.fromEntries(["title", "description", "city", "district", "neighborhood", "street", "price", "area", "rooms", "floor", "totalFloors", "condition", "sellerType"].map((field) => [field, { type: "number", minimum: 0, maximum: 1 }])),
    },
    imageAssessments: { type: "array", maxItems: 5, items: { type: "object", additionalProperties: false, required: ["imageIndex", "relevance", "confidence"], properties: { imageIndex: { type: "integer", minimum: 0, maximum: 4 }, relevance: { type: "string", enum: ["PROPERTY_IMAGE", "NON_PROPERTY_IMAGE", "UNKNOWN"] }, confidence: { type: "number", minimum: 0, maximum: 1 } } } },
  },
} as const;

export async function analyzeFacebookImages(images: string[], postText?: string, options?: { contextImageCount?: number }): Promise<VisionExtraction | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || !images.length) return null;
  const validImages = images.map(validImageInput).filter((value): value is string => value !== null).slice(0, 6);
  if (!validImages.length) return null;
  const contextImageCount = Math.max(0, Math.min(options?.contextImageCount ?? 0, validImages.length));
  const candidateImageCount = validImages.length - contextImageCount;
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, signal: AbortSignal.timeout(45_000),
    body: JSON.stringify({
      model: process.env.OPENAI_FACEBOOK_VISION_MODEL ?? "gpt-4o-mini", store: false,
      instructions: "Odczytaj dane wyłącznie z głównej treści posta Facebook widocznej na wycinku oraz opcjonalnego tekstu. Ignoruj autora, timestamp, reakcje, przyciski i komentarze. Najpierw niezależnie ustal listingIntent z całego kontekstu: SELL_PROPERTY (konkretna nieruchomość oferowana na sprzedaż), BUY_PROPERTY (ogłoszenie kupującego/szukającego), RENT_OFFER, RENT_WANTED, SERVICE, OTHER albo UNKNOWN. isProperty oznacza tylko temat nieruchomości i NIE oznacza automatycznie sprzedaży. Frazy typu „kupię”, „szukam mieszkania”, zakres 30-40 m2, 1-2 pokoje i „do 220 000 zł” opisują kryteria kupującego — nie mapuj ich na parametry konkretnego listingu. price, area i rooms wypełniaj wyłącznie dla SELL_PROPERTY lub RENT_OFFER i konkretnego lokalu. Wykonaj dokładny OCR regionu. Nie zgaduj brakujących cyfr ani danych z samego wyglądu mieszkania. Niepewne pola zwróć null. visibleText ma być wierną transkrypcją istotnej treści. Dla każdego pola podaj fieldConfidence 0-1; dla null ustaw 0. Klasyfikuj każde dodatkowe źródłowe zdjęcie osobno: PROPERTY_IMAGE tylko gdy z wysoką pewnością pokazuje lokal, budynek lub wnętrze związane z ofertą; NON_PROPERTY_IMAGE dla portretów, zdjęć profilowych/grupowych, memów, cytatów, wydarzeń, UI i niezwiązanych zdjęć lifestyle; w pozostałych przypadkach UNKNOWN. Nie identyfikuj osób ani nie opisuj danych biometrycznych.",
      input: [{ role: "user", content: [
        { type: "input_text", text: `Opcjonalny tekst użytkownika:\n${postText?.trim() || "(brak)"}\nPierwsze obrazy kontekstowe (nie zapisuj ich): ${contextImageCount}. Następne ${candidateImageCount} obrazy to kandydaci galerii; indeksuj je od 0 w imageAssessments.` },
        ...validImages.map((imageUrl) => ({ type: "input_image" as const, image_url: imageUrl, detail: "high" as const })),
      ] }],
      text: { format: { type: "json_schema", name: "facebook_property_vision", strict: true, schema: SCHEMA } },
    }),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`Analiza screenshotu nie powiodła się (OpenAI HTTP ${response.status}).`);
  const text = outputText(payload); if (!text) throw new Error("OpenAI nie zwróciło danych ze screenshotu.");
  const value = JSON.parse(text) as VisionExtraction;
  return { ...value, confidence: Math.max(0, Math.min(1, value.confidence)), intentConfidence: Math.max(0, Math.min(1, value.intentConfidence)), imageAssessments: value.imageAssessments.filter((item) => Number.isInteger(item.imageIndex) && item.imageIndex >= 0 && item.imageIndex < candidateImageCount).map((item) => ({ ...item, confidence: Math.max(0, Math.min(1, item.confidence)) })) };
}

function validImageInput(value: string): string | null {
  if (/^data:image\/(?:jpeg|png|webp);base64,[a-z0-9+/=]+$/i.test(value) && value.length <= 950_000) return value;
  try { const url = new URL(value); return url.protocol === "https:" && url.hostname ? url.toString() : null; } catch { return null; }
}
function outputText(payload: unknown): string | null { if (!isRecord(payload) || !Array.isArray(payload.output)) return null; for (const item of payload.output) { if (!isRecord(item) || !Array.isArray(item.content)) continue; for (const content of item.content) if (isRecord(content) && content.type === "output_text" && typeof content.text === "string") return content.text; } return null; }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }

export type { VisionExtraction };
