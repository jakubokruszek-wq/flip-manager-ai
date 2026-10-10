import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { normalizeOtodomUrl } from "../otodom-search.ts";
import { EXTERNAL_PORTAL_PARSERS } from "../external-source-adapters.ts";

mock.module("@/features/flip-finder/listing-images", { namedExports: { resolveListingImages: (existing: string[], thumbnail: string | null, images?: string[]) => [...new Set([...existing, ...(thumbnail ? [thumbnail] : []), ...(images ?? [])])] } });
mock.module("@/features/market-intelligence/resale-comps-store", { namedExports: { syncResaleCompFromListing: async () => ({ saved: false, created: false, compId: null, available: true }) } });
let reconciliationCalls = 0;
mock.module("@/features/flip-finder/server/canonical-reconciliation", { namedExports: { reconcileCanonicalListingDecision: async () => { reconciliationCalls += 1; return { isCurrentMatch: true }; } } });

type Row = Record<string, unknown>;
function fakeDb(rows: Row[]) {
  let sequence = 0;
  const snapshots: Row[] = [];
  return {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      let operation: "select" | "upsert" | "insert" | "update" = "select";
      let payload: Row | null = null;
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (key: string, value: unknown) => { filters[key] = value; return builder; },
        order: () => builder,
        limit: () => builder,
        filter: () => builder,
        abortSignal: () => builder,
        insert: (value: Row) => { operation = "insert"; payload = value; return builder; },
        upsert: (value: Row) => { operation = "upsert"; payload = value; return builder; },
        update: (value: Row) => { operation = "update"; payload = value; return builder; },
        maybeSingle: async () => {
          const row = rows.find((candidate) => Object.entries(filters).every(([key, value]) => candidate[key] === value)) ?? null;
          return { data: row, error: null };
        },
        single: async () => {
          if (table === "listings" && operation === "upsert" && payload) {
            const existing = rows.find((candidate) => candidate.source === payload?.source && candidate.external_listing_id === payload?.external_listing_id);
            if (existing) Object.assign(existing, payload);
            else rows.push({ ...payload, id: `listing-${++sequence}` });
            return { data: { id: existing?.id ?? rows.at(-1)?.id }, error: null };
          }
          return { data: { id: `row-${++sequence}` }, error: null };
        },
        then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => {
          if (table === "listing_snapshots" && operation === "insert" && payload) snapshots.push({ ...payload });
          if (table === "listings" && operation === "update" && payload) {
            const existing = rows.find((candidate) => Object.entries(filters).every(([key, value]) => candidate[key] === value));
            if (existing) Object.assign(existing, payload);
          }
          return Promise.resolve({ data: [], error: null }).then(resolve, reject);
        },
      };
      return builder;
    },
    snapshots,
  };
}

const { persistListing } = await import("./persist-listing.ts");

function listing(externalListingId: string, title: string) {
  return {
    source: "domiporta" as const,
    externalListingId,
    originalUrl: "https://domiporta.pl/oferta/lodz-1?utm_source=feed",
    normalizedUrl: "https://domiporta.pl/oferta/lodz-1",
    title,
    price: 489000,
    area: 53,
    rooms: 2,
    floor: "2",
    pricePerSqm: 9226,
    city: "Łódź",
    district: "Bałuty",
    locationText: "Bałuty, Łódź",
    thumbnailUrl: null,
    images: [],
    buildingType: null,
    description: "Sprzedaż mieszkania",
    publishedAt: null,
    rawPayload: {},
    contentHash: title,
  };
}

function otodomListing(externalListingId: string, url: string) {
  return {
    source: "otodom" as const,
    externalListingId,
    originalUrl: url,
    normalizedUrl: normalizeOtodomUrl(url),
    title: "Mieszkanie Otodom",
    price: 439000,
    area: 50,
    rooms: 2,
    floor: "2",
    pricePerSqm: 8780,
    city: "Łódź",
    district: "Bałuty",
    locationText: "Bałuty, Łódź",
    thumbnailUrl: null,
    images: [],
    buildingType: null,
    description: "Oferta testowa",
    publishedAt: null,
    rawPayload: {},
    contentHash: "otodom-content",
  };
}

test("persistListing reuses a canonical listing when a portal rotates its external id but URL stays stable", async () => {
  const rows: Row[] = [{ id: "canonical-1", source: "domiporta", external_listing_id: "old-id", normalized_url: "https://domiporta.pl/oferta/lodz-1", price: 480000, content_hash: "old", images: [] }];
  const db = fakeDb(rows);
  const first = await persistListing(db as never, "filter-1", listing("new-id", "Nowy tytuł"), true, [], "scan-1", "2026-10-01T10:00:00Z", AbortSignal.timeout(1000));
  assert.equal(first.listingId, "canonical-1");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].external_listing_id, "old-id");
  assert.equal(rows[0].title, "Nowy tytuł");
});

test("persistListing treats Otodom .html and extensionless URLs as one canonical listing", async () => {
  const rows: Row[] = [{
    id: "otodom-canonical",
    source: "otodom",
    external_listing_id: "old-otodom-id",
    normalized_url: "https://otodom.pl/pl/oferta/mieszkanie-lodz-ID4CRDS.html",
    price: 439000,
    content_hash: "old",
    images: [],
  }];
  const db = fakeDb(rows);
  const saved = await persistListing(
    db as never,
    "filter-1",
    otodomListing("new-otodom-id", "https://www.otodom.pl/pl/oferta/mieszkanie-lodz-ID4CRDS.html?utm_source=feed"),
    true,
    [],
    "scan-otodom",
    "2026-10-01T10:00:00Z",
    AbortSignal.timeout(1000),
  );
  assert.equal(saved.listingId, "otodom-canonical");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].external_listing_id, "old-otodom-id");
  assert.equal(rows[0].normalized_url, "https://otodom.pl/pl/oferta/mieszkanie-lodz-ID4CRDS");
});

function allegroFixture(slug: string, offerId: string, photoUrl: string) {
  const url = `https://allegrolokalnie.pl/oferta/${slug}`;
  const data = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    itemListElement: [{
      "@type": "ListItem",
      item: {
        "@type": "Product",
        name: "Mieszkanie Łódź Górna, 68 m²",
        url,
        category: "Mieszkania na sprzedaż",
        itemCondition: "https://schema.org/UsedCondition",
        image: { "@type": "ImageObject", url: photoUrl },
        offers: { "@type": "Offer", price: "220000", priceCurrency: "PLN" },
      },
    }],
  };
  const html = `<script type="application/ld+json">${JSON.stringify(data)}</script><a class="mlc-itembox" itemprop="url" href="${url}" data-card-analytics-click="${offerId}"></a>`;
  return EXTERNAL_PORTAL_PARSERS.allegro_lokalnie(html, "Łódź").listings[0]!;
}

test("Allegro distinct portal UUIDs sharing a photo persist as distinct canonical listings", async () => {
  const sharedPhoto = "https://a.allegroimg.com/original/119757/shared-photo-hash/room.jpg";
  const rows: Row[] = [];
  const db = fakeDb(rows);
  const first = allegroFixture("mieszkanie-lodz-gorna-68-m2-ujw", "11111111-1111-4111-8111-111111111111", sharedPhoto);
  const second = allegroFixture("mieszkanie-lodz-gorna-68-m2-oos", "22222222-2222-4222-8222-222222222222", sharedPhoto);

  const firstSaved = await persistListing(db as never, "filter-1", first, true, [], "scan-allegro", "2026-10-10T19:00:00.000Z", AbortSignal.timeout(1000));
  const secondSaved = await persistListing(db as never, "filter-1", second, true, [], "scan-allegro", "2026-10-10T19:01:00.000Z", AbortSignal.timeout(1000));

  assert.notEqual(first.externalListingId, second.externalListingId);
  assert.notEqual(firstSaved.listingId, secondSaved.listingId);
  assert.equal(rows.length, 2, "a shared photo is not sufficient evidence to merge two portal identities");
});

test("Allegro reimport with a rotated portal UUID reuses an exact historical URL and preserves its decision and history", async () => {
  const url = "https://allegrolokalnie.pl/oferta/mieszkanie-lodz-gorna-68-m2-ujw";
  const photo = "https://a.allegroimg.com/original/119757/old-photo-hash/room.jpg";
  const rows: Row[] = [{
    id: "historical-allegro-listing",
    source: "allegro_lokalnie",
    external_listing_id: "119757/legacy-image-hash",
    original_url: url,
    normalized_url: url,
    title: "Historyczny tytuł",
    price: 220000,
    area: 68,
    rooms: 3,
    city: "Łódź",
    district: "Górna",
    price_per_sqm: 3235,
    content_hash: "historical-content",
    images: [photo],
    manual_decision: "REJECTED",
    lifecycle_status: "REJECTED",
    archived_at: "2026-10-01T10:00:00.000Z",
  }];
  const db = fakeDb(rows);
  const current = allegroFixture("mieszkanie-lodz-gorna-68-m2-ujw", "33333333-3333-4333-8333-333333333333", "https://a.allegroimg.com/original/119757/new-photo-hash/room.jpg");

  const saved = await persistListing(db as never, "filter-1", current, true, [], "scan-allegro-reimport", "2026-10-10T19:02:00.000Z", AbortSignal.timeout(1000));

  assert.equal(saved.listingId, "historical-allegro-listing", "same source URL resolves the legacy row in place despite its old image-derived ID");
  assert.equal(rows.length, 1, "reimport updates the existing history row rather than inserting or deleting");
  assert.equal(rows[0]?.external_listing_id, "119757/legacy-image-hash", "the historical canonical key remains stable");
  assert.equal(rows[0]?.manual_decision, "REJECTED");
  assert.equal(rows[0]?.lifecycle_status, "REJECTED");
  assert.equal(rows[0]?.archived_at, "2026-10-01T10:00:00.000Z");
  assert.deepEqual(rows[0]?.images, [photo, "https://a.allegroimg.com/original/119757/new-photo-hash/room.jpg"]);
  assert.equal(db.snapshots.length, 1, "the changed reimport appends a snapshot against the unchanged listing ID");
  assert.equal(db.snapshots[0]?.listing_id, "historical-allegro-listing");
});

test("persistListing stores the adapter's confirmed publication date in snapshot raw_data", async () => {
  const rows: Row[] = [];
  const db = fakeDb(rows);
  await persistListing(db as never, "filter-1", { ...listing("published-1", "Oferta z datą"), publishedAt: "2026-10-04T21:55:00.000Z" }, true, [], "scan-1", "2026-10-07T10:00:00.000Z", AbortSignal.timeout(1000));
  assert.equal(rows.length, 1);
  assert.equal(db.snapshots.length, 1);
  assert.equal((db.snapshots[0].raw_data as Row).sourcePublishedAt, "2026-10-04T21:55:00.000Z");
});

test("persistListing stores only an explicitly supplied namespaced cross-portal unit identity", async () => {
  const rows: Row[] = [];
  const db = fakeDb(rows);
  await persistListing(db as never, "filter-1", { ...listing("identified-1", "Mieszkanie"), crossSourceIdentity: "portal_shared_unit_id:unit-42" }, true, [], "scan-identity", "2026-10-07T10:00:00.000Z", AbortSignal.timeout(1000));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].cross_source_identity, "portal_shared_unit_id:unit-42");
});

test("persistListing keeps confirmed identity evidence across a price-changing reimport with sparse portal data", async () => {
  const previousEvidence = {
    agencyReference: { agency: "biuro-lodz", number: "bio-71" },
    buildingKey: "lodz|tuwima|12",
    apartmentNumber: "4",
    unitKey: "lodz|tuwima|12|unit:4",
    marketType: "secondary",
    buildingType: "kamienica",
    area: 50.2,
    rooms: 2,
    floor: "3",
    sharedPhotoAssetKeys: ["https://cdn.example.test/unit/interior-1.jpg"],
  };
  const rows: Row[] = [{
    id: "identity-reimport",
    source: "domiporta",
    external_listing_id: "stable-offer-id",
    normalized_url: "https://domiporta.pl/oferta/lodz-1",
    price: 480000,
    content_hash: "old-content",
    images: [],
    identity_evidence: previousEvidence,
  }];
  const db = fakeDb(rows);
  const updated = await persistListing(db as never, "filter-1", {
    ...listing("stable-offer-id", "Ta sama oferta z nową ceną"),
    price: 470000,
    contentHash: "new-content",
    identityEvidence: {
      agencyReference: null,
      buildingKey: "lodz|tuwima|12",
      apartmentNumber: null,
      unitKey: null,
      marketType: "secondary",
      buildingType: null,
      area: null,
      rooms: null,
      floor: null,
      sharedPhotoAssetKeys: [],
    },
  }, true, [], "scan-reimport", "2026-10-09T10:00:00Z", AbortSignal.timeout(1000));

  assert.equal(updated.listingId, "identity-reimport");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].price, 470000, "the current price may change on a legitimate reimport");
  assert.deepEqual(rows[0].identity_evidence, previousEvidence, "omitted evidence is merged without erasing the prior confirmed unit identity");
});

test("persistListing ignores identity-shaped fields inside untrusted portal raw payloads", async () => {
  const rows: Row[] = [];
  const db = fakeDb(rows);
  await persistListing(db as never, "filter-1", {
    ...listing("untrusted-identity-1", "Mieszkanie"),
    rawPayload: { crossSourceIdentityKind: "canonical_unit_id", crossSourceIdentity: "forged-source-value" },
  }, true, [], "scan-untrusted-identity", "2026-10-07T10:00:00.000Z", AbortSignal.timeout(1000));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].cross_source_identity, undefined, "public portal JSON cannot force a canonical property merge");
});

test("a source scan does not reactivate or write over an archived listing without an explicit restore", async () => {
  reconciliationCalls = 0;
  const archivedRow: Row = {
    id: "archived-canonical", source: "domiporta", external_listing_id: "archived-id",
    original_url: "https://domiporta.pl/oferta/lodz-1", normalized_url: "https://domiporta.pl/oferta/lodz-1",
    title: "Archived title", price: 480000, content_hash: "archived-content", images: ["https://img.example/old.jpg"],
    lifecycle_status: "ARCHIVED", archived_at: "2026-10-01T10:00:00.000Z", manual_decision: null,
  };
  const before = structuredClone(archivedRow);
  const rows: Row[] = [archivedRow];
  const db = fakeDb(rows);

  const result = await persistListing(db as never, "filter-1", listing("archived-id", "New source title"), true, [], "scan-archived", "2026-10-07T10:00:00Z", AbortSignal.timeout(1000));

  assert.deepEqual(result, { listingId: "archived-canonical", listingCreated: false, matchCreated: false, updated: 0, priceDrop: 0 });
  assert.deepEqual(rows, [before], "archived lifecycle, content, and archival timestamp remain untouched");
  assert.equal(db.snapshots.length, 0, "the archived row must not gain new history as a side effect of a scan");
  assert.equal(reconciliationCalls, 0, "the importer must not reach canonical reconciliation for an archived row");
});

test("a non-Facebook reimport without a valid total sale price is rejected before any row or existing price can be changed", async () => {
  const rows: Row[] = [{ id: "canonical-2", source: "domiporta", external_listing_id: "known-id", price: 489000, content_hash: "known", images: [] }];
  const db = fakeDb(rows);
  await assert.rejects(
    persistListing(db as never, "filter-1", { ...listing("known-id", "Existing listing"), price: Number.NaN }, true, [], "scan-2", "2026-10-07T10:00:00.000Z", AbortSignal.timeout(1000)),
    /INVALID_SALE_PRICE/,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].price, 489000);
});
