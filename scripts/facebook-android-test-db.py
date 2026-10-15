#!/usr/bin/env python3
"""Ephemeral CI-only DB bridge. No Supabase credentials or arbitrary SQL API."""
import importlib.util
import json
import os
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from uuid import uuid4

if os.environ.get("GITHUB_ACTIONS") != "true" and os.environ.get("FLIP_ISOLATED_TESTS") != "1":
    raise SystemExit("BLOCKED: isolated GitHub CI service only")
spec = importlib.util.spec_from_file_location("isolated_pg", Path(__file__).with_name("test-facebook-android-postgres.py"))
pg = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pg)
from psycopg.types.json import Jsonb
from psycopg.rows import dict_row
from facebook_android_fixture_store import create_fixture_tables, persist_fixture_import

suite = pg.AndroidPostgres()
suite.setUp()
db = suite.db
RUN = "22222222-2222-4222-8222-222222222222"
db.execute("alter table facebook_scan_jobs add column scan_run_id uuid default '" + RUN + "'")
create_fixture_tables(db)
db.execute("create table test_nonces(device_id text not null,nonce text not null,primary key(device_id,nonce))")
db.execute("delete from facebook_scan_jobs where consumer_type='BROWSER_EXTENSION'")
groups = []
for index in range(13):
    profile = index >= 11
    source_id = str(123456 + index) if profile else ("offline-lodz" if index == 0 else "offline-" + str(index))
    group_id = "00000000-0000-4000-8000-000000000008" if index == 0 else str(uuid4())
    url = "https://www.facebook.com/profile.php?id=" + source_id if profile else "https://www.facebook.com/groups/" + source_id + "/"
    group = {"id": group_id, "name": "Offline source " + str(index), "url": url, "sourceId": source_id, "type": "PROFILE" if profile else "GROUP"}
    groups.append({**group, "priority": "high" if index == 0 else "normal", "enabled": True, "access_status": "UNAVAILABLE" if index == 12 else "CONNECTED"})
    if index == 0:
        db.execute("update facebook_scan_jobs set group_snapshot=%s,priority=100 where id=%s", (Jsonb([group]), pg.JOB))
    else:
        db.execute("insert into watched_facebook_groups(id,access_status) values(%s,%s)", (group_id, "UNAVAILABLE" if index == 12 else "CONNECTED"))
        scan = uuid4()
        db.execute("insert into source_scans(id) values(%s)", (scan,))
        db.execute("insert into facebook_scan_jobs(id,source_scan_id,consumer_type,group_snapshot) values(%s,%s,'ANDROID_WEBVIEW',%s)", (uuid4(), scan, Jsonb([group])))
        db.execute("insert into collector_android_source_grants(device_id,watched_group_id,search_filter_id) values(%s,%s,'00000000-0000-4000-8000-000000000007')", (pg.DEVICE, group_id))
db.close()

RPC = {
    "claim_android_facebook_scan_job": ["p_device_id", "p_lease_seconds", "p_source_ids"],
    "renew_android_facebook_scan_job": ["p_job_id", "p_device_id", "p_lease_token", "p_lease_seconds"],
    "begin_android_facebook_completion": ["p_job_id", "p_device_id", "p_lease_token", "p_completion_id", "p_payload_hash"],
    "finish_android_facebook_completion": ["p_job_id", "p_device_id", "p_lease_token", "p_completion_id", "p_payload_hash", "p_receipt", "p_error_code"],
}

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass # Never log body, HMAC, lease or post text.

    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length > 2 * 1024 * 1024:
                raise ValueError("oversized")
            body = json.loads(self.rfile.read(length))
            with pg.connect() as conn:
                conn.row_factory = dict_row
                result = self.handle_body(conn, body)
            encoded = json.dumps(result, default=str).encode()
            self.send_response(200)
        except Exception:
            encoded = b'{"error":"ISOLATED_DB_ERROR"}'
            self.send_response(503)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def handle_body(self, conn, body):
        if self.path == "/health":
            return {"ok": True}
        if self.path == "/rpc":
            name = body["name"]
            keys = RPC[name] # Whitelisted function and parameter ordering only.
            args = [Jsonb(body["args"][key]) if key == "p_receipt" else body["args"].get(key) for key in keys]
            if name.startswith(("claim_", "renew_")):
                return conn.execute("select * from " + name + "(" + ",".join(["%s"]*len(args)) + ")", args).fetchall()
            row = conn.execute("select " + name + "(" + ",".join(["%s"]*len(args)) + ") as result", args).fetchone()
            return row["result"]
        if self.path == "/job":
            return conn.execute("select * from facebook_scan_jobs where id=%s", (body["id"],)).fetchone()
        if self.path == "/nonce":
            row=conn.execute("insert into test_nonces values(%s,%s) on conflict do nothing returning nonce", (body["deviceId"],body["nonce"])).fetchone()
            return {"accepted": row is not None}
        if self.path == "/sources":
            ids = {str(row["watched_group_id"]) for row in conn.execute("select watched_group_id from collector_android_source_grants where device_id=%s and (expires_at is null or expires_at>now())", (body["deviceId"],)).fetchall()}
            return [row for row in groups if row["id"] in ids]
        if self.path == "/checkpoint":
            row=conn.execute("select result from test_completed_batches where binding=%s",(Jsonb(body),)).fetchone()
            return row["result"] if row else None
        if self.path == "/import":
            return persist_fixture_import(conn, body)
        if self.path == "/requeue":
            conn.execute("update facebook_scan_jobs set status='queued',attempts=0,android_completion_id=null,android_payload_hash=null,android_completion_state=null,android_completion_started_at=null,android_receipt=null,lease_token=null,leased_until=null,worker_id=null where consumer_type='ANDROID_WEBVIEW' and status in ('completed','failed')")
            conn.execute("update source_scans set status='pending'")
            return {"ok": True}
        if self.path == "/stats":
            return {"listings":conn.execute("select count(*) as n from test_listings").fetchone()["n"],"completedBatches":conn.execute("select count(*) as n from test_completed_batches").fetchone()["n"]}
        raise ValueError("unknown isolated endpoint")

print("Isolated CI DB bridge ready on loopback:55440", flush=True)
ThreadingHTTPServer(("127.0.0.1",55440),Handler).serve_forever()
