/** Price storage is always integer grosz, including when entered in thousands. */
export function formatPriceEntry(value: number | null, thousands: boolean): string {
  return value === null ? "" : (value / (thousands ? 100000 : 100)).toFixed(thousands ? 5 : 2).replace(/\.?0+$/, "");
}
export function parsePriceEntry(text: string, thousands: boolean): number | null {
  if (!text.trim()) return null;
  const normalized = text.replace(/\s/g, "").replace(",", ".");
  const digits = thousands ? 5 : 2;
  if (!new RegExp(`^\\d+(?:\\.\\d{0,${digits}})?$`).test(normalized)) throw new Error("Niepoprawna cena");
  const [whole, fraction = ""] = normalized.split(".");
  const value = Number(whole) * 10 ** digits + Number(fraction.padEnd(digits, "0"));
  if (!Number.isSafeInteger(value) || value > 100000000000) throw new Error("Cena jest za duża");
  return value;
}
