const DEFAULT_RETURN_TO = "/dashboard";
const MAX_RETURN_TO_LENGTH = 2_048;

export function safeReturnTo(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_RETURN_TO_LENGTH) return DEFAULT_RETURN_TO;
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return DEFAULT_RETURN_TO;
  try {
    const url = new URL(value, "https://flip-manager.invalid");
    if (url.origin !== "https://flip-manager.invalid") return DEFAULT_RETURN_TO;
    if (url.pathname === "/login" || url.pathname.startsWith("/auth/")) return DEFAULT_RETURN_TO;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return DEFAULT_RETURN_TO;
  }
}
