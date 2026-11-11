import "server-only";
import { plainText } from "./plain-text";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireOperator, type OperatorIdentity } from "@/features/auth/operator";
import { emptyWorkspace, parseWorkspace, type Workspace, type WorkspaceEvent, type WorkspaceFile } from "./model";
import { PRIVATE_BUCKET } from "./files";
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export async function workspaceAccess(propertyId: string, actor?: OperatorIdentity) {
  const operator = actor ?? await requireOperator();
  if (!UUID.test(propertyId)) throw new Error("Nieprawidłowy identyfikator nieruchomości.");
  const db = createAdminClient();
  const authDb = await createClient();
  const [propertyResult, workspaceResult] = await Promise.all([
    authDb.from("properties").select("id,status,title,address,price,area,rooms,floor,images,notes,original_url,expected_sale_price,renovation_cost").eq("id", propertyId).maybeSingle(),
    db.from("property_workspaces").select("owner_id,data,version,updated_at").eq("property_id", propertyId).maybeSingle(),
  ]);
  if (propertyResult.error) throw new Error("Nie udało się odczytać nieruchomości.");
  if (!propertyResult.data) throw new Error("Nie znaleziono nieruchomości.");
  if (workspaceResult.error) throw new Error("Nie udało się odczytać karty nieruchomości. Odśwież stronę i spróbuj ponownie.");
  if (workspaceResult.data && workspaceResult.data.owner_id !== operator.id) throw new Error("Nie znaleziono nieruchomości.");
  return { operator, db, property: { ...propertyResult.data, images: Array.isArray(propertyResult.data.images) ? propertyResult.data.images.filter((url: unknown): url is string => typeof url === "string") : [] }, workspace: workspaceResult.data };
}
export async function readWorkspace(propertyId: string) {
  const access = await workspaceAccess(propertyId);
  const data: Workspace = access.workspace ? parseWorkspace(access.workspace.data) : emptyWorkspace(access.property.status);
  if (!access.workspace) {
    data.notes = "";
    if (typeof access.property.expected_sale_price === "number") data.expectedSalePrice = Math.round(access.property.expected_sale_price * 100);
    if (typeof access.property.renovation_cost === "number") data.budgets.renovation = Math.round(access.property.renovation_cost * 100);
  }
  data.notes = plainText(data.notes);
  const [fileResult, eventResult] = await Promise.all([
    access.db.from("property_workspace_files").select("id,name,category,mime,size,path,created_at").eq("property_id", propertyId).eq("owner_id", access.operator.id).order("created_at", { ascending: false }).limit(500),
    access.db.from("property_workspace_events").select("version,stage,expense_count,task_count,created_at").eq("property_id", propertyId).eq("owner_id", access.operator.id).order("version", { ascending: false }).limit(50),
  ]);
  if (fileResult.error || eventResult.error) throw new Error("Nie udało się pobrać dokumentów lub historii zmian.");
  const storedFiles = fileResult.data ?? [];
  const links = new Map<string, string>();
  await Promise.all([false, true].map(async pdf => {
    const paths = storedFiles.filter(file => (file.mime === "application/pdf") === pdf).map(file => file.path as string);
    if (!paths.length) return;
    const { data: signed, error } = await access.db.storage.from(PRIVATE_BUCKET).createSignedUrls(paths, 900, pdf ? { download: true } : undefined);
    if (error || !signed || signed.some(item => !item.signedUrl || item.error)) throw new Error("Nie udało się otworzyć prywatnego dokumentu.");
    for (const item of signed) if (item.path && item.signedUrl) links.set(item.path, item.signedUrl);
  }));
  const files: WorkspaceFile[] = storedFiles.map(file => ({ id: file.id, name: file.name, category: file.category, mime: file.mime, size: file.size, created_at: file.created_at, url: links.get(file.path)! }));
  return { property: access.property, data, version: access.workspace?.version ?? 0, files, events: (eventResult.data ?? []) as WorkspaceEvent[] };
}
