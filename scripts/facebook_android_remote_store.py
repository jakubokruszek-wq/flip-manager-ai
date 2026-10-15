"""Persistent synthetic store for a separately approved FREE test project.

Never accepts the production project. Never drops, truncates or resets schema.
No initialization is attempted on a nonempty unmarked database.
"""
import hashlib
import os
from pathlib import Path
from urllib.parse import urlparse, unquote

PRODUCTION = "zmuisdirvfcxrvtbvrle"

def validate_database(env):
    import re
    project = env.get("FLIP_TEST_PROJECT_REF", "")
    if not re.fullmatch(r"[a-z]{20}", project) or project == PRODUCTION:
        raise ValueError("OFFLINE_TEST_PROJECT_REQUIRED")
    uri = urlparse(env.get("FLIP_TEST_DATABASE_URL", ""))
    host = uri.hostname or ""
    direct = host == "db." + project + ".supabase.co" and uri.username == "postgres"
    pooled = host.endswith(".pooler.supabase.com") and uri.username == "postgres." + project
    # Safe, non-secret diagnostic codes; never log the supplied connection URI.
    if not env.get("FLIP_TEST_DATABASE_URL", ""):
        raise ValueError("OFFLINE_TEST_DATABASE_URL_MISSING")
    if uri.scheme not in ("postgres", "postgresql"):
        raise ValueError("OFFLINE_TEST_DATABASE_SCHEME_INVALID")
    if not (direct or pooled):
        raise ValueError("OFFLINE_TEST_DATABASE_HOST_OR_USER_INVALID")
    if uri.port not in (None, 5432):
        raise ValueError("OFFLINE_TEST_DATABASE_PORT_INVALID")
    if uri.path != "/postgres":
        raise ValueError("OFFLINE_TEST_DATABASE_NAME_INVALID")
    if not uri.password:
        raise ValueError("OFFLINE_TEST_DATABASE_PASSWORD_MISSING")
    if uri.query or uri.fragment:
        raise ValueError("OFFLINE_TEST_DATABASE_EXTRA_PARAMETERS")
    return {"host": host, "port": 5432, "dbname": "postgres", "user": unquote(uri.username), "password": unquote(uri.password),
            "sslmode": "verify-full", "sslrootcert": "/etc/ssl/certs/ca-certificates.crt", "connect_timeout": 10,
            "autocommit": True, "options": "-c statement_timeout=10000 -c lock_timeout=5000"}

def configure(pg):
    import psycopg
    parameters = validate_database(os.environ)
    print("OFFLINE_TEST_STAGE=URL_VALIDATED", flush=True)
    def connect():
        try:
            return psycopg.connect(**parameters)
        except psycopg.Error:
            raise RuntimeError("OFFLINE_TEST_DATABASE_UNAVAILABLE") from None
    # Verify connectivity separately from potentially mutating initialization.
    with connect() as db:
        db.execute("select 1")
    print("OFFLINE_TEST_STAGE=DATABASE_CONNECTED", flush=True)
    return initialize(pg, connect, os.environ["FLIP_TEST_PROJECT_REF"])

def initialize(pg, connect, project_ref):
    from psycopg.types.json import Jsonb
    from facebook_android_fixture_store import create_fixture_tables
    pg.connect = connect
    root = Path(__file__).resolve().parents[1]
    schema_version = hashlib.sha256((pg.constants["FIXTURE"] + (root/"supabase/drafts/android-webview-backend.sql").read_text()).encode()).hexdigest()
    with connect() as db:
        # Session lock spans draft BEGIN/COMMIT as well as initial seeding.
        db.execute("select pg_advisory_lock(710702007)")
        marker = db.execute("select to_regclass('public.offline_test_environment')").fetchone()[0]
        if marker:
            saved = db.execute("select schema_version,project_ref,groups from offline_test_environment where id=1").fetchone()
            if not saved or saved[:2] != (schema_version, project_ref):
                raise ValueError("OFFLINE_TEST_SCHEMA_MISMATCH")
            groups = saved[2]
        else:
            if db.execute("""select 1 from pg_class where relnamespace='public'::regnamespace and relkind in ('r','p','v','m','S')
                union all select 1 from pg_proc p where p.pronamespace='public'::regnamespace
                and not exists(select 1 from pg_depend d where d.objid=p.oid and d.classid='pg_proc'::regclass and d.deptype='e') limit 1""").fetchone():
                raise ValueError("OFFLINE_TEST_NONEMPTY_DATABASE_REFUSED")
            # The managed test project already owns anon/authenticated/service_role.
            db.execute("create table" + pg.constants["FIXTURE"].split("create table", 1)[1])
            db.execute((root/"supabase/drafts/android-webview-backend.sql").read_text())
            db.execute(pg.constants["CASES"].split("do $$",1)[0])
            db.execute("alter table facebook_scan_jobs add column scan_run_id uuid default '22222222-2222-4222-8222-222222222222'")
            db.execute("delete from facebook_scan_jobs where consumer_type='BROWSER_EXTENSION'")
            create_fixture_tables(db)
            db.execute("create table test_nonces(device_id text not null,nonce text not null,expires_at timestamptz not null default now()+interval '10 minutes',primary key(device_id,nonce))")
            groups = seed_sources(db, pg)
            db.execute("create table offline_test_environment(id integer primary key check(id=1),schema_version text not null,project_ref text not null,groups jsonb not null)")
            db.execute("insert into offline_test_environment values(1,%s,%s,%s)",(schema_version,project_ref,Jsonb(groups)))
            # Never expose synthetic results or marker through Supabase's anon API.
            for (table,) in db.execute("select tablename from pg_tables where schemaname='public'").fetchall():
                db.execute("alter table " + table + " enable row level security")
                db.execute("revoke all on " + table + " from public,anon,authenticated")
        db.execute("select pg_advisory_unlock(710702007)")
    return groups

def seed_sources(db, pg):
    from uuid import uuid4
    from psycopg.types.json import Jsonb
    groups=[]
    for index in range(13):
        profile=index>=11
        source_id=str(123456+index) if profile else ("offline-lodz" if index==0 else "offline-"+str(index))
        group_id="00000000-0000-4000-8000-000000000008" if index==0 else str(uuid4())
        url="https://www.facebook.com/profile.php?id="+source_id if profile else "https://www.facebook.com/groups/"+source_id+"/"
        group={"id":group_id,"name":"Offline source "+str(index),"url":url,"sourceId":source_id,"type":"PROFILE" if profile else "GROUP"}
        groups.append({**group,"priority":"high" if index==0 else "normal","enabled":True,"access_status":"UNAVAILABLE" if index==12 else "CONNECTED"})
        if index==0:
            db.execute("update facebook_scan_jobs set group_snapshot=%s,priority=100 where id=%s",(Jsonb([group]),pg.JOB))
        else:
            db.execute("insert into watched_facebook_groups(id,access_status) values(%s,%s)",(group_id,groups[-1]["access_status"]))
            db.execute("insert into collector_android_source_grants(device_id,watched_group_id,search_filter_id) values(%s,%s,'00000000-0000-4000-8000-000000000007')",(pg.DEVICE,group_id))
        # Three distinct durable rounds. No resetting IDs/receipts on restart.
        for round_index in range(3):
            if index==0 and round_index==0:
                continue
            scan=uuid4()
            db.execute("insert into source_scans(id) values(%s)",(scan,))
            db.execute("insert into facebook_scan_jobs(id,source_scan_id,consumer_type,group_snapshot,priority) values(%s,%s,'ANDROID_WEBVIEW',%s,%s)",
                       (uuid4(),scan,Jsonb([group]),100 if index==0 else 0))
    return groups
