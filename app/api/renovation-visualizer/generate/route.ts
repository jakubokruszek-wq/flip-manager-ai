import { renovationImageGenerationAdapter, RenovationGenerationError } from "@/features/renovation-visualizer/server";
import { parseRenovationVisualizationInput } from "@/features/renovation-visualizer/utils";
import type { RenovationVisualizerApiResponse } from "@/features/renovation-visualizer/types";

export const maxDuration = 180;

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try { body = await request.json(); } catch { body = null; }
  const input = parseRenovationVisualizationInput(body);
  if (!input) return json({ ok: false, code: "INVALID_INPUT", message: "Brak zdjęcia lub nieprawidłowe dane wizualizacji." }, 400);

  try {
    const result = await renovationImageGenerationAdapter.generate(input);
    return json({ ok: true, result }, 200);
  } catch (error) {
    console.error(error);
    if (error instanceof Error) console.error("RENOVATION VISUALIZER STACK", error.stack);
    if (error instanceof RenovationGenerationError) return json({ ok: false, code: error.code, message: error.message }, error.status);
    console.error("RENOVATION VISUALIZER GENERATION ERROR", { propertyId: input.propertyId, error });
    return json({ ok: false, code: "GENERATION_FAILED", message: "Nie udało się wygenerować wizualizacji." }, 500);
  }
}

function json(payload: RenovationVisualizerApiResponse, status: number): Response {
  return Response.json(payload, { status });
}
