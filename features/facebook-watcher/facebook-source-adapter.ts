import { normalizeFacebookListing } from "./normalize-facebook-listing";
import type { FacebookListingInput } from "./types";

export interface FacebookSourceAdapter {
  importManual(input: FacebookListingInput): Promise<FacebookListingInput>;
  importFromUrl?(url: string): Promise<FacebookListingInput>;
}

export class FacebookSourceError extends Error {
  constructor(public readonly code: "MANUAL_IMPORT_REQUIRED" | "INVALID_INPUT", message: string) { super(message); }
}

export const manualFacebookAdapter: FacebookSourceAdapter = {
  async importManual(input) {
    const normalized = normalizeFacebookListing(input);
    if (!normalized.postText && !normalized.url) throw new FacebookSourceError("INVALID_INPUT", "Wklej treść posta lub link.");
    if (input.url && !normalized.url) throw new FacebookSourceError("INVALID_INPUT", "Podaj prawidłowy link Facebook HTTPS.");
    if (!normalized.postText && !(normalized.images?.length)) throw new FacebookSourceError("MANUAL_IMPORT_REQUIRED", "Facebook nie udostępnia bezpiecznego publicznego odczytu tego posta. Wklej jego treść lub dodaj screenshot.");
    return normalized;
  },
  async importFromUrl() {
    throw new FacebookSourceError("MANUAL_IMPORT_REQUIRED", "Wklej treść posta — moduł nie omija logowania, CAPTCHA ani zabezpieczeń Facebooka.");
  },
};
