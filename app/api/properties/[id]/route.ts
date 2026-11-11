import { operatorAuthorizationResponse, requireOperator } from "@/features/auth/operator";

import { createAdminClient } from "@/lib/supabase/admin";
import { parsePropertyUpdate, propertyUpdateColumns } from "@/features/properties/property-update";

type Context = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Context) {
  try {
    await requireOperator();
  } catch (error) {
    return operatorAuthorizationResponse(error);
  }
  const { id } = await params;

  try {
    const body = await request.json();
    const values = parsePropertyUpdate(body);
    const supabase = createAdminClient();
    const { data: existing, error: lookupError } = await supabase
      .from("properties")
      .select("id")
      .eq("id", id)
      .maybeSingle();

    if (lookupError) {
      console.error("PROPERTY UPDATE LOOKUP ERROR:", { id, error: lookupError });
      return Response.json({ message: lookupError.message }, { status: 500 });
    }
    if (!existing) return Response.json({ message: "Nie znaleziono nieruchomości." }, { status: 404 });

    const columns = propertyUpdateColumns(values);
    const mapping: Record<string, keyof typeof columns> = { totalFloors: "total_floors", description: "notes", originalUrl: "original_url", renovationCost: "renovation_cost", expectedSalePrice: "expected_sale_price" };
    let updates: Partial<typeof columns> = columns;
    if (Array.isArray(body.changedFields)) {
      const selected = new Set(body.changedFields.map((key: string) => mapping[key] ?? key));
      updates = Object.fromEntries(Object.entries(columns).filter(([key]) => selected.has(key)));
    }
    const workspace = await supabase.from("property_workspaces").select("owner_id").eq("property_id", id).maybeSingle();
    if (workspace.error) return Response.json({ message: "Nie udało się sprawdzić karty nieruchomości." }, { status: 500 });
    if (workspace.data) {
      const actor = await requireOperator();
      if (workspace.data.owner_id !== actor.id) return Response.json({ message: "Brak dostępu do karty." }, { status: 403 });
      delete updates.status; delete updates.renovation_cost; delete updates.expected_sale_price; delete updates.profit; delete updates.roi;
    }
    if (!Object.keys(updates).length) return Response.json({ id });
    const { data, error } = await supabase
      .from("properties")
      .update(updates)
      .eq("id", id)
      .select("id")
      .maybeSingle();

    if (error) {
      console.error("PROPERTY UPDATE ERROR:", { id, error });
      return Response.json({ message: error.message }, { status: error.code === "42501" ? 403 : 500 });
    }

    if (!data?.id) return Response.json({ message: "Nie udało się odczytać zaktualizowanej nieruchomości." }, { status: 500 });
    return Response.json({ id: data.id });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Nie udało się zaktualizować nieruchomości.";
    return Response.json({ message }, { status: 400 });
  }
}

export async function DELETE(_request: Request, { params }: Context) {
  let actor;
  try {
    actor = await requireOperator();
  } catch (error) {
    return operatorAuthorizationResponse(error);
  }
  const { id } = await params;
  const supabase = createAdminClient();
  const { data: property, error: lookupError } = await supabase
    .from("properties")
    .select("id")
    .eq("id", id)
    .maybeSingle();

  if (lookupError) {
    console.error("PROPERTY DELETE LOOKUP ERROR:", lookupError);
    return Response.json({ message: "Nie udało się sprawdzić nieruchomości przed usunięciem." }, { status: 500 });
  }

  if (!property) {
    // A confirmed, distinct id-space mixup this mission could not reproduce
    // end-to-end (no current UI path was found that passes a listings id
    // here), but worth guarding regardless: public.properties and
    // public.listings are separate tables with separately generated UUIDs,
    // so an id that is a genuine listing must never be silently reported as
    // "not found" the same way a truly nonexistent id would be — that
    // generic message is exactly what masks a wrong-table bug from whoever
    // is debugging it next.
    const { data: listing } = await supabase.from("listings").select("id").eq("id", id).maybeSingle();
    if (listing) {
      return Response.json(
        { message: "Ten identyfikator odpowiada ofercie (public.listings), a nie nieruchomości (public.properties). Ofert nie można usuwać przez ten punkt końcowy.", code: "ID_BELONGS_TO_LISTING" },
        { status: 409 },
      );
    }
    const cleanup = await cleanupPrivateFiles(supabase, actor.id, id);
    if (cleanup.error) return Response.json({ message: "Nie udało się dokończyć usuwania dokumentów. Spróbuj ponownie." }, { status: 503 });
    if (cleanup.removed) return new Response(null, { status: 204 });
    return Response.json({ message: "Nie znaleziono nieruchomości." }, { status: 404 });
  }

  const workspace = await supabase.from("property_workspaces").select("owner_id").eq("property_id", id).maybeSingle();
  if (workspace.error) return Response.json({ message: "Nie udało się sprawdzić właściciela karty." }, { status: 500 });
  if (workspace.data && workspace.data.owner_id !== actor.id) return Response.json({ message: "Brak dostępu do karty." }, { status: 403 });
  const { error: deleteError } = await supabase.from("properties").delete().eq("id", id);

  if (deleteError) {
    console.error("PROPERTY DELETE ERROR:", { id, deleteError });
    return Response.json({ message: "Nie udało się usunąć nieruchomości." }, { status: 500 });
  }

  const cleanup = await cleanupPrivateFiles(supabase, actor.id, id);
  if (cleanup.error) return Response.json({ message: "Kartę usunięto, ale dokumenty wymagają dokończenia usuwania. Naciśnij Usuń ponownie.", code: "PRIVATE_FILE_CLEANUP_PENDING" }, { status: 503 });
  return new Response(null, { status: 204 });
}

async function cleanupPrivateFiles(db: ReturnType<typeof createAdminClient>, ownerId: string, propertyId: string) {
  const bucket = db.storage.from("property-workspace-private");
  let removed = 0;
  // Scope includes the authenticated owner. A retry can clean files even after cascading metadata deletion.
  const prefix = `${ownerId}/${propertyId}`;
  for (let batch = 0; batch < 20; batch++) {
    const list = await bucket.list(prefix, { limit: 1000 });
    if (list.error) return { removed, error: true };
    const paths = (list.data ?? []).filter(item => item.id).map(item => `${prefix}/${item.name}`);
    if (!paths.length) return { removed, error: false };
    const result = await bucket.remove(paths);
    if (result.error) return { removed, error: true };
    removed += paths.length;
  }
  return { removed, error: true };
}
