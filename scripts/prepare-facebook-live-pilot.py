#!/usr/bin/env python3
"""PRINT ONLY: reviewable additive seed for the existing dedicated test DB.

No connection, deployment, secrets, migration or execution. SQL requires separate
approval and verifies the existing OFFLINE_TEST environment marker before inserts.
"""
import argparse
import json
import re
import time
from uuid import UUID, uuid4


def prepare(project_ref, device_id, registry_id, group_id, expires_at, now=None):
    now = int(time.time() * 1000) if now is None else now
    if not re.fullmatch(r"[a-z]{20}", project_ref) or project_ref == "zmuisdirvfcxrvtbvrle":
        raise ValueError("PILOT_TEST_PROJECT_REQUIRED")
    for value in (device_id, registry_id):
        if str(UUID(value)) != value or value.startswith("00000000-"):
            raise ValueError("PILOT_NEW_ID_REQUIRED")
    if device_id == registry_id or not re.fullmatch(r"[A-Za-z0-9._-]{1,100}", group_id) or group_id.lower().startswith("offline"):
        raise ValueError("PILOT_GROUP_INVALID")
    if not isinstance(expires_at, int) or not now < expires_at <= now + 3600000:
        raise ValueError("PILOT_APPROVAL_EXPIRY_REQUIRED")
    scan_id, job_id, run_id = (str(uuid4()) for _ in range(3))
    source = json.dumps([{"id": registry_id, "name": "Approved pilot group", "sourceId": group_id,
                          "type": "GROUP", "url": "https://www.facebook.com/groups/" + group_id + "/"}])
    # All interpolated identifiers are validated above; JSON is SQL-quoted too.
    source = source.replace("'", "''")
    return f"""-- REVIEW ONLY; do not execute without separate approval. No existing row is changed.
begin;
do $$ begin
  if to_regclass('public.offline_test_environment') is null
     or to_regclass('public.test_listings') is null
     or to_regclass('public.listings') is not null then
    raise exception 'PILOT_TEST_SCHEMA_REQUIRED';
  end if;
  if not exists(select 1 from public.offline_test_environment where id=1 and project_ref='{project_ref}') then
    raise exception 'PILOT_TEST_PROJECT_MISMATCH';
  end if;
end $$;
insert into public.collector_devices(id,consumer_type) values('{device_id}','ANDROID_WEBVIEW');
insert into public.watched_facebook_groups(id) values('{registry_id}');
insert into public.collector_android_source_grants(device_id,watched_group_id,search_filter_id,expires_at)
 values('{device_id}','{registry_id}','00000000-0000-4000-8000-000000000007',to_timestamp({expires_at}/1000.0));
insert into public.source_scans(id) values('{scan_id}');
insert into public.facebook_scan_jobs(id,source_scan_id,scan_run_id,consumer_type,group_snapshot,max_attempts)
 values('{job_id}','{scan_id}','{run_id}','ANDROID_WEBVIEW','{source}'::jsonb,1);
commit;
"""


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project-ref", required=True)
    parser.add_argument("--device-id", required=True)
    parser.add_argument("--source-registry-id", required=True)
    parser.add_argument("--facebook-group-id", required=True)
    parser.add_argument("--expires-at", required=True, type=int)
    args = parser.parse_args()
    try:
        print(prepare(args.project_ref, args.device_id, args.source_registry_id, args.facebook_group_id, args.expires_at), end="")
    except (ValueError, TypeError):
        raise SystemExit("PILOT_REVIEW_PLAN_INVALID") from None
