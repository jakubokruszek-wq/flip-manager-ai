import assert from "node:assert/strict";
import test, { mock } from "node:test";

const listings = new Map<string, Record<string, unknown>>();
const properties: Record<string, unknown>[] = [];
let sequence = 0;

mock.module("@/features/auth/operator", {
  namedExports: {
    requireOperator: async () => ({ id: "operator-1", email: "operator@example.test" }),
    operatorAuthorizationResponse: (error: unknown) => Response.json({ message: String(error) }, { status: 401 }),
  },
});
mock.module("@/lib/supabase/admin", { namedExports: { createAdminClient: fakeAdminClient } });

const route = await import("../../../app/api/properties/import-from-finder/route.ts");

function fakeAdminClient() {
  return {
    from(table: string) {
      const filters: Array<(row: Record<string, unknown>) => boolean> = [];
      let insertRow: Record<string, unknown> | null = null;
      let updatePatch: Record<string, unknown> | null = null;
      const rows = table === "listings" ? [...listings.values()] : table === "properties" ? properties : null;
      assert.ok(rows, `unexpected table ${table}`);
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (column: string, value: unknown) => { filters.push((row) => row[column] === value); return builder; },
        insert: (row: Record<string, unknown>) => { insertRow = row; return builder; },
        update: (patch: Record<string, unknown>) => { updatePatch = patch; return builder; },
        maybeSingle: async () => ({ data: rows.find((row) => filters.every((matches) => matches(row))) ?? null, error: null }),
        single: async () => {
          if (insertRow) {
            const row = { ...insertRow, id: `crm-${++sequence}` };
            properties.push(row);
            return { data: { id: row.id }, error: null };
          }
          const row = rows.find((item) => filters.every((matches) => matches(item)));
          if (row && updatePatch) Object.assign(row, updatePatch);
          return { data: row ? { id: row.id } : null, error: row ? null : { code: "PGRST116", message: "missing row" } };
        },
      };
      return builder;
    },
  };
}

test("adding two confirmed source rows for one property reuses one CRM property", async () => {
  listings.clear();
  properties.splice(0);
  sequence = 0;
  const identity = "portal_shared_unit_id:registry-tuwima-71";
  listings.set("listing-gratka", { id: "listing-gratka", external_listing_id: "g-71", normalized_url: "https://gratka.pl/oferta/71", images: [], cross_source_identity: identity });
  listings.set("listing-morizon", { id: "listing-morizon", external_listing_id: "m-71", normalized_url: "https://morizon.pl/oferta/71", images: [], cross_source_identity: identity });

  async function importListing(id: string, source: string, originalUrl: string) {
    return route.POST(new Request("https://app.test/api/properties/import-from-finder", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id, source, originalUrl, normalizedUrl: originalUrl, externalListingId: null,
        title: "Mieszkanie Tuwima", price: 365_000, area: 71, rooms: 3, floor: null,
        buildingType: "blok", ownership: null, description: "Fixture ofert źródłowych",
        images: [], locationText: "Łódź, Śródmieście", address: null, city: "Łódź", district: "Śródmieście",
        investmentAnalysis: null,
      }),
    }));
  }

  const first = await importListing("listing-gratka", "gratka", "https://gratka.pl/oferta/71");
  const firstBody = await first.json() as { propertyId: string; status: string };
  const second = await importListing("listing-morizon", "morizon", "https://morizon.pl/oferta/71");
  const secondBody = await second.json() as { propertyId: string; status: string };

  assert.equal(first.status, 201);
  assert.equal(firstBody.status, "created");
  assert.equal(second.status, 200);
  assert.equal(secondBody.status, "updated");
  assert.equal(secondBody.propertyId, firstBody.propertyId);
  assert.equal(properties.length, 1, "the confirmed group has exactly one CRM row");
  assert.equal(properties[0].cross_source_identity, identity);
});
