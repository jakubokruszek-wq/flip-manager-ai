import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const migrationPath = path.join(process.cwd(), "supabase/migrations/20261004120000_add_finder_scan_continuation.sql");
const sql = fs.readFileSync(migrationPath, "utf8");

test("continuation draft adds durable lease state without changing OLX/Facebook ownership", () => {
  assert.match(sql, /add column if not exists continuation_attempt integer not null default 0/i);
  assert.match(sql, /add column if not exists continuation_next_at timestamptz/i);
  assert.match(sql, /add column if not exists continuation_cycle_at timestamptz/i);
  assert.match(sql, /add column if not exists continuation_lease_token uuid/i);
  assert.match(sql, /add column if not exists continuation_lease_until timestamptz/i);
  assert.match(sql, /create or replace function public\.claim_finder_scan_source/i);
  assert.match(sql, /source not in \('olx', 'facebook'\)/i);
  assert.match(sql, /for update skip locked/i);
  assert.match(sql, /started_at <= p_now - interval '5 minutes'/i);
  assert.match(sql, /if p_lease_seconds is null or p_lease_seconds < 30 or p_lease_seconds > 900 then/i, "explicit NULL must fail before a row can be claimed");
  assert.match(sql, /grant execute .*to service_role/i);
  assert.doesNotMatch(sql, /insert into public\.olx_scan_jobs/i);
});
