#!/usr/bin/env python3
"""Real PostgreSQL CI tests. Fixed isolated service; no production URL accepted."""
import ast
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import os
import time
import unittest
from uuid import UUID

if os.environ.get("GITHUB_ACTIONS") != "true":
    raise SystemExit("BLOCKED: this suite targets only the explicitly provisioned GitHub CI service")
import psycopg
from psycopg.types.json import Jsonb

ROOT = Path(__file__).resolve().parents[1]
constants = {}
for statement in ast.parse((ROOT / "scripts/test-facebook-android-sql.py").read_text()).body:
    if isinstance(statement, ast.Assign) and isinstance(statement.targets[0], ast.Name) and statement.targets[0].id in ("FIXTURE", "CASES"):
        constants[statement.targets[0].id] = ast.literal_eval(statement.value)

def connect():
    return psycopg.connect(host="127.0.0.1", port=55439, dbname="flip_android_test", user="flip_test", password="isolated-ci-only", autocommit=True, options="-c statement_timeout=5000 -c lock_timeout=4000")

DEVICE = UUID("00000000-0000-4000-8000-000000000001")
OTHER = UUID("00000000-0000-4000-8000-000000000002")
JOB = UUID("00000000-0000-4000-8000-000000000004")
COMPLETION = UUID("00000000-0000-4000-8000-000000000006")
HASH = "a" * 64

class AndroidPostgres(unittest.TestCase):
    def setUp(self):
        self.db = connect()
        self.db.execute("drop schema public cascade; create schema public")
        for role in ("anon", "authenticated", "service_role"):
            if not self.db.execute("select 1 from pg_roles where rolname=%s", (role,)).fetchone():
                self.db.execute(f"create role {role}" + (" bypassrls" if role == "service_role" else ""))
        fixture = constants["FIXTURE"].split("create table", 1)[1]
        self.db.execute("create table" + fixture)
        self.db.execute((ROOT / "supabase/drafts/android-webview-backend.sql").read_text())
        self.db.execute("grant usage on schema public to service_role,anon,authenticated; grant select,update on collector_devices,facebook_scan_jobs,source_scans,watched_facebook_groups to service_role")
        seed = constants["CASES"].split("do $$", 1)[0]
        self.db.execute(seed)
        self.db.execute("insert into collector_android_source_grants select %s,watched_group_id,search_filter_id,null from collector_android_source_grants where device_id=%s", (OTHER, DEVICE))

    def tearDown(self):
        self.db.close()

    def claim(self, device, db=None):
        db = db or self.db
        return db.execute("select id,lease_token,attempts from claim_android_facebook_scan_job(%s,180)", (device,)).fetchone()

    def begin(self, token, digest=HASH, device=DEVICE):
        return self.db.execute("select begin_android_facebook_completion(%s,%s,%s,%s,%s)", (JOB,device,token,COMPLETION,digest)).fetchone()[0]

    def test_actual_draft_and_lifecycle_assertions(self):
        self.db.execute("do $$" + constants["CASES"].split("do $$",1)[1])

    def test_two_devices_race_only_one_claims(self):
        def poll(device):
            with connect() as db:
                return self.claim(device,db)
        with ThreadPoolExecutor(2) as pool:
            results=list(pool.map(poll,[DEVICE,OTHER]))
        self.assertEqual(sum(row is not None for row in results),1)
        self.assertEqual(self.db.execute("select attempts from facebook_scan_jobs where id=%s",(JOB,)).fetchone()[0],1)

    def test_same_device_serializes_across_independent_transactions(self):
        with connect() as locked:
            locked.execute("begin")
            first=self.claim(DEVICE,locked)
            def poll():
                with connect() as db: return self.claim(DEVICE,db)
            with ThreadPoolExecutor(1) as pool:
                second=pool.submit(poll)
                time.sleep(.15)
                self.assertFalse(second.done())
                locked.execute("commit")
                self.assertEqual(second.result(timeout=5),first)

    def test_no_grant_means_no_claim(self):
        self.db.execute("delete from collector_android_source_grants")
        self.assertIsNone(self.claim(DEVICE))

    def test_expired_grant_means_no_claim(self):
        self.db.execute("update collector_android_source_grants set expires_at=now()-interval '1 second'")
        self.assertIsNone(self.claim(DEVICE))

    def test_unavailable_source_cannot_be_claimed(self):
        self.db.execute("update watched_facebook_groups set access_status='UNAVAILABLE'")
        self.assertIsNone(self.claim(DEVICE))

    def test_deleted_source_revokes_scope_by_foreign_key(self):
        self.db.execute("delete from watched_facebook_groups")
        self.assertEqual(self.db.execute("select count(*) from collector_android_source_grants").fetchone()[0],0)
        self.assertIsNone(self.claim(DEVICE))

    def test_atomic_completion_receipt_after_response_loss(self):
        _,token,_=self.claim(DEVICE)
        self.assertEqual(self.begin(token)["outcome"],"reserved")
        self.assertEqual(self.begin(token)["outcome"],"busy")
        self.assertEqual(self.begin(token,"b"*64)["outcome"],"conflict")
        receipt={"ok":True,"status":"completed","completionId":str(COMPLETION),"result":{"captured":1}}
        with self.db.transaction():
            first=self.db.execute("select finish_android_facebook_completion(%s,%s,%s,%s,%s,%s)",(JOB,DEVICE,token,COMPLETION,HASH,Jsonb(receipt))).fetchone()[0]
        self.assertEqual(first,receipt)
        self.assertEqual(self.begin(token)["receipt"],receipt)
        self.assertEqual(self.db.execute("select status from source_scans").fetchone()[0],"completed")

    def test_partial_import_stays_fenced(self):
        _,token,_=self.claim(DEVICE)
        self.begin(token)
        self.db.execute("update facebook_scan_jobs set leased_until=now()-interval '1 hour' where id=%s",(JOB,))
        self.assertIsNone(self.claim(OTHER))
        self.assertIsNone(self.claim(DEVICE))
        self.assertEqual(self.begin(token)["outcome"],"busy")

    def test_rls_and_service_invoker(self):
        self.assertTrue(self.db.execute("select relrowsecurity from pg_class where oid='collector_android_source_grants'::regclass").fetchone()[0])
        for role in ("anon","authenticated"):
            with connect() as db:
                db.execute(f"set role {role}")
                with self.assertRaises(psycopg.errors.InsufficientPrivilege):
                    db.execute("select * from claim_android_facebook_scan_job(%s,180)",(DEVICE,))
                with self.assertRaises(psycopg.errors.InsufficientPrivilege):
                    db.execute("select * from collector_android_source_grants")
        self.db.execute("set role service_role")
        try: self.assertIsNotNone(self.claim(DEVICE))
        finally: self.db.execute("reset role")

    def test_browser_jobs_unchanged(self):
        self.claim(DEVICE)
        self.assertEqual(self.db.execute("select status,attempts from facebook_scan_jobs where consumer_type='BROWSER_EXTENSION'").fetchone(),("queued",0))

    def test_completion_id_is_unique_across_two_owned_jobs(self):
        scan = UUID("00000000-0000-4000-8000-000000000009")
        second = UUID("00000000-0000-4000-8000-000000000010")
        self.db.execute("insert into source_scans(id) values(%s)",(scan,))
        self.db.execute("insert into facebook_scan_jobs(id,source_scan_id,consumer_type) values(%s,%s,'ANDROID_WEBVIEW')",(second,scan))
        first_claim=self.claim(DEVICE);other_claim=self.claim(OTHER)
        self.assertNotEqual(first_claim[0],other_claim[0])
        def reserve(claim,device):
            with connect() as db:
                return db.execute("select begin_android_facebook_completion(%s,%s,%s,%s,%s)",(claim[0],device,claim[1],COMPLETION,HASH)).fetchone()[0]["outcome"]
        with ThreadPoolExecutor(2) as pool:
            a=pool.submit(reserve,first_claim,DEVICE);b=pool.submit(reserve,other_claim,OTHER)
            self.assertEqual(sorted([a.result(timeout=5),b.result(timeout=5)]),["conflict","reserved"])

    def test_atomic_insert_witness_for_isolated_e2e_adapter(self):
        # Tests the isolated adapter's SQL primitive, not production counters.
        self.db.execute("create table isolated_unique_listing(source text,external_listing_id text,price int,primary key(source,external_listing_id))")
        def upsert():
            with connect() as db:
                return db.execute("insert into isolated_unique_listing values('facebook','post',260000) on conflict(source,external_listing_id) do update set price=excluded.price returning (xmax=0)").fetchone()[0]
        with ThreadPoolExecutor(2) as pool:
            a=pool.submit(upsert);b=pool.submit(upsert)
            self.assertEqual(sum([a.result(timeout=5),b.result(timeout=5)]),1)
        self.assertEqual(self.db.execute("select count(*) from isolated_unique_listing").fetchone()[0],1)

if __name__ == "__main__":
    unittest.main(verbosity=2)
