import { createClient } from "@/lib/supabase/server";
import type { Property } from "@/features/properties/types";

export async function getProperties(): Promise<Property[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("properties")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    throw new Error(
      JSON.stringify(
        {
          message: error.message,
          details: error.details,
          hint: error.hint,
          code: error.code,
        },
        null,
        2
      )
    );
  }

  return (data ?? []) as Property[];
}