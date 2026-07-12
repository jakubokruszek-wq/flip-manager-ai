import {
  PropertyImportResult,
  ImportSource,
} from "../types";

function detectSource(url: string): ImportSource {
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

export async function importProperty(
  url: string
): Promise<PropertyImportResult> {
  const source = detectSource(url);

  return {
    source,
    url,
  };
}