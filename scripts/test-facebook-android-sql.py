#!/usr/bin/env python3
"""Execute the actual SQL draft in a disposable native PostgreSQL cluster.

Never accepts a connection URL or reads production DB environment variables.
Requires initdb, pg_ctl and psql in PATH; run as an unprivileged local user.
Minimal prerequisite tables test the draft, not the full historical migrations.
"""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
TOOLS = {name: shutil.which(name) for name in ("initdb", "pg_ctl", "psql")}
missing = [name for name, path in TOOLS.items() if not path]
if missing:
    raise SystemExit("BLOCKED: missing local PostgreSQL tools: " + ", ".join(missing))

FIXTURE = """
create role anon; create role authenticated; create role service_role bypassrls;
create table public.collector_devices (
 id uuid primary key, last_heartbeat_at timestamptz, revoked_at timestamptz
);
create table public.watched_facebook_groups (id uuid primary key, enabled boolean not null default true, access_status text not null default 'CONNECTED');
create table public.source_scans (
 id uuid primary key, status text not null default 'pending',
 finished_at timestamptz, error_message text
);
create table public.facebook_scan_jobs (
 id uuid primary key, source_scan_id uuid references public.source_scans,
 search_filter_id uuid default '00000000-0000-4000-8000-000000000007',
 group_snapshot jsonb default '[{"id":"00000000-0000-4000-8000-000000000008"}]',
 consumer_type text not null constraint facebook_scan_jobs_consumer_type_check
 check (consumer_type in ('BROWSER_EXTENSION','LEGACY_WORKER')),
 job_type text not null default 'SOURCE_SCAN', status text not null default 'queued',
 worker_id text, lease_token uuid, leased_until timestamptz,
 attempts integer not null default 0, max_attempts integer not null default 3,
 priority integer not null default 0, created_at timestamptz default now(),
 available_at timestamptz default now(), started_at timestamptz,
 heartbeat_at timestamptz, finished_at timestamptz,
 error_code text, error_message text, result_summary jsonb
);
"""
CASES = """
insert into collector_devices(id,consumer_type) values
 ('00000000-0000-4000-8000-000000000001','ANDROID_WEBVIEW'),
 ('00000000-0000-4000-8000-000000000002','ANDROID_WEBVIEW');
insert into watched_facebook_groups(id) values ('00000000-0000-4000-8000-000000000008');
insert into collector_android_source_grants(device_id,watched_group_id,search_filter_id) values
 ('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000008','00000000-0000-4000-8000-000000000007');
insert into source_scans(id) values ('00000000-0000-4000-8000-000000000003');
insert into facebook_scan_jobs(id,source_scan_id,consumer_type) values
 ('00000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-000000000003','ANDROID_WEBVIEW'),
 ('00000000-0000-4000-8000-000000000005',null,'BROWSER_EXTENSION');
do $$
declare
 device uuid := '00000000-0000-4000-8000-000000000001';
 other_device uuid := '00000000-0000-4000-8000-000000000002';
 completion uuid := '00000000-0000-4000-8000-000000000006';
 j public.facebook_scan_jobs%rowtype;
 again public.facebook_scan_jobs%rowtype;
 old_token uuid; outcome jsonb; receipt jsonb;
begin
 select * into strict j from claim_android_facebook_scan_job(device,180);
 assert j.consumer_type = 'ANDROID_WEBVIEW' and j.attempts = 1;
 select * into strict again from claim_android_facebook_scan_job(device,180);
 assert again.lease_token = j.lease_token and again.attempts = 1;
 assert not exists(select 1 from renew_android_facebook_scan_job(j.id,other_device,j.lease_token,180));
 assert not exists(select 1 from claim_android_facebook_scan_job(other_device,180));
 old_token := j.lease_token;
 update facebook_scan_jobs set leased_until = clock_timestamp()-interval '1 second' where id=j.id;
 assert not exists(select 1 from renew_android_facebook_scan_job(j.id,device,old_token,180));
 assert not exists(select 1 from claim_android_facebook_scan_job(other_device,180));
 assert (select status='queued' and lease_token is null and available_at>clock_timestamp() from facebook_scan_jobs where id=j.id);
 update facebook_scan_jobs set available_at=clock_timestamp()-interval '1 second' where id=j.id;
 select * into strict j from claim_android_facebook_scan_job(device,180);
 assert j.attempts=2 and j.lease_token<>old_token;
 outcome := begin_android_facebook_completion(j.id,device,old_token,completion,repeat('a',64));
 assert outcome->>'outcome'='lost';
 outcome := begin_android_facebook_completion(j.id,device,j.lease_token,completion,repeat('a',64));
 assert outcome->>'outcome'='reserved';
 outcome := begin_android_facebook_completion(j.id,device,j.lease_token,completion,repeat('b',64));
 assert outcome->>'outcome'='conflict';
 update facebook_scan_jobs set leased_until=clock_timestamp()-interval '1 second' where id=j.id;
 assert not exists(select 1 from claim_android_facebook_scan_job(device,180));
 assert not exists(select 1 from claim_android_facebook_scan_job(other_device,180));
 receipt := jsonb_build_object('ok',true,'status','completed','completionId',completion,'result',jsonb_build_object('captured',1));
 assert finish_android_facebook_completion(j.id,other_device,j.lease_token,completion,repeat('a',64),receipt) is null;
 assert finish_android_facebook_completion(j.id,device,j.lease_token,completion,repeat('a',64),receipt)=receipt;
 assert finish_android_facebook_completion(j.id,device,j.lease_token,completion,repeat('a',64),receipt)=receipt;
 outcome := begin_android_facebook_completion(j.id,device,j.lease_token,completion,repeat('a',64));
 assert outcome->>'outcome'='duplicate' and outcome->'receipt'=receipt;
 assert (select status='queued' and attempts=0 from facebook_scan_jobs where consumer_type='BROWSER_EXTENSION');
 assert not has_function_privilege('anon','public.claim_android_facebook_scan_job(uuid,integer)','execute');
 assert not has_function_privilege('authenticated','public.claim_android_facebook_scan_job(uuid,integer)','execute');
 assert has_function_privilege('service_role','public.claim_android_facebook_scan_job(uuid,integer)','execute');
end $$;
"""

# Explicit connection options override any inherited PGHOST/PGSERVICE settings.
env = {k: v for k, v in os.environ.items() if not k.startswith("PG")}
with tempfile.TemporaryDirectory(prefix="flip-android-pg-") as directory:
    root = Path(directory)
    data = root / "data"
    def run(name, *args, **kwargs):
        return subprocess.run([TOOLS[name], *map(str, args)], env=env, check=True, timeout=60, **kwargs)
    run("initdb", "-D", data, "-A", "trust", "-U", "flip_test", "--no-locale")
    started = False
    try:
        # Unix socket only. No TCP listener, production URL or shared database.
        run("pg_ctl", "-D", data, "-l", root / "server.log", "-o", f"-k {root} -h '' -p 55439", "-w", "start")
        started = True
        sql = FIXTURE + (ROOT / "supabase/drafts/android-webview-backend.sql").read_text() + CASES
        run("psql", "-X", "-h", root, "-p", "55439", "-U", "flip_test", "-d", "postgres", "-v", "ON_ERROR_STOP=1", input=sql, text=True)
        print("PASS: draft functions, ownership, expiry/backoff, fencing, receipts, consumer separation and execute grants")
        print("NOT COVERED: full historical migrations, concurrent independent transactions, real Supabase RLS")
    finally:
        if started:
            run("pg_ctl", "-D", data, "-m", "immediate", "-w", "stop")
