"""Real PostgreSQL restart/permission checks; hardcoded local CI databases only."""
import importlib.util
import os
from pathlib import Path
import unittest
import psycopg
from facebook_android_remote_store import initialize

if os.environ.get("GITHUB_ACTIONS") != "true" and os.environ.get("FLIP_ISOLATED_TESTS") != "1":
    raise SystemExit("ISOLATED_TESTS_ONLY")
spec=importlib.util.spec_from_file_location("remote_pg_fixture",Path(__file__).with_name("test-facebook-android-postgres.py"))
pg=importlib.util.module_from_spec(spec);spec.loader.exec_module(pg)

def connect(name="flip_android_remote_fixture"):
    return psycopg.connect(host="127.0.0.1",port=55439,dbname=name,user="flip_test",password="isolated-ci-only",autocommit=True)

class RemoteStore(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with connect("flip_android_test") as db:
            for role in ("anon","authenticated","service_role"):
                if not db.execute("select 1 from pg_roles where rolname=%s",(role,)).fetchone():
                    db.execute("create role "+role+(" bypassrls" if role=="service_role" else ""))
    def test_restart_preserves_sources_owned_lease_and_results(self):
        with connect("flip_android_test") as db: db.execute("create database flip_android_remote_fixture")
        groups=initialize(pg,connect,"abcdefghijklmnopqrst")
        self.assertEqual(len(groups),13)
        self.assertEqual(sum(row["type"]=="GROUP" for row in groups),11)
        with connect() as db:
            jobs=db.execute("select id from facebook_scan_jobs order by id").fetchall()
            self.assertEqual(len(jobs),39)
            claimed=db.execute("select id,lease_token from claim_android_facebook_scan_job(%s,180)",(pg.DEVICE,)).fetchone()
            self.assertIsNotNone(claimed)
            db.execute("insert into test_listings(source,external_listing_id,source_id,price) values('facebook','synthetic-preserved','offline-lodz',260000)")
        again=initialize(pg,connect,"abcdefghijklmnopqrst")
        self.assertEqual(again,groups)
        with connect() as db:
            self.assertEqual(db.execute("select id from facebook_scan_jobs order by id").fetchall(),jobs)
            self.assertEqual(db.execute("select id,lease_token from claim_android_facebook_scan_job(%s,180)",(pg.DEVICE,)).fetchone(),claimed)
            self.assertEqual(db.execute("select count(*) from test_listings").fetchone()[0],1)
            for role in ("anon","authenticated"):
                with self.assertRaises(psycopg.errors.InsufficientPrivilege):
                    with db.transaction():
                        db.execute("set local role "+role)
                        db.execute("select * from facebook_scan_jobs")

    def test_nonempty_unmarked_database_is_never_reset(self):
        with connect("flip_android_test") as db: db.execute("create database flip_android_refuse_fixture")
        def target(): return connect("flip_android_refuse_fixture")
        with target() as db: db.execute("create table unrelated(id integer); insert into unrelated values(7)")
        with self.assertRaisesRegex(ValueError,"NONEMPTY_DATABASE_REFUSED"): initialize(pg,target,"abcdefghijklmnopqrst")
        with target() as db: self.assertEqual(db.execute("select id from unrelated").fetchone()[0],7)

if __name__=="__main__": unittest.main()
