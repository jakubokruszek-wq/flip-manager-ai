export function preferredListingUrl(originalUrl: string | null, normalizedUrl: string | null, source: string, listingId: string, logInvalid = false): string | null {
  for (const candidate of [originalUrl, normalizedUrl]) {
    if (!candidate) continue;
    try {
      const url = new URL(candidate);
      if ((url.protocol === "http:" || url.protocol === "https:") && !/[\[\]{}]/.test(url.href)) return url.href;
    } catch {
      // The fallback is checked next.
    }
  }
  if (logInvalid && (originalUrl || normalizedUrl)) console.warn("MARKET COMPARABLE INVALID URL", { source, listingId, url: originalUrl ?? normalizedUrl });
  return null;
}
