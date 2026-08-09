import type { PropertyDetectedSource } from "@/features/properties/types/property";

export function detectSource(url: string): PropertyDetectedSource {
  const value = url.toLowerCase();

  if (value.includes("otodom")) return "otodom";

  if (value.includes("olx")) return "olx";

  if (value.includes("gratka")) return "gratka";

  if (value.includes("morizon")) return "morizon";

  if (
    value.includes("facebook.com") ||
    value.includes("fb.com")
  ) {
    return "facebook";
  }

  return "unknown";
}
