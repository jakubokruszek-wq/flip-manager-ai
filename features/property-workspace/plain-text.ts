/** Display imported HTML as text; never inject source markup into the page. */
export function plainText(value: string): string {
  return value.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "").replace(/<\s*(?:br\s*\/?|\/(?:p|div|li|h[1-6]))\s*>/gi, "\n").replace(/<[^>]*>/g, "").replace(/&(?:nbsp|amp|lt|gt|quot|apos|#39);/g, x => ({ "&nbsp;": " ", "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&#39;": "'" })[x]!).replace(/&#(x[\da-f]+|\d+);/gi, (all, code: string) => { const n = code[0].toLowerCase() === "x" ? parseInt(code.slice(1), 16) : Number(code); return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : all; }).replace(/\n{3,}/g, "\n\n").trim();
}
