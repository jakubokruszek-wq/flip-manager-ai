import "server-only";

import { createClient } from "@/lib/supabase/server";

export type PriceHistory = {
  listingId: string;
  currentPrice: number | null;
  history: Array<{
    price: number | null;
    capturedAt: string;
  }>;
};

export async function getListingPriceHistory(listingId: string): Promise<PriceHistory | null> {
  const supabase = await createClient();
  const [listingResult, snapshotsResult] = await Promise.all([
    supabase.from("listings").select("id,price").eq("id", listingId).maybeSingle(),
    supabase
      .from("listing_snapshots")
      .select("price,captured_at")
      .eq("listing_id", listingId)
      .order("captured_at", { ascending: true }),
  ]);

  if (listingResult.error || snapshotsResult.error) {
    console.error(
      "FLIP FINDER PRICE HISTORY ERROR:",
      listingResult.error ?? snapshotsResult.error,
    );
    throw new Error("Nie udało się pobrać historii ceny oferty.");
  }

  if (!isRecord(listingResult.data) || typeof listingResult.data.id !== "string") {
    return null;
  }

  return {
    listingId: listingResult.data.id,
    currentPrice: nullableNumber(listingResult.data.price),
    history: Array.isArray(snapshotsResult.data)
      ? snapshotsResult.data
          .filter(isRecord)
          .flatMap((snapshot) => {
            const capturedAt = nullableString(snapshot.captured_at);
            return capturedAt ? [{ price: nullableNumber(snapshot.price), capturedAt }] : [];
          })
      : [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}
