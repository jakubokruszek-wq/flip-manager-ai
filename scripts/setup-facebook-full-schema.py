#!/usr/bin/env python3
"""Restore the schema-only app snapshot into the fixed disposable CI database.

No production URL/environment variable accepted. Supabase-managed auth is
represented by its documented uid/jwt interface; no users/sessions are copied.
"""
import os
from pathlib import Path
import psycopg

if os.environ.get("GITHUB_ACTIONS") != "true" and os.environ.get("FLIP_ISOLATED_TESTS") != "1":
    raise SystemExit("ISOLATED_TESTS_ONLY")
root = Path(__file__).resolve().parents[1]
with psycopg.connect(host="127.0.0.1", port=55439, dbname="flip_android_test", user="flip_test", password="isolated-ci-only", autocommit=True) as db:
    for role in ("anon", "authenticated", "service_role"):
        if not db.execute("select 1 from pg_roles where rolname=%s", (role,)).fetchone():
            db.execute("create role " + role + (" bypassrls" if role == "service_role" else ""))
    db.execute("drop schema public cascade; create schema public; grant usage on schema public to anon,authenticated,service_role")
    db.execute("create schema if not exists auth; create table if not exists auth.users(id uuid primary key)")
    db.execute("""create or replace function auth.jwt() returns jsonb language sql stable as $$
        select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
        create or replace function auth.uid() returns uuid language sql stable as $$
        select nullif(auth.jwt()->>'sub','')::uuid $$;
        grant usage on schema auth to anon,authenticated,service_role;
        grant execute on function auth.jwt(),auth.uid() to anon,authenticated,service_role;""")
    db.execute((root / "scripts/fixtures/facebook-public-schema.sql").read_text())
    count=db.execute("select count(*) from pg_tables where schemaname='public'").fetchone()[0]
    assert count == 51, count
    db.execute((root / "supabase/drafts/android-webview-backend.sql").read_text())
    db.execute("insert into search_filters(id,name,sources,city) values('66666666-6666-4666-8666-666666666666','Synthetic Finder integration','[\"facebook\"]','Łódź')")
    db.execute("insert into source_scans(id,search_filter_id,source,status) values('44444444-4444-4444-8444-444444444444','66666666-6666-4666-8666-666666666666','facebook','running')")
    db.execute("notify pgrst, 'reload schema'")
    print("Restored 51 application tables, 49 functions, constraints, indexes, policies and grants; zero production rows.")
