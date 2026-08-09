import type { AiLocationResolution, ComparableReviewer, LocationInput } from "./types.ts";

const RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["street", "neighborhood", "district", "city", "confidence", "evidence"],
  properties: {
    street: { type: ["string", "null"] },
    neighborhood: { type: ["string", "null"] },
    district: { type: ["string", "null"] },
    city: { type: ["string", "null"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    evidence: { type: "string" },
  },
} as const;

export async function resolveLocationWithAi(input: LocationInput): Promise<AiLocationResolution | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({
      model: process.env.OPENAI_LOCATION_MODEL ?? "gpt-5-mini",
      store: false,
      instructions: "Klasyfikuj wyłącznie podaną lokalizację w Polsce. Jawna nazwa osiedla w tytule lub opisie ma pierwszeństwo. Nie zgaduj ulicy ani miasta. Neighborhood zwracaj tylko przy confidence >= 0.75. Evidence musi być krótkim, dosłownym fragmentem przekazanego źródła.",
      input: JSON.stringify({
        address: input.address,
        street: input.street,
        district: input.district,
        city: input.city,
        locationText: input.locationText,
        title: input.title,
        description: input.description,
      }),
      text: { format: { type: "json_schema", name: "location_resolution", strict: true, schema: RESPONSE_SCHEMA } },
    }),
  });

  if (!response.ok) {
    console.error("AI LOCATION RESOLVER ERROR", { status: response.status });
    return null;
  }

  return parseResolution(await response.json());
}

// Punkt rozszerzenia na drugi etap; celowo nigdzie nieużywany przez Market Intelligence.
export async function reviewComparable<T>(target: T, comparable: T, reviewer: ComparableReviewer<T>) {
  return reviewer(target, comparable);
}

function parseResolution(payload: unknown): AiLocationResolution | null {
  const text = outputText(payload);
  if (!text) return null;
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    if (typeof value.confidence !== "number" || typeof value.evidence !== "string") return null;
    return {
      street: nullableString(value.street),
      neighborhood: nullableString(value.neighborhood),
      district: nullableString(value.district),
      city: nullableString(value.city),
      confidence: Math.max(0, Math.min(1, value.confidence)),
      evidence: value.evidence,
    };
  } catch {
    return null;
  }
}

function outputText(payload: unknown): string | null {
  if (!isRecord(payload) || !Array.isArray(payload.output)) return null;
  for (const output of payload.output) {
    if (!isRecord(output) || !Array.isArray(output.content)) continue;
    for (const content of output.content) {
      if (isRecord(content) && content.type === "output_text" && typeof content.text === "string") return content.text;
    }
  }
  return null;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.normalize("NFC").trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
