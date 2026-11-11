import { MAX_FILE_SIZE, validateFile } from "./files";
import type { FileCategory } from "./model";
async function hashFile(file: File) {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
export async function uploadWorkspaceFile(propertyId: string, file: File, category: FileCategory): Promise<string> {
  if (file.size > MAX_FILE_SIZE) throw new Error("Plik może mieć maksymalnie 12 MB.");
  const checked = validateFile(new Uint8Array(await file.slice(0, 64).arrayBuffer()), category);
  const sha256 = await hashFile(file);
  const endpoint = `/api/properties/${propertyId}/files`;
  const prepared = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "prepare", name: file.name.slice(0, 200), size: file.size, mime: checked.mime, category, sha256 }) });
  const session = await prepared.json(); if (!prepared.ok) throw new Error(session.message || "Nie udało się przygotować dokumentu.");
  if (session.duplicate) return session.id;
  const storageOrigin = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).origin;
  if (typeof session.uploadUrl !== "string" || new URL(session.uploadUrl).origin !== storageOrigin) throw new Error("Nieprawidłowy adres przesyłania dokumentu.");
  const uploaded = await fetch(session.uploadUrl, { method: "PUT", headers: { "Content-Type": checked.mime, "x-upsert": "false" }, body: file, redirect: "error" });
  if (!uploaded.ok) throw new Error("Nie udało się przesłać pliku. Sprawdź połączenie i spróbuj ponownie.");
  const finalized = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "finalize", id: session.id }) });
  const result = await finalized.json(); if (!finalized.ok) throw new Error(result.message || "Nie udało się zatwierdzić dokumentu.");
  return result.id;
}
