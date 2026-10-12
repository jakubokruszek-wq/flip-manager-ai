import assert from "node:assert/strict";
import test, { mock } from "node:test";
import type { PropertySourceListing } from "@/features/properties/types/property";
import type { RadarVerificationQueueItem } from "@/features/price-radar/types";

mock.module("@/lib/supabase/admin", {
  namedExports: { createAdminClient: () => { throw new Error("this unit test must stay offline"); } },
});

const { applyRadarVerificationDecision, buildRadarVerificationSnapshot, isReviewableRadarVerificationCandidate, upsertPendingRadarVerificationCandidate, getRadarVerificationQueue, setRadarVerificationQueueRejection } = await import("./radar-verification-queue.ts");

// A minimal, row-store fake of price_radar_verification_queue, mirroring the
// upsert/select/rpc surface the module actually calls -- enough to prove the
// queue's own bucketing (pending/confirmed/rejected) and decision
// persistence across a reimport, without needing the full qualification
// pipeline a real "confirm" also exercises (already covered end to end by
// the migration's own dry-run tests against real linked Production).
function fakeVerificationDb(initial: Record<string, unknown>[] = []) {
  const rows = initial;
  let seq = 0;
  return {
    rows,
    from(table: string) {
      assert.equal(table, "price_radar_verification_queue");
      const filters: Array<(row: Record<string, unknown>) => boolean> = [];
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (key: string, value: unknown) => { filters.push((row) => row[key] === value); return builder; },
        order: () => builder,
        maybeSingle: async () => ({ data: rows.find((row) => filters.every((filter) => filter(row))) ?? null, error: null }),
        then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: rows.filter((row) => filters.every((filter) => filter(row))), error: null }).then(resolve),
      };
      return builder;
    },
    async rpc(name: string, args: Record<string, unknown>) {
      if (name === "upsert_price_radar_verification_candidate") {
        const candidate = args.p_candidate as Record<string, unknown>;
        let row = rows.find((item) => item.owner_id === args.p_owner_id && item.source === candidate.source && item.external_listing_id === candidate.external_listing_id);
        if (!row) {
          row = { id: `queue-${++seq}`, owner_id: args.p_owner_id, status: "pending", operator_decision: null, decision_at: null, rejected_at: null, first_seen_at: candidate.collected_at ?? "2026-10-12T10:00:00.000Z" };
          rows.push(row);
        }
        Object.assign(row, candidate);
        return { data: row.id, error: null };
      }
      if (name === "set_price_radar_verification_queue_rejection") {
        const row = rows.find((item) => item.id === args.p_queue_id && item.owner_id === args.p_owner_id && (item.status === "pending" || item.status === "rejected"));
        if (!row) return { data: false, error: null };
        row.status = args.p_rejected ? "rejected" : "pending";
        row.rejected_at = args.p_rejected ? "2026-10-12T10:05:00.000Z" : null;
        return { data: true, error: null };
      }
      throw new Error(`unexpected RPC ${name}`);
    },
  };
}

test("a rejected candidate is immediately removed from the visible pending queue and moved to rejected", async () => {
  const db = fakeVerificationDb();
  const input = candidate();
  const upserted = await upsertPendingRadarVerificationCandidate(db as never, "owner-1", input, { tryConsume: () => true }, async () => null);
  assert.equal(upserted.ok, true);
  const queueId = upserted.ok ? upserted.queueId : "";

  const beforeReject = await getRadarVerificationQueue("owner-1", db as never);
  assert.equal(beforeReject.pending.length, 1);
  assert.equal(beforeReject.rejected.length, 0);

  const rejected = await setRadarVerificationQueueRejection("owner-1", queueId, true, db as never);
  assert.deepEqual(rejected, { ok: true });

  const afterReject = await getRadarVerificationQueue("owner-1", db as never);
  assert.equal(afterReject.pending.length, 0, "a rejected candidate must disappear from the pending queue immediately");
  assert.equal(afterReject.rejected.length, 1);
  assert.equal(afterReject.rejected[0]?.id, queueId);
});

test("a rejection survives a reimport (re-upsert) of the same listing -- it is not silently restored to pending", async () => {
  const db = fakeVerificationDb();
  const input = candidate();
  const upserted = await upsertPendingRadarVerificationCandidate(db as never, "owner-1", input, { tryConsume: () => true }, async () => null);
  const queueId = upserted.ok ? upserted.queueId : "";
  await setRadarVerificationQueueRejection("owner-1", queueId, true, db as never);

  // A later scan reimports the same (owner, source, externalListingId) --
  // e.g. the listing is still live and keeps getting re-seen.
  const reimported = await upsertPendingRadarVerificationCandidate(db as never, "owner-1", candidate({ price: 410_000 }), { tryConsume: () => true }, async () => null);
  assert.equal(reimported.ok && reimported.queueId, queueId, "the same queue row is refreshed, never duplicated");

  const afterReimport = await getRadarVerificationQueue("owner-1", db as never);
  assert.equal(afterReimport.pending.length, 0, "the operator's rejection must not be silently reopened by a reimport without a justified state change");
  assert.equal(afterReimport.rejected.length, 1);
});

function candidate(overrides: Partial<PropertySourceListing> = {}, reason = "detail_not_confirmed") {
  const listing: PropertySourceListing = {
    source: "allegro_lokalnie", externalListingId: "offer-42",
    originalUrl: "https://allegrolokalnie.pl/oferta/offer-42", normalizedUrl: "https://allegrolokalnie.pl/oferta/offer-42",
    title: "Mieszkanie na sprzedaż, Łódź, Śródmieście", description: "Mieszkanie w bloku. Sprzedaż, rynek wtórny.",
    price: 400_000, area: 40, pricePerSqm: 10_000, rooms: 2, floor: null, city: "Łódź", district: "Śródmieście", locationText: null, thumbnailUrl: null,
    buildingType: "apartamentowiec", ownership: null, images: [], publishedAt: null,
    rawPayload: { radarSearchScope: "apartment-sale", propertyType: "apartment", marketType: "secondary", detailVerified: false,
      detailResponse: { httpStatus: 200, finalUrl: "https://allegrolokalnie.pl/oferta/offer-42?view=detail", identity: "same_listing_id" } },
    contentHash: "content-42", ...overrides,
  };
  const evidence = listing.rawPayload.detailEvidence as Record<string, unknown> | undefined;
  return {
    listing, reason, seenAt: "2026-10-11T10:00:00.000Z",
    detailUnconfirmedFields: Array.isArray(evidence?.unconfirmedFields) ? evidence.unconfirmedFields.filter((field): field is string => typeof field === "string") : [],
    detailContradictoryFields: Array.isArray(listing.rawPayload.detailContradictions) ? listing.rawPayload.detailContradictions.filter((field): field is string => typeof field === "string") : [],
  };
}

test("credible uncertain apartment sale is reviewable with field evidence and bounded source metadata", () => {
  const input = candidate({ title: "Mieszkanie, Łódź, Śródmieście", description: "Budynek wielorodzinny.", rawPayload: {
    radarSearchScope: "apartment-sale", propertyType: "apartment", marketType: "secondary", detailVerified: false,
    detailEvidence: { unconfirmedFields: ["building_type", "market_type", "finish_evidence"] },
    detailResponse: { httpStatus: 200, finalUrl: "https://allegrolokalnie.pl/oferta/offer-42?view=detail", identity: "same_listing_id" },
  }, buildingType: null });
  assert.equal(isReviewableRadarVerificationCandidate(input), true);
  const snapshot = buildRadarVerificationSnapshot(input) as RadarVerificationQueueItem["snapshot"];
  assert.equal(snapshot.sourceHttpStatus, 200);
  assert.equal(snapshot.finalUrl, "https://allegrolokalnie.pl/oferta/offer-42?view=detail");
  assert.ok(snapshot.confirmedFields.includes("total_price"));
  assert.ok(snapshot.confirmedFields.includes("apartment_sale"));
  assert.ok(snapshot.missingFields.includes("building_type"));
  assert.ok(snapshot.missingFields.includes("market_type"));
  assert.ok(snapshot.missingFields.includes("standard"));
  assert.match(snapshot.fieldEvidence.apartment_sale, /wyszukiwania portalu/u);
});

test("a starting or per-square-metre amount is reviewable but never presented as confirmed total price or computed price/m²", () => {
  const input = candidate({ rawPayload: {
    radarSearchScope: "apartment-sale", propertyType: "apartment", marketType: "secondary", detailVerified: false,
    priceIsStartingAt: true, priceKind: "from", detailResponse: { httpStatus: 200, finalUrl: "https://allegrolokalnie.pl/oferta/offer-42", identity: "same_listing_id" },
  } }, "price_is_not_total_offer_price");
  assert.equal(isReviewableRadarVerificationCandidate(input), true);
  const snapshot = buildRadarVerificationSnapshot(input) as RadarVerificationQueueItem["snapshot"];
  assert.equal(snapshot.price, 400_000, "the source amount remains visible as raw evidence");
  assert.equal(snapshot.pricePerSqm, null, "a starting amount is never divided into a misleading unit price");
  assert.ok(!snapshot.confirmedFields.includes("total_price"));
  assert.ok(snapshot.missingFields.includes("total_price"));
});

test("parser-marked unconfirmed and contradictory values cannot remain in the confirmed-field list", () => {
  const input = candidate({ rawPayload: {
    radarSearchScope: "apartment-sale", propertyType: "apartment", marketType: "secondary", detailVerified: false,
    detailEvidence: { unconfirmedFields: ["area", "market_type"] }, detailContradictions: ["rooms"],
  } });
  const snapshot = buildRadarVerificationSnapshot(input) as RadarVerificationQueueItem["snapshot"];
  assert.ok(!snapshot.confirmedFields.includes("area"));
  assert.ok(!snapshot.confirmedFields.includes("market_type"));
  assert.ok(!snapshot.confirmedFields.includes("rooms"));
  assert.ok(snapshot.missingFields.includes("area"));
  assert.ok(snapshot.missingFields.includes("market_type"));
  assert.ok(snapshot.contradictoryFields.includes("rooms"));
  assert.equal(snapshot.pricePerSqm, null, "uncertain area cannot produce a displayed statistical ratio");
});

test("positive A/B evidence is recorded separately; category B does not need a renovation date", () => {
  const a = candidate({ description: "Mieszkanie w bloku. Świeżo po kapitalnym remoncie w 2025, gotowe do zamieszkania." });
  const b = candidate({ description: "Mieszkanie w bloku. W pełni wykończone pod klucz, gotowe do zamieszkania, wysoki standard." });
  const both = candidate({ description: "Mieszkanie w bloku. Świeżo po kapitalnym remoncie w 2025, w pełni wykończone pod klucz, gotowe do zamieszkania, wysoki standard." });
  assert.equal((buildRadarVerificationSnapshot(a) as Record<string, unknown>).qualityCategory, "fresh_renovation");
  assert.equal((buildRadarVerificationSnapshot(b) as Record<string, unknown>).qualityCategory, "ready_high_standard");
  assert.equal((buildRadarVerificationSnapshot(both) as Record<string, unknown>).qualityCategory, "fresh_renovation", "a confirmed category-A renovation takes precedence over overlapping category-B wording, matching qualification");
});

test("explicit non-apartment transactions and identity mismatch never enter the manual review queue", () => {
  for (const description of [
    "Wynajmę mieszkanie w bloku w Łodzi.",
    "Dom na sprzedaż w Łodzi.",
    "Kamienica na sprzedaż, mieszkanie w Łodzi.",
    "Lokal usługowy na sprzedaż.",
    "Działka inwestycyjna.",
    "Udział w nieruchomości, nie samodzielne mieszkanie.",
    "Sprzedaż całej inwestycji, kilka budynków.",
  ]) {
    assert.equal(isReviewableRadarVerificationCandidate(candidate({ description })), false, description);
  }
  assert.equal(isReviewableRadarVerificationCandidate(candidate({ rawPayload: { radarSearchScope: "apartment-sale", detailIdentity: "mismatch" } })), false);
  assert.equal(isReviewableRadarVerificationCandidate(candidate({ rawPayload: { radarSearchScope: "apartment-sale", detailActive: false } })), false);
  assert.equal(isReviewableRadarVerificationCandidate(candidate({ city: "Warszawa", rawPayload: { radarSearchScope: "apartment-sale" } })), false, "a known non-Łódź city is a hard exclusion, not a manual correction candidate");
  assert.equal(isReviewableRadarVerificationCandidate(candidate({ title: "Ogłoszenie, Łódź", rawPayload: { marketType: "secondary" } })), false, "without the Radar apartment-sale search scope, title must identify an apartment");
});

test("reapplying a persisted operator decision creates an explicit verified result, not a guessed parser fact", () => {
  const source = candidate({ rawPayload: {
    radarSearchScope: "apartment-sale", propertyType: "apartment", marketType: "secondary", detailVerified: false,
    priceIsStartingAt: true, priceKind: "from", priceUnit: "per_sqm",
  } }).listing;
  const decision = {
    apartmentSaleConfirmed: true as const, price: 410_000, area: 41, rooms: 2, city: "Łódź" as const,
    district: "Bałuty" as const, buildingType: "blok" as const, marketType: "secondary" as const,
    qualityCategory: "ready_high_standard" as const,
  };
  const reapplied = applyRadarVerificationDecision(source, decision);
  assert.equal(reapplied.price, 410_000);
  assert.equal(reapplied.pricePerSqm, 10_000);
  assert.equal(reapplied.district, "Bałuty");
  assert.deepEqual(reapplied.rawPayload.operatorVerification, decision);
  assert.deepEqual(reapplied.rawPayload.operatorPriceEvidence, { priceIsStartingAt: true, priceKind: "from", priceUnit: "per_sqm" });
  assert.equal(reapplied.rawPayload.priceIsStartingAt, false, "the explicit total-price confirmation overrides the parser's former starting-price warning");
  assert.equal(reapplied.rawPayload.priceKind, "total");
  assert.equal(reapplied.rawPayload.priceUnit, "total");
});

test("an AI district hint is stored only with its quote and never as an operator decision", async () => {
  const savedCandidate: { value: Record<string, unknown> | null } = { value: null };
  const builder = {
    select() { return this; }, eq() { return this; },
    async maybeSingle() { return { data: null, error: null }; },
  };
  const db = {
    from() { return builder; },
    async rpc(name: string, args: Record<string, unknown>) {
      assert.equal(name, "upsert_price_radar_verification_candidate");
      savedCandidate.value = args.p_candidate as Record<string, unknown>;
      return { data: "queue-id", error: null };
    },
  };
  const input = candidate({ district: null, rawPayload: { radarSearchScope: "apartment-sale", propertyType: "apartment", detailVerified: false, marketType: null } });
  const result = await upsertPendingRadarVerificationCandidate(
    db as never, "owner-test", input, { tryConsume: () => true },
    async () => ({ district: "Bałuty", evidence: "Bałuty, Łódź" }),
  );
  assert.deepEqual(result, { ok: true, queueId: "queue-id" });
  assert.equal(savedCandidate.value?.suggested_district, "Bałuty");
  assert.equal(savedCandidate.value?.suggestion_evidence, "Bałuty, Łódź");
  assert.equal(savedCandidate.value?.operator_decision, undefined, "AI cannot approve or resolve a candidate");
});
