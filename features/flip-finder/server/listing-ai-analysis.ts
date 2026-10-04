import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { calculateContentHash } from "@/features/flip-finder/otodom-search";
import { captureOpenAIResponseUsage } from "@/features/facebook-worker/openai-pricing";
import type { FacebookVisionUsage } from "@/features/facebook-worker/types";

/**
 * Advisory-only AI observations about a listing's own description and its
 * own already-confirmed photos. Nothing here is read by filter matching,
 * underwriting, or the deterministic price/renovation-cost/profit/ROI
 * math -- it exists purely to give an operator reviewing a "Do oceny"
 * (REVIEW) card a human-readable hint, cached per listing so the API is
 * called at most once per unique description and once per unique confirmed
 * image set, never on every Finder render.
 */

const DEFAULT_MODEL = "gpt-6-luna";
const MAX_DESCRIPTION_CHARS = 4_000;
const MAX_CONFIRMED_IMAGES = 4;
const TEXT_ANALYSIS_TIMEOUT_MS = 20_000;
const PHOTO_ANALYSIS_TIMEOUT_MS = 30_000;
/** Guards against treating a pathologically large or malformed response body as real data. */
const MAX_RESPONSE_TEXT_LENGTH = 200_000;

export type ListingAiTextFindings = {
  buildingTypeHint: string | null;
  ownershipHint: string | null;
  yearBuiltHint: number | null;
  conditionSummary: string | null;
  renovationMentioned: boolean | null;
  confidence: number;
  missingInfo: string[];
};

export type ListingAiPhotoFindings = {
  visibleCondition: string | null;
  visibleFinish: string | null;
  visibleRenovationNeeds: string[];
  confidence: number;
  missingInfo: string[];
  photosAnalyzed: number;
};

export type ListingAiAnalysisRow = {
  listingId: string;
  contentHash: string;
  imagesHash: string | null;
  model: string;
  textFindings: ListingAiTextFindings | null;
  photoFindings: ListingAiPhotoFindings | null;
  analyzedAt: string;
};

const TEXT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["buildingTypeHint", "ownershipHint", "yearBuiltHint", "conditionSummary", "renovationMentioned", "confidence", "missingInfo"],
  properties: {
    buildingTypeHint: { type: ["string", "null"] },
    ownershipHint: { type: ["string", "null"] },
    yearBuiltHint: { type: ["integer", "null"] },
    conditionSummary: { type: ["string", "null"] },
    renovationMentioned: { type: ["boolean", "null"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    missingInfo: { type: "array", items: { type: "string" } },
  },
} as const;

// Deliberately excludes ownership, rooms, area, and any other apartment
// parameter or hidden-defect field -- the schema makes it structurally
// impossible for the model to return one, not just a prompt instruction
// that could be ignored.
const PHOTO_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["visibleCondition", "visibleFinish", "visibleRenovationNeeds", "confidence", "missingInfo"],
  properties: {
    visibleCondition: { type: ["string", "null"] },
    visibleFinish: { type: ["string", "null"] },
    visibleRenovationNeeds: { type: "array", items: { type: "string" } },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    missingInfo: { type: "array", items: { type: "string" } },
  },
} as const;

/**
 * Only images already present on the listing's OWN record are eligible --
 * this never fetches or considers any image from elsewhere. By the time a
 * listing reaches here, its `images` array has already been through each
 * source's own confirmation step (a portal parser's own per-card HTML/
 * JSON-LD scoping, or Facebook Watcher's own mirrorable-media gate before a
 * Facebook-origin listing is persisted through this same persistListing
 * path). This is a second, source-agnostic hygiene pass on top of that --
 * well-formed absolute https URLs only, deduplicated, capped -- never the
 * primary confirmation itself, and it never reaches into a neighboring
 * post, page element, or any other listing for an image.
 */
export function confirmedListingImages(images: readonly unknown[] | null | undefined): string[] {
  if (!images) return [];
  const seen = new Set<string>();
  const confirmed: string[] = [];
  for (const raw of images) {
    if (typeof raw !== "string" || !raw.trim()) continue;
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      continue;
    }
    if (url.protocol !== "https:") continue;
    const normalized = url.toString();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    confirmed.push(normalized);
    if (confirmed.length >= MAX_CONFIRMED_IMAGES) break;
  }
  return confirmed;
}

export async function analyzeListingDescriptionWithAi(
  description: string | null,
  context: { title: string | null; city: string | null },
  options: { timeoutMs?: number } = {},
): Promise<{ findings: ListingAiTextFindings; usage: FacebookVisionUsage } | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  const trimmed = description?.trim() ?? "";
  if (!apiKey || !trimmed) return null;
  const requestedModel = process.env.OPENAI_MODEL ?? DEFAULT_MODEL;
  const truncated = trimmed.slice(0, MAX_DESCRIPTION_CHARS);
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(options.timeoutMs ?? TEXT_ANALYSIS_TIMEOUT_MS),
    body: JSON.stringify({
      model: requestedModel,
      store: false,
      instructions:
        "Przeanalizuj WYŁĄCZNIE podany opis oferty nieruchomości. Wypełnij pole tylko wtedy, gdy wynika ono bezpośrednio z tekstu opisu -- nigdy nie zgaduj, nie szacuj i nie wnioskuj z wieku budynku, materiału ani własnej wiedzy ogólnej. Jeśli informacja nie jest wprost podana w opisie, zwróć null dla tego pola i dodaj jego nazwę (po angielsku, nazwa klucza) do missingInfo. renovationMentioned ma być true tylko gdy opis wprost wspomina o potrzebie lub wykonaniu remontu, false gdy wprost wspomina że remont nie jest potrzebny, a null gdy opis się do tego nie odnosi. confidence to Twoja ogólna pewność co do wypełnionych (nie-null) pól, w zakresie 0-1.",
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: `Tytuł: ${context.title ?? "(brak)"}\nMiasto: ${context.city ?? "(brak)"}\nOpis oferty:\n${truncated}`,
            },
          ],
        },
      ],
      text: { format: { type: "json_schema", name: "listing_description_findings", strict: true, schema: TEXT_SCHEMA } },
    }),
  });
  const { payload, text } = await readOpenAiResponse(response);
  if (!response.ok) throw new Error(`Analiza opisu oferty nie powiodła się (OpenAI HTTP ${response.status}).`);
  if (!text) throw new Error("OpenAI nie zwróciło treści analizy opisu.");
  const value = JSON.parse(text) as ListingAiTextFindings;
  const usage = captureOpenAIResponseUsage(payload, requestedModel, response.headers.get("x-request-id"));
  return { findings: { ...value, confidence: clamp01(value.confidence) }, usage };
}

export async function analyzeListingPhotosWithAi(
  confirmedImageUrls: readonly string[],
  context: { title: string | null },
  options: { timeoutMs?: number } = {},
): Promise<{ findings: ListingAiPhotoFindings; usage: FacebookVisionUsage } | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || !confirmedImageUrls.length) return null;
  const requestedModel = process.env.OPENAI_MODEL ?? DEFAULT_MODEL;
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(options.timeoutMs ?? PHOTO_ANALYSIS_TIMEOUT_MS),
    body: JSON.stringify({
      model: requestedModel,
      store: false,
      instructions:
        "Oceń WYŁĄCZNIE to, co jest faktycznie widoczne na dołączonych zdjęciach tej jednej oferty. Nigdy nie zgaduj ukrytych usterek (np. wilgoć pod podłogą, stan instalacji), formy własności, liczby pokoi, metrażu ani żadnego innego parametru mieszkania -- to nie jest Twoje zadanie i nie ma go w schemacie odpowiedzi. visibleRenovationNeeds ma zawierać tylko konkretne, faktycznie widoczne elementy (np. \"widoczne pęknięcia na suficie\", \"stara instalacja elektryczna na widoku\"), nigdy domysły. Jeśli zdjęcia nie pokazują wystarczająco, żeby ocenić stan lub wykończenie, zwróć null/pustą listę dla tego pola i opisz brak w missingInfo. confidence to Twoja ogólna pewność co do wypełnionych pól, 0-1.",
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: `Tytuł oferty: ${context.title ?? "(brak)"}\nLiczba dołączonych, potwierdzonych zdjęć tej oferty: ${confirmedImageUrls.length}.` },
            ...confirmedImageUrls.map((imageUrl) => ({ type: "input_image" as const, image_url: imageUrl, detail: "auto" as const })),
          ],
        },
      ],
      text: { format: { type: "json_schema", name: "listing_photo_findings", strict: true, schema: PHOTO_SCHEMA } },
    }),
  });
  const { payload, text } = await readOpenAiResponse(response);
  if (!response.ok) throw new Error(`Analiza zdjęć oferty nie powiodła się (OpenAI HTTP ${response.status}).`);
  if (!text) throw new Error("OpenAI nie zwróciło treści analizy zdjęć.");
  const value = JSON.parse(text) as Omit<ListingAiPhotoFindings, "photosAnalyzed">;
  const usage = captureOpenAIResponseUsage(payload, requestedModel, response.headers.get("x-request-id"));
  return { findings: { ...value, confidence: clamp01(value.confidence), photosAnalyzed: confirmedImageUrls.length }, usage };
}

/**
 * Analyzes a listing's description and/or confirmed photos only if either
 * has actually changed since the last cached analysis (or there is none
 * yet) -- never on an unchanged re-scan, and never on a Finder page render,
 * since nothing here is ever called from a read/render path. Caches via an
 * upsert keyed on listing_id; whichever half (text/photo) is unchanged
 * keeps its previous cached value instead of being cleared. Degrades
 * silently (no-op, never throws) if the draft migration for this table has
 * not been applied yet, or if OPENAI_API_KEY is not configured, or if a
 * real API call fails -- this is advisory-only data, so missing it must
 * never fail the scan that is persisting the listing itself.
 */
export async function analyzeListingWithAiIfNeeded(
  supabase: SupabaseClient,
  listingId: string,
  item: { title: string | null; city: string | null; description: string | null; images?: string[] | null },
): Promise<void> {
  const descriptionHash = calculateContentHash({ description: item.description ?? "" });
  const confirmedImages = confirmedListingImages(item.images);
  const imagesHash = confirmedImages.length ? calculateContentHash({ images: confirmedImages }) : null;

  const existing = await supabase
    .from("listing_ai_analysis")
    .select("content_hash,images_hash,model,text_findings,photo_findings")
    .eq("listing_id", listingId)
    .maybeSingle();
  if (isMissingListingAiAnalysisTable(existing.error)) return;
  if (existing.error) {
    console.warn("LISTING_AI_ANALYSIS_READ_ERROR", { listingId, error: existing.error });
    return;
  }

  const cached = existing.data as { content_hash: string; images_hash: string | null; model: string; text_findings: unknown; photo_findings: unknown } | null;
  const textUnchanged = cached?.content_hash === descriptionHash;
  const photosUnchanged = cached ? cached.images_hash === imagesHash : imagesHash === null;
  if (textUnchanged && photosUnchanged) return;

  const requestedModel = process.env.OPENAI_MODEL ?? DEFAULT_MODEL;
  const [textOutcome, photoOutcome] = await Promise.all([
    textUnchanged ? null : analyzeListingDescriptionWithAi(item.description, { title: item.title, city: item.city }).catch((reason) => {
      console.warn("LISTING_AI_TEXT_ANALYSIS_FAILED", { listingId, error: reason instanceof Error ? reason.message : "unknown" });
      return null;
    }),
    photosUnchanged ? null : analyzeListingPhotosWithAi(confirmedImages, { title: item.title }).catch((reason) => {
      console.warn("LISTING_AI_PHOTO_ANALYSIS_FAILED", { listingId, error: reason instanceof Error ? reason.message : "unknown" });
      return null;
    }),
  ]);

  // Whichever half is unchanged keeps its previously cached value (null if
  // there was never a cached row); the half that changed gets its fresh
  // outcome, or null if that call failed or had nothing to analyze (e.g. an
  // empty description) -- still worth caching as "attempted, found
  // nothing" against this exact content_hash/images_hash, so an
  // unextractable description or a photo-less listing is never retried on
  // every subsequent scan.
  const textFindings = textUnchanged ? cached?.text_findings ?? null : textOutcome?.findings ?? null;
  const photoFindings = photosUnchanged ? cached?.photo_findings ?? null : photoOutcome?.findings ?? null;

  // A photo call's input necessarily includes the image(s) themselves, on
  // top of the same kind of text prompt a text-only call sends -- its own
  // reported input token count is therefore always higher for the same
  // listing, which this log line makes directly inspectable per call
  // rather than only implied by the two calls sharing one cost table.
  if (textOutcome) logListingAiUsage("text", listingId, textOutcome.usage);
  if (photoOutcome) logListingAiUsage("photo", listingId, photoOutcome.usage, confirmedImages.length);

  const { error: writeError } = await supabase.from("listing_ai_analysis").upsert(
    {
      listing_id: listingId,
      content_hash: descriptionHash,
      images_hash: imagesHash,
      model: requestedModel,
      text_findings: textFindings,
      photo_findings: photoFindings,
      analyzed_at: new Date().toISOString(),
    },
    { onConflict: "listing_id" },
  );
  if (writeError && !isMissingListingAiAnalysisTable(writeError)) {
    console.warn("LISTING_AI_ANALYSIS_WRITE_ERROR", { listingId, error: writeError });
  }
}

function logListingAiUsage(kind: "text" | "photo", listingId: string, usage: FacebookVisionUsage, photosAnalyzed?: number): void {
  console.info("LISTING_AI_USAGE", {
    kind,
    listingId,
    model: usage.model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    estimatedCostUsd: usage.estimatedCostUsd,
    dataQuality: usage.dataQuality,
    ...(photosAnalyzed !== undefined ? { photosAnalyzed } : {}),
  });
}

function isMissingListingAiAnalysisTable(error: { code?: unknown; message?: unknown } | null): boolean {
  if (!error) return false;
  const code = typeof error.code === "string" ? error.code : "";
  const message = typeof error.message === "string" ? error.message : "";
  return (code === "42P01" || code === "PGRST205") && /listing_ai_analysis/.test(message);
}

async function readOpenAiResponse(response: Response): Promise<{ payload: unknown; text: string | null }> {
  const raw = await response.text().catch(() => "");
  if (raw.length > MAX_RESPONSE_TEXT_LENGTH) {
    throw new Error(`Odpowiedź OpenAI przekroczyła dozwolony rozmiar (${raw.length} > ${MAX_RESPONSE_TEXT_LENGTH} znaków).`);
  }
  let payload: unknown = null;
  try {
    payload = raw ? JSON.parse(raw) : null;
  } catch {
    payload = null;
  }
  return { payload, text: outputText(payload) };
}

function outputText(payload: unknown): string | null {
  if (!isRecord(payload) || !Array.isArray(payload.output)) return null;
  for (const item of payload.output) {
    if (!isRecord(item) || !Array.isArray(item.content)) continue;
    for (const content of item.content) {
      if (isRecord(content) && content.type === "output_text" && typeof content.text === "string") return content.text;
    }
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clamp01(value: unknown): number {
  const num = typeof value === "number" && Number.isFinite(value) ? value : 0;
  return Math.max(0, Math.min(1, num));
}
