import sharp from "sharp";
import { requireOperator, OperatorAuthorizationError, operatorAuthorizationResponse } from "@/features/auth/operator";
import { workspaceAccess, UUID } from "@/features/property-workspace/server";
import { PRIVATE_BUCKET, MAX_FILE_SIZE } from "@/features/property-workspace/files";
export const runtime = "nodejs";
export async function GET(request: Request, { params }: { params: Promise<{ id: string; fileId: string }> }) {
  try {
    const actor = await requireOperator(); const { id, fileId } = await params;
    if (!UUID.test(fileId)) return new Response(null, { status: 404 });
    const { db, operator } = await workspaceAccess(id, actor);
    const result = await db.from("property_workspace_files").select("path,mime,size").eq("property_id", id).eq("owner_id", operator.id).eq("id", fileId).maybeSingle();
    if (result.error) throw new Error("Nie udało się pobrać podglądu.");
    if (!result.data || !result.data.mime.startsWith("image/") || result.data.size > MAX_FILE_SIZE) return new Response(null, { status: 404 });
    const stored = await db.storage.from(PRIVATE_BUCKET).download(result.data.path);
    if (stored.error || !stored.data || stored.data.size > MAX_FILE_SIZE) throw new Error("Nie udało się pobrać podglądu.");
    const forOcr = new URL(request.url).searchParams.get("mode") === "ocr";
    const edge = forOcr ? 2200 : 640;
    const bytes = await sharp(Buffer.from(await stored.data.arrayBuffer()), { limitInputPixels: 80_000_000, sequentialRead: true }).rotate().resize({ width: edge, height: edge, fit: "inside", withoutEnlargement: true }).jpeg({ quality: forOcr ? 94 : 75 }).toBuffer();
    return new Response(new Uint8Array(bytes), { headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=300", "Vary": "Cookie", "X-Content-Type-Options": "nosniff" } });
  } catch (error) {
    if (error instanceof OperatorAuthorizationError) return operatorAuthorizationResponse(error);
    return new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
  }
}
