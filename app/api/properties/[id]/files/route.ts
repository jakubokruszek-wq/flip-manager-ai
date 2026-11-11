import { createHash, randomUUID } from "node:crypto";
import { operatorAuthorizationResponse, OperatorAuthorizationError, requireOperator } from "@/features/auth/operator";
import { workspaceAccess, UUID } from "@/features/property-workspace/server";
import { fileCategories } from "@/features/property-workspace/model";
import { MAX_FILE_SIZE, PRIVATE_BUCKET, validateFile } from "@/features/property-workspace/files";
type Context = { params: Promise<{ id: string }> };
async function input(request: Request): Promise<Record<string, unknown>> {
  const reader = request.body?.getReader(); if (!reader) throw new Error("Brak danych pliku.");
  const chunks: Uint8Array[] = []; let size = 0;
  try { for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 16384) throw new Error("Za dużo danych pliku."); chunks.push(value); } }
  finally { await reader.cancel(); }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Nieprawidłowe dane pliku.");
  return value as Record<string, unknown>;
}
function responseError(error: unknown) {
  if (error instanceof OperatorAuthorizationError) return operatorAuthorizationResponse(error);
  return Response.json({ message: error instanceof Error ? error.message : "Nie udało się zapisać dokumentu." }, { status: 400 });
}
export async function POST(request: Request, { params }: Context) {
  try {
    const { id } = await params; const { db, operator } = await workspaceAccess(id, await requireOperator()); const body = await input(request);
    if (body.action === "prepare") {
      if (typeof body.name !== "string" || !body.name.trim() || body.name.length > 200 || typeof body.category !== "string" || !Object.hasOwn(fileCategories, body.category) || typeof body.mime !== "string" || !["image/jpeg", "image/png", "image/webp", "application/pdf"].includes(body.mime) || !Number.isSafeInteger(body.size) || Number(body.size) <= 0 || Number(body.size) > MAX_FILE_SIZE || typeof body.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(body.sha256)) throw new Error("Wybierz JPG, PNG, WebP lub PDF do 12 MB i kategorię dokumentu.");
      // Best-effort reclamation of abandoned uploads belonging to this operator.
      const { data: expired } = await db.from("property_workspace_uploads").select("id,path").eq("owner_id", operator.id).lt("expires_at", new Date().toISOString()).limit(20);
      for (const row of expired ?? []) {
        const { data: completed } = await db.from("property_workspace_files").select("id").eq("id", row.id).maybeSingle();
        const result = completed ? { error: null } : await db.storage.from(PRIVATE_BUCKET).remove([row.path]);
        if (!result.error) await db.from("property_workspace_uploads").delete().eq("id", row.id).eq("owner_id", operator.id);
      }
      const [existingResult, countResult] = await Promise.all([
        db.from("property_workspace_files").select("id,category").eq("property_id", id).eq("owner_id", operator.id).eq("sha256", body.sha256).maybeSingle(),
        db.from("property_workspace_files").select("id", { count: "exact", head: true }).eq("property_id", id).eq("owner_id", operator.id),
      ]);
      if (existingResult.error || countResult.error) throw new Error("Nie udało się sprawdzić zapisanych dokumentów.");
      if (existingResult.data) return Response.json({ id: existingResult.data.id, duplicate: true });
      if ((countResult.count ?? 0) >= 500) throw new Error("Ta nieruchomość ma już 500 załączników.");
      const fileId = randomUUID(); const extension = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "application/pdf": "pdf" }[body.mime]!;
      const path = `${operator.id}/${id}/${fileId}.${extension}`;
      const { error } = await db.from("property_workspace_uploads").insert({ id: fileId, property_id: id, owner_id: operator.id, name: body.name.replace(/[\x00-\x1f/\\]/g, "_").trim(), category: body.category, mime: body.mime, size: body.size, sha256: body.sha256, path });
      if (error) throw new Error("Nie udało się przygotować przesyłania dokumentu.");
      const signed = await db.storage.from(PRIVATE_BUCKET).createSignedUploadUrl(path, { upsert: false });
      if (signed.error || !signed.data) { await db.from("property_workspace_uploads").delete().eq("id", fileId).eq("owner_id", operator.id); throw new Error("Nie udało się otworzyć przesyłania. Spróbuj ponownie."); }
      return Response.json({ id: fileId, uploadUrl: signed.data.signedUrl, duplicate: false });
    }
    if (body.action !== "finalize" || typeof body.id !== "string" || !UUID.test(body.id)) throw new Error("Nieprawidłowa operacja dokumentu.");
    const previous = await db.from("property_workspace_files").select("id").eq("id", body.id).eq("property_id", id).eq("owner_id", operator.id).maybeSingle();
    if (previous.error) throw new Error("Nie udało się sprawdzić dokumentu.");
    if (previous.data) return Response.json({ id: previous.data.id, duplicate: false });
    const pending = await db.from("property_workspace_uploads").select("*").eq("id", body.id).eq("property_id", id).eq("owner_id", operator.id).maybeSingle();
    if (pending.error || !pending.data || Date.parse(pending.data.expires_at) <= Date.now()) throw new Error("Przesyłanie wygasło. Wybierz dokument ponownie.");
    const upload = pending.data;
    const cancel = async () => { const removed = await db.storage.from(PRIVATE_BUCKET).remove([upload.path]); if (!removed.error) await db.from("property_workspace_uploads").delete().eq("id", upload.id).eq("owner_id", operator.id); };
    const downloaded = await db.storage.from(PRIVATE_BUCKET).download(upload.path);
    if (downloaded.error || !downloaded.data) throw new Error("Plik jeszcze nie dotarł. Wybierz go ponownie, aby ponowić przesyłanie.");
    const bytes = new Uint8Array(await downloaded.data.arrayBuffer());
    try {
      const checked = validateFile(bytes, upload.category);
      if (bytes.length !== upload.size || checked.mime !== upload.mime || createHash("sha256").update(bytes).digest("hex") !== upload.sha256) throw new Error("Treść pliku nie zgadza się z przygotowanym dokumentem.");
    } catch (error) { await cancel(); throw error; }
    const { error: insertError } = await db.from("property_workspace_files").insert({ id: upload.id, property_id: id, owner_id: operator.id, name: upload.name, category: upload.category, mime: upload.mime, size: upload.size, path: upload.path, sha256: upload.sha256 });
    if (insertError) {
      if (insertError.code === "23505") {
        const existing = await db.from("property_workspace_files").select("id,path").eq("property_id", id).eq("owner_id", operator.id).eq("sha256", upload.sha256).maybeSingle();
        if (existing.data) { if (existing.data.path !== upload.path) await cancel(); return Response.json({ id: existing.data.id, duplicate: true }); }
      }
      throw new Error("Plik przesłano, ale nie udało się go przypisać. Spróbuj ponownie.");
    }
    await db.from("property_workspace_uploads").delete().eq("id", upload.id).eq("owner_id", operator.id);
    return Response.json({ id: upload.id, duplicate: false }, { status: 201 });
  } catch (error) { return responseError(error); }
}
export async function PATCH(request: Request, { params }: Context) {
  try {
    const { id } = await params; const { db, operator } = await workspaceAccess(id, await requireOperator()); const body = await input(request);
    if (typeof body.id !== "string" || !UUID.test(body.id) || typeof body.name !== "string" || !body.name.trim() || body.name.length > 200 || typeof body.category !== "string" || !Object.hasOwn(fileCategories, body.category)) throw new Error("Wpisz nazwę i kategorię dokumentu.");
    const current = await db.from("property_workspace_files").select("mime").eq("id", body.id).eq("property_id", id).eq("owner_id", operator.id).maybeSingle();
    if (current.error || !current.data) throw new Error("Nie znaleziono dokumentu.");
    if (current.data.mime === "application/pdf" && ["viewing", "before", "during", "after"].includes(body.category)) throw new Error("W tej kategorii wybierz zdjęcie.");
    const { data: file, error } = await db.from("property_workspace_files").update({ name: body.name.replace(/[\x00-\x1f/\\]/g, "_").trim(), category: body.category }).eq("id", body.id).eq("property_id", id).eq("owner_id", operator.id).select("id").maybeSingle();
    if (error || !file) throw new Error("Nie udało się zaktualizować dokumentu.");
    return Response.json({ id: file.id });
  } catch (error) { return responseError(error); }
}
