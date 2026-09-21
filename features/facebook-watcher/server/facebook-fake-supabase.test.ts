import assert from "node:assert/strict";
import test from "node:test";
import { FakeFacebookSupabase } from "./facebook-fake-supabase.ts";

test("upsert ignores a single duplicate without changing the stored row", async () => {
  const db = new FakeFacebookSupabase();
  db.seed("records", [{ id: "old", event_key: "same", title: "Original", marker: "keep" }]);
  const before = JSON.stringify(db.rows("records"));

  await db.from("records").upsert(
    { id: "replacement", event_key: "same", title: "Incoming", marker: "overwrite-attempt" },
    { onConflict: "event_key", ignoreDuplicates: true },
  );

  assert.equal(JSON.stringify(db.rows("records")), before);
});

test("an ignore-duplicates batch preserves the duplicate and inserts the new row", async () => {
  const db = new FakeFacebookSupabase();
  db.seed("records", [{ id: "old", event_key: "same", title: "Original" }]);
  const before = JSON.stringify(db.rows("records")[0]);

  await db.from("records").upsert(
    [
      { id: "replacement", event_key: "same", title: "Incoming" },
      { id: "new", event_key: "different", title: "New" },
    ],
    { onConflict: "event_key", ignoreDuplicates: true },
  );

  assert.equal(JSON.stringify(db.rows("records")[0]), before);
  assert.deepEqual(db.rows("records"), [
    { id: "old", event_key: "same", title: "Original" },
    { id: "new", event_key: "different", title: "New" },
  ]);
});

test("ignoreDuplicates=false keeps the fake's existing update/upsert semantics", async () => {
  const db = new FakeFacebookSupabase();
  db.seed("records", [{ id: "old", event_key: "same", title: "Original", marker: "keep" }]);

  await db.from("records").upsert(
    { id: "replacement", event_key: "same", title: "Updated" },
    { onConflict: "event_key", ignoreDuplicates: false },
  );

  assert.deepEqual(db.rows("records"), [
    { id: "replacement", event_key: "same", title: "Updated", marker: "keep" },
  ]);
});

test("conflict matching uses the requested column instead of assuming id or event_key", async () => {
  const db = new FakeFacebookSupabase();
  db.seed("records", [{ uuid: "old", external_key: "same", title: "Original" }]);

  await db.from("records").upsert(
    { uuid: "replacement", external_key: "same", title: "Incoming" },
    { onConflict: "external_key", ignoreDuplicates: true },
  );

  assert.deepEqual(db.rows("records"), [{ uuid: "old", external_key: "same", title: "Original" }]);
});
