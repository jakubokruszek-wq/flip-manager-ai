import type { FileCategory } from "./model";
import { fileCategories } from "./model";
export const PRIVATE_BUCKET = "property-workspace-private";
export const MAX_FILE_SIZE = 12 * 1024 * 1024;
export function validateFile(bytes: Uint8Array, category: string): { mime: string; extension: string; category: FileCategory } {
  if (!Object.hasOwn(fileCategories, category)) throw new Error("Wybierz kategorię dokumentu.");
  if (!bytes.length || bytes.length > MAX_FILE_SIZE) throw new Error("Plik może mieć maksymalnie 12 MB.");
  const starts = (...v: number[]) => v.every((b, i) => bytes[i] === b);
  let mime = "", extension = "";
  if (starts(0xff, 0xd8, 0xff)) { mime = "image/jpeg"; extension = "jpg"; }
  else if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) { mime = "image/png"; extension = "png"; }
  else if (new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" && new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP") { mime = "image/webp"; extension = "webp"; }
  else if (new TextDecoder().decode(bytes.slice(0, 5)) === "%PDF-") { mime = "application/pdf"; extension = "pdf"; }
  else throw new Error("Obsługiwane pliki: JPG, PNG, WebP i PDF. Zdjęcie HEIC zapisz jako JPG.");
  if (["viewing", "before", "during", "after"].includes(category) && !mime.startsWith("image/")) throw new Error("W tej kategorii dodaj zdjęcie.");
  return { mime, extension, category: category as FileCategory };
}
