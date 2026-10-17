"""Isolated fixture persistence only; no Supabase clients or production URLs."""
from psycopg.types.json import Jsonb


def create_fixture_tables(conn):
    conn.execute("create table test_completed_batches(batch_id uuid primary key,binding jsonb not null,result jsonb not null)")
    conn.execute("create table test_listings(id uuid primary key default gen_random_uuid(),source text not null,external_listing_id text not null,source_id text not null,price numeric,unique(source,external_listing_id))")


def persist_fixture_import(conn, body):
    binding = body["binding"]
    with conn.transaction():
        # Serialize same-batch retries BEFORE any side effects or counting.
        conn.execute("select pg_advisory_xact_lock(hashtextextended(%s,0))", (binding["batchId"],))
        saved = conn.execute("select binding,result from test_completed_batches where batch_id=%s", (binding["batchId"],)).fetchone()
        if saved:
            if saved["binding"] != binding:
                raise ValueError("BATCH_BINDING_CONFLICT")
            return saved["result"]
        created = updated = duplicates = 0
        for listing in body["listings"]:
            row = conn.execute(
                "insert into test_listings(source,external_listing_id,source_id,price) values('facebook',%s,%s,%s) "
                "on conflict(source,external_listing_id) do update set price=excluded.price "
                "where test_listings.source_id=excluded.source_id and test_listings.price is distinct from excluded.price "
                "returning (xmax=0) as inserted",
                (listing["postId"], listing["sourceId"], listing["price"]),
            ).fetchone()
            if row is None:
                existing = conn.execute("select source_id from test_listings where source='facebook' and external_listing_id=%s", (listing["postId"],)).fetchone()
                if existing["source_id"] != listing["sourceId"]:
                    raise ValueError("POST_SOURCE_CONFLICT")
                duplicates += 1
            elif row["inserted"]:
                created += 1
            else:
                updated += 1
        counts = {"version": 1, "basis": "TRANSACTIONAL", "created": created, "updated": updated, "duplicates": duplicates}
        result = {**body["result"], "listingsCreated": created, "listingsUpdated": updated, "writeAccounting": counts}
        conn.execute("insert into test_completed_batches values(%s,%s,%s)", (binding["batchId"], Jsonb(binding), Jsonb(result)))
        return result
