import "server-only";
import type { FacebookVisionExtraction } from "@/features/facebook-worker/types";

type VisionExtraction = FacebookVisionExtraction;

const SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["isProperty", "title", "description", "visibleText", "city", "district", "neighborhood", "street", "price", "area", "rooms", "floor", "totalFloors", "condition", "sellerType", "confidence"],
  properties: {
    isProperty: { type: "boolean" }, title: { type: ["string", "null"] }, description: { type: ["string", "null"] },
    visibleText: { type: ["string", "null"] }, city: { type: ["string", "null"] }, district: { type: ["string", "null"] }, neighborhood: { type: ["string", "null"] }, street: { type: ["string", "null"] },
    price: { type: ["number", "null"] }, area: { type: ["number", "null"] }, rooms: { type: ["number", "null"] }, floor: { type: ["number", "null"] }, totalFloors: { type: ["number", "null"] },
    condition: { type: ["string", "null"], enum: ["renovation", "ready", null] }, sellerType: { type: ["string", "null"], enum: ["private", "agency", null] }, confidence: { type: "number", minimum: 0, maximum: 1 },
  },
} as const;

export async function analyzeFacebookImages(images: string[], postText?: string): Promise<VisionExtraction | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || !images.length) return null;
  const validImages = images.map(validImageInput).filter((value): value is string => value !== null).slice(0, 6);
  if (!validImages.length) return null;
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, signal: AbortSignal.timeout(45_000),
    body: JSON.stringify({
      model: process.env.OPENAI_FACEBOOK_VISION_MODEL ?? "gpt-4o-mini", store: false,
      instructions: "Odczytaj dane wyłącznie z głównej treści posta Facebook widocznej na wycinku oraz opcjonalnego tekstu użytkownika. Ignoruj autora, timestamp, reakcje, przyciski i komentarze. Nie zgaduj. Nie wyprowadzaj ceny, adresu ani parametrów z wyglądu mieszkania. isProperty=true tylko dla oferty sprzedaży lub wynajmu nieruchomości. title i description twórz wyłącznie z widocznej treści ogłoszenia. Niepewne lub niewidoczne pola zwróć jako null. visibleText ma być wierną transkrypcją istotnej treści ogłoszenia. sellerType=private tylko gdy tekst mówi właściciel, prywatnie, bezpośrednio lub bez pośredników.",
      input: [{ role: "user", content: [
        { type: "input_text", text: `Opcjonalny tekst użytkownika:\n${postText?.trim() || "(brak)"}` },
        ...validImages.map((imageUrl) => ({ type: "input_image" as const, image_url: imageUrl, detail: "high" as const })),
      ] }],
      text: { format: { type: "json_schema", name: "facebook_property_vision", strict: true, schema: SCHEMA } },
    }),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`Analiza screenshotu nie powiodła się (OpenAI HTTP ${response.status}).`);
  const text = outputText(payload); if (!text) throw new Error("OpenAI nie zwróciło danych ze screenshotu.");
  const value = JSON.parse(text) as VisionExtraction;
  return { ...value, confidence: Math.max(0, Math.min(1, value.confidence)) };
}

function validImageInput(value: string): string | null {
  if (/^data:image\/(?:jpeg|png|webp);base64,[a-z0-9+/=]+$/i.test(value) && value.length <= 950_000) return value;
  try { const url = new URL(value); return url.protocol === "https:" && url.hostname ? url.toString() : null; } catch { return null; }
}
function outputText(payload: unknown): string | null { if (!isRecord(payload) || !Array.isArray(payload.output)) return null; for (const item of payload.output) { if (!isRecord(item) || !Array.isArray(item.content)) continue; for (const content of item.content) if (isRecord(content) && content.type === "output_text" && typeof content.text === "string") return content.text; } return null; }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }

export type { VisionExtraction };
