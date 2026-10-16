import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { testCases, testModeAllowed } from "../test-mode";

/** Explicit synthetic inserts only. No update/delete, source fetch or production fallback. */
export async function prepareTestCases(actorId: string) {
  if (!testModeAllowed(actorId)) throw Error("TEST_NOT_AVAILABLE");
  const db = createAdminClient(), cases = testCases(actorId), now = new Date().toISOString();
  const { error } = await db.from("listings").upsert(cases.map(c => ({
    id: c.id, source: "facebook", external_listing_id: c.id,
    original_url: `https://example.test/deal-room/${c.id}`, title: c.title,
    city: "Łódź", district: "Górna", address: c.title, area: 45, rooms: 2,
    updated_at: now, price: c.price, building_type: "BLOCK", ownership: "pełna własność",
    lifecycle_status: "ACTIVE", manual_decision: c.key === "reject" ? "REJECTED" : null,
    description: "WYŁĄCZNIE SYNTETYCZNY TEST. Mieszkanie do remontu. Brak zweryfikowanej dokumentacji prawnej.",
    images: [], gallery_status: "NOT_REQUESTED", last_seen_at: now,
  })), { onConflict: "id", ignoreDuplicates: true });
  if (error) throw Error("TEST_PREPARATION_FAILED");
  // Shared synthetic comparables only inside the explicitly isolated database.
  const { error: compError } = await db.from("resale_comps").upsert([1,2,3].map(i => ({
    source: "otodom", external_listing_id: `deal-room-synthetic-${i}`,
    canonical_url: `https://example.test/deal-room/comparable/${i}`, title: "TEST · syntetyczne porównanie",
    city: "Łódź", district: "Górna", area_m2: 45, rooms: 2, building_type: "BLOCK",
    price: (9500 + i*250)*45, price_per_m2: 9500 + i*250,
    renovation_status: "RENOVATED", renovation_confidence: "HIGH", active: true, last_seen_at: now,
    evidence: { synthetic: true, marketType: "secondary" },
  })), { onConflict: "source,external_listing_id", ignoreDuplicates: true });
  if (compError) throw Error("TEST_PREPARATION_FAILED");
  return cases;
}
