import assert from "node:assert/strict";
import test from "node:test";
import { readRadarVerificationBacklog } from "./radar-verification-backlog.ts";

type Row = Record<string, unknown>;
function database(queue: Row[], active: Row[] = []) {
  return { from(table: string) {
    const predicates: Array<(row: Row) => boolean> = [];
    const builder = {
      select: () => builder,
      eq: (key: string, value: unknown) => { predicates.push((row) => row[key] === value); return builder; },
      in: (key: string, values: unknown[]) => { predicates.push((row) => values.includes(row[key])); return builder; },
      order: () => builder,
      then(resolve: (value: unknown) => unknown) { return Promise.resolve({ data: (table === "price_radar_verification_queue" ? queue : active).filter((row) => predicates.every((predicate) => predicate(row))), error: null }).then(resolve); },
    };
    return builder;
  } };
}
const row = (id: string, patch: Row = {}): Row => ({ id, owner_id: "owner", source: "gratka", status: "pending", external_listing_id: id,
  original_url: `https://gratka.pl/nieruchomosci/mieszkanie/ob/${id}`, source_snapshot: { price: 400000, area: 40, rawPayload: { detailVerified: true } }, ...patch });

test("automatic backlog is owner/source scoped, excludes previous decisions and already qualified offers", async () => {
  const db = database([row("1", { source_snapshot: { crossSourceIdentity: "portal_shared_unit_id:unit-1", rawPayload: { detailVerified: true } } }), row("2", { owner_id: "other" }), row("3", { status: "rejected" }), row("4", { status: "confirmed" }), row("5"), row("6", { source: "morizon" })],
    [{ owner_id: "owner", source: "gratka", status: "active", external_listing_id: "5" }]);
  const result = await readRadarVerificationBacklog(db as never, "owner", "gratka");
  assert.deepEqual(result.ids, ["1"]);
  assert.equal(result.listings[0].rawPayload.detailVerified, false, "a saved hint never counts as a newly verified detail");
  assert.equal(result.listings[0].rawPayload.radarBacklogRescan, true);
  assert.equal(result.listings[0].crossSourceIdentity, "portal_shared_unit_id:unit-1");
});
test("rejections, removals and confirmations between portions keep their fixed cursor slots and are skipped", async () => {
  const db = database([row("1", { status: "rejected" }), row("3"), row("4", { status: "confirmed" })]);
  const result = await readRadarVerificationBacklog(db as never, "owner", "gratka", ["1", "2", "3", "4"]);
  assert.deepEqual(result.ids, ["1", "2", "3", "4"]);
  assert.deepEqual(result.listings.map((listing) => listing.rawPayload.radarBacklogSkip), [true, true, false, true]);
});
test("backlog reading is bounded even if the database returns a large queue", async () => {
  const result = await readRadarVerificationBacklog(database(Array.from({ length: 1000 }, (_, index) => row(String(index)))) as never, "owner", "gratka");
  assert.equal(result.ids.length, 300);
});

test("the first 300 already qualified records cannot starve the next pending candidates", async () => {
  const queue = Array.from({ length: 400 }, (_, index) => row(String(index)));
  const active = queue.slice(0, 300).map((item) => ({ owner_id: "owner", source: "gratka", status: "active", external_listing_id: item.external_listing_id }));
  const result = await readRadarVerificationBacklog(database(queue, active) as never, "owner", "gratka");
  assert.equal(result.ids.length, 100);
  assert.equal(result.ids[0], "300");
});
