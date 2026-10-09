import { operatorAuthorizationResponse, requireOperator } from "@/features/auth/operator";
import { getSearchFilter } from "@/features/flip-finder/server/search-filters";
import { createAdminClient } from "@/lib/supabase/admin";

type Context = { params: Promise<{ id: string }> };
type Action = "link" | "not_link" | "unlink";

export async function POST(request: Request, { params }: Context) {
  let operator: Awaited<ReturnType<typeof requireOperator>>;
  try {
    operator = await requireOperator();
  } catch (error) {
    return operatorAuthorizationResponse(error);
  }
  const filterId = (await params).id;
  const filter = await getSearchFilter(filterId);
  if (!filter) return Response.json({ message: "Nie znaleziono filtra." }, { status: 404 });

  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({ message: "Nieprawidłowe dane żądania." }, { status: 400 }); }
  if (!isRecord(body) || !isAction(body.action) || !isUuid(body.listingA) || (body.listingB !== undefined && body.listingB !== null && !isUuid(body.listingB))) {
    return Response.json({ message: "Nieprawidłowe dane decyzji o łączeniu ofert." }, { status: 400 });
  }
  if (body.action !== "unlink" && !isUuid(body.listingB)) {
    return Response.json({ message: "Wskaż dwie oferty do porównania." }, { status: 400 });
  }
  if (body.action === "unlink" && body.listingB !== undefined && body.listingB !== null) {
    return Response.json({ message: "Rozłączenie działa dla całej ręcznej grupy." }, { status: 400 });
  }

  const supabase = createAdminClient();
  const { data, error } = await supabase.rpc("manage_finder_listing_identity", {
    p_owner_id: operator.id,
    p_search_filter_id: filterId,
    p_action: body.action,
    p_listing_a: body.listingA,
    p_listing_b: body.listingB ?? null,
  });
  if (error) {
    if (isMissingRpc(error)) return Response.json({ code: "IDENTITY_SCHEMA_REQUIRED", message: "Ręczne łączenie ofert jest niedostępne. Najpierw trzeba zastosować lokalny draft migracji Finder Identity." }, { status: 503 });
    if (error.code === "22023" || error.code === "42501" || error.code === "P0002" || error.code === "P0001") {
      return Response.json({ code: error.message, message: "Nie można wykonać tej decyzji. Sprawdź, czy oferty należą do bieżącego filtra i nie zawierają sprzecznych danych." }, { status: 409 });
    }
    console.error("FINDER IDENTITY DECISION ERROR:", error);
    return Response.json({ message: "Nie udało się zapisać decyzji o łączeniu ofert." }, { status: 500 });
  }
  return Response.json({ ok: true, action: body.action, result: Array.isArray(data) ? data[0] ?? null : data });
}

function isAction(value: unknown): value is Action { return value === "link" || value === "not_link" || value === "unlink"; }
function isUuid(value: unknown): value is string { return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value); }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function isMissingRpc(error: { code?: string; message?: string }): boolean { return (error.code === "PGRST202" || error.code === "42883") && /manage_finder_listing_identity/u.test(error.message ?? ""); }
