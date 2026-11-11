import { operatorAuthorizationResponse, OperatorAuthorizationError, requireOperator } from "@/features/auth/operator";
import { parseWorkspace } from "@/features/property-workspace/model";
import { readWorkspace, workspaceAccess } from "@/features/property-workspace/server";
type Context = { params: Promise<{ id: string }> };
export async function GET(_request: Request, { params }: Context) {
  try { return Response.json(await readWorkspace((await params).id), { headers: { "Cache-Control": "private, no-store" } }); }
  catch (error) { if (error instanceof OperatorAuthorizationError) return operatorAuthorizationResponse(error); return Response.json({ message: error instanceof Error ? error.message : "Nie udało się pobrać danych." }, { status: 400 }); }
}
export async function PUT(request: Request, { params }: Context) {
  try {
    const { id } = await params;
    const { db, operator } = await workspaceAccess(id, await requireOperator());
    const raw = await request.text();
    if (raw.length > 512_000) throw new Error("Za dużo danych. Zapisuj zdjęcia w dokumentach.");
    const body = JSON.parse(raw);
    if (!Number.isSafeInteger(body.version) || body.version < 0) throw new Error("Nieprawidłowa wersja zapisu.");
    const data = parseWorkspace(body.data);
    const attachmentIds = data.expenses.flatMap(e => e.fileId ? [e.fileId] : []);
    if (attachmentIds.length) {
      const { data: files, error } = await db.from("property_workspace_files").select("id").eq("property_id", id).eq("owner_id", operator.id).in("id", attachmentIds);
      if (error || files?.length !== new Set(attachmentIds).size) throw new Error("Dokument kosztu nie należy do tej nieruchomości.");
    }
    const { data: saved, error } = await db.rpc("save_property_workspace", { p_property_id: id, p_owner_id: operator.id, p_expected_version: body.version, p_data: data });
    if (error) {
      if (error.message.includes("WORKSPACE_CONFLICT")) return Response.json({ message: "Dane zmieniono w innym oknie. Odśwież widok przed kolejnym zapisem; zachowaj swoje notatki." }, { status: 409 });
      console.error("WORKSPACE_SAVE", error.code);
      throw new Error("Nie udało się zapisać. Twoje zmiany pozostały w formularzu.");
    }
    return Response.json({ version: saved, data });
  } catch (error) { if (error instanceof OperatorAuthorizationError) return operatorAuthorizationResponse(error); return Response.json({ message: error instanceof Error ? error.message : "Nie udało się zapisać." }, { status: 400 }); }
}
