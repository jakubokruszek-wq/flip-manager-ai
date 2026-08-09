import { RENOVATION_LEVELS, RENOVATION_OPTION_KEYS, RENOVATION_STYLES, type RenovationLevel, type RenovationOption, type RenovationVisualizationInput } from "../types";

export function parseRenovationVisualizationInput(value: unknown): RenovationVisualizationInput | null {
  if (!isRecord(value)) return null;
  const propertyId = text(value.propertyId);
  const imageUrl = safeHttpUrl(value.imageUrl);
  const instructions = typeof value.instructions === "string" ? value.instructions.trim().slice(0, 2_000) : null;
  const budget = typeof value.budget === "number" && Number.isFinite(value.budget) && value.budget >= 20_000 && value.budget <= 150_000 ? value.budget : null;
  const options = Array.isArray(value.options) ? [...new Set(value.options.filter((item): item is RenovationOption => RENOVATION_OPTION_KEYS.includes(item as RenovationOption)))] : null;
  if (!propertyId || !imageUrl || instructions === null || budget === null || !options) return null;
  if (!RENOVATION_STYLES.includes(value.style as never) || !RENOVATION_LEVELS.includes(value.renovationLevel as never)) return null;
  return { propertyId, imageUrl, style: value.style as RenovationVisualizationInput["style"], renovationLevel: value.renovationLevel as RenovationLevel, budget, options, instructions };
}

function safeHttpUrl(value: unknown): string | null { if (typeof value !== "string") return null; try { const url = new URL(value); return url.protocol === "http:" || url.protocol === "https:" ? url.href : null; } catch { return null; } }
function text(value: unknown): string | null { return typeof value === "string" && value.trim() ? value.trim() : null; }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
