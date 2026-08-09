import { createClient } from "@/lib/supabase/server";
import { parsePropertyUpdate, propertyUpdateColumns } from "@/features/properties/property-update";

type Context = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Context) {
  const { id } = await params;

  try {
    const values = parsePropertyUpdate(await request.json());
    const supabase = await createClient();
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

    const { data, error } = await supabase
      .from("properties")
      .update(propertyUpdateColumns(values))
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
  const { id } = await params;
  const supabase = await createClient();
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
    return Response.json({ message: "Nie znaleziono nieruchomości." }, { status: 404 });
  }

  const { error: deleteError } = await supabase.from("properties").delete().eq("id", id);

  if (deleteError) {
    console.error("PROPERTY DELETE ERROR:", { id, deleteError });
    return Response.json({ message: "Nie udało się usunąć nieruchomości." }, { status: 500 });
  }

  return new Response(null, { status: 204 });
}
