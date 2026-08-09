const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  apos: "'",
  copy: "©",
  gt: ">",
  laquo: "«",
  ldquo: "“",
  lsquo: "‘",
  lt: "<",
  mdash: "—",
  ndash: "–",
  nbsp: " ",
  quot: '"',
  raquo: "»",
  rdquo: "”",
  reg: "®",
  rsquo: "’",
  trade: "™",
};

/**
 * Converts listing HTML into safe, readable plain text for React rendering.
 * The listing data remains unchanged; this is intentionally a display-only transform.
 */
export function formatListingDescription(value: string | null | undefined): string {
  if (!value?.trim()) return "";

  const withStructure = value
    .replace(/\r\n?/g, "\n")
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\s*\/\s*p\s*>/gi, "\n\n")
    .replace(/<\s*\/\s*(?:div|h[1-6]|blockquote)\s*>/gi, "\n\n")
    .replace(/<\s*li\b[^>]*>/gi, "\n• ")
    .replace(/<\s*\/\s*li\s*>/gi, "")
    .replace(/<\s*\/\s*(?:ul|ol)\s*>/gi, "\n")
    .replace(/<[^>]*>/g, "");

  const decoded = decodeHtmlEntities(withStructure);
  const paragraphs = decoded
    .split(/\n\s*\n+/)
    .map((paragraph) => paragraph
      .split("\n")
      .map((line) => line.replace(/[\t ]+/g, " ").trim())
      .filter(Boolean)
      .join("\n"))
    .filter(Boolean);

  return paragraphs.join("\n\n");
}

function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z][\da-z]+);/gi, (entity, token: string) => {
    const normalized = token.toLowerCase();
    if (normalized.startsWith("#x")) return codePointToString(Number.parseInt(normalized.slice(2), 16), entity);
    if (normalized.startsWith("#")) return codePointToString(Number.parseInt(normalized.slice(1), 10), entity);
    return NAMED_ENTITIES[normalized] ?? entity;
  });
}

function codePointToString(value: number, fallback: string): string {
  if (!Number.isInteger(value) || value < 0 || value > 0x10ffff) return fallback;
  return String.fromCodePoint(value);
}
