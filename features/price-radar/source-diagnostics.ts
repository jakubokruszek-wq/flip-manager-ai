const OTODOM_ROW_REJECTIONS = new Set([
  "invalid_url",
  "search_or_category_url",
  "missing_offer_id",
  "placeholder_url",
  "missing_title",
  "missing_price",
  "missing_area",
  "parser_error",
  "duplicate",
  "unsupported_listing",
]);

const PAGE_LIMIT = "PUBLIC_SEARCH_PAGE_LIMIT_REACHED";

export type RadarWarningClassification = "candidate_rejection" | "coverage_limit" | "informational" | "source_error";

/**
 * Warning strings are not all source failures. Adapters use bounded
 * machine-readable reasons for rejected individual rows, while fetch/parser/
 * persistence exceptions are thrown and handled by the caller as failures.
 * Unknown warning formats remain fail-closed until deliberately classified.
 */
export function classifyRadarSourceWarning(warning: string): RadarWarningClassification {
  const value = warning.trim();
  if (value.includes(PAGE_LIMIT)) return "coverage_limit";

  const invalidPrice = value.match(/^INVALID_SALE_PRICE:\s*.*?\b(\d+)\s+ofert(?:\s|$)/iu);
  if (invalidPrice) return "candidate_rejection";

  const otodomRejection = value.match(/^Otodom:\s*([a-z_]+)\s*\((\d+)\)$/u);
  if (otodomRejection && OTODOM_ROW_REJECTIONS.has(otodomRejection[1]!)) return "candidate_rejection";

  if (
    /^Otodom zwr[oó]ci(?:ł|l) pust[aą] pierwsz[aą] stron[eę] wynik[oó]w dla tego filtra\.$/iu.test(value)
    || /^Żadna oferta z pierwszej strony nie spełniła lokalnych warunków filtra\.$/iu.test(value)
    || /^Dzielnice nie są jeszcze niezawodnie mapowane do parametrów Otodom\.$/iu.test(value)
    || /^Morizon zwr[oó]ci(?:ł|l) pust[aą] list[eę] ofert\.$/iu.test(value)
  ) return "informational";

  return "source_error";
}

export function radarSourceStatusFromWarnings(warnings: readonly string[]): "completed" | "failed" | "partial" {
  const classifications = warnings.map(classifyRadarSourceWarning);
  if (classifications.includes("source_error")) return "failed";
  if (classifications.includes("coverage_limit")) return "partial";
  return "completed";
}

export function sourceRejectionCountsFromWarnings(warnings: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const warning of warnings) {
    const invalidPrice = warning.match(/^INVALID_SALE_PRICE:\s*.*?\b(\d+)\s+ofert(?:\s|$)/iu);
    if (invalidPrice) {
      addCount(counts, "invalid_sale_price", Number(invalidPrice[1]));
      continue;
    }
    const otodomRejection = warning.match(/^Otodom:\s*([a-z_]+)\s*\((\d+)\)$/u);
    if (otodomRejection && OTODOM_ROW_REJECTIONS.has(otodomRejection[1]!)) {
      addCount(counts, otodomRejection[1]!, Number(otodomRejection[2]));
    }
  }
  return counts;
}

function addCount(target: Record<string, number>, key: string, value: number): void {
  if (Number.isSafeInteger(value) && value > 0) target[key] = (target[key] ?? 0) + value;
}
