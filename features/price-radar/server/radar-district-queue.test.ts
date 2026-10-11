import assert from "node:assert/strict";
import test from "node:test";

type Row = Record<string, unknown>;

function fakeDb(initial: Row[] = []) {
  const rows: Row[] = initial;
  let seq = 0;
  return {
    rows,
    from(table: string) {
      assert.equal(table, "price_radar_district_queue");
      const filters: Array<(row: Row) => boolean> = [];
      const builder: Row = {
        select: () => builder,
        eq: (key: string, value: unknown) => { filters.push((row) => row[key] === value); return builder; },
        order: () => builder,
        maybeSingle: async () => ({ data: rows.find((row) => filters.every((filter) => filter(row))) ?? null, error: null }),
        then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
          Promise.resolve({ data: rows.filter((row) => filters.every((filter) => filter(row))), error: null }).then(resolve, reject),
      };
      return builder;
    },
    async rpc(name: string, args: Row) {
      if (name === "upsert_price_radar_district_queue_candidate") {
        const candidate = args.p_candidate as Row;
        let row = rows.find((item) => item.owner_id === args.p_owner_id && item.source === candidate.source && item.external_listing_id === candidate.external_listing_id);
        if (!row) {
          row = { id: `queue-${++seq}`, owner_id: args.p_owner_id, status: "pending", assigned_district: null, assigned_at: null, rejected_at: null, first_seen_at: candidate.collected_at };
          rows.push(row);
        }
        Object.assign(row, candidate);
        return { data: row.id, error: null };
      }
      if (name === "set_price_radar_district_queue_rejection") {
        const row = rows.find((item) => item.id === args.p_queue_id && item.owner_id === args.p_owner_id && (item.status === "pending" || item.status === "rejected"));
        if (!row) return { data: false, error: null };
        row.status = args.p_rejected ? "rejected" : "pending";
        row.rejected_at = args.p_rejected ? "2026-10-11T10:00:00.000Z" : null;
        return { data: true, error: null };
      }
      if (name === "assign_price_radar_district_queue_candidate") {
        const districts = ["Bałuty", "Górna", "Polesie", "Śródmieście", "Widzew"];
        if (!districts.includes(args.p_district as string)) return { data: null, error: { message: "INVALID_DISTRICT" } };
        const row = rows.find((item) => item.id === args.p_queue_id && item.owner_id === args.p_owner_id);
        if (!row) return { data: null, error: { message: "QUEUE_CANDIDATE_NOT_FOUND" } };
        const listingId = `listing-${row.id}`;
        row.status = "assigned";
        row.assigned_district = args.p_district;
        row.assigned_at = "2026-10-11T10:05:00.000Z";
        row.rejected_at = null;
        return { data: listingId, error: null };
      }
      throw new Error(`unexpected RPC ${name}`);
    },
  };
}

function schemaUnavailableDb() {
  return {
    from() {
      const builder: Row = {
        select: () => builder,
        eq: () => builder,
        order: () => builder,
        maybeSingle: async () => ({ data: null, error: { code: "42P01", message: "relation \"public.price_radar_district_queue\" does not exist" } }),
        then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: null, error: { code: "PGRST205", message: "Could not find the table 'public.price_radar_district_queue' in the schema cache" } }).then(resolve),
      };
      return builder;
    },
    async rpc(name: string) {
      return { data: null, error: { code: "PGRST202", message: `Could not find the function public.${name} in the schema cache` } };
    },
  };
}

const { upsertPendingDistrictCandidate, getRadarDistrictQueue, assignRadarDistrictQueueCandidate, setRadarDistrictQueueRejection } = await import("./radar-district-queue.ts");

const ownerId = "owner-1";
const baseCandidate = {
  source: "domiporta", externalListingId: "ext-1", originalUrl: "https://example.test/1", normalizedUrl: "https://example.test/1",
  title: "Mieszkanie w bloku, Łódź", description: "Świeżo po generalnym remoncie w 2025, nowe instalacje, gotowe do zamieszkania. Rynek wtórny.",
  price: 450_000, area: 50, rooms: 2, city: "Łódź",
  contentHash: "hash-1", crossSourceIdentity: null, publishedAt: null, sourceUpdatedAt: null, rawPayload: { detailVerified: true },
};
const baseConfirmed = { buildingType: "blok", marketType: "secondary", renovationStatus: "fresh_renovation", pricePerSqm: 9_000 };

test("upsertPendingDistrictCandidate reports schema_unavailable instead of throwing when the migration is not applied", async () => {
  const result = await upsertPendingDistrictCandidate(schemaUnavailableDb() as never, ownerId, baseCandidate, baseConfirmed, "2026-10-11T10:00:00.000Z");
  assert.deepEqual(result, { ok: false, reason: "schema_unavailable" });
});

test("getRadarDistrictQueue reports an unavailable, empty queue instead of throwing when the migration is not applied", async () => {
  const result = await getRadarDistrictQueue(ownerId, schemaUnavailableDb() as never);
  assert.deepEqual(result, { available: false, pending: [], assigned: [], rejected: [] });
});

test("assignRadarDistrictQueueCandidate reports schema_unavailable, never a thrown error, for an unapplied migration", async () => {
  const result = await assignRadarDistrictQueueCandidate(ownerId, "queue-1", "Bałuty", ownerId, 2, schemaUnavailableDb() as never);
  assert.deepEqual(result, { ok: false, reason: "schema_unavailable" });
});

test("assignRadarDistrictQueueCandidate rejects an invalid district name before ever touching the database", async () => {
  const db = fakeDb();
  const result = await assignRadarDistrictQueueCandidate(ownerId, "queue-1", "Nieznana", ownerId, 2, db as never);
  assert.deepEqual(result, { ok: false, reason: "invalid_district" });
});

test("a full pending -> assign cycle round-trips through getRadarDistrictQueue", async () => {
  const db = fakeDb();
  const upserted = await upsertPendingDistrictCandidate(db as never, ownerId, baseCandidate, baseConfirmed, "2026-10-11T10:00:00.000Z");
  assert.equal(upserted.ok, true);
  const queueId = upserted.ok ? upserted.queueId : "";

  const beforeAssign = await getRadarDistrictQueue(ownerId, db as never);
  assert.equal(beforeAssign.available, true);
  assert.equal(beforeAssign.pending.length, 1);
  assert.equal(beforeAssign.pending[0]?.id, queueId);
  assert.equal(beforeAssign.pending[0]?.buildingType, "blok");

  const assigned = await assignRadarDistrictQueueCandidate(ownerId, queueId, "Bałuty", ownerId, 2, db as never);
  assert.equal(assigned.ok, true);

  const afterAssign = await getRadarDistrictQueue(ownerId, db as never);
  assert.equal(afterAssign.pending.length, 0, "an assigned candidate leaves the pending list");
  assert.equal(afterAssign.assigned.length, 1);
  assert.equal(afterAssign.assigned[0]?.assignedDistrict, "Bałuty");
});

test("reject then undo-reject round-trips a pending candidate", async () => {
  const db = fakeDb();
  const upserted = await upsertPendingDistrictCandidate(db as never, ownerId, baseCandidate, baseConfirmed, "2026-10-11T10:00:00.000Z");
  const queueId = upserted.ok ? upserted.queueId : "";

  const rejected = await setRadarDistrictQueueRejection(ownerId, queueId, true, db as never);
  assert.deepEqual(rejected, { ok: true });
  const afterReject = await getRadarDistrictQueue(ownerId, db as never);
  assert.equal(afterReject.pending.length, 0);
  assert.equal(afterReject.rejected.length, 1);

  const restored = await setRadarDistrictQueueRejection(ownerId, queueId, false, db as never);
  assert.deepEqual(restored, { ok: true });
  const afterRestore = await getRadarDistrictQueue(ownerId, db as never);
  assert.equal(afterRestore.pending.length, 1);
  assert.equal(afterRestore.rejected.length, 0);
});

test("a reimport (re-upsert) of the same owner/source/externalListingId refreshes the snapshot in one row, never duplicating it", async () => {
  const db = fakeDb();
  const first = await upsertPendingDistrictCandidate(db as never, ownerId, baseCandidate, baseConfirmed, "2026-10-11T10:00:00.000Z");
  const second = await upsertPendingDistrictCandidate(db as never, ownerId, { ...baseCandidate, price: 460_000 }, baseConfirmed, "2026-10-11T11:00:00.000Z");
  assert.equal(first.ok && second.ok && first.queueId === second.queueId, true, "the same (owner, source, externalListingId) must resolve to the same queue row");
  assert.equal(db.rows.length, 1);
  assert.equal(db.rows[0]?.price, 460_000, "the snapshot is refreshed");
});

test("assignRadarDistrictQueueCandidate re-qualifies the CURRENT row -- a candidate that no longer qualifies on another ground is refused, never silently approved by a district choice", async () => {
  const db = fakeDb();
  const upserted = await upsertPendingDistrictCandidate(db as never, ownerId, baseCandidate, baseConfirmed, "2026-10-11T10:00:00.000Z");
  const queueId = upserted.ok ? upserted.queueId : "";
  // Simulate something about the dwelling genuinely changing between the
  // scan that queued it and the operator's decision (e.g. a later rescan's
  // upsert refreshed the row with a now-invalid price) -- the API must
  // re-qualify the CURRENT stored row, not trust whatever was true when it
  // was first queued.
  const row = db.rows.find((item) => item.id === queueId);
  if (row) row.price = 0;
  const result = await assignRadarDistrictQueueCandidate(ownerId, queueId, "Bałuty", ownerId, 2, db as never);
  assert.deepEqual(result, { ok: false, reason: "no_longer_qualifies", detail: "price_missing" });
});

test("assignRadarDistrictQueueCandidate re-qualifies successfully when the stored row is unchanged", async () => {
  const db = fakeDb();
  const upserted = await upsertPendingDistrictCandidate(db as never, ownerId, baseCandidate, baseConfirmed, "2026-10-11T10:00:00.000Z");
  const queueId = upserted.ok ? upserted.queueId : "";
  const result = await assignRadarDistrictQueueCandidate(ownerId, queueId, "Bałuty", ownerId, 2, db as never);
  assert.equal(result.ok, true);
});

test("assignRadarDistrictQueueCandidate reports not_found for a queue id that does not belong to this owner", async () => {
  const db = fakeDb();
  const upserted = await upsertPendingDistrictCandidate(db as never, "owner-other", baseCandidate, baseConfirmed, "2026-10-11T10:00:00.000Z");
  const queueId = upserted.ok ? upserted.queueId : "";
  const result = await assignRadarDistrictQueueCandidate(ownerId, queueId, "Bałuty", ownerId, 2, db as never);
  assert.deepEqual(result, { ok: false, reason: "not_found" });
});
