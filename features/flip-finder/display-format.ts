const FRIENDLY_FIELD_LABELS: Record<string, string> = {
  address: "dokładny adres",
  area: "metraż",
  buildingType: "typ budynku",
  city: "miasto",
  district: "dzielnica",
  floor: "piętro",
  ownership: "forma własności",
  price: "cena",
  rooms: "liczba pokoi",
  topFloor: "liczba pięter w budynku",
  totalFloors: "liczba pięter w budynku",
};

/** Display-only cleanup; raw Facebook evidence is never changed. */
export function cleanDisplayText(value: string | null | undefined): string {
  if (!value?.trim()) return "";
  return value
    .normalize("NFC")
    .replace(/\*{2,}|_{2,}/g, "")
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, " ")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[\t ]+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

/** Removes repeated address/district/city fragments without changing evidence. */
export function dedupeLocationText(value: string | null | undefined): string | null {
  if (!value?.trim()) return null;
  const seen = new Set<string>();
  const parts = value.split(/[;,]+/u).map((part) => part.trim()).filter(Boolean).filter((part) => {
    const key = comparableLocationPart(part);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return parts.length > 0 ? parts.join(", ") : null;
}

export function friendlyFieldLabel(field: string): string {
  const key = field.trim();
  if (FRIENDLY_FIELD_LABELS[key]) return FRIENDLY_FIELD_LABELS[key];
  return key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").toLocaleLowerCase("pl-PL");
}

export function friendlyMissingFields(fields: string[] | null | undefined): string[] {
  return [...new Set((fields ?? []).map(friendlyFieldLabel))];
}

function comparableLocationPart(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase("pl-PL").replace(/[^\p{L}\p{N}]+/gu, "").trim();
}
