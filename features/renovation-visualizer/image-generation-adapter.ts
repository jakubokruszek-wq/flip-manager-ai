import "server-only";

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import { buildRenovationPrompt } from "./prompts";
import type { RenovationLevel, RenovationStyle, RenovationVisualizationInput, RenovationVisualizationOutput } from "./types";

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const IMAGE_FETCH_TIMEOUT_MS = 20_000;
const OPENAI_TIMEOUT_MS = 150_000;
const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export type RenovationGenerationErrorCode = "MISSING_API_KEY" | "IMAGE_FETCH_FAILED" | "TIMEOUT" | "OPENAI_API_ERROR";

export class RenovationGenerationError extends Error {
  constructor(public readonly code: RenovationGenerationErrorCode, message: string, public readonly status = 500) {
    super(message);
    this.name = "RenovationGenerationError";
  }
}

export interface RenovationImageGenerationAdapter {
  generate(input: RenovationVisualizationInput): Promise<RenovationVisualizationOutput>;
}

class OpenAiRenovationImageAdapter implements RenovationImageGenerationAdapter {
  async generate(input: RenovationVisualizationInput): Promise<RenovationVisualizationOutput> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new RenovationGenerationError("MISSING_API_KEY", "Brak konfiguracji OPENAI_API_KEY.", 503);

    const sourceImage = await downloadSourceImage(input.imageUrl);
    const form = new FormData();
    form.append("model", process.env.OPENAI_IMAGE_MODEL ?? "gpt-image-2");
    form.append("image", new Blob([sourceImage.bytes], { type: sourceImage.contentType }), `room.${extensionFor(sourceImage.contentType)}`);
    form.append("prompt", buildRenovationPrompt(input));
    form.append("quality", "medium");
    form.append("size", "auto");
    form.append("output_format", "png");

    let response: Response;
    try {
      response = await fetch("https://api.openai.com/v1/images/edits", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
        signal: AbortSignal.timeout(OPENAI_TIMEOUT_MS),
      });
    } catch (error) {
      console.error(error);
      if (error instanceof Error) console.error("OPENAI IMAGE FETCH STACK", error.stack);
      if (isTimeout(error)) throw new RenovationGenerationError("TIMEOUT", "Generowanie wizualizacji przekroczyło limit czasu.", 504);
      throw new RenovationGenerationError("OPENAI_API_ERROR", "Nie udało się połączyć z usługą generowania obrazu.", 502);
    }

    await assertOpenAiResponse(response);
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      console.error("OPENAI RENOVATION IMAGE ERROR", JSON.stringify({ status: response.status, requestId: response.headers.get("x-request-id"), error: apiErrorMessage(payload) }));
      throw new RenovationGenerationError("OPENAI_API_ERROR", "OpenAI nie wygenerowało wizualizacji. Spróbuj ponownie.", 502);
    }
    const base64 = imageBase64(payload);
    if (!base64) throw new RenovationGenerationError("OPENAI_API_ERROR", "OpenAI zwróciło odpowiedź bez obrazu.", 502);
    const imageDataUrl = `data:image/png;base64,${base64}`;
    const estimate = renovationEstimate(input.renovationLevel, input.budget);

    return {
      generatedImageUrl: imageDataUrl,
      imageDataUrl,
      changes: suggestedChanges(input.style, input.renovationLevel),
      estimatedRenovationMin: estimate.min,
      estimatedRenovationMax: estimate.max,
      confidence: 82,
      warnings: warningsFor(),
    };
  }
}

export const renovationImageGenerationAdapter: RenovationImageGenerationAdapter = new OpenAiRenovationImageAdapter();

export async function downloadSourceImage(imageUrl: string): Promise<{ bytes: ArrayBuffer; contentType: string }> {
  let currentUrl = new URL(imageUrl);
  for (let redirect = 0; redirect <= 3; redirect += 1) {
    await assertPublicHttpUrl(currentUrl);
    let response: Response;
    try {
      response = await fetch(currentUrl, {
        redirect: "manual",
        headers: { Accept: "image/jpeg,image/png,image/webp", "User-Agent": "FlipManager-RenovationVisualizer/1.0" },
        signal: AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS),
      });
    } catch (error) {
      if (isTimeout(error)) throw new RenovationGenerationError("TIMEOUT", "Pobieranie zdjęcia przekroczyło limit czasu.", 504);
      throw new RenovationGenerationError("IMAGE_FETCH_FAILED", "Nie udało się pobrać wybranego zdjęcia.", 422);
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location || redirect === 3) throw new RenovationGenerationError("IMAGE_FETCH_FAILED", "Zdjęcie ma nieprawidłowe przekierowanie.", 422);
      currentUrl = new URL(location, currentUrl);
      continue;
    }
    if (!response.ok) throw new RenovationGenerationError("IMAGE_FETCH_FAILED", `Nie udało się pobrać zdjęcia (HTTP ${response.status}).`, 422);
    const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
    if (!ALLOWED_IMAGE_TYPES.has(contentType)) throw new RenovationGenerationError("IMAGE_FETCH_FAILED", "Wybrany URL nie prowadzi do obsługiwanego obrazu JPG, PNG lub WebP.", 422);
    const declaredSize = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredSize) && declaredSize > MAX_IMAGE_BYTES) throw new RenovationGenerationError("IMAGE_FETCH_FAILED", "Zdjęcie przekracza limit 20 MB.", 413);
    const bytes = await response.arrayBuffer();
    if (!bytes.byteLength || bytes.byteLength > MAX_IMAGE_BYTES) throw new RenovationGenerationError("IMAGE_FETCH_FAILED", "Zdjęcie jest puste lub przekracza limit 20 MB.", 413);
    return { bytes, contentType };
  }
  throw new RenovationGenerationError("IMAGE_FETCH_FAILED", "Nie udało się pobrać zdjęcia.", 422);
}

function suggestedChanges(style: RenovationStyle, level: RenovationLevel): string[] {
  const changes = ["Odświeżenie kolorystyki ścian i wykończeń", "Dopasowanie oświetlenia i wyposażenia do wybranego stylu", "Zachowanie istniejącego układu, okien, drzwi i ścian"];
  if (level !== "refresh") changes.unshift("Wymiana widocznych podłóg i zużytych elementów wykończenia");
  if (level === "general") changes.push("Wymiana widocznej zabudowy i armatury bez zmian konstrukcyjnych");
  if (style === "flip-budget") changes.push("Zastosowanie trwałych, łatwo dostępnych materiałów budżetowych");
  return changes;
}

function warningsFor(): string[] {
  return ["Wizualizacja ma charakter koncepcyjny; kolory, skala i detale wymagają pomiarów na miejscu.", "Zmiany konstrukcyjne wymagają projektu i weryfikacji.", "Zmiany instalacji i elementów stałych wymagają oceny wykonawcy."];
}

function renovationEstimate(level: RenovationLevel, budget: number): { min: number; max: number } {
  const factor = level === "refresh" ? { min: 0.45, max: 0.75 } : level === "standard" ? { min: 0.7, max: 1 } : { min: 0.9, max: 1.25 };
  return { min: Math.round(budget * factor.min), max: Math.round(budget * factor.max) };
}

async function assertPublicHttpUrl(url: URL): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new RenovationGenerationError("IMAGE_FETCH_FAILED", "Nieprawidłowy protokół URL zdjęcia.", 400);
  if (url.username || url.password || url.port) throw new RenovationGenerationError("IMAGE_FETCH_FAILED", "Nieprawidłowy URL zdjęcia.", 400);
  const addresses = isIP(url.hostname) ? [{ address: url.hostname }] : await lookup(url.hostname, { all: true }).catch(() => []);
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) throw new RenovationGenerationError("IMAGE_FETCH_FAILED", "URL zdjęcia wskazuje na niedozwolony adres sieciowy.", 400);
}

function isPrivateAddress(address: string): boolean {
  const value = address.toLowerCase();
  if (value === "::1" || value === "0.0.0.0" || value.startsWith("fe80:") || value.startsWith("fc") || value.startsWith("fd")) return true;
  const parts = value.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return false;
  return parts[0] === 10 || parts[0] === 127 || parts[0] === 0 || (parts[0] === 169 && parts[1] === 254) || (parts[0] === 172 && (parts[1] ?? 0) >= 16 && (parts[1] ?? 0) <= 31) || (parts[0] === 192 && parts[1] === 168);
}

function imageBase64(value: unknown): string | null {
  if (!isRecord(value) || !Array.isArray(value.data) || !isRecord(value.data[0])) return null;
  return typeof value.data[0].b64_json === "string" && value.data[0].b64_json ? value.data[0].b64_json : null;
}
function apiErrorMessage(value: unknown): string | null { return isRecord(value) && isRecord(value.error) && typeof value.error.message === "string" ? value.error.message : null; }
async function assertOpenAiResponse(response: Response): Promise<void> {
  if (response.ok) return;
  const body = await response.clone().text();
  console.error("OPENAI IMAGE ERROR", {
    status: response.status,
    statusText: response.statusText,
    body,
  });
  console.error("OPENAI IMAGE ERROR BODY", body);
  const payload = parseJson(body);
  throw new RenovationGenerationError(
    "OPENAI_API_ERROR",
    apiErrorMessage(payload) ?? (body || `OpenAI HTTP ${response.status}: ${response.statusText}`),
    502,
  );
}
function parseJson(value: string): unknown { try { return JSON.parse(value) as unknown; } catch { return null; } }
function extensionFor(type: string): string { return type === "image/png" ? "png" : type === "image/webp" ? "webp" : "jpg"; }
function isTimeout(error: unknown): boolean { return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError"); }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
